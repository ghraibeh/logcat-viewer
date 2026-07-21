"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.inputReportTouch = exports.bindingResponse = exports.videoFocusNotification = exports.microphoneResponse = exports.mediaAck = exports.mediaConfig = exports.sensorEventNight = exports.sensorEventDrivingStatus = exports.sensorStartResponse = exports.byeByeResponse = exports.navFocusNotification = exports.audioFocusNotification = exports.pingResponse = exports.pingRequest = exports.authComplete = exports.channelOpenResponse = exports.resolutionDims = exports.Resolution = exports.TouchAction = exports.NavFocusType = exports.AudioFocusState = exports.AudioFocusRequestType = exports.VideoFocusMode = exports.DrivingStatus = exports.SensorType = exports.AudioStreamType = exports.MediaCodecType = exports.MessageStatus = exports.InputMsg = exports.SensorMsg = exports.MediaMsg = exports.ControlMsg = void 0;
exports.parseServiceDiscoveryRequest = parseServiceDiscoveryRequest;
exports.parseAudioFocusRequest = parseAudioFocusRequest;
exports.parsePingTimestamp = parsePingTimestamp;
exports.parseChannelOpenRequest = parseChannelOpenRequest;
exports.parseSensorRequestType = parseSensorRequestType;
exports.parseMediaStartSession = parseMediaStartSession;
exports.parseMicrophoneOpen = parseMicrophoneOpen;
exports.parseByeByeReason = parseByeByeReason;
const pb_1 = require("./pb");
/**
 * The Android Auto message subset a head unit needs — message-id tables, enum values, and
 * hand-written proto2 encoders/decoders. Field numbers transcribed from headunit-revived's
 * generated protobuf Java (vendored in android-headunit/, see PROVENANCE.md). Everything is
 * proto2 with UNPACKED repeated fields; fields are always written explicitly (has-bits), so
 * zero-valued fields like status=SUCCESS(0) still hit the wire.
 */
// --- message ids -------------------------------------------------------------
/** Control channel (Control.ControlMsgType). */
exports.ControlMsg = {
    VERSION_REQUEST: 1,
    VERSION_RESPONSE: 2,
    SSL_HANDSHAKE: 3, // MESSAGE_ENCAPSULATED_SSL
    AUTH_COMPLETE: 4,
    SERVICE_DISCOVERY_REQUEST: 5,
    SERVICE_DISCOVERY_RESPONSE: 6,
    CHANNEL_OPEN_REQUEST: 7,
    CHANNEL_OPEN_RESPONSE: 8,
    PING_REQUEST: 11,
    PING_RESPONSE: 12,
    NAV_FOCUS_REQUEST: 13,
    NAV_FOCUS_NOTIFICATION: 14,
    BYEBYE_REQUEST: 15,
    BYEBYE_RESPONSE: 16,
    VOICE_SESSION_NOTIFICATION: 17,
    AUDIO_FOCUS_REQUEST: 18,
    AUDIO_FOCUS_NOTIFICATION: 19,
};
/** Media channels (Media.MsgType). */
exports.MediaMsg = {
    DATA: 0x0000,
    CODEC_CONFIG: 0x0001,
    SETUP: 0x8000,
    START: 0x8001,
    STOP: 0x8002,
    CONFIG: 0x8003,
    ACK: 0x8004,
    MICROPHONE_REQUEST: 0x8005,
    MICROPHONE_RESPONSE: 0x8006,
    VIDEO_FOCUS_REQUEST: 0x8007,
    VIDEO_FOCUS_NOTIFICATION: 0x8008,
};
/** Sensor channel (Sensors.SensorsMsgType). */
exports.SensorMsg = {
    START_REQUEST: 0x8001,
    START_RESPONSE: 0x8002,
    EVENT: 0x8003,
};
/** Input channel (Input.MsgType). */
exports.InputMsg = {
    EVENT: 0x8001,
    BINDING_REQUEST: 0x8002,
    BINDING_RESPONSE: 0x8003,
};
// --- enums --------------------------------------------------------------------
exports.MessageStatus = { SUCCESS: 0 };
exports.MediaCodecType = { AUDIO_PCM: 1, VIDEO_H264_BP: 3 };
exports.AudioStreamType = { NONE: 0, SPEECH: 1, SYSTEM: 2, MEDIA: 3 };
exports.SensorType = { NIGHT: 10, DRIVING_STATUS: 13 };
exports.DrivingStatus = { UNRESTRICTED: 0 };
exports.VideoFocusMode = { PROJECTED: 1, NATIVE: 2 };
exports.AudioFocusRequestType = {
    NONE: 0,
    GAIN: 1,
    GAIN_TRANSIENT: 2,
    GAIN_TRANSIENT_MAY_DUCK: 3,
    RELEASE: 4,
};
exports.AudioFocusState = {
    GAIN: 1,
    GAIN_TRANSIENT: 2,
    LOSS: 3,
    LOSS_TRANSIENT_CAN_DUCK: 4,
    LOSS_TRANSIENT: 5,
    GAIN_MEDIA_ONLY: 6,
    GAIN_TRANSIENT_GUIDANCE_ONLY: 7,
};
exports.NavFocusType = { NAV_FOCUS_1: 1, NAV_FOCUS_2: 2 };
exports.TouchAction = {
    DOWN: 0,
    UP: 1,
    MOVE: 2,
    CANCEL: 3,
    POINTER_DOWN: 5,
    POINTER_UP: 6,
};
/** VideoCodecResolutionType — the fixed AA resolution ladder. */
exports.Resolution = {
    '800x480': 1,
    '1280x720': 2,
    '1920x1080': 3,
    '720x1280': 6,
    '1080x1920': 7,
};
exports.resolutionDims = {
    '800x480': [800, 480],
    '1280x720': [1280, 720],
    '1920x1080': [1920, 1080],
    '720x1280': [720, 1280],
    '1080x1920': [1080, 1920],
};
// --- encoders -------------------------------------------------------------------
/** ChannelOpenResponse { status(1) = SUCCESS } */
const channelOpenResponse = () => new pb_1.PbWriter().varint(1, exports.MessageStatus.SUCCESS).finish();
exports.channelOpenResponse = channelOpenResponse;
/** AuthComplete { status(1) = SUCCESS } (the classic `08 00`). */
const authComplete = () => new pb_1.PbWriter().varint(1, exports.MessageStatus.SUCCESS).finish();
exports.authComplete = authComplete;
const pingRequest = (timestampNs) => new pb_1.PbWriter().varint(1, timestampNs).finish();
exports.pingRequest = pingRequest;
const pingResponse = (timestampNs) => new pb_1.PbWriter().varint(1, timestampNs).finish();
exports.pingResponse = pingResponse;
/** AudioFocusNotification { focusState(1), unsolicited(2) } */
const audioFocusNotification = (state, unsolicited) => new pb_1.PbWriter().varint(1, state).bool(2, unsolicited).finish();
exports.audioFocusNotification = audioFocusNotification;
/** NavFocusNotification { focusType(1) } */
const navFocusNotification = (type) => new pb_1.PbWriter().varint(1, type).finish();
exports.navFocusNotification = navFocusNotification;
const byeByeResponse = () => Buffer.alloc(0); // no fields
exports.byeByeResponse = byeByeResponse;
/** SensorResponse { status(1) = SUCCESS } */
const sensorStartResponse = () => new pb_1.PbWriter().varint(1, exports.MessageStatus.SUCCESS).finish();
exports.sensorStartResponse = sensorStartResponse;
/** SensorBatch { drivingStatus(13) = DrivingStatusData { status(1) = UNRESTRICTED } } —
 *  THE projection gate: AA won't set up video until it knows the car is parked. */
const sensorEventDrivingStatus = () => new pb_1.PbWriter().msg(13, new pb_1.PbWriter().varint(1, exports.DrivingStatus.UNRESTRICTED)).finish();
exports.sensorEventDrivingStatus = sensorEventDrivingStatus;
/** SensorBatch { nightMode(10) = NightData { isNightMode(1) } } */
const sensorEventNight = (isNight) => new pb_1.PbWriter().msg(10, new pb_1.PbWriter().bool(1, isNight)).finish();
exports.sensorEventNight = sensorEventNight;
/** Media Config { status(1) = HEADUNIT(2), maxUnacked(2) = 16, configurationIndices(3) += 0 } */
const mediaConfig = () => new pb_1.PbWriter().varint(1, 2).varint(2, 16).varint(3, 0).finish();
exports.mediaConfig = mediaConfig;
/** Media Ack { sessionId(1), ack(2) = 1 } */
const mediaAck = (sessionId) => new pb_1.PbWriter().varint(1, sessionId).varint(2, 1).finish();
exports.mediaAck = mediaAck;
/** MicrophoneResponse { status(1) = 0, sessionId(2) } */
const microphoneResponse = (sessionId) => new pb_1.PbWriter().varint(1, 0).varint(2, sessionId).finish();
exports.microphoneResponse = microphoneResponse;
/** VideoFocusNotification { mode(1) = PROJECTED, unsolicited(2) = true } */
const videoFocusNotification = () => new pb_1.PbWriter().varint(1, exports.VideoFocusMode.PROJECTED).bool(2, true).finish();
exports.videoFocusNotification = videoFocusNotification;
/** BindingResponse { status(1) = SUCCESS } */
const bindingResponse = () => new pb_1.PbWriter().varint(1, exports.MessageStatus.SUCCESS).finish();
exports.bindingResponse = bindingResponse;
/** InputReport { timestamp(1), touchEvent(3) = TouchEvent {
 *    pointerData(1) = Pointer { x(1), y(2), pointerId(3) }, actionIndex(2)=0, action(3) } } */
const inputReportTouch = (timestampNs, x, y, action, pointerId = 0) => {
    const pointer = new pb_1.PbWriter().varint(1, x).varint(2, y).varint(3, pointerId);
    const touch = new pb_1.PbWriter().msg(1, pointer).varint(2, 0).varint(3, action);
    return new pb_1.PbWriter().varint(1, timestampNs).msg(3, touch).finish();
};
exports.inputReportTouch = inputReportTouch;
// --- decoders -------------------------------------------------------------------
/** ServiceDiscoveryRequest { phoneName(4), phoneBrand(5) } */
function parseServiceDiscoveryRequest(content) {
    try {
        const f = (0, pb_1.decodeFields)(content);
        const str = (n) => {
            const v = f.get(n)?.[0];
            return Buffer.isBuffer(v) ? v.toString('utf8') : undefined;
        };
        return { phoneName: str(4), phoneBrand: str(5) };
    }
    catch {
        return {};
    }
}
/** AudioFocusRequestNotification { request(1) } */
function parseAudioFocusRequest(content) {
    try {
        return (0, pb_1.fieldNum)((0, pb_1.decodeFields)(content), 1);
    }
    catch {
        return undefined;
    }
}
/** PingRequest { timestamp(1) } */
function parsePingTimestamp(content) {
    try {
        return (0, pb_1.fieldBig)((0, pb_1.decodeFields)(content), 1);
    }
    catch {
        return undefined;
    }
}
/** ChannelOpenRequest { priority(1), serviceId(2) } */
function parseChannelOpenRequest(content) {
    try {
        const f = (0, pb_1.decodeFields)(content);
        return { priority: (0, pb_1.fieldNum)(f, 1), serviceId: (0, pb_1.fieldNum)(f, 2) };
    }
    catch {
        return {};
    }
}
/** SensorRequest { type(1) } */
function parseSensorRequestType(content) {
    try {
        return (0, pb_1.fieldNum)((0, pb_1.decodeFields)(content), 1);
    }
    catch {
        return undefined;
    }
}
/** Media Start { sessionId(1) } */
function parseMediaStartSession(content) {
    try {
        return (0, pb_1.fieldNum)((0, pb_1.decodeFields)(content), 1) ?? 0;
    }
    catch {
        return 0;
    }
}
/** MicrophoneRequest { open(1) } */
function parseMicrophoneOpen(content) {
    try {
        return ((0, pb_1.fieldNum)((0, pb_1.decodeFields)(content), 1) ?? 0) !== 0;
    }
    catch {
        return false;
    }
}
/** ByeByeRequest { reason(1) } */
function parseByeByeReason(content) {
    try {
        return (0, pb_1.fieldNum)((0, pb_1.decodeFields)(content), 1);
    }
    catch {
        return undefined;
    }
}
