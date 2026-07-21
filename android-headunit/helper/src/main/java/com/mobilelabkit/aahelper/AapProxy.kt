package com.mobilelabkit.aahelper

import android.net.Network
import android.util.Log
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicInteger

/**
 * The one thing that makes wireless Android Auto reliable on a hotspot: a **local TCP proxy**.
 *
 * Stock Android Auto (gearhead) runs in its OWN process. When we trigger it at the head unit's
 * real LAN IP, gearhead picks which network to open that socket over — and on a hotspot with no
 * validated internet Android keeps **cellular** as gearhead's default, so it either can't reach
 * the head unit's LAN IP or connects and then wedges at "version request sent". Nothing WE do
 * (`bindProcessToNetwork`, the `PARAM_SERVICE_WIFI_NETWORK` extra) reliably steers *another*
 * process's socket.
 *
 * So instead we point gearhead at **127.0.0.1** — loopback is reachable no matter which network is
 * default — and this proxy, running in OUR process where we CAN bind the socket to the right
 * Wi-Fi ([network]), relays the bytes to the head unit's real [remoteIp]:[remotePort]. gearhead
 * never has to make a network choice, so the hotspot / no-internet / cellular-default cases that
 * used to fail "sometimes" just work. (Same trick as headunit-revived's Wireless Helper.)
 */
class AapProxy(
    private val remoteIp: String,
    private val remotePort: Int,
    private val network: Network?,
    private val onConnected: () -> Unit = {},
    private val onDisconnected: () -> Unit = {},
) {
    @Volatile private var running = false
    @Volatile var localPort = -1; private set
    private var server: ServerSocket? = null
    private var acceptThread: Thread? = null
    // gearhead sometimes opens more than one connection during setup; count them so we only report
    // "disconnected" when the LAST bridge closes (a real session drop), not on a probe closing.
    private val bridges = AtomicInteger(0)

    /**
     * Bind a loopback-only server and start accepting. Returns the local port to hand gearhead
     * (fire it at 127.0.0.1:localPort), or -1 if the server couldn't start.
     */
    fun start(): Int {
        if (running) return localPort
        return try {
            val ss = ServerSocket().apply {
                reuseAddress = true
                // Loopback only: nothing off-device can reach the proxy, and it's routable
                // regardless of the phone's default network.
                bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0))
            }
            server = ss
            localPort = ss.localPort
            running = true
            Log.i(TAG, "proxy up on 127.0.0.1:$localPort -> $remoteIp:$remotePort (net=$network)")
            acceptThread = Thread({ acceptLoop(ss) }, "aa-proxy-accept").also { it.start() }
            localPort
        } catch (e: Exception) {
            Log.e(TAG, "proxy start failed: ${e.message}")
            -1
        }
    }

    private fun acceptLoop(ss: ServerSocket) {
        while (running) {
            val aa = try {
                ss.accept()
            } catch (e: Exception) {
                if (running) { Log.w(TAG, "accept: ${e.message}"); continue } else break
            }
            Thread({ bridge(aa) }, "aa-proxy-bridge").start()
        }
    }

    private fun bridge(aa: Socket) {
        var head: Socket? = null
        try {
            if (bridges.incrementAndGet() == 1) runCatching { onConnected() }
            head = connectHeadUnit()
            aa.tcpNoDelay = true
            head.tcpNoDelay = true
            Log.i(TAG, "bridge established: gearhead <-> $remoteIp")
            val up = Thread({ pump(aa, head, "gearhead->head") }, "aa-proxy-up")
            val down = Thread({ pump(head, aa, "head->gearhead") }, "aa-proxy-down")
            up.start(); down.start()
            up.join(); down.join()
        } catch (e: Exception) {
            Log.w(TAG, "bridge error: ${e.message}")
        } finally {
            runCatching { aa.close() }
            runCatching { head?.close() }
            if (bridges.decrementAndGet() <= 0) runCatching { onDisconnected() }
            Log.i(TAG, "bridge closed")
        }
    }

    /** Open the socket to the head unit, bound to [network] so it routes over the right Wi-Fi even
     *  when that Wi-Fi has no internet and cellular is the default. */
    private fun connectHeadUnit(): Socket {
        val s = Socket()
        // bindSocket must happen before connect (and requires the socket unconnected) — API 23+.
        network?.let { runCatching { it.bindSocket(s) }.onFailure { e -> Log.w(TAG, "bindSocket: ${e.message}") } }
        s.connect(InetSocketAddress(remoteIp, remotePort), CONNECT_TIMEOUT_MS)
        return s
    }

    private fun pump(from: Socket, to: Socket, name: String) {
        val buf = ByteArray(32 * 1024)
        try {
            val input = from.getInputStream()
            val output = to.getOutputStream()
            while (running) {
                val n = input.read(buf)
                if (n == -1) break
                output.write(buf, 0, n)
                output.flush()
            }
        } catch (e: Exception) {
            Log.d(TAG, "$name ended: ${e.message}")
        } finally {
            // One direction ending means the session is over — kick the other pump awake.
            runCatching { from.close() }
            runCatching { to.close() }
        }
    }

    fun stop() {
        running = false
        runCatching { server?.close() }
        server = null
        acceptThread?.interrupt(); acceptThread = null
        localPort = -1
    }

    companion object {
        private const val TAG = "aahelper-proxy"
        private const val CONNECT_TIMEOUT_MS = 5000
    }
}
