package com.mobilelabkit.headunit

import android.util.Log
import com.andrerinas.headunitrevived.aap.protocol.proto.Common
import com.andrerinas.headunitrevived.aap.protocol.proto.Input
import java.util.concurrent.Executors

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
    // Touch/key events are dispatched on the UI/main thread, but the socket write in
    // AapTransport.sendMessage MUST NOT run there — Android throws NetworkOnMainThreadException,
    // the write fails, and the whole AA session tears down (this is why touching the projected
    // screen killed streaming). Offload sends to one background thread; it also serializes them.
    private val tx = Executors.newSingleThreadExecutor { r -> Thread(r, "aap-input-tx") }
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

    /** One finger in a touch event: stable [id] (so the phone tracks each finger across frames)
     *  and its position in display coordinates. */
    class TouchPointer(val id: Int, val x: Int, val y: Int)

    /**
     * Forward a touch with ALL current fingers. Multi-pointer is what makes pinch-to-zoom / rotate
     * work: the phone needs every active finger's position each frame, plus [actionIndex] telling it
     * which finger the POINTER_DOWN/POINTER_UP applies to (Android MotionEvent semantics). Sending
     * only one pointer (the old behavior) made every gesture look like a single-finger drag.
     */
    fun sendTouch(action: Input.TouchEvent.PointerAction, pointers: List<TouchPointer>, actionIndex: Int) {
        val touch = Input.TouchEvent.newBuilder().setAction(action).setActionIndex(actionIndex)
        for (p in pointers) {
            touch.addPointerData(
                Input.TouchEvent.Pointer.newBuilder()
                    .setX(p.x.coerceIn(0, displayW)).setY(p.y.coerceIn(0, displayH)).setPointerId(p.id)
            )
        }
        val bytes = Input.InputReport.newBuilder()
            .setTimestamp(System.nanoTime())
            .setTouchEvent(touch)
            .build().toByteArray()
        tx.execute { runCatching { transport.sendMessage(AapProto.CH_INPUT, Input.MsgType.EVENT_VALUE, bytes, encrypted = true) } }
    }

    /**
     * Forwards a hardware/remote key (Android TV D-pad, BACK, media keys — same keycode space as
     * [android.view.KeyEvent]) to the phone's Android Auto session, same channel as touch. Lets a
     * TV remote drive AA navigation directly instead of only simulating taps.
     */
    fun sendKey(keycode: Int, down: Boolean) {
        val key = Input.Key.newBuilder().setKeycode(keycode).setDown(down).build()
        val keyEvent = Input.KeyEvent.newBuilder().addKeys(key).build()
        val bytes = Input.InputReport.newBuilder()
            .setTimestamp(System.nanoTime())
            .setKeyEvent(keyEvent)
            .build().toByteArray()
        tx.execute { runCatching { transport.sendMessage(AapProto.CH_INPUT, Input.MsgType.EVENT_VALUE, bytes, encrypted = true) } }
    }

    /** Stop the background sender — called on protocol teardown so the thread doesn't leak. */
    fun stop() { runCatching { tx.shutdownNow() } }

    companion object { private const val TAG = "headunit-input" }
}
