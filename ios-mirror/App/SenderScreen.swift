import SwiftUI
import Network
import ReplayKit

/// Caster setup: browse `_mlkmirror._tcp` receivers, resolve the chosen one to host:port,
/// hand that to the broadcast extension via the app group, then present the system
/// broadcast picker (system-wide capture only runs inside a Broadcast Upload Extension).
struct SenderScreen: View {
    @StateObject private var model = BrowserModel()

    var body: some View {
        VStack(spacing: 14) {
            if model.receivers.isEmpty {
                Spacer()
                ProgressView()
                Text("Looking for receivers…").font(.footnote).foregroundStyle(.secondary)
                Text("Open “Receive a screen” on the other device.")
                    .font(.caption2).foregroundStyle(.tertiary)
                Spacer()
            } else {
                List(model.receivers, id: \.self, selection: $model.selected) { name in
                    HStack {
                        Image(systemName: "tv").foregroundStyle(.cyan)
                        Text(name)
                        Spacer()
                        if model.selected == name {
                            if model.resolving {
                                ProgressView().controlSize(.small)
                            } else if model.resolvedHost != nil {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                            }
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { model.select(name) }
                }
                .listStyle(.insetGrouped)
            }

            if let host = model.resolvedHost {
                VStack(spacing: 8) {
                    Text("Ready to cast to \(model.selected ?? "") (\(host))")
                        .font(.footnote).foregroundStyle(.secondary)
                    BroadcastPickerButton()
                        .frame(width: 220, height: 52)
                    Text("The system picker starts “MLK Mirror Cast”.\nStop from the red status pill or the picker.")
                        .font(.caption2).foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                .padding(.bottom, 18)
            }
        }
        .navigationTitle("Cast this screen")
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }
}

/// Wraps RPSystemBroadcastPickerView pinned to our extension.
struct BroadcastPickerButton: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let v = RPSystemBroadcastPickerView()
        v.preferredExtension = "com.penguinin.mlkmirror.broadcast"
        v.showsMicrophoneButton = false
        // Restyle the system button so it reads as a proper call-to-action.
        if let btn = v.subviews.compactMap({ $0 as? UIButton }).first {
            btn.setTitle("  Start casting", for: .normal)
            btn.setTitleColor(.white, for: .normal)
            btn.titleLabel?.font = .boldSystemFont(ofSize: 17)
            btn.setImage(UIImage(systemName: "record.circle"), for: .normal)
            btn.tintColor = .white
            btn.backgroundColor = .systemCyan
            btn.layer.cornerRadius = 12
            btn.frame = v.bounds
            btn.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        }
        return v
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}

final class BrowserModel: ObservableObject {
    @Published var receivers: [String] = []
    @Published var selected: String?
    @Published var resolving = false
    @Published var resolvedHost: String?

    private var browser: NWBrowser?
    private var probe: NWConnection?
    private let queue = DispatchQueue(label: "mirror-browse")

    func start() {
        let b = NWBrowser(for: .bonjour(type: MirrorWire.serviceType, domain: nil), using: .tcp)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            let names: [String] = results.compactMap {
                if case let .service(name, _, _, _) = $0.endpoint { return name }
                return nil
            }.sorted()
            DispatchQueue.main.async { self?.receivers = names }
        }
        b.start(queue: queue)
        browser = b
    }

    func stop() {
        browser?.cancel(); browser = nil
        probe?.cancel(); probe = nil
    }

    /// Resolve the picked service to a concrete host:port by opening a throwaway
    /// connection (Network.framework resolves on connect), then store it where the
    /// broadcast extension reads it. The receiver binds a FIXED port, so the resolved
    /// address stays valid across its restarts.
    func select(_ name: String) {
        selected = name
        resolvedHost = nil
        resolving = true
        probe?.cancel()
        let endpoint = NWEndpoint.service(name: name, type: MirrorWire.serviceType,
                                          domain: "local.", interface: nil)
        let c = NWConnection(to: endpoint, using: .tcp)
        probe = c
        c.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            if case .ready = st {
                var host: String?
                var port: UInt16 = MirrorWire.defaultPort
                if let path = c.currentPath,
                   case let .hostPort(h, p)? = path.remoteEndpoint {
                    switch h {
                    case .ipv4(let a): host = "\(a)"
                    case .ipv6(let a): host = "\(a)"
                    case .name(let n, _): host = n
                    @unknown default: break
                    }
                    port = p.rawValue
                }
                c.cancel()
                DispatchQueue.main.async {
                    self.resolving = false
                    self.resolvedHost = host
                    if let host {
                        let d = UserDefaults(suiteName: CastConfig.appGroup)
                        d?.set(host, forKey: CastConfig.hostKey)
                        d?.set(Int(port), forKey: CastConfig.portKey)
                        d?.set(name, forKey: CastConfig.nameKey)
                    }
                }
            } else if case .failed = st {
                c.cancel()
                DispatchQueue.main.async { self.resolving = false }
            }
        }
        c.start(queue: queue)
    }
}
