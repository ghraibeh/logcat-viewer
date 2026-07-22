import Foundation
import Network
import Security
import AAHeadUnitCore

/// The head-unit server: advertises `_mlkheadunit._tcp` (the discovery name the AA Wireless
/// Helper browses) + listens on the fixed AA wireless port 5288, and on each accepted phone
/// stands up a full [AaSession] (TLS client identity from the bundled p12). The Swift twin
/// of Kotlin's `WirelessServer` + `MainActivity.startAaProtocol`.
///
/// The phone-side trigger is unchanged: your AA Wireless Helper fires Google's
/// WirelessStartupReceiver at THIS device's IP:5288, and the phone TCP-connects here.
final class HeadUnitService {
    static let port: UInt16 = 5288
    static let bonjourType = "_mlkheadunit._tcp"

    private let identity: SecIdentity
    private let config: HuConfig
    private weak var delegate: SessionDelegate?
    private let queue = DispatchQueue(label: "aa-headunit-server")

    private var listener: NWListener?
    private var transport: AaTransport?
    private var session: AaSession?
    private let clock = HostClock()

    var onStatus: ((String) -> Void)?

    init(identity: SecIdentity, config: HuConfig, delegate: SessionDelegate) {
        self.identity = identity
        self.config = config
        self.delegate = delegate
    }

    func start() {
        queue.async { self.startLocked() }
    }

    private func startLocked() {
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            if let tcp = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
                tcp.noDelay = true
                tcp.enableKeepalive = true
                tcp.keepaliveIdle = 2
            }
            let l = try NWListener(using: params, on: NWEndpoint.Port(rawValue: Self.port)!)
            l.service = NWListener.Service(name: nil, type: Self.bonjourType)
            l.newConnectionHandler = { [weak self] c in self?.accept(c) }
            l.stateUpdateHandler = { [weak self] st in
                switch st {
                case .ready: self?.onStatus?("Waiting for a phone — trigger AA at this device’s IP:5288")
                case .failed(let e): self?.onStatus?("Listener failed: \(e)")
                default: break
                }
            }
            l.start(queue: queue)
            listener = l
        } catch {
            onStatus?("Couldn't open port \(Self.port): \(error)")
        }
    }

    func stop() {
        queue.async {
            self.session?.stop(); self.session = nil
            self.transport?.stop(); self.transport = nil
            self.listener?.cancel(); self.listener = nil
        }
    }

    func sendTouch(action: Int, x: Int, y: Int) { session?.sendTouch(action: action, x: x, y: y) }
    func sendMic(_ pcm: [UInt8]) { session?.sendMic(pcm) }

    private func accept(_ c: NWConnection) {
        // Single phone at a time — a new connection replaces the old session.
        if let old = transport { old.stop() }
        session?.stop()

        guard let crypto = try? AapCrypto(identity: identity) else {
            onStatus?("TLS init failed"); c.cancel(); return
        }
        let transport = AaTransport(connection: c, crypto: crypto)
        let session = AaSession(sender: transport, crypto: crypto, config: config,
                                clock: clock, delegate: delegate!)
        transport.onMessage = { [weak session] ch, id, content in
            session?.handle(channel: ch, messageId: id, content: content)
        }
        transport.onError = { [weak self] msg in
            self?.delegate?.sessionEnded(reason: msg)
        }
        self.transport = transport
        self.session = session

        c.stateUpdateHandler = { [weak self] st in
            switch st {
            case .ready:
                transport.start()
                session.begin() // send the version request
            case .failed(let e):
                self?.delegate?.sessionEnded(reason: "connection failed: \(e)")
            case .cancelled:
                break
            default: break
            }
        }
        c.start(queue: queue)
    }

    /// Load the bundled head-unit identity (cert + key) for the TLS client role.
    static func loadIdentity() -> SecIdentity? {
        guard let url = Bundle.main.url(forResource: "headunit", withExtension: "p12"),
              let data = try? Data(contentsOf: url) else { return nil }
        var items: CFArray?
        let opts = [kSecImportExportPassphrase as String: "androidlab"] as CFDictionary
        guard SecPKCS12Import(data as CFData, opts, &items) == errSecSuccess,
              let arr = items as? [[String: Any]],
              let idAny = arr.first?[kSecImportItemIdentity as String] else { return nil }
        return (idAny as! SecIdentity)
    }
}

/// Monotonic clock for the core's ping/touch timestamps.
final class HostClock: MonoClock {
    func nowNanos() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
}

/// This device's Wi-Fi IPv4, shown on the waiting screen so the user can point the trigger.
func localWifiIPv4() -> String? {
    var address: String?
    var ifaddr: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
    defer { freeifaddrs(ifaddr) }
    var ptr = first
    while true {
        let flags = Int32(ptr.pointee.ifa_flags)
        let addr = ptr.pointee.ifa_addr.pointee
        if (flags & (IFF_UP | IFF_RUNNING)) == (IFF_UP | IFF_RUNNING),
           addr.sa_family == UInt8(AF_INET) {
            let name = String(cString: ptr.pointee.ifa_name)
            if name == "en0" { // Wi-Fi
                var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                if getnameinfo(ptr.pointee.ifa_addr, socklen_t(addr.sa_len), &host,
                               socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                    address = String(cString: host)
                }
            }
        }
        guard let next = ptr.pointee.ifa_next else { break }
        ptr = next
    }
    return address
}
