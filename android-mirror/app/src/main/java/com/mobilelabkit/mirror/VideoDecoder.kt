package com.mobilelabkit.mirror

import android.media.MediaCodec
import android.media.MediaFormat
import android.util.Log
import android.view.Surface
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Hardware H.264 decoder: Annex-B access units (from the sender's on-device encoder) ->
 * MediaCodec -> the SurfaceView's Surface. Runs a single decode thread that both feeds
 * input and drains output-to-Surface, so frames render as soon as they decode.
 *
 * The sender delivers SPS/PPS as a config unit (isConfig=true) ahead of the first IDR — we
 * hold frames until we have both a config buffer AND a Surface, then configure MediaCodec
 * and feed the config as a CODEC_CONFIG buffer. Real-time: if the input queue backs up we
 * drop the oldest, and if no input buffer is free we drop the frame.
 *
 * Shared, unchanged in spirit, with android-airplay / android-chromecast — the wire source
 * differs (a peer phone's MediaCodec encoder here) but the Annex-B contract is identical.
 */
class VideoDecoder(private val width: Int, private val height: Int) {

    private data class Unit(val data: ByteArray, val isConfig: Boolean)

    // Small queue keeps latency low; the hardware decoder is fast enough that it rarely fills.
    // (A rare drop self-heals at the next keyframe — now every 1 s.)
    private val queue = LinkedBlockingQueue<Unit>(6)
    @Volatile private var surface: Surface? = null
    @Volatile private var running = false
    private var thread: Thread? = null

    private var codec: MediaCodec? = null
    private var configured = false
    private var ptsIndex = 0L
    @Volatile private var resetRequested = false

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "mirror-decode").also { it.start() }
    }

    /** The SurfaceView's surface just became available (or was destroyed → null). */
    fun setSurface(s: Surface?) {
        surface = s
        // Surface gone: tear the codec down (on the decode thread) and reconfigure on the
        // next config. Flagged rather than reset here so codec ops stay on one thread.
        if (s == null) resetRequested = true
    }

    /** Feed one Annex-B unit from the sender. Blocks rather than dropping: dropping a
     *  mid-stream P-frame corrupts the picture (broken macroblocks) until the next keyframe.
     *  Blocking backpressures TCP so the SENDER makes the drop decision cleanly (via keyframe
     *  resync). The hardware decoder is real-time, so this rarely waits. */
    fun submit(data: ByteArray, isConfig: Boolean) {
        if (!running) return
        try {
            if (!queue.offer(Unit(data, isConfig), 2, TimeUnit.SECONDS)) {
                queue.poll(); queue.offer(Unit(data, isConfig)) // last resort if decode wedged
            }
        } catch (e: InterruptedException) {
            // shutting down
        }
    }

    /** A sender disconnected — flush so the next connection reconfigures cleanly. Safe to
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
                    resetCodec() // handle disconnect / surface-loss on this thread only
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

    private fun feed(u: Unit) {
        val c = codec
        if (c == null) {
            // Need a config buffer AND a surface before we can configure.
            if (!u.isConfig) return
            val s = surface ?: return
            if (!configure(s)) return
        }
        val mc = codec ?: return
        val idx = mc.dequeueInputBuffer(8_000)
        if (idx < 0) return // no free input buffer → drop (real-time)
        val buf = mc.getInputBuffer(idx) ?: return
        buf.clear()
        buf.put(u.data)
        if (u.isConfig) {
            mc.queueInputBuffer(idx, 0, u.data.size, 0, MediaCodec.BUFFER_FLAG_CODEC_CONFIG)
        } else {
            mc.queueInputBuffer(idx, 0, u.data.size, ptsIndex++ * 16_666L, 0)
        }
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

    private fun configure(s: Surface): Boolean {
        return try {
            val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
            // Hint low-latency decoding where supported (API 30+); harmless elsewhere.
            fmt.setInteger("low-latency", 1)
            val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            c.configure(fmt, s, null, 0)
            c.start()
            codec = c
            configured = true
            ptsIndex = 0
            Log.i(TAG, "MediaCodec configured ${width}x${height} (${c.name})")
            true
        } catch (e: Exception) {
            Log.e(TAG, "MediaCodec configure failed", e)
            resetCodec()
            false
        }
    }

    private fun resetCodec() {
        configured = false
        codec?.let {
            try { it.stop() } catch (_: Exception) {}
            try { it.release() } catch (_: Exception) {}
        }
        codec = null
    }

    companion object { private const val TAG = "mirror-video" }
}
