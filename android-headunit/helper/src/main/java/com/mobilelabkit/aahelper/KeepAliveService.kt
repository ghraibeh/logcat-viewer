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
import android.os.IBinder
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
    private var wakeLock: PowerManager.WakeLock? = null
    private val nsd by lazy { getSystemService(Context.NSD_SERVICE) as NsdManager }
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var resolving = false
    private var lastFireMs = 0L
    private var host: String? = null
    private var port = 5288

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopSelf(); return START_NOT_STICKY }

        intent?.getStringExtra(EXTRA_IP)?.let { host = it }
        port = intent?.getIntExtra(EXTRA_PORT, port) ?: port

        startForegroundCompat()
        acquireLocks()

        // Fire once immediately using the known IP, then let NSD drive reconnects.
        host?.let { fire(it, port, "initial") }
        startNsd()
        return START_STICKY
    }

    private fun fire(h: String, p: Int, why: String) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastFireMs < RECONNECT_DEBOUNCE_MS) return  // don't spam
        lastFireMs = now
        val how = AaTrigger.fire(this, h, p)
        Log.i(TAG, "trigger fired ($why) -> $h:$p [$how]")
        notify("Connecting to $h:$p…")
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
            override fun onServiceLost(info: NsdServiceInfo) {}   // head unit went busy (connected)
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
                host = h; port = resolved.port
                // Head unit is advertising => it is idle. Re-fire to (re)connect.
                fire(h, resolved.port, "nsd-idle")
            }
        })
    }

    // --- locks ----------------------------------------------------------------
    private fun acquireLocks() {
        if (wifiLock == null) {
            val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "$TAG:wifi")
                .also { runCatching { it.acquire() } }
        }
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$TAG:cpu")
                .also { runCatching { it.acquire() } }
        }
    }

    private fun releaseLocks() {
        wifiLock?.let { runCatching { if (it.isHeld) it.release() } }; wifiLock = null
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
        stopNsd()
        releaseLocks()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
    }

    companion object {
        private const val TAG = "aahelper-keepalive"
        private const val CHANNEL = "keepalive"
        private const val NOTIF_ID = 42
        private const val SERVICE_TYPE = "_mlkheadunit._tcp."
        private const val RECONNECT_DEBOUNCE_MS = 6000L
        const val EXTRA_IP = "ip"
        const val EXTRA_PORT = "port"
        const val ACTION_STOP = "com.mobilelabkit.aahelper.STOP"

        fun start(ctx: Context, ip: String, port: Int) {
            val i = Intent(ctx, KeepAliveService::class.java).apply {
                putExtra(EXTRA_IP, ip); putExtra(EXTRA_PORT, port)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, KeepAliveService::class.java).apply { action = ACTION_STOP })
        }
    }
}
