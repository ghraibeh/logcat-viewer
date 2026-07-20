package com.mobilelabkit.mirror

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.SocketException

/**
 * Receiver role: advertise `_mlkmirror._tcp`, accept one sender at a time, and decode the
 * incoming H.264 stream onto a full-screen SurfaceView. The full-screen shell (SurfaceView,
 * cover, Wi-Fi/multicast locks, immersive mode, Wi-Fi bind) mirrors android-chromecast /
 * android-airplay so behaviour stays consistent across the receivers.
 */
class ReceiverActivity : Activity(), SurfaceHolder.Callback {

    private lateinit var surfaceView: SurfaceView
    private lateinit var cover: View
    private lateinit var status: TextView
    private var decoder: VideoDecoder? = null
    private val audio = AudioPlayer()
    private val advertiser by lazy { MirrorDiscovery.Advertiser(applicationContext) }

    private var multicastLock: WifiManager.MulticastLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    @Volatile private var running = false
    private var serverSocket: ServerSocket? = null
    private var serverThread: Thread? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        goImmersive()

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surfaceView = SurfaceView(this).apply { holder.addCallback(this@ReceiverActivity) }
        root.addView(surfaceView, matchParent())
        cover = View(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(cover, matchParent())
        status = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 16f
            gravity = Gravity.CENTER
            setPadding(48, 48, 48, 48)
        }
        root.addView(
            status,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
            )
        )
        setContentView(root)

        decoder = VideoDecoder(1280, 720).also { it.start() }
        acquireWifi()
        bindWifiThen { startServer() }
    }

    // --- server ------------------------------------------------------------------------
    private fun startServer() {
        running = true
        serverThread = Thread({ serverLoop() }, "mirror-accept").also { it.start() }
    }

    /** Prefer a FIXED port so the sender's discovered address stays valid across receiver
     *  restarts — an ephemeral port changes every restart, leaving the sender pointed at a
     *  dead port (ECONNREFUSED). SO_REUSEADDR lets a quick restart reclaim it despite
     *  TIME_WAIT. Fall back to an ephemeral port only if the fixed one is already taken (a
     *  second receiver on the same subnet). */
    private fun openServerSocket(): ServerSocket? = try {
        ServerSocket().apply {
            reuseAddress = true
            bind(InetSocketAddress(MirrorProtocol.DEFAULT_PORT))
        }
    } catch (e: Exception) {
        Log.w(TAG, "fixed port ${MirrorProtocol.DEFAULT_PORT} busy (${e.message}); using ephemeral")
        try { ServerSocket(0) } catch (e2: Exception) { null }
    }

    private fun serverLoop() {
        val ss = openServerSocket() ?: run {
            runOnUiThread { status.text = "Couldn't open a listening socket." }
            return
        }
        serverSocket = ss
        val port = ss.localPort
        val name = "${Build.MODEL} (Mirror)"
        advertiser.start(name, port,
            onName = { adName -> runOnUiThread { showWaiting(adName) } },
            onError = { msg -> runOnUiThread { status.text = "Discovery error:\n$msg" } })
        Log.i(TAG, "listening on :$port as \"$name\"")

        while (running) {
            val socket = try {
                ss.accept()
            } catch (e: Exception) {
                if (running) Log.w(TAG, "accept ended: ${e.message}")
                break
            }
            val remote = socket.inetAddress?.hostAddress ?: "?"
            Log.i(TAG, "sender connected from $remote")
            runOnUiThread {
                // Hide the cover AND the status text so nothing overlays the mirrored screen.
                cover.visibility = View.GONE
                status.visibility = View.GONE
            }
            try {
                socket.tcpNoDelay = true
                val din = DataInputStream(BufferedInputStream(socket.inputStream, 1 shl 16))
                val header = MirrorProtocol.readHeader(din)
                Log.i(TAG, "stream header ${header.width}x${header.height}")
                while (running && !socket.isClosed) {
                    val frame = MirrorProtocol.readUnit(din)
                    if (frame.isAudio) audio.write(frame.data)
                    else decoder?.submit(frame.data, frame.isConfig)
                }
            } catch (e: SocketException) {
                Log.i(TAG, "sender disconnected: ${e.message}")
            } catch (e: Exception) {
                Log.w(TAG, "stream error: ${e.message}")
            } finally {
                runCatching { socket.close() }
                decoder?.onDisconnected()
                audio.stop()
                runOnUiThread { showWaiting(null) }
            }
        }
        runCatching { ss.close() }
    }

    // --- SurfaceHolder.Callback --------------------------------------------------------
    override fun surfaceCreated(holder: SurfaceHolder) { decoder?.setSurface(holder.surface) }
    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        decoder?.setSurface(holder.surface)
    }
    override fun surfaceDestroyed(holder: SurfaceHolder) { decoder?.setSurface(null) }

    // --- lifecycle ---------------------------------------------------------------------
    override fun onDestroy() {
        super.onDestroy()
        running = false
        advertiser.stop()
        runCatching { serverSocket?.close() }
        serverSocket = null
        serverThread?.interrupt()
        serverThread = null
        decoder?.release()
        decoder = null
        audio.stop()
        releaseWifi()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    // --- helpers -----------------------------------------------------------------------
    private fun matchParent() = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
    )

    private fun showWaiting(advertisedName: String?) {
        val ip = localIp()
        status.text = buildString {
            append("Waiting for a phone to cast…\n\n")
            append("On the other phone: open MobileLabKit Mirror ▸ Cast this screen,\n")
            append("then pick “${advertisedName ?: "${Build.MODEL} (Mirror)"}”.")
            if (ip != null) append("\n\n$ip")
        }
        status.visibility = View.VISIBLE
        cover.visibility = View.VISIBLE
    }

    private fun bindWifiThen(start: () -> Unit) {
        val cm = getSystemService(ConnectivityManager::class.java)
        val net = cm?.activeNetwork
        val onWifi = net != null &&
            cm.getNetworkCapabilities(net)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        if (onWifi) runCatching { cm?.bindProcessToNetwork(net) }
        start()
    }

    private fun acquireWifi() {
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
        multicastLock = wifi.createMulticastLock("mirror-mdns").apply {
            setReferenceCounted(false)
            runCatching { acquire() }
        }
        @Suppress("DEPRECATION")
        wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "mirror-wifi").apply {
            runCatching { acquire() }
        }
    }

    private fun releaseWifi() {
        runCatching { multicastLock?.takeIf { it.isHeld }?.release() }
        runCatching { wifiLock?.takeIf { it.isHeld }?.release() }
        multicastLock = null
        wifiLock = null
    }

    private fun localIp(): String? = runCatching {
        NetworkInterface.getNetworkInterfaces().asSequence()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.asSequence() }
            .filterIsInstance<Inet4Address>()
            .firstOrNull { it.isSiteLocalAddress }
            ?.hostAddress
    }.getOrNull()

    @Suppress("DEPRECATION")
    private fun goImmersive() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    companion object { private const val TAG = "mirror-receiver" }
}
