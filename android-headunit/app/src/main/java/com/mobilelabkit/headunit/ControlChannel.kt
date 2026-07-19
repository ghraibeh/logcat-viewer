package com.mobilelabkit.headunit

import android.util.Log
import com.andrerinas.headunitrevived.aap.protocol.proto.Control
import com.mobilelabkit.headunit.AapTransport.Companion.readU16
import com.mobilelabkit.headunit.AapTransport.Companion.u16be

/**
 * Control-channel handshake, MODERN Android Auto protocol (headunit-revived-compatible):
 *
 *   HU → version request → phone → version response
 *   HU ⇄ TLS handshake (ENCAPSULATED_SSL messages, [AapCrypto] as client)
 *   HU → auth complete (status = success)
 *   phone → service discovery REQUEST → HU → service discovery RESPONSE (modern Service set)
 *   phone → audio-focus REQUEST → HU → audio-focus NOTIFICATION (STATE_GAIN, always grant)
 *   phone → nav-focus REQUEST → HU → nav-focus NOTIFICATION
 *   ping both ways
 */
class ControlChannel(
    private val transport: AapTransport,
    private val crypto: AapCrypto,
    private val videoConfig: HeadUnitConfig.VideoConfig,
    private val onStatus: (String) -> Unit
) {
    // Control message ids (Control.ControlMsgType).
    private val MSG_SERVICE_DISCOVERY_RESPONSE = Control.ControlMsgType.MESSAGE_SERVICE_DISCOVERY_RESPONSE_VALUE
    private val MSG_CHANNEL_OPEN_RESPONSE = Control.ControlMsgType.MESSAGE_CHANNEL_OPEN_RESPONSE_VALUE
    private val MSG_AUDIO_FOCUS_NOTIFICATION = Control.ControlMsgType.MESSAGE_AUDIO_FOCUS_NOTIFICATION_VALUE
    private val MSG_NAV_FOCUS_NOTIFICATION = Control.ControlMsgType.MESSAGE_NAV_FOCUS_NOTIFICATION_VALUE
    private val MSG_PING_RESPONSE = Control.ControlMsgType.MESSAGE_PING_RESPONSE_VALUE
    private val MSG_PING_REQUEST = Control.ControlMsgType.MESSAGE_PING_REQUEST_VALUE
    private val MSG_BYEBYE_RESPONSE = Control.ControlMsgType.MESSAGE_BYEBYE_RESPONSE_VALUE

    fun begin() {
        transport.sendMessage(
            AapProto.CH_CONTROL, AapProto.VERSION_REQUEST,
            u16be(AapProto.VERSION_MAJOR) + u16be(AapProto.VERSION_MINOR), encrypted = false
        )
        onStatus("Handshake: version request sent…")
    }

    fun onMessage(messageId: Int, content: ByteArray) {
        when (messageId) {
            AapProto.VERSION_RESPONSE -> onVersionResponse(content)
            AapProto.SSL_HANDSHAKE -> onSslHandshake(content)
            Control.ControlMsgType.MESSAGE_SERVICE_DISCOVERY_REQUEST_VALUE -> onServiceDiscoveryRequest()
            Control.ControlMsgType.MESSAGE_AUDIO_FOCUS_REQUEST_VALUE -> onAudioFocusRequest(content)
            Control.ControlMsgType.MESSAGE_NAV_FOCUS_REQUEST_VALUE -> onNavFocusRequest()
            MSG_PING_REQUEST -> respondPing(content)
            MSG_PING_RESPONSE -> { /* our keepalive ack'd */ }
            Control.ControlMsgType.MESSAGE_BYEBYE_REQUEST_VALUE -> onByeBye(content)
            else -> Log.d(TAG, "unhandled control id=0x%04x".format(messageId))
        }
    }

    private fun onVersionResponse(content: ByteArray) {
        val major = if (content.size >= 2) readU16(content, 0) else 0
        val minor = if (content.size >= 4) readU16(content, 2) else 0
        val status = if (content.size >= 6) readU16(content, 4) else -1
        Log.i(TAG, "version response $major.$minor status=$status")
        onStatus("Version $major.$minor — starting TLS…")
        transport.sendMessage(AapProto.CH_CONTROL, AapProto.SSL_HANDSHAKE, crypto.startHandshake(), encrypted = false)
    }

    private fun onSslHandshake(content: ByteArray) {
        val out = crypto.processHandshake(content)
        if (out.isNotEmpty()) {
            transport.sendMessage(AapProto.CH_CONTROL, AapProto.SSL_HANDSHAKE, out, encrypted = false)
        }
        if (crypto.finished) {
            onStatus("TLS established — auth complete…")
            // AUTH_COMPLETE payload = {status = STATUS_SUCCESS(0)} → protobuf bytes 08 00.
            transport.sendMessage(AapProto.CH_CONTROL, AapProto.AUTH_COMPLETE, byteArrayOf(0x08, 0x00), encrypted = false)
            startPinging()
        }
    }

    private fun onServiceDiscoveryRequest() {
        transport.sendMessage(
            AapProto.CH_CONTROL, MSG_SERVICE_DISCOVERY_RESPONSE,
            DiscoveryResponse.build(videoConfig), encrypted = true
        )
        onStatus("Service discovery answered (modern) — waiting for channels…")
    }

    /** Map the phone's focus request to the correct state (RELEASE→LOSS, GAIN→GAIN, …) —
     *  responding GAIN to a RELEASE makes the phone re-request forever and never open channels. */
    private fun onAudioFocusRequest(content: ByteArray) {
        val req = runCatching { Control.AudioFocusRequestNotification.parseFrom(content).request }.getOrNull()
        val state = when (req) {
            Control.AudioFocusRequestNotification.AudioFocusRequestType.RELEASE ->
                Control.AudioFocusNotification.AudioFocusStateType.STATE_LOSS
            Control.AudioFocusRequestNotification.AudioFocusRequestType.GAIN_TRANSIENT ->
                Control.AudioFocusNotification.AudioFocusStateType.STATE_GAIN_TRANSIENT
            Control.AudioFocusRequestNotification.AudioFocusRequestType.GAIN_TRANSIENT_MAY_DUCK ->
                Control.AudioFocusNotification.AudioFocusStateType.STATE_GAIN_TRANSIENT_GUIDANCE_ONLY
            else ->
                Control.AudioFocusNotification.AudioFocusStateType.STATE_GAIN
        }
        val notif = Control.AudioFocusNotification.newBuilder().setFocusState(state).setUnsolicited(false).build()
        transport.sendMessage(AapProto.CH_CONTROL, MSG_AUDIO_FOCUS_NOTIFICATION, notif.toByteArray(), encrypted = true)
        onStatus("Audio focus ${state.name}.")
    }

    private fun onNavFocusRequest() {
        val notif = Control.NavFocusNotification.newBuilder()
            .setFocusType(Control.NavFocusType.NAV_FOCUS_2)
            .build()
        transport.sendMessage(AapProto.CH_CONTROL, MSG_NAV_FOCUS_NOTIFICATION, notif.toByteArray(), encrypted = true)
    }

    private fun onByeBye(content: ByteArray) {
        Log.i(TAG, "phone sent byebye")
        transport.sendMessage(
            AapProto.CH_CONTROL, MSG_BYEBYE_RESPONSE,
            Control.ByeByeResponse.newBuilder().build().toByteArray(), encrypted = true
        )
        onStatus("Phone ended the session (byebye).")
    }

    private fun respondPing(content: ByteArray) {
        // ECHO the phone's ping timestamp — Android Auto matches the response to its outstanding
        // request by this value to measure latency. Replying with our own clock makes AA log
        // "Received out of order ping response" and treat the link as unhealthy.
        val ts = runCatching { Control.PingRequest.parseFrom(content).timestamp }.getOrDefault(System.nanoTime())
        val resp = Control.PingResponse.newBuilder().setTimestamp(ts).build()
        transport.sendMessage(AapProto.CH_CONTROL, MSG_PING_RESPONSE, resp.toByteArray(), encrypted = true)
    }

    // --- keepalive ping ---
    @Volatile private var pinging = false
    private var pingThread: Thread? = null
    private fun startPinging() {
        if (pinging) return
        pinging = true
        pingThread = Thread({
            while (pinging) {
                // ~1s cadence: Android Auto flags "Missing HU ping requests" at ~3s and drops an
                // unresponsive head unit, so 5s was far too slow. Real head units ping ~1/s.
                try { Thread.sleep(1000) } catch (e: InterruptedException) { break }
                if (!pinging) break
                runCatching {
                    val req = Control.PingRequest.newBuilder().setTimestamp(System.nanoTime()).build()
                    transport.sendMessage(AapProto.CH_CONTROL, MSG_PING_REQUEST, req.toByteArray(), encrypted = true)
                }
            }
        }, "aap-ping").also { it.start() }
    }

    fun stop() { pinging = false; pingThread?.interrupt(); pingThread = null }

    companion object { private const val TAG = "headunit-ctrl" }
}
