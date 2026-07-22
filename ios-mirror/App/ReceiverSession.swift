import Foundation
import Network

/// Receiver-side networking: advertises `_mlkmirror._tcp` on the fixed port, accepts ONE
/// sender at a time (a new sender takes over — last wins), parses the MLK1 stream, and runs
/// the reverse control channel (touches + NEED_IDR) back to the sender.
///
/// Threading: all Network.framework callbacks land on `queue`; consumers get parsed events
/// via closures also invoked on `queue` (hop to main yourself for UI).
final class ReceiverSession {

    struct Geometry {
        var capW: Int, capH: Int, realW: Int, realH: Int
    }

    var onState: ((String) -> Void)?            // human-readable status line
    var onConnected: ((String) -> Void)?        // sender description
    var onDisconnected: (() -> Void)?
    var onGeometry: ((Geometry) -> Void)?       // header or mid-stream META
    var onVideoUnit: ((Data, Bool) -> Void)?    // (annexB, isConfig)
    var onAudioPCM: ((Data) -> Void)?           // 48k stereo s16 interleaved

    private let queue = DispatchQueue(label: "mirror-receiver")
    private var listener: NWListener?
    private var conn: NWConnection?
    private var running = false

    // Reverse-channel state. Touch sends are fire-and-forget; needIdr is a latched flag so
    // a burst of decode failures becomes one wire message per drain (same design as the
    // Android receiver's control writer).
    private var needIdrPending = false
    private var lastNeedIdrMs: Int64 = 0

    func start() {
        queue.async { self.startLocked() }
    }

    private func startLocked() {
        guard !running else { return }
        running = true
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            if let tcp = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
                tcp.noDelay = true
            }
            let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: MirrorWire.defaultPort)!)
            l.service = NWListener.Service(
                name: nil, // default: device name — what the Android picker shows
                type: MirrorWire.serviceType,
                txtRecord: NWTXTRecord([MirrorWire.txtVersionKey: MirrorWire.protoVersion])
            )
            l.newConnectionHandler = { [weak self] c in self?.accept(c) }
            l.stateUpdateHandler = { [weak self] st in
                switch st {
                case .ready: self?.onState?("Waiting for a sender…")
                case .failed(let e): self?.onState?("Listener failed: \(e)")
                default: break
                }
            }
            l.start(queue: queue)
            listener = l
        } catch {
            onState?("Couldn't open port \(MirrorWire.defaultPort): \(error)")
        }
    }

    func stop() {
        queue.async {
            self.running = false
            self.conn?.cancel(); self.conn = nil
            self.listener?.cancel(); self.listener = nil
        }
    }

    // --- accept + stream parsing ----------------------------------------------------------

    private func accept(_ c: NWConnection) {
        // Single-sender, last wins (the lesson from the AirPlay dual-sender chaos): a new
        // sender replaces the old one instead of interleaving two streams into one decoder.
        if let old = conn {
            onState?("New sender taking over")
            old.cancel()
        }
        conn = c
        c.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            switch st {
            case .ready:
                self.onConnected?(c.endpoint.debugDescription)
                self.readHeader(c)
            case .failed, .cancelled:
                if self.conn === c {
                    self.conn = nil
                    self.onDisconnected?()
                }
            default: break
            }
        }
        c.start(queue: queue)
    }

    private func receiveExactly(_ c: NWConnection, _ n: Int, _ done: @escaping (Data?) -> Void) {
        guard n > 0 else { done(Data()); return }
        c.receive(minimumIncompleteLength: n, maximumLength: n) { data, _, complete, error in
            if let data, data.count == n {
                done(data)
            } else {
                if error != nil || complete { done(nil) } else { done(nil) }
            }
        }
    }

    private func readHeader(_ c: NWConnection) {
        receiveExactly(c, 20) { [weak self] data in
            guard let self, self.conn === c else { return }
            guard let data, let h = try? MirrorWire.parseHeader(data) else {
                self.onState?("Rejected non-mirror peer")
                c.cancel()
                return
            }
            self.onGeometry?(Geometry(capW: Int(h.capW), capH: Int(h.capH),
                                      realW: Int(h.realW), realH: Int(h.realH)))
            self.readUnit(c)
        }
    }

    private func readUnit(_ c: NWConnection) {
        receiveExactly(c, 5) { [weak self] head in
            guard let self, self.conn === c else { return }
            guard let head else { c.cancel(); return }
            let len = Int(MirrorWire.int32(head, at: 0))
            let kind = head[head.startIndex + 4]
            guard len > 0, len <= MirrorWire.maxUnit else {
                self.onState?("Bad unit length \(len) — dropping sender")
                c.cancel()
                return
            }
            self.receiveExactly(c, len) { payload in
                guard self.conn === c else { return }
                guard let payload else { c.cancel(); return }
                switch kind {
                case MirrorWire.kindVideo: self.onVideoUnit?(payload, false)
                case MirrorWire.kindConfig: self.onVideoUnit?(payload, true)
                case MirrorWire.kindAudio: self.onAudioPCM?(payload)
                case MirrorWire.kindMeta:
                    if let m = MirrorWire.parseMeta(payload) {
                        self.onGeometry?(Geometry(capW: Int(m.capW), capH: Int(m.capH),
                                                  realW: Int(m.realW), realH: Int(m.realH)))
                    }
                default: break // unknown kinds: read + ignore (forward compatible)
                }
                self.readUnit(c)
            }
        }
    }

    // --- reverse control channel ----------------------------------------------------------

    /// Forward one touch to the sender (coordinates already in the sender's REAL pixels).
    func sendTouch(action: Int, x: Int, y: Int, dtMs: Int) {
        queue.async {
            guard let c = self.conn else { return }
            let t = MirrorWire.Touch(action: Int32(action), x: Int32(x), y: Int32(y), dtMs: Int32(dtMs))
            c.send(content: MirrorWire.touchData(t), completion: .idempotent)
        }
    }

    /// The decoder lost sync — ask the sender for a fresh IDR (throttled to 300 ms).
    func requestKeyframe() {
        queue.async {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            guard now - self.lastNeedIdrMs >= 300 else { self.needIdrPending = true; return }
            self.lastNeedIdrMs = now
            self.needIdrPending = false
            self.conn?.send(content: MirrorWire.needIdrData(), completion: .idempotent)
        }
        // A latched pending request is flushed on the next call; senders also honor
        // repeats, so the simple throttle is enough in practice.
    }
}
