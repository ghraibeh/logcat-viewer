import Foundation

/// The sink the channel/control logic sends through. The app implements this over the real
/// socket + [AapCrypto] + [AapFrameCodec]; tests implement it with a capture buffer. Keeps
/// the entire protocol state machine platform-agnostic and unit-testable.
public protocol MessageSender: AnyObject {
    /// Frame + (optionally) encrypt + write one message. Synchronous from the caller's view;
    /// the app serializes actual socket writes.
    func send(channel: Int, messageId: Int, content: [UInt8], encrypted: Bool)
}

/// Monotonic nanosecond clock for ping/touch timestamps (injectable so the core has no
/// direct dependency on a wall clock — the app passes `DispatchTime.now().uptimeNanoseconds`).
public protocol MonoClock: AnyObject { func nowNanos() -> UInt64 }

/// TLS engine seam used by the control channel during the handshake phase.
public protocol HandshakeEngine: AnyObject {
    var finished: Bool { get }
    func startHandshake() throws -> [UInt8]
    func processHandshake(_ incoming: [UInt8]) throws -> [UInt8]
}

extension AapCrypto: HandshakeEngine {}

/// Callbacks out to the app (video frames, audio PCM, mic open/close, lifecycle).
public protocol SessionDelegate: AnyObject {
    func session(status: String)
    func session(phoneName: String, brand: String)
    func session(channelOpened: Int)
    /// Video: Annex-B H.264, 8-byte timestamp already stripped. codecConfig = SPS/PPS.
    func session(videoData: [UInt8], codecConfig: Bool)
    /// Audio: PCM for the given channel (rate/channels per the advertised sink).
    func session(audioData: [UInt8], channel: Int)
    func session(micOpen: Bool)
    func sessionStreaming()
    func sessionEnded(reason: String)
    /// Schedule `body` after `seconds`, repeating; return a token the session can cancel.
    /// (The app backs this with a Timer/DispatchSource — the core stays scheduler-agnostic.)
    func scheduleRepeating(seconds: Double, _ body: @escaping () -> Void) -> Any
    func cancelScheduled(_ token: Any)
}

/// One Android Auto head-unit session over an open link — the Swift twin of the Electron
/// `AaSession` + `ControlChannel` + channels, driven by messages the app feeds in from the
/// socket via [handle]. All protocol behavior lives here; the app owns only I/O + media.
public final class AaSession {
    private unowned let sender: MessageSender
    private let crypto: HandshakeEngine
    private let cfg: HuConfig
    private unowned let delegate: SessionDelegate
    private let clock: MonoClock

    private var streaming = false
    private var stopped = false
    private var mediaSession: [Int: Int] = [:]   // channel → sessionId
    private var pingToken: Any?
    private var videoFocusToken: Any?

    public init(sender: MessageSender, crypto: HandshakeEngine, config: HuConfig,
                clock: MonoClock, delegate: SessionDelegate) {
        self.sender = sender
        self.crypto = crypto
        self.cfg = config
        self.clock = clock
        self.delegate = delegate
    }

    /// Kick off the handshake: send the version request. The app must already be reading the
    /// socket and calling [handle] for each inbound message.
    public func begin() {
        sender.send(channel: AapProto.chControl, messageId: ControlMsg.versionRequest,
                    content: AapProto.u16be(AapProto.versionMajor) + AapProto.u16be(AapProto.versionMinor),
                    encrypted: false)
        delegate.session(status: "Handshake: version request sent…")
    }

    public func stop() {
        guard !stopped else { return }
        stopped = true
        if let t = pingToken { delegate.cancelScheduled(t); pingToken = nil }
        if let t = videoFocusToken { delegate.cancelScheduled(t); videoFocusToken = nil }
    }

    public func sendTouch(action: Int, x: Int, y: Int) {
        let cx = max(0, min(cfg.width, x))
        let cy = max(0, min(cfg.height, y))
        sender.send(channel: AapProto.chInput, messageId: InputMsg.event,
                    content: AapEncode.inputReportTouch(clock.nowNanos(), cx, cy, action), encrypted: true)
    }

    /// Feed the phone's mic PCM (16-bit mono 16 kHz) framed as media data: [ts:8 µs BE][pcm].
    public func sendMic(_ pcm: [UInt8]) {
        let tsUs = clock.nowNanos() / 1000
        var header = [UInt8](repeating: 0, count: 8)
        for i in 0..<8 { header[7 - i] = UInt8((tsUs >> (8 * i)) & 0xff) }
        sender.send(channel: AapProto.chMic, messageId: MediaMsg.data, content: header + pcm, encrypted: true)
    }

    // --- inbound routing ------------------------------------------------------------------

    /// Route one fully-decrypted, reassembled message (from the transport).
    public func handle(channel: Int, messageId: Int, content: [UInt8]) {
        // Channel-open (control msg 7) can arrive on ANY channel — answer generically.
        if messageId == ControlMsg.channelOpenRequest {
            sender.send(channel: channel, messageId: ControlMsg.channelOpenResponse,
                        content: AapEncode.channelOpenResponse(), encrypted: true)
            delegate.session(channelOpened: channel)
            if channel == AapProto.chSensor { pushDrivingStatus() }
            if channel == AapProto.chVideo { startVideoFocusWatchdog() }
            return
        }
        switch channel {
        case AapProto.chControl: handleControl(messageId, content)
        case AapProto.chSensor: handleSensor(messageId, content)
        case AapProto.chInput: handleInput(messageId, content)
        default: handleMedia(channel, messageId, content)
        }
    }

    // --- control channel ------------------------------------------------------------------

    private func handleControl(_ id: Int, _ content: [UInt8]) {
        switch id {
        case ControlMsg.versionResponse:
            let major = content.count >= 2 ? AapProto.readU16(content, 0) : 0
            let minor = content.count >= 4 ? AapProto.readU16(content, 2) : 0
            delegate.session(status: "Version \(major).\(minor) — starting TLS…")
            do {
                let hello = try crypto.startHandshake()
                sender.send(channel: AapProto.chControl, messageId: ControlMsg.sslHandshake, content: hello, encrypted: false)
            } catch { end("TLS start failed: \(error)") }
        case ControlMsg.sslHandshake:
            do {
                let out = try crypto.processHandshake(content)
                if !out.isEmpty {
                    sender.send(channel: AapProto.chControl, messageId: ControlMsg.sslHandshake, content: out, encrypted: false)
                }
                if crypto.finished {
                    delegate.session(status: "TLS established — auth complete…")
                    sender.send(channel: AapProto.chControl, messageId: ControlMsg.authComplete, content: AapEncode.authComplete(), encrypted: false)
                    startPinging()
                }
            } catch { end("TLS handshake failed: \(error)") }
        case ControlMsg.serviceDiscoveryRequest:
            let (name, brand) = AapDecode.serviceDiscoveryRequest(content)
            if name != nil || brand != nil { delegate.session(phoneName: name ?? "?", brand: brand ?? "?") }
            sender.send(channel: AapProto.chControl, messageId: ControlMsg.serviceDiscoveryResponse,
                        content: Discovery.buildServiceDiscoveryResponse(cfg), encrypted: true)
            delegate.session(status: "Service discovery answered — waiting for channels…")
        case ControlMsg.audioFocusRequest:
            let req = AapDecode.audioFocusRequest(content)
            let state: Int
            switch req {
            case AudioFocusRequestType.release: state = AudioFocusState.loss
            case AudioFocusRequestType.gainTransient: state = AudioFocusState.gainTransient
            case AudioFocusRequestType.gainTransientMayDuck: state = AudioFocusState.gainTransientGuidanceOnly
            default: state = AudioFocusState.gain
            }
            sender.send(channel: AapProto.chControl, messageId: ControlMsg.audioFocusNotification,
                        content: AapEncode.audioFocusNotification(state, unsolicited: false), encrypted: true)
        case ControlMsg.navFocusRequest:
            sender.send(channel: AapProto.chControl, messageId: ControlMsg.navFocusNotification,
                        content: AapEncode.navFocusNotification(NavFocusType.navFocus2), encrypted: true)
        case ControlMsg.pingRequest:
            // ECHO the phone's timestamp — AA matches responses by it ("out of order" otherwise).
            let ts = AapDecode.pingTimestamp(content) ?? clock.nowNanos()
            sender.send(channel: AapProto.chControl, messageId: ControlMsg.pingResponse,
                        content: AapEncode.pingResponse(ts), encrypted: true)
        case ControlMsg.pingResponse:
            break // our keepalive ack'd
        case ControlMsg.byeByeRequest:
            sender.send(channel: AapProto.chControl, messageId: ControlMsg.byeByeResponse,
                        content: AapEncode.byeByeResponse(), encrypted: true)
            end("phone ended the session (byebye)")
        default:
            delegate.session(status: "unhandled control id=0x\(String(id, radix: 16))")
        }
    }

    private func handleSensor(_ id: Int, _ content: [UInt8]) {
        guard id == SensorMsg.startRequest else { return }
        let type = AapDecode.sensorRequestType(content)
        sender.send(channel: AapProto.chSensor, messageId: SensorMsg.startResponse,
                    content: AapEncode.sensorStartResponse(), encrypted: true)
        if type == SensorType.drivingStatus {
            sender.send(channel: AapProto.chSensor, messageId: SensorMsg.event, content: AapEncode.sensorEventDrivingStatus(), encrypted: true)
        } else if type == SensorType.night {
            sender.send(channel: AapProto.chSensor, messageId: SensorMsg.event, content: AapEncode.sensorEventNight(false), encrypted: true)
        }
    }

    private func handleInput(_ id: Int, _ content: [UInt8]) {
        if id == InputMsg.bindingRequest {
            sender.send(channel: AapProto.chInput, messageId: InputMsg.bindingResponse,
                        content: AapEncode.bindingResponse(), encrypted: true)
            delegate.session(status: "Input bound — touch is live.")
        }
    }

    private func handleMedia(_ ch: Int, _ id: Int, _ content: [UInt8]) {
        switch id {
        case MediaMsg.setup:
            sender.send(channel: ch, messageId: MediaMsg.config, content: AapEncode.mediaConfig(), encrypted: true)
            if ch == AapProto.chVideo { gainVideoFocus() }
            if AapProto.isAudio(ch) {
                sender.send(channel: AapProto.chControl, messageId: ControlMsg.audioFocusNotification,
                            content: AapEncode.audioFocusNotification(AudioFocusState.gain, unsolicited: true), encrypted: true)
            }
        case MediaMsg.start:
            mediaSession[ch] = AapDecode.mediaStartSession(content)
        case MediaMsg.stop:
            break
        case MediaMsg.videoFocusRequest:
            gainVideoFocus()
        case MediaMsg.microphoneRequest:
            let open = AapDecode.microphoneOpen(content)
            sender.send(channel: ch, messageId: MediaMsg.microphoneResponse,
                        content: AapEncode.microphoneResponse(mediaSession[ch] ?? 0), encrypted: true)
            delegate.session(micOpen: open)
        case MediaMsg.data:
            onDataMsg(ch, content, hasTimestamp: true)
        case MediaMsg.codecConfig:
            onDataMsg(ch, content, hasTimestamp: false)
        default:
            break
        }
    }

    private func onDataMsg(_ ch: Int, _ content: [UInt8], hasTimestamp: Bool) {
        let off = (hasTimestamp && content.count > 8) ? 8 : 0
        if content.count > off {
            let payload = Array(content[off...])
            if ch == AapProto.chVideo {
                if !streaming { streaming = true; delegate.sessionStreaming() }
                delegate.session(videoData: payload, codecConfig: !hasTimestamp)
            } else {
                delegate.session(audioData: payload, channel: ch)
            }
        }
        sender.send(channel: ch, messageId: MediaMsg.ack, content: AapEncode.mediaAck(mediaSession[ch] ?? 0), encrypted: true)
    }

    // --- unsolicited pushes ---------------------------------------------------------------

    private func pushDrivingStatus() {
        sender.send(channel: AapProto.chSensor, messageId: SensorMsg.event,
                    content: AapEncode.sensorEventDrivingStatus(), encrypted: true)
        delegate.session(status: "Driving status → unrestricted (projection gate unlocked).")
    }

    private func gainVideoFocus() {
        sender.send(channel: AapProto.chVideo, messageId: MediaMsg.videoFocusNotification,
                    content: AapEncode.videoFocusNotification(), encrypted: true)
    }

    private func startVideoFocusWatchdog() {
        guard videoFocusToken == nil else { return }
        videoFocusToken = delegate.scheduleRepeating(seconds: 1.5) { [weak self] in
            guard let self else { return }
            if self.stopped || self.streaming {
                if let t = self.videoFocusToken { self.delegate.cancelScheduled(t); self.videoFocusToken = nil }
                return
            }
            self.gainVideoFocus()
        }
    }

    private func startPinging() {
        guard pingToken == nil else { return }
        pingToken = delegate.scheduleRepeating(seconds: 1.0) { [weak self] in
            guard let self, !self.stopped else { return }
            self.sender.send(channel: AapProto.chControl, messageId: ControlMsg.pingRequest,
                             content: AapEncode.pingRequest(self.clock.nowNanos()), encrypted: true)
        }
    }

    private func end(_ reason: String) {
        guard !stopped else { return }
        stop()
        delegate.sessionEnded(reason: reason)
    }
}
