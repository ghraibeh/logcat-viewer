package com.mobilelabkit.mirror

/**
 * Shared capture-sizing rules, used by the sender at cast start ([SenderActivity]) and again by
 * [ScreenCaptureService] when the screen rotates and the encoder is rebuilt. Keeping it in one
 * place means a rotation recompute produces the same scaled size the initial cast did (just with
 * width/height swapped), so the receiver sees a consistent stream.
 */
object CaptureSpec {
    const val MAX_EDGE = 960     // cap the long edge → less bandwidth → lower latency
    const val FPS = 30
    const val BPP = 0.15         // bits-per-pixel-per-frame heuristic for the bitrate

    data class Size(val w: Int, val h: Int, val bitRate: Int)

    /** Scale the real display size so the long edge ≤ [MAX_EDGE], round to even, and derive a
     *  clamped bitrate. Preserves the display's aspect ratio (so the receiver can letterbox it). */
    fun compute(realW: Int, realH: Int): Size {
        var w = realW
        var h = realH
        val longEdge = maxOf(w, h)
        if (longEdge > MAX_EDGE) {
            val scale = MAX_EDGE.toFloat() / longEdge
            w = (w * scale).toInt()
            h = (h * scale).toInt()
        }
        w = even(w); h = even(h)
        val bitRate = (w.toLong() * h * FPS * BPP).toInt().coerceIn(1_500_000, 4_000_000)
        return Size(w, h, bitRate)
    }

    fun isLandscape(w: Int, h: Int) = w >= h

    private fun even(v: Int) = (v / 2 * 2).coerceAtLeast(2)
}
