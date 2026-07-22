import Foundation

/// App-group handoff between the app (which browses + picks the receiver) and the
/// broadcast extension (which runs headless and needs to know where to stream).
enum CastConfig {
    static let appGroup = "group.com.penguinin.mlkmirror"
    static let hostKey = "receiver_host"
    static let portKey = "receiver_port"
    static let nameKey = "receiver_name"

    static func savedReceiver() -> (host: String, port: UInt16)? {
        guard let d = UserDefaults(suiteName: appGroup),
              let host = d.string(forKey: hostKey), !host.isEmpty else { return nil }
        let port = UInt16(d.integer(forKey: portKey))
        return (host, port == 0 ? MirrorWire.defaultPort : port)
    }
}
