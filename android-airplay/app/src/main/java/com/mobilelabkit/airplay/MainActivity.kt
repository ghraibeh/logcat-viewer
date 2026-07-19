package com.mobilelabkit.airplay

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Standalone AirPlay receiver. On launch it advertises itself over the LAN (mDNS) and
 * waits; when the user picks it in the iPhone's Control Center ▸ Screen Mirroring, the
 * native receiver hands us H.264 frames that [VideoDecoder] renders full-screen. Audio
 * is decoded + played entirely in native. View-only (AirPlay carries no input channel).
 *
 * Controls (floating bar, top-right): 🔊/🔇 mute for the mirror audio, and the advertised
 * mirror resolution (720p…4K, persisted; default 4K). Changing resolution restarts the
 * receiver — the iPhone must re-pick the name. During streaming the bar auto-hides;
 * tap the screen to bring it back.
 */
class MainActivity : Activity(), NativeReceiver.Listener, SurfaceHolder.Callback {

    private lateinit var surfaceView: SurfaceView
    private lateinit var cover: View
    private lateinit var status: TextView
    private lateinit var controls: LinearLayout
    private lateinit var muteBtn: TextView
    private lateinit var resBtn: TextView
    private var decoder: VideoDecoder? = null

    private lateinit var prefs: SharedPreferences
    private var resKey: String = RES_DEFAULT

    private var multicastLock: WifiManager.MulticastLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private val ui = Handler(Looper.getMainLooper())
    private val hideControls = Runnable { if (streaming) controls.visibility = View.GONE }

    // The mirror video and the HTTP control connection are separate TCP streams: when the
    // iPhone drops ungracefully (leaves Wi-Fi, crashes, out of range) the frames just stop
    // while the control connection lingers, so onClientDisconnected() can fire late or not
    // at all. This watchdog treats "no frame for a while" as a disconnect and resets.
    private val watchdog = object : Runnable {
        override fun run() {
            if (streaming && SystemClock.elapsedRealtime() - lastFrameMs > STALL_MS) {
                Log.i(TAG, "no video for >${STALL_MS}ms — treating as disconnect")
                streaming = false
                decoder?.onDisconnected()
                resetScreen()
            }
            ui.postDelayed(this, WATCHDOG_INTERVAL_MS)
        }
    }

    @Volatile private var streaming = false
    @Volatile private var restarting = false
    @Volatile private var lastFrameMs = 0L
    private var muted = false

    private val advertisedName: String = DEFAULT_NAME

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        goImmersive()

        prefs = getSharedPreferences("settings", MODE_PRIVATE)
        resKey = prefs.getString("res", RES_DEFAULT) ?: RES_DEFAULT
        if (RES_OPTIONS.none { it.first == resKey }) resKey = RES_DEFAULT

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surfaceView = SurfaceView(this).apply { holder.addCallback(this@MainActivity) }
        root.addView(
            surfaceView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        // Opaque black layer ON TOP of the SurfaceView (a bottom SurfaceView punches a
        // transparent hole in the window, so the black root background can't hide a frozen
        // last frame — this can). Visible while waiting/disconnected, hidden once frames flow.
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
            textSize = 17f
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
        buildControls(root)
        setContentView(root)

        // Tap: while streaming, bring back the (auto-hidden) control bar.
        root.setOnClickListener {
            if (streaming) showControlsBriefly()
        }

        val (w, h) = parseRes(resKey)
        decoder = VideoDecoder(w, h).also { it.start() }
        showWaiting()
        ui.postDelayed(watchdog, WATCHDOG_INTERVAL_MS)
        acquireWifi()
        // Pin the whole process to the Wi-Fi network BEFORE creating the native sockets.
        // Android routes each app's sockets by fwmark; without this, our mDNS multicast
        // "sends" (sendto succeeds) but never egresses wlan0, so the iPhone never sees us.
        bindWifiThen { startReceiver() }
    }

    // --- floating control bar ---------------------------------------------------
    private fun buildControls(root: FrameLayout) {
        fun chip(text: String): TextView = TextView(this).apply {
            this.text = text
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setBackgroundColor(0x99202830.toInt())
            setPadding(dp(14), dp(10), dp(14), dp(10))
        }
        muteBtn = chip(if (muted) "🔇" else "🔊").apply {
            setOnClickListener { toggleMute() }
        }
        resBtn = chip(resLabel(resKey)).apply {
            setOnClickListener { pickResolution() }
        }
        controls = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(muteBtn)
            addView(View(context), LinearLayout.LayoutParams(dp(8), 1))
            addView(resBtn)
        }
        root.addView(
            controls,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.END
            ).apply {
                topMargin = dp(24)
                rightMargin = dp(16)
            }
        )
    }

    private fun toggleMute() {
        muted = !muted
        NativeReceiver.setMuted(muted)
        muteBtn.text = if (muted) "🔇" else "🔊"
        Toast.makeText(this, if (muted) "Audio muted" else "Audio on", Toast.LENGTH_SHORT).show()
        if (streaming) showControlsBriefly()
    }

    private fun pickResolution() {
        val labels = RES_OPTIONS.map { it.second }.toTypedArray()
        val current = RES_OPTIONS.indexOfFirst { it.first == resKey }
        AlertDialog.Builder(this)
            .setTitle("Mirror resolution")
            .setSingleChoiceItems(labels, current) { dlg, which ->
                dlg.dismiss()
                val picked = RES_OPTIONS[which].first
                if (picked != resKey) {
                    resKey = picked
                    prefs.edit().putString("res", resKey).apply()
                    resBtn.text = resLabel(resKey)
                    Toast.makeText(
                        this,
                        "Restarting at ${resLabel(resKey)} — pick “$advertisedName” again on the iPhone",
                        Toast.LENGTH_LONG
                    ).show()
                    restartReceiver()
                }
            }
            .show()
        if (streaming) showControlsBriefly()
    }

    private fun showControlsBriefly() {
        controls.visibility = View.VISIBLE
        ui.removeCallbacks(hideControls)
        ui.postDelayed(hideControls, 3000)
    }

    // --- receiver lifecycle -----------------------------------------------------
    private fun startReceiver() {
        val hw = deviceIdHex()
        val (w, h) = parseRes(resKey)
        // nativeStart spins up the RAOP/mDNS threads; run it off the UI thread.
        Thread({
            val port = NativeReceiver.start(advertisedName, w, h, hw, this)
            if (port <= 0) runOnUiThread {
                status.text = "Couldn’t start the AirPlay receiver (error $port).\n" +
                    "Another AirPlay app may be using the mDNS port — close it and reopen."
            } else {
                if (muted) NativeReceiver.setMuted(true) // re-apply across restarts
                Log.i(TAG, "receiver up on raop:$port as \"$advertisedName\" ($resKey)")
            }
        }, "airplay-start").start()
    }

    /** Stop + start with the current [resKey] (resolution change). */
    private fun restartReceiver() {
        if (restarting) return
        restarting = true
        streaming = false
        decoder?.onDisconnected()
        resetScreen()
        Thread({
            NativeReceiver.stop()
            runOnUiThread {
                restarting = false
                startReceiver()
            }
        }, "airplay-restart").start()
    }

    // --- NativeReceiver.Listener (called on native threads) --------------------
    override fun onVideoFrame(data: ByteArray, pts: Long, isConfig: Boolean) {
        decoder?.submit(data, isConfig)
        lastFrameMs = SystemClock.elapsedRealtime() // feeds the stall watchdog
        if (!streaming && !isConfig) {
            streaming = true
            runOnUiThread {
                hideWaiting()
                cover.visibility = View.GONE // reveal the live video
                showControlsBriefly()
            }
        }
    }

    override fun onClientConnected() {
        streaming = false
        runOnUiThread {
            cover.visibility = View.VISIBLE // blank any stale frame until new frames arrive
            status.visibility = View.VISIBLE
            status.text = "Connecting…"
        }
    }

    override fun onClientDisconnected() {
        streaming = false
        decoder?.onDisconnected()
        resetScreen()
    }

    // --- SurfaceHolder.Callback -----------------------------------------------
    override fun surfaceCreated(holder: SurfaceHolder) { decoder?.setSurface(holder.surface) }
    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        decoder?.setSurface(holder.surface)
    }
    override fun surfaceDestroyed(holder: SurfaceHolder) { decoder?.setSurface(null) }

    // --- lifecycle -------------------------------------------------------------
    override fun onDestroy() {
        super.onDestroy()
        ui.removeCallbacks(hideControls)
        ui.removeCallbacks(watchdog)
        NativeReceiver.stop()
        decoder?.release()
        decoder = null
        releaseWifi()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    // --- helpers ---------------------------------------------------------------
    private fun showWaiting() {
        val ip = localIp()
        status.text = buildString {
            append("Waiting for iPhone…  (${resLabel(resKey)})\n\n")
            append("On your iPhone: Control Center ▸ Screen Mirroring ▸\n")
            append("“$advertisedName”")
            if (ip != null) append("\n\n$ip")
        }
        status.visibility = View.VISIBLE
        controls.visibility = View.VISIBLE
        ui.removeCallbacks(hideControls)
    }

    private fun hideWaiting() { status.visibility = View.GONE }

    /** Blank the mirror (cover the frozen last frame) and show the waiting prompt again. */
    private fun resetScreen() = runOnUiThread {
        cover.visibility = View.VISIBLE
        showWaiting()
    }

    /** Bind the process to the active Wi-Fi network (if any), then run [start]. All sockets
     *  created after this (the native mDNS + RAOP sockets) egress Wi-Fi regardless of the
     *  default route — otherwise Android's fwmark routing silently drops our multicast. */
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
        multicastLock = wifi.createMulticastLock("airplay-mdns").apply {
            setReferenceCounted(false)
            runCatching { acquire() }
        }
        wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "airplay-wifi").apply {
            runCatching { acquire() }
        }
    }

    private fun releaseWifi() {
        runCatching { multicastLock?.takeIf { it.isHeld }?.release() }
        runCatching { wifiLock?.takeIf { it.isHeld }?.release() }
        multicastLock = null
        wifiLock = null
    }

    /** Stable 12-hex-char pseudo-MAC for the AirPlay deviceid TXT (real MAC is hidden). */
    private fun deviceIdHex(): String {
        val aid = runCatching {
            Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
        }.getOrNull().orEmpty()
        val hex = aid.filter { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }
        return (hex + "0a1b2c3d4e5f").take(12).lowercase()
    }

    private fun localIp(): String? = runCatching {
        NetworkInterface.getNetworkInterfaces().asSequence()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { it.inetAddresses.asSequence() }
            .filterIsInstance<Inet4Address>()
            .firstOrNull { it.isSiteLocalAddress }
            ?.hostAddress
    }.getOrNull()

    private fun parseRes(key: String): Pair<Int, Int> {
        val parts = key.split("x")
        val w = parts.getOrNull(0)?.toIntOrNull() ?: 3840
        val h = parts.getOrNull(1)?.toIntOrNull() ?: 2160
        return w to h
    }

    private fun resLabel(key: String): String =
        RES_OPTIONS.firstOrNull { it.first == key }?.second ?: key

    private fun dp(v: Int): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
        ).toInt()

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
        private const val TAG = "airplay"
        private const val DEFAULT_NAME = "MobileLabKit.android"

        /** Reset the screen if no video frame arrives for this long while streaming — the
         *  AirPlay mirror sends continuously, so a multi-second gap means the client is gone.
         *  Generous enough not to trip on a brief network hiccup. */
        private const val STALL_MS = 4000L
        private const val WATCHDOG_INTERVAL_MS = 1000L

        /** Advertised AirPlay display sizes (GET /info widthPixels/heightPixels — the
         *  iPhone streams at up to this). Default = highest; the hardware decoder
         *  handles 4K comfortably. */
        private val RES_OPTIONS = listOf(
            "1280x720" to "720p",
            "1920x1080" to "1080p",
            "2560x1440" to "1440p",
            "3840x2160" to "4K"
        )
        private const val RES_DEFAULT = "3840x2160"
    }
}
