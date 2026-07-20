package com.mobilelabkit.mirror

import java.io.DataInputStream
import java.io.DataOutputStream

/**
 * The tiny private wire protocol between two copies of this app. Because we own both ends
 * there is no negotiation to do — just enough framing to carry an Annex-B H.264 stream and
 * to fail fast if something else connects to the port.
 *
 *   stream  := header unit*
 *   header  := magic(4) : "MLK1"   width(int32)   height(int32)
 *   unit    := len(int32)   kind(int8)   payload(len bytes)
 *              kind 0 = video frame, 1 = video config (SPS/PPS), 2 = audio PCM
 *
 * All integers are big-endian (DataOutputStream default). The decoder derives its real
 * dimensions from the SPS in the config unit; the header width/height are advisory (used
 * only to size logging / the decoder hint). Audio is raw interleaved PCM at
 * [AUDIO_SAMPLE_RATE] / [AUDIO_CHANNELS] / 16-bit — cheap on a LAN and no codec to negotiate.
 */
object MirrorProtocol {

    const val SERVICE_TYPE = "_mlkmirror._tcp."
    const val DEFAULT_PORT = 8899
    const val TXT_VERSION = "v"
    const val PROTO_VERSION = "1"

    private val MAGIC = byteArrayOf('M'.code.toByte(), 'L'.code.toByte(), 'K'.code.toByte(), '1'.code.toByte())
    const val KIND_VIDEO: Int = 0
    const val KIND_CONFIG: Int = 1
    const val KIND_AUDIO: Int = 2
    const val MAX_UNIT = 8 shl 20 // 8 MB — a single access unit is far smaller

    // Fixed audio format both ends agree on (raw PCM, no codec).
    const val AUDIO_SAMPLE_RATE = 48_000
    const val AUDIO_CHANNELS = 2

    data class Header(val width: Int, val height: Int)
    data class Frame(val data: ByteArray, val kind: Int) {
        val isConfig get() = kind == KIND_CONFIG
        val isAudio get() = kind == KIND_AUDIO
    }

    fun writeHeader(out: DataOutputStream, width: Int, height: Int) {
        out.write(MAGIC)
        out.writeInt(width)
        out.writeInt(height)
        out.flush()
    }

    /** Reads + validates the stream header. Throws if the magic doesn't match (wrong peer). */
    fun readHeader(din: DataInputStream): Header {
        val m = ByteArray(4)
        din.readFully(m)
        if (!m.contentEquals(MAGIC)) throw IllegalStateException("not a MobileLabKit Mirror stream")
        val w = din.readInt()
        val h = din.readInt()
        return Header(w, h)
    }

    fun writeUnit(out: DataOutputStream, data: ByteArray, offset: Int, length: Int, kind: Int) {
        out.writeInt(length)
        out.writeByte(kind)
        out.write(data, offset, length)
    }

    fun readUnit(din: DataInputStream): Frame {
        val len = din.readInt()
        if (len <= 0 || len > MAX_UNIT) throw IllegalStateException("bad unit length $len")
        val kind = din.readByte().toInt()
        val buf = ByteArray(len)
        din.readFully(buf)
        return Frame(buf, kind)
    }
}
