// iOS screen mirror capture helper for AndroidLab (macOS-only).
//
// Uses exactly what QuickTime uses — the CoreMediaIO "iOS Device" screen-capture
// device — so it needs NO root, only camera/screen TCC permission (granted once by
// a normal app prompt). Captures full-res frames at the device's native rate via
// AVCaptureSession, hardware-encodes them to H.264 with VideoToolbox, and writes a
// raw Annex-B elementary stream to stdout (SPS/PPS emitted before each keyframe) —
// byte-compatible with the app's existing WebCodecs decoder.
//
// Usage: iosscreen [<device-name-substring>]   (picks the first "iOS Device" that
// matches the name, or the first one if no name is given). Logs go to stderr;
// stdout carries ONLY H.264 bytes. Stop with SIGINT/SIGTERM.

import Foundation
import AVFoundation
import CoreMediaIO
import VideoToolbox

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

// Set by a SIGUSR1 (a dock<->popout re-attach in the app): force the next encoded
// frame to be a keyframe so a freshly-mounted decoder in the other window can
// configure + paint immediately instead of waiting for the next periodic IDR.
var forceKeyframe = false

// Enable the iOS screen-capture CMIO devices (QuickTime's own switch). Unprivileged.
func enableScreenCaptureDevices() {
    var addr = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(0))
    var yes: UInt32 = 1
    CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &addr, 0, nil,
                              UInt32(MemoryLayout<UInt32>.size), &yes)
}

// Find the iPhone/iPad screen device. It reports modelID "iOS Device" and is NOT
// returned by AVCaptureDevice.DiscoverySession on macOS 26, so enumerate the raw
// CoreMediaIO device list and match one whose AVCaptureDevice modelID is "iOS Device".
func findIosScreenDevice(nameMatch: String?) -> AVCaptureDevice? {
    var addr = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(0))
    var size: UInt32 = 0
    CMIOObjectGetPropertyDataSize(CMIOObjectID(kCMIOObjectSystemObject), &addr, 0, nil, &size)
    let count = Int(size) / MemoryLayout<CMIOObjectID>.size
    if count == 0 { return nil }
    var ids = [CMIOObjectID](repeating: 0, count: count)
    var used: UInt32 = 0
    CMIOObjectGetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &addr, 0, nil, size, &used, &ids)

    func uidOf(_ dev: CMIOObjectID) -> String? {
        var a = CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceUID),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal), mElement: 0)
        var sz: UInt32 = 0
        if CMIOObjectGetPropertyDataSize(dev, &a, 0, nil, &sz) != 0 { return nil }
        var cf: Unmanaged<CFString>?
        var u: UInt32 = 0
        let r = withUnsafeMutablePointer(to: &cf) { CMIOObjectGetPropertyData(dev, &a, 0, nil, sz, &u, $0) }
        return r == 0 ? (cf?.takeRetainedValue() as String?) : nil
    }

    log("CMIO devices: \(count); camera auth: \(AVCaptureDevice.authorizationStatus(for: .video).rawValue)")
    var all: [AVCaptureDevice] = []
    for id in ids {
        guard let uid = uidOf(id) else { continue }
        if let dev = AVCaptureDevice(uniqueID: uid) { all.append(dev) }
    }
    let names = all.map { "\($0.localizedName)[\($0.modelID)]" }.joined(separator: ", ")
    log("cmio: \(count) devices, camera-auth \(AVCaptureDevice.authorizationStatus(for: .video).rawValue) (3=ok) — \(names)")
    // Screen mirror = the iPhone/iPad SCREEN device only (modelID "iOS Device").
    // NEVER a Continuity Camera — a camera also carries the device's name, so we
    // match strictly within the screen devices. One screen device → use it. Several
    // (e.g. an iPhone + iPad both attached) → disambiguate by name; if the name
    // matches none, wait rather than guess (return nil so the caller keeps polling).
    let screens = all.filter { $0.modelID == "iOS Device" }
    if screens.isEmpty { return nil }
    if screens.count == 1 { return screens.first }
    if let want = nameMatch, !want.isEmpty {
        if let m = screens.first(where: { $0.localizedName.contains(want) || want.contains($0.localizedName) }) {
            return m
        }
    }
    return nil
}

// --- VideoToolbox H.264 encoder → Annex-B on stdout --------------------------
let stdoutHandle = FileHandle.standardOutput
let startCode = Data([0x00, 0x00, 0x00, 0x01])

func writeAnnexB(_ bytes: Data) { stdoutHandle.write(bytes) }

// Emit SPS/PPS (Annex-B) from a keyframe's format description.
func writeParameterSets(_ fmt: CMFormatDescription) {
    var count: Int = 0
    if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: 0, parameterSetPointerOut: nil,
        parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) != noErr { return }
    for i in 0..<count {
        var ptr: UnsafePointer<UInt8>?
        var len: Int = 0
        if CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr,
            parameterSetSizeOut: &len, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let p = ptr {
            writeAnnexB(startCode)
            writeAnnexB(Data(bytes: p, count: len))
        }
    }
}

// VT encode callback: convert AVCC (4-byte length-prefixed) NALUs to Annex-B.
let encodeCallback: VTCompressionOutputCallback = { _, _, status, _, sampleBuffer in
    guard status == noErr, let sb = sampleBuffer, CMSampleBufferDataIsReady(sb) else { return }

    var isKeyframe = true
    if let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]],
       let notSync = atts.first?[kCMSampleAttachmentKey_NotSync] as? Bool {
        isKeyframe = !notSync
    }
    if isKeyframe, let fmt = CMSampleBufferGetFormatDescription(sb) {
        writeParameterSets(fmt)
    }
    guard let bb = CMSampleBufferGetDataBuffer(sb) else { return }
    var total: Int = 0
    var dataPtr: UnsafeMutablePointer<Int8>?
    if CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total, dataPointerOut: &dataPtr) != noErr {
        return
    }
    guard let base = dataPtr else { return }
    var offset = 0
    while offset + 4 <= total {
        var nalLen: UInt32 = 0
        memcpy(&nalLen, base + offset, 4)
        nalLen = CFSwapInt32BigToHost(nalLen)
        offset += 4
        if nalLen == 0 || offset + Int(nalLen) > total { break }
        writeAnnexB(startCode)
        base.withMemoryRebound(to: UInt8.self, capacity: total) { u in
            writeAnnexB(Data(bytes: u + offset, count: Int(nalLen)))
        }
        offset += Int(nalLen)
    }
}

final class FrameHandler: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    var session: VTCompressionSession?
    var configured = false
    var frames = 0

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if frames == 0 { log("first frame received") }
        if !configured { setup(pixel) }
        guard let s = session else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        var props: CFDictionary? = nil
        if forceKeyframe {
            forceKeyframe = false
            props = [kVTEncodeFrameOptionKey_ForceKeyFrame as String: kCFBooleanTrue as Any] as CFDictionary
        }
        VTCompressionSessionEncodeFrame(s, imageBuffer: pixel, presentationTimeStamp: pts,
                                        duration: .invalid, frameProperties: props, sourceFrameRefcon: nil,
                                        infoFlagsOut: nil)
        frames += 1
    }

    func setup(_ pixel: CVPixelBuffer) {
        let w = CVPixelBufferGetWidth(pixel)
        let h = CVPixelBufferGetHeight(pixel)
        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h),
            codecType: kCMVideoCodecType_H264, encoderSpecification: nil, imageBufferAttributes: nil,
            compressedDataAllocator: nil, outputCallback: encodeCallback, refcon: nil, compressionSessionOut: &s)
        guard status == noErr, let sess = s else { log("VTCompressionSessionCreate failed: \(status)"); return }
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 60 as CFNumber)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AverageBitRate, value: 8_000_000 as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(sess)
        session = sess
        configured = true
        log("encoder ready: \(w)x\(h)")
    }
}

// --- main --------------------------------------------------------------------
let nameArg = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : nil

// Held strongly for the process lifetime once capture starts.
var liveSession: AVCaptureSession? = nil
var liveHandler: FrameHandler? = nil
var captureStarted = false

func startCapture(_ device: AVCaptureDevice) {
    if captureStarted { return }
    captureStarted = true
    log("capturing: \(device.localizedName)")
    let session = AVCaptureSession()
    session.sessionPreset = .high
    do {
        let input = try AVCaptureDeviceInput(device: device)
        if session.canAddInput(input) { session.addInput(input) } else { log("cannot add input"); exit(3) }
    } catch {
        log("input error (permission?): \(error)")
        exit(3)
    }
    let output = AVCaptureVideoDataOutput()
    let handler = FrameHandler()
    output.setSampleBufferDelegate(handler, queue: DispatchQueue(label: "capture"))
    output.alwaysDiscardsLateVideoFrames = true
    if session.canAddOutput(output) { session.addOutput(output) }
    session.startRunning()
    liveSession = session
    liveHandler = handler
    log("session running")
}

func tryFindAndStart() {
    if captureStarted { return }
    if let dev = findIosScreenDevice(nameMatch: nameArg) { startCapture(dev) }
}

// Behave like QuickTime — but WITHOUT needing QuickTime (or any other app) open.
// The iPhone's screen is an on-demand CoreMediaIO device: macOS's screen-capture
// daemon only keeps it published while a client is actively engaged with the CMIO
// subsystem. A one-shot poll from a short-lived process isn't a strong enough
// trigger, so we stay resident: assert the enable flag, register a persistent
// device-list listener, re-assert on a timer, and keep the run loop pumping so we
// grab the screen device the instant the daemon publishes it — then WE hold it.
enableScreenCaptureDevices()

var devAddr = CMIOObjectPropertyAddress(
    mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
    mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
    mElement: CMIOObjectPropertyElement(0))
_ = CMIOObjectAddPropertyListenerBlock(CMIOObjectID(kCMIOObjectSystemObject), &devAddr, DispatchQueue.main) { _, _ in
    tryFindAndStart()
}

// Immediate attempt, then re-assert the flag + re-scan on a timer (a cold daemon
// needs a repeated nudge). Give up after a budget so the UI can report a failure.
tryFindAndStart()
let startTime = Date()
let giveUpAfter: TimeInterval = 30
let timer = Timer(timeInterval: 1.5, repeats: true) { t in
    if captureStarted { t.invalidate(); return }
    enableScreenCaptureDevices()
    tryFindAndStart()
    if !captureStarted && Date().timeIntervalSince(startTime) > giveUpAfter {
        log("no iOS screen-capture device found (is the iPhone connected, unlocked, and awake?)")
        exit(2)
    }
}
RunLoop.main.add(timer, forMode: .common)

// Clean shutdown on SIGINT/SIGTERM.
let sigsrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigsrc.setEventHandler { liveSession?.stopRunning(); exit(0) }
sigsrc.resume()
signal(SIGINT, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { liveSession?.stopRunning(); exit(0) }
sigterm.resume()
signal(SIGTERM, SIG_IGN)

// SIGUSR1 → force a keyframe on the next encode (dock<->popout re-attach). Must have
// a handler installed or the default action would terminate the helper.
let sigusr = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
sigusr.setEventHandler { forceKeyframe = true }
sigusr.resume()
signal(SIGUSR1, SIG_IGN)

log("waiting for iOS screen device…")
RunLoop.main.run()
