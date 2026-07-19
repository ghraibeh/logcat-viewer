package com.mobilelabkit.headunit

import android.util.Log
import java.io.ByteArrayOutputStream

/**
 * Android Auto message transport over the AOAP bulk link.
 *
 * Encodes/decodes AA frames ([channel][flags][size](+totalSize)[payload]), splits large
 * messages into FIRST/MIDDLE/LAST frames and reassembles them, and applies TLS
 * (encrypt on send / decrypt on receive) for frames whose ENCRYPTED flag is set. Complete
 * messages are handed to [handler] as (channel, encrypted, messageId, content).
 *
 * One reader thread owns the bulk-IN endpoint; sends are serialized on a lock.
 */
class AapTransport(
    private val link: UsbAoap.Link,
    private val crypto: AapCrypto,
    private val handler: (channel: Int, encrypted: Boolean, messageId: Int, content: ByteArray) -> Unit
) {
    fun interface OnError { fun onError(msg: String) }
    var onError: OnError? = null

    @Volatile private var running = false
    private var reader: Thread? = null
    private val sendLock = Any()

    // Per-channel reassembly of multi-frame messages.
    private val assembling = HashMap<Int, ByteArrayOutputStream>()
    // Rolling buffer of bytes read from bulk that don't yet form a whole frame.
    private var rx = ByteArray(0)

    fun start() {
        if (running) return
        running = true
        reader = Thread({ readLoop() }, "aap-rx").also { it.start() }
    }

    fun stop() {
        running = false
        reader?.interrupt()
        reader = null
    }

    /** Send a message on [channel]. [content] is the message body (without the id); we
     *  prepend the 2-byte message id, encrypt if requested, then frame + write. */
    fun sendMessage(channel: Int, messageId: Int, content: ByteArray, encrypted: Boolean) {
        val plain = u16be(messageId) + content
        val body = if (encrypted) crypto.encrypt(plain) else plain
        val enc = if (encrypted) AapProto.ENC_ENCRYPTED else AapProto.ENC_PLAIN

        synchronized(sendLock) {
            val total = body.size
            var off = 0
            val chunk = AapProto.MAX_FRAME_PAYLOAD
            val multi = total > chunk
            while (off < total) {
                val n = minOf(chunk, total - off)
                val frameType = when {
                    !multi -> AapProto.FRAME_BULK
                    off == 0 -> AapProto.FRAME_FIRST
                    off + n >= total -> AapProto.FRAME_LAST
                    else -> AapProto.FRAME_MIDDLE
                }
                val header = ByteArrayOutputStream()
                header.write(channel)
                header.write(frameType or enc or AapProto.MSG_SPECIFIC)
                header.write(u16be(n))
                if (frameType == AapProto.FRAME_FIRST) header.write(u32be(total))
                val frame = header.toByteArray() + body.copyOfRange(off, off + n)
                val w = link.write(frame)
                if (w < 0) { fail("bulk write failed"); return }
                off += n
            }
        }
    }

    // --- receive ---------------------------------------------------------------
    private fun readLoop() {
        val buf = ByteArray(AapProto.MAX_FRAME_PAYLOAD + 16)
        while (running) {
            val n = try {
                link.read(buf, 5000)
            } catch (e: Exception) {
                if (running) fail("bulk read error: ${e.message}"); return
            }
            if (n <= 0) continue // timeout / empty; keep waiting
            rx += buf.copyOf(n)
            drainFrames()
        }
    }

    /** Parse every complete frame currently in [rx], leaving any partial tail. */
    private fun drainFrames() {
        var pos = 0
        while (true) {
            if (rx.size - pos < 4) break
            val channel = rx[pos].toInt() and 0xff
            val flags = rx[pos + 1].toInt() and 0xff
            val frameType = flags and AapProto.FRAME_TYPE_MASK
            val headerLen = if (frameType == AapProto.FRAME_FIRST) 8 else 4
            if (rx.size - pos < headerLen) break
            val frameSize = readU16(rx, pos + 2)
            val frameEnd = pos + headerLen + frameSize
            if (rx.size < frameEnd) break // wait for the rest of this frame
            val payload = rx.copyOfRange(pos + headerLen, frameEnd)
            pos = frameEnd
            handleFrame(channel, flags, frameType, payload)
        }
        rx = if (pos == 0) rx else rx.copyOfRange(pos, rx.size)
    }

    private fun handleFrame(channel: Int, flags: Int, frameType: Int, payload: ByteArray) {
        val encrypted = (flags and AapProto.ENC_ENCRYPTED) != 0
        val complete: ByteArray = when (frameType) {
            AapProto.FRAME_BULK -> payload
            AapProto.FRAME_FIRST -> {
                assembling[channel] = ByteArrayOutputStream().apply { write(payload) }
                return
            }
            AapProto.FRAME_MIDDLE -> {
                assembling[channel]?.write(payload); return
            }
            AapProto.FRAME_LAST -> {
                val acc = assembling.remove(channel) ?: return
                acc.write(payload); acc.toByteArray()
            }
            else -> return
        }
        dispatch(channel, encrypted, complete)
    }

    private fun dispatch(channel: Int, encrypted: Boolean, framePayload: ByteArray) {
        val plain = if (encrypted) {
            try { crypto.decrypt(framePayload) } catch (e: Exception) {
                Log.w(TAG, "decrypt failed on ${AapProto.channelName(channel)}", e); return
            }
        } else framePayload
        if (plain.size < 2) return
        val messageId = readU16(plain, 0)
        val content = plain.copyOfRange(2, plain.size)
        try {
            handler(channel, encrypted, messageId, content)
        } catch (e: Exception) {
            Log.e(TAG, "handler error", e)
        }
    }

    private fun fail(msg: String) {
        Log.e(TAG, msg)
        onError?.onError(msg)
    }

    companion object {
        private const val TAG = "headunit-aap"
        fun u16be(v: Int) = byteArrayOf((v ushr 8).toByte(), v.toByte())
        fun u32be(v: Int) = byteArrayOf((v ushr 24).toByte(), (v ushr 16).toByte(), (v ushr 8).toByte(), v.toByte())
        fun readU16(b: ByteArray, o: Int) = ((b[o].toInt() and 0xff) shl 8) or (b[o + 1].toInt() and 0xff)
    }
}
