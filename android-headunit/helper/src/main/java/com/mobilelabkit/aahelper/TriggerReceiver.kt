package com.mobilelabkit.aahelper

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.NetworkInfo
import android.net.wifi.WifiManager
import android.util.Log

/**
 * Auto-start the keep-alive service (and thus wireless Android Auto) when the phone reaches the
 * head unit — hands-free, no tapping Connect. Two triggers, matching the official Wireless Helper:
 *
 *  - **Bluetooth**: a chosen device connects (`ACTION_ACL_CONNECTED`) → the "I'm in the car" signal.
 *  - **Wi-Fi**: the phone joins the configured SSID (`NETWORK_STATE_CHANGED_ACTION`).
 *
 * Bluetooth is only the *signal* here — the Android Auto data still flows over Wi-Fi. Both are
 * gated by prefs so nothing fires unless the user turned the option on. The service discovers the
 * head unit's IP via NSD, so we don't need to know it here.
 */
class TriggerReceiver : BroadcastReceiver() {

    override fun onReceive(ctx: Context, intent: Intent) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        when (intent.action) {
            BluetoothDevice.ACTION_ACL_CONNECTED -> {
                if (!prefs.getBoolean(KEY_BT, false)) return
                val dev = deviceOf(intent)
                val target = prefs.getString(KEY_BT_MAC, "") ?: ""
                if (target.isEmpty() || dev?.address == target) {
                    Log.i(TAG, "Bluetooth connected (${dev?.address}) — auto-starting")
                    startService(ctx)
                }
            }
            WifiManager.NETWORK_STATE_CHANGED_ACTION -> {
                if (!prefs.getBoolean(KEY_WIFI, false)) return
                @Suppress("DEPRECATION")
                val info = intent.getParcelableExtra<NetworkInfo>(WifiManager.EXTRA_NETWORK_INFO)
                if (info?.isConnected != true) return
                val want = prefs.getString(KEY_WIFI_SSID, "") ?: ""
                val cur = currentSsid(ctx)
                if (want.isNotEmpty() && cur.equals(want, ignoreCase = true)) {
                    Log.i(TAG, "Joined Wi-Fi '$cur' — auto-starting")
                    startService(ctx)
                }
            }
        }
    }

    private fun startService(ctx: Context) {
        if (KeepAliveService.isRunning) return
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val ip = prefs.getString(KEY_IP, "") ?: ""
        val port = prefs.getInt(KEY_PORT, 5288)
        if (ip.isNotEmpty()) KeepAliveService.start(ctx, ip, port) else KeepAliveService.startAuto(ctx)
    }

    @Suppress("DEPRECATION")
    private fun deviceOf(intent: Intent): BluetoothDevice? =
        intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)

    @SuppressLint("HardwareIds")
    private fun currentSsid(ctx: Context): String = try {
        @Suppress("DEPRECATION")
        (ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .connectionInfo.ssid?.trim('"') ?: ""
    } catch (e: Exception) { "" }

    companion object {
        private const val TAG = "aahelper-trigger"
        const val PREFS = "aahelper"
        const val KEY_IP = "ip"
        const val KEY_PORT = "port"
        const val KEY_BT = "autostart_bt"
        const val KEY_BT_MAC = "autostart_bt_mac"
        const val KEY_WIFI = "autostart_wifi"
        const val KEY_WIFI_SSID = "autostart_wifi_ssid"
    }
}
