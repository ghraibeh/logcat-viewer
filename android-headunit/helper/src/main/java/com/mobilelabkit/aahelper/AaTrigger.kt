package com.mobilelabkit.aahelper

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.util.Log

/**
 * Fires Google's hidden "wireless startup" trigger so stock Android Auto connects to a head unit.
 *
 * The key move (see [AapProxy]): we do NOT hand gearhead the head unit's real IP and hope it picks
 * the right network. We stand up a loopback [AapProxy] bound to the correct Wi-Fi, then trigger AA
 * at **127.0.0.1:<proxyPort>**. gearhead only ever talks to loopback (reachable on any network),
 * and the proxy relays to the head unit over the network WE bound — so the hotspot / no-internet /
 * cellular-default cases that used to wedge at "version request" just work.
 *
 * Shared by the UI ([MainActivity]) and the keep-alive service ([KeepAliveService]).
 */
object AaTrigger {

    const val GEARHEAD = "com.google.android.projection.gearhead"
    const val WIRELESS = "com.google.android.apps.auto.wireless"
    private const val TAG = "aahelper-trigger"

    fun isAndroidAutoInstalled(ctx: Context): Boolean = try {
        ctx.packageManager.getPackageInfo(GEARHEAD, 0); true
    } catch (e: Exception) { false }

    /**
     * Start a proxy to [host]:[port] and trigger Android Auto at it via loopback.
     *
     * @param boundNetwork the exact Wi-Fi network to reach the head unit over — the SoftAP path
     * passes the network it joined + is holding. When null we pick the current Wi-Fi network.
     * @return the running [AapProxy] (caller owns it: stop the old one before firing again, and on
     * teardown), or null if the proxy couldn't start / AA isn't installed.
     */
    fun fire(
        ctx: Context,
        host: String,
        port: Int,
        boundNetwork: Network? = null,
        onConnected: () -> Unit = {},
        onDisconnected: () -> Unit = {},
    ): AapProxy? {
        if (!isAndroidAutoInstalled(ctx)) { Log.w(TAG, "Android Auto not installed"); return null }

        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = boundNetwork ?: currentWifiNetwork(cm)
        Log.i(TAG, "firing at $host:$port over " + (network?.toString() ?: "default network"))

        val proxy = AapProxy(host, port, network, onConnected, onDisconnected)
        val localPort = proxy.start()
        if (localPort < 0) { Log.e(TAG, "proxy failed to start"); return null }

        // gearhead is triggered at loopback, NOT the head unit's IP.
        val gearhead = Intent().apply {
            setClassName(GEARHEAD, "$WIRELESS.setup.service.impl.WirelessStartupActivity")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("PARAM_HOST_ADDRESS", LOOPBACK)
            putExtra("PARAM_SERVICE_PORT", localPort)
            // Receiver-path aliases (broadcast fallback reads these).
            putExtra("ip_address", LOOPBACK)
            putExtra("projection_port", localPort)
            network?.let { putExtra("PARAM_SERVICE_WIFI_NETWORK", it) }
        }

        // Route the launch through a transparent foreground activity so it survives Android 12+/14+
        // Background-Activity-Launch restrictions when fired from the keep-alive service.
        val trigger = Intent(ctx, TransparentTriggerActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
            putExtra(TransparentTriggerActivity.EXTRA_INTENT, gearhead)
        }
        runCatching { ctx.startActivity(trigger) }
            .onFailure { Log.w(TAG, "couldn't start trigger activity: ${it.message}") }
        return proxy
    }

    /** The current Wi-Fi [Network]: prefer the active network if it's Wi-Fi, else the first Wi-Fi
     *  transport we can find. Null when the phone has no Wi-Fi network (e.g. it hosts the hotspot). */
    private fun currentWifiNetwork(cm: ConnectivityManager): Network? {
        val active = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) cm.activeNetwork else null
        if (active != null && cm.getNetworkCapabilities(active)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true) {
            return active
        }
        @Suppress("DEPRECATION")
        return cm.allNetworks.firstOrNull {
            cm.getNetworkCapabilities(it)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        }
    }

    private const val LOOPBACK = "127.0.0.1"
}
