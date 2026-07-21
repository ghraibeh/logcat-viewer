package com.mobilelabkit.headunit

import android.util.Log
import java.net.Socket
import java.net.SocketTimeoutException

/**
 * TCP-socket implementation of [AapLink] for **wireless Android Auto**. The phone connects to the
 * head unit's TCP server (port 5288) after the Bluetooth bootstrap; from there the AA protocol is
 * byte-identical to USB. Reads honor a per-call timeout (mapped to 0 like a USB bulk timeout);
 * writes flush the whole frame.
 */
class SocketLink(private val socket: Socket) : AapLink {

    private val input = socket.getInputStream()
    private val output = socket.getOutputStream()

    init {
        runCatching { socket.tcpNoDelay = true }
        // TCP keep-alive so a truly dead peer (phone left the network) is detected at the OS level
        // in addition to our app-level stall watchdog. Matches headunit-revived's SocketAccessory.
        runCatching { socket.keepAlive = true }
    }

    override fun read(buf: ByteArray, timeoutMs: Int): Int {
        return try {
            if (socket.soTimeout != timeoutMs) socket.soTimeout = timeoutMs
            input.read(buf, 0, buf.size) // >0 bytes, -1 on EOF
        } catch (e: SocketTimeoutException) {
            0
        } catch (e: Exception) {
            Log.w(TAG, "socket read error: ${e.message}"); -1
        }
    }

    override fun write(data: ByteArray): Int {
        return try {
            output.write(data); output.flush(); data.size
        } catch (e: Exception) {
            Log.w(TAG, "socket write error: ${e.javaClass.simpleName}: ${e.message}"); -1
        }
    }

    override fun close() {
        runCatching { socket.close() }
    }

    companion object { private const val TAG = "headunit-socket" }
}
