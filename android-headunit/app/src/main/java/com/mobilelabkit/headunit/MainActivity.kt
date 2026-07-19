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
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView

/**
 * Android Auto head-unit receiver — Phase 1 (USB / AOAP transport).
 *
 * Full-screen "car display". Plug a phone into this device (this device is the USB host —
 * use a USB-C↔USB-C cable, or an OTG adapter). We drive the AOAP accessory-start
 * sequence; the phone switches to Android Auto and re-enumerates as an accessory, and we
 * open its bulk IN/OUT link. Phase 2 layers the AA framing + TLS + channels on top of the
 * link this screen establishes.
 */
class MainActivity : Activity() {

    private lateinit var status: TextView
    private lateinit var usb: UsbManager
    private var link: UsbAoap.Link? = null
    @Volatile private var busy = false

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
                    val dev = deviceExtra(intent)
                    Log.i(TAG, "detached: ${dev?.deviceName}")
                    link?.close(); link = null
                    busy = false
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
        status = TextView(this).apply {
            setTextColor(Color.WHITE)
            textSize = 18f
            gravity = Gravity.CENTER
            setPadding(64, 64, 64, 64)
        }
        root.addView(
            status,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        )
        setContentView(root)

        val filter = IntentFilter(ACTION_PERM).apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(permReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(permReceiver, filter)
        }

        showWaiting()
        // Launched via USB_DEVICE_ATTACHED? Handle that device; else scan what's connected.
        (intent?.let { deviceExtra(it) })?.let { ensureAndHandle(it) } ?: scan()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        deviceExtra(intent)?.let { ensureAndHandle(it) }
    }

    override fun onResume() {
        super.onResume()
        goImmersive()
        if (link == null && !busy) scan()
    }

    override fun onDestroy() {
        super.onDestroy()
        runCatching { unregisterReceiver(permReceiver) }
        link?.close(); link = null
    }

    // --- device flow -----------------------------------------------------------
    /** Pick something to work with: a phone already in AA/accessory mode wins; else the
     *  first plugged-in device (candidate phone to switch into Android Auto). */
    private fun scan() {
        if (busy) return
        val devices = usb.deviceList.values
        val accessory = devices.firstOrNull { UsbAoap.isAccessory(it) }
        val candidate = accessory ?: devices.firstOrNull { it.deviceClass != UsbConstants.USB_CLASS_HUB }
        if (candidate == null) {
            showWaiting()
            return
        }
        ensureAndHandle(candidate)
    }

    /** Make sure we hold USB permission for [dev], then handle it. */
    private fun ensureAndHandle(dev: UsbDevice) {
        if (busy) return
        if (usb.hasPermission(dev)) {
            handleDevice(dev)
        } else {
            setStatus("Requesting USB permission…")
            val flags = if (Build.VERSION.SDK_INT >= 31)
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            else PendingIntent.FLAG_UPDATE_CURRENT
            val pi = PendingIntent.getBroadcast(this, 0, Intent(ACTION_PERM).setPackage(packageName), flags)
            usb.requestPermission(dev, pi)
        }
    }

    private fun handleDevice(dev: UsbDevice) {
        if (busy) return
        busy = true
        Thread({
            try {
                if (UsbAoap.isAccessory(dev)) {
                    // Already in Android Auto / accessory mode → open the bulk link.
                    val l = UsbAoap.openLink(usb, dev)
                    if (l != null) {
                        link = l
                        setStatus(
                            "✓ Android Auto link open\n\n" +
                                "Bulk endpoints ready (in ${l.maxPacketIn}B).\n" +
                                "Phase 2 (protocol / video) plugs in here."
                        )
                    } else {
                        busy = false
                        setStatus("Phone is in accessory mode but the bulk link failed to open.")
                    }
                } else {
                    // Ordinary phone → send the AOAP start sequence to launch Android Auto.
                    val conn = usb.openDevice(dev)
                    if (conn == null) {
                        busy = false
                        setStatus("Couldn’t open the phone (permission?). Reconnect and allow.")
                        return@Thread
                    }
                    setStatus("Starting Android Auto on the phone…")
                    val ok = UsbAoap.startAccessoryMode(conn)
                    conn.close()
                    busy = false // the re-enumerated accessory arrives via USB_DEVICE_ATTACHED
                    if (ok) {
                        setStatus("Android Auto starting…\nwaiting for the phone to reconnect.")
                    } else {
                        setStatus(
                            "This device didn’t accept Android Auto over USB.\n\n" +
                                "Make sure it's an Android phone with Android Auto set up, and that " +
                                "this device is the USB host (USB-C↔USB-C or an OTG adapter)."
                        )
                    }
                }
            } catch (e: Exception) {
                busy = false
                Log.e(TAG, "device handling failed", e)
                setStatus("USB error: ${e.message}")
            }
        }, "aoap").start()
    }

    // --- helpers ---------------------------------------------------------------
    private fun deviceExtra(intent: Intent): UsbDevice? =
        if (Build.VERSION.SDK_INT >= 33)
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)

    private fun showWaiting() = setStatus(
        "MobileLabKit — Android Auto head unit\n\n" +
            "Plug an Android phone into this device.\n" +
            "(This device is the USB host — use a USB-C↔USB-C cable or an OTG adapter, " +
            "and set up Android Auto on the phone first.)"
    )

    private fun setStatus(text: String) = runOnUiThread { status.text = text }

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
        private const val TAG = "headunit"
        private const val ACTION_PERM = "com.mobilelabkit.headunit.USB_PERMISSION"
    }
}
