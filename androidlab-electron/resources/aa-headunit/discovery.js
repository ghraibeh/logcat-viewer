"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeConfig = makeConfig;
exports.buildServiceDiscoveryResponse = buildServiceDiscoveryResponse;
const pb_1 = require("./pb");
const C = __importStar(require("./consts"));
const proto_1 = require("./proto");
function makeConfig(resolution, densityDpi = 240) {
    const [width, height] = proto_1.resolutionDims[resolution];
    return { resolution, width, height, densityDpi, fps30: true };
}
const BRAND = 'AndroidLab';
function buildServiceDiscoveryResponse(cfg) {
    const services = [];
    const service = (id, fill) => {
        const w = new pb_1.PbWriter().varint(1, id);
        fill(w);
        return w;
    };
    const audioConfig = (rate, bits, channels) => new pb_1.PbWriter().varint(1, rate).varint(2, bits).varint(3, channels);
    // Sensor: driving status (safety gate) + night. SensorSourceService is Service field 2;
    // sensors(1) = repeated Sensor { type(1) }.
    services.push(service(C.CH_SENSOR, (w) => w.msg(2, new pb_1.PbWriter()
        .msg(1, new pb_1.PbWriter().varint(1, proto_1.SensorType.DRIVING_STATUS))
        .msg(1, new pb_1.PbWriter().varint(1, proto_1.SensorType.NIGHT)))));
    // Video sink (H.264). MediaSinkService is Service field 3:
    // availableType(1), audioType(2), audioConfigs(3), videoConfigs(4), availableWhileInCall(5).
    services.push(service(C.CH_VIDEO, (w) => w.msg(3, new pb_1.PbWriter()
        .varint(1, proto_1.MediaCodecType.VIDEO_H264_BP)
        .varint(2, proto_1.AudioStreamType.NONE)
        .msg(4, 
    // VideoConfiguration: codecResolution(1), frameRate(2), marginWidth(3),
    // marginHeight(4), density(5), videoCodecType(10).
    new pb_1.PbWriter()
        .varint(1, proto_1.Resolution[cfg.resolution])
        .varint(2, 2 /* VideoFrameRateType._30 */)
        .varint(3, 0)
        .varint(4, 0)
        .varint(5, cfg.densityDpi)
        .varint(10, proto_1.MediaCodecType.VIDEO_H264_BP))
        .bool(5, true))));
    // Input (touchscreen) — sized to the advertised video resolution.
    // InputSourceService is Service field 4; touchscreen(2) = TouchConfig { width(1), height(2) }.
    services.push(service(C.CH_INPUT, (w) => w.msg(4, new pb_1.PbWriter().msg(2, new pb_1.PbWriter().varint(1, cfg.width).varint(2, cfg.height)))));
    // Audio sinks: system, speech, media (PCM).
    const audioSink = (ch, streamType, rate, channels) => service(ch, (w) => w.msg(3, new pb_1.PbWriter()
        .varint(1, proto_1.MediaCodecType.AUDIO_PCM)
        .varint(2, streamType)
        .msg(3, audioConfig(rate, 16, channels))));
    services.push(audioSink(C.CH_AUDIO_SYSTEM, proto_1.AudioStreamType.SYSTEM, 16000, 1));
    services.push(audioSink(C.CH_AUDIO_SPEECH, proto_1.AudioStreamType.SPEECH, 16000, 1));
    services.push(audioSink(C.CH_AUDIO_MEDIA, proto_1.AudioStreamType.MEDIA, 48000, 2));
    // Microphone source (required for the AA connection / Assistant).
    // MediaSourceService is Service field 5: type(1), audioConfig(2).
    services.push(service(C.CH_MIC, (w) => w.msg(5, new pb_1.PbWriter().varint(1, proto_1.MediaCodecType.AUDIO_PCM).msg(2, audioConfig(16000, 16, 1)))));
    // Media-playback status (Service field 9, empty message) + navigation status (field 8:
    // minimumIntervalMs(1), type(2) = ImageCodesOnly(2)).
    services.push(service(C.CH_MEDIA_PLAYBACK, (w) => w.msg(9, new pb_1.PbWriter())));
    services.push(service(C.CH_NAV, (w) => w.msg(8, new pb_1.PbWriter().varint(1, 1000).varint(2, 2))));
    // HeadUnitInfo (ServiceDiscoveryResponse field 17).
    const huInfo = new pb_1.PbWriter()
        .string(1, BRAND)
        .string(2, `${BRAND} HeadUnit`)
        .string(3, BRAND)
        .string(4, BRAND)
        .string(5, '2026')
        .string(6, '1')
        .string(7, 'ALK0001')
        .string(8, '0.1');
    const out = new pb_1.PbWriter();
    for (const s of services)
        out.msg(1, s);
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
