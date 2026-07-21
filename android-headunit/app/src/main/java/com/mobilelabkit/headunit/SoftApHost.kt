package com.mobilelabkit.headunit

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections

/**
 * Head-unit self-hosted Wi-Fi via [WifiManager.startLocalOnlyHotspot] — an **optional** mode for
 * when there is no shared router/hotspot to put the phone and head unit on the same LAN.
 *
 * Why this fixes the "stuck on version request" hotspot case: the failure there is client↔client
 * isolation on a phone Personal Hotspot (two clients can't reach each other). When the head unit
 * IS the access point and the phone joins it, the phone→head-unit path is client→AP, which an AP
 * never isolates. Our existing TCP:5288 server + NSD + AA protocol are unchanged; only the network
 * underneath differs.
 *
 * This is a **normal-app** capability — `startLocalOnlyHotspot()` needs only CHANGE_WIFI_STATE +
 * ACCESS_FINE_LOCATION (and NEARBY_WIFI_DEVICES on 13+), NOT a system app. Constraints inherent to
 * the API: the SSID/passphrase are auto-generated (we surface them for the phone to join), it runs
 * on one radio (the head unit's Wi-Fi *client* mode is off while hosting), the link has no internet,
 * and only one local-only hotspot can exist at a time (fails if the OS tether hotspot is already on).
 */
class SoftApHost(private val context: Context) {

    data class Info(val ssid: String, val passphrase: String?, val ip: String)

    fun interface OnReady { fun onReady(info: Info) }
    fun interface OnError { fun onError(msg: String) }

    private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private val handler = Handler(Looper.getMainLooper())
    private var reservation: WifiManager.LocalOnlyHotspotReservation? = null

    @Volatile var active = false
        private set
    @Volatile var info: Info? = null
        private set

    /** Start the SoftAP. [onReady] fires with the join credentials once it's up; [onError] on failure. */
    fun start(onReady: OnReady, onError: OnError) {
        if (active) { info?.let { onReady.onReady(it) }; return }
        val cb = object : WifiManager.LocalOnlyHotspotCallback() {
            override fun onStarted(res: WifiManager.LocalOnlyHotspotReservation) {
                reservation = res
                active = true
                val (ssid, pass) = readConfig(res)
                // The AP interface takes a moment to get its IPv4 — poll briefly, then fall back to
                // the AOSP local-only default (192.168.49.1).
                pollForIp(0, ssid, pass, onReady)
            }
            override fun onStopped() { Log.i(TAG, "local-only hotspot stopped"); active = false; info = null }
            override fun onFailed(reason: Int) {
                active = false
                onError.onError("SoftAP failed (${failureName(reason)}). On some phones you must turn " +
                    "off the system hotspot and mobile data, and keep Location on.")
            }
        }
        try {
            wifi.startLocalOnlyHotspot(cb, handler)
        } catch (e: Exception) {
            onError.onError("SoftAP not available: ${e.message}")
        }
    }

    private fun pollForIp(attempt: Int, ssid: String, pass: String?, onReady: OnReady) {
        val ip = apInterfaceIpv4()
        if (ip != null || attempt >= 10) {
            val resolved = Info(ssid, pass, ip ?: DEFAULT_AP_IP)
            info = resolved
            Log.i(TAG, "local-only hotspot up: ssid=$ssid ip=${resolved.ip}")
            handler.post { onReady.onReady(resolved) }
        } else {
            handler.postDelayed({ pollForIp(attempt + 1, ssid, pass, onReady) }, 300)
        }
    }

    fun stop() {
        reservation?.let { runCatching { it.close() } }
        reservation = null
        active = false
        info = null
    }

    /** Pull SSID + passphrase out of the reservation across API levels. */
    private fun readConfig(res: WifiManager.LocalOnlyHotspotReservation): Pair<String, String?> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val c = res.softApConfiguration
            val ssid = if (Build.VERSION.SDK_INT >= 33) {
                c.wifiSsid?.let { unquote(it.toString()) } ?: @Suppress("DEPRECATION") unquote(c.ssid ?: "")
            } else {
                @Suppress("DEPRECATION") unquote(c.ssid ?: "")
            }
            return ssid to c.passphrase
        }
        @Suppress("DEPRECATION")
        val wc = res.wifiConfiguration
        @Suppress("DEPRECATION")
        return unquote(wc?.SSID ?: "") to wc?.preSharedKey?.let { unquote(it) }
    }

    private fun unquote(s: String) = s.trim().removeSurrounding("\"")

    /** The IPv4 the SoftAP handed our AP interface (e.g. 192.168.49.1), or null if not up yet. */
    private fun apInterfaceIpv4(): String? = runCatching {
        Collections.list(NetworkInterface.getNetworkInterfaces())
            .asSequence()
            .filter { it.isUp && !it.isLoopback }
            .flatMap { iface -> Collections.list(iface.inetAddresses).asSequence().map { iface.name to it } }
            .filter { (_, addr) -> addr is Inet4Address && !addr.isLoopbackAddress && addr.isSiteLocalAddress }
            // The AP host is the .1 on its subnet; prefer the ap/softap interface, and 192.168.x.1.
            .sortedBy { (name, _) -> if (name.startsWith("ap") || name.startsWith("swlan") || name.contains("softap")) 0 else 1 }
            .firstOrNull { (_, addr) -> addr.hostAddress?.endsWith(".1") == true }
            ?.second?.hostAddress
    }.getOrNull()

    private fun failureName(reason: Int) = when (reason) {
        WifiManager.LocalOnlyHotspotCallback.ERROR_NO_CHANNEL -> "no channel"
        WifiManager.LocalOnlyHotspotCallback.ERROR_GENERIC -> "generic"
        WifiManager.LocalOnlyHotspotCallback.ERROR_INCOMPATIBLE_MODE -> "incompatible mode"
        WifiManager.LocalOnlyHotspotCallback.ERROR_TETHERING_DISALLOWED -> "tethering disallowed"
        else -> "code $reason"
    }

    companion object {
        private const val TAG = "headunit-softap"
        private const val DEFAULT_AP_IP = "192.168.49.1"
    }
}
