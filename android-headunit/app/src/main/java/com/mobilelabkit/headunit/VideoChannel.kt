package com.mobilelabkit.headunit

import android.util.Log
import f1x.aasdk.proto.data.AVChannelData.AVChannel
import f1x.aasdk.proto.data.ChannelDescriptorData.ChannelDescriptor
import f1x.aasdk.proto.data.VideoConfigData.VideoConfig
import f1x.aasdk.proto.enums.AVChannelSetupStatusEnum.AVChannelSetupStatus
import f1x.aasdk.proto.enums.AVStreamTypeEnum.AVStreamType
import f1x.aasdk.proto.enums.StatusEnum.Status
import f1x.aasdk.proto.enums.VideoFPSEnum.VideoFPS
import f1x.aasdk.proto.enums.VideoFocusModeEnum.VideoFocusMode
import f1x.aasdk.proto.enums.VideoResolutionEnum.VideoResolution
import f1x.aasdk.proto.messages.AVChannelSetupResponseMessage.AVChannelSetupResponse
import f1x.aasdk.proto.messages.AVChannelStartIndicationMessage.AVChannelStartIndication
import f1x.aasdk.proto.messages.AVMediaAckIndicationMessage.AVMediaAckIndication
import f1x.aasdk.proto.messages.ChannelOpenResponseMessage.ChannelOpenResponse
import f1x.aasdk.proto.messages.ServiceDiscoveryResponseMessage.ServiceDiscoveryResponse
import f1x.aasdk.proto.messages.VideoFocusIndicationMessage.VideoFocusIndication

/**
 * Android Auto **video** channel (head-unit side). We advertise the display in service
 * discovery, then respond to the phone's channel-open + AV-setup, grant video focus, and
 * feed the incoming H.264 to [VideoDecoder]. Every media frame is acked.
 *
 * The head unit is reactive here — the phone drives; we answer (aasdk/OpenAuto VideoService).
 */
class VideoChannel(
    private val transport: AapTransport,
    private val decoder: VideoDecoder,
    private val onStatus: (String) -> Unit
) {
    @Volatile var session: Int = 0; private set

    /** Add our video channel descriptor to the service-discovery response. */
    fun fillFeatures(response: ServiceDiscoveryResponse.Builder) {
        val cfg = VideoConfig.newBuilder()
            .setVideoResolution(RES_ENUM)
            .setVideoFps(VideoFPS.Enum._30)
            .setMarginWidth(0)
            .setMarginHeight(0)
            .setDpi(160)
            .build()
        val av = AVChannel.newBuilder()
            .setStreamType(AVStreamType.Enum.VIDEO)
            .setAvailableWhileInCall(true)
            .addVideoConfigs(cfg)
            .build()
        response.addChannels(
            ChannelDescriptor.newBuilder()
                .setChannelId(AapProto.CH_VIDEO)
                .setAvChannel(av)
                .build()
        )
    }

    fun onMessage(messageId: Int, content: ByteArray) {
        when (messageId) {
            AapProto.CHANNEL_OPEN_REQUEST -> {
                send(AapProto.CHANNEL_OPEN_RESPONSE,
                    ChannelOpenResponse.newBuilder().setStatus(Status.Enum.OK).build().toByteArray())
                onStatus("Video channel opened.")
            }
            AapProto.AV_SETUP_REQUEST -> {
                send(AapProto.AV_SETUP_RESPONSE,
                    AVChannelSetupResponse.newBuilder()
                        .setMediaStatus(AVChannelSetupStatus.Enum.OK)
                        .setMaxUnacked(10)
                        .addConfigs(0) // we advertised one config → index 0
                        .build().toByteArray())
                grantFocus()
                onStatus("Video setup OK — focus granted, awaiting stream…")
            }
            AapProto.AV_VIDEO_FOCUS_REQUEST -> grantFocus()
            AapProto.AV_START_INDICATION -> {
                session = runCatching { AVChannelStartIndication.parseFrom(content).session }.getOrDefault(0)
                onStatus("Video streaming (session $session)…")
            }
            AapProto.AV_MEDIA_WITH_TIMESTAMP_INDICATION -> {
                if (content.size > 8) decoder.submit(content.copyOfRange(8, content.size)) // strip 8-byte ts
                ack()
            }
            AapProto.AV_MEDIA_INDICATION -> { decoder.submit(content); ack() }
            AapProto.AV_STOP_INDICATION -> onStatus("Video stopped.")
            else -> Log.d(TAG, "video msg 0x%04x".format(messageId))
        }
    }

    private fun grantFocus() {
        send(AapProto.AV_VIDEO_FOCUS_INDICATION,
            VideoFocusIndication.newBuilder()
                .setFocusMode(VideoFocusMode.Enum.FOCUSED)
                .setUnrequested(false)
                .build().toByteArray())
    }

    private fun ack() {
        send(AapProto.AV_MEDIA_ACK_INDICATION,
            AVMediaAckIndication.newBuilder().setSession(session).setValue(1).build().toByteArray())
    }

    private fun send(messageId: Int, content: ByteArray) {
        transport.sendMessage(AapProto.CH_VIDEO, messageId, content, encrypted = true)
    }

    companion object {
        private const val TAG = "headunit-video"
        // First-contact resolution: 480p (800x480) is the most broadly-accepted.
        val RES_ENUM: VideoResolution.Enum = VideoResolution.Enum._480p
        const val WIDTH = 800
        const val HEIGHT = 480
    }
}
