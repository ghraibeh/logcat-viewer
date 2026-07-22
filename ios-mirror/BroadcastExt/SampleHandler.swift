import ReplayKit
import VideoToolbox
import Network
import CoreMedia
import AVFAudio

/// ReplayKit Broadcast Upload Extension: the iOS "Cast this screen" engine. The system
/// feeds us every screen frame (system-wide, unlike in-app RPScreenRecorder); we downscale
/// (long edge ≤ 960 — same CaptureSpec rule as the Android sender), H.264-encode with
/// VideoToolbox, and stream MLK1 units to the receiver the app picked (app-group handoff).
///
/// Latency/loss policy mirrors the Android sender: 1 s keyframe interval, realtime encode,
/// never let backlog build (if the socket can't drain we drop frames pre-encode and lead
/// back in with a forced IDR), and honor the receiver's CTRL_NEED_IDR immediately.
/// Audio: ReplayKit's app-audio arrives in whatever LPCM format the system likes (often
/// 44.1 kHz float); a persistent AVAudioConverter resamples it to the protocol's fixed
/// 48 kHz stereo s16 interleaved (KIND_AUDIO). Mic audio is not captured.
final class SampleHandler: RPBroadcastSampleHandler {

    private let queue = DispatchQueue(label: "mirror-cast")
    private var conn: NWConnection?
    private var compression: VTCompressionSession?
    private var transfer: VTPixelTransferSession?
    private var scaledPool: CVPixelBufferPool?

    private var headerSent = false
    private var capW = 0, capH = 0
    private var srcW = 0, srcH = 0
    private var forceKeyframe = true // first frame is always an IDR
    private var lastConfig = Data()
    private var framesInFlight = 0 // send-completion backpressure gauge
    private var droppingUntilKeyframe = false

    private var browser: NWBrowser?
    private var browseTimeout: DispatchWorkItem?

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        // Preferred: the receiver the app picked, via app-group defaults (only works once
        // the App Group entitlement is provisioned — see project.yml). Fallback: browse
        // Bonjour ourselves and take the first receiver on the LAN.
        if let target = CastConfig.savedReceiver() {
            connect(to: NWEndpoint.hostPort(host: NWEndpoint.Host(target.host),
                                            port: NWEndpoint.Port(rawValue: target.port)!))
            return
        }
        let b = NWBrowser(for: .bonjour(type: MirrorWire.serviceType, domain: nil), using: .tcp)
        browser = b
        b.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self, self.conn == nil else { return }
            guard let first = results.sorted(by: {
                $0.endpoint.debugDescription < $1.endpoint.debugDescription
            }).first else { return }
            self.browseTimeout?.cancel()
            self.browser?.cancel(); self.browser = nil
            self.connect(to: first.endpoint)
        }
        b.start(queue: queue)
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.conn == nil else { return }
            self.browser?.cancel(); self.browser = nil
            self.finishBroadcastWithError(NSError(
                domain: "mlkmirror", code: 1,
                userInfo: [NSLocalizedDescriptionKey:
                    "No mirror receiver found on this network. Open “Receive a screen” on the other device first."]))
        }
        browseTimeout = timeout
        queue.asyncAfter(deadline: .now() + 6, execute: timeout)
    }

    private func connect(to endpoint: NWEndpoint) {
        let params = NWParameters.tcp
        if let tcp = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true
        }
        let c = NWConnection(to: endpoint, using: params)
        conn = c
        c.stateUpdateHandler = { [weak self] st in
            switch st {
            case .failed(let e):
                self?.finishBroadcastWithError(NSError(
                    domain: "mlkmirror", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Receiver connection failed: \(e)"]))
            case .ready:
                self?.readControl()
            default: break
            }
        }
        c.start(queue: queue)
    }

    override func broadcastFinished() {
        queue.sync {
            if let s = compression { VTCompressionSessionInvalidate(s) }
            compression = nil
            transfer = nil
            conn?.cancel(); conn = nil
        }
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer,
                                      with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case .video:
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            queue.async { [weak self] in self?.encode(pixelBuffer, pts: pts) }
        case .audioApp:
            queue.async { [weak self] in self?.forwardAudio(sampleBuffer) }
        default:
            break // mic not captured
        }
    }

    // --- audio: any LPCM in → 48 kHz stereo s16 interleaved KIND_AUDIO units --------------

    private var audioConverter: AVAudioConverter?
    private var audioSrcFormat: AVAudioFormat?
    private var audioInCount = 0
    private var audioOutCount = 0
    private let audioDstFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: Double(MirrorWire.audioSampleRate),
        channels: AVAudioChannelCount(MirrorWire.audioChannels),
        interleaved: true)!

    private func forwardAudio(_ sb: CMSampleBuffer) {
        audioInCount += 1
        if audioInCount == 1 || audioInCount % 200 == 0 {
            NSLog("mlkcast audio: in=%d out=%d headerSent=%d", audioInCount, audioOutCount, headerSent ? 1 : 0)
        }
        // Units may only follow the header, and the header waits for the first video frame
        // (it carries the capture dims) — drop the few ms of audio that arrive before it.
        guard headerSent, conn != nil else { return }
        let frames = CMSampleBufferGetNumSamples(sb)
        guard frames > 0, let fmtDesc = CMSampleBufferGetFormatDescription(sb) else {
            NSLog("mlkcast audio: no frames/format"); return
        }
        let srcFmt = AVAudioFormat(cmAudioFormatDescription: fmtDesc)
        if audioInCount == 1 { NSLog("mlkcast audio: src format %@", srcFmt.description) }

        // Pull the PCM out without copying: wrap the sample buffer's AudioBufferList.
        let abl = AudioBufferList.allocate(maximumBuffers: 8)
        defer { free(abl.unsafeMutablePointer) }
        var block: CMBlockBuffer? // keeps the wrapped bytes alive through the conversion
        let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sb,
            bufferListSizeNeededOut: nil,
            bufferListOut: abl.unsafeMutablePointer,
            bufferListSize: AudioBufferList.sizeInBytes(maximumBuffers: 8),
            blockBufferAllocator: kCFAllocatorDefault,
            blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &block)
        guard status == noErr, block != nil,
              let srcBuf = AVAudioPCMBuffer(pcmFormat: srcFmt,
                                            bufferListNoCopy: abl.unsafeMutablePointer,
                                            deallocator: nil) else {
            NSLog("mlkcast audio: ABL extract failed (status=%d)", status); return
        }
        srcBuf.frameLength = AVAudioFrameCount(frames)

        // One persistent converter (sample-rate conversion is stateful); rebuild only if
        // the system changes the capture format mid-broadcast.
        if audioConverter == nil || audioSrcFormat != srcFmt {
            audioConverter = AVAudioConverter(from: srcFmt, to: audioDstFormat)
            audioSrcFormat = srcFmt
        }
        guard let conv = audioConverter else { return }

        let ratio = audioDstFormat.sampleRate / srcFmt.sampleRate
        let outCapacity = AVAudioFrameCount(Double(frames) * ratio) + 64
        guard let outBuf = AVAudioPCMBuffer(pcmFormat: audioDstFormat,
                                            frameCapacity: outCapacity) else { return }
        var served = false
        var convError: NSError?
        let result = conv.convert(to: outBuf, error: &convError) { _, outStatus in
            if served { outStatus.pointee = .noDataNow; return nil }
            served = true
            outStatus.pointee = .haveData
            return srcBuf
        }
        withExtendedLifetime(block) {}
        if result == .error {
            NSLog("mlkcast audio: convert failed: %@", convError?.localizedDescription ?? "?")
            return
        }
        guard outBuf.frameLength > 0 else {
            NSLog("mlkcast audio: converter produced 0 frames (in=%d)", frames); return
        }
        // Interleaved int16: the underlying audioBufferList's single buffer holds the
        // interleaved stream (int16ChannelData is documented nil for interleaved formats).
        let ablOut = outBuf.audioBufferList.pointee.mBuffers
        guard let base = ablOut.mData else { NSLog("mlkcast audio: out buffer has no data"); return }
        let byteCount = Int(outBuf.frameLength) * MirrorWire.audioChannels * 2
        audioOutCount += 1
        sendUnit(kind: MirrorWire.kindAudio, payload: Data(bytes: base, count: byteCount))
    }

    // --- reverse channel (receiver → us): touches ignored (iOS can't inject), NEED_IDR honored.
    private func readControl() {
        guard let c = conn else { return }
        c.receive(minimumIncompleteLength: 1, maximumLength: 1) { [weak self] data, _, complete, error in
            guard let self, let data, !data.isEmpty else {
                if error != nil || complete { return } // socket gone; broadcastFinished handles teardown
                self?.readControl()
                return
            }
            switch data[data.startIndex] {
            case MirrorWire.ctrlNeedIdr:
                self.forceKeyframe = true
                self.readControl()
            case MirrorWire.ctrlTouch:
                // Fixed 13 more bytes (action + x + y + dtMs) — read and discard.
                c.receive(minimumIncompleteLength: 13, maximumLength: 13) { _, _, _, _ in
                    self.readControl()
                }
            default:
                self.readControl() // unknown control byte — skip
            }
        }
    }

    // --- encode pipeline -------------------------------------------------------------------

    private func encode(_ src: CVPixelBuffer, pts: CMTime) {
        let w = CVPixelBufferGetWidth(src)
        let h = CVPixelBufferGetHeight(src)
        if compression == nil || w != srcW || h != srcH {
            rebuildSessions(srcWidth: w, srcHeight: h)
        }
        guard let session = compression else { return }

        // Sender-side latency governor: if the link isn't draining, encoding more frames
        // just builds standing delay. Drop pre-encode and lead back in with a keyframe.
        if framesInFlight > 12 {
            droppingUntilKeyframe = true
            forceKeyframe = true
            return
        }
        if droppingUntilKeyframe && !forceKeyframe { return }
        droppingUntilKeyframe = false

        // Downscale into the pooled buffer (VT can't scale inside the compression session).
        var scaled: CVPixelBuffer?
        if let pool = scaledPool, capW != w || capH != h {
            CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &scaled)
            if let dst = scaled, let t = transfer {
                guard VTPixelTransferSessionTransferImage(t, from: src, to: dst) == noErr else { return }
            } else {
                scaled = nil
            }
        }
        let toEncode = scaled ?? src

        var flags: VTEncodeInfoFlags = []
        var frameProps: CFDictionary?
        if forceKeyframe {
            forceKeyframe = false
            frameProps = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
        }
        VTCompressionSessionEncodeFrame(
            session, imageBuffer: toEncode,
            presentationTimeStamp: pts, duration: .invalid,
            frameProperties: frameProps, infoFlagsOut: &flags
        ) { [weak self] status, encodeFlags, sample in
            self?.queue.async { self?.encodeOutput(status, encodeFlags, sample) }
        }
    }

    private func rebuildSessions(srcWidth: Int, srcHeight: Int) {
        srcW = srcWidth; srcH = srcHeight
        if let s = compression { VTCompressionSessionInvalidate(s) }
        compression = nil

        // CaptureSpec-equivalent sizing: long edge ≤ 960, even dims, bpp-derived bitrate.
        let longEdge = max(srcWidth, srcHeight)
        let scale = longEdge > 960 ? 960.0 / Double(longEdge) : 1.0
        capW = max(2, Int(Double(srcWidth) * scale) / 2 * 2)
        capH = max(2, Int(Double(srcHeight) * scale) / 2 * 2)
        let bitRate = min(4_000_000, max(1_500_000, Int(Double(capW * capH) * 30 * 0.15)))

        if scale < 1.0 {
            var t: VTPixelTransferSession?
            VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &t)
            transfer = t
            let poolAttrs: [CFString: Any] = [
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                kCVPixelBufferWidthKey: capW,
                kCVPixelBufferHeightKey: capH,
                kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
            ]
            var pool: CVPixelBufferPool?
            CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, poolAttrs as CFDictionary, &pool)
            scaledPool = pool
        } else {
            transfer = nil
            scaledPool = nil
        }

        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(capW), height: Int32(capH),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil,
            compressionSessionOut: &session)
        guard status == noErr, let session else { return }

        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel,
                             value: kVTProfileLevel_H264_Main_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering,
                             value: kCFBooleanFalse) // no B-frames: live stream, P-only GOPs
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate,
                             value: bitRate as CFNumber)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
                             value: 1.0 as CFNumber) // 1 s GOP — same resync cadence as Android
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate,
                             value: 30 as CFNumber)
        VTCompressionSessionPrepareToEncodeFrames(session)
        compression = session

        // headerSent is deliberately untouched: it's per-connection, not per-session
        // (a rotation rebuilds the encoder but the MLK1 header was already sent).
        forceKeyframe = true
        lastConfig = Data()
    }

    private func encodeOutput(_ status: OSStatus, _ flags: VTEncodeInfoFlags, _ sample: CMSampleBuffer?) {
        guard status == noErr, let sample, CMSampleBufferDataIsReady(sample) else { return }
        guard let c = conn else { return }

        // Send the MLK1 header once we know the capture dims (before the first unit).
        if !headerSent {
            headerSent = true
            let header = MirrorWire.headerData(capW: Int32(capW), capH: Int32(capH),
                                               realW: Int32(srcW), realH: Int32(srcH))
            c.send(content: header, completion: .idempotent)
        }

        let isKeyframe: Bool = {
            guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                    as? [[CFString: Any]], let first = attachments.first else { return true }
            return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
        }()

        // Keyframes are preceded by their parameter sets (KIND_CONFIG), Android-sender style.
        if isKeyframe, let fmt = CMSampleBufferGetFormatDescription(sample),
           let config = Self.annexBParameterSets(from: fmt), config != lastConfig {
            lastConfig = config
            sendUnit(kind: MirrorWire.kindConfig, payload: config)
        }

        guard let dataBuffer = CMSampleBufferGetDataBuffer(sample) else { return }
        var length = 0
        var pointer: UnsafeMutablePointer<CChar>?
        guard CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: nil,
                                          totalLengthOut: &length, dataPointerOut: &pointer) == noErr,
              let pointer, length > 0 else { return }
        let avcc = Data(bytes: pointer, count: length)
        sendUnit(kind: MirrorWire.kindVideo, payload: AnnexB.avccToAnnexB(avcc))
    }

    private func sendUnit(kind: UInt8, payload: Data) {
        guard let c = conn, !payload.isEmpty else { return }
        framesInFlight += 1
        c.send(content: MirrorWire.unitData(kind: kind, payload: payload),
               completion: .contentProcessed { [weak self] _ in
                   self?.queue.async { self?.framesInFlight -= 1 }
               })
    }

    /// SPS+PPS from a format description as one Annex-B config unit.
    private static func annexBParameterSets(from fmt: CMFormatDescription) -> Data? {
        var out = Data()
        let startCode: [UInt8] = [0, 0, 0, 1]
        var count = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            fmt, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
            parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) == noErr, count >= 2 else { return nil }
        for i in 0 ..< count {
            var ptr: UnsafePointer<UInt8>?
            var size = 0
            guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr, parameterSetSizeOut: &size,
                parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr, let ptr else { return nil }
            out.append(contentsOf: startCode)
            out.append(ptr, count: size)
        }
        return out
    }
}
