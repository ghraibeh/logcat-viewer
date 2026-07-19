package com.mobilelabkit.airplay

import android.media.MediaCodec
import android.media.MediaFormat
import android.util.Log
import android.view.Surface
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Hardware H.264 decoder: Annex-B access units (from the native AirPlay receiver) ->
 * MediaCodec -> the SurfaceView's Surface. Runs a single decode thread that both feeds
 * input and drains output-to-Surface, so frames render as soon as they decode.
 *
 * The receiver delivers SPS/PPS separately (isConfig=true) ahead of the IDR — we hold
 * frames until we have both a config buffer AND a Surface, then configure MediaCodec and
 * feed the config as a CODEC_CONFIG buffer. Real-time: if the input queue backs up we
 * drop the oldest, and if no input buffer is free we drop the frame.
 */
class VideoDecoder(private val width: Int, private val height: Int) {

    private data class Unit(val data: ByteArray, val isConfig: Boolean)

    private val queue = LinkedBlockingQueue<Unit>(120)
    @Volatile private var surface: Surface? = null
    @Volatile private var running = false
    private var thread: Thread? = null

    private var codec: MediaCodec? = null
    private var configured = false
    private var ptsIndex = 0L

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "airplay-decode").also { it.start() }
    }

    /** The SurfaceView's surface just became available (or was destroyed → null). */
    fun setSurface(s: Surface?) {
        surface = s
        if (s == null) resetCodec() // surface gone: tear the codec down, reconfigure on the next config
    }

    /** Feed one Annex-B unit from the native receiver. Non-blocking (drops when full). */
    fun submit(data: ByteArray, isConfig: Boolean) {
        if (!running) return
        if (!queue.offer(Unit(data, isConfig))) {
            queue.poll()               // drop oldest, keep newest (stay live)
            queue.offer(Unit(data, isConfig))
        }
    }

    /** A client disconnected — flush so the next connection reconfigures cleanly. */
    fun onDisconnected() {
        queue.clear()
        resetCodec()
    }

    fun release() {
        running = false
        thread?.interrupt()
        thread = null
        resetCodec()
        queue.clear()
    }

    private fun loop() {
        val info = MediaCodec.BufferInfo()
        while (running) {
            try {
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

    companion object { private const val TAG = "airplay-video" }
}
