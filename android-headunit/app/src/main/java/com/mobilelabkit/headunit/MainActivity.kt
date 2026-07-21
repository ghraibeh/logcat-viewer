package com.mobilelabkit.headunit

import android.Manifest
import android.app.Activity
import android.app.Dialog
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.util.Rational
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.media.AudioAttributes
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.CheckBox
import android.widget.FrameLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import com.andrerinas.headunitrevived.aap.protocol.proto.Common
import com.andrerinas.headunitrevived.aap.protocol.proto.Control
import com.andrerinas.headunitrevived.aap.protocol.proto.Input

/**
 * Android Auto head-unit receiver (modern protocol). USB/AOAP → the phone enters Android
 * Auto → TLS → the modern service-discovery + channel setup → the phone projects its car UI
 * (H.264 → MediaCodec → Surface), with touch forwarded back.
 */
class MainActivity : Activity(), SurfaceHolder.Callback {

    private lateinit var rootView: FrameLayout
    private lateinit var surfaceView: SurfaceView
    private lateinit var cover: View
    private lateinit var idle: IdleView
    private lateinit var usb: UsbManager
    private lateinit var videoConfig: HeadUnitConfig.VideoConfig

    @Volatile private var link: AapLink? = null
    private var wirelessServer: WirelessServer? = null
    private var nsdAdvertiser: NsdAdvertiser? = null
    private var softApHost: SoftApHost? = null
    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null
    private var btBootstrap: BtBootstrap? = null
    private var wifiDirect: WifiDirectHost? = null
    private var transport: AapTransport? = null
    private var control: ControlChannel? = null
    private var input: InputChannel? = null
    private var decoder: VideoDecoder? = null
    private var audioSinks: List<AudioSink> = emptyList()
    private var focusWatchdog: Thread? = null
    @Volatile private var busy = false
    @Volatile private var streaming = false

    private val permReceiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            when (intent.action) {
                ACTION_PERM -> {
                    val dev = deviceExtra(intent)
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    if (dev != null && granted) handleDevice(dev)
                    else setStatus("USB permission denied — reconnect the phone and allow it.")
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> deviceExtra(intent)?.let { ensureAndHandle(it) }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    Log.i(TAG, "detached: ${deviceExtra(intent)?.deviceName}")
                    teardownProtocol(); link?.close(); link = null
                    busy = false; streaming = false; showWaiting()
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        goImmersive()
        usb = getSystemService(Context.USB_SERVICE) as UsbManager
        ensureMicPermission()

        // Apply the saved orientation + auto-detect the panel resolution BEFORE the UI/protocol,
        // so the service-discovery we send the phone advertises the right display.
        val orientation = HeadUnitConfig.savedOrientation(this)
        applyOrientation(orientation)
        videoConfig = HeadUnitConfig.detect(this, orientation)

        // A head unit stays on and stationary: keep the screen awake so the panel never dozes
        // (which would sleep Wi-Fi and drop the wireless session).
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_main)
        rootView = findViewById(R.id.rootView)
        surfaceView = findViewById<SurfaceView>(R.id.surfaceView).apply { holder.addCallback(this@MainActivity) }
        @Suppress("ClickableViewAccessibility")
        surfaceView.setOnTouchListener { v, e -> onSurfaceTouch(v, e) }
        cover = findViewById(R.id.cover)
        idle = findViewById<IdleView>(R.id.idle).apply {
            onSettings = { showConfigDialog(firstRun = false) }
            onMethodSelected = { m -> onIdleMethodPicked(m) }
        }
        rootView.post { layoutSurface() }

        showWaiting()
        val filter = IntentFilter(ACTION_PERM).apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED); addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(permReceiver, filter, Context.RECEIVER_EXPORTED)
        else @Suppress("UnspecifiedRegisterReceiverFlag") registerReceiver(permReceiver, filter)

        // Wireless: always listen on TCP:5288 for a phone to connect; the Bluetooth bootstrap
        // (opt-in via ⚙) points the phone here. Harmless when only USB is used.
        startWireless()
        updateWirelessMode()
        // Optional: host our own Wi-Fi so no router/hotspot is needed. Off by default; does not
        // affect the USB or shared-network wireless paths.
        startSoftApIfEnabled()

        // First launch: ask portrait vs landscape before touching the phone.
        if (!HeadUnitConfig.isConfigured(this)) showConfigDialog(firstRun = true)
        else startFromIntentOrScan()
    }

    private fun startFromIntentOrScan() {
        (intent?.let { deviceExtra(it) })?.let { ensureAndHandle(it) } ?: scan()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent); deviceExtra(intent)?.let { ensureAndHandle(it) }
    }

    override fun onResume() { super.onResume(); goImmersive(); if (link == null && !busy) scan() }

    override fun onDestroy() {
        super.onDestroy(); runCatching { unregisterReceiver(permReceiver) }
        wirelessServer?.stop(); wirelessServer = null
        nsdAdvertiser?.stop(); nsdAdvertiser = null
        softApHost?.stop(); softApHost = null
        wifiLock?.let { runCatching { if (it.isHeld) it.release() } }; wifiLock = null
        btBootstrap?.stop(); btBootstrap = null; wifiDirect?.stop(); wifiDirect = null
        teardownProtocol(); link?.close(); link = null; decoder?.release(); decoder = null
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); if (hasFocus) goImmersive() }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig); goImmersive(); rootView.post { layoutSurface() }
    }

    // --- picture-in-picture (keep projecting when backgrounded) -----------------
    /** Pressing Home/Recents while projecting drops the app into a floating PiP window instead
     *  of stopping — the USB link + decode threads keep running, so Android Auto stays live. */
    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        enterPipIfActive()
    }

    private fun enterPipIfActive() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return
        if (link == null && !streaming) return // nothing running → don't float an empty window
        val w = videoConfig.width.coerceAtLeast(1)
        val h = videoConfig.height.coerceAtLeast(1)
        val params = PictureInPictureParams.Builder().setAspectRatio(Rational(w, h)).build()
        runCatching { enterPictureInPictureMode(params) }
    }

    override fun onPictureInPictureModeChanged(isInPip: Boolean, newConfig: android.content.res.Configuration) {
        super.onPictureInPictureModeChanged(isInPip, newConfig)
        runOnUiThread {
            // Clean floating video: hide the idle chrome in PiP / while streaming; restore otherwise.
            idle.visibility = if (isInPip || streaming) View.GONE else View.VISIBLE
            if (!isInPip) goImmersive()
        }
        rootView.post { layoutSurface() }
    }

    /** While Android Auto is streaming, back is a real action (it would otherwise dismiss the app
     *  mid-projection) — confirm before tearing the link down. Idle/connecting: default behavior. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (!streaming) { super.onBackPressed(); return }
        showDisconnectDialog()
    }

    /** On-brand confirmation sheet (matches the idle screen's dark palette) — a plain AlertDialog
     *  would look like a stock Android popup floating over a car-projection UI. Destructive action
     *  (red, on the right) is never the default focus; Cancel is the safe, easy tap.
     *  Layout: [R.layout.dialog_disconnect] — fixed 300dp width, same phone-dialog sizing as a
     *  standard Material AlertDialog (NOT derived from the AA car-density hack: HeadUnitConfig's
     *  CAR_DENSITY_DPI only tags the video/discovery response sent to the phone; it never touches
     *  this Activity's own Resources/Configuration). */
    private fun showDisconnectDialog() {
        val dialog = Dialog(this, android.R.style.Theme_Translucent_NoTitleBar)
        val view = layoutInflater.inflate(R.layout.dialog_disconnect, null)
        view.findViewById<View>(R.id.scrim).setOnClickListener { dialog.dismiss() }
        view.findViewById<View>(R.id.btnCancel).setOnClickListener { dialog.dismiss() }
        view.findViewById<View>(R.id.btnDisconnect).setOnClickListener { dialog.dismiss(); disconnect() }
        dialog.setContentView(view)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setDimAmount(0.6f)
            setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
        }
        dialog.setCancelable(true)
        dialog.show()
        // The scrim/card wrappers are focusable=false (see dialog_disconnect.xml) so they can't
        // steal D-pad focus from the buttons — but nothing then has focus by default on a TV
        // remote, so seed it onto Cancel (the safe default) explicitly.
        view.findViewById<View>(R.id.btnCancel).requestFocus()
    }

    /** Tear down the active session (same cleanup as a USB detach) and re-advertise for the next phone. */
    private fun disconnect() {
        teardownProtocol(); link?.close(); link = null
        busy = false; streaming = false
        nsdAdvertiser?.start()
        setStatus("Disconnected."); showWaiting()
    }

    override fun surfaceCreated(holder: SurfaceHolder) { decoder?.setSurface(holder.surface) }
    override fun surfaceChanged(holder: SurfaceHolder, f: Int, w: Int, h: Int) { decoder?.setSurface(holder.surface) }
    override fun surfaceDestroyed(holder: SurfaceHolder) { decoder?.setSurface(null) }

    // --- device flow -----------------------------------------------------------
    private fun scan() {
        if (busy) return
        val devices = usb.deviceList.values
        val accessory = devices.firstOrNull { UsbAoap.isAccessory(it) }
        val candidate = accessory ?: devices.firstOrNull { it.deviceClass != UsbConstants.USB_CLASS_HUB }
        if (candidate == null) { showWaiting(); return }
        ensureAndHandle(candidate)
    }

    private fun ensureAndHandle(dev: UsbDevice) {
        if (busy) return
        if (usb.hasPermission(dev)) handleDevice(dev)
        else {
            setStatus("Requesting USB permission…")
            val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            else PendingIntent.FLAG_UPDATE_CURRENT
            usb.requestPermission(dev, PendingIntent.getBroadcast(this, 0, Intent(ACTION_PERM).setPackage(packageName), flags))
        }
    }

    private fun handleDevice(dev: UsbDevice) {
        if (busy) return
        busy = true
        Thread({
            try {
                if (UsbAoap.isAccessory(dev)) {
                    val l = UsbAoap.openLink(usb, dev)
                    if (l != null) { link = l; setStatus("Android Auto link open — starting protocol…"); startAaProtocol(l) }
                    else { busy = false; setStatus("Accessory mode but the bulk link failed to open.") }
                } else {
                    val conn = usb.openDevice(dev)
                    if (conn == null) { busy = false; setStatus("Couldn’t open the phone (permission?)."); return@Thread }
                    setStatus("Starting Android Auto on the phone…")
                    val ok = UsbAoap.startAccessoryMode(conn); conn.close(); busy = false
                    setStatus(
                        if (ok) "Android Auto starting…\nwaiting for the phone to reconnect."
                        else "This device didn’t accept Android Auto over USB. Make sure Android Auto is set up and this device is the USB host."
                    )
                }
            } catch (e: Exception) {
                busy = false; Log.e(TAG, "device handling failed", e); setStatus("USB error: ${e.message}")
            }
        }, "aoap").start()
    }

    // --- wireless (TCP:5288) ---------------------------------------------------
    /** Start listening for a wireless AA connection (phone → our IP:5288). Safe to call repeatedly. */
    private fun startWireless() {
        if (wirelessServer?.isRunning == true) return
        wirelessServer = WirelessServer { socketLink ->
            // Handle the connection RIGHT HERE on the accept thread — do NOT hop to the UI thread
            // first. Android Auto's wireless setup resets the socket within ~30-40ms if it doesn't
            // get our version request, and a UI-thread hop (idle-screen animation, GC) can burn most
            // of that budget before we even send it. startAaProtocol already runs off the UI thread
            // for USB (the "aoap" worker), so this is the same code path; its few UI touches post
            // themselves to the UI thread. setStatus() is also main-thread-safe on its own.
            val current = link
            when {
                current == null && !busy -> {
                    link = socketLink
                    setStatus("Wireless phone connected — starting Android Auto…")
                    busy = true
                    startAaProtocol(socketLink)
                }
                // Video already flowing, or the session is USB (incl. the AOAP mode switch,
                // where busy is set with link still null): leave it alone.
                streaming || current !is SocketLink -> socketLink.close()
                else -> {
                    // The phone connected AGAIN while the wireless handshake is still pending:
                    // the held socket is a stalled probe (hotspot setups produce these — AA
                    // connects, then wedges without ever answering the version request). Adopt
                    // the fresh connection instead of rejecting it, or the retry can never win.
                    Log.i(TAG, "wireless reconnect during handshake — replacing the stalled link")
                    teardownProtocol(); current.close()
                    link = socketLink
                    setStatus("Wireless phone reconnected — starting Android Auto…")
                    busy = true; streaming = false
                    startAaProtocol(socketLink)
                }
            }
        }.also { it.start() }

        // Advertise on the LAN so the phone-side "AA Wireless Helper" can auto-discover us.
        if (nsdAdvertiser == null) {
            nsdAdvertiser = NsdAdvertiser(this, 5288, "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                .also { it.start() }
        }
        // Hold the Wi-Fi radio out of power-save so it doesn't sleep between beacons — otherwise
        // latency spikes to 30–100ms and Android Auto's wireless handshake times out ("version
        // request never answered"). WIFI_MODE_FULL_HIGH_PERF is DEPRECATED and a NO-OP on Android
        // 10+, so it left power-save on; WIFI_MODE_FULL_LOW_LATENCY (API 29+) actually disables it
        // (active while the screen is on + app foreground, which a head unit always is).
        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            else @Suppress("DEPRECATION") android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = wm.createWifiLock(mode, "MobileLabKit:HeadUnit").also { runCatching { it.acquire() } }
        }
    }

    // --- SoftAP (optional self-hosted Wi-Fi) -----------------------------------
    /** Bring up our own Wi-Fi via LocalOnlyHotspot if the user enabled it. The TCP:5288 server
     *  already binds on all interfaces, so it serves the SoftAP subnet with no other change. */
    private fun startSoftApIfEnabled() {
        if (!HeadUnitConfig.softApEnabled(this)) { softApHost?.stop(); softApHost = null; return }
        if (softApHost?.active == true) { if (!streaming) showWaiting(); return }
        val host = SoftApHost(this).also { softApHost = it }
        host.start(
            onReady = { if (!streaming) showWaiting() },
            onError = { msg -> runOnUiThread { if (!streaming) { showWaiting(); Toast.makeText(this, msg, Toast.LENGTH_LONG).show() } } }
        )
    }

    // --- AA protocol (modern) --------------------------------------------------
    private fun startAaProtocol(l: AapLink) {
        // Session starting: stop advertising as "available" so the helper's auto-reconnect
        // doesn't re-fire the trigger at us mid-session. We re-advertise on disconnect.
        nsdAdvertiser?.stop()
        try {
            val crypto = AapCrypto(assets.open("headunit_cert.pem").readBytes(), assets.open("headunit_key.pem").readBytes())

            lateinit var tp: AapTransport
            lateinit var sensor: SensorChannel
            lateinit var inp: InputChannel
            val media = HashMap<Int, MediaChannel>()

            tp = AapTransport(l, crypto) { ch, _, id, content ->
                // Channel-open (Control msg 7) can arrive on any channel — answer generically.
                if (id == Control.ControlMsgType.MESSAGE_CHANNEL_OPEN_REQUEST_VALUE) {
                    tp.sendMessage(
                        ch, Control.ControlMsgType.MESSAGE_CHANNEL_OPEN_RESPONSE_VALUE,
                        Control.ChannelOpenResponse.newBuilder().setStatus(Common.MessageStatus.STATUS_SUCCESS)
                            .build().toByteArray(),
                        encrypted = true
                    )
                    // The moment the SENSOR channel opens, push driving status = UNRESTRICTED
                    // UNSOLICITED. This is the projection safety gate: AA refuses to set up video
                    // until it knows the car is parked, and it does NOT ask (no SensorStartRequest).
                    if (ch == AapProto.CH_SENSOR) sensor.pushDrivingStatus()
                    // Once the video channel is open, tell the phone we're displaying AA so it
                    // sets up + streams video. headunit-revived re-sends this (unsolicited video
                    // focus) every 1.5s until video arrives — so run a watchdog, not a one-shot.
                    if (ch == AapProto.CH_VIDEO) media[AapProto.CH_VIDEO]?.let { startVideoFocusWatchdog(it) }
                } else {
                    when (ch) {
                        AapProto.CH_CONTROL -> control?.onMessage(id, content)
                        AapProto.CH_SENSOR -> sensor.onMessage(id, content)
                        AapProto.CH_INPUT -> inp.onMessage(id, content)
                        else -> media[ch]?.onMessage(id, content)
                            ?: Log.d(TAG, "msg on ${AapProto.channelName(ch)} id=0x%04x".format(id))
                    }
                }
                if (ch == AapProto.CH_VIDEO && !streaming &&
                    (id == com.andrerinas.headunitrevived.aap.protocol.proto.Media.MsgType.MEDIA_MESSAGE_DATA_VALUE ||
                        id == com.andrerinas.headunitrevived.aap.protocol.proto.Media.MsgType.MEDIA_MESSAGE_CODEC_CONFIG_VALUE)
                ) { streaming = true; runOnUiThread { cover.visibility = View.GONE; idle.visibility = View.GONE } }
            }.apply {
                onError = AapTransport.OnError { m ->
                    // USB has a DETACHED broadcast; a wireless socket only signals via this error,
                    // so fully tear down + free the link so the next connection can start.
                    runOnUiThread {
                        // A replaced/stale transport (wireless takeover) may still error out after
                        // a NEW session started — ignore it, or it would tear the new session down.
                        if (transport !== tp) return@runOnUiThread
                        teardownProtocol(); link?.close(); link = null
                        busy = false; streaming = false
                        // Idle again: re-advertise so the helper's auto-reconnect can find us.
                        nsdAdvertiser?.start()
                        setStatus("Link ended: $m"); showWaiting()
                    }
                }
            }

            // Lightweight channels wired up FIRST, then start the reader + send the version request
            // IMMEDIATELY. Android Auto's wireless setup drops the socket if the head unit doesn't
            // answer within ~100ms, and the decoder/audio init below can take longer than that — so
            // the handshake (version → TLS → discovery, none of which need media objects) is kicked
            // off before them. The heavy init then runs while those round-trips are in flight, and
            // finishes long before the phone opens any channel.
            sensor = SensorChannel(tp) { setStatus(it) }
            inp = InputChannel(tp, videoConfig.width, videoConfig.height) { setStatus(it) }
            val ctrl = ControlChannel(tp, crypto, videoConfig) { setStatus(it) }
            transport = tp; control = ctrl; input = inp
            tp.start(); ctrl.begin()

            // --- heavier setup (deferred so it doesn't delay the version request) ---
            val dec = VideoDecoder(videoConfig.width, videoConfig.height).also { it.start() }
            decoder = dec
            surfaceView.holder.surface?.let { if (it.isValid) dec.setSurface(it) }
            media[AapProto.CH_VIDEO] = MediaChannel(AapProto.CH_VIDEO, tp, dec) { setStatus(it) }
            // When the decoder desyncs (dropped/late frame), ask the phone for a fresh keyframe.
            dec.onNeedKeyframe = { media[AapProto.CH_VIDEO]?.gainVideoFocus() }
            // Audio sinks — play the phone's media / speech(nav+assistant) / system PCM out the
            // receiver's speaker. Sample rate + channels match what discovery advertised.
            val mediaSink = AudioSink(48000, 2, AudioAttributes.USAGE_MEDIA)
            val speechSink = AudioSink(16000, 1, AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            val systemSink = AudioSink(16000, 1, AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
            audioSinks = listOf(mediaSink, speechSink, systemSink)
            media[AapProto.CH_AUDIO_MEDIA] = MediaChannel(AapProto.CH_AUDIO_MEDIA, tp, null, audioSink = mediaSink) { setStatus(it) }
            media[AapProto.CH_AUDIO_SPEECH] = MediaChannel(AapProto.CH_AUDIO_SPEECH, tp, null, audioSink = speechSink) { setStatus(it) }
            media[AapProto.CH_AUDIO_SYSTEM] = MediaChannel(AapProto.CH_AUDIO_SYSTEM, tp, null, audioSink = systemSink) { setStatus(it) }
            // Mic channel captures the receiver's microphone for Assistant/voice (RECORD_AUDIO).
            media[AapProto.CH_MIC] = MediaChannel(AapProto.CH_MIC, tp, null, MicRecorder()) { setStatus(it) }
        } catch (e: Exception) {
            busy = false; Log.e(TAG, "AA protocol start failed", e)
            setStatus("Couldn’t start the Android Auto protocol: ${e.message}")
        }
    }

    /** Re-send unsolicited video focus every 1.5s until the video starts (headunit-revived's
     *  keyframe/focus watchdog). Exits once [streaming] flips or the receiver tears down. */
    private fun startVideoFocusWatchdog(video: MediaChannel) {
        focusWatchdog?.interrupt()
        focusWatchdog = Thread({
            while (transport != null) {
                val rendered = decoder?.lastFrameRenderedMs ?: 0L
                // Before streaming: nudge the phone to project. During streaming: if rendering
                // has stalled >2s, the picture is frozen → request a keyframe to recover.
                val stalled = streaming && rendered > 0L &&
                    android.os.SystemClock.elapsedRealtime() - rendered > 2000
                if (!streaming || stalled) runCatching { video.gainVideoFocus() }
                try { Thread.sleep(1500) } catch (e: InterruptedException) { break }
            }
        }, "video-focus-wd").also { it.start() }
    }

    private fun teardownProtocol() {
        focusWatchdog?.interrupt(); focusWatchdog = null
        control?.stop(); input?.stop(); transport?.stop(); transport = null
        control = null; input = null; decoder?.release(); decoder = null
        audioSinks.forEach { it.release() }; audioSinks = emptyList()
    }

    // --- helpers ---------------------------------------------------------------
    private fun deviceExtra(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)

    private fun onSurfaceTouch(v: View, e: MotionEvent): Boolean {
        val inp = input ?: return false
        val action = when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> Input.TouchEvent.PointerAction.TOUCH_ACTION_DOWN
            MotionEvent.ACTION_POINTER_DOWN -> Input.TouchEvent.PointerAction.TOUCH_ACTION_POINTER_DOWN
            MotionEvent.ACTION_MOVE -> Input.TouchEvent.PointerAction.TOUCH_ACTION_MOVE
            MotionEvent.ACTION_POINTER_UP -> Input.TouchEvent.PointerAction.TOUCH_ACTION_POINTER_UP
            MotionEvent.ACTION_UP -> Input.TouchEvent.PointerAction.TOUCH_ACTION_UP
            MotionEvent.ACTION_CANCEL -> Input.TouchEvent.PointerAction.TOUCH_ACTION_CANCEL
            else -> return false
        }
        // Forward EVERY active finger so multi-touch gestures (pinch-to-zoom, rotate) work — the
        // phone needs all pointer positions each frame. actionIndex marks which finger this
        // POINTER_DOWN/POINTER_UP is for. Coordinates map from the surface into AA display space.
        val sx = videoConfig.width.toFloat() / v.width.coerceAtLeast(1)
        val sy = videoConfig.height.toFloat() / v.height.coerceAtLeast(1)
        val pointers = (0 until e.pointerCount).map { i ->
            InputChannel.TouchPointer(e.getPointerId(i), (e.getX(i) * sx).toInt(), (e.getY(i) * sy).toInt())
        }
        inp.sendTouch(action, pointers, e.actionIndex)
        return true
    }

    // Android TV remote: once AA video is actually streaming, D-pad/select/back/media drive the
    // projected car UI on the phone (same as a head unit's hardware buttons) instead of the
    // activity's own view focus. Before streaming starts, keys fall through to the normal
    // Activity handling so the idle screen / settings dialog stay D-pad-navigable.
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean =
        forwardKeyToPhone(keyCode, down = true) || super.onKeyDown(keyCode, event)

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean =
        forwardKeyToPhone(keyCode, down = false) || super.onKeyUp(keyCode, event)

    private fun forwardKeyToPhone(keyCode: Int, down: Boolean): Boolean {
        if (!streaming || keyCode !in REMOTE_FORWARDED_KEYCODES) return false
        val inp = input ?: return false
        inp.sendKey(keyCode, down)
        return true
    }

    /** Ask for the mic at launch so Android Auto voice / Assistant works once connected. */
    private fun ensureMicPermission() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            runCatching { requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_MIC) }
        }
    }

    /**
     * Wireless mode is the TCP:5288 server (always running) + NSD advertising + the on-screen
     * "AA Wireless Helper" instructions. The old Bluetooth→Wi-Fi-Direct bootstrap
     * ([BtBootstrap]/[WifiDirectHost]) is intentionally NOT started: on Android it can't hold the
     * Bluetooth ACL / present the HFP "car" role that stock Android Auto requires, so it never
     * latches (verified on-device). The working path is the phone-side helper firing AA's
     * WirelessStartup trigger at us over the shared Wi-Fi. Kept as reference, not invoked.
     */
    private fun updateWirelessMode() {
        // Make sure any previously-started bootstrap is torn down, then refresh the waiting screen.
        btBootstrap?.stop(); btBootstrap = null
        wifiDirect?.stop(); wifiDirect = null
        if (!streaming) showWaiting()
    }

    private fun wirelessPerms(): Array<String> {
        val p = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION)
        if (Build.VERSION.SDK_INT >= 31) {
            p += Manifest.permission.BLUETOOTH_CONNECT
            p += Manifest.permission.BLUETOOTH_ADVERTISE
            p += Manifest.permission.BLUETOOTH_SCAN
        }
        if (Build.VERSION.SDK_INT >= 33) p += Manifest.permission.NEARBY_WIFI_DEVICES
        return p.toTypedArray()
    }

    private fun hasWirelessPermissions(): Boolean =
        wirelessPerms().all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }

    private fun requestWirelessPermissions() {
        runCatching { requestPermissions(wirelessPerms(), REQ_WIRELESS) }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_WIRELESS) updateWirelessMode()
    }

    // --- display configuration -------------------------------------------------
    private fun applyOrientation(o: HeadUnitConfig.Orientation) {
        requestedOrientation = if (o == HeadUnitConfig.Orientation.LANDSCAPE)
            ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
    }

    /** Size the projection surface per the scaling setting:
     *  FIT (default) keeps AA's aspect ratio, centered (may show black bars on odd-aspect panels);
     *  FILL stretches to the whole panel (no bars, but distorts). Touch maps proportionally either way. */
    private fun layoutSurface() {
        if (HeadUnitConfig.savedScaling(this) == HeadUnitConfig.Scaling.FILL) {
            surfaceView.layoutParams = FrameLayout.LayoutParams(MATCH, MATCH, Gravity.CENTER)
        } else {
            val rw = rootView.width; val rh = rootView.height
            if (rw == 0 || rh == 0 || !::videoConfig.isInitialized) return
            val vw = videoConfig.width.toFloat(); val vh = videoConfig.height.toFloat()
            val scale = minOf(rw / vw, rh / vh)
            val sw = (vw * scale).toInt().coerceAtLeast(1)
            val sh = (vh * scale).toInt().coerceAtLeast(1)
            surfaceView.layoutParams = FrameLayout.LayoutParams(sw, sh, Gravity.CENTER)
        }
        surfaceView.requestLayout()
    }

    /** Display chooser: orientation (auto-detected resolution shown) + a stretch-to-fill toggle,
     *  presented as a bottom sheet (structure in [R.layout.dialog_config]) rather than a centered
     *  AlertDialog — a settings panel reads as a sheet the user pulls up, not a popup interrupting
     *  the car UI. Only the values that are inherently runtime data (detected resolutions, saved
     *  prefs) are set here. */
    private fun showConfigDialog(firstRun: Boolean) {
        val current = if (::videoConfig.isInitialized) videoConfig.orientation else HeadUnitConfig.savedOrientation(this)
        val portrait = HeadUnitConfig.detect(this, HeadUnitConfig.Orientation.PORTRAIT)
        val landscape = HeadUnitConfig.detect(this, HeadUnitConfig.Orientation.LANDSCAPE)

        val view = layoutInflater.inflate(R.layout.dialog_config, null)
        view.findViewById<TextView>(R.id.tvTitle).text =
            if (firstRun) "Choose head-unit display" else "Head-unit display"
        val group = view.findViewById<RadioGroup>(R.id.group)
        view.findViewById<RadioButton>(R.id.rbPortrait).apply {
            id = 1; text = "Portrait — ${portrait.width}×${portrait.height}"
        }
        view.findViewById<RadioButton>(R.id.rbLandscape).apply {
            id = 2; text = "Landscape — ${landscape.width}×${landscape.height}"
        }
        group.check(if (current == HeadUnitConfig.Orientation.LANDSCAPE) 2 else 1)
        val stretch = view.findViewById<CheckBox>(R.id.cbStretch).apply {
            isChecked = HeadUnitConfig.savedScaling(this@MainActivity) == HeadUnitConfig.Scaling.FILL
        }
        // Connection method as ONE exclusive choice. AP = host our own Wi-Fi + show the join QR;
        // picking USB or Wireless turns the AP back off (see the OK handler + startSoftApIfEnabled).
        val groupConn = view.findViewById<RadioGroup>(R.id.groupConn)
        groupConn.check(
            when {
                HeadUnitConfig.softApEnabled(this) -> R.id.rbConnAp
                HeadUnitConfig.wirelessEnabled(this) -> R.id.rbConnWireless
                else -> R.id.rbConnUsb
            }
        )

        val dialog = Dialog(this, android.R.style.Theme_Translucent_NoTitleBar)
        // Full-screen window (the sheet itself is bottom-anchored via the XML's layout_gravity)
        // so there's real "outside" area above the sheet to tap-to-dismiss on — a WRAP_CONTENT
        // window would only cover the sheet's own rect, leaving nothing there to catch the tap.
        view.findViewById<View>(R.id.scrim).setOnClickListener { if (!firstRun) dialog.dismiss() }
        view.findViewById<View>(R.id.btnCancel).apply {
            visibility = if (firstRun) View.GONE else View.VISIBLE
            setOnClickListener { dialog.dismiss() }
        }
        view.findViewById<View>(R.id.btnOk).setOnClickListener {
            val chosen = if (group.checkedRadioButtonId == 2) HeadUnitConfig.Orientation.LANDSCAPE else HeadUnitConfig.Orientation.PORTRAIT
            HeadUnitConfig.saveScaling(this, if (stretch.isChecked) HeadUnitConfig.Scaling.FILL else HeadUnitConfig.Scaling.FIT)
            val ap = groupConn.checkedRadioButtonId == R.id.rbConnAp
            // Wireless server + NSD are useful for both Wireless and AP modes; only USB turns them off.
            HeadUnitConfig.saveWireless(this, ap || groupConn.checkedRadioButtonId == R.id.rbConnWireless)
            HeadUnitConfig.saveSoftAp(this, ap)
            dialog.dismiss()
            applyConfig(chosen)
            updateWirelessMode()
            startSoftApIfEnabled()  // AP on → starts SoftAP + the QR appears; else stops it
            if (firstRun) startFromIntentOrScan()
        }

        dialog.setContentView(view)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setDimAmount(0.6f)
            attributes.windowAnimations = R.style.BottomSheetAnimation
            setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
        }
        dialog.setCancelable(!firstRun)
        // Cap the sheet to a share of the display height once its natural (wrap_content) size is
        // known, and shrink just the fields' ScrollView by the overflow — a short/landscape panel
        // otherwise lets the sheet grow taller than the screen and pushes Cancel/OK off it.
        val sheet = view.findViewById<View>(R.id.sheet)
        val scrollFields = view.findViewById<View>(R.id.scrollFields)
        view.viewTreeObserver.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                view.viewTreeObserver.removeOnPreDrawListener(this)
                val maxSheetHeight = (resources.displayMetrics.heightPixels * 0.82f).toInt()
                val overflow = sheet.height - maxSheetHeight
                if (overflow > 0) {
                    scrollFields.layoutParams = scrollFields.layoutParams.apply {
                        height = (scrollFields.height - overflow).coerceAtLeast(0)
                    }
                }
                return true
            }
        })
        dialog.show()
        // Same as the disconnect dialog: the scrim/sheet are focusable=false so they don't steal
        // D-pad focus, but something still needs to hold it initially on a TV remote — seed it
        // onto the currently-checked orientation option.
        group.findViewById<View>(group.checkedRadioButtonId).requestFocus()
    }

    /** Persist + apply an orientation choice; detect its resolution and relayout. */
    private fun applyConfig(o: HeadUnitConfig.Orientation) {
        val changed = !::videoConfig.isInitialized || videoConfig.orientation != o
        HeadUnitConfig.saveOrientation(this, o)
        applyOrientation(o)
        videoConfig = HeadUnitConfig.detect(this, o)
        rootView.post { layoutSurface() }
        if (!streaming) showWaiting()
        if (changed && transport != null) {
            Toast.makeText(
                this, "Re-plug the phone to apply ${o.name.lowercase()} ${videoConfig.width}×${videoConfig.height}",
                Toast.LENGTH_LONG
            ).show()
        }
    }

    /** Which method the persisted config maps to (AP wins over plain wireless). */
    private fun savedMethod(): IdleView.Method = when {
        HeadUnitConfig.softApEnabled(this) -> IdleView.Method.AP_WIFI
        HeadUnitConfig.wirelessEnabled(this) -> IdleView.Method.WIRELESS
        else -> IdleView.Method.USB
    }

    /** User tapped a method card on the idle screen: persist it and (dis)engage the SoftAP.
     *  AP WIFI → host our own Wi-Fi + show the join QR; USB/Wireless → turn the SoftAP back off. */
    private fun onIdleMethodPicked(m: IdleView.Method) {
        when (m) {
            IdleView.Method.AP_WIFI -> { HeadUnitConfig.saveWireless(this, true); HeadUnitConfig.saveSoftAp(this, true) }
            IdleView.Method.WIRELESS -> { HeadUnitConfig.saveWireless(this, true); HeadUnitConfig.saveSoftAp(this, false) }
            IdleView.Method.USB -> { HeadUnitConfig.saveWireless(this, false); HeadUnitConfig.saveSoftAp(this, false) }
        }
        updateWirelessMode()
        startSoftApIfEnabled()  // AP on → SoftAP + QR appear (on onReady); else stops it
        if (!streaming) showWaiting()
    }

    /** Configure the idle screen for the WAITING state: which methods are available, the SoftAP
     *  join card (if hosting), and the display label. */
    private fun showWaiting() = runOnUiThread {
        if (streaming) return@runOnUiThread
        val ap = softApHost?.info
        // All three methods are always selectable (tapping one engages it); sync the highlight to
        // the persisted mode without re-firing the tap callback.
        idle.setMethods(usb = true, wireless = true)
        idle.setActiveMethod(savedMethod())
        idle.setSoftAp(ap)
        // No SoftAP: if wireless is on, we're already listening on TCP:5288 — offer a scan-to-connect
        // QR for this shared-network IP too, instead of only a generic "waiting" card.
        idle.setShareIp(if (ap == null && HeadUnitConfig.wirelessEnabled(this)) NsdAdvertiser.localIpv4() else null)
        idle.setDisplayLabel(videoConfig.label)
        idle.showState(
            IdleView.Phase.WAITING,
            when {
                ap != null -> "Scan the code with “AA Wireless Helper”, or join the Wi-Fi below."
                HeadUnitConfig.wirelessEnabled(this) -> "Plug in over USB, or connect from “AA Wireless Helper” on the same Wi-Fi."
                else -> "Plug an Android phone into this device over USB (USB-C↔USB-C or OTG)."
            }
        )
        cover.visibility = View.VISIBLE
        idle.visibility = View.VISIBLE
    }

    /** Live status text from the USB/protocol flow → the idle hero, with a phase inferred from the
     *  wording so the state chip + spinner reflect connecting vs. error vs. waiting. */
    private fun setStatus(text: String) = runOnUiThread {
        val lower = text.lowercase()
        val phase = when {
            lower.contains("error") || lower.contains("failed") || lower.contains("couldn") ||
                lower.contains("denied") || lower.contains("ended") -> IdleView.Phase.ERROR
            lower.contains("starting") || lower.contains("connect") || lower.contains("handshake") ||
                lower.contains("tls") || lower.contains("version") || lower.contains("discovery") ||
                lower.contains("focus") || lower.contains("open") || lower.contains("waiting for") -> IdleView.Phase.CONNECTING
            else -> IdleView.Phase.WAITING
        }
        if (!streaming) {
            cover.visibility = View.VISIBLE   // hide any frozen last frame behind the idle screen
            idle.visibility = View.VISIBLE
            idle.showState(phase, text)
        }
        Log.i(TAG, text.replace("\n", " · "))
    }

    @Suppress("DEPRECATION")
    private fun goImmersive() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
                View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY)
    }

    companion object {
        private const val TAG = "headunit"
        private const val ACTION_PERM = "com.mobilelabkit.headunit.USB_PERMISSION"
        private const val REQ_MIC = 101
        private const val REQ_WIRELESS = 102
        private const val MATCH = FrameLayout.LayoutParams.MATCH_PARENT
        private const val WRAP = FrameLayout.LayoutParams.WRAP_CONTENT

        /** Keys an Android TV remote sends that make sense to hand to the projected AA session. */
        private val REMOTE_FORWARDED_KEYCODES = setOf(
            KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_BACK,
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE,
            KeyEvent.KEYCODE_MEDIA_NEXT, KeyEvent.KEYCODE_MEDIA_PREVIOUS
        )
    }
}
