package com.mobilelabkit.mirror

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent

/**
 * Touch injection on the **controlled (sender) device** — the only unprivileged, no-root way
 * to synthesize taps/swipes system-wide (`dispatchGesture`, needs `canPerformGestures`).
 *
 * The receiver streams the raw touch (down/move/up); we accumulate a gesture's points and
 * dispatch ONE **complete** stroke on finger-up. A complete down→up stroke is what apps
 * recognise as a real click/scroll — a held, "continued" stroke tends to read as a long-press
 * or an unfinished gesture and never fires the view's click handler. A short clustered path is
 * a tap; a spread path is a swipe/scroll over its real duration.
 */
class MirrorAccessibilityService : AccessibilityService() {

    private val main = Handler(Looper.getMainLooper())
    private val xs = ArrayList<Float>(256)
    private val ys = ArrayList<Float>(256)
    private var totalMs = 0L

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        // We only inject gestures — receive NO events. Zeroing eventTypes stops the system
        // from generating/dispatching UI events to us, which otherwise loads the sender's CPU
        // and adds mirror latency. Gesture injection (canPerformGestures) is unaffected.
        runCatching {
            serviceInfo = serviceInfo?.apply {
                eventTypes = 0
                flags = 0
                notificationTimeout = 1000
            }
        }
        Log.i(TAG, "accessibility service connected — touch control available")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* inject only */ }
    override fun onInterrupt() {}

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    fun onTouch(t: MirrorProtocol.Touch) {
        main.post {
            when (t.action) {
                MirrorProtocol.TOUCH_DOWN -> {
                    xs.clear(); ys.clear(); totalMs = 0L
                    xs.add(t.x.toFloat()); ys.add(t.y.toFloat())
                }
                MirrorProtocol.TOUCH_MOVE -> {
                    if (xs.isEmpty()) { xs.add(t.x.toFloat()); ys.add(t.y.toFloat()) }
                    else { xs.add(t.x.toFloat()); ys.add(t.y.toFloat()); totalMs += t.dtMs }
                }
                MirrorProtocol.TOUCH_UP -> {
                    if (xs.isNotEmpty()) {
                        xs.add(t.x.toFloat()); ys.add(t.y.toFloat()); totalMs += t.dtMs
                        dispatchComplete()
                    }
                    xs.clear(); ys.clear()
                }
                MirrorProtocol.TOUCH_CANCEL -> { xs.clear(); ys.clear() }
            }
        }
    }

    /** Build one complete stroke through the accumulated points and dispatch it. */
    private fun dispatchComplete() {
        val path = Path()
        path.moveTo(xs[0], ys[0])
        if (xs.size == 1) {
            path.lineTo(xs[0] + 1f, ys[0]) // a tap needs a non-zero-length path
        } else {
            for (i in 1 until xs.size) path.lineTo(xs[i], ys[i])
        }
        // Tap ≈ a few ms; drag = its real duration. Clamp so a stray 0 still taps and a long
        // hold still long-presses. dispatchGesture wants > 0.
        val dur = totalMs.coerceIn(1L, 60_000L)
        val ok = runCatching {
            dispatchGesture(
                GestureDescription.Builder()
                    .addStroke(GestureDescription.StrokeDescription(path, 0L, dur))
                    .build(),
                null, null,
            )
        }.getOrDefault(false)
        Log.i(TAG, "inject ${xs.size}pt @ ${xs[0].toInt()},${ys[0].toInt()} dur=${dur}ms dispatched=$ok")
    }

    companion object {
        private const val TAG = "mirror-a11y"
        @Volatile var instance: MirrorAccessibilityService? = null
    }
}
