package com.mobilelabkit.aahelper

import android.annotation.SuppressLint
import androidx.activity.ComponentActivity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/**
 * "AA Wireless Helper" — runs on the **source phone** (the one with Android Auto).
 *
 * Stock Android Auto has no way to be triggered from the head-unit side: something on the
 * phone has to tell it "connect to this head unit's IP:port". This app is a front end for that
 * trigger (see [AaTrigger]) — the same role as headunit-revived's "Wireless Helper".
 *
 * Two connection modes, chosen **explicitly** (not inferred from a leftover text field):
 *  - **Same Wi-Fi** (default): head unit + phone share a router/hotspot; the IP is auto-found
 *    over mDNS (Scan). This is what most setups should use.
 *  - **Host-Wi-Fi**: the head unit hosts its own Wi-Fi and the phone joins it — only for when
 *    there's no usable shared network. Scan the head unit's QR to fill the Wi-Fi name/password/IP.
 */
class MainActivity : ComponentActivity() {

    private lateinit var prefs: android.content.SharedPreferences
    private lateinit var ipField: EditText
    private lateinit var portField: EditText
    private lateinit var ssidField: EditText
    private lateinit var passField: EditText
    private lateinit var status: TextView
    private lateinit var subtitle: TextView
    private lateinit var sharedGroup: LinearLayout
    private lateinit var hostGroup: LinearLayout
    private lateinit var modeGroup: RadioGroup

    private val nsd by lazy { getSystemService(Context.NSD_SERVICE) as NsdManager }
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var resolving = false

    private val isHostMode: Boolean get() = modeGroup.checkedRadioButtonId == ID_MODE_HOST

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(28), dp(24), dp(24))
        }

        root.addView(TextView(this).apply {
            text = "AA Wireless Helper"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
            setTextColor(Color.BLACK)
        })
        subtitle = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(Color.DKGRAY)
            setPadding(0, dp(6), 0, dp(16))
        }
        root.addView(subtitle)

        // --- Connection mode (explicit; persisted) --------------------------------
        root.addView(header("Connection mode"))
        modeGroup = RadioGroup(this).apply { orientation = RadioGroup.VERTICAL }
        modeGroup.addView(RadioButton(this).apply {
            id = ID_MODE_SHARED; text = "Same Wi-Fi network  (recommended)"
        })
        modeGroup.addView(RadioButton(this).apply {
            id = ID_MODE_HOST; text = "Head unit’s own Wi-Fi  (Host-Wi-Fi)"
        })
        root.addView(modeGroup)

        // --- Same-Wi-Fi section ---------------------------------------------------
        sharedGroup = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        sharedGroup.addView(hint("The head unit and this phone are on the same router/hotspot. " +
            "Scan finds it automatically — no typing."))
        sharedGroup.addView(Button(this).apply {
            text = "Scan for head unit"; setOnClickListener { startScan() }
        })
        root.addView(sharedGroup)

        // --- Host-Wi-Fi section ---------------------------------------------------
        hostGroup = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; visibility = View.GONE
        }
        hostGroup.addView(hint("The head unit hosts its own Wi-Fi and this phone joins it — only " +
            "when there’s no shared network. Scan its QR to fill everything below."))
        hostGroup.addView(Button(this).apply {
            text = "Scan QR from head unit"; setOnClickListener { startQrScan() }
        })
        hostGroup.addView(label("Head unit’s Wi-Fi name"))
        ssidField = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            hint = "e.g. AndroidShare_1234"
            setText(prefs.getString(KEY_SOFTAP_SSID, ""))
        }
        hostGroup.addView(ssidField)
        hostGroup.addView(label("Head unit’s Wi-Fi password"))
        passField = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            hint = "shown on the head unit"
            setText(prefs.getString(KEY_SOFTAP_PASS, ""))
        }
        hostGroup.addView(passField)
        root.addView(hostGroup)

        // --- Head unit address (both modes; auto-filled by Scan/QR) ---------------
        root.addView(label("Head unit IP"))
        ipField = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_TEXT
            hint = "e.g. 192.168.5.63 (auto-filled)"
            setText(prefs.getString(KEY_IP, ""))
        }
        root.addView(ipField)
        root.addView(label("Port"))
        portField = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            setText(prefs.getInt(KEY_PORT, DEFAULT_PORT).toString())
        }
        root.addView(portField)

        root.addView(Button(this).apply {
            text = "Connect & keep alive"
            setOnClickListener { onConnect() }
        }, lp(dp(16)))
        root.addView(Button(this).apply {
            text = "Stop keeping alive"
            setOnClickListener {
                KeepAliveService.stop(this@MainActivity)
                status.text = "Stopped. Android Auto will disconnect on its own."
            }
        }, lp(dp(8)))

        status = TextView(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTextColor(Color.DKGRAY)
            setPadding(0, dp(14), 0, 0)
        }
        root.addView(status)

        // Samsung/OEM battery managers freeze Android Auto's projection process and kill the
        // session. Open AA's app info so the user can set battery usage to "Unrestricted" once.
        root.addView(Button(this).apply {
            text = "Keep Android Auto awake (battery settings)"
            setOnClickListener { openAaBatterySettings() }
        }, lp(dp(28)))

        // --- Auto-start (hands-free) ----------------------------------------------
        root.addView(header("Auto-start (hands-free)"))
        addAutoStartControls(root)

        // Mode switch handling: reveal the right section, refresh copy, persist.
        modeGroup.setOnCheckedChangeListener { _, _ -> applyMode() }
        modeGroup.check(if (prefs.getString(KEY_MODE, MODE_SHARED) == MODE_HOST) ID_MODE_HOST else ID_MODE_SHARED)
        applyMode()

        setContentView(ScrollView(this).apply { addView(root) })

        requestStartupPermissions()
    }

    private fun addAutoStartControls(root: LinearLayout) {
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
        root.addView(wifiAuto, lp(dp(8)))

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
    }

    /** Reflect the selected mode: show only the relevant section, update the subtitle, persist. */
    private fun applyMode() {
        val host = isHostMode
        sharedGroup.visibility = if (host) View.GONE else View.VISIBLE
        hostGroup.visibility = if (host) View.VISIBLE else View.GONE
        subtitle.text = if (host)
            "Open the head-unit app, turn on its “Host Wi-Fi”, then scan its QR here and Connect."
        else
            "Open the head-unit app on the same Wi-Fi. It’s found automatically — just Connect."
        prefs.edit().putString(KEY_MODE, if (host) MODE_HOST else MODE_SHARED).apply()
        // Auto-discovery only makes sense on a shared network (in Host-Wi-Fi we haven't joined yet).
        if (!host) startScan() else stopScan()
    }

    // --- small view helpers ----------------------------------------------------
    private fun header(text: String) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        setTextColor(Color.parseColor("#1A73E8"))
        setPadding(0, dp(22), 0, dp(6))
        setTypeface(typeface, android.graphics.Typeface.BOLD)
    }

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(Color.GRAY)
        setPadding(0, dp(12), 0, dp(2))
    }

    private fun hint(text: String) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
        setTextColor(Color.DKGRAY)
        setPadding(0, dp(2), 0, dp(8))
    }

    private fun lp(topMargin: Int) = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { this.topMargin = topMargin }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    override fun onResume() {
        super.onResume()
        if (!isHostMode) startScan()   // auto-discover on a shared network
    }

    override fun onPause() {
        super.onPause()
        stopScan()
    }

    // --- NSD auto-discovery (shared-network mode) -----------------------------
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
                    if (isHostMode) return@runOnUiThread   // don't clobber a QR-filled address
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
            Toast.makeText(this, "No head unit IP yet — tap Scan (or scan the QR), or type it.", Toast.LENGTH_SHORT).show()
            return
        }
        if (!AaTrigger.isAndroidAutoInstalled(this)) {
            status.text = "Android Auto isn't installed on this phone."
            return
        }

        val edit = prefs.edit().putString(KEY_IP, ip).putInt(KEY_PORT, port)

        if (isHostMode) {
            val ssid = ssidField.text.toString().trim()
            val pass = passField.text.toString()
            if (ssid.isEmpty()) {
                Toast.makeText(this, "Enter the head unit's Wi-Fi name, or scan its QR.", Toast.LENGTH_LONG).show()
                return
            }
            edit.putString(KEY_SOFTAP_SSID, ssid).putString(KEY_SOFTAP_PASS, pass).apply()
            KeepAliveService.startSoftAp(this, ssid, pass, ip, port)
            status.text = "Joining “$ssid” and connecting to $ip:$port (Host-Wi-Fi mode).\n" +
                "Allow the “connect to this device’s Wi-Fi?” prompt if it appears."
        } else {
            edit.apply()
            // Shared network: ignore any leftover SoftAP creds — this is the whole point of an
            // explicit mode. gearhead connects over the loopback proxy (see AaTrigger/AapProxy).
            // Preflight the reachability first: if the head unit isn't on this Wi-Fi, firing
            // gearhead just makes "connecting to vehicle" flash and die, with no clue why.
            preflightThenStart(ip, port)
        }
    }

    /** Confirm the head unit is actually reachable on the phone's current Wi-Fi before triggering
     *  Android Auto. A TCP connect that fails almost always means the head unit is on a different
     *  network (e.g. its “Host Wi-Fi” is on, so it never joined the router) — say so plainly. */
    private fun preflightThenStart(ip: String, port: Int) {
        status.text = "Checking the head unit is reachable on “${currentSsid().ifEmpty { "Wi-Fi" }}”…"
        Thread {
            val reachable = runCatching {
                java.net.Socket().use { it.connect(java.net.InetSocketAddress(ip, port), PREFLIGHT_MS); true }
            }.getOrDefault(false)
            runOnUiThread {
                if (reachable) {
                    KeepAliveService.start(this, ip, port)
                    status.text = "Connecting to $ip:$port and keeping it alive.\n" +
                        "If it still drops, tap “battery settings” below and set Android Auto to Unrestricted."
                } else {
                    val ssid = currentSsid().ifEmpty { "your Wi-Fi" }
                    status.text = "Can’t reach the head unit at $ip:$port on “$ssid”.\n\n" +
                        "The head unit isn’t on this network. Either:\n" +
                        "•  turn OFF “Host this head unit’s own Wi-Fi” on the head unit and join it to “$ssid”, then Scan again; or\n" +
                        "•  switch to Host-Wi-Fi mode above and scan the head unit’s QR."
                }
            }
        }.start()
    }

    // --- QR scan (Host-Wi-Fi join) --------------------------------------------
    /** Launch the (portrait) camera QR scanner for the head unit's join code. */
    private fun startQrScan() {
        if (checkSelfPermission(android.Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.CAMERA), REQ_CAMERA)
            return
        }
        val opts = com.journeyapps.barcodescanner.ScanOptions().apply {
            setDesiredBarcodeFormats(com.journeyapps.barcodescanner.ScanOptions.QR_CODE)
            setPrompt("Point at the head unit’s QR")
            setBeepEnabled(false)
            setOrientationLocked(true)
            captureActivity = PortraitCaptureActivity::class.java
        }
        qrLauncher.launch(opts)
    }

    private val qrLauncher = registerForActivityResult(com.journeyapps.barcodescanner.ScanContract()) { result ->
        val contents = result.contents ?: return@registerForActivityResult
        if (!applyJoinUri(contents)) {
            Toast.makeText(this, "That QR isn’t a head-unit join code.", Toast.LENGTH_LONG).show()
        }
    }

    /** Parse `mlkhu://join?ip=..&port=..[&ssid=..&pass=..]`. `ssid` present ⇒ Host-Wi-Fi join code
     *  (join that network first); absent ⇒ the head unit is already on this shared network — just
     *  connect straight to ip:port. */
    private fun applyJoinUri(text: String): Boolean {
        val uri = runCatching { Uri.parse(text.trim()) }.getOrNull() ?: return false
        if (uri.scheme != "mlkhu" || uri.host != "join") return false
        val ip = uri.getQueryParameter("ip") ?: return false
        val ssid = uri.getQueryParameter("ssid")
        val port = uri.getQueryParameter("port")?.toIntOrNull() ?: DEFAULT_PORT
        ipField.setText(ip); portField.setText(port.toString())
        if (ssid != null) {
            val pass = uri.getQueryParameter("pass") ?: ""
            modeGroup.check(ID_MODE_HOST)
            ssidField.setText(ssid); passField.setText(pass)
            Toast.makeText(this, "Scanned “$ssid” — connecting…", Toast.LENGTH_SHORT).show()
        } else {
            modeGroup.check(ID_MODE_SHARED)
            Toast.makeText(this, "Scanned head unit at $ip:$port — connecting…", Toast.LENGTH_SHORT).show()
        }
        onConnect()
        return true
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CAMERA && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startQrScan()
    }

    private fun requestStartupPermissions() {
        // FINE_LOCATION: non-redacted WifiInfo on Android 10+. POST_NOTIFICATIONS (13+): so the
        // keep-alive foreground-service notification is visible.
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
        private const val KEY_SOFTAP_SSID = "softap_ssid"
        private const val KEY_SOFTAP_PASS = "softap_pass"
        private const val KEY_MODE = "conn_mode"
        private const val MODE_SHARED = "shared"
        private const val MODE_HOST = "host"
        private const val ID_MODE_SHARED = 1
        private const val ID_MODE_HOST = 2
        private const val REQ_CAMERA = 7
        private const val DEFAULT_PORT = 5288
        private const val PREFLIGHT_MS = 2500
        private const val SERVICE_TYPE = "_mlkheadunit._tcp."
    }
}
