package com.mobilelabkit.aahelper

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.ConnectivityManager
import android.net.Uri
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * "AA Wireless Helper" — runs on the **source phone** (the one with Android Auto).
 *
 * Stock Android Auto has no way to be triggered from the head-unit side: something on the
 * phone has to tell it "connect to this head unit's IP:port". That trigger is Google's hidden
 * `WirelessStartupActivity` (or, on AA 16.4+, the `WirelessStartupReceiver` broadcast). This
 * app is a one-button front end for it — the same role as headunit-revived's "Wireless Helper".
 *
 * Flow: open the head-unit app on the receiver → it listens on TCP :5288 and shows its Wi-Fi
 * IP → type that IP here → **Connect** → Android Auto projects to the head unit over the shared
 * Wi-Fi. No Bluetooth, no Wi-Fi Direct.
 */
class MainActivity : Activity() {

    private lateinit var ipField: EditText
    private lateinit var portField: EditText
    private lateinit var status: TextView

    private val nsd by lazy { getSystemService(Context.NSD_SERVICE) as NsdManager }
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var resolving = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val dp = { v: Int -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt() }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(28), dp(24), dp(24))
        }

        root.addView(TextView(this).apply {
            text = "AA Wireless Helper"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            setTextColor(Color.BLACK)
        })
        root.addView(TextView(this).apply {
            text = "Open the head-unit app on the receiver (same Wi-Fi). Tap Scan to find it automatically, " +
                "or type the IP it shows, then Connect."
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(Color.DKGRAY)
            setPadding(0, dp(6), 0, dp(16))
        })

        val scan = Button(this).apply { text = "Scan for head unit" }
        scan.setOnClickListener { startScan() }
        root.addView(scan)

        root.addView(label("Head unit IP"))
        ipField = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            hint = "e.g. 192.168.5.63"
            setText(prefs.getString(KEY_IP, ""))
        }
        root.addView(ipField)

        root.addView(label("Port"))
        portField = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            setText(prefs.getInt(KEY_PORT, DEFAULT_PORT).toString())
        }
        root.addView(portField)

        val connect = Button(this).apply {
            text = "Connect & keep alive"
            setPadding(0, dp(8), 0, dp(8))
        }
        connect.setOnClickListener { onConnect() }
        root.addView(connect, lp(dp(16)))

        val disconnect = Button(this).apply { text = "Stop keeping alive" }
        disconnect.setOnClickListener {
            KeepAliveService.stop(this)
            status.text = "Stopped. Android Auto will disconnect on its own."
        }
        root.addView(disconnect, lp(dp(8)))

        status = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(Color.DKGRAY)
            setPadding(0, dp(14), 0, 0)
        }
        root.addView(status)

        // Samsung/OEM battery managers freeze Android Auto's projection process after a few
        // seconds and kill the session. This shortcut opens AA's app info so the user can set
        // battery usage to "Unrestricted" once. (A normal app can't whitelist another app.)
        val battery = Button(this).apply { text = "Keep Android Auto awake (battery settings)" }
        battery.setOnClickListener { openAaBatterySettings() }
        root.addView(battery, lp(dp(28)))

        // --- Auto-start (hands-free): kick off wireless AA without opening this app ---
        root.addView(label("Auto-start (hands-free)"))

        val wifiAuto = CheckBox(this).apply {
            text = "When I join this Wi-Fi network"
            isChecked = prefs.getBoolean(TriggerReceiver.KEY_WIFI, false)
        }
        wifiAuto.setOnCheckedChangeListener { _, checked ->
            if (checked) {
                val ssid = currentSsid()
                if (ssid.isEmpty() || ssid == "<unknown ssid>") {
                    Toast.makeText(this, "Join the head unit's Wi-Fi first, then enable this.", Toast.LENGTH_LONG).show()
                    wifiAuto.isChecked = false
                } else {
                    prefs.edit().putString(TriggerReceiver.KEY_WIFI_SSID, ssid)
                        .putBoolean(TriggerReceiver.KEY_WIFI, true).apply()
                    Toast.makeText(this, "Will auto-start on “$ssid”", Toast.LENGTH_SHORT).show()
                    requestSelfBatteryExemption()
                }
            } else prefs.edit().putBoolean(TriggerReceiver.KEY_WIFI, false).apply()
        }
        root.addView(wifiAuto, lp(dp(16)))

        val btAuto = CheckBox(this).apply {
            text = "When Bluetooth connects (car / head unit)"
            isChecked = prefs.getBoolean(TriggerReceiver.KEY_BT, false)
        }
        btAuto.setOnCheckedChangeListener { _, checked ->
            if (checked) {
                val mac = connectedBtMac()
                prefs.edit().putString(TriggerReceiver.KEY_BT_MAC, mac)
                    .putBoolean(TriggerReceiver.KEY_BT, true).apply()
                Toast.makeText(this,
                    if (mac.isEmpty()) "Enabled (any paired device — connect the car's BT first to pin it)"
                    else "Will auto-start when that device connects", Toast.LENGTH_LONG).show()
                requestSelfBatteryExemption()
            } else prefs.edit().putBoolean(TriggerReceiver.KEY_BT, false).apply()
        }
        root.addView(btAuto, lp(dp(4)))

        setContentView(root)

        // FINE_LOCATION: non-redacted WifiInfo extra (Android 10+). POST_NOTIFICATIONS (Android 13+):
        // so the keep-alive foreground-service notification is visible.
        val need = mutableListOf<String>()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            need += android.Manifest.permission.ACCESS_FINE_LOCATION
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need += android.Manifest.permission.POST_NOTIFICATIONS
        }
        if (need.isNotEmpty()) requestPermissions(need.toTypedArray(), 1)
    }

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(Color.GRAY)
        setPadding(0, dp(12), 0, dp(2))
    }

    private fun lp(topMargin: Int) = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { this.topMargin = topMargin }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    override fun onResume() {
        super.onResume()
        startScan()   // auto-discover as soon as the screen is shown
    }

    override fun onPause() {
        super.onPause()
        stopScan()
    }

    /** Browse the LAN for the head unit's NSD service and auto-fill the IP when found. */
    private fun startScan() {
        stopScan()
        status.text = "Scanning for a head unit on this Wi-Fi…"
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                if (info.serviceType.contains("mlkheadunit") && !resolving) {
                    resolving = true
                    resolve(info)
                }
            }
            override fun onServiceLost(info: NsdServiceInfo) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                runOnUiThread { status.text = "Scan couldn't start ($errorCode). Type the IP shown on the head unit." }
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
        }
        discoveryListener = l
        runCatching { nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l) }
            .onFailure { status.text = "Scan unavailable. Type the IP shown on the head unit." }
    }

    private fun stopScan() {
        discoveryListener?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        discoveryListener = null
    }

    @Suppress("DEPRECATION")
    private fun resolve(info: NsdServiceInfo) {
        nsd.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) { resolving = false }
            override fun onServiceResolved(resolved: NsdServiceInfo) {
                resolving = false
                val host = resolved.host?.hostAddress ?: return
                runOnUiThread {
                    ipField.setText(host)
                    portField.setText(resolved.port.toString())
                    status.text = "Found “${resolved.serviceName}” at $host:${resolved.port}. Tap Connect."
                }
            }
        })
    }

    private fun onConnect() {
        val ip = ipField.text.toString().trim()
        val port = portField.text.toString().trim().toIntOrNull() ?: DEFAULT_PORT
        if (ip.isEmpty()) {
            Toast.makeText(this, "Enter the head unit's IP", Toast.LENGTH_SHORT).show()
            return
        }
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_IP, ip).putInt(KEY_PORT, port).apply()

        if (!AaTrigger.isAndroidAutoInstalled(this)) {
            status.text = "Android Auto isn't installed on this phone."
            return
        }

        // Hand off to the foreground keep-alive service: it fires the trigger now, holds Wi-Fi/CPU
        // awake, and auto-reconnects (re-fires) whenever the head unit goes idle again after a drop.
        KeepAliveService.start(this, ip, port)
        status.text = "Connecting to $ip:$port and keeping it alive.\n" +
            "If it still drops, tap “battery settings” below and set Android Auto to Unrestricted."
    }

    private fun openAaBatterySettings() {
        val i = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.fromParts("package", AaTrigger.GEARHEAD, null)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try { startActivity(i) } catch (e: Exception) {
            Toast.makeText(this, "Couldn't open Android Auto settings", Toast.LENGTH_SHORT).show()
        }
    }

    @SuppressLint("HardwareIds")
    private fun currentSsid(): String = try {
        @Suppress("DEPRECATION")
        (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .connectionInfo.ssid?.trim('"') ?: ""
    } catch (e: Exception) { "" }

    /** The currently-connected classic Bluetooth device's MAC (to pin the BT auto-start), or "". */
    @SuppressLint("MissingPermission")
    private fun connectedBtMac(): String = try {
        val bm = getSystemService(Context.BLUETOOTH_SERVICE) as android.bluetooth.BluetoothManager
        bm.adapter?.bondedDevices?.firstOrNull { d ->
            runCatching { d.javaClass.getMethod("isConnected").invoke(d) as? Boolean }.getOrNull() == true
        }?.address ?: ""
    } catch (e: Exception) { "" }

    /** Ask to exempt THIS helper (not Android Auto) from battery optimization, so its auto-start
     *  receiver + keep-alive service survive in the background. */
    private fun requestSelfBatteryExemption() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val pm = getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        @SuppressLint("BatteryLife")
        val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        runCatching { startActivity(i) }
    }

    companion object {
        private const val PREFS = "aahelper"
        private const val KEY_IP = "ip"
        private const val KEY_PORT = "port"
        private const val DEFAULT_PORT = 5288
        private const val SERVICE_TYPE = "_mlkheadunit._tcp."
    }
}
