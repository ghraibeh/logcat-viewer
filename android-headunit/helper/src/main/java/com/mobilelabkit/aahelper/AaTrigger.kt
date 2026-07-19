package com.mobilelabkit.aahelper

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Parcelable

/**
 * Fires Google's hidden "wireless startup" trigger so stock Android Auto TCP-connects to a head
 * unit's [host]:[port] over the shared Wi-Fi. Tries the Activity (older AA) then the broadcast
 * (AA 16.4+), attaching the active Network + WifiInfo extras like headunit-revived does.
 *
 * Shared by the UI ([MainActivity]) and the keep-alive service ([KeepAliveService]).
 */
object AaTrigger {

    const val GEARHEAD = "com.google.android.projection.gearhead"
    private const val WIRELESS = "com.google.android.apps.auto.wireless"

    fun isAndroidAutoInstalled(ctx: Context): Boolean = try {
        ctx.packageManager.getPackageInfo(GEARHEAD, 0); true
    } catch (e: Exception) { false }

    /** @return a short human string describing which path fired (or the failure). */
    fun fire(ctx: Context, host: String, port: Int): String {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network: Parcelable? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) cm.activeNetwork else null

        @Suppress("DEPRECATION")
        val wifiInfo: Parcelable? = try {
            (ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager).connectionInfo
        } catch (e: Exception) { null }

        // 1) Activity path (may be non-exported on this AA build -> SecurityException -> fall back).
        val activityIntent = Intent().apply {
            setClassName(GEARHEAD, "$WIRELESS.setup.service.impl.WirelessStartupActivity")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra("PARAM_HOST_ADDRESS", host)
            putExtra("PARAM_SERVICE_PORT", port)
            network?.let { putExtra("PARAM_SERVICE_WIFI_NETWORK", it) }
            wifiInfo?.let { putExtra("wifi_info", it) }
        }
        try {
            ctx.startActivity(activityIntent)
            return "startup activity"
        } catch (e: Exception) {
            // 2) Broadcast fallback — the path proven to work on modern AA.
            val bcast = Intent().apply {
                setClassName(GEARHEAD, "$WIRELESS.setup.receiver.WirelessStartupReceiver")
                action = "$WIRELESS.setup.receiver.wirelessstartup.START"
                putExtra("ip_address", host)
                putExtra("projection_port", port)
                network?.let { putExtra("PARAM_SERVICE_WIFI_NETWORK", it) }
                wifiInfo?.let { putExtra("wifi_info", it) }
                addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
            }
            return try {
                ctx.sendBroadcast(bcast); "startup broadcast"
            } catch (e2: Exception) {
                "failed: ${e2.message}"
            }
        }
    }
}
