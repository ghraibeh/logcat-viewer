package com.mobilelabkit.headunit

import android.util.Log
import com.mobilelabkit.headunit.AapTransport.Companion.readU16
import com.mobilelabkit.headunit.AapTransport.Companion.u16be
import f1x.aasdk.proto.enums.StatusEnum.Status
import f1x.aasdk.proto.messages.AuthCompleteIndicationMessage.AuthCompleteIndication
import f1x.aasdk.proto.messages.PingResponseMessage.PingResponse

/**
 * The Android Auto control-channel handshake (head-unit side):
 *
 *   HU → version request          → phone → version response
 *   HU ⇄ TLS handshake (SSL_HANDSHAKE messages, [AapCrypto] as client)
 *   HU → auth complete
 *   phone → service discovery REQUEST → HU → service discovery RESPONSE
 *
 * The head unit is the RESPONDER for discovery: the phone asks, and we answer describing
 * our own channels (video/input/audio/…). [buildDiscoveryResponse] assembles that proto
 * (MainActivity fills each channel's features). After the response the phone drives the
 * per-channel open/setup on the individual channels ([VideoChannel] etc.).
 */
class ControlChannel(
    private val transport: AapTransport,
    private val crypto: AapCrypto,
    private val onStatus: (String) -> Unit,
    private val buildDiscoveryResponse: () -> ByteArray
) {
    /** Kick off the handshake by requesting a protocol-version match. */
    fun begin() {
        transport.sendMessage(
            AapProto.CH_CONTROL, AapProto.VERSION_REQUEST,
            u16be(AapProto.VERSION_MAJOR) + u16be(AapProto.VERSION_MINOR),
            encrypted = false
        )
        onStatus("Handshake: version request sent…")
    }

    fun onMessage(messageId: Int, content: ByteArray) {
        when (messageId) {
            AapProto.VERSION_RESPONSE -> onVersionResponse(content)
            AapProto.SSL_HANDSHAKE -> onSslHandshake(content)
            AapProto.SERVICE_DISCOVERY_REQUEST -> onServiceDiscoveryRequest()
            AapProto.PING_REQUEST -> respondPing()
            AapProto.SHUTDOWN_REQUEST -> onStatus("Phone requested shutdown.")
            else -> Log.d(TAG, "unhandled control id=0x%04x".format(messageId))
        }
    }

    private fun onVersionResponse(content: ByteArray) {
        val major = if (content.size >= 2) readU16(content, 0) else 0
        val minor = if (content.size >= 4) readU16(content, 2) else 0
        val status = if (content.size >= 6) readU16(content, 4) else -1
        Log.i(TAG, "version response $major.$minor status=$status")
        if (status == 1) { onStatus("Protocol version mismatch ($major.$minor)."); return }
        onStatus("Version $major.$minor OK — starting TLS…")
        transport.sendMessage(AapProto.CH_CONTROL, AapProto.SSL_HANDSHAKE, crypto.startHandshake(), encrypted = false)
    }

    private fun onSslHandshake(content: ByteArray) {
        val out = crypto.processHandshake(content)
        if (out.isNotEmpty()) {
            transport.sendMessage(AapProto.CH_CONTROL, AapProto.SSL_HANDSHAKE, out, encrypted = false)
        }
        if (crypto.finished) {
            onStatus("TLS established — sending auth complete…")
            val auth = AuthCompleteIndication.newBuilder().setStatus(Status.Enum.OK).build()
            transport.sendMessage(AapProto.CH_CONTROL, AapProto.AUTH_COMPLETE, auth.toByteArray(), encrypted = false)
            // Now the phone will send a SERVICE_DISCOVERY_REQUEST; we answer it below.
        }
    }

    private fun onServiceDiscoveryRequest() {
        val response = buildDiscoveryResponse()
        transport.sendMessage(
            AapProto.CH_CONTROL, AapProto.SERVICE_DISCOVERY_RESPONSE, response, encrypted = true
        )
        onStatus("Service discovery answered — waiting for the phone to open channels…")
    }

    private fun respondPing() {
        val pong = PingResponse.newBuilder().setTimestamp(System.nanoTime()).build()
        transport.sendMessage(AapProto.CH_CONTROL, AapProto.PING_RESPONSE, pong.toByteArray(), encrypted = true)
    }

    companion object {
        private const val TAG = "headunit-ctrl"
    }
}
