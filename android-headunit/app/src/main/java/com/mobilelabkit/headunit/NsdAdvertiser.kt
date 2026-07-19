package com.mobilelabkit.headunit

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections

/**
 * Advertises this head unit on the local network via **NSD / mDNS** so the phone-side
 * "AA Wireless Helper" can auto-discover it (no typing an IP). We register a custom service
 * type `_mlkheadunit._tcp` on the wireless port; the helper browses for it, resolves the
 * host+port, and fires Android Auto's wireless trigger at it.
 *
 * This is purely a *discovery* convenience — it is not the Android Auto protocol and stock AA
 * does not read it. It just replaces "read the IP off the screen and type it".
 */
class NsdAdvertiser(context: Context, private val port: Int, private val displayName: String) {

    private val nsd = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
    private var listener: NsdManager.RegistrationListener? = null

    fun start() {
        if (listener != null) return
        // NB: capture into a local — inside apply{} an unqualified `port` would resolve to
        // NsdServiceInfo's own port property (0), not our constructor param.
        val p = port
        val name = displayName
        val info = NsdServiceInfo().apply {
            serviceName = name
            serviceType = SERVICE_TYPE
            setPort(p)
        }
        val l = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(s: NsdServiceInfo) { Log.i(TAG, "registered as ${s.serviceName}") }
            override fun onRegistrationFailed(s: NsdServiceInfo, code: Int) { Log.w(TAG, "register failed: $code") }
            override fun onServiceUnregistered(s: NsdServiceInfo) {}
            override fun onUnregistrationFailed(s: NsdServiceInfo, code: Int) {}
        }
        listener = l
        runCatching { nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l) }
            .onFailure { Log.w(TAG, "register threw: ${it.message}") }
    }

    fun stop() {
        listener?.let { runCatching { nsd.unregisterService(it) } }
        listener = null
    }

    companion object {
        private const val TAG = "headunit-nsd"
        const val SERVICE_TYPE = "_mlkheadunit._tcp."

        /** This device's LAN IPv4 (Wi-Fi/Ethernet), for displaying on the waiting screen. */
        fun localIpv4(): String? {
            return runCatching {
                Collections.list(NetworkInterface.getNetworkInterfaces())
                    .asSequence()
                    .filter { it.isUp && !it.isLoopback }
                    .flatMap { Collections.list(it.inetAddresses).asSequence() }
                    .filterIsInstance<Inet4Address>()
                    .firstOrNull { !it.isLoopbackAddress && it.isSiteLocalAddress }
                    ?.hostAddress
            }.getOrNull()
        }
    }
}
