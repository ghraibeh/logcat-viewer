package com.mobilelabkit.airplay

import android.media.MediaCodec
import android.media.MediaFormat
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Hardware H.264 decoder: Annex-B access units (from the native AirPlay receiver) ->
 * MediaCodec -> the SurfaceView's Surface. Runs a single decode thread that both feeds
 * input and drains output-to-Surface, so frames render as soon as they decode.
 *
 * The receiver delivers SPS/PPS separately (isConfig=true) ahead of the IDR. We DON'T
 * configure the codec to the advertised display size (the iPhone streams at its own,
 * usually-smaller resolution). Instead we parse the real coded size out of the SPS and
 * configure to exactly that, handing the SPS/PPS in as `csd-0`. Configuring an oversized
 * input port (e.g. 4K when the stream is 1080p) makes some vendors' Codec2/V4L2 decoders
 * fail `start()` outright ("failed to set format on port:IN") — a black screen with
 * working audio. A stream-resolution change (rotation) rebuilds the codec.
 *
 * Real-time: if the input queue backs up we drop the oldest, and if no input buffer is
 * free we drop the frame (both hold the last good frame on screen and resync at the next
 * IDR — see `awaitingIdr` — rather than feed the codec a broken P-frame reference chain).
 * `setSurface` hot-swaps a running codec's render target via `setOutputSurface` instead of a
 * full teardown/reconfigure when the Surface instance changes (e.g. entering/leaving
 * picture-in-picture recreates it) — decode state (reference frames) doesn't depend on the
 * output surface, so this avoids a black gap while waiting for a fresh keyframe that a full
 * reset would force. Deliberately NO "no output for N ms" stall watchdog: an earlier version
 * rebuilt the codec on that heuristic, but it fired far too readily under normal conditions
 * and made things worse (repeatedly tearing down a codec that wasn't actually stuck). Idle
 * stretches with no new frames are normal — see the `onClientConnected`/`onClientDisconnected`
 * note in MainActivity.
 */
class VideoDecoder(private val fallbackW: Int, private val fallbackH: Int) {

    private data class Unit(val data: ByteArray, val isConfig: Boolean)

    /** Fired (on the decode thread) whenever the coded stream size changes — initial
     *  configure or a rotation-driven resolution swap. Caller hops to the UI thread. */
    @Volatile var onVideoSize: ((Int, Int) -> kotlin.Unit)? = null

    private val queue = LinkedBlockingQueue<Unit>(120)
    @Volatile private var surface: Surface? = null
    @Volatile private var running = false
    private var thread: Thread? = null

    private var codec: MediaCodec? = null
    private var ptsIndex = 0L
    @Volatile private var resetRequested = false

    // A pending setSurface() call, applied on the decode thread (all codec touches stay on
    // one thread). Surface itself can legitimately become null, so a separate flag — not
    // nullability — marks "there's a change to apply".
    @Volatile private var pendingSurface: Surface? = null
    @Volatile private var surfaceChangePending = false

    // The SPS/PPS (Annex-B) most recently seen. Kept so we can (re)build the codec after a
    // surface loss without waiting for the iPhone to resend its config.
    @Volatile private var lastConfig: ByteArray? = null
    private var curW = 0
    private var curH = 0

    // Set whenever a unit gets dropped (queue overflow or no free input buffer). H.264
    // P-frames reference the frame before them, so decoding past a drop feeds the codec
    // frames whose reference is gone — that's what shows up as blocky/corrupted video
    // (worst during scrolling, which is exactly when frame size/rate spikes and a real-time
    // decoder is most likely to fall behind). Once set, non-config units are held (last good
    // frame stays on screen) until the next IDR resyncs the stream cleanly.
    @Volatile private var awaitingIdr = false

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "airplay-decode").also { it.start() }
    }

    /** The SurfaceView's surface became available/destroyed/recreated (e.g. entering/leaving
     *  picture-in-picture, which swaps in a genuinely new Surface instance). Deferred to the
     *  decode thread — see [applySurfaceChange] — which hot-swaps the running codec's output
     *  via `MediaCodec.setOutputSurface` rather than tearing it down: decode state (reference
     *  frames) isn't tied to the render target, so this keeps playback continuous through the
     *  swap instead of blanking to black until the next keyframe (what a full reconfigure
     *  would require). */
    fun setSurface(s: Surface?) {
        if (s === surface) return
        pendingSurface = s
        surfaceChangePending = true
    }

    /** Feed one Annex-B unit from the native receiver. Non-blocking (drops when full). */
    fun submit(data: ByteArray, isConfig: Boolean) {
        if (!running) return
        if (!queue.offer(Unit(data, isConfig))) {
            // Backlog means the decode thread can't keep up. Dropping just the oldest unit
            // still corrupts every P-frame downstream of the gap, so clear the whole backlog
            // and resync at the next IDR instead of feeding the codec a broken reference chain.
            queue.clear()
            awaitingIdr = true
            queue.offer(Unit(data, isConfig))
        }
    }

    /** A client disconnected — flush so the next connection reconfigures cleanly. Safe to
     *  call from any thread; the actual codec teardown happens on the decode thread. */
    fun onDisconnected() {
        queue.clear()
        resetRequested = true
    }

    fun release() {
        running = false
        thread?.interrupt()
        try { thread?.join(200) } catch (_: InterruptedException) {} // let the loop stop touching the codec
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
                    resetCodec() // handle disconnect on this thread only
                }
                if (surfaceChangePending) {
                    surfaceChangePending = false
                    applySurfaceChange(pendingSurface)
                }
                val u = queue.poll(10, TimeUnit.MILLISECONDS)
                if (u != null) feed(u)
                drain(info)
            } catch (ie: InterruptedException) {
                break
            } catch (e: Exception) {
                Log.w(TAG, "decode error, resetting codec", e)
                resetCodec()
            }
        }
    }

    /** Apply a pending setSurface() on the decode thread: hot-swap the running codec's output
     *  surface when possible (preserves decode state — no black gap, no keyframe wait), else
     *  fall back to a full reset (surface lost, no codec yet, or the swap itself failed). */
    private fun applySurfaceChange(s: Surface?) {
        val oldSurface = surface
        surface = s
        val mc = codec
        if (s != null && mc != null && oldSurface != null) {
            try {
                mc.setOutputSurface(s)
                return
            } catch (e: Exception) {
                Log.w(TAG, "setOutputSurface failed, falling back to a full reset", e)
            }
        }
        resetCodec()
    }

    private fun feed(u: Unit) {
        if (u.isConfig) {
            lastConfig = u.data
            val (w, h) = dimsFor(u.data)
            val c = codec
            if (c == null) {
                val s = surface ?: return
                configure(s, u.data, w, h)
            } else if (w != curW || h != curH) {
                // Stream resolution changed (e.g. rotation) → rebuild for the new size.
                resetCodec()
                val s = surface ?: return
                configure(s, u.data, w, h)
            }
            // csd-0 already carries the SPS/PPS — no need to also queue it as a buffer.
            return
        }

        if (awaitingIdr) {
            if (!containsNalType(u.data, NAL_IDR)) return // hold last good frame until resync
            awaitingIdr = false
        }

        var mc = codec
        if (mc == null) {
            // No codec yet (first frame after a surface (re)create). Rebuild from the last
            // SPS/PPS we saw — a P-frame alone can't configure a decoder.
            val cfg = lastConfig ?: return
            val s = surface ?: return
            val (w, h) = dimsFor(cfg)
            if (!configure(s, cfg, w, h)) return
            mc = codec ?: return
        }
        val idx = mc.dequeueInputBuffer(8_000)
        if (idx < 0) {
            awaitingIdr = true // dropped: everything after this is now an orphaned reference
            return
        }
        val buf = mc.getInputBuffer(idx) ?: return
        buf.clear()
        buf.put(u.data)
        mc.queueInputBuffer(idx, 0, u.data.size, ptsIndex++ * 16_666L, 0)
    }

    private fun drain(info: MediaCodec.BufferInfo) {
        val mc = codec ?: return
        while (true) {
            val idx = mc.dequeueOutputBuffer(info, 0)
            when {
                idx >= 0 -> mc.releaseOutputBuffer(idx, true) // render to the Surface
                idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED ->
                    Log.i(TAG, "output format: ${mc.outputFormat}")
                else -> break // INFO_TRY_AGAIN_LATER / no output ready
            }
        }
    }

    /** Real coded size from the SPS, or the advertised size clamped to 1080p as a safe
     *  fallback (an oversized input port is exactly what breaks start() on some decoders). */
    private fun dimsFor(config: ByteArray): Pair<Int, Int> =
        parseSpsDimensions(config) ?: (fallbackW.coerceAtMost(1920) to fallbackH.coerceAtMost(1088))

    private fun configure(s: Surface, csd: ByteArray, w: Int, h: Int): Boolean {
        return try {
            val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h)
            // Hand the SPS/PPS in up front so the codec is fully specified before start().
            fmt.setByteBuffer("csd-0", ByteBuffer.wrap(csd))
            // Hint low-latency decoding where supported (API 30+); harmless elsewhere.
            fmt.setInteger("low-latency", 1)
            val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            c.configure(fmt, s, null, 0)
            c.start()
            codec = c
            curW = w; curH = h
            ptsIndex = 0
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
        awaitingIdr = false // a fresh codec has no stale reference chain to resync from
    }

    // --- H.264 SPS resolution parsing ------------------------------------------
    // Enough of the SPS to recover the coded (cropped) frame size. Standard bit-reader
    // over the emulation-stripped RBSP; profiles that carry chroma/scaling extensions are
    // skipped over correctly so the width/height fields land at the right offset.

    private fun parseSpsDimensions(annexb: ByteArray): Pair<Int, Int>? {
        val sps = findNalPayload(annexb, 7) ?: return null
        return try { decodeSpsDims(sps) } catch (_: Exception) { null }
    }

    /** Whether any NAL of [type] is present (no emulation-stripping/allocation needed). */
    private fun containsNalType(data: ByteArray, type: Int): Boolean {
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
            if ((data[nalStart].toInt() and 0x1F) == type) return true
            i = nalStart + 1
        }
        return false
    }

    /** First NAL of [type]'s payload (bytes after the 1-byte NAL header), emulation-stripped. */
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
            // Next start code (00 00 01) ends this NAL.
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
        var k = 0
        var zeros = 0
        var i = from
        while (i < to) {
            val b = data[i]
            if (zeros >= 2 && b == 3.toByte() && i + 1 < to) {
                zeros = 0            // drop the emulation-prevention 0x03
                i++
                continue
            }
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
        r.bits(8)              // constraint_set flags + reserved
        r.bits(8)              // level_idc
        r.ue()                 // seq_parameter_set_id
        var chromaFormatIdc = 1
        if (profileIdc in HIGH_PROFILES) {
            chromaFormatIdc = r.ue()
            if (chromaFormatIdc == 3) r.bit()   // separate_colour_plane_flag
            r.ue()             // bit_depth_luma_minus8
            r.ue()             // bit_depth_chroma_minus8
            r.bit()            // qpprime_y_zero_transform_bypass_flag
            if (r.bit() == 1) {                 // seq_scaling_matrix_present_flag
                val lists = if (chromaFormatIdc != 3) 8 else 12
                for (idx in 0 until lists) {
                    if (r.bit() == 1) {         // scaling_list_present_flag
                        val size = if (idx < 6) 16 else 64
                        var lastScale = 8; var nextScale = 8
                        for (j in 0 until size) {
                            if (nextScale != 0) {
                                val delta = r.se()
                                nextScale = (lastScale + delta + 256) % 256
                            }
                            if (nextScale != 0) lastScale = nextScale
                        }
                    }
                }
            }
        }
        r.ue()                 // log2_max_frame_num_minus4
        val picOrderCntType = r.ue()
        when (picOrderCntType) {
            0 -> r.ue()        // log2_max_pic_order_cnt_lsb_minus4
            1 -> {
                r.bit()        // delta_pic_order_always_zero_flag
                r.se()         // offset_for_non_ref_pic
                r.se()         // offset_for_top_to_bottom_field
                repeat(r.ue()) { r.se() } // offset_for_ref_frame[]
            }
        }
        r.ue()                 // max_num_ref_frames
        r.bit()                // gaps_in_frame_num_value_allowed_flag
        val picWidthInMbs = r.ue() + 1
        val picHeightInMapUnits = r.ue() + 1
        val frameMbsOnly = r.bit()
        if (frameMbsOnly == 0) r.bit() // mb_adaptive_frame_field_flag
        r.bit()                // direct_8x8_inference_flag
        var cropL = 0; var cropR = 0; var cropT = 0; var cropB = 0
        if (r.bit() == 1) {    // frame_cropping_flag
            cropL = r.ue(); cropR = r.ue(); cropT = r.ue(); cropB = r.ue()
        }
        var width = picWidthInMbs * 16
        var height = (2 - frameMbsOnly) * picHeightInMapUnits * 16
        val subW = if (chromaFormatIdc == 1 || chromaFormatIdc == 2) 2 else 1
        val subH = if (chromaFormatIdc == 1) 2 else 1
        val cropUnitX = if (chromaFormatIdc == 0) 1 else subW
        val cropUnitY = (if (chromaFormatIdc == 0) 1 else subH) * (2 - frameMbsOnly)
        width -= cropUnitX * (cropL + cropR)
        height -= cropUnitY * (cropT + cropB)
        require(width in 16..8192 && height in 16..8192) { "implausible SPS size ${width}x$height" }
        return width to height
    }

    companion object {
        private const val TAG = "airplay-video"
        private const val NAL_IDR = 5
        private val HIGH_PROFILES =
            intArrayOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135)
    }
}
