import AVFoundation
import AAHeadUnitCore

/// Plays AA's audio-sink PCM and captures the mic for the phone. AA advertises (and this
/// head unit accepts): media = 48 kHz stereo s16, speech/system = 16 kHz mono s16. Each
/// channel gets its own player node at its format; the mic captures 16 kHz mono s16 and is
/// pushed back through [onMicPCM] while the phone holds the mic open (Assistant/calls).
final class HuAudio {
    var onMicPCM: (([UInt8]) -> Void)?

    private let engine = AVAudioEngine()
    private var players: [Int: (node: AVAudioPlayerNode, format: AVAudioFormat)] = [:]
    private let queue = DispatchQueue(label: "aahu-audio")
    private var started = false
    private var micTapInstalled = false
    private var micAllowed = false

    private static func format(rate: Double, channels: AVAudioChannelCount) -> AVAudioFormat {
        AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: channels, interleaved: true)!
    }

    func start(allowMic: Bool) {
        queue.async {
            guard !self.started else { return }
            self.micAllowed = allowMic
            do {
                let s = AVAudioSession.sharedInstance()
                if allowMic {
                    // playAndRecord: audio sinks out + mic in for Assistant/calls.
                    try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
                } else {
                    // No mic permission — playback only; projection + audio-out still work.
                    try s.setCategory(.playback, mode: .default, options: [])
                }
                try s.setActive(true)
                for ch in [AapProto.chAudioMedia, AapProto.chAudioSpeech, AapProto.chAudioSystem] {
                    let fmt = ch == AapProto.chAudioMedia
                        ? Self.format(rate: 48000, channels: 2)
                        : Self.format(rate: 16000, channels: 1)
                    let node = AVAudioPlayerNode()
                    self.engine.attach(node)
                    self.engine.connect(node, to: self.engine.mainMixerNode, format: fmt)
                    self.players[ch] = (node, fmt)
                }
                try self.engine.start()
                for (_, p) in self.players { p.node.play() }
                self.started = true
            } catch {
                print("aahu-audio: start failed: \(error)")
            }
        }
    }

    func stop() {
        queue.async {
            guard self.started else { return }
            if self.micTapInstalled { self.engine.inputNode.removeTap(onBus: 0); self.micTapInstalled = false }
            self.engine.stop()
            self.players.removeAll()
            self.started = false
        }
    }

    /// One AA audio payload (interleaved s16 at the channel's advertised format).
    func play(_ pcm: [UInt8], channel: Int) {
        queue.async {
            guard self.started, let p = self.players[channel] else { return }
            let bytesPerFrame = Int(p.format.streamDescription.pointee.mBytesPerFrame)
            let frames = pcm.count / max(1, bytesPerFrame)
            guard frames > 0,
                  let buf = AVAudioPCMBuffer(pcmFormat: p.format, frameCapacity: AVAudioFrameCount(frames)) else { return }
            buf.frameLength = AVAudioFrameCount(frames)
            if let dst = buf.audioBufferList.pointee.mBuffers.mData {
                pcm.withUnsafeBytes { dst.copyMemory(from: $0.baseAddress!, byteCount: min(pcm.count, Int(buf.audioBufferList.pointee.mBuffers.mDataByteSize))) }
            }
            p.node.scheduleBuffer(buf, completionHandler: nil)
        }
    }

    /// The phone opened/closed the mic. While open, tap the input at 16 kHz mono and stream.
    /// No-op without mic permission — Assistant just won't hear, projection is unaffected.
    func setMicOpen(_ open: Bool) {
        queue.async {
            guard self.started, self.micAllowed else { return }
            if open, !self.micTapInstalled {
                let input = self.engine.inputNode
                let hwFormat = input.outputFormat(forBus: 0)
                let target = Self.format(rate: 16000, channels: 1)
                guard let converter = AVAudioConverter(from: hwFormat, to: target) else { return }
                input.installTap(onBus: 0, bufferSize: 1024, format: hwFormat) { [weak self] buf, _ in
                    guard let self else { return }
                    let ratio = target.sampleRate / hwFormat.sampleRate
                    let cap = AVAudioFrameCount(Double(buf.frameLength) * ratio) + 64
                    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: cap) else { return }
                    var served = false
                    _ = converter.convert(to: out, error: nil) { _, status in
                        if served { status.pointee = .noDataNow; return nil }
                        served = true; status.pointee = .haveData; return buf
                    }
                    if out.frameLength > 0, let base = out.audioBufferList.pointee.mBuffers.mData {
                        let n = Int(out.frameLength) * 2
                        self.onMicPCM?([UInt8](UnsafeRawBufferPointer(start: base, count: n)))
                    }
                }
                self.micTapInstalled = true
            } else if !open, self.micTapInstalled {
                self.engine.inputNode.removeTap(onBus: 0)
                self.micTapInstalled = false
            }
        }
    }
}
