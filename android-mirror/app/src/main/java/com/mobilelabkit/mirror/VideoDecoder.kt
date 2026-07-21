package com.mobilelabkit.mirror

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.SystemClock
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Hardware H.264 decoder: Annex-B access units (from the sender's on-device encoder) ->
 * MediaCodec -> the SurfaceView's Surface. Runs a single decode thread that both feeds input
 * and drains output-to-Surface, so frames render as soon as they decode.
 *
 * We configure the codec to the **real coded size parsed from the SPS**, not a fixed guess:
 * the sender rebuilds its encoder at swapped dimensions when the phone rotates, so a fresh
 * config unit arrives mid-stream with a new resolution — we rebuild the codec for it. (Also
 * avoids configuring an oversized input port, which some vendors' decoders reject at start().)
 * [onVideoSize] reports the coded (cropped) size so the receiver can letterbox correctly.
 *
 * Real-time backpressure: [submit] BLOCKS rather than dropping — dropping a mid-stream P-frame
 * corrupts the picture until the next keyframe, so blocking backpressures TCP and lets the
 * SENDER make the clean drop decision (via keyframe resync).
 */
class VideoDecoder(
    private val fallbackW: Int,
    private val fallbackH: Int,
    private val onVideoSize: ((Int, Int) -> Unit)? = null,
) {

    private data class Chunk(val data: ByteArray, val isConfig: Boolean)

    private val queue = LinkedBlockingQueue<Chunk>(6)
    @Volatile private var surface: Surface? = null
    @Volatile private var running = false
    private var thread: Thread? = null

    private var codec: MediaCodec? = null
    private var ptsIndex = 0L
    @Volatile private var resetRequested = false

    // Most-recent SPS/PPS (Annex-B) — used to rebuild the codec after a surface loss without
    // waiting for the sender to resend it.
    @Volatile private var lastConfig: ByteArray? = null
    private var curW = 0
    private var curH = 0

    // Stall watchdog: if we keep feeding the codec input but it stops rendering output, the
    // decoder has wedged (lost sync on a dropped frame, or is bound to a surface that got swapped
    // out by an aspect/rotation resize). Rebuild it — it re-syncs at the sender's next keyframe
    // (≤1 s). Only fires while input is still arriving, so it never trips on a paused sender.
    private var lastInputMs = 0L
    private var lastRenderMs = 0L

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "mirror-decode").also { it.start() }
    }

    /** The SurfaceView's surface became available/destroyed/resized. Any change of surface
     *  instance (incl. an aspect/rotation resize that recreates it) forces a rebuild so the codec
     *  never renders into a surface it's no longer bound to. */
    fun setSurface(s: Surface?) {
        if (s !== surface) {
            surface = s
            resetRequested = true
        }
    }

    /** Feed one Annex-B unit from the sender. Blocks rather than dropping (see class doc). */
    fun submit(data: ByteArray, isConfig: Boolean) {
        if (!running) return
        try {
            if (!queue.offer(Chunk(data, isConfig), 2, TimeUnit.SECONDS)) {
                queue.poll(); queue.offer(Chunk(data, isConfig)) // last resort if decode wedged
            }
        } catch (e: InterruptedException) {
            // shutting down
        }
    }

    /** A sender disconnected — flush so the next connection reconfigures cleanly. */
    fun onDisconnected() {
        queue.clear()
        resetRequested = true
    }

    fun release() {
        running = false
        thread?.interrupt()
        try { thread?.join(200) } catch (_: InterruptedException) {}
        thread = null
        resetCodec()
        queue.clear()
    }

    private fun loop() {
        val info = MediaCodec.BufferInfo()
        while (running) {
            try {
                if (resetRequested) {
                    resetRequested = false
                    resetCodec()
                }
                val u = queue.poll(10, TimeUnit.MILLISECONDS)
                if (u != null) feed(u)
                drain(info)
                // Watchdog: input still flowing but no output for a while → wedged decoder.
                val now = SystemClock.elapsedRealtime()
                if (codec != null && lastInputMs != 0L &&
                    now - lastRenderMs > STALL_MS && now - lastInputMs < STALL_MS
                ) {
                    Log.w(TAG, "decoder stalled (${now - lastRenderMs}ms no output, input live) — rebuilding")
                    resetCodec() // next frame reconfigures from lastConfig; re-syncs at next keyframe
                }
            } catch (ie: InterruptedException) {
                break
            } catch (e: Exception) {
                Log.w(TAG, "decode error, resetting codec", e)
                resetCodec()
            }
        }
    }

    private fun feed(u: Chunk) {
        if (u.isConfig) {
            lastConfig = u.data
            val (w, h) = dimsFor(u.data)
            val c = codec
            if (c == null) {
                val s = surface ?: return
                configure(s, u.data, w, h)
            } else if (w != curW || h != curH) {
                // Stream resolution changed (rotation) → rebuild for the new size.
                resetCodec()
                val s = surface ?: return
                configure(s, u.data, w, h)
            }
            return // csd-0 already carries the SPS/PPS
        }

        var mc = codec
        if (mc == null) {
            // First frame after a surface (re)create — rebuild from the last SPS/PPS we saw.
            val cfg = lastConfig ?: return
            val s = surface ?: return
            val (w, h) = dimsFor(cfg)
            if (!configure(s, cfg, w, h)) return
            mc = codec ?: return
        }
        val idx = mc.dequeueInputBuffer(8_000)
        if (idx < 0) return // no free input buffer → drop (real-time)
        val buf = mc.getInputBuffer(idx) ?: return
        buf.clear()
        buf.put(u.data)
        mc.queueInputBuffer(idx, 0, u.data.size, ptsIndex++ * 16_666L, 0)
        lastInputMs = SystemClock.elapsedRealtime()
    }

    private fun drain(info: MediaCodec.BufferInfo) {
        val mc = codec ?: return
        while (true) {
            val idx = mc.dequeueOutputBuffer(info, 0)
            when {
                idx >= 0 -> {
                    mc.releaseOutputBuffer(idx, true) // render to the Surface
                    lastRenderMs = SystemClock.elapsedRealtime()
                }
                idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED ->
                    Log.i(TAG, "output format: ${mc.outputFormat}")
                else -> break
            }
        }
    }

    private fun dimsFor(config: ByteArray): Pair<Int, Int> =
        parseSpsDimensions(config) ?: (fallbackW.coerceAtMost(1920) to fallbackH.coerceAtMost(1920))

    private fun configure(s: Surface, csd: ByteArray, w: Int, h: Int): Boolean {
        return try {
            val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h)
            fmt.setByteBuffer("csd-0", ByteBuffer.wrap(csd)) // fully specify before start()
            fmt.setInteger("low-latency", 1)                 // API 30+ hint; harmless elsewhere
            val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            c.configure(fmt, s, null, 0)
            c.start()
            codec = c
            curW = w; curH = h
            ptsIndex = 0
            // Fresh codec — arm the watchdog from now so it isn't tripped by startup latency.
            val now = SystemClock.elapsedRealtime()
            lastRenderMs = now; lastInputMs = 0L
            Log.i(TAG, "MediaCodec configured ${w}x${h} (${c.name})")
            onVideoSize?.invoke(w, h)
            true
        } catch (e: Exception) {
            Log.e(TAG, "MediaCodec configure failed (${w}x${h})", e)
            resetCodec()
            false
        }
    }

    private fun resetCodec() {
        codec?.let {
            try { it.stop() } catch (_: Exception) {}
            try { it.release() } catch (_: Exception) {}
        }
        codec = null
        curW = 0; curH = 0
        lastInputMs = 0L // don't let the watchdog re-fire before the rebuilt codec renders
    }

    // --- H.264 SPS resolution parsing -------------------------------------------------------
    private fun parseSpsDimensions(annexb: ByteArray): Pair<Int, Int>? {
        val sps = findNalPayload(annexb, 7) ?: return null
        return try { decodeSpsDims(sps) } catch (_: Exception) { null }
    }

    private fun findNalPayload(data: ByteArray, type: Int): ByteArray? {
        val n = data.size
        var i = 0
        while (i + 2 < n) {
            val sc = when {
                data[i] == 0.toByte() && data[i + 1] == 0.toByte() && data[i + 2] == 1.toByte() -> 3
                i + 3 < n && data[i] == 0.toByte() && data[i + 1] == 0.toByte() &&
                    data[i + 2] == 0.toByte() && data[i + 3] == 1.toByte() -> 4
                else -> 0
            }
            if (sc == 0) { i++; continue }
            val nalStart = i + sc
            if (nalStart >= n) break
            val nalType = data[nalStart].toInt() and 0x1F
            var j = nalStart + 1
            while (j + 2 < n && !(data[j] == 0.toByte() && data[j + 1] == 0.toByte() && data[j + 2] == 1.toByte())) j++
            val nalEnd = if (j + 2 < n) j else n
            if (nalType == type) return stripEmulation(data, nalStart + 1, nalEnd)
            i = nalEnd
        }
        return null
    }

    private fun stripEmulation(data: ByteArray, from: Int, to: Int): ByteArray {
        val out = ByteArray(to - from)
        var k = 0; var zeros = 0; var i = from
        while (i < to) {
            val b = data[i]
            if (zeros >= 2 && b == 3.toByte() && i + 1 < to) { zeros = 0; i++; continue }
            out[k++] = b
            zeros = if (b == 0.toByte()) zeros + 1 else 0
            i++
        }
        return out.copyOf(k)
    }

    private class BitReader(private val d: ByteArray) {
        private var bytePos = 0
        private var bitPos = 0
        fun bit(): Int {
            val v = (d[bytePos].toInt() and 0xFF ushr (7 - bitPos)) and 1
            if (++bitPos == 8) { bitPos = 0; bytePos++ }
            return v
        }
        fun bits(n: Int): Int { var v = 0; repeat(n) { v = (v shl 1) or bit() }; return v }
        fun ue(): Int {
            var zeros = 0
            while (bit() == 0) zeros++
            var v = 1
            repeat(zeros) { v = (v shl 1) or bit() }
            return v - 1
        }
        fun se(): Int { val k = ue(); return if (k and 1 == 1) (k + 1) / 2 else -(k / 2) }
    }

    private fun decodeSpsDims(rbsp: ByteArray): Pair<Int, Int> {
        val r = BitReader(rbsp)
        val profileIdc = r.bits(8)
        r.bits(8)               // constraint flags + reserved
        r.bits(8)               // level_idc
        r.ue()                  // seq_parameter_set_id
        var chromaFormatIdc = 1
        if (profileIdc in HIGH_PROFILES) {
            chromaFormatIdc = r.ue()
            if (chromaFormatIdc == 3) r.bit()
            r.ue(); r.ue(); r.bit()
            if (r.bit() == 1) {
                val lists = if (chromaFormatIdc != 3) 8 else 12
                for (idx in 0 until lists) {
                    if (r.bit() == 1) {
                        val size = if (idx < 6) 16 else 64
                        var last = 8; var next = 8
                        for (j in 0 until size) {
                            if (next != 0) { val delta = r.se(); next = (last + delta + 256) % 256 }
                            if (next != 0) last = next
                        }
                    }
                }
            }
        }
        r.ue()                  // log2_max_frame_num_minus4
        val pocType = r.ue()
        when (pocType) {
            0 -> r.ue()
            1 -> { r.bit(); r.se(); r.se(); repeat(r.ue()) { r.se() } }
        }
        r.ue()                  // max_num_ref_frames
        r.bit()                 // gaps_in_frame_num_value_allowed_flag
        val widthMbs = r.ue() + 1
        val heightMap = r.ue() + 1
        val frameMbsOnly = r.bit()
        if (frameMbsOnly == 0) r.bit()
        r.bit()                 // direct_8x8_inference_flag
        var cl = 0; var cr = 0; var ct = 0; var cb = 0
        if (r.bit() == 1) { cl = r.ue(); cr = r.ue(); ct = r.ue(); cb = r.ue() }
        var width = widthMbs * 16
        var height = (2 - frameMbsOnly) * heightMap * 16
        val subW = if (chromaFormatIdc == 1 || chromaFormatIdc == 2) 2 else 1
        val subH = if (chromaFormatIdc == 1) 2 else 1
        val unitX = if (chromaFormatIdc == 0) 1 else subW
        val unitY = (if (chromaFormatIdc == 0) 1 else subH) * (2 - frameMbsOnly)
        width -= unitX * (cl + cr)
        height -= unitY * (ct + cb)
        require(width in 16..8192 && height in 16..8192) { "implausible SPS size ${width}x$height" }
        return width to height
    }

    companion object {
        private const val TAG = "mirror-video"
        private const val STALL_MS = 1500L // input flowing but no render this long ⇒ rebuild
        private val HIGH_PROFILES =
            intArrayOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135)
    }
}
