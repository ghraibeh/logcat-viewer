/**
 * Wire constants for the (modern) Android Auto protocol.
 * Port of android-headunit's AapProto.kt.
 *
 * Framing on the link:
 *   [channelId:1][flags:1][frameSize:2 BE] (+[totalSize:4 BE] when flags has FIRST) [payload]
 * flags = frameType | encryptionType | messageType. The decrypted payload starts with a
 * 2-byte BE message id, then the protobuf.
 */

// --- channel ids (head unit assigns these in the service-discovery response) ---
export const CH_CONTROL = 0;
export const CH_SENSOR = 1;
export const CH_VIDEO = 2;
export const CH_INPUT = 3;
export const CH_AUDIO_SPEECH = 4; // AU1
export const CH_AUDIO_SYSTEM = 5; // AU2
export const CH_AUDIO_MEDIA = 6; // AUD
export const CH_MIC = 7;
export const CH_BLUETOOTH = 8;
export const CH_MEDIA_PLAYBACK = 9;
export const CH_NAV = 10;

export const isAudio = (ch: number): boolean =>
  ch === CH_AUDIO_SPEECH || ch === CH_AUDIO_SYSTEM || ch === CH_AUDIO_MEDIA;

// --- flags byte components ---
export const FRAME_MIDDLE = 0;
export const FRAME_FIRST = 1;
export const FRAME_LAST = 2;
export const FRAME_BULK = 3;
export const FRAME_TYPE_MASK = 3;
export const ENC_PLAIN = 0;
export const ENC_ENCRYPTED = 1 << 3; // 0x08
export const MSG_SPECIFIC = 0;
export const MSG_CONTROL = 1 << 2; // 0x04

// Protocol version we advertise (major.minor). headunit-revived sends 1.2.
export const VERSION_MAJOR = 1;
export const VERSION_MINOR = 2;

// Control message ids that aren't the SSL/version raw path (rest come from proto.ts).
export const VERSION_REQUEST = 1;
export const VERSION_RESPONSE = 2;
export const SSL_HANDSHAKE = 3; // MESSAGE_ENCAPSULATED_SSL
export const AUTH_COMPLETE = 4;

export const MAX_FRAME_PAYLOAD = 0x4000;

export function channelName(id: number): string {
  switch (id) {
    case CH_CONTROL: return 'CONTROL';
    case CH_SENSOR: return 'SENSOR';
    case CH_VIDEO: return 'VIDEO';
    case CH_INPUT: return 'INPUT';
    case CH_AUDIO_SPEECH: return 'AUD_SPEECH';
    case CH_AUDIO_SYSTEM: return 'AUD_SYSTEM';
    case CH_AUDIO_MEDIA: return 'AUD_MEDIA';
    case CH_MIC: return 'MIC';
    case CH_BLUETOOTH: return 'BT';
    case CH_MEDIA_PLAYBACK: return 'MEDIA_PB';
    case CH_NAV: return 'NAV';
    default: return `CH${id}`;
  }
}

export const u16be = (v: number): Buffer => Buffer.from([(v >>> 8) & 0xff, v & 0xff]);
export const u32be = (v: number): Buffer =>
  Buffer.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
export const readU16 = (b: Buffer, o: number): number => (b[o] << 8) | b[o + 1];
