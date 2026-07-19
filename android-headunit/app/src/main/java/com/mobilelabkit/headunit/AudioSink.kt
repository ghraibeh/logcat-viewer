package com.mobilelabkit.headunit

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Plays one Android Auto PCM audio-sink stream (media / speech / system) through [AudioTrack].
 *
 * The phone streams 16-bit PCM on the audio channels; we play it on the receiver's speaker. The
 * actual (blocking) AudioTrack write runs on a dedicated worker thread fed by a bounded queue —
 * writing on the transport's reader thread would stall video/audio decode and freeze the stream.
 */
class AudioSink(
    private val sampleRate: Int,
    private val channelCount: Int,
    private val usage: Int
) {
    private val queue = LinkedBlockingQueue<ByteArray>(64)
    @Volatile private var running = false
    private var thread: Thread? = null
    private var track: AudioTrack? = null

    private val channelMask =
        if (channelCount >= 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
    private val minBuf = runCatching {
        AudioTrack.getMinBufferSize(sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
    }.getOrDefault(0)

    /** Enqueue a PCM chunk (already stripped of the timestamp). [pcm] must not be mutated after. */
    fun submit(pcm: ByteArray) {
        if (pcm.isEmpty()) return
        if (!running) start()
        if (!queue.offer(pcm)) { queue.poll(); queue.offer(pcm) } // drop oldest under backlog
    }

    private fun start() {
        if (running || minBuf <= 0) return
        running = true
        thread = Thread({ loop() }, "aap-audio-$usage").also { it.start() }
    }

    private fun loop() {
        val t = try {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder().setUsage(usage)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
                )
                .setAudioFormat(
                    AudioFormat.Builder().setSampleRate(sampleRate)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(channelMask).build()
                )
                .setBufferSizeInBytes(minBuf * 4)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } catch (e: Exception) {
            Log.e(TAG, "AudioTrack init failed (${sampleRate}Hz x$channelCount)", e); running = false; return
        }
        track = t
        runCatching { t.play() }
        while (running) {
            val pcm = try { queue.poll(200, TimeUnit.MILLISECONDS) } catch (e: InterruptedException) { break }
                ?: continue
            runCatching { t.write(pcm, 0, pcm.size) } // blocking write, but on THIS thread only
        }
        runCatching { t.stop() }; runCatching { t.release() }
        track = null
    }

    fun release() {
        running = false
        thread?.interrupt(); thread = null
        queue.clear()
    }

    companion object { private const val TAG = "headunit-audio" }
}
