package com.mobilelabkit.mirror

import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.os.Build
import android.util.Log
import android.view.Surface

/**
 * Sender-side capture pipeline: MediaProjection mirrors the phone's screen into a
 * VirtualDisplay whose Surface is a hardware H.264 encoder's input. The encoder emits an
 * Annex-B byte stream (SPS/PPS as a CODEC_CONFIG unit, then frames) — the exact format the
 * receiver's [VideoDecoder] consumes.
 *
 * A single drain thread pulls encoded units and hands them to [onUnit]. Nothing here touches
 * the network; the service owns the socket and decides how to buffer under backpressure.
 */
class ScreenEncoder(
    private val projection: MediaProjection,
    private val width: Int,
    private val height: Int,
    private val dpi: Int,
    private val bitRate: Int,
    private val frameRate: Int = 30,
    private val onUnit: (data: ByteArray, isConfig: Boolean) -> Unit,
    private val onError: (String) -> Unit,
) {
    private var codec: MediaCodec? = null
    private var inputSurface: Surface? = null
    private var virtualDisplay: VirtualDisplay? = null
    @Volatile private var running = false
    private var thread: Thread? = null

    fun start() {
        try {
            val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
                setInteger(MediaFormat.KEY_FRAME_RATE, frameRate)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    setInteger(MediaFormat.KEY_BITRATE_MODE,
                        MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
                }
                // Ask for low-latency encoding where supported (API 30+); ignored elsewhere.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setInteger(MediaFormat.KEY_LATENCY, 1)
            }
            val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            c.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            inputSurface = c.createInputSurface()
            c.start()
            codec = c
            // AUTO_MIRROR: reflect the default display into our surface (the standard
            // screen-capture recipe). The content is whatever is on the phone's screen.
            virtualDisplay = projection.createVirtualDisplay(
                "mlk-mirror", width, height, dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                inputSurface, null, null
            )
            running = true
            thread = Thread({ drainLoop() }, "mirror-encode").also { it.start() }
            Log.i(TAG, "encoding ${width}x${height} @ ${bitRate / 1000}kbps (${c.name})")
        } catch (e: Exception) {
            Log.e(TAG, "encoder start failed", e)
            onError(e.message ?: e.javaClass.simpleName)
            stop()
        }
    }

    private fun drainLoop() {
        val info = MediaCodec.BufferInfo()
        val mc = codec ?: return
        while (running) {
            val idx = try {
                mc.dequeueOutputBuffer(info, 10_000)
            } catch (e: IllegalStateException) {
                if (running) onError("encoder failure: ${e.message}")
                break
            }
            when {
                idx >= 0 -> {
                    val buf = mc.getOutputBuffer(idx)
                    if (buf != null && info.size > 0) {
                        buf.position(info.offset)
                        buf.limit(info.offset + info.size)
                        val out = ByteArray(info.size)
                        buf.get(out)
                        val isConfig = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                        onUnit(out, isConfig)
                    }
                    runCatching { mc.releaseOutputBuffer(idx, false) }
                }
                idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED ->
                    Log.i(TAG, "encoder format: ${mc.outputFormat}")
                else -> { /* INFO_TRY_AGAIN_LATER — keep polling */ }
            }
        }
    }

    fun stop() {
        running = false
        thread?.interrupt()
        try { thread?.join(200) } catch (_: InterruptedException) {}
        thread = null
        runCatching { virtualDisplay?.release() }
        virtualDisplay = null
        codec?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        codec = null
        runCatching { inputSurface?.release() }
        inputSurface = null
    }

    companion object { private const val TAG = "mirror-encode" }
}
