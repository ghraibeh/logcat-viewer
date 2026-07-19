package com.mobilelabkit.headunit

import android.util.Log
import f1x.aasdk.proto.data.ChannelDescriptorData.ChannelDescriptor
import f1x.aasdk.proto.data.InputChannelData.InputChannel as ProtoInputChannel
import f1x.aasdk.proto.data.TouchConfigData.TouchConfig
import f1x.aasdk.proto.data.TouchEventData.TouchEvent
import f1x.aasdk.proto.data.TouchLocationData.TouchLocation
import f1x.aasdk.proto.enums.StatusEnum.Status
import f1x.aasdk.proto.enums.TouchActionEnum.TouchAction
import f1x.aasdk.proto.messages.BindingResponseMessage.BindingResponse
import f1x.aasdk.proto.messages.ChannelOpenResponseMessage.ChannelOpenResponse
import f1x.aasdk.proto.messages.InputEventIndicationMessage.InputEventIndication
import f1x.aasdk.proto.messages.ServiceDiscoveryResponseMessage.ServiceDiscoveryResponse

/**
 * Android Auto **input** channel (head-unit side) — this is the touch-forwarding path.
 *
 * We advertise a touchscreen sized to the video display, answer the phone's channel-open
 * and key-binding requests, then push `InputEventIndication` touch events (PRESS / DRAG /
 * RELEASE, in display coordinates) to the phone as the user touches the head-unit surface.
 */
class InputChannel(
    private val transport: AapTransport,
    private val displayW: Int,
    private val displayH: Int,
    private val onStatus: (String) -> Unit
) {
    /** Add our input (touchscreen) channel to the service-discovery response. */
    fun fillFeatures(response: ServiceDiscoveryResponse.Builder) {
        val touch = TouchConfig.newBuilder().setWidth(displayW).setHeight(displayH).build()
        val input = ProtoInputChannel.newBuilder()
            .setTouchScreenConfig(touch)
            .build()
        response.addChannels(
            ChannelDescriptor.newBuilder()
                .setChannelId(AapProto.CH_INPUT)
                .setInputChannel(input)
                .build()
        )
    }

    fun onMessage(messageId: Int, content: ByteArray) {
        when (messageId) {
            AapProto.CHANNEL_OPEN_REQUEST -> {
                send(AapProto.CHANNEL_OPEN_RESPONSE,
                    ChannelOpenResponse.newBuilder().setStatus(Status.Enum.OK).build().toByteArray())
                onStatus("Input channel opened — touch is live.")
            }
            AapProto.INPUT_BINDING_REQUEST ->
                send(AapProto.INPUT_BINDING_RESPONSE,
                    BindingResponse.newBuilder().setStatus(Status.Enum.OK).build().toByteArray())
            else -> Log.d(TAG, "input msg 0x%04x".format(messageId))
        }
    }

    /** Forward one touch sample. [action] is a [TouchAction] value; coordinates are already
     *  mapped into the display's pixel space (0..displayW, 0..displayH). */
    fun sendTouch(action: TouchAction.Enum, x: Int, y: Int) {
        val ev = InputEventIndication.newBuilder()
            .setTimestamp(System.nanoTime() / 1000) // microseconds
            .setTouchEvent(
                TouchEvent.newBuilder()
                    .setTouchAction(action)
                    .addTouchLocation(
                        TouchLocation.newBuilder()
                            .setX(x.coerceIn(0, displayW))
                            .setY(y.coerceIn(0, displayH))
                            .setPointerId(0)
                    )
            )
            .build()
        send(AapProto.INPUT_EVENT_INDICATION, ev.toByteArray())
    }

    private fun send(messageId: Int, content: ByteArray) {
        transport.sendMessage(AapProto.CH_INPUT, messageId, content, encrypted = true)
    }

    companion object { private const val TAG = "headunit-input" }
}
