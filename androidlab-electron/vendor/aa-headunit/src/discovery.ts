import { PbWriter } from './pb';
import * as C from './consts';
import { MediaCodecType, AudioStreamType, SensorType, Resolution, resolutionDims, ResolutionKey } from './proto';

/**
 * Builds the modern Android Auto service-discovery response (port of DiscoveryResponse.kt).
 * Android Auto refuses to project unless the head unit advertises the full expected set —
 * sensor (driving status), video sink, touchscreen input, the three audio sinks, a
 * microphone source (required for Assistant), media-playback status and navigation status.
 */

export interface HuConfig {
  resolution: ResolutionKey;
  width: number;
  height: number;
  densityDpi: number;
  fps30: boolean;
}

export function makeConfig(resolution: ResolutionKey, densityDpi = 240): HuConfig {
  const [width, height] = resolutionDims[resolution];
  return { resolution, width, height, densityDpi, fps30: true };
}

const BRAND = 'AndroidLab';

export function buildServiceDiscoveryResponse(cfg: HuConfig): Buffer {
  const services: PbWriter[] = [];
  const service = (id: number, fill: (w: PbWriter) => void): PbWriter => {
    const w = new PbWriter().varint(1, id);
    fill(w);
    return w;
  };
  const audioConfig = (rate: number, bits: number, channels: number): PbWriter =>
    new PbWriter().varint(1, rate).varint(2, bits).varint(3, channels);

  // Sensor: driving status (safety gate) + night. SensorSourceService is Service field 2;
  // sensors(1) = repeated Sensor { type(1) }.
  services.push(
    service(C.CH_SENSOR, (w) =>
      w.msg(
        2,
        new PbWriter()
          .msg(1, new PbWriter().varint(1, SensorType.DRIVING_STATUS))
          .msg(1, new PbWriter().varint(1, SensorType.NIGHT)),
      ),
    ),
  );

  // Video sink (H.264). MediaSinkService is Service field 3:
  // availableType(1), audioType(2), audioConfigs(3), videoConfigs(4), availableWhileInCall(5).
  services.push(
    service(C.CH_VIDEO, (w) =>
      w.msg(
        3,
        new PbWriter()
          .varint(1, MediaCodecType.VIDEO_H264_BP)
          .varint(2, AudioStreamType.NONE)
          .msg(
            4,
            // VideoConfiguration: codecResolution(1), frameRate(2), marginWidth(3),
            // marginHeight(4), density(5), videoCodecType(10).
            new PbWriter()
              .varint(1, Resolution[cfg.resolution])
              .varint(2, 2 /* VideoFrameRateType._30 */)
              .varint(3, 0)
              .varint(4, 0)
              .varint(5, cfg.densityDpi)
              .varint(10, MediaCodecType.VIDEO_H264_BP),
          )
          .bool(5, true),
      ),
    ),
  );

  // Input (touchscreen) — sized to the advertised video resolution.
  // InputSourceService is Service field 4; touchscreen(2) = TouchConfig { width(1), height(2) }.
  services.push(
    service(C.CH_INPUT, (w) =>
      w.msg(4, new PbWriter().msg(2, new PbWriter().varint(1, cfg.width).varint(2, cfg.height))),
    ),
  );

  // Audio sinks: system, speech, media (PCM).
  const audioSink = (ch: number, streamType: number, rate: number, channels: number): PbWriter =>
    service(ch, (w) =>
      w.msg(
        3,
        new PbWriter()
          .varint(1, MediaCodecType.AUDIO_PCM)
          .varint(2, streamType)
          .msg(3, audioConfig(rate, 16, channels)),
      ),
    );
  services.push(audioSink(C.CH_AUDIO_SYSTEM, AudioStreamType.SYSTEM, 16000, 1));
  services.push(audioSink(C.CH_AUDIO_SPEECH, AudioStreamType.SPEECH, 16000, 1));
  services.push(audioSink(C.CH_AUDIO_MEDIA, AudioStreamType.MEDIA, 48000, 2));

  // Microphone source (required for the AA connection / Assistant).
  // MediaSourceService is Service field 5: type(1), audioConfig(2).
  services.push(
    service(C.CH_MIC, (w) =>
      w.msg(5, new PbWriter().varint(1, MediaCodecType.AUDIO_PCM).msg(2, audioConfig(16000, 16, 1))),
    ),
  );

  // Media-playback status (Service field 9, empty message) + navigation status (field 8:
  // minimumIntervalMs(1), type(2) = ImageCodesOnly(2)).
  services.push(service(C.CH_MEDIA_PLAYBACK, (w) => w.msg(9, new PbWriter())));
  services.push(
    service(C.CH_NAV, (w) => w.msg(8, new PbWriter().varint(1, 1000).varint(2, 2))),
  );

  // HeadUnitInfo (ServiceDiscoveryResponse field 17).
  const huInfo = new PbWriter()
    .string(1, BRAND)
    .string(2, `${BRAND} HeadUnit`)
    .string(3, BRAND)
    .string(4, BRAND)
    .string(5, '2026')
    .string(6, '1')
    .string(7, 'ALK0001')
    .string(8, '0.1');

  const out = new PbWriter();
  for (const s of services) out.msg(1, s);
  return out
    .string(2, BRAND)
    .string(3, BRAND)
    .string(4, '2026')
    .string(5, 'ALK0001')
    .varint(6, 0) // driverPosition = DRIVER_POSITION_LEFT
    .string(7, BRAND)
    .string(8, `${BRAND} HeadUnit`)
    .string(9, '1')
    .string(10, '0.1')
    .bool(11, false) // canPlayNativeMediaDuringVr
    .bool(12, false) // hideProjectedClock
    .string(14, BRAND) // displayName
    .msg(17, huInfo)
    .finish();
}
