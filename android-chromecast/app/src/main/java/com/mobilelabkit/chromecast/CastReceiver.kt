package com.mobilelabkit.chromecast

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.provider.Settings
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.io.DataInputStream
import java.math.BigInteger
import java.net.InetAddress
import java.security.KeyStore
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Calendar
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket
import javax.security.auth.x500.X500Principal

/**
 * Phase-1 Google Cast receiver front door.
 *
 * A Cast device is discovered purely by an mDNS advertisement of `_googlecast._tcp` — no
 * root, no certificate, no handshake — so registering it here is what makes this app
 * **appear in the phone's native Screen-Cast list**. When the user taps it, the sender
 * opens TLS to port 8009 and issues a CASTV2 `AuthChallenge` (device authentication).
 *
 * This phase does NOT yet complete auth or receive video (that's the vendored-openscreen
 * Phase 2). It exists to de-risk the two unknowns we can only measure on-device:
 *   1. does our entry appear + does the native caster actually connect when tapped, and
 *   2. what exactly is in the AuthChallenge (algorithms, and whether a sender_nonce is set)?
 * Everything the sender sends is surfaced through [Listener] and logged.
 */
class CastReceiver(private val context: Context) {

    interface Listener {
        /** Advertising is live — we should now be visible in the sender's Cast list. */
        fun onAdvertising(friendlyName: String, port: Int)
        /** A sender opened a TCP connection to :8009 (fires before the TLS handshake). */
        fun onSenderConnected(remote: String)
        /** Parsed the first CASTV2 device-auth challenge. */
        fun onAuthChallenge(sigAlg: Int, hashAlg: Int, nonceLen: Int)
        fun onSenderDisconnected()
        fun onError(message: String)
    }

    /** Stable per-device 32-hex Cast id (from ANDROID_ID) — must be unique per receiver
     *  or two installs collide in the sender's list. */
    private val deviceId: String by lazy {
        val aid = runCatching {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
        }.getOrNull().orEmpty().filter { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }
        (aid + "0123456789abcdef0123456789abcdef").take(32).lowercase()
    }

    @Volatile private var running = false
    private var serverSocket: SSLServerSocket? = null
    private var nsd: NsdManager? = null
    private var regListener: NsdManager.RegistrationListener? = null
    private var acceptThread: Thread? = null
    private var listener: Listener? = null

    val isRunning: Boolean get() = running

    @Synchronized
    fun start(friendlyName: String, listener: Listener) {
        if (running) return
        this.listener = listener
        try {
            val ctx = buildServerTls()
            val ss = ctx.serverSocketFactory.createServerSocket(CAST_PORT) as SSLServerSocket
            serverSocket = ss
            running = true
            val port = ss.localPort
            acceptThread = Thread({ acceptLoop(ss) }, "cast-accept").also { it.start() }
            registerService(friendlyName, port)
            listener.onAdvertising(friendlyName, port)
            Log.i(TAG, "Cast receiver advertising \"$friendlyName\" on :$port")
        } catch (e: Exception) {
            running = false
            Log.e(TAG, "start failed", e)
            listener.onError(e.message ?: e.javaClass.simpleName)
        }
    }

    @Synchronized
    fun stop() {
        if (!running) return
        running = false
        runCatching { regListener?.let { nsd?.unregisterService(it) } }
        regListener = null
        runCatching { serverSocket?.close() }
        serverSocket = null
        acceptThread?.interrupt()
        acceptThread = null
        listener = null
    }

    // --- mDNS advertisement: this is what puts us in the native Cast list -------------
    private fun registerService(friendlyName: String, port: Int) {
        val info = NsdServiceInfo().apply {
            serviceName = "MobileLabKit-${deviceId.take(8)}"
            serviceType = SERVICE_TYPE
            setPort(port)
            // The TXT record a Chromecast advertises. `fn` is the name shown in the list;
            // `ca` is the capability bitmask (4101 = video+audio out, like a real Chromecast).
            setAttribute("id", deviceId)
            setAttribute("cd", deviceId)
            setAttribute("ve", "05")
            setAttribute("md", "MobileLabKit Cast")
            setAttribute("ic", "/setup/icon.png")
            setAttribute("fn", friendlyName)
            setAttribute("ca", "4101")
            setAttribute("st", "0")
            setAttribute("nf", "1")
            setAttribute("rs", "")
        }
        val mgr = context.getSystemService(Context.NSD_SERVICE) as NsdManager
        nsd = mgr
        val l = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(s: NsdServiceInfo) {
                Log.i(TAG, "mDNS registered: ${s.serviceName} (${SERVICE_TYPE})")
            }
            override fun onRegistrationFailed(s: NsdServiceInfo, code: Int) {
                Log.e(TAG, "mDNS registration failed: $code")
                listener?.onError("mDNS registration failed ($code)")
            }
            override fun onServiceUnregistered(s: NsdServiceInfo) {
                Log.i(TAG, "mDNS unregistered")
            }
            override fun onUnregistrationFailed(s: NsdServiceInfo, code: Int) {
                Log.w(TAG, "mDNS unregister failed: $code")
            }
        }
        regListener = l
        mgr.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
    }

    // --- TLS server on :8009 — capture what the sender sends --------------------------
    private fun acceptLoop(ss: SSLServerSocket) {
        while (running) {
            val socket = try {
                ss.accept() as SSLSocket
            } catch (e: Exception) {
                if (running) Log.w(TAG, "accept ended: ${e.message}")
                break
            }
            val remote = socket.inetAddress?.hostAddress ?: "?"
            Log.i(TAG, "sender connected (TCP) from $remote")
            listener?.onSenderConnected(remote)
            // Handle one connection at a time — a screen cast opens a single control channel.
            runCatching { handleConnection(socket) }
                .onFailure { Log.w(TAG, "connection error: ${it.message}") }
            runCatching { socket.close() }
            listener?.onSenderDisconnected()
        }
    }

    private fun handleConnection(socket: SSLSocket) {
        socket.startHandshake() // TLS up; the sender does not present a client cert
        Log.i(TAG, "TLS handshake complete; reading CASTV2 frames")
        val din = DataInputStream(socket.inputStream)
        while (running && !socket.isClosed) {
            val len = din.readInt() // CASTV2 framing: 4-byte big-endian length prefix
            if (len <= 0 || len > MAX_FRAME) throw IllegalStateException("bad frame len $len")
            val buf = ByteArray(len)
            din.readFully(buf)
            onCastMessage(buf)
        }
    }

    /** Parse the fields of a CastMessage we care about and log/report them. */
    private fun onCastMessage(bytes: ByteArray) {
        val m = Proto(bytes)
        var namespace = ""
        var payloadBin: ByteArray? = null
        var payloadStr: String? = null
        while (m.hasMore()) {
            val (field, wire) = m.readTag()
            when {
                field == 4 && wire == 2 -> namespace = m.readString()
                field == 6 && wire == 2 -> payloadStr = m.readString()
                field == 7 && wire == 2 -> payloadBin = m.readBytes()
                else -> m.skip(wire)
            }
        }
        Log.i(TAG, "CASTV2 msg ns=$namespace payload=${payloadStr ?: "<${payloadBin?.size ?: 0}B binary>"}")
        if (namespace == NS_DEVICEAUTH && payloadBin != null) parseAuthChallenge(payloadBin)
    }

    /** DeviceAuthMessage{ challenge=1 : AuthChallenge{ sig_alg=1, sender_nonce=2, hash_alg=3 } } */
    private fun parseAuthChallenge(payload: ByteArray) {
        val outer = Proto(payload)
        var challenge: ByteArray? = null
        while (outer.hasMore()) {
            val (field, wire) = outer.readTag()
            if (field == 1 && wire == 2) challenge = outer.readBytes() else outer.skip(wire)
        }
        if (challenge == null) { Log.i(TAG, "device-auth message with no challenge"); return }
        val c = Proto(challenge)
        var sigAlg = 1 /* RSASSA_PKCS1v15 default */
        var hashAlg = 0 /* SHA1 default */
        var nonceLen = 0
        while (c.hasMore()) {
            val (field, wire) = c.readTag()
            when {
                field == 1 && wire == 0 -> sigAlg = c.readVarint().toInt()
                field == 2 && wire == 2 -> nonceLen = c.readBytes().size
                field == 3 && wire == 0 -> hashAlg = c.readVarint().toInt()
                else -> c.skip(wire)
            }
        }
        Log.i(TAG, "AuthChallenge sigAlg=$sigAlg hashAlg=$hashAlg nonceLen=$nonceLen")
        listener?.onAuthChallenge(sigAlg, hashAlg, nonceLen)
    }

    // --- self-signed TLS identity (AndroidKeyStore, no BouncyCastle needed) -----------
    private fun buildServerTls(): SSLContext {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!ks.containsAlias(KEY_ALIAS)) generateSelfSigned()
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        kmf.init(ks, null) // AndroidKeyStore keys need no password
        // sanity: fail early if the alias didn't yield a usable identity
        (ks.getKey(KEY_ALIAS, null) as? PrivateKey) ?: error("no private key for TLS")
        (ks.getCertificate(KEY_ALIAS) as? X509Certificate) ?: error("no cert for TLS")
        return SSLContext.getInstance("TLS").apply { init(kmf.keyManagers, null, null) }
    }

    private fun generateSelfSigned() {
        val notBefore = Calendar.getInstance()
        val notAfter = Calendar.getInstance().apply { add(Calendar.YEAR, 10) }
        // EC (P-256) rather than RSA: ECDHE_ECDSA avoids the RSA-in-TEE path that fails
        // mid-handshake ("RSA routines: internal error") on some devices' keymaster.
        val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(
                KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA384,
                KeyProperties.DIGEST_SHA512
            )
            .setCertificateSubject(X500Principal("CN=MobileLabKit Cast"))
            .setCertificateSerialNumber(BigInteger.valueOf(1))
            .setCertificateNotBefore(notBefore.time)
            .setCertificateNotAfter(notAfter.time)
            .build()
        val kpg = java.security.KeyPairGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore"
        )
        kpg.initialize(spec)
        kpg.generateKeyPair()
        Log.i(TAG, "generated self-signed TLS identity (EC P-256)")
    }

    // --- tiny protobuf reader (only what CastMessage/DeviceAuth need) -----------------
    private class Proto(private val b: ByteArray) {
        private var p = 0
        fun hasMore() = p < b.size
        fun readTag(): Pair<Int, Int> {
            val key = readVarint().toInt()
            return (key ushr 3) to (key and 0x7)
        }
        fun readVarint(): Long {
            var shift = 0; var result = 0L
            while (true) {
                val byte = b[p++].toInt() and 0xff
                result = result or ((byte and 0x7f).toLong() shl shift)
                if (byte and 0x80 == 0) break
                shift += 7
            }
            return result
        }
        fun readBytes(): ByteArray {
            val n = readVarint().toInt()
            val out = b.copyOfRange(p, p + n); p += n; return out
        }
        fun readString() = String(readBytes(), Charsets.UTF_8)
        /** Advance past a field of the given wire type without decoding it. */
        fun skip(wire: Int) {
            when (wire) {
                0 -> readVarint()
                2 -> { val n = readVarint().toInt(); p += n }
                5 -> p += 4
                1 -> p += 8
                else -> throw IllegalStateException("unknown wire type $wire")
            }
        }
    }

    companion object {
        private const val TAG = "cast-receiver"
        private const val SERVICE_TYPE = "_googlecast._tcp."
        private const val CAST_PORT = 8009
        private const val KEY_ALIAS = "cast-tls-ec" // EC identity (bump to regenerate)
        private const val MAX_FRAME = 1 shl 20 // 1 MB
        private const val NS_DEVICEAUTH = "urn:x-cast:com.google.cast.tp.deviceauth"
    }
}
