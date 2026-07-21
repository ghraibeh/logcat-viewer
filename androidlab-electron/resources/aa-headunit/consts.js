"use strict";
/**
 * Wire constants for the (modern) Android Auto protocol.
 * Port of android-headunit's AapProto.kt.
 *
 * Framing on the link:
 *   [channelId:1][flags:1][frameSize:2 BE] (+[totalSize:4 BE] when flags has FIRST) [payload]
 * flags = frameType | encryptionType | messageType. The decrypted payload starts with a
 * 2-byte BE message id, then the protobuf.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.readU16 = exports.u32be = exports.u16be = exports.MAX_FRAME_PAYLOAD = exports.AUTH_COMPLETE = exports.SSL_HANDSHAKE = exports.VERSION_RESPONSE = exports.VERSION_REQUEST = exports.VERSION_MINOR = exports.VERSION_MAJOR = exports.MSG_CONTROL = exports.MSG_SPECIFIC = exports.ENC_ENCRYPTED = exports.ENC_PLAIN = exports.FRAME_TYPE_MASK = exports.FRAME_BULK = exports.FRAME_LAST = exports.FRAME_FIRST = exports.FRAME_MIDDLE = exports.isAudio = exports.CH_NAV = exports.CH_MEDIA_PLAYBACK = exports.CH_BLUETOOTH = exports.CH_MIC = exports.CH_AUDIO_MEDIA = exports.CH_AUDIO_SYSTEM = exports.CH_AUDIO_SPEECH = exports.CH_INPUT = exports.CH_VIDEO = exports.CH_SENSOR = exports.CH_CONTROL = void 0;
exports.channelName = channelName;
// --- channel ids (head unit assigns these in the service-discovery response) ---
exports.CH_CONTROL = 0;
exports.CH_SENSOR = 1;
exports.CH_VIDEO = 2;
exports.CH_INPUT = 3;
exports.CH_AUDIO_SPEECH = 4; // AU1
exports.CH_AUDIO_SYSTEM = 5; // AU2
exports.CH_AUDIO_MEDIA = 6; // AUD
exports.CH_MIC = 7;
exports.CH_BLUETOOTH = 8;
exports.CH_MEDIA_PLAYBACK = 9;
exports.CH_NAV = 10;
const isAudio = (ch) => ch === exports.CH_AUDIO_SPEECH || ch === exports.CH_AUDIO_SYSTEM || ch === exports.CH_AUDIO_MEDIA;
exports.isAudio = isAudio;
// --- flags byte components ---
exports.FRAME_MIDDLE = 0;
exports.FRAME_FIRST = 1;
exports.FRAME_LAST = 2;
exports.FRAME_BULK = 3;
exports.FRAME_TYPE_MASK = 3;
exports.ENC_PLAIN = 0;
exports.ENC_ENCRYPTED = 1 << 3; // 0x08
exports.MSG_SPECIFIC = 0;
exports.MSG_CONTROL = 1 << 2; // 0x04
// Protocol version we advertise (major.minor). headunit-revived sends 1.2.
exports.VERSION_MAJOR = 1;
exports.VERSION_MINOR = 2;
// Control message ids that aren't the SSL/version raw path (rest come from proto.ts).
exports.VERSION_REQUEST = 1;
exports.VERSION_RESPONSE = 2;
exports.SSL_HANDSHAKE = 3; // MESSAGE_ENCAPSULATED_SSL
exports.AUTH_COMPLETE = 4;
exports.MAX_FRAME_PAYLOAD = 0x4000;
function channelName(id) {
    switch (id) {
        case exports.CH_CONTROL: return 'CONTROL';
        case exports.CH_SENSOR: return 'SENSOR';
        case exports.CH_VIDEO: return 'VIDEO';
        case exports.CH_INPUT: return 'INPUT';
        case exports.CH_AUDIO_SPEECH: return 'AUD_SPEECH';
        case exports.CH_AUDIO_SYSTEM: return 'AUD_SYSTEM';
        case exports.CH_AUDIO_MEDIA: return 'AUD_MEDIA';
        case exports.CH_MIC: return 'MIC';
        case exports.CH_BLUETOOTH: return 'BT';
        case exports.CH_MEDIA_PLAYBACK: return 'MEDIA_PB';
        case exports.CH_NAV: return 'NAV';
        default: return `CH${id}`;
    }
}
const u16be = (v) => Buffer.from([(v >>> 8) & 0xff, v & 0xff]);
exports.u16be = u16be;
const u32be = (v) => Buffer.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
exports.u32be = u32be;
const readU16 = (b, o) => (b[o] << 8) | b[o + 1];
exports.readU16 = readU16;
