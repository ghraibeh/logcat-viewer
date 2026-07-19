package com.mobilelabkit.headunit

import android.media.MediaCodec
import android.media.MediaFormat
import android.util.Log
import android.view.Surface
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Hardware H.264 decoder for the Android Auto video stream: Annex-B access units
 * (from [VideoChannel]) → MediaCodec → the SurfaceView's Surface.
 *
 * Android Auto sends inline SPS/PPS (no separate codec-config flag), so we hold frames
 * until we've seen an SPS (NAL 7) + PPS (NAL 8) and a Surface, extract them as csd-0/csd-1,
 * configure MediaCodec, then feed everything. Real-time: drop when the queue backs up.
 */
class VideoDecoder(private val width: Int, private val height: Int) {

    private val queue = LinkedBlockingQueue<ByteArray>(180)
    @Volatile private var surface: Surface? = null
    @Volatile private var running = false
    private var thread: Thread? = null

    private var codec: MediaCodec? = null
    private var sps: ByteArray? = null
    private var pps: ByteArray? = null
    private var ptsIndex = 0L

    fun start() {
        if (running) return
        running = true
        thread = Thread({ loop() }, "aap-video").also { it.start() }
    }

    fun setSurface(s: Surface?) {
        surface = s
        if (s == null) resetCodec()
    }

    /** Feed one Annex-B access unit (may contain SPS/PPS/IDR or a P-frame). */
    fun submit(au: ByteArray) {
        if (!running || au.isEmpty()) return
        if (!queue.offer(au)) { queue.poll(); queue.offer(au) }
    }

    fun release() {
        running = false
        thread?.interrupt(); thread = null
        resetCodec(); queue.clear()
    }

    private fun loop() {
        val info = MediaCodec.BufferInfo()
        while (running) {
            try {
                val au = queue.poll(10, TimeUnit.MILLISECONDS)
                if (au != null) feed(au)
                drain(info)
            } catch (ie: InterruptedException) {
                break
            } catch (e: Exception) {
                Log.w(TAG, "decode error, resetting", e); resetCodec()
            }
        }
    }

    private fun feed(au: ByteArray) {
        if (codec == null) {
            scanParamSets(au)
            val s = surface ?: return
            if (sps == null || pps == null) return // wait for a keyframe with SPS/PPS
            if (!configure(s)) return
        }
        val mc = codec ?: return
        val idx = mc.dequeueInputBuffer(8_000)
        if (idx < 0) return
        val buf = mc.getInputBuffer(idx) ?: return
        buf.clear(); buf.put(au)
        mc.queueInputBuffer(idx, 0, au.size, ptsIndex++ * 16_666L, 0)
    }

    private fun drain(info: MediaCodec.BufferInfo) {
        val mc = codec ?: return
        while (true) {
            val idx = mc.dequeueOutputBuffer(info, 0)
            when {
                idx >= 0 -> mc.releaseOutputBuffer(idx, true) // render to Surface
                idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> Log.i(TAG, "format ${mc.outputFormat}")
                else -> break
            }
        }
    }

    /** Extract SPS (NAL type 7) / PPS (NAL type 8) from an Annex-B buffer. */
    private fun scanParamSets(au: ByteArray) {
        var i = 0
        val starts = ArrayList<Int>()
        while (i + 3 < au.size) {
            val sc3 = au[i].toInt() == 0 && au[i + 1].toInt() == 0 && au[i + 2].toInt() == 1
            val sc4 = au[i].toInt() == 0 && au[i + 1].toInt() == 0 && au[i + 2].toInt() == 0 && (i + 3 < au.size) && au[i + 3].toInt() == 1
            if (sc4) { starts.add(i); i += 4 } else if (sc3) { starts.add(i); i += 3 } else i++
        }
        for (k in starts.indices) {
            val start = starts[k]
            val hdr = if (start + 3 < au.size && au[start + 2].toInt() == 1) 3 else 4
            val nalStart = start
            val nalEnd = if (k + 1 < starts.size) starts[k + 1] else au.size
            val nalType = au[start + hdr].toInt() and 0x1f
            val nal = au.copyOfRange(nalStart, nalEnd)
            if (nalType == 7 && sps == null) sps = nal
            if (nalType == 8 && pps == null) pps = nal
        }
    }

    private fun configure(s: Surface): Boolean {
        return try {
            val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
            fmt.setByteBuffer("csd-0", java.nio.ByteBuffer.wrap(sps!!))
            fmt.setByteBuffer("csd-1", java.nio.ByteBuffer.wrap(pps!!))
            fmt.setInteger("low-latency", 1)
            val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            c.configure(fmt, s, null, 0)
            c.start()
            codec = c; ptsIndex = 0
            Log.i(TAG, "MediaCodec configured ${width}x${height} (${c.name})")
            true
        } catch (e: Exception) {
            Log.e(TAG, "configure failed", e); resetCodec(); false
        }
    }

    private fun resetCodec() {
        codec?.let { runCatching { it.stop() }; runCatching { it.release() } }
        codec = null; sps = null; pps = null
    }

    companion object { private const val TAG = "headunit-video" }
}
