package com.mobilelabkit.headunit

import android.util.Log
import com.andrerinas.headunitrevived.aap.protocol.proto.Control
import com.andrerinas.headunitrevived.aap.protocol.proto.Media

/**
 * A modern AA media channel (head-unit side): one instance per video / audio-sink / mic
 * channel. Handles the phone's setup → config, start, video-focus and microphone requests,
 * and the media data stream.
 *
 * Video (decoder != null): codec-config (msgId 1) + timestamped H.264 (msgId 0) → MediaCodec.
 * Audio sinks (decoder == null): data is dropped for now (Phase-5 AudioTrack), but ACKed so
 * the phone keeps streaming. Mic: answered so AA is satisfied (no capture yet).
 */
class MediaChannel(
    val channelId: Int,
    private val transport: AapTransport,
    private val decoder: VideoDecoder?,
    private val onStatus: (String) -> Unit
) {
    @Volatile private var session = 0

    fun onMessage(messageId: Int, content: ByteArray) {
        when (messageId) {
            Media.MsgType.MEDIA_MESSAGE_SETUP_VALUE -> onSetup()
            Media.MsgType.MEDIA_MESSAGE_START_VALUE -> onStart(content)
            Media.MsgType.MEDIA_MESSAGE_STOP_VALUE -> {}
            Media.MsgType.MEDIA_MESSAGE_VIDEO_FOCUS_REQUEST_VALUE -> gainVideoFocus()
            Media.MsgType.MEDIA_MESSAGE_MICROPHONE_REQUEST_VALUE -> onMicRequest(content)
            Media.MsgType.MEDIA_MESSAGE_DATA_VALUE -> onData(content, hasTimestamp = true)
            Media.MsgType.MEDIA_MESSAGE_CODEC_CONFIG_VALUE -> onData(content, hasTimestamp = false)
            else -> Log.d(TAG, "media[$channelId] msg 0x%04x".format(messageId))
        }
    }

    private fun onSetup() {
        val cfg = Media.Config.newBuilder()
            .setStatus(Media.Config.ConfigStatus.HEADUNIT)
            .setMaxUnacked(16)
            .addConfigurationIndices(0)
            .build()
        send(Media.MsgType.MEDIA_MESSAGE_CONFIG_VALUE, cfg.toByteArray())
        onStatus("${AapProto.channelName(channelId)} set up.")

        if (channelId == AapProto.CH_VIDEO) {
            gainVideoFocus()
        }
        if (AapProto.isAudio(channelId)) {
            // Grant audio focus (unsolicited) on the control channel so the phone routes audio here.
            val notif = Control.AudioFocusNotification.newBuilder()
                .setFocusState(Control.AudioFocusNotification.AudioFocusStateType.STATE_GAIN)
                .setUnsolicited(true)
                .build()
            transport.sendMessage(
                AapProto.CH_CONTROL, Control.ControlMsgType.MESSAGE_AUDIO_FOCUS_NOTIFICATION_VALUE,
                notif.toByteArray(), encrypted = true
            )
        }
    }

    /** Tell the phone the head unit is displaying AA (unsolicited PROJECTED focus). This is
     *  what prompts the phone to set up + start the video stream — headunit-revived sends it
     *  when its projection surface goes live. Called on video-channel open and on setup. */
    fun gainVideoFocus() {
        val notif = Media.VideoFocusNotification.newBuilder()
            .setMode(Media.VideoFocusMode.VIDEO_FOCUS_PROJECTED)
            .setUnsolicited(true)
            .build()
        send(Media.MsgType.MEDIA_MESSAGE_VIDEO_FOCUS_NOTIFICATION_VALUE, notif.toByteArray())
        onStatus("Video focus PROJECTED — awaiting stream…")
    }

    private fun onStart(content: ByteArray) {
        session = runCatching { Media.Start.parseFrom(content).sessionId }.getOrDefault(0)
        onStatus("${AapProto.channelName(channelId)} streaming (session $session)…")
    }

    private fun onData(content: ByteArray, hasTimestamp: Boolean) {
        if (decoder != null) {
            val off = if (hasTimestamp && content.size > 8) 8 else 0 // strip 8-byte timestamp
            if (content.size > off) decoder.submit(content.copyOfRange(off, content.size))
        }
        ack()
    }

    private fun ack() {
        val a = Media.Ack.newBuilder().setSessionId(session).setAck(1).build()
        send(Media.MsgType.MEDIA_MESSAGE_ACK_VALUE, a.toByteArray())
    }

    private fun onMicRequest(content: ByteArray) {
        val open = runCatching { Media.MicrophoneRequest.parseFrom(content).open }.getOrDefault(false)
        val resp = Media.MicrophoneResponse.newBuilder().setStatus(0).setSessionId(session).build()
        send(Media.MsgType.MEDIA_MESSAGE_MICROPHONE_RESPONSE_VALUE, resp.toByteArray())
        Log.i(TAG, "mic request open=$open")
    }

    private fun send(messageId: Int, content: ByteArray) {
        transport.sendMessage(channelId, messageId, content, encrypted = true)
    }

    companion object { private const val TAG = "headunit-media" }
}
