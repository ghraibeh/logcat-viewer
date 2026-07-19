package com.mobilelabkit.headunit

import android.annotation.SuppressLint
import android.content.Context
import android.net.wifi.p2p.WifiP2pGroup
import android.net.wifi.p2p.WifiP2pManager
import android.util.Log

/**
 * Creates a **Wi-Fi Direct** group that the head unit owns, so it knows the SSID + passphrase to
 * hand the phone during the Bluetooth bootstrap. The phone joins this group and TCP-connects to the
 * group-owner IP (fixed 192.168.49.1) on port 5288, where the AA protocol runs.
 *
 * Needs CHANGE_WIFI_STATE + ACCESS_FINE_LOCATION (or NEARBY_WIFI_DEVICES on Android 13+) and Wi-Fi
 * on; the caller ensures permissions. Passphrase is available API 29+. BSSID must be a real MAC (not
 * masked) or the phone rejects the creds — that needs location services ON.
 */
class WifiDirectHost(private val context: Context) {

    data class Creds(val ssid: String, val passphrase: String, val ownerIp: String, val bssid: String)

    private val manager = context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    private var channel: WifiP2pManager.Channel? = null
    @Volatile var creds: Creds? = null
        private set

    @SuppressLint("MissingPermission")
    fun start(onReady: (Creds?) -> Unit) {
        val mgr = manager ?: return onReady(null)
        val ch = mgr.initialize(context, context.mainLooper, null)
        channel = ch
        // Drop any stale group first, then create a fresh one.
        mgr.removeGroup(ch, object : WifiP2pManager.ActionListener {
            override fun onSuccess() = createGroup(mgr, ch, onReady)
            override fun onFailure(reason: Int) = createGroup(mgr, ch, onReady)
        })
    }

    @SuppressLint("MissingPermission")
    private fun createGroup(mgr: WifiP2pManager, ch: WifiP2pManager.Channel, onReady: (Creds?) -> Unit) {
        mgr.createGroup(ch, object : WifiP2pManager.ActionListener {
            override fun onSuccess() = requestInfo(mgr, ch, onReady)
            override fun onFailure(reason: Int) {
                Log.e(TAG, "createGroup failed: $reason"); onReady(null)
            }
        })
    }

    @SuppressLint("MissingPermission")
    private fun requestInfo(mgr: WifiP2pManager, ch: WifiP2pManager.Channel, onReady: (Creds?) -> Unit) {
        mgr.requestGroupInfo(ch) { group: WifiP2pGroup? ->
            if (group == null) { onReady(null); return@requestGroupInfo }
            val ssid = group.networkName ?: ""
            val pass = group.passphrase ?: ""
            val bssid = (group.owner?.deviceAddress ?: "").uppercase()
            val c = Creds(ssid, pass, OWNER_IP, bssid)
            creds = c
            Log.i(TAG, "P2P group ready: ssid=$ssid ip=$OWNER_IP bssid=$bssid")
            onReady(c)
        }
    }

    @SuppressLint("MissingPermission")
    fun stop() {
        val mgr = manager; val ch = channel
        if (mgr != null && ch != null) runCatching { mgr.removeGroup(ch, null) }
        creds = null
    }

    companion object {
        private const val TAG = "headunit-wifidirect"
        /** Android always assigns the P2P group owner this address. */
        const val OWNER_IP = "192.168.49.1"
    }
}
