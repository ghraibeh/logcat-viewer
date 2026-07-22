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
 *
 * Loss handling (ported from the AirPlay receiver's battle-tested decoder): any dropped or
 * cleared frame closes an IDR gate — subsequent P-frames are HELD (last good frame stays on
 * screen) instead of being decoded against missing references, which is what smears the whole
 * picture into blocky garbage. Because we own the sender, the gate also fires
 * [onNeedKeyframe] so the encoder emits a fresh IDR immediately (sub-frame resync) rather
 * than waiting out the 1 s GOP. The stall watchdog is anchored on the oldest
 * fed-but-undrained frame (a paused sender can never trip it), and a chronically stalling
 * hardware decoder (some head units ship broken OMX decoders that starve for tens of
 * seconds) gets replaced with Android's software AVC decoder for the rest of the session —
 * at our ≤960-long-edge stream sizes software decode is cheap and deterministic.
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

    /** Fired (any decoder thread) when the reference chain broke — a frame was dropped/cleared
     *  or the codec was rebuilt — and the sender should emit a fresh IDR now. Throttled to one
     *  request per [KEYFRAME_REQ_THROTTLE_MS]. The receiver forwards it over the reverse
     *  control channel (CTRL_NEED_IDR). */
    @Volatile var onNeedKeyframe: (() -> Unit)? = null
    @Volatile private var lastKeyframeReqMs = 0L

    // Resync gate: set whenever a frame was lost (queue clear, input-buffer drop, codec
    // rebuild). Non-config units are held until the next IDR — decoding past a gap is what
    // produces the smeared/blocky picture. Config units bypass the gate.
    @Volatile private var awaitingIdr = false

    // Stall watchdog state (decode thread only): pendingSinceMs = when the OLDEST currently
    // undrained frame was queued (0 = none). Anchored to fed frames — a paused sender can
    // never look like a stall. firstOutputSeen widens the leash during codec warmup.
    private var pendingSinceMs = 0L
    private var lastInputMs = 0L
    private var firstOutputSeen = false

    // IDR-starvation detector: how long the gate has been holding a live stream.
    private var heldSinceMs = 0L
    private var lastHeldMs = 0L

    // Chronic-stall fallback: repeated watchdog rebuilds mark the hardware decoder as
    // unreliable and switch to Android's software AVC decoder for the session.
    private var stallRebuilds = 0
    private var firstStallMs = 0L
    @Volatile private var forcedCodecName: String? = null

    // Latency governor: a queue that stays deep means we're rendering seconds behind live
    // (a slow stretch let backlog accumulate, and a no-drop pipeline never drains it — the
    // picture is clean but permanently late). Skip forward once, cleanly.
    private var deepSinceMs = 0L
    private var lastCatchupMs = 0L

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
                // Last resort if decode wedged: something is now missing from the reference
                // chain — gate until a fresh IDR (and ask the sender for one immediately).
                Log.w(TAG, "decode queue wedged — dropping oldest, holding for next IDR")
                queue.poll(); queue.offer(Chunk(data, isConfig))
                awaitingIdr = true
                requestKeyframe()
            }
        } catch (e: InterruptedException) {
            // shutting down
        }
    }

    /** Throttled [onNeedKeyframe] — one wire request per KEYFRAME_REQ_THROTTLE_MS. */
    private fun requestKeyframe() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastKeyframeReqMs < KEYFRAME_REQ_THROTTLE_MS) return
        lastKeyframeReqMs = now
        onNeedKeyframe?.invoke()
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
                val now = SystemClock.elapsedRealtime()
                // Stall watchdog: a fed frame sat undrained for the limit while newer input
                // kept flowing ⇒ the codec has wedged. Anchored to the oldest PENDING frame
                // — a paused/quiet sender leaves nothing pending and can never trip this.
                val stallLimit = if (firstOutputSeen) STALL_MS else STARTUP_STALL_MS
                if (codec != null && pendingSinceMs != 0L &&
                    now - pendingSinceMs > stallLimit && now - lastInputMs < STALL_MS
                ) {
                    Log.w(TAG, "decoder stalled (oldest fed frame ${now - pendingSinceMs}ms undrained, input live) — rebuilding")
                    // Repeated stalls mean the hardware decoder itself is broken (some head
                    // units starve for tens of seconds) — switch to software AVC for the
                    // session; at ≤960-long-edge it decodes everything comfortably.
                    if (firstStallMs == 0L || now - firstStallMs > STALL_WINDOW_MS) {
                        firstStallMs = now; stallRebuilds = 0
                    }
                    if (++stallRebuilds >= STALL_FALLBACK_COUNT && forcedCodecName == null) {
                        forcedCodecName = softwareAvcDecoderName()
                        Log.w(TAG, "hardware decoder unreliable ($stallRebuilds stalls) — switching to ${forcedCodecName ?: "<none found>"}")
                    }
                    resetCodec()
                    requestKeyframe()
                }
                // IDR starvation: the gate has held a live stream for a while — the keyframe
                // we asked for got lost somewhere. Ask again (throttled).
                if (awaitingIdr && heldSinceMs != 0L &&
                    now - heldSinceMs > STARVED_MS && now - lastHeldMs < 1000L
                ) {
                    Log.w(TAG, "IDR-starved ${now - heldSinceMs}ms with frames arriving — re-requesting keyframe")
                    heldSinceMs = now
                    requestKeyframe()
                }
                // Latency governor: the queue staying deep = rendering behind live. One
                // clean skip-forward: drop the backlog, gate, and resync on a fresh IDR.
                if (queue.size >= CATCHUP_DEPTH) {
                    if (deepSinceMs == 0L) deepSinceMs = now
                    if (now - deepSinceMs > CATCHUP_AFTER_MS && now - lastCatchupMs > CATCHUP_COOLDOWN_MS) {
                        Log.w(TAG, "decode backlog ≥$CATCHUP_DEPTH frames for ${now - deepSinceMs}ms — skipping forward to live")
                        queue.clear()
                        awaitingIdr = true
                        requestKeyframe()
                        lastCatchupMs = now
                        deepSinceMs = 0L
                    }
                } else {
                    deepSinceMs = 0L
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

        if (awaitingIdr) {
            if (!containsNalType(u.data, NAL_IDR)) {
                // Hold the last good frame until the resync IDR arrives — decoding past a
                // gap is what smears the picture. Time the hold for the starvation detector.
                val now = SystemClock.elapsedRealtime()
                if (heldSinceMs == 0L) heldSinceMs = now
                lastHeldMs = now
                return
            }
            awaitingIdr = false
            heldSinceMs = 0L
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
        // Be patient: at 30 fps the codec's buffers briefly saturate now and then; an 8 ms
        // patience turned each blip into a dropped frame, and a drop costs a full IDR
        // round-trip. Only a genuinely wedged codec keeps us waiting the full 250 ms —
        // that's the stall watchdog's job.
        val idx = mc.dequeueInputBuffer(INPUT_WAIT_US)
        if (idx < 0) {
            Log.w(TAG, "no input buffer in ${INPUT_WAIT_US / 1000}ms — dropping frame, holding for next IDR")
            awaitingIdr = true
            requestKeyframe()
            return
        }
        val buf = mc.getInputBuffer(idx) ?: return
        buf.clear()
        buf.put(u.data)
        mc.queueInputBuffer(idx, 0, u.data.size, ptsIndex++ * 16_666L, 0)
        val now = SystemClock.elapsedRealtime()
        if (pendingSinceMs == 0L || now - lastInputMs > STALL_MS) pendingSinceMs = now
        lastInputMs = now
    }

    private fun drain(info: MediaCodec.BufferInfo) {
        val mc = codec ?: return
        while (true) {
            val idx = mc.dequeueOutputBuffer(info, 0)
            when {
                idx >= 0 -> {
                    mc.releaseOutputBuffer(idx, true) // render to the Surface
                    pendingSinceMs = 0L // codec is producing — nothing considered stuck
                    firstOutputSeen = true
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
            val forced = forcedCodecName
            val c = if (forced != null) MediaCodec.createByCodecName(forced)
                    else MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            c.configure(fmt, s, null, 0)
            c.start()
            codec = c
            curW = w; curH = h
            ptsIndex = 0
            pendingSinceMs = 0L; lastInputMs = 0L // fresh codec — nothing fed, nothing pending
            firstOutputSeen = false
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
        // A fresh codec has no reference frames — hold everything until the next IDR
        // (config units bypass the gate and reconfigure; the sender answers our keyframe
        // request within a frame or two, so the hold is brief).
        awaitingIdr = true
        pendingSinceMs = 0L; lastInputMs = 0L
        firstOutputSeen = false
        heldSinceMs = 0L
    }

    /** Android's software AVC decoder, for when the hardware one proves broken. */
    private fun softwareAvcDecoderName(): String? {
        return try {
            val infos = android.media.MediaCodecList(android.media.MediaCodecList.ALL_CODECS).codecInfos
            infos.firstOrNull { info ->
                !info.isEncoder &&
                    info.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) } &&
                    (if (android.os.Build.VERSION.SDK_INT >= 29) info.isSoftwareOnly
                     else info.name.startsWith("OMX.google.", ignoreCase = true))
            }?.name
        } catch (_: Exception) { null }
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
        private const val NAL_IDR = 5
        private const val STALL_MS = 1500L // a fed frame undrained this long (input live) ⇒ rebuild
        private const val STARTUP_STALL_MS = 4500L // pre-first-output leash (cold-start latency)
        private const val STARVED_MS = 3000L // gate holding a live stream this long ⇒ re-request IDR
        private const val INPUT_WAIT_US = 250_000L // input-buffer patience (drops cost an IDR round-trip)
        private const val KEYFRAME_REQ_THROTTLE_MS = 300L // at most one CTRL_NEED_IDR per this window
        private const val STALL_WINDOW_MS = 60_000L // stall-count window for the software fallback
        private const val STALL_FALLBACK_COUNT = 3 // stalls within the window ⇒ software decoder
        private const val CATCHUP_DEPTH = 4 // queue depth (of 6) considered "behind live"
        private const val CATCHUP_AFTER_MS = 700L // deep this long ⇒ skip forward
        private const val CATCHUP_COOLDOWN_MS = 3000L // min gap between skips
        private val HIGH_PROFILES =
            intArrayOf(100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135)
    }
}
