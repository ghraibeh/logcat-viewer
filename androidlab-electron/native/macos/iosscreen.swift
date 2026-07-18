// iOS screen mirror capture helper for AndroidLab (macOS-only).
//
// Uses exactly what QuickTime uses — the CoreMediaIO "iOS Device" screen-capture
// device — so it needs NO root, only camera/screen TCC permission (granted once by
// a normal app prompt). Captures full-res frames at the device's native rate via
// AVCaptureSession, hardware-encodes them to H.264 with VideoToolbox, and writes a
// raw Annex-B elementary stream to stdout (SPS/PPS emitted before each keyframe) —
// byte-compatible with the app's existing WebCodecs decoder.
//
// The device's AUDIO is captured too (same CoreMediaIO mechanism QuickTime uses)
// and played straight on the Mac's default audio output via
// AVCaptureAudioPreviewOutput — it never touches stdout, so the video byte stream
// is unchanged. SIGUSR2 toggles mute. Audio is best-effort: no route -> silent
// mirror, video streams regardless.
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

// The device-audio route (nil until attached). SIGUSR2 toggles its volume 1<->0.
// Audio lives in its OWN AVCaptureSession (liveAudioSession), never in the video
// session: a session that contains an audio device switches its master clock to the
// audio hardware clock and re-times video delivery against it, which shows up as
// flicker/judder in a live mirror that paints frames on arrival. Keeping the video
// session audio-free keeps its clock and its graph exactly as they were pre-audio.
var liveAudioPreview: AVCaptureAudioPreviewOutput? = nil
var liveAudioSession: AVCaptureSession? = nil

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
    var encW = 0
    var encH = 0
    var frames = 0

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        guard let pixel = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if frames == 0 { log("first frame received") }
        // The capture buffer's size changes when the device rotates (portrait <->
        // landscape). The encoder is fixed to one resolution, so a stale session would
        // squash the new frames into the old aspect (stretched, wrong orientation) —
        // recreate it at the new size and emit a fresh keyframe so the decoder re-inits.
        let w = CVPixelBufferGetWidth(pixel)
        let h = CVPixelBufferGetHeight(pixel)
        if session == nil || w != encW || h != encH {
            configureEncoder(w, h)
        }
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

    func configureEncoder(_ w: Int, _ h: Int) {
        if let old = session {
            VTCompressionSessionInvalidate(old)
            session = nil
        }
        var s: VTCompressionSession?
        let status = VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h),
            codecType: kCMVideoCodecType_H264, encoderSpecification: nil, imageBufferAttributes: nil,
            compressedDataAllocator: nil, outputCallback: encodeCallback, refcon: nil, compressionSessionOut: &s)
        guard status == noErr, let sess = s else { log("VTCompressionSessionCreate failed: \(status)"); return }
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        // Tag the stream to match the capture buffers EXACTLY (709 primaries, sRGB
        // transfer, 709 matrix — what the screen daemon attaches to its 420v frames)
        // so VideoToolbox does no color conversion and the VUI tells the truth.
        // Without explicit color info the SPS carries no VUI and the decoder guesses;
        // tagging transfer as ITU_R_709_2 instead makes VT gamma-convert sRGB->709
        // (midtones drop ~10%: sRGB 128 encodes to 115) and Chromium then paints the
        // 709-encoded values as sRGB — a visibly darker, contrastier mirror. VUI
        // transfer 13 (sRGB) round-trips through WebCodecs untouched.
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_ColorPrimaries, value: kCVImageBufferColorPrimaries_ITU_R_709_2)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_TransferFunction, value: kCVImageBufferTransferFunction_sRGB)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_YCbCrMatrix, value: kCVImageBufferYCbCrMatrix_ITU_R_709_2)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: 60 as CFNumber)
        VTSessionSetProperty(sess, key: kVTCompressionPropertyKey_AverageBitRate, value: 8_000_000 as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(sess)
        session = sess
        encW = w
        encH = h
        // A brand-new session must lead with SPS/PPS + an IDR so the WebCodecs decoder
        // re-initialises at the new dimensions rather than reusing the old geometry.
        forceKeyframe = true
        log("encoder ready: \(w)x\(h)")
    }
}

// --- device audio → Mac speakers ----------------------------------------------
// Route the iPhone's audio to the Mac's default output — in a DEDICATED session
// (see liveAudioSession above: audio in the video session would switch that
// session's master clock to the audio device and re-time video delivery, which
// reads as flicker on a paint-on-arrival mirror; a failed attach here can never
// disturb the video graph either). The screen device is muxed (video + audio) on
// most macOS builds, so its own input feeds the preview; some builds publish the
// audio side as a SEPARATE CoreAudio capture device carrying the same name — use
// that instead. The audio side often publishes a beat after the screen device (and
// the first mic-TCC prompt resolves asynchronously), so failed attempts retry.
func attachAudio(screenDevice: AVCaptureDevice, attempt: Int = 0) {
    if liveAudioPreview != nil { return }
    let session = AVCaptureSession()
    let preview = AVCaptureAudioPreviewOutput()
    preview.volume = 1.0
    guard session.canAddOutput(preview) else { log("audio: preview output rejected"); return }
    session.addOutput(preview)
    // The muxed screen device itself (a second input for it is fine on DAL devices)…
    do {
        let ain = try AVCaptureDeviceInput(device: screenDevice)
        if session.canAddInput(ain) { session.addInput(ain) }
    } catch {
        log("audio: screen-device input error: \(error)")
    }
    // …or a stand-alone audio device published under the same name.
    if preview.connections.isEmpty {
        let disc = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external],
                                                    mediaType: .audio, position: .unspecified)
        if let adev = disc.devices.first(where: { $0.localizedName == screenDevice.localizedName }) {
            do {
                let ain = try AVCaptureDeviceInput(device: adev)
                if session.canAddInput(ain) { session.addInput(ain) }
            } catch {
                log("audio: input error (microphone permission?): \(error)")
            }
        }
    }
    if preview.connections.isEmpty {
        if attempt < 5 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                attachAudio(screenDevice: screenDevice, attempt: attempt + 1)
            }
        } else {
            log("audio: no route found — mirror stays silent; mic-auth \(AVCaptureDevice.authorizationStatus(for: .audio).rawValue) (3=ok)")
        }
        return
    }
    session.startRunning()
    liveAudioSession = session
    liveAudioPreview = preview
    log("audio: playing device audio on the Mac's default output")
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
    // Request 420v (bi-planar video-range) instead of the device's native 2vuy.
    // The iOS screen device's raw 2vuy is NOT standard video range: measured against
    // `ios screenshot` ground truth, its luma is full-range + 16 (clamped at 235) and
    // its chroma is full-range — an off-spec conversion QuickTime compensates for
    // internally. Encoding those planes as-is and letting a spec-compliant decoder
    // expand 16-235 -> 0-255 lifts the whole picture ~16% and clips every highlight
    // above ~86% signal to white (washed-out mirror, pastels turn white). Asking
    // AVFoundation for 420v routes frames through the daemon's own converter, which
    // undoes its convention correctly (verified: gray N -> Y = 16 + 219*N/255 exactly),
    // and 420v is also the H.264 encoder's native input so VT passes planes through.
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String:
                                kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
    let handler = FrameHandler()
    output.setSampleBufferDelegate(handler, queue: DispatchQueue(label: "capture"))
    output.alwaysDiscardsLateVideoFrames = true
    if session.canAddOutput(output) { session.addOutput(output) }
    session.startRunning()
    liveSession = session
    liveHandler = handler
    log("session running")
    // Audio starts AFTER video is rolling, in its own session — it can neither delay
    // the first frame nor touch the video graph.
    attachAudio(screenDevice: device)
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
sigsrc.setEventHandler { liveAudioSession?.stopRunning(); liveSession?.stopRunning(); exit(0) }
sigsrc.resume()
signal(SIGINT, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { liveAudioSession?.stopRunning(); liveSession?.stopRunning(); exit(0) }
sigterm.resume()
signal(SIGTERM, SIG_IGN)

// SIGUSR1 → force a keyframe on the next encode (dock<->popout re-attach). Must have
// a handler installed or the default action would terminate the helper.
let sigusr = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
sigusr.setEventHandler { forceKeyframe = true }
sigusr.resume()
signal(SIGUSR1, SIG_IGN)

// SIGUSR2 → toggle playing the device audio on the Mac (the app's mute button).
let sigmute = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
sigmute.setEventHandler {
    guard let ap = liveAudioPreview else { return }
    ap.volume = ap.volume > 0 ? 0 : 1
    log("audio: \(ap.volume > 0 ? "unmuted" : "muted")")
}
sigmute.resume()
signal(SIGUSR2, SIG_IGN)

log("waiting for iOS screen device…")
RunLoop.main.run()
