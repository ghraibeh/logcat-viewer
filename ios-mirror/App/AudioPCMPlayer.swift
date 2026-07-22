import AVFoundation

/// Plays the mirror's raw audio units: 48 kHz stereo 16-bit interleaved PCM (KIND_AUDIO),
/// the fixed format both ends of the MLK1 protocol agree on. AVAudioEngine wants float32
/// deinterleaved, so each unit is converted on arrival (a trivial per-sample scale — the
/// units are ~10-20 ms each, this is noise CPU-wise).
final class AudioPCMPlayer {

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: Double(MirrorWire.audioSampleRate),
                                       channels: AVAudioChannelCount(MirrorWire.audioChannels))!
    private var started = false
    private let queue = DispatchQueue(label: "mirror-audio")

    func start() {
        queue.async {
            guard !self.started else { return }
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playback, mode: .moviePlayback)
                try session.setActive(true)
                self.engine.attach(self.player)
                self.engine.connect(self.player, to: self.engine.mainMixerNode, format: self.format)
                try self.engine.start()
                self.player.play()
                self.started = true
            } catch {
                // No audio is a degraded-but-fine state — video keeps mirroring.
                print("mirror-audio: engine start failed: \(error)")
            }
        }
    }

    func stop() {
        queue.async {
            guard self.started else { return }
            self.player.stop()
            self.engine.stop()
            self.started = false
        }
    }

    /// Recover from interruptions (lock screen, calls, media-services resets): the engine
    /// can be stopped out from under us while `started` is still true.
    func restartIfNeeded() {
        queue.async {
            if self.started, !self.engine.isRunning {
                do {
                    try AVAudioSession.sharedInstance().setActive(true)
                    try self.engine.start()
                    self.player.play()
                } catch {
                    print("mirror-audio: engine restart failed: \(error)")
                }
            }
        }
        start() // idempotent: no-ops when already started, cold-starts otherwise
    }

    /// One KIND_AUDIO payload: interleaved s16 stereo frames.
    func write(_ pcm: Data) {
        queue.async {
            guard self.started else { return }
            let bytesPerFrame = 2 * MirrorWire.audioChannels
            let frames = pcm.count / bytesPerFrame
            guard frames > 0,
                  let buf = AVAudioPCMBuffer(pcmFormat: self.format,
                                             frameCapacity: AVAudioFrameCount(frames)) else { return }
            buf.frameLength = AVAudioFrameCount(frames)
            pcm.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                let src = raw.bindMemory(to: Int16.self)
                let left = buf.floatChannelData![0]
                let right = buf.floatChannelData![1]
                for i in 0 ..< frames {
                    left[i] = Float(src[i * 2]) / 32768.0
                    right[i] = Float(src[i * 2 + 1]) / 32768.0
                }
            }
            self.player.scheduleBuffer(buf, completionHandler: nil)
        }
    }
}
