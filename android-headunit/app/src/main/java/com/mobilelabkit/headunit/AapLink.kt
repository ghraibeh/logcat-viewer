package com.mobilelabkit.headunit

/**
 * Byte-transport abstraction for the Android Auto link. The AA protocol (framing, TLS, channels,
 * video/audio) sits entirely above this and is identical whether the bytes travel over **USB/AOAP**
 * ([UsbAoap.Link]) or a **TCP socket** ([SocketLink], wireless AA). [AapTransport] talks only to
 * this interface, so wired and wireless share one protocol stack.
 */
interface AapLink {
    /** Read up to [buf].size bytes. Returns bytes read (>0), 0 on timeout, or <0 on error/EOF. */
    fun read(buf: ByteArray, timeoutMs: Int): Int

    /** Write the whole frame. Returns bytes written (>=0) or <0 on error. */
    fun write(data: ByteArray): Int

    fun close()
}
