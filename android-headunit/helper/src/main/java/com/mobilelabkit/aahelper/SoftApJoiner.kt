package com.mobilelabkit.aahelper

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Joins the head unit's self-hosted Wi-Fi ([SoftApHost] on the head-unit side) and **holds** it,
 * so Android Auto can project over it with no router or shared hotspot.
 *
 * Two things this must get right, both learned the hard way on-device:
 *  1. **Force the join** to a specific, internet-less SSID — a normal `WifiNetworkSuggestion`
 *     alone won't win against a saved network that *has* internet. `WifiNetworkSpecifier` +
 *     [ConnectivityManager.requestNetwork] connects immediately to exactly that SSID.
 *  2. **Keep holding it.** If we unregister the callback, Android tears down the specifier network
 *     and the phone roams straight back to the internet Wi-Fi — which is precisely why a fire at
 *     the head unit's IP failed before (the route went out the wrong gateway). We keep the
 *     callback registered for the whole session and hand the bound [Network] to [AaTrigger] so
 *     gearhead connects over it, not over the default network. Mirrors OpenAutoLink's CarWifiManager.
 *
 * Requires API 29 (Q). Below that, the user must join the SoftAP manually from Wi-Fi settings.
 */
class SoftApJoiner(context: Context) {

    fun interface OnJoined { fun onJoined(network: Network) }
    fun interface OnFailed { fun onFailed(reason: String) }

    private val appContext = context.applicationContext
    private val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val handler = Handler(Looper.getMainLooper())
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var attempt = 0
    private var running = false
    // Guard against stacking rejoins: onUnavailable/onLost can both fire and each would otherwise
    // queue its own retry, tearing down a network we may have just re-acquired.
    private var rejoinPending = false

    val supported: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

    /** Join [ssid]/[passphrase] and hold it; [onJoined] fires with the bound network (repeated on
     *  reconnect), [onFailed] after we exhaust retries. */
    fun start(ssid: String, passphrase: String?, onJoined: OnJoined, onFailed: OnFailed) {
        if (!supported) { onFailed.onFailed("Host-Wi-Fi join needs Android 10+; join it from Wi-Fi settings instead."); return }
        running = true
        attempt = 0
        tryJoin(ssid, passphrase, onJoined, onFailed)
    }

    private fun tryJoin(ssid: String, passphrase: String?, onJoined: OnJoined, onFailed: OnFailed) {
        if (!running) return
        rejoinPending = false
        if (attempt >= MAX_ATTEMPTS) { onFailed.onFailed("Couldn't join “$ssid” after $MAX_ATTEMPTS tries"); return }
        attempt++
        releaseCallback()

        val specBuilder = WifiNetworkSpecifier.Builder().setSsid(ssid)
        if (!passphrase.isNullOrEmpty()) specBuilder.setWpa2Passphrase(passphrase)
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            // The SoftAP has no internet — do NOT require INTERNET or the request never matches.
            .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .setNetworkSpecifier(specBuilder.build())
            .build()

        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (!running) return
                // A successful join resets the retry budget — otherwise a long session that drops
                // a dozen times over hours would exhaust MAX_ATTEMPTS and give up permanently.
                attempt = 0
                Log.i(TAG, "joined + holding “$ssid” (network=$network)")
                // Hand the app process a default route onto this network too, so our own
                // (non-gearhead) traffic can reach the head unit if needed.
                runCatching { cm.bindProcessToNetwork(network) }
                handler.post { onJoined.onJoined(network) }
            }
            override fun onUnavailable() {
                if (!running) return
                Log.w(TAG, "join attempt $attempt for “$ssid” failed; retrying")
                scheduleRejoin(ssid, passphrase, onJoined, onFailed)
            }
            override fun onLost(network: Network) {
                if (!running) return
                Log.w(TAG, "“$ssid” lost; rejoining")
                scheduleRejoin(ssid, passphrase, onJoined, onFailed)
            }
        }
        callback = cb
        // The system shows a "connect to this device's Wi-Fi?" dialog the first time; after the
        // user allows it once, subsequent joins to the same SSID are silent.
        runCatching { cm.requestNetwork(request, cb) }
            .onFailure { onFailed.onFailed("requestNetwork failed: ${it.message}") }
    }

    /** Queue at most one pending rejoin: onUnavailable and onLost can arrive together, and stacking
     *  their retries would churn the network we're trying to keep held. */
    private fun scheduleRejoin(ssid: String, passphrase: String?, onJoined: OnJoined, onFailed: OnFailed) {
        if (rejoinPending) return
        rejoinPending = true
        handler.postDelayed({ tryJoin(ssid, passphrase, onJoined, onFailed) }, RETRY_MS)
    }

    fun stop() {
        running = false
        rejoinPending = false
        handler.removeCallbacksAndMessages(null)
        releaseCallback()
        runCatching { cm.bindProcessToNetwork(null) }
    }

    private fun releaseCallback() {
        callback?.let { runCatching { cm.unregisterNetworkCallback(it) } }
        callback = null
    }

    companion object {
        private const val TAG = "aahelper-softap-join"
        private const val MAX_ATTEMPTS = 12
        private const val RETRY_MS = 4000L
    }
}
