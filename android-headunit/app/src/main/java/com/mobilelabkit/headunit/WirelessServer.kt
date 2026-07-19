package com.mobilelabkit.headunit

import android.util.Log
import java.net.InetSocketAddress
import java.net.ServerSocket

/**
 * TCP server for **wireless Android Auto**. Listens on [port] (5288 by convention); when the phone
 * connects — after the Bluetooth bootstrap tells it our IP:5288 — [onClient] fires with a
 * [SocketLink] to run the AA protocol over. One connection at a time; a new accept while a session
 * is active is closed by the callback (which no-ops if busy).
 */
class WirelessServer(
    private val port: Int = 5288,
    private val onClient: (SocketLink) -> Unit
) {
    @Volatile private var running = false
    private var server: ServerSocket? = null
    private var thread: Thread? = null

    val isRunning: Boolean get() = running

    fun start() {
        if (running) return
        running = true
        thread = Thread({
            try {
                val s = ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(port)) }
                server = s
                Log.i(TAG, "wireless server listening on :$port")
                while (running) {
                    val sock = try {
                        s.accept()
                    } catch (e: Exception) {
                        if (running) { Log.w(TAG, "accept error: ${e.message}"); continue } else break
                    }
                    Log.i(TAG, "wireless client connected: ${sock.inetAddress?.hostAddress}")
                    runCatching { onClient(SocketLink(sock)) }
                }
            } catch (e: Exception) {
                Log.e(TAG, "wireless server error", e)
            } finally {
                runCatching { server?.close() }
            }
        }, "aap-wireless-server").also { it.start() }
    }

    fun stop() {
        running = false
        runCatching { server?.close() }
        thread?.interrupt(); thread = null
    }

    companion object { private const val TAG = "headunit-wireless" }
}
