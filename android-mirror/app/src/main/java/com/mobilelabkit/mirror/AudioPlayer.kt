package com.mobilelabkit.mirror

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log

/**
 * Plays the incoming PCM audio stream on the receiver via a streaming AudioTrack, matching
 * the fixed [MirrorProtocol] format (48 kHz stereo 16-bit). Lazily created on the first
 * audio unit so a video-only sender costs nothing.
 */
class AudioPlayer {
    private var track: AudioTrack? = null
    @Volatile private var started = false

    fun start() {
        if (started) return
        val minBuf = AudioTrack.getMinBufferSize(
            MirrorProtocol.AUDIO_SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_STEREO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(3840 * 4)
        track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(MirrorProtocol.AUDIO_SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_STEREO)
                    .build()
            )
            .setBufferSizeInBytes(minBuf)
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track?.play()
        started = true
        Log.i(TAG, "audio playback started")
    }

    fun write(data: ByteArray) {
        if (!started) start()
        runCatching { track?.write(data, 0, data.size) }
    }

    fun stop() {
        started = false
        track?.let {
            runCatching { it.pause() }
            runCatching { it.flush() }
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        track = null
    }

    companion object { private const val TAG = "mirror-audioplay" }
}
