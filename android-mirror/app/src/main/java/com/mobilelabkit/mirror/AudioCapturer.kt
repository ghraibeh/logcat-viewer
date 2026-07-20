package com.mobilelabkit.mirror

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.util.Log

/**
 * Captures the sender's **playback** audio (what the phone is playing) via
 * AudioPlaybackCapture, tied to the same MediaProjection as the screen capture — so no
 * microphone is involved, just the system audio mix. Delivers raw PCM chunks to [onPcm].
 *
 * Playback capture is API 29+ (the caller guards on that before constructing this). Apps can
 * opt out of being captured (music/DRM apps often do, via `allowAudioPlaybackCapture=false`
 * or FLAG_SECURE); those simply produce silence here. We match MEDIA / GAME / UNKNOWN usages
 * — the ones a screen share cares about. RECORD_AUDIO is verified before this is started.
 */
class AudioCapturer(
    private val projection: MediaProjection,
    private val onPcm: (data: ByteArray, length: Int) -> Unit,
    private val onError: (String) -> Unit,
) {
    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var running = false

    fun start() {
        try {
            val config = AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(MirrorProtocol.AUDIO_SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
                .build()
            val minBuf = AudioRecord.getMinBufferSize(
                MirrorProtocol.AUDIO_SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_STEREO,
                AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(CHUNK * 4)
            val rec = AudioRecord.Builder()
                .setAudioPlaybackCaptureConfig(config)
                .setAudioFormat(format)
                .setBufferSizeInBytes(minBuf)
                .build()
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                onError("audio capture init failed"); rec.release(); return
            }
            rec.startRecording()
            record = rec
            running = true
            thread = Thread({ loop() }, "mirror-audio").also { it.start() }
            Log.i(TAG, "playback audio capture started")
        } catch (e: Exception) {
            Log.e(TAG, "audio start failed", e)
            onError(e.message ?: e.javaClass.simpleName)
        }
    }

    private fun loop() {
        val rec = record ?: return
        val buf = ByteArray(CHUNK)
        while (running) {
            val n = rec.read(buf, 0, buf.size)
            if (n > 0) {
                val out = buf.copyOf(n)
                onPcm(out, n)
            } else if (n < 0) {
                Log.w(TAG, "audio read error $n"); break
            }
        }
    }

    fun stop() {
        running = false
        thread?.interrupt()
        try { thread?.join(150) } catch (_: InterruptedException) {}
        thread = null
        record?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        record = null
    }

    companion object {
        private const val TAG = "mirror-audio"
        // ~20 ms of 48 kHz stereo 16-bit PCM = 960 frames * 2ch * 2 bytes.
        private const val CHUNK = 3840
    }
}
