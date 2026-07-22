import Foundation

/// Head-unit capability config advertised in the service-discovery response.
public struct HuConfig {
    public let resolution: Resolution
    public let width: Int
    public let height: Int
    public let densityDpi: Int
    public let fps30: Bool

    public init(resolution: Resolution, densityDpi: Int = 240, fps30: Bool = true) {
        self.resolution = resolution
        (self.width, self.height) = resolution.dims
        self.densityDpi = densityDpi
        self.fps30 = fps30
    }
}

/// Builds the modern Android Auto service-discovery response — the Swift twin of the Electron
/// head unit's `discovery.ts`. AA refuses to project unless the head unit advertises the full
/// expected set: sensor (driving status), video sink, touchscreen, three audio sinks, a mic
/// source (required for Assistant), media-playback and navigation status.
public enum Discovery {
    private static let brand = "AndroidLab"

    public static func buildServiceDiscoveryResponse(_ cfg: HuConfig) -> [UInt8] {
        func service(_ id: Int, _ fill: (PbWriter) -> Void) -> PbWriter {
            let w = PbWriter().varint(1, id); fill(w); return w
        }
        func audioConfig(_ rate: Int, _ bits: Int, _ channels: Int) -> PbWriter {
            PbWriter().varint(1, rate).varint(2, bits).varint(3, channels)
        }

        var services: [PbWriter] = []

        // Sensor: driving status (safety gate) + night. SensorSourceService = Service field 2.
        services.append(service(AapProto.chSensor) { w in
            w.msg(2, PbWriter()
                .msg(1, PbWriter().varint(1, SensorType.drivingStatus))
                .msg(1, PbWriter().varint(1, SensorType.night)))
        })

        // Video sink (H.264). MediaSinkService = Service field 3.
        services.append(service(AapProto.chVideo) { w in
            w.msg(3, PbWriter()
                .varint(1, MediaCodecType.videoH264BP)
                .varint(2, AudioStreamType.none)
                .msg(4, PbWriter()               // VideoConfiguration
                    .varint(1, cfg.resolution.rawValue)
                    .varint(2, 2)                // VideoFrameRateType._30
                    .varint(3, 0)                // marginWidth
                    .varint(4, 0)                // marginHeight
                    .varint(5, cfg.densityDpi)
                    .varint(10, MediaCodecType.videoH264BP))
                .bool(5, true))                  // availableWhileInCall
        })

        // Input (touchscreen) — sized to the advertised video resolution.
        services.append(service(AapProto.chInput) { w in
            w.msg(4, PbWriter().msg(2, PbWriter().varint(1, cfg.width).varint(2, cfg.height)))
        })

        // Audio sinks: system, speech, media (PCM).
        func audioSink(_ ch: Int, _ streamType: Int, _ rate: Int, _ channels: Int) -> PbWriter {
            service(ch) { w in
                w.msg(3, PbWriter()
                    .varint(1, MediaCodecType.audioPcm)
                    .varint(2, streamType)
                    .msg(3, audioConfig(rate, 16, channels)))
            }
        }
        services.append(audioSink(AapProto.chAudioSystem, AudioStreamType.system, 16000, 1))
        services.append(audioSink(AapProto.chAudioSpeech, AudioStreamType.speech, 16000, 1))
        services.append(audioSink(AapProto.chAudioMedia, AudioStreamType.media, 48000, 2))

        // Microphone source (required for the AA connection / Assistant). MediaSourceService = field 5.
        services.append(service(AapProto.chMic) { w in
            w.msg(5, PbWriter().varint(1, MediaCodecType.audioPcm).msg(2, audioConfig(16000, 16, 1)))
        })

        // Media-playback status (field 9, empty) + navigation status (field 8).
        services.append(service(AapProto.chMediaPlayback) { w in w.msg(9, PbWriter()) })
        services.append(service(AapProto.chNav) { w in w.msg(8, PbWriter().varint(1, 1000).varint(2, 2)) })

        let huInfo = PbWriter()
            .string(1, brand).string(2, "\(brand) HeadUnit").string(3, brand).string(4, brand)
            .string(5, "2026").string(6, "1").string(7, "ALK0001").string(8, "0.1")

        let out = PbWriter()
        for s in services { out.msg(1, s) }
        return out
            .string(2, brand).string(3, brand).string(4, "2026").string(5, "ALK0001")
            .varint(6, 0)                        // driverPosition = LEFT
            .string(7, brand).string(8, "\(brand) HeadUnit").string(9, "1").string(10, "0.1")
            .bool(11, false)                     // canPlayNativeMediaDuringVr
            .bool(12, false)                     // hideProjectedClock
            .string(14, brand)                   // displayName
            .msg(17, huInfo)
            .finish()
    }
}
