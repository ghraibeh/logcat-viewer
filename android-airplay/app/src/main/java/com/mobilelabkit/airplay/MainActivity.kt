package com.mobilelabkit.airplay

import android.animation.ValueAnimator
import android.app.Activity
import android.app.AlertDialog
import android.app.PictureInPictureParams
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.RenderEffect
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.SpannableStringBuilder
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StyleSpan
import android.util.Log
import android.util.Rational
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView
import android.widget.Toast
import java.net.Inet4Address
import java.net.NetworkInterface
import kotlin.math.roundToInt

/**
 * Standalone AirPlay receiver. On launch it advertises itself over the LAN (mDNS) and
 * waits; when the user picks it in the iPhone's Control Center ▸ Screen Mirroring, the
 * native receiver hands us H.264 frames that [VideoDecoder] renders full-screen. Audio
 * is decoded + played entirely in native. View-only (AirPlay carries no input channel).
 *
 * Controls: a bottom "glass pill" bar (mute, pinch-zoom −/%/+, ⋯ more) — also pinch-to-zoom +
 * drag-to-pan directly on the video once zoomed. The ⋯ button opens a popup with the rest:
 * mirror resolution (720p…4K, persisted; changing it restarts the receiver — the iPhone must
 * re-pick the name), 🎨 saturation/contrast boost (API 31+, persisted), reset zoom, entering
 * picture-in-picture (also auto-entered on Home/recents while streaming), and sending the app
 * to the background outright (task stays alive — native audio/video keep running — without
 * occupying a floating PiP window). During streaming the bar auto-hides; tap the screen to
 * bring it back. Back press asks to confirm before exiting.
 */
class MainActivity : Activity(), NativeReceiver.Listener, SurfaceHolder.Callback {

    private lateinit var root: FrameLayout
    private lateinit var surfaceView: SurfaceView
    private lateinit var cover: View
    private lateinit var status: TextView
    private lateinit var waitingIcon: ImageView
    private var waitingPulse: ValueAnimator? = null
    private lateinit var controls: View
    private lateinit var muteBtn: TextView
    private lateinit var zoomLabel: TextView
    private var decoder: VideoDecoder? = null
    private var colorEnhance = true

    // Coded stream size (from the SPS), used to letterbox/pillarbox the SurfaceView instead
    // of stretching it full-screen. Reapplied whenever either changes: a new stream size
    // (e.g. the iPhone rotates) or the window bounds (e.g. this device rotates).
    private var videoW = 0
    private var videoH = 0

    // Pinch-to-zoom + pan on the mirrored video: implemented as plain View transforms
    // (scaleX/Y around the SurfaceView's center, translationX/Y for pan) rather than a GL
    // pipeline — the SurfaceView already exactly bounds the video content (see
    // applyVideoAspect), so clamping pan against its width/height keeps the zoomed view
    // from ever showing past the picture's edges.
    private var zoomScale = 1f
    private var panX = 0f
    private var panY = 0f
    private lateinit var scaleDetector: ScaleGestureDetector
    private lateinit var panDetector: GestureDetector

    private lateinit var prefs: SharedPreferences
    private var resKey: String = RES_DEFAULT

    private var multicastLock: WifiManager.MulticastLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private val ui = Handler(Looper.getMainLooper())
    private val hideControls = Runnable { if (streaming) controls.visibility = View.GONE }

    @Volatile private var streaming = false
    @Volatile private var restarting = false
    private var muted = false

    // Live RTSP/HTTP connections from the client (see onClientConnected/onClientDisconnected).
    // Individual open/close events are meaningless (iOS churns ancillary connections during
    // normal mirroring), but the count dropping to ZERO is a real signal: every connection
    // the iPhone had — including the persistent control/event pair — is gone, i.e. the
    // session is over (graceful stop, network death, or the iPhone giving up on us). That's
    // when the UI resets to "Waiting for iPhone" instead of freezing on the last frame.
    private val connCount = java.util.concurrent.atomic.AtomicInteger(0)

    private val advertisedName: String = DEFAULT_NAME

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        goImmersive()

        prefs = getSharedPreferences("settings", MODE_PRIVATE)
        resKey = prefs.getString("res", RES_DEFAULT) ?: RES_DEFAULT
        if (RES_OPTIONS.none { it.first == resKey }) resKey = RES_DEFAULT
        colorEnhance = prefs.getBoolean("colorEnhance", true)

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surfaceView = SurfaceView(this).apply { holder.addCallback(this@MainActivity) }
        applyColorEnhance()
        root.addView(
            surfaceView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
                Gravity.CENTER
            )
        )
        // Reapply the aspect-fit whenever the window bounds change (device rotation, or the
        // very first layout pass where width/height aren't known yet).
        root.addOnLayoutChangeListener { _, l, t, r, b, ol, ot, or_, ob ->
            if (r - l != or_ - ol || b - t != ob - ot) applyVideoAspect()
        }
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
        waitingIcon = ImageView(this).apply {
            setImageResource(R.drawable.ic_launcher_foreground)
            alpha = 0.55f
        }
        status = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
            setLineSpacing(dp(4).toFloat(), 1f)
            setPadding(dp(32), 0, dp(32), 0)
        }
        val waitingCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            addView(
                waitingIcon,
                LinearLayout.LayoutParams(dp(84), dp(84)).apply { bottomMargin = dp(20) }
            )
            addView(status)
        }
        root.addView(
            waitingCard,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER
            )
        )
        buildControls(root)
        setContentView(root)

        // Pinch to zoom, drag to pan (once zoomed), tap to bring back the auto-hidden
        // control bar. All three share one touch stream on the root, so a two-finger pinch
        // pans on its focal-point movement at the same time it scales — the usual photo-
        // viewer feel.
        scaleDetector = ScaleGestureDetector(this, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                // View.scaleX/Y always scale around the view's own CENTER pivot, not the pinch
                // focal point — left alone, the content visually slides out from under your
                // fingers as it scales (reads as "the view bouncing"). Compensate with a pan
                // delta that keeps the point under the fingers' midpoint fixed on screen (the
                // touch listener is on `root`, but the SurfaceView is centered within it via
                // Gravity.CENTER, so root's center IS the SurfaceView's pivot in root-space).
                val prevScale = zoomScale
                setZoom(zoomScale * detector.scaleFactor)
                val cx = root.width / 2f
                val cy = root.height / 2f
                val dx = (detector.focusX - cx) * (prevScale - zoomScale)
                val dy = (detector.focusY - cy) * (prevScale - zoomScale)
                applyPan(panX + dx, panY + dy)
                return true
            }
        })
        panDetector = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                if (streaming) showControlsBriefly()
                return true
            }
            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
                if (zoomScale <= 1f) return false
                applyPan(panX - distanceX, panY - distanceY)
                return true
            }
        })
        root.setOnTouchListener { _, event ->
            scaleDetector.onTouchEvent(event)
            panDetector.onTouchEvent(event)
            true
        }

        val (w, h) = parseRes(resKey)
        decoder = VideoDecoder(w, h).also { dec ->
            dec.onVideoSize = { vw, vh -> runOnUiThread { onVideoSize(vw, vh) } }
            // Keyframe starvation (the IDR a stream needs was lost and iOS won't re-send
            // one): force a video-stream restart — the client re-establishes the mirror
            // TCP connection and always leads the new stream with SPS/PPS + an IDR.
            dec.onStarved = { NativeReceiver.nudgeVideo() }
            dec.start()
        }
        showWaiting()
        acquireWifi()
        // Pin the whole process to the Wi-Fi network BEFORE creating the native sockets.
        // Android routes each app's sockets by fwmark; without this, our mDNS multicast
        // "sends" (sendto succeeds) but never egresses wlan0, so the iPhone never sees us.
        bindWifiThen { startReceiver() }
    }

    // --- control bar: a bottom "glass pill" + an overflow popup -----------------------
    private fun buildControls(root: FrameLayout) {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = glassSurface(dp(28).toFloat())
            setPadding(dp(6), dp(6), dp(6), dp(6))
            elevation = dp(6).toFloat()
        }
        muteBtn = iconButton(if (muted) "🔇" else "🔊").apply {
            setOnClickListener { toggleMute() }
        }
        zoomLabel = TextView(this).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            gravity = Gravity.CENTER
            minWidth = dp(52)
            text = zoomLabelText()
        }
        bar.addView(muteBtn)
        bar.addView(spacer(dp(6)))
        bar.addView(iconButton("➖").apply { setOnClickListener { stepZoom(-ZOOM_STEP) } })
        bar.addView(zoomLabel)
        bar.addView(iconButton("➕").apply { setOnClickListener { stepZoom(ZOOM_STEP) } })
        bar.addView(spacer(dp(6)))
        bar.addView(iconButton("⋯").apply { setOnClickListener { showMoreMenu(this) } })

        controls = bar
        root.addView(
            bar,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            ).apply { bottomMargin = dp(28) }
        )
    }

    private fun spacer(widthPx: Int) = View(this).apply { layoutParams = LinearLayout.LayoutParams(widthPx, 1) }

    /** Rounded, translucent "glass" surface — shared by the bottom bar and its overflow menu. */
    private fun glassSurface(cornerRadiusPx: Float): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = cornerRadiusPx
        setColor(0xE6141821.toInt())
        setStroke(dp(1), 0x26FFFFFF)
    }

    /** A circular icon-only button: ripple feedback, tinted glass background, centered glyph. */
    private fun iconButton(glyph: String, sizeDp: Int = 44): TextView = TextView(this).apply {
        text = glyph
        setTextColor(Color.WHITE)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
        gravity = Gravity.CENTER
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
        val base = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x24FFFFFF) }
        background = RippleDrawable(ColorStateList.valueOf(0x40FFFFFF), base, null)
    }

    /** The ⋯ overflow: everything that isn't a one-tap gesture-friendly control — resolution,
     *  color enhance, reset zoom, PiP, background — as a small rounded "glass" menu card
     *  anchored above the bar (a stock PopupMenu would render as a plain system dropdown,
     *  clashing with the bar's own styling). */
    private fun showMoreMenu(anchor: View) {
        lateinit var popupWindow: PopupWindow
        val menu = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = glassSurface(dp(18).toFloat())
            setPadding(dp(4), dp(4), dp(4), dp(4))
            elevation = dp(8).toFloat()
        }
        fun row(icon: String, label: String, trailing: String? = null, action: () -> Unit) {
            val r = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(14), dp(12), dp(14), dp(12))
                isClickable = true
                isFocusable = true
                background = RippleDrawable(ColorStateList.valueOf(0x33FFFFFF), null, null)
                setOnClickListener { popupWindow.dismiss(); action() }
            }
            r.addView(
                TextView(this).apply {
                    text = icon
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                    setTextColor(Color.WHITE)
                },
                LinearLayout.LayoutParams(dp(30), LinearLayout.LayoutParams.WRAP_CONTENT)
            )
            r.addView(
                TextView(this).apply {
                    text = label
                    setTextColor(Color.WHITE)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                },
                LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            )
            if (trailing != null) {
                r.addView(
                    TextView(this).apply {
                        text = trailing
                        setTextColor(0xFF8A93A6.toInt())
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                    }
                )
            }
            menu.addView(r, LinearLayout.LayoutParams(dp(230), LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        row("🖥", "Resolution", resLabel(resKey)) { pickResolution() }
        // RenderEffect (SurfaceView color grading) needs API 31+; below that it wouldn't do
        // anything, so it's simplest not to offer it at all.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            row("🎨", "Enhanced colors", if (colorEnhance) "On" else "Off") { toggleColorEnhance() }
        }
        row("⟲", "Reset zoom") { resetZoom(); if (streaming) showControlsBriefly() }
        if (pipSupported()) row("🖼", "Picture-in-picture") { enterPip() }
        row("🏠", "Move to background") { moveTaskToBack(true) }

        popupWindow = PopupWindow(menu, ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, true).apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT)) // let the menu's own rounded corners show
            isOutsideTouchable = true
            elevation = dp(12).toFloat()
        }
        menu.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED)
        popupWindow.showAsDropDown(
            anchor,
            -(menu.measuredWidth - anchor.width),
            -(anchor.height + menu.measuredHeight + dp(12))
        )
        if (streaming) showControlsBriefly()
    }

    // --- pinch-zoom / pan --------------------------------------------------------
    private fun zoomLabelText(): String = "${(zoomScale * 100).roundToInt()}%"

    private fun setZoom(newScale: Float) {
        zoomScale = newScale.coerceIn(MIN_ZOOM, MAX_ZOOM)
        surfaceView.scaleX = zoomScale
        surfaceView.scaleY = zoomScale
        applyPan(panX, panY) // re-clamp the existing pan to the new scale's bounds
        zoomLabel.text = zoomLabelText()
    }

    /** Clamp pan so the zoomed view never shows past the SurfaceView's own bounds — which
     *  (thanks to applyVideoAspect) exactly match the displayed picture, not the window. */
    private fun applyPan(x: Float, y: Float) {
        val maxX = surfaceView.width * (zoomScale - 1f) / 2f
        val maxY = surfaceView.height * (zoomScale - 1f) / 2f
        panX = x.coerceIn(-maxX, maxX)
        panY = y.coerceIn(-maxY, maxY)
        surfaceView.translationX = panX
        surfaceView.translationY = panY
    }

    private fun stepZoom(delta: Float) {
        setZoom(zoomScale + delta)
        if (streaming) showControlsBriefly()
    }

    private fun resetZoom() {
        zoomScale = 1f
        panX = 0f
        panY = 0f
        surfaceView.scaleX = 1f
        surfaceView.scaleY = 1f
        surfaceView.translationX = 0f
        surfaceView.translationY = 0f
        zoomLabel.text = zoomLabelText()
    }

    private fun toggleMute() {
        muted = !muted
        NativeReceiver.setMuted(muted)
        muteBtn.text = if (muted) "🔇" else "🔊"
        Toast.makeText(this, if (muted) "Audio muted" else "Audio on", Toast.LENGTH_SHORT).show()
        if (streaming) showControlsBriefly()
    }

    private fun toggleColorEnhance() {
        colorEnhance = !colorEnhance
        prefs.edit().putBoolean("colorEnhance", colorEnhance).apply()
        applyColorEnhance()
        Toast.makeText(
            this,
            if (colorEnhance) "Enhanced colors on" else "Enhanced colors off",
            Toast.LENGTH_SHORT
        ).show()
        if (streaming) showControlsBriefly()
    }

    /** Boost saturation + contrast on the SurfaceView's own compositor layer — this is baked
     *  into the hardware layer's blend (SurfaceView.setRenderEffect, API 31+), so it grades
     *  the MediaCodec-decoded frames directly with no GL pipeline of our own needed. */
    private fun applyColorEnhance() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        if (!colorEnhance) {
            surfaceView.setRenderEffect(null)
            return
        }
        val saturation = ColorMatrix().apply { setSaturation(1.35f) }
        val contrast = 1.12f
        val translate = (-0.5f * contrast + 0.5f) * 255f
        val contrastMatrix = ColorMatrix(
            floatArrayOf(
                contrast, 0f, 0f, 0f, translate,
                0f, contrast, 0f, 0f, translate,
                0f, 0f, contrast, 0f, translate,
                0f, 0f, 0f, 1f, 0f
            )
        )
        saturation.postConcat(contrastMatrix)
        val effect = RenderEffect.createColorFilterEffect(ColorMatrixColorFilter(saturation))
        surfaceView.setRenderEffect(effect)
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
        if (!streaming && !isConfig) {
            streaming = true
            runOnUiThread {
                hideWaiting()
                cover.visibility = View.GONE // reveal the live video
                showControlsBriefly()
            }
        }
    }

    // onClientConnected/onClientDisconnected fire from the native RTSP HTTP server's generic
    // per-TCP-connection accept/close (conn_init/conn_destroy in jni_bridge.c) — NOT from the
    // mirror video socket specifically. The iPhone opens short-lived HTTP connections for
    // ancillary requests (notably a periodic /feedback heartbeat) on the SAME control port
    // while mirroring continues uninterrupted, so INDIVIDUAL events are meaningless — an
    // earlier build that blanked the screen per-event flashed black every ~4s in normal use.
    // What IS meaningful is the live-connection COUNT reaching zero: the persistent
    // control/event pair is gone too, so the session is truly over (graceful stop, network
    // death, or the iPhone abandoning us). Only then reset to the waiting screen — otherwise
    // a dead session leaves the last frame up forever, indistinguishable from a freeze.
    override fun onClientConnected() {
        val n = connCount.incrementAndGet()
        Log.i(TAG, "client connection opened ($n live)")
    }

    override fun onClientDisconnected() {
        val n = connCount.decrementAndGet().coerceAtLeast(0)
        if (n <= 0) connCount.set(0)
        Log.i(TAG, "client connection closed ($n live)")
        if (n == 0 && streaming && !restarting) {
            streaming = false
            decoder?.onDisconnected()
            Log.i(TAG, "session ended (all client connections closed) — resetting to waiting screen")
            resetScreen()
        }
    }

    // --- aspect-ratio-preserving layout ------------------------------------------
    /** The decoded stream's coded size changed (first frame, or a rotation on the iPhone
     *  swapping width/height). Store it and re-fit the SurfaceView. */
    private fun onVideoSize(w: Int, h: Int) {
        if (w == videoW && h == videoH) return
        videoW = w
        videoH = h
        applyVideoAspect()
        resetZoom() // the SurfaceView's bounds just changed — old pan/zoom no longer applies
        if (pipSupported() && isInPictureInPictureMode) {
            runCatching {
                setPictureInPictureParams(PictureInPictureParams.Builder().setAspectRatio(pipAspectRatio()).build())
            }
        }
    }

    /** Size the SurfaceView to the video's aspect ratio, fit inside (letterboxed/pillarboxed)
     *  the current window bounds and centered — instead of stretching it full-screen. Handles
     *  both portrait and landscape sources, and reruns on every device rotation. */
    private fun applyVideoAspect() {
        val vw = videoW
        val vh = videoH
        val rootW = root.width
        val rootH = root.height
        if (vw <= 0 || vh <= 0 || rootW <= 0 || rootH <= 0) return
        val scale = minOf(rootW.toFloat() / vw, rootH.toFloat() / vh)
        val targetW = (vw * scale).toInt().coerceAtLeast(1)
        val targetH = (vh * scale).toInt().coerceAtLeast(1)
        val lp = surfaceView.layoutParams as FrameLayout.LayoutParams
        if (lp.width == targetW && lp.height == targetH) return
        lp.width = targetW
        lp.height = targetH
        lp.gravity = Gravity.CENTER
        surfaceView.layoutParams = lp
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
        NativeReceiver.stop()
        decoder?.release()
        decoder = null
        releaseWifi()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) goImmersive()
    }

    /** Back is a plain exit gesture here (single-Activity app, no back stack) — confirm
     *  first so it's not accidentally hit mid-session and drop the iPhone's connection. */
    @Suppress("DEPRECATION", "MissingSuperCall")
    override fun onBackPressed() {
        if (isInPictureInPictureMode) {
            super.onBackPressed()
            return
        }
        AlertDialog.Builder(this)
            .setTitle("Stop mirroring?")
            .setMessage("This closes the AirPlay receiver and disconnects the iPhone.")
            .setPositiveButton("Stop") { _, _ -> super.onBackPressed() }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /** Home/recents while actively mirroring → drop into PiP instead of just backgrounding,
     *  so the decode thread (which keeps running regardless — it's not tied to visibility)
     *  keeps rendering into a small floating window rather than an invisible one. Not called
     *  for rotation/other config changes, only an actual "leaving the app" gesture. */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (streaming) enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        if (isInPictureInPictureMode) {
            // The floating PiP window is tiny and touch-only-drives-the-system-controls —
            // our own overlay (control bar / waiting text) would just clutter it.
            ui.removeCallbacks(hideControls)
            controls.visibility = View.GONE
            setWaitingVisible(false)
        } else {
            goImmersive()
            if (streaming) showControlsBriefly() else showWaiting()
        }
    }

    private fun pipSupported(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

    /** The video's own aspect ratio (falling back to 16:9 before the first frame), clamped to
     *  what Android's PiP window allows (roughly 1:2.39 .. 2.39:1) so setAspectRatio never
     *  throws on an extreme portrait/landscape source. */
    private fun pipAspectRatio(): Rational {
        val w = videoW.takeIf { it > 0 } ?: 16
        val h = videoH.takeIf { it > 0 } ?: 9
        val ratio = (w.toFloat() / h.toFloat()).coerceIn(1f / 2.39f, 2.39f)
        return Rational((ratio * 1000).toInt(), 1000)
    }

    private fun enterPip() {
        if (!pipSupported()) return
        val params = PictureInPictureParams.Builder().setAspectRatio(pipAspectRatio()).build()
        runCatching { enterPictureInPictureMode(params) }
    }

    // --- helpers ---------------------------------------------------------------
    private fun showWaiting() {
        status.text = buildWaitingText(localIp())
        setWaitingVisible(true)
        controls.visibility = View.VISIBLE
        ui.removeCallbacks(hideControls)
    }

    private fun hideWaiting() = setWaitingVisible(false)

    /** A short typographic hierarchy (headline / instructions / device name / IP) instead of
     *  one flat text block — built with spans rather than a second TextView to keep this a
     *  single-view swap in the waiting card. */
    private fun buildWaitingText(ip: String?): CharSequence {
        val b = SpannableStringBuilder()
        fun append(text: String, sizeRel: Float, color: Int, bold: Boolean = false) {
            val start = b.length
            b.append(text)
            b.setSpan(RelativeSizeSpan(sizeRel), start, b.length, 0)
            b.setSpan(ForegroundColorSpan(color), start, b.length, 0)
            if (bold) b.setSpan(StyleSpan(android.graphics.Typeface.BOLD), start, b.length, 0)
        }
        append("Waiting for iPhone\n", 1.3f, Color.WHITE, bold = true)
        append("Control Center ▸ Screen Mirroring ▸\n", 0.9f, 0xFFAEB6C4.toInt())
        append("“$advertisedName”", 1f, 0xFF8FD3FF.toInt(), bold = true)
        append("  ·  ${resLabel(resKey)}", 0.85f, 0xFF6C7686.toInt())
        if (ip != null) append("\n$ip", 0.8f, 0xFF6C7686.toInt())
        return b
    }

    /** Toggles the waiting card (icon + text) together and starts/stops its idle pulse — kept
     *  as one entry point so no call site can show one half without the other. */
    private fun setWaitingVisible(visible: Boolean) {
        status.visibility = if (visible) View.VISIBLE else View.GONE
        waitingIcon.visibility = if (visible) View.VISIBLE else View.GONE
        if (visible) startWaitingPulse() else stopWaitingPulse()
    }

    private fun startWaitingPulse() {
        if (waitingPulse != null) return
        waitingPulse = ValueAnimator.ofFloat(0.35f, 0.9f).apply {
            duration = 1100
            repeatMode = ValueAnimator.REVERSE
            repeatCount = ValueAnimator.INFINITE
            addUpdateListener { waitingIcon.alpha = it.animatedValue as Float }
            start()
        }
    }

    private fun stopWaitingPulse() {
        waitingPulse?.cancel()
        waitingPulse = null
    }

    /** Blank the mirror (cover the frozen last frame) and show the waiting prompt again. */
    private fun resetScreen() = runOnUiThread {
        cover.visibility = View.VISIBLE
        showWaiting()
        resetZoom() // start the next session unzoomed
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
        // LOW_LATENCY (API 29+) is the mode that actually disables Wi-Fi power save while
        // we're foreground with the screen on — HIGH_PERF has been a no-op alias for years
        // (Android 13+ silently coerces it to low-latency; older builds ignore it outright).
        // Power save matters here: when the mirrored screen goes static, video traffic stops
        // and only per-second heartbeats remain — exactly the low-traffic lull that lets the
        // radio start napping and timing/feedback round-trips degrade.
        val lockMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        else
            @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifiLock = wifi.createWifiLock(lockMode, "airplay-wifi").apply {
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

        private const val MIN_ZOOM = 1f
        private const val MAX_ZOOM = 5f
        private const val ZOOM_STEP = 0.5f

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
