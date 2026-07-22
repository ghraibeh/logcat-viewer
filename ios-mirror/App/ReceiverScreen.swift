import SwiftUI
import AVFoundation
import UIKit

/// Full-screen receiver: advertises on the LAN, renders the incoming mirror, plays its
/// audio, and forwards touches on the video back to Android senders (live remote control —
/// coordinates mapped to the sender's REAL screen pixels, the dispatchGesture space).
struct ReceiverScreen: View {
    @StateObject private var model = ReceiverModel()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VideoHostView(model: model)
                .ignoresSafeArea()
            if !model.streaming {
                VStack(spacing: 10) {
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .font(.system(size: 44))
                        .foregroundStyle(.cyan)
                    Text("Waiting for a sender…").font(.title3).bold().foregroundStyle(.white)
                    Text("Open MLK Mirror on the other device\nand pick “\(UIDevice.current.name)”")
                        .multilineTextAlignment(.center)
                        .font(.footnote).foregroundStyle(.gray)
                    Text(model.status).font(.caption2).foregroundStyle(.gray.opacity(0.7))
                }
            }
        }
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .onAppear { model.start(); UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { model.stop(); UIApplication.shared.isIdleTimerDisabled = false }
    }
}

final class ReceiverModel: ObservableObject {
    @Published var streaming = false
    @Published var status = ""

    let session = ReceiverSession()
    let renderer = VideoRenderer()
    let audio = AudioPCMPlayer()
    let pip = PiPController()

    // Sender geometry for touch mapping (updated by header + META units).
    private(set) var senderRealW = 0
    private(set) var senderRealH = 0
    private(set) var videoSize = CGSize.zero

    private var foregroundObserver: NSObjectProtocol?

    func start() {
        // Run the audio engine from the start, even before any sender connects: its
        // continuous render (silence when idle) is what keeps this process — sockets,
        // decoder, PiP — alive in the background and behind the lock screen.
        audio.start()
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            // Coming back from background/lock: the decode session may have been
            // invalidated and the audio engine interrupted — resync both.
            self.audio.restartIfNeeded()
            if self.streaming { self.renderer.resync() }
        }
        renderer.onNeedKeyframe = { [weak self] in self?.session.requestKeyframe() }
        renderer.onVideoSize = { [weak self] w, h in
            self?.videoSize = CGSize(width: w, height: h)
        }
        session.onState = { [weak self] s in DispatchQueue.main.async { self?.status = s } }
        session.onConnected = { [weak self] _ in
            DispatchQueue.main.async { self?.audio.restartIfNeeded() }
        }
        session.onDisconnected = { [weak self] in
            DispatchQueue.main.async {
                self?.streaming = false
                self?.renderer.reset()
                self?.audio.stop()
            }
        }
        session.onGeometry = { [weak self] g in
            self?.senderRealW = g.realW
            self?.senderRealH = g.realH
        }
        session.onVideoUnit = { [weak self] data, isConfig in
            guard let self else { return }
            self.renderer.submit(data, isConfig: isConfig)
            if !isConfig {
                DispatchQueue.main.async {
                    if !self.streaming { self.streaming = true }
                }
            }
        }
        session.onAudioPCM = { [weak self] pcm in self?.audio.write(pcm) }
        session.start()
    }

    func stop() {
        if let o = foregroundObserver { NotificationCenter.default.removeObserver(o) }
        foregroundObserver = nil
        pip.detach()
        session.stop()
        audio.stop()
        renderer.reset()
    }
}

/// UIKit host: owns the AVSampleBufferDisplayLayer and captures touches, mapping them from
/// the letterboxed video rect to the sender's real pixel space (single finger, like the
/// Android receiver — one complete stroke per gesture).
struct VideoHostView: UIViewRepresentable {
    let model: ReceiverModel

    func makeUIView(context: Context) -> MirrorTouchView {
        let v = MirrorTouchView()
        v.backgroundColor = .black
        v.model = model
        v.layer.addSublayer(model.renderer.layer)
        // PiP hooks straight onto the display layer; auto-starts on Home/app-switch.
        model.pip.attach(layer: model.renderer.layer)
        return v
    }

    func updateUIView(_ uiView: MirrorTouchView, context: Context) {}
}

final class MirrorTouchView: UIView {
    weak var model: ReceiverModel?
    private var lastEventTime: TimeInterval = 0

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        model?.renderer.layer.frame = bounds
        CATransaction.commit()
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) { forward(touches, action: 0) }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) { forward(touches, action: 1) }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { forward(touches, action: 2) }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { forward(touches, action: 3) }

    private func forward(_ touches: Set<UITouch>, action: Int) {
        guard let model, let touch = touches.first,
              model.senderRealW > 0, model.senderRealH > 0,
              model.videoSize.width > 0, model.videoSize.height > 0 else { return }
        // The layer letterboxes (resizeAspect): compute the actual video rect inside our
        // bounds, then map view coords → sender real pixels.
        let rect = AVMakeRect(aspectRatio: model.videoSize, insideRect: bounds)
        guard rect.width > 1, rect.height > 1 else { return }
        let p = touch.location(in: self)
        let nx = (p.x - rect.minX) / rect.width
        let ny = (p.y - rect.minY) / rect.height
        guard nx >= 0, nx <= 1, ny >= 0, ny <= 1 else { return }
        let now = touch.timestamp
        let dt = lastEventTime == 0 ? 0 : Int((now - lastEventTime) * 1000)
        lastEventTime = action == 2 || action == 3 ? 0 : now
        model.session.sendTouch(
            action: action,
            x: Int(nx * CGFloat(model.senderRealW)),
            y: Int(ny * CGFloat(model.senderRealH)),
            dtMs: min(dt, 500)
        )
    }
}
