package com.mobilelabkit.mirror

import java.io.DataInputStream
import java.io.DataOutputStream

/**
 * The tiny private wire protocol between two copies of this app. Because we own both ends
 * there is no negotiation to do — just enough framing to carry an Annex-B H.264 stream and
 * to fail fast if something else connects to the port.
 *
 *   stream  := header unit*                          (sender → receiver direction)
 *   header  := magic(4) : "MLK1"   capW(int32) capH(int32)   realW(int32) realH(int32)
 *   unit    := len(int32)   kind(int8)   payload(len bytes)
 *              kind 0 = video frame, 1 = video config (SPS/PPS), 2 = audio PCM
 *
 * The socket is full-duplex; the reverse direction (receiver → sender) carries LIVE touch
 * events so the viewer can drive the captured device in real time:
 *   touch := type(int8=1)   action(int8: 0=down,1=move,2=up,3=cancel)   x(int32) y(int32)   dtMs(int32)
 * x/y are in the sender's REAL screen pixels (realW/realH from the header — the coordinate
 * space AccessibilityService.dispatchGesture expects). dtMs is the time since the previous
 * event, used to pace the injected stroke so it matches the real finger's speed.
 *
 * All integers are big-endian (DataOutputStream default). The decoder derives its real video
 * dimensions from the SPS in the config unit; capW/capH are advisory (decoder hint). Audio is
 * raw interleaved PCM at [AUDIO_SAMPLE_RATE] / [AUDIO_CHANNELS] / 16-bit.
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

    // Reverse-channel (receiver → sender) live touch events.
    const val CTRL_TOUCH = 1
    const val TOUCH_DOWN = 0
    const val TOUCH_MOVE = 1
    const val TOUCH_UP = 2
    const val TOUCH_CANCEL = 3

    data class Header(val width: Int, val height: Int, val realWidth: Int, val realHeight: Int)
    data class Frame(val data: ByteArray, val kind: Int) {
        val isConfig get() = kind == KIND_CONFIG
        val isAudio get() = kind == KIND_AUDIO
    }

    data class Touch(val action: Int, val x: Int, val y: Int, val dtMs: Int)

    fun writeHeader(out: DataOutputStream, width: Int, height: Int, realWidth: Int, realHeight: Int) {
        out.write(MAGIC)
        out.writeInt(width)
        out.writeInt(height)
        out.writeInt(realWidth)
        out.writeInt(realHeight)
        out.flush()
    }

    /** Reads + validates the stream header. Throws if the magic doesn't match (wrong peer). */
    fun readHeader(din: DataInputStream): Header {
        val m = ByteArray(4)
        din.readFully(m)
        if (!m.contentEquals(MAGIC)) throw IllegalStateException("not a MobileLabKit Mirror stream")
        val w = din.readInt()
        val h = din.readInt()
        val rw = din.readInt()
        val rh = din.readInt()
        return Header(w, h, rw, rh)
    }

    fun writeTouch(out: DataOutputStream, t: Touch) {
        out.writeByte(CTRL_TOUCH)
        out.writeByte(t.action)
        out.writeInt(t.x)
        out.writeInt(t.y)
        out.writeInt(t.dtMs)
        out.flush()
    }

    /** Reads one reverse-channel control message. */
    fun readTouch(din: DataInputStream): Touch {
        val type = din.readByte().toInt()
        if (type != CTRL_TOUCH) throw IllegalStateException("unknown control type $type")
        val action = din.readByte().toInt()
        val x = din.readInt()
        val y = din.readInt()
        val dt = din.readInt()
        return Touch(action, x, y, dt)
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
