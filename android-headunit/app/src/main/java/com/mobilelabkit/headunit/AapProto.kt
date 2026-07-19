package com.mobilelabkit.headunit

/**
 * Wire constants for the (modern) Android Auto protocol.
 *
 * Framing on the bulk link is unchanged from before:
 *   [channelId:1][flags:1][frameSize:2 BE] (+[totalSize:4 BE] when flags has FIRST) [payload]
 * flags = frameType | encryptionType | messageType. The decrypted payload starts with a
 * 2-byte BE message id, then the protobuf.
 *
 * Message ids + message shapes come from the vendored modern protos
 * (com.andrerinas.headunitrevived.aap.protocol.proto.*) — see Control/Media/Sensors/Input.
 * aasdk's 2018 message set is too old for Android Auto 1.7.
 */
object AapProto {
    // --- channel ids (headunit-revived Channel.kt; head unit assigns these) ---
    const val CH_CONTROL = 0
    const val CH_SENSOR = 1
    const val CH_VIDEO = 2
    const val CH_INPUT = 3
    const val CH_AUDIO_SPEECH = 4   // AU1
    const val CH_AUDIO_SYSTEM = 5   // AU2
    const val CH_AUDIO_MEDIA = 6    // AUD
    const val CH_MIC = 7
    const val CH_BLUETOOTH = 8
    const val CH_MEDIA_PLAYBACK = 9
    const val CH_NAV = 10

    fun isAudio(ch: Int) = ch == CH_AUDIO_SPEECH || ch == CH_AUDIO_SYSTEM || ch == CH_AUDIO_MEDIA
    fun isMediaLike(ch: Int) = ch == CH_VIDEO || ch == CH_MIC || isAudio(ch)

    // --- flags byte components ---
    const val FRAME_MIDDLE = 0
    const val FRAME_FIRST = 1
    const val FRAME_LAST = 2
    const val FRAME_BULK = 3
    const val FRAME_TYPE_MASK = 3
    const val ENC_PLAIN = 0
    const val ENC_ENCRYPTED = 1 shl 3 // 0x08
    const val MSG_SPECIFIC = 0
    const val MSG_CONTROL = 1 shl 2   // 0x04

    // Protocol version we advertise (major.minor).
    const val VERSION_MAJOR = 1
    const val VERSION_MINOR = 1

    // Control message ids that aren't the SSL/version raw path (rest come from Control proto).
    const val VERSION_REQUEST = 1
    const val VERSION_RESPONSE = 2
    const val SSL_HANDSHAKE = 3       // MESSAGE_ENCAPSULATED_SSL
    const val AUTH_COMPLETE = 4

    const val MAX_FRAME_PAYLOAD = 0x4000

    fun channelName(id: Int): String = when (id) {
        CH_CONTROL -> "CONTROL"; CH_SENSOR -> "SENSOR"; CH_VIDEO -> "VIDEO"; CH_INPUT -> "INPUT"
        CH_AUDIO_SPEECH -> "AUD_SPEECH"; CH_AUDIO_SYSTEM -> "AUD_SYSTEM"; CH_AUDIO_MEDIA -> "AUD_MEDIA"
        CH_MIC -> "MIC"; CH_BLUETOOTH -> "BT"; CH_MEDIA_PLAYBACK -> "MEDIA_PB"; CH_NAV -> "NAV"
        else -> "CH$id"
    }
}
