package com.mobilelabkit.headunit

import android.util.Log
import com.andrerinas.headunitrevived.aap.protocol.proto.Common
import com.andrerinas.headunitrevived.aap.protocol.proto.Input

/**
 * Modern AA input channel (head-unit side) — the touch-forwarding path. Answers the phone's
 * key-binding request, then pushes `Input.InputReport` touch events (down / move / up) in
 * display coordinates as the user touches the head-unit surface.
 */
class InputChannel(
    private val transport: AapTransport,
    private val displayW: Int,
    private val displayH: Int,
    private val onStatus: (String) -> Unit
) {
    fun onMessage(messageId: Int, content: ByteArray) {
        when (messageId) {
            Input.MsgType.BINDINGREQUEST_VALUE -> {
                transport.sendMessage(
                    AapProto.CH_INPUT, Input.MsgType.BINDINGRESPONSE_VALUE,
                    Input.BindingResponse.newBuilder().setStatus(Common.MessageStatus.STATUS_SUCCESS).build().toByteArray(),
                    encrypted = true
                )
                onStatus("Input bound — touch is live.")
            }
            else -> Log.d(TAG, "input msg 0x%04x".format(messageId))
        }
    }

    fun sendTouch(action: Input.TouchEvent.PointerAction, x: Int, y: Int) {
        val touch = Input.TouchEvent.newBuilder()
            .setAction(action)
            .addPointerData(
                Input.TouchEvent.Pointer.newBuilder()
                    .setX(x.coerceIn(0, displayW)).setY(y.coerceIn(0, displayH)).setPointerId(0)
            )
            .build()
        val report = Input.InputReport.newBuilder()
            .setTimestamp(System.nanoTime())
            .setTouchEvent(touch)
            .build()
        transport.sendMessage(AapProto.CH_INPUT, Input.MsgType.EVENT_VALUE, report.toByteArray(), encrypted = true)
    }

    companion object { private const val TAG = "headunit-input" }
}
