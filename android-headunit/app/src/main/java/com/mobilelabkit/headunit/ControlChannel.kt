package com.mobilelabkit.headunit

import android.util.Log
import com.mobilelabkit.headunit.AapTransport.Companion.readU16
import com.mobilelabkit.headunit.AapTransport.Companion.u16be
import f1x.aasdk.proto.data.ChannelDescriptorData.ChannelDescriptor
import f1x.aasdk.proto.enums.StatusEnum.Status
import f1x.aasdk.proto.messages.AuthCompleteIndicationMessage.AuthCompleteIndication
import f1x.aasdk.proto.messages.PingResponseMessage.PingResponse
import f1x.aasdk.proto.messages.ServiceDiscoveryRequestMessage.ServiceDiscoveryRequest
import f1x.aasdk.proto.messages.ServiceDiscoveryResponseMessage.ServiceDiscoveryResponse

/**
 * The Android Auto control-channel handshake (head-unit side), Phase 2:
 *
 *   version request → version response
 *   → TLS handshake (SSL_HANDSHAKE messages, driven by [AapCrypto])
 *   → auth complete
 *   → service discovery request → response (the phone's channel list)
 *
 * Phase 3+ picks up from [onReady] to open the video / input / audio channels.
 */
class ControlChannel(
    private val transport: AapTransport,
    private val crypto: AapCrypto,
    private val onStatus: (String) -> Unit,
    private val onReady: (ServiceDiscoveryResponse) -> Unit
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

    /** Route a decoded control message. (Non-control channels are Phase 3+.) */
    fun onMessage(channel: Int, encrypted: Boolean, messageId: Int, content: ByteArray) {
        if (channel != AapProto.CH_CONTROL) {
            Log.d(TAG, "msg on ${AapProto.channelName(channel)} id=0x%04x (phase 3+)".format(messageId))
            return
        }
        when (messageId) {
            AapProto.VERSION_RESPONSE -> onVersionResponse(content)
            AapProto.SSL_HANDSHAKE -> onSslHandshake(content)
            AapProto.SERVICE_DISCOVERY_RESPONSE -> onServiceDiscovery(content)
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
        if (status == 1) { // MISMATCH
            onStatus("Protocol version mismatch ($major.$minor). Can't continue.")
            return
        }
        onStatus("Version $major.$minor OK — starting TLS…")
        val hello = crypto.startHandshake()
        transport.sendMessage(AapProto.CH_CONTROL, AapProto.SSL_HANDSHAKE, hello, encrypted = false)
    }

    private fun onSslHandshake(content: ByteArray) {
        val out = crypto.processHandshake(content)
        if (out.isNotEmpty()) {
            transport.sendMessage(AapProto.CH_CONTROL, AapProto.SSL_HANDSHAKE, out, encrypted = false)
        }
        if (crypto.finished) {
            onStatus("TLS established — sending auth complete + service discovery…")
            val auth = AuthCompleteIndication.newBuilder().setStatus(Status.Enum.OK).build()
            transport.sendMessage(AapProto.CH_CONTROL, AapProto.AUTH_COMPLETE, auth.toByteArray(), encrypted = false)

            val disc = ServiceDiscoveryRequest.newBuilder()
                .setDeviceName("MobileLabKit")
                .setDeviceBrand("MobileLabKit")
                .build()
            transport.sendMessage(
                AapProto.CH_CONTROL, AapProto.SERVICE_DISCOVERY_REQUEST, disc.toByteArray(),
                encrypted = true
            )
        }
    }

    private fun onServiceDiscovery(content: ByteArray) {
        val resp = try {
            ServiceDiscoveryResponse.parseFrom(content)
        } catch (e: Exception) {
            Log.e(TAG, "bad service discovery response", e)
            onStatus("Service discovery parse failed."); return
        }
        val summary = resp.channelsList.joinToString("\n") { "  • ${describe(it)}" }
        Log.i(TAG, "service discovery: ${resp.channelsCount} channels\n$summary")
        onStatus(
            "✓ Android Auto link established\n\n" +
                "${resp.channelsCount} channels offered:\n$summary\n\n" +
                "(Phase 3 opens the video channel next.)"
        )
        onReady(resp)
    }

    private fun describe(c: ChannelDescriptor): String {
        val id = c.channelId
        val kind = when {
            c.hasAvChannel() -> "AV/" + c.avChannel.streamType.name
            c.hasInputChannel() -> "INPUT"
            c.hasSensorChannel() -> "SENSOR"
            c.hasAvInputChannel() -> "AV_INPUT"
            c.hasBluetoothChannel() -> "BLUETOOTH"
            c.hasNavigationChannel() -> "NAVIGATION"
            else -> "?"
        }
        return "ch $id: $kind"
    }

    private fun respondPing() {
        val pong = PingResponse.newBuilder().setTimestamp(System.nanoTime()).build()
        transport.sendMessage(AapProto.CH_CONTROL, AapProto.PING_RESPONSE, pong.toByteArray(), encrypted = true)
    }

    companion object {
        private const val TAG = "headunit-ctrl"
    }
}
