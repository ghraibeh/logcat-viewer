import { PbWriter, decodeFields, fieldNum, fieldBig } from './pb';

/**
 * The Android Auto message subset a head unit needs — message-id tables, enum values, and
 * hand-written proto2 encoders/decoders. Field numbers transcribed from headunit-revived's
 * generated protobuf Java (vendored in android-headunit/, see PROVENANCE.md). Everything is
 * proto2 with UNPACKED repeated fields; fields are always written explicitly (has-bits), so
 * zero-valued fields like status=SUCCESS(0) still hit the wire.
 */

// --- message ids -------------------------------------------------------------

/** Control channel (Control.ControlMsgType). */
export const ControlMsg = {
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
} as const;

/** Media channels (Media.MsgType). */
export const MediaMsg = {
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
} as const;

/** Sensor channel (Sensors.SensorsMsgType). */
export const SensorMsg = {
  START_REQUEST: 0x8001,
  START_RESPONSE: 0x8002,
  EVENT: 0x8003,
} as const;

/** Input channel (Input.MsgType). */
export const InputMsg = {
  EVENT: 0x8001,
  BINDING_REQUEST: 0x8002,
  BINDING_RESPONSE: 0x8003,
} as const;

// --- enums --------------------------------------------------------------------

export const MessageStatus = { SUCCESS: 0 } as const;

export const MediaCodecType = { AUDIO_PCM: 1, VIDEO_H264_BP: 3 } as const;

export const AudioStreamType = { NONE: 0, SPEECH: 1, SYSTEM: 2, MEDIA: 3 } as const;

export const SensorType = { NIGHT: 10, DRIVING_STATUS: 13 } as const;

export const DrivingStatus = { UNRESTRICTED: 0 } as const;

export const VideoFocusMode = { PROJECTED: 1, NATIVE: 2 } as const;

export const AudioFocusRequestType = {
  NONE: 0,
  GAIN: 1,
  GAIN_TRANSIENT: 2,
  GAIN_TRANSIENT_MAY_DUCK: 3,
  RELEASE: 4,
} as const;

export const AudioFocusState = {
  GAIN: 1,
  GAIN_TRANSIENT: 2,
  LOSS: 3,
  LOSS_TRANSIENT_CAN_DUCK: 4,
  LOSS_TRANSIENT: 5,
  GAIN_MEDIA_ONLY: 6,
  GAIN_TRANSIENT_GUIDANCE_ONLY: 7,
} as const;

export const NavFocusType = { NAV_FOCUS_1: 1, NAV_FOCUS_2: 2 } as const;

export const TouchAction = {
  DOWN: 0,
  UP: 1,
  MOVE: 2,
  CANCEL: 3,
  POINTER_DOWN: 5,
  POINTER_UP: 6,
} as const;

/** VideoCodecResolutionType — the fixed AA resolution ladder. */
export const Resolution = {
  '800x480': 1,
  '1280x720': 2,
  '1920x1080': 3,
  '720x1280': 6,
  '1080x1920': 7,
} as const;
export type ResolutionKey = keyof typeof Resolution;

export const resolutionDims: Record<ResolutionKey, [number, number]> = {
  '800x480': [800, 480],
  '1280x720': [1280, 720],
  '1920x1080': [1920, 1080],
  '720x1280': [720, 1280],
  '1080x1920': [1080, 1920],
};

// --- encoders -------------------------------------------------------------------

/** ChannelOpenResponse { status(1) = SUCCESS } */
export const channelOpenResponse = (): Buffer =>
  new PbWriter().varint(1, MessageStatus.SUCCESS).finish();

/** AuthComplete { status(1) = SUCCESS } (the classic `08 00`). */
export const authComplete = (): Buffer => new PbWriter().varint(1, MessageStatus.SUCCESS).finish();

export const pingRequest = (timestampNs: bigint): Buffer =>
  new PbWriter().varint(1, timestampNs).finish();

export const pingResponse = (timestampNs: bigint): Buffer =>
  new PbWriter().varint(1, timestampNs).finish();

/** AudioFocusNotification { focusState(1), unsolicited(2) } */
export const audioFocusNotification = (state: number, unsolicited: boolean): Buffer =>
  new PbWriter().varint(1, state).bool(2, unsolicited).finish();

/** NavFocusNotification { focusType(1) } */
export const navFocusNotification = (type: number): Buffer =>
  new PbWriter().varint(1, type).finish();

export const byeByeResponse = (): Buffer => Buffer.alloc(0); // no fields

/** SensorResponse { status(1) = SUCCESS } */
export const sensorStartResponse = (): Buffer =>
  new PbWriter().varint(1, MessageStatus.SUCCESS).finish();

/** SensorBatch { drivingStatus(13) = DrivingStatusData { status(1) = UNRESTRICTED } } —
 *  THE projection gate: AA won't set up video until it knows the car is parked. */
export const sensorEventDrivingStatus = (): Buffer =>
  new PbWriter().msg(13, new PbWriter().varint(1, DrivingStatus.UNRESTRICTED)).finish();

/** SensorBatch { nightMode(10) = NightData { isNightMode(1) } } */
export const sensorEventNight = (isNight: boolean): Buffer =>
  new PbWriter().msg(10, new PbWriter().bool(1, isNight)).finish();

/** Media Config { status(1) = HEADUNIT(2), maxUnacked(2) = 16, configurationIndices(3) += 0 } */
export const mediaConfig = (): Buffer =>
  new PbWriter().varint(1, 2).varint(2, 16).varint(3, 0).finish();

/** Media Ack { sessionId(1), ack(2) = 1 } */
export const mediaAck = (sessionId: number): Buffer =>
  new PbWriter().varint(1, sessionId).varint(2, 1).finish();

/** MicrophoneResponse { status(1) = 0, sessionId(2) } */
export const microphoneResponse = (sessionId: number): Buffer =>
  new PbWriter().varint(1, 0).varint(2, sessionId).finish();

/** VideoFocusNotification { mode(1) = PROJECTED, unsolicited(2) = true } */
export const videoFocusNotification = (): Buffer =>
  new PbWriter().varint(1, VideoFocusMode.PROJECTED).bool(2, true).finish();

/** BindingResponse { status(1) = SUCCESS } */
export const bindingResponse = (): Buffer =>
  new PbWriter().varint(1, MessageStatus.SUCCESS).finish();

/** InputReport { timestamp(1), touchEvent(3) = TouchEvent {
 *    pointerData(1) = Pointer { x(1), y(2), pointerId(3) }, actionIndex(2)=0, action(3) } } */
export const inputReportTouch = (
  timestampNs: bigint,
  x: number,
  y: number,
  action: number,
  pointerId = 0,
): Buffer => {
  const pointer = new PbWriter().varint(1, x).varint(2, y).varint(3, pointerId);
  const touch = new PbWriter().msg(1, pointer).varint(2, 0).varint(3, action);
  return new PbWriter().varint(1, timestampNs).msg(3, touch).finish();
};

// --- decoders -------------------------------------------------------------------

/** ServiceDiscoveryRequest { phoneName(4), phoneBrand(5) } */
export function parseServiceDiscoveryRequest(content: Buffer): { phoneName?: string; phoneBrand?: string } {
  try {
    const f = decodeFields(content);
    const str = (n: number) => {
      const v = f.get(n)?.[0];
      return Buffer.isBuffer(v) ? v.toString('utf8') : undefined;
    };
    return { phoneName: str(4), phoneBrand: str(5) };
  } catch {
    return {};
  }
}

/** AudioFocusRequestNotification { request(1) } */
export function parseAudioFocusRequest(content: Buffer): number | undefined {
  try {
    return fieldNum(decodeFields(content), 1);
  } catch {
    return undefined;
  }
}

/** PingRequest { timestamp(1) } */
export function parsePingTimestamp(content: Buffer): bigint | undefined {
  try {
    return fieldBig(decodeFields(content), 1);
  } catch {
    return undefined;
  }
}

/** ChannelOpenRequest { priority(1), serviceId(2) } */
export function parseChannelOpenRequest(content: Buffer): { priority?: number; serviceId?: number } {
  try {
    const f = decodeFields(content);
    return { priority: fieldNum(f, 1), serviceId: fieldNum(f, 2) };
  } catch {
    return {};
  }
}

/** SensorRequest { type(1) } */
export function parseSensorRequestType(content: Buffer): number | undefined {
  try {
    return fieldNum(decodeFields(content), 1);
  } catch {
    return undefined;
  }
}

/** Media Start { sessionId(1) } */
export function parseMediaStartSession(content: Buffer): number {
  try {
    return fieldNum(decodeFields(content), 1) ?? 0;
  } catch {
    return 0;
  }
}

/** MicrophoneRequest { open(1) } */
export function parseMicrophoneOpen(content: Buffer): boolean {
  try {
    return (fieldNum(decodeFields(content), 1) ?? 0) !== 0;
  } catch {
    return false;
  }
}

/** ByeByeRequest { reason(1) } */
export function parseByeByeReason(content: Buffer): number | undefined {
  try {
    return fieldNum(decodeFields(content), 1);
  } catch {
    return undefined;
  }
}
