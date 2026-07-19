package com.mobilelabkit.headunit

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import com.andrerinas.headunitrevived.aap.protocol.proto.Common
import com.andrerinas.headunitrevived.aap.protocol.proto.Control
import com.andrerinas.headunitrevived.aap.protocol.proto.Input

/**
 * Android Auto head-unit receiver (modern protocol). USB/AOAP → the phone enters Android
 * Auto → TLS → the modern service-discovery + channel setup → the phone projects its car UI
 * (H.264 → MediaCodec → Surface), with touch forwarded back.
 */
class MainActivity : Activity(), SurfaceHolder.Callback {

    private lateinit var surfaceView: SurfaceView
    private lateinit var status: TextView
    private lateinit var usb: UsbManager

    private var link: UsbAoap.Link? = null
    private var transport: AapTransport? = null
    private var control: ControlChannel? = null
    private var input: InputChannel? = null
    private var decoder: VideoDecoder? = null
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

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surfaceView = SurfaceView(this).apply { holder.addCallback(this@MainActivity) }
        @Suppress("ClickableViewAccessibility")
        surfaceView.setOnTouchListener { v, e -> onSurfaceTouch(v, e) }
        root.addView(surfaceView, FrameLayout.LayoutParams(MATCH, MATCH))
        status = TextView(this).apply {
            setTextColor(Color.WHITE); textSize = 18f; gravity = Gravity.CENTER; setPadding(64, 64, 64, 64)
        }
        root.addView(status, FrameLayout.LayoutParams(MATCH, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        setContentView(root)

        showWaiting()
        val filter = IntentFilter(ACTION_PERM).apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED); addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(permReceiver, filter, Context.RECEIVER_EXPORTED)
        else @Suppress("UnspecifiedRegisterReceiverFlag") registerReceiver(permReceiver, filter)

        (intent?.let { deviceExtra(it) })?.let { ensureAndHandle(it) } ?: scan()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent); deviceExtra(intent)?.let { ensureAndHandle(it) }
    }

    override fun onResume() { super.onResume(); goImmersive(); if (link == null && !busy) scan() }

    override fun onDestroy() {
        super.onDestroy(); runCatching { unregisterReceiver(permReceiver) }
        teardownProtocol(); link?.close(); link = null; decoder?.release(); decoder = null
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); if (hasFocus) goImmersive() }

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

    // --- AA protocol (modern) --------------------------------------------------
    private fun startAaProtocol(l: UsbAoap.Link) {
        try {
            val crypto = AapCrypto(assets.open("headunit_cert.pem").readBytes(), assets.open("headunit_key.pem").readBytes())
            val dec = VideoDecoder(VIDEO_W, VIDEO_H).also { it.start() }
            decoder = dec
            surfaceView.holder.surface?.let { if (it.isValid) dec.setSurface(it) }

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
                ) { streaming = true; runOnUiThread { status.visibility = View.GONE } }
            }.apply { onError = AapTransport.OnError { m -> busy = false; setStatus("Link error: $m") } }

            sensor = SensorChannel(tp) { setStatus(it) }
            inp = InputChannel(tp, VIDEO_W, VIDEO_H) { setStatus(it) }
            media[AapProto.CH_VIDEO] = MediaChannel(AapProto.CH_VIDEO, tp, dec) { setStatus(it) }
            for (a in intArrayOf(AapProto.CH_AUDIO_MEDIA, AapProto.CH_AUDIO_SPEECH, AapProto.CH_AUDIO_SYSTEM, AapProto.CH_MIC)) {
                media[a] = MediaChannel(a, tp, null) { setStatus(it) }
            }
            val ctrl = ControlChannel(tp, crypto, VIDEO_W, VIDEO_H) { setStatus(it) }
            transport = tp; control = ctrl; input = inp
            tp.start(); ctrl.begin()
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
            var tries = 0
            while (!streaming && tries < 60 && transport != null) {
                runCatching { video.gainVideoFocus() }
                try { Thread.sleep(1500) } catch (e: InterruptedException) { break }
                tries++
            }
        }, "video-focus-wd").also { it.start() }
    }

    private fun teardownProtocol() {
        focusWatchdog?.interrupt(); focusWatchdog = null
        control?.stop(); transport?.stop(); transport = null
        control = null; input = null; decoder?.release(); decoder = null
    }

    // --- helpers ---------------------------------------------------------------
    private fun deviceExtra(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)

    private fun onSurfaceTouch(v: View, e: MotionEvent): Boolean {
        val inp = input ?: return false
        val action = when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> Input.TouchEvent.PointerAction.TOUCH_ACTION_DOWN
            MotionEvent.ACTION_MOVE -> Input.TouchEvent.PointerAction.TOUCH_ACTION_MOVE
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> Input.TouchEvent.PointerAction.TOUCH_ACTION_UP
            else -> return false
        }
        val x = (e.x / v.width.coerceAtLeast(1) * VIDEO_W).toInt()
        val y = (e.y / v.height.coerceAtLeast(1) * VIDEO_H).toInt()
        inp.sendTouch(action, x, y)
        return true
    }

    private fun showWaiting() = setStatus(
        "MobileLabKit — Android Auto head unit\n\n" +
            "Plug an Android phone into this device.\n" +
            "(This device is the USB host — USB-C↔USB-C or an OTG adapter; set up Android Auto on the phone first.)"
    )

    private fun setStatus(text: String) = runOnUiThread {
        if (!streaming) { status.visibility = View.VISIBLE; status.text = text }
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
        private const val MATCH = FrameLayout.LayoutParams.MATCH_PARENT
        const val VIDEO_W = 800
        const val VIDEO_H = 480
    }
}
