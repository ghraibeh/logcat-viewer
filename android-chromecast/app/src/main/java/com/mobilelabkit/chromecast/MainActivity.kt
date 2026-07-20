package com.mobilelabkit.chromecast

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Standalone Google Cast receiver (Phase 1). On launch it advertises itself over the LAN
 * as a Chromecast (`_googlecast._tcp`) so it shows up in the phone's native Screen-Cast
 * list; when a sender connects it captures the CASTV2 device-auth challenge and reports it
 * on-screen and to logcat. Video/audio receive (vendored openscreen) is Phase 2.
 *
 * The full-screen shell — SurfaceView, cover, Wi-Fi/multicast locks, immersive mode — is
 * reused from android-airplay so the Phase-2 decoder path drops straight in.
 */
class MainActivity : Activity(), CastReceiver.Listener, SurfaceHolder.Callback {

    private lateinit var surfaceView: SurfaceView
    private lateinit var cover: View
    private lateinit var status: TextView
    private var decoder: VideoDecoder? = null
    private val receiver by lazy { CastReceiver(applicationContext) }

    private var multicastLock: WifiManager.MulticastLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private val ui = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        goImmersive()

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surfaceView = SurfaceView(this).apply { holder.addCallback(this@MainActivity) }
        root.addView(
            surfaceView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        // Opaque cover over the SurfaceView (Phase 2 hides it once frames arrive).
        cover = View(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(
            cover,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
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
        showWaiting("Starting…")
        acquireWifi()
        // Pin the process to Wi-Fi BEFORE the mDNS/TLS sockets are created, so our
        // advertisement actually egresses wlan0 (same fix as android-airplay).
        bindWifiThen { receiver.start(ADVERTISED_NAME, this) }
    }

    // --- CastReceiver.Listener (called on receiver threads) --------------------------
    override fun onAdvertising(friendlyName: String, port: Int) = runOnUiThread {
        showWaiting("Waiting for a phone to cast…")
    }

    override fun onSenderConnected(remote: String) = runOnUiThread {
        status.text = "Sender connected\n$remote\n\nnegotiating…"
    }

    override fun onAuthChallenge(sigAlg: Int, hashAlg: Int, nonceLen: Int) = runOnUiThread {
        status.text = buildString {
            append("Cast auth challenge received ✓\n\n")
            append("signature alg: $sigAlg\n")
            append("hash alg: $hashAlg\n")
            append("sender nonce: $nonceLen bytes\n\n")
            append("(Phase 2 answers this to start the mirror)")
        }
    }

    override fun onSenderDisconnected() = runOnUiThread {
        showWaiting("Waiting for a phone to cast…")
    }

    override fun onError(message: String) = runOnUiThread {
        Log.e(TAG, "receiver error: $message")
        status.text = "Couldn’t start the Cast receiver:\n$message"
    }

    // --- SurfaceHolder.Callback (wired for Phase 2) ----------------------------------
    override fun surfaceCreated(holder: SurfaceHolder) { decoder?.setSurface(holder.surface) }
    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        decoder?.setSurface(holder.surface)
    }
    override fun surfaceDestroyed(holder: SurfaceHolder) { decoder?.setSurface(null) }

    // --- lifecycle -------------------------------------------------------------------
    override fun onDestroy() {
        super.onDestroy()
        receiver.stop()
        decoder?.release()
        decoder = null
        releaseWifi()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    // --- helpers ---------------------------------------------------------------------
    private fun showWaiting(headline: String) {
        val ip = localIp()
        status.text = buildString {
            append("$headline\n\n")
            append("On your phone: open Screen Cast / Smart View and pick\n")
            append("“$ADVERTISED_NAME”")
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
        // Android drops inbound multicast (mDNS on 224.0.0.251) unless a lock is held.
        multicastLock = wifi.createMulticastLock("cast-mdns").apply {
            setReferenceCounted(false)
            runCatching { acquire() }
        }
        @Suppress("DEPRECATION")
        wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "cast-wifi").apply {
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

    companion object {
        private const val TAG = "cast"
        private const val ADVERTISED_NAME = "MobileLabKit Cast"
    }
}
