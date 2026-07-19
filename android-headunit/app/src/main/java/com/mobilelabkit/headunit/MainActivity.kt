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
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import f1x.aasdk.proto.messages.ServiceDiscoveryResponseMessage.ServiceDiscoveryResponse

/**
 * Android Auto head-unit receiver.
 *
 * As USB host we run the AOAP accessory-start (Phase 1), open the bulk link, then drive
 * the AA handshake (version → TLS → auth → the phone's service discovery, Phase 2). We
 * advertise a video display; when the phone opens + sets up the video channel we grant
 * focus and render its H.264 to a full-screen Surface (Phase 3).
 */
class MainActivity : Activity(), SurfaceHolder.Callback {

    private lateinit var surfaceView: SurfaceView
    private lateinit var status: TextView
    private lateinit var usb: UsbManager

    private var link: UsbAoap.Link? = null
    private var transport: AapTransport? = null
    private var control: ControlChannel? = null
    private var video: VideoChannel? = null
    private var decoder: VideoDecoder? = null
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
                    teardownProtocol()
                    link?.close(); link = null
                    busy = false; streaming = false
                    showWaiting()
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
        root.addView(surfaceView, FrameLayout.LayoutParams(MATCH, MATCH))
        status = TextView(this).apply {
            setTextColor(Color.WHITE); textSize = 18f; gravity = Gravity.CENTER
            setPadding(64, 64, 64, 64)
        }
        root.addView(status, FrameLayout.LayoutParams(MATCH, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
        setContentView(root)

        showWaiting()
        val filter = IntentFilter(ACTION_PERM).apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(permReceiver, filter, Context.RECEIVER_EXPORTED)
        else @Suppress("UnspecifiedRegisterReceiverFlag") registerReceiver(permReceiver, filter)

        (intent?.let { deviceExtra(it) })?.let { ensureAndHandle(it) } ?: scan()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        deviceExtra(intent)?.let { ensureAndHandle(it) }
    }

    override fun onResume() {
        super.onResume(); goImmersive()
        if (link == null && !busy) scan()
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching { unregisterReceiver(permReceiver) }
        teardownProtocol()
        link?.close(); link = null
        decoder?.release(); decoder = null
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus); if (hasFocus) goImmersive()
    }

    // --- SurfaceHolder ---------------------------------------------------------
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
            val flags = if (Build.VERSION.SDK_INT >= 31)
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
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
                        else "This device didn’t accept Android Auto over USB.\nCheck it's an Android phone with " +
                            "Android Auto set up, and that this device is the USB host."
                    )
                }
            } catch (e: Exception) {
                busy = false; Log.e(TAG, "device handling failed", e); setStatus("USB error: ${e.message}")
            }
        }, "aoap").start()
    }

    // --- AA protocol -----------------------------------------------------------
    private fun startAaProtocol(l: UsbAoap.Link) {
        try {
            val crypto = AapCrypto(assets.open("headunit_cert.pem").readBytes(), assets.open("headunit_key.pem").readBytes())
            val dec = VideoDecoder(VideoChannel.WIDTH, VideoChannel.HEIGHT).also { it.start() }
            decoder = dec
            surfaceView.holder.surface?.let { if (it.isValid) dec.setSurface(it) }

            lateinit var vid: VideoChannel
            val tp = AapTransport(l, crypto) { ch, _, id, content ->
                when (ch) {
                    AapProto.CH_CONTROL -> control?.onMessage(id, content)
                    AapProto.CH_VIDEO -> vid.onMessage(id, content)
                    else -> Log.d(TAG, "msg on ${AapProto.channelName(ch)} id=0x%04x (phase 4+)".format(id))
                }
                if (ch == AapProto.CH_VIDEO && !streaming &&
                    (id == AapProto.AV_MEDIA_INDICATION || id == AapProto.AV_MEDIA_WITH_TIMESTAMP_INDICATION)
                ) { streaming = true; runOnUiThread { status.visibility = View.GONE } }
            }.apply { onError = AapTransport.OnError { m -> busy = false; setStatus("Link error: $m") } }

            vid = VideoChannel(tp, dec) { setStatus(it) }
            val ctrl = ControlChannel(tp, crypto, onStatus = { setStatus(it) }, buildDiscoveryResponse = { buildDiscovery(vid) })
            transport = tp; control = ctrl; video = vid
            tp.start(); ctrl.begin()
        } catch (e: Exception) {
            busy = false; Log.e(TAG, "AA protocol start failed", e)
            setStatus("Couldn’t start the Android Auto protocol: ${e.message}")
        }
    }

    private fun buildDiscovery(vid: VideoChannel): ByteArray {
        val b = ServiceDiscoveryResponse.newBuilder()
            .setHeadUnitName("MobileLabKit")
            .setCarModel("MobileLabKit")
            .setCarYear("2026")
            .setCarSerial("MLK0001")
            .setLeftHandDriveVehicle(true)
            .setHeadunitManufacturer("MobileLabKit")
            .setHeadunitModel("MobileLabKit HeadUnit")
            .setSwBuild("1")
            .setSwVersion("0.3")
            .setCanPlayNativeMediaDuringVr(false)
            .setHideClock(false)
        vid.fillFeatures(b) // Phase 4+ adds input/audio here
        return b.build().toByteArray()
    }

    private fun teardownProtocol() {
        transport?.stop(); transport = null
        control = null; video = null
        decoder?.release(); decoder = null
    }

    // --- helpers ---------------------------------------------------------------
    private fun deviceExtra(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)

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
    }
}
