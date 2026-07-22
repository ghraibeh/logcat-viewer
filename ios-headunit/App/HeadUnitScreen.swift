import SwiftUI
import AVFoundation
import UIKit
import AAHeadUnitCore

/// The head-unit screen: full-bleed AA projection with touch forwarded back to the phone,
/// and a waiting card (with this device's IP) before a phone connects. Design language
/// matches the MLK Mirror apps — cyan glyph, bold headline, dark card.
struct HeadUnitScreen: View {
    @StateObject private var model = HeadUnitModel()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            ProjectionView(model: model).ignoresSafeArea()
            if !model.streaming {
                VStack(spacing: 10) {
                    Image(systemName: "car.fill").font(.system(size: 42)).foregroundStyle(.cyan)
                    Text("Android Auto").font(.title2).bold().foregroundStyle(.white)
                    Text(model.status).font(.footnote).foregroundStyle(.gray)
                        .multilineTextAlignment(.center).padding(.horizontal, 32)
                    if let ip = model.ip {
                        Text("This head unit: \(ip):5288")
                            .font(.callout).monospaced().foregroundStyle(.cyan)
                        Text("Point the AA Wireless Helper here (or it auto-discovers “\(UIDevice.current.name)”).")
                            .font(.caption2).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center).padding(.horizontal, 40)
                    }
                }
            }
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .onAppear { model.start(); UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { model.stop(); UIApplication.shared.isIdleTimerDisabled = false }
    }
}

final class HeadUnitModel: ObservableObject, SessionDelegate {
    @Published var streaming = false
    @Published var status = "Starting…"
    @Published var ip: String? = localWifiIPv4()

    let renderer = HuVideoRenderer()
    let pip = PiPController()
    private let audio = HuAudio()
    private var service: HeadUnitService?
    private let ui = DispatchQueue.main
    private var foregroundObserver: NSObjectProtocol?

    // AA projected coordinate space (the resolution we advertised) — for touch mapping.
    // Landscape 1920x1080, like a real car head unit; ~160 dpi gives a roomy dashboard UI
    // (too-high density makes AA's UI phone-huge — the lesson from the Kotlin head unit).
    private let config = HuConfig(resolution: .r1920x1080, densityDpi: 160)
    var videoSize: CGSize = CGSize(width: 1920, height: 1080)

    func start() {
        guard let identity = HeadUnitService.loadIdentity() else {
            status = "Missing head-unit certificate (headunit.p12)"; return
        }
        audio.onMicPCM = { [weak self] pcm in self?.service?.sendMic(pcm) }
        renderer.onVideoSize = { [weak self] w, h in self?.videoSize = CGSize(width: w, height: h) }
        // Coming back from PiP/background: flush the decoder so AA's next keyframe repaints
        // cleanly instead of resuming on a stale reference frame.
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in if self?.streaming == true { self?.renderer.flush() } }
        // Ask for the mic up front (Assistant/calls). Denied is fine — start audio-out only
        // and the server anyway, so projection + audio still work without Assistant. Starting
        // the server also triggers iOS's local-network prompt (no API to request it).
        Permissions.requestMicrophone { [weak self] granted in
            guard let self else { return }
            self.audio.start(allowMic: granted)
            let svc = HeadUnitService(identity: identity, config: self.config, delegate: self)
            svc.onStatus = { [weak self] s in self?.ui.async { self?.status = s } }
            svc.start()
            self.service = svc
        }
    }

    func stop() {
        if let o = foregroundObserver { NotificationCenter.default.removeObserver(o) }
        foregroundObserver = nil
        pip.detach()
        service?.stop(); service = nil
        audio.stop()
        renderer.reset()
    }

    func forwardTouch(action: Int, x: Int, y: Int) { service?.sendTouch(action: action, x: x, y: y) }

    // MARK: SessionDelegate (hop to main for UI/media)
    func session(status: String) { ui.async { self.status = status } }
    func session(phoneName: String, brand: String) { ui.async { self.status = "\(brand) \(phoneName)" } }
    func session(channelOpened: Int) {}
    func session(videoData: [UInt8], codecConfig: Bool) { renderer.submit(videoData, codecConfig: codecConfig) }
    func session(audioData: [UInt8], channel: Int) { audio.play(audioData, channel: channel) }
    func session(micOpen: Bool) { audio.setMicOpen(micOpen) }
    func sessionStreaming() { ui.async { self.streaming = true } }
    func sessionEnded(reason: String) {
        ui.async {
            self.streaming = false
            self.renderer.reset()
            self.status = "Disconnected: \(reason)"
        }
    }
    // Core scheduler seam backed by a main-queue repeating timer.
    func scheduleRepeating(seconds: Double, _ body: @escaping () -> Void) -> Any {
        let t = Timer.scheduledTimer(withTimeInterval: seconds, repeats: true) { _ in body() }
        return t
    }
    func cancelScheduled(_ token: Any) { (token as? Timer)?.invalidate() }
}

/// UIKit host: the projection layer + touch capture mapping view→AA display coordinates.
struct ProjectionView: UIViewRepresentable {
    let model: HeadUnitModel
    func makeUIView(context: Context) -> HuTouchView {
        let v = HuTouchView(); v.backgroundColor = .black; v.model = model
        v.layer.addSublayer(model.renderer.layer)
        model.pip.attach(layer: model.renderer.layer) // auto-PiP on Home/app-switch
        return v
    }
    func updateUIView(_ uiView: HuTouchView, context: Context) {}
}

final class HuTouchView: UIView {
    weak var model: HeadUnitModel?
    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        model?.renderer.layer.frame = bounds
        CATransaction.commit()
    }
    override func touchesBegan(_ t: Set<UITouch>, with e: UIEvent?) { fwd(t, TouchAction.down) }
    override func touchesMoved(_ t: Set<UITouch>, with e: UIEvent?) { fwd(t, TouchAction.move) }
    override func touchesEnded(_ t: Set<UITouch>, with e: UIEvent?) { fwd(t, TouchAction.up) }
    override func touchesCancelled(_ t: Set<UITouch>, with e: UIEvent?) { fwd(t, TouchAction.cancel) }

    private func fwd(_ touches: Set<UITouch>, _ action: Int) {
        guard let model, let touch = touches.first else { return }
        let vs = model.videoSize
        guard vs.width > 0, vs.height > 0 else { return }
        // The projected video letterboxes inside our bounds (resizeAspect); map into it.
        let rect = AVMakeRect(aspectRatio: vs, insideRect: bounds)
        guard rect.width > 1, rect.height > 1 else { return }
        let p = touch.location(in: self)
        let nx = (p.x - rect.minX) / rect.width
        let ny = (p.y - rect.minY) / rect.height
        guard nx >= 0, nx <= 1, ny >= 0, ny <= 1 else { return }
        model.forwardTouch(action: action, x: Int(nx * vs.width), y: Int(ny * vs.height))
    }
}
