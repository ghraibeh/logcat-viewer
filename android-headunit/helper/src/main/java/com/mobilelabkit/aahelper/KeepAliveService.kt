package com.mobilelabkit.aahelper

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log

/**
 * Keeps a wireless Android Auto session alive and **self-healing**.
 *
 * Android Auto's projection process gets frozen by OEM battery managers and Wi-Fi power-save after
 * a while — no app can fully prevent it (headunit-revived doesn't either). So we do what it does:
 *
 *  - **Foreground service** (type connectedDevice) + **WifiLock** (HIGH_PERF) + **WakeLock**
 *    (partial) to keep this phone awake so it can't freeze Android Auto in the first place.
 *  - **Auto-reconnect**: the head unit advertises over NSD *only while idle* (it un-advertises the
 *    moment a session starts). So whenever we (re)discover it, that means "idle — needs a trigger",
 *    and we re-fire [AaTrigger]. While a session is live the head unit is invisible, so we sit quiet.
 */
class KeepAliveService : Service() {

    private var wifiLock: WifiManager.WifiLock? = null
    private var multicastLock: WifiManager.MulticastLock? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    // The loopback proxy that Android Auto actually connects to (127.0.0.1). One at a time — a
    // re-fire stops the old one first. See [AapProxy] / [AaTrigger.fire].
    private var proxy: AapProxy? = null
    private val nsd by lazy { getSystemService(Context.NSD_SERVICE) as NsdManager }
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var resolving = false
    private var lastFireMs = 0L
    // Auto-reconnect gate: only re-fire after the head unit actually disappeared (session started
    // or it dropped) and came back — never while it stays advertising, which would churn a live session.
    @Volatile private var sawLost = true
    private var host: String? = null
    private var port = 5288
    // SoftAP mode: when the head unit hosts its own Wi-Fi, we join + HOLD it and project over that
    // bound network instead of a shared LAN. Null SSID = normal shared-network mode (unchanged).
    private var softApSsid: String? = null
    private var softApPass: String? = null
    private var softApJoiner: SoftApJoiner? = null
    @Volatile private var boundNetwork: android.net.Network? = null
    // Several head units can advertise _mlkheadunit._tcp on the same LAN (another phone, the Mac
    // app…). Once we resolve the one matching the configured IP, lock onto its service NAME and
    // only auto-refire at that unit — the name survives IP changes, and every other advertiser is
    // ignored instead of getting a trigger and fighting over Android Auto.
    private var lockedName: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopSelf(); return START_NOT_STICKY }

        intent?.getStringExtra(EXTRA_IP)?.let { host = it }
        port = intent?.getIntExtra(EXTRA_PORT, port) ?: port
        intent?.getStringExtra(EXTRA_SOFTAP_SSID)?.let { if (it.isNotBlank()) softApSsid = it }
        intent?.getStringExtra(EXTRA_SOFTAP_PASS)?.let { softApPass = it }

        isRunning = true
        startForegroundCompat()
        acquireLocks()

        val ssid = softApSsid
        if (ssid != null) {
            // SoftAP mode: join + HOLD the head unit's own Wi-Fi, then project over that network.
            // The head unit is always at its AP gateway; NSD isn't needed to find it, and re-firing
            // is driven by the hold callback (onLost → rejoin) rather than mDNS.
            notify("Joining “$ssid”…")
            val joiner = SoftApJoiner(this).also { softApJoiner = it }
            joiner.start(ssid, softApPass,
                onJoined = { network ->
                    boundNetwork = network
                    host?.let { fire(it, port, "softap-joined") }
                },
                onFailed = { reason -> Log.w(TAG, "softap join failed: $reason"); notify(reason) }
            )
        } else {
            // Shared-network mode (unchanged): fire immediately on the known IP, NSD drives reconnects.
            host?.let { fire(it, port, "initial") }
            startNsd()
        }
        return START_STICKY
    }

    private fun fire(h: String, p: Int, why: String) {
        val now = SystemClock.elapsedRealtime()
        // A re-fire (auto-reconnect) is only legitimate after the head unit actually went away and
        // came back — a real drop. If it just keeps advertising (or its un-advertise is flaky), a
        // re-fire would restart a LIVE session and cause the connect/disconnect churn. The initial
        // fire is always allowed.
        if (why == "nsd-idle" && !sawLost) return
        // The debounce guards only AUTOMATIC re-fires (nsd/proxy-drop) from churning a live session.
        // A user tapping Connect ("initial") must always tear down the old proxy and fire fresh.
        if (why != "initial" && now - lastFireMs < RECONNECT_DEBOUNCE_MS) return
        sawLost = false
        lastFireMs = now
        // A fresh proxy per fire (new loopback port). Tear the previous one down so a stalled
        // gearhead attempt on the old port can't linger.
        proxy?.stop()
        proxy = AaTrigger.fire(
            this, h, p, boundNetwork,
            onConnected = { handler.post { if (isRunning) notify("Connected — Android Auto is projecting.") } },
            onDisconnected = { handler.post { onSessionDropped(h, p) } },
        )
        Log.i(TAG, "trigger fired ($why) -> $h:$p [proxy:${proxy?.localPort ?: -1}]")
        notify("Connecting to $h:$p…")
    }

    /** The AA session's TCP link to the head unit closed. Re-arm reconnect. In shared-network mode
     *  NSD re-discovery drives the next fire (the head unit re-advertises when it goes idle); in
     *  SoftAP mode there's no NSD, so schedule the re-fire ourselves over the held network. */
    private fun onSessionDropped(h: String, p: Int) {
        if (!isRunning) return
        sawLost = true
        notify("Disconnected — waiting to reconnect…")
        if (softApSsid != null) {
            handler.postDelayed({ if (isRunning && boundNetwork != null) fire(h, p, "proxy-drop") }, SOFTAP_REFIRE_MS)
        }
    }

    // --- NSD auto-discovery / reconnect ---------------------------------------
    private fun startNsd() {
        stopNsd()
        val l = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(t: String) {}
            override fun onServiceFound(info: NsdServiceInfo) {
                if (info.serviceType.contains("mlkheadunit") && !resolving) {
                    resolving = true
                    resolve(info)
                }
            }
            override fun onServiceLost(info: NsdServiceInfo) {
                // Head unit went busy (a session started) or dropped off — arm the next re-fire.
                if (info.serviceType.contains("mlkheadunit")) sawLost = true
            }
            override fun onDiscoveryStopped(t: String) {}
            override fun onStartDiscoveryFailed(t: String, code: Int) {}
            override fun onStopDiscoveryFailed(t: String, code: Int) {}
        }
        discoveryListener = l
        runCatching { nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l) }
    }

    private fun stopNsd() {
        discoveryListener?.let { runCatching { nsd.stopServiceDiscovery(it) } }
        discoveryListener = null
    }

    @Suppress("DEPRECATION")
    private fun resolve(info: NsdServiceInfo) {
        nsd.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(i: NsdServiceInfo, code: Int) { resolving = false }
            override fun onServiceResolved(resolved: NsdServiceInfo) {
                resolving = false
                val h = resolved.host?.hostAddress ?: return
                // Ignore advertisers that aren't the head unit we're keeping alive: if we've locked
                // onto a name, only that one counts; before locking, only the configured IP does.
                val locked = lockedName
                if (locked != null) {
                    if (resolved.serviceName != locked) return
                } else if (host != null && h != host) {
                    return
                }
                lockedName = resolved.serviceName
                host = h; port = resolved.port
                // Head unit is advertising => it is idle. Re-fire to (re)connect.
                fire(h, resolved.port, "nsd-idle")
            }
        })
    }

    // --- locks ----------------------------------------------------------------
    private fun acquireLocks() {
        val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        if (wifiLock == null) {
            // WIFI_MODE_FULL_HIGH_PERF is deprecated + a no-op on Android 10+, so it never actually
            // stopped power-save. LOW_LATENCY (API 29+) does, keeping round-trips low enough that
            // Android Auto's wireless handshake doesn't time out.
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = wm.createWifiLock(mode, "$TAG:wifi").also { runCatching { it.acquire() } }
        }
        // NSD/mDNS discovery for auto-reconnect uses multicast, which Android filters out when the
        // screen is off unless a MulticastLock is held — exactly the idle "after a while" case.
        // (The official Wireless Helper holds this too.)
        if (multicastLock == null) {
            multicastLock = wm.createMulticastLock("$TAG:mcast")
                .also { it.setReferenceCounted(false); runCatching { it.acquire() } }
        }
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$TAG:cpu")
                .also { runCatching { it.acquire() } }
        }
    }

    private fun releaseLocks() {
        wifiLock?.let { runCatching { if (it.isHeld) it.release() } }; wifiLock = null
        multicastLock?.let { runCatching { if (it.isHeld) it.release() } }; multicastLock = null
        wakeLock?.let { runCatching { if (it.isHeld) it.release() } }; wakeLock = null
    }

    // --- foreground notification ----------------------------------------------
    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(CHANNEL, "Wireless link", NotificationManager.IMPORTANCE_LOW)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
        }
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        )
        val stop = PendingIntent.getService(
            this, 1, Intent(this, KeepAliveService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        )
        val b = Notification.Builder(this, CHANNEL)
            .setContentTitle("AA Wireless Helper")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
        return b.build()
    }

    private fun startForegroundCompat() {
        val n = buildNotification("Keeping Android Auto connected…")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    private fun notify(text: String) {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, buildNotification(text))
    }

    override fun onDestroy() {
        super.onDestroy()
        isRunning = false
        handler.removeCallbacksAndMessages(null)
        stopNsd()
        proxy?.stop(); proxy = null
        softApJoiner?.stop(); softApJoiner = null; boundNetwork = null
        releaseLocks()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
    }

    companion object {
        @Volatile var isRunning = false
            private set
        private const val TAG = "aahelper-keepalive"
        private const val CHANNEL = "keepalive"
        private const val NOTIF_ID = 42
        private const val SERVICE_TYPE = "_mlkheadunit._tcp."
        private const val RECONNECT_DEBOUNCE_MS = 20000L
        private const val SOFTAP_REFIRE_MS = 3000L
        const val EXTRA_IP = "ip"
        const val EXTRA_PORT = "port"
        const val EXTRA_SOFTAP_SSID = "softap_ssid"
        const val EXTRA_SOFTAP_PASS = "softap_pass"
        const val ACTION_STOP = "com.mobilelabkit.aahelper.STOP"

        /** Shared-network mode: connect to a head unit already reachable at [ip]:[port]. */
        fun start(ctx: Context, ip: String, port: Int) {
            val i = Intent(ctx, KeepAliveService::class.java).apply {
                putExtra(EXTRA_IP, ip); putExtra(EXTRA_PORT, port)
            }
            launch(ctx, i)
        }

        /** SoftAP mode: join + hold the head unit's own Wi-Fi ([ssid]/[pass]), then project to
         *  [ip]:[port] (its AP gateway, e.g. 192.168.43.1). No router/hotspot needed. */
        fun startSoftAp(ctx: Context, ssid: String, pass: String?, ip: String, port: Int) {
            val i = Intent(ctx, KeepAliveService::class.java).apply {
                putExtra(EXTRA_IP, ip); putExtra(EXTRA_PORT, port)
                putExtra(EXTRA_SOFTAP_SSID, ssid); putExtra(EXTRA_SOFTAP_PASS, pass)
            }
            launch(ctx, i)
        }

        /** Start with no known IP — the service relies on NSD discovery to find the head unit and
         *  fire. Used by auto-start (Wi-Fi/Bluetooth) where we may not know the IP up front. */
        fun startAuto(ctx: Context) = launch(ctx, Intent(ctx, KeepAliveService::class.java))

        private fun launch(ctx: Context, i: Intent) {
            // Started from a background receiver (BT/Wi-Fi) we're on a short temp-allowlist; guard
            // against the Android 12+ ForegroundServiceStartNotAllowedException just in case.
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
                else ctx.startService(i)
            }.onFailure { Log.w(TAG, "start blocked: ${it.message}") }
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, KeepAliveService::class.java).apply { action = ACTION_STOP })
        }
    }
}
