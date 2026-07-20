package com.mobilelabkit.mirror

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import java.net.InetAddress
import java.util.ArrayDeque

/**
 * mDNS/DNS-SD helpers for the private `_mlkmirror._tcp` service. The receiver advertises;
 * the sender browses + resolves. This is exactly the discovery mechanism a Chromecast uses
 * — but on our own service type, between our own apps, so there is nothing to authenticate.
 */
object MirrorDiscovery {

    private const val TAG = "mirror-nsd"

    /** A resolved receiver the sender can connect to. */
    data class Receiver(val name: String, val host: String, val port: Int) {
        override fun toString() = "$name  ($host:$port)"
    }

    // --- Receiver side: advertise ourselves --------------------------------------------
    class Advertiser(context: Context) {
        private val nsd = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
        private var listener: NsdManager.RegistrationListener? = null

        fun start(friendlyName: String, port: Int, onName: (String) -> Unit = {}, onError: (String) -> Unit = {}) {
            stop()
            val info = NsdServiceInfo().apply {
                serviceName = friendlyName
                serviceType = MirrorProtocol.SERVICE_TYPE
                setPort(port)
                setAttribute(MirrorProtocol.TXT_VERSION, MirrorProtocol.PROTO_VERSION)
            }
            val l = object : NsdManager.RegistrationListener {
                override fun onServiceRegistered(s: NsdServiceInfo) {
                    Log.i(TAG, "advertising \"${s.serviceName}\" on :$port")
                    onName(s.serviceName)
                }
                override fun onRegistrationFailed(s: NsdServiceInfo, code: Int) {
                    Log.e(TAG, "registration failed: $code")
                    onError("mDNS registration failed ($code)")
                }
                override fun onServiceUnregistered(s: NsdServiceInfo) { Log.i(TAG, "unregistered") }
                override fun onUnregistrationFailed(s: NsdServiceInfo, code: Int) {
                    Log.w(TAG, "unregister failed: $code")
                }
            }
            listener = l
            nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
        }

        fun stop() {
            listener?.let { runCatching { nsd.unregisterService(it) } }
            listener = null
        }
    }

    // --- Sender side: browse + resolve --------------------------------------------------
    class Browser(context: Context) {
        private val nsd = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager
        private var discovery: NsdManager.DiscoveryListener? = null

        private val found = LinkedHashMap<String, Receiver>()
        private val pending = ArrayDeque<NsdServiceInfo>()
        private var resolving = false
        private var onChange: (List<Receiver>) -> Unit = {}

        /** Starts browsing. [onChange] fires (on a binder thread) whenever the set changes. */
        fun start(onChange: (List<Receiver>) -> Unit) {
            stop()
            this.onChange = onChange
            found.clear(); pending.clear(); resolving = false
            val l = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(t: String) { Log.i(TAG, "discovery started") }
                override fun onServiceFound(s: NsdServiceInfo) {
                    if (s.serviceType.trimEnd('.') == MirrorProtocol.SERVICE_TYPE.trimEnd('.')) enqueue(s)
                }
                override fun onServiceLost(s: NsdServiceInfo) {
                    synchronized(found) { found.remove(s.serviceName) }
                    emit()
                }
                override fun onDiscoveryStopped(t: String) { Log.i(TAG, "discovery stopped") }
                override fun onStartDiscoveryFailed(t: String, code: Int) {
                    Log.e(TAG, "start discovery failed: $code")
                }
                override fun onStopDiscoveryFailed(t: String, code: Int) {
                    Log.w(TAG, "stop discovery failed: $code")
                }
            }
            discovery = l
            nsd.discoverServices(MirrorProtocol.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, l)
        }

        fun stop() {
            discovery?.let { runCatching { nsd.stopServiceDiscovery(it) } }
            discovery = null
        }

        // NsdManager only allows one resolve in flight — serialize them.
        private fun enqueue(info: NsdServiceInfo) {
            synchronized(this) { pending.add(info); if (!resolving) resolveNext() }
        }

        private fun resolveNext() {
            val next = synchronized(this) {
                val n = pending.poll()
                resolving = n != null
                n
            } ?: return
            nsd.resolveService(next, object : NsdManager.ResolveListener {
                override fun onServiceResolved(s: NsdServiceInfo) {
                    val host: InetAddress? = s.host
                    if (host != null) {
                        synchronized(found) {
                            found[s.serviceName] = Receiver(s.serviceName, host.hostAddress ?: return, s.port)
                        }
                        emit()
                    }
                    resolveNext()
                }
                override fun onResolveFailed(s: NsdServiceInfo, code: Int) {
                    Log.w(TAG, "resolve failed for ${s.serviceName}: $code")
                    resolveNext()
                }
            })
        }

        private fun emit() {
            val snapshot = synchronized(found) { found.values.toList() }
            onChange(snapshot)
        }
    }
}
