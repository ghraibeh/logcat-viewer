package com.mobilelabkit.headunit

/**
 * Android Auto wire constants (from aasdk's Messenger enums + ControlMessageIdsEnum).
 *
 * Frame on the bulk link:
 *   [channelId:1][flags:1][frameSize:2 BE] (+[totalSize:4 BE] when flags has FIRST) [payload]
 * flags = frameType | encryptionType | messageType.
 * The decrypted payload starts with a 2-byte BE message id, then the message content.
 */
object AapProto {
    // --- channel ids ---
    const val CH_CONTROL = 0
    const val CH_INPUT = 1
    const val CH_SENSOR = 2
    const val CH_VIDEO = 3
    const val CH_MEDIA_AUDIO = 4
    const val CH_SPEECH_AUDIO = 5
    const val CH_SYSTEM_AUDIO = 6
    const val CH_AV_INPUT = 7
    const val CH_BLUETOOTH = 8

    // --- flags byte components ---
    const val FRAME_MIDDLE = 0
    const val FRAME_FIRST = 1        // 1 << 0
    const val FRAME_LAST = 2         // 1 << 1
    const val FRAME_BULK = 3         // FIRST | LAST (single-frame message)
    const val FRAME_TYPE_MASK = 3

    const val ENC_PLAIN = 0
    const val ENC_ENCRYPTED = 1 shl 3  // 0x08

    const val MSG_SPECIFIC = 0
    const val MSG_CONTROL = 1 shl 2    // 0x04 (aasdk sends control-channel msgs as SPECIFIC)

    // --- control channel message ids (ControlMessageIdsEnum.proto) ---
    const val VERSION_REQUEST = 0x0001
    const val VERSION_RESPONSE = 0x0002
    const val SSL_HANDSHAKE = 0x0003
    const val AUTH_COMPLETE = 0x0004
    const val SERVICE_DISCOVERY_REQUEST = 0x0005
    const val SERVICE_DISCOVERY_RESPONSE = 0x0006
    const val CHANNEL_OPEN_REQUEST = 0x0007
    const val CHANNEL_OPEN_RESPONSE = 0x0008
    const val PING_REQUEST = 0x000b
    const val PING_RESPONSE = 0x000c
    const val NAVIGATION_FOCUS_REQUEST = 0x000d
    const val NAVIGATION_FOCUS_RESPONSE = 0x000e
    const val SHUTDOWN_REQUEST = 0x000f
    const val SHUTDOWN_RESPONSE = 0x0010
    const val AUDIO_FOCUS_REQUEST = 0x0012
    const val AUDIO_FOCUS_RESPONSE = 0x0013

    // Protocol version we advertise (aasdk Version.hpp: 1.1).
    const val VERSION_MAJOR = 1
    const val VERSION_MINOR = 1

    // aasdk splits messages larger than this into FIRST/MIDDLE/LAST frames.
    const val MAX_FRAME_PAYLOAD = 0x4000 // 16384

    fun channelName(id: Int): String = when (id) {
        CH_CONTROL -> "CONTROL"; CH_INPUT -> "INPUT"; CH_SENSOR -> "SENSOR"
        CH_VIDEO -> "VIDEO"; CH_MEDIA_AUDIO -> "MEDIA_AUDIO"; CH_SPEECH_AUDIO -> "SPEECH_AUDIO"
        CH_SYSTEM_AUDIO -> "SYSTEM_AUDIO"; CH_AV_INPUT -> "AV_INPUT"; CH_BLUETOOTH -> "BLUETOOTH"
        else -> "CH$id"
    }
}
