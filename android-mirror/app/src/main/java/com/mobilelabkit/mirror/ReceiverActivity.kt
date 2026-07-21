package com.mobilelabkit.mirror

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.SocketException
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Receiver role: advertise `_mlkmirror._tcp`, accept one sender at a time, and decode the
 * incoming H.264 stream onto a full-screen SurfaceView. The full-screen shell (SurfaceView,
 * cover, Wi-Fi/multicast locks, immersive mode, Wi-Fi bind) mirrors android-chromecast /
 * android-airplay so behaviour stays consistent across the receivers.
 */
class ReceiverActivity : Activity(), SurfaceHolder.Callback {

    private lateinit var root: FrameLayout
    private lateinit var surfaceView: SurfaceView
    private lateinit var cover: View
    private lateinit var status: TextView
    private lateinit var aspectLabel: TextView
    private var decoder: VideoDecoder? = null
    private val audio = AudioPlayer()
    private val advertiser by lazy { MirrorDiscovery.Advertiser(applicationContext) }

    // Aspect handling: the decoded frame is scaled into the screen per the chosen mode. Fit
    // (letterbox) respects the source ratio; Fill stretches; Zoom crops. Video size comes from
    // the decoder (updates on rotation). Cycled with the remote's OK button, persisted.
    private lateinit var prefs: SharedPreferences
    private var aspectMode = ASPECT_FIT
    @Volatile private var videoW = 0
    @Volatile private var videoH = 0
    private val ui = Handler(Looper.getMainLooper())
    private val hideAspect = Runnable { aspectLabel.visibility = View.GONE }

    private var multicastLock: WifiManager.MulticastLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    @Volatile private var running = false
    private var serverSocket: ServerSocket? = null
    private var serverThread: Thread? = null

    // Reverse control channel: live touches captured here → sender's real screen coords → socket.
    @Volatile private var senderRealW = 0
    @Volatile private var senderRealH = 0
    @Volatile private var controlConnected = false
    private val controlQueue = LinkedBlockingQueue<MirrorProtocol.Touch>(256)
    private var controlWriter: Thread? = null
    private var lastTouchMs = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        goImmersive()

        prefs = getSharedPreferences("mirror", MODE_PRIVATE)
        aspectMode = prefs.getInt("aspect", ASPECT_FIT).coerceIn(ASPECT_FIT, ASPECT_ZOOM)

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        // SurfaceView is centered; its size is set per aspect mode (letterbox bars are the black
        // root behind it). Start MATCH_PARENT until the first frame reports its real size.
        surfaceView = SurfaceView(this).apply { holder.addCallback(this@ReceiverActivity) }
        root.addView(surfaceView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))
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
        aspectLabel = TextView(this).apply {
            setTextColor(Color.WHITE)
            setBackgroundColor(0xB0000000.toInt())
            textSize = 15f
            setPadding(dp(18), dp(10), dp(18), dp(10))
            visibility = View.GONE
        }
        root.addView(aspectLabel, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(28) })
        setContentView(root)

        // Re-fit when the container size is first known / changes (e.g. TV underscan, rotation).
        root.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or2, ob ->
            if (r - l != or2 - ol || b - t != ob - ot) applyAspect()
        }

        // Capture touches on the mirror and stream them live to the sender (if it has touch
        // control enabled). Consume events (return true) so we track the whole gesture.
        surfaceView.setOnTouchListener { v, e -> handleTouch(v, e); true }

        decoder = VideoDecoder(1280, 720) { w, h ->
            runOnUiThread { videoW = w; videoH = h; applyAspect() }
        }.also { it.start() }
        acquireWifi()
        bindWifiThen { startServer() }
    }

    // --- aspect ratio ------------------------------------------------------------------
    /** Size the SurfaceView within the screen per [aspectMode] and the decoded video size. */
    private fun applyAspect() {
        if (!::surfaceView.isInitialized) return
        val rw = root.width
        val rh = root.height
        if (rw == 0 || rh == 0) return
        val lp = surfaceView.layoutParams as FrameLayout.LayoutParams
        if (aspectMode == ASPECT_FILL || videoW == 0 || videoH == 0) {
            lp.width = FrameLayout.LayoutParams.MATCH_PARENT
            lp.height = FrameLayout.LayoutParams.MATCH_PARENT
        } else {
            val scale = if (aspectMode == ASPECT_ZOOM)
                maxOf(rw.toFloat() / videoW, rh.toFloat() / videoH) // fill, crop overflow
            else
                minOf(rw.toFloat() / videoW, rh.toFloat() / videoH) // fit, letterbox
            lp.width = (videoW * scale).toInt()
            lp.height = (videoH * scale).toInt()
        }
        lp.gravity = Gravity.CENTER
        surfaceView.layoutParams = lp
    }

    private fun cycleAspect() {
        aspectMode = (aspectMode + 1) % 3
        prefs.edit().putInt("aspect", aspectMode).apply()
        applyAspect()
        aspectLabel.text = "Aspect: ${aspectName(aspectMode)}"
        aspectLabel.visibility = View.VISIBLE
        ui.removeCallbacks(hideAspect)
        ui.postDelayed(hideAspect, 1500)
    }

    /** The remote's OK/Center (or Menu) cycles Fit → Stretch → Zoom. */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER,
            KeyEvent.KEYCODE_BUTTON_A, KeyEvent.KEYCODE_MENU -> { cycleAspect(); return true }
        }
        return super.onKeyDown(keyCode, event)
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
                Log.i(TAG, "stream header ${header.width}x${header.height} (real ${header.realWidth}x${header.realHeight})")
                senderRealW = header.realWidth
                senderRealH = header.realHeight
                startControlWriter(socket)
                while (running && !socket.isClosed) {
                    val frame = MirrorProtocol.readUnit(din)
                    when {
                        // Sender rotated → new geometry. Keep touch mapping correct; the decoder
                        // re-fits video size on its own from the fresh SPS that follows.
                        frame.isMeta -> {
                            val m = MirrorProtocol.parseMeta(frame.data)
                            senderRealW = m.realWidth; senderRealH = m.realHeight
                        }
                        frame.isAudio -> audio.write(frame.data)
                        else -> decoder?.submit(frame.data, frame.isConfig)
                    }
                }
            } catch (e: SocketException) {
                Log.i(TAG, "sender disconnected: ${e.message}")
            } catch (e: Exception) {
                Log.w(TAG, "stream error: ${e.message}")
            } finally {
                stopControlWriter()
                senderRealW = 0; senderRealH = 0
                runCatching { socket.close() }
                decoder?.onDisconnected()
                audio.stop()
                runOnUiThread { showWaiting(null) }
            }
        }
        runCatching { ss.close() }
    }

    // --- reverse control channel (live touch → sender) ---------------------------------
    private fun startControlWriter(socket: java.net.Socket) {
        controlQueue.clear()
        controlConnected = true
        controlWriter = Thread({
            try {
                val cout = DataOutputStream(BufferedOutputStream(socket.getOutputStream()))
                while (controlConnected && !socket.isClosed) {
                    val t = controlQueue.poll(200, TimeUnit.MILLISECONDS) ?: continue
                    MirrorProtocol.writeTouch(cout, t)
                }
            } catch (e: Exception) {
                Log.i(TAG, "control writer ended: ${e.message}")
            }
        }, "mirror-control-tx").also { it.start() }
    }

    private fun stopControlWriter() {
        controlConnected = false
        controlWriter?.interrupt()
        controlWriter = null
        controlQueue.clear()
    }

    /** Map a touch on the mirror to the sender's real screen pixels and stream it live.
     *  Moves are lightly throttled; each event carries dt (ms since last) so the sender can
     *  pace the injected stroke to match the real finger. Single finger. */
    private fun handleTouch(v: View, e: android.view.MotionEvent) {
        if (!controlConnected || senderRealW == 0 || senderRealH == 0) return
        val vw = v.width.coerceAtLeast(1)
        val vh = v.height.coerceAtLeast(1)
        val sx = (e.x / vw * senderRealW).toInt().coerceIn(0, senderRealW - 1)
        val sy = (e.y / vh * senderRealH).toInt().coerceIn(0, senderRealH - 1)
        val now = e.eventTime
        when (e.actionMasked) {
            android.view.MotionEvent.ACTION_DOWN -> {
                lastTouchMs = now
                send(MirrorProtocol.Touch(MirrorProtocol.TOUCH_DOWN, sx, sy, 0))
            }
            android.view.MotionEvent.ACTION_MOVE -> {
                val dt = (now - lastTouchMs).toInt()
                if (dt < 12) return          // ~80 Hz cap — plenty for smooth following
                lastTouchMs = now
                send(MirrorProtocol.Touch(MirrorProtocol.TOUCH_MOVE, sx, sy, dt))
            }
            android.view.MotionEvent.ACTION_UP -> {
                val dt = (now - lastTouchMs).toInt().coerceAtLeast(1)
                lastTouchMs = now
                send(MirrorProtocol.Touch(MirrorProtocol.TOUCH_UP, sx, sy, dt))
            }
            android.view.MotionEvent.ACTION_CANCEL ->
                send(MirrorProtocol.Touch(MirrorProtocol.TOUCH_CANCEL, sx, sy, 1))
        }
    }

    private fun send(t: MirrorProtocol.Touch) {
        if (!controlQueue.offer(t)) { controlQueue.poll(); controlQueue.offer(t) }
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
        ui.removeCallbacks(hideAspect)
        running = false
        stopControlWriter()
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
            append("\n\nPress OK on the remote to change aspect — now: ${aspectName(aspectMode)}")
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

    private fun aspectName(mode: Int) = when (mode) {
        ASPECT_FILL -> "Stretch (fill)"
        ASPECT_ZOOM -> "Zoom (crop)"
        else -> "Fit (letterbox)"
    }

    private fun dp(v: Int) = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    ).toInt()

    companion object {
        private const val TAG = "mirror-receiver"
        private const val ASPECT_FIT = 0   // letterbox — respect the source ratio (default)
        private const val ASPECT_FILL = 1  // stretch to fill the screen
        private const val ASPECT_ZOOM = 2  // scale to fill, crop overflow (respect ratio)
    }
}
