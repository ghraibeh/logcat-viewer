import Foundation
import Network
import AAHeadUnitCore

/// The socket half of the AA link on iOS — the app-side twin of Kotlin's `AapTransport`
/// I/O + `SocketLink`. Owns the `NWConnection`, drives an [AapFrameCodec] for framing +
/// per-frame decrypt, and serializes outbound sends (encrypt + write) on one queue so the
/// ordered TLS record stream never interleaves — the exact hazard the Kotlin note calls out
/// (a keepalive ping racing a touch corrupts the stream and drops the link).
///
/// It implements [MessageSender] so [AaSession] sends through it, and feeds inbound complete
/// messages back to the session via [onMessage].
final class AaTransport: MessageSender {
    var onMessage: ((_ channel: Int, _ messageId: Int, _ content: [UInt8]) -> Void)?
    var onError: ((String) -> Void)?

    private let conn: NWConnection
    private let codec: AapFrameCodec
    private let queue = DispatchQueue(label: "aa-transport")
    private var running = false
    private var lastRxMs = DispatchTime.now().uptimeNanoseconds / 1_000_000
    private var gotData = false
    private var stallTimer: DispatchSourceTimer?

    init(connection: NWConnection, crypto: AapCrypto) {
        self.conn = connection
        self.codec = AapFrameCodec(crypto: crypto)
    }

    func start() {
        running = true
        receiveLoop()
        // Stall backstop: AA pings ~1/s once up; a long silence means a dead link (ungraceful
        // Wi-Fi drop leaves the socket timing out forever with no EOF). Generous, like Kotlin.
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 5, repeating: 5)
        t.setEventHandler { [weak self] in
            guard let self, self.running else { return }
            let now = DispatchTime.now().uptimeNanoseconds / 1_000_000
            let window: UInt64 = self.gotData ? 30_000 : 10_000
            if now - self.lastRxMs > window { self.fail("link stalled (no data for \(window)ms)") }
        }
        t.resume()
        stallTimer = t
    }

    func stop() {
        running = false
        stallTimer?.cancel(); stallTimer = nil
        conn.cancel()
    }

    // MARK: MessageSender

    func send(channel: Int, messageId: Int, content: [UInt8], encrypted: Bool) {
        // Hop to the transport queue so encrypt+write is serialized against every other
        // sender (ping timer, touch, media ACKs) — one ordered outbound TLS stream.
        queue.async { [weak self] in
            guard let self, self.running else { return }
            do {
                let frames = try self.codec.encode(channel: channel, messageId: messageId,
                                                   content: content, encrypted: encrypted)
                self.conn.send(content: Data(frames), completion: .contentProcessed { err in
                    if let err { self.fail("write failed: \(err)") }
                })
            } catch {
                self.fail("encode/encrypt failed: \(error)")
            }
        }
    }

    // MARK: receive

    private func receiveLoop() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let error {
                self.fail("read error: \(error)")
                return
            }
            if let data, !data.isEmpty {
                self.gotData = true
                self.lastRxMs = DispatchTime.now().uptimeNanoseconds / 1_000_000
                // Decode on the transport queue (per-frame decrypt must stay in receive order).
                self.queue.async {
                    let msgs = self.codec.feed([UInt8](data))
                    for m in msgs { self.onMessage?(m.channel, m.messageId, m.content) }
                }
            }
            if isComplete {
                self.fail("link disconnected")
                return
            }
            if self.running { self.receiveLoop() }
        }
    }

    private func fail(_ msg: String) {
        guard running else { return }
        running = false
        stallTimer?.cancel(); stallTimer = nil
        onError?(msg)
    }
}
