package com.mobilelabkit.headunit

import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log

/**
 * Microphone capture for Android Auto voice / Google Assistant / voice search.
 *
 * When the phone opens the mic (MicrophoneRequest), it expects the head unit to stream the
 * receiver's microphone back as 16-bit mono PCM at the negotiated sample rate. We capture with
 * [AudioRecord] (VOICE_RECOGNITION source — tuned for speech) on a worker thread and hand each
 * PCM chunk to [onData]; the media channel frames it for the phone.
 *
 * Requires the RECORD_AUDIO runtime permission — the caller checks/requests it; if it's missing
 * the AudioRecord constructor throws and we fail gracefully (Assistant just won't hear anything).
 */
class MicRecorder(private val sampleRate: Int = 16000) {

    private var record: AudioRecord? = null
    private var thread: Thread? = null
    @Volatile private var active = false

    private val minBuf = runCatching {
        AudioRecord.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    }.getOrDefault(0)

    val isAvailable: Boolean get() = minBuf > 0

    fun start(onData: (ByteArray, Int) -> Unit) {
        if (active || !isAvailable) return
        val r = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION, sampleRate,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, minBuf * 2
            )
        } catch (e: Exception) {
            Log.e(TAG, "AudioRecord init failed (RECORD_AUDIO not granted?)", e); return
        }
        if (r.state != AudioRecord.STATE_INITIALIZED) { runCatching { r.release() }; return }
        record = r; active = true
        runCatching { r.startRecording() }
        thread = Thread({
            val buf = ByteArray(minBuf)
            while (active) {
                val n = try { r.read(buf, 0, buf.size) } catch (e: Exception) { break }
                if (n > 0) onData(buf, n) else if (n < 0) break
            }
        }, "aap-mic").also { it.start() }
        Log.i(TAG, "mic capture started @ ${sampleRate}Hz")
    }

    fun stop() {
        if (!active && record == null) return
        active = false
        thread?.interrupt(); thread = null
        record?.let { runCatching { it.stop() }; runCatching { it.release() } }
        record = null
        Log.i(TAG, "mic capture stopped")
    }

    companion object { private const val TAG = "headunit-mic" }
}
