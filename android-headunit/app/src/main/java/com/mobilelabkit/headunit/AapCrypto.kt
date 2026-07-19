package com.mobilelabkit.headunit

import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLEngineResult
import javax.net.ssl.SSLEngineResult.HandshakeStatus
import javax.net.ssl.X509TrustManager

/**
 * TLS for the Android Auto link. The head unit is the TLS **client** (aasdk uses
 * `TLSv1_2_client_method` + `SSL_set_connect_state`) and presents the head-unit
 * certificate; the phone verifies it. We do NOT verify the phone (trust-all).
 *
 * The handshake bytes are exchanged inside AA `SSL_HANDSHAKE` control messages, so this
 * drives `SSLEngine` incrementally: [startHandshake] emits ClientHello, then each
 * [processHandshake] feeds one inbound handshake message and returns the next bytes to
 * send, until [finished]. After that [encrypt]/[decrypt] wrap/unwrap application records.
 */
class AapCrypto(certPem: ByteArray, keyPkcs8Pem: ByteArray) {
    private val engine: SSLEngine
    private val appBufSize: Int
    private val netBufSize: Int
    private var pending = ByteArray(0) // leftover inbound ciphertext across messages

    val finished: Boolean
        get() = engine.handshakeStatus == HandshakeStatus.NOT_HANDSHAKING || handshakeDone
    private var handshakeDone = false

    init {
        val cert = CertificateFactory.getInstance("X.509")
            .generateCertificate(certPem.inputStream()) as X509Certificate
        val key = KeyFactory.getInstance("RSA")
            .generatePrivate(PKCS8EncodedKeySpec(pemToDer(keyPkcs8Pem)))
        val ks = KeyStore.getInstance("PKCS12").apply {
            load(null, null)
            setKeyEntry("headunit", key, PASS, arrayOf(cert))
        }
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
            .apply { init(ks, PASS) }
        val ctx = SSLContext.getInstance("TLSv1.2")
        ctx.init(kmf.keyManagers, arrayOf(TRUST_ALL), SecureRandom())
        engine = ctx.createSSLEngine().apply {
            useClientMode = true
        }
        appBufSize = engine.session.applicationBufferSize
        netBufSize = engine.session.packetBufferSize
    }

    /** Begin the handshake and return the first bytes to send (ClientHello). */
    fun startHandshake(): ByteArray {
        engine.beginHandshake()
        return drainWrap()
    }

    /** Feed one inbound SSL_HANDSHAKE message; return the next bytes to send (may be empty
     *  if we're only consuming). When [finished] flips true the handshake is complete. */
    fun processHandshake(incoming: ByteArray): ByteArray {
        feedUnwrap(incoming, handshake = true)
        val out = drainWrap()
        if (engine.handshakeStatus == HandshakeStatus.NOT_HANDSHAKING) handshakeDone = true
        return out
    }

    /** Encrypt an application payload into TLS record(s). */
    fun encrypt(plain: ByteArray): ByteArray {
        val src = ByteBuffer.wrap(plain)
        val out = ByteArrayOutputStream()
        while (src.hasRemaining()) {
            val net = ByteBuffer.allocate(netBufSize)
            val r = engine.wrap(src, net)
            if (r.status != SSLEngineResult.Status.OK) {
                Log.w(TAG, "encrypt wrap ${r.status}")
                if (r.status == SSLEngineResult.Status.BUFFER_OVERFLOW) continue else break
            }
            net.flip(); out.write(net.toBytes())
        }
        return out.toByteArray()
    }

    /** Decrypt inbound TLS record(s) into the application payload. */
    fun decrypt(cipher: ByteArray): ByteArray = feedUnwrap(cipher, handshake = false)

    // --- SSLEngine driving ----------------------------------------------------
    private fun drainWrap(): ByteArray {
        val out = ByteArrayOutputStream()
        loop@ while (true) {
            when (engine.handshakeStatus) {
                HandshakeStatus.NEED_WRAP -> {
                    val net = ByteBuffer.allocate(netBufSize)
                    val r = engine.wrap(EMPTY, net)
                    net.flip(); out.write(net.toBytes())
                    if (r.status == SSLEngineResult.Status.CLOSED) break@loop
                }
                HandshakeStatus.NEED_TASK -> runTasks()
                else -> break@loop // NEED_UNWRAP / FINISHED / NOT_HANDSHAKING
            }
        }
        return out.toByteArray()
    }

    /** Unwrap [incoming] (+ any leftover). During the handshake this drives handshake
     *  unwraps and returns nothing useful; for app data it returns the plaintext. */
    private fun feedUnwrap(incoming: ByteArray, handshake: Boolean): ByteArray {
        val buf = if (pending.isEmpty()) incoming else pending + incoming
        val src = ByteBuffer.wrap(buf)
        val app = ByteArrayOutputStream()
        var appBuf = ByteBuffer.allocate(appBufSize)
        loop@ while (src.hasRemaining()) {
            val r = engine.unwrap(src, appBuf)
            when (r.status) {
                SSLEngineResult.Status.OK -> {
                    appBuf.flip(); app.write(appBuf.toBytes()); appBuf = ByteBuffer.allocate(appBufSize)
                    if (engine.handshakeStatus == HandshakeStatus.NEED_TASK) runTasks()
                    if (handshake && engine.handshakeStatus != HandshakeStatus.NEED_UNWRAP) break@loop
                }
                SSLEngineResult.Status.BUFFER_UNDERFLOW -> break@loop // need more bytes next msg
                SSLEngineResult.Status.BUFFER_OVERFLOW -> {
                    appBuf = ByteBuffer.allocate(appBuf.capacity() * 2)
                }
                SSLEngineResult.Status.CLOSED -> break@loop
            }
        }
        pending = ByteArray(src.remaining()).also { src.get(it) }
        return app.toByteArray()
    }

    private fun runTasks() {
        var t = engine.delegatedTask
        while (t != null) { t.run(); t = engine.delegatedTask }
    }

    companion object {
        private const val TAG = "headunit-tls"
        private val PASS = charArrayOf()
        private val EMPTY: ByteBuffer = ByteBuffer.allocate(0)

        private val TRUST_ALL = object : X509TrustManager {
            override fun checkClientTrusted(c: Array<out X509Certificate>?, a: String?) {}
            override fun checkServerTrusted(c: Array<out X509Certificate>?, a: String?) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }

        private fun pemToDer(pem: ByteArray): ByteArray {
            val text = String(pem, Charsets.US_ASCII)
                .replace(Regex("-----BEGIN [^-]+-----"), "")
                .replace(Regex("-----END [^-]+-----"), "")
                .replace(Regex("\\s"), "")
            return android.util.Base64.decode(text, android.util.Base64.DEFAULT)
        }

        private fun ByteBuffer.toBytes(): ByteArray = ByteArray(remaining()).also { get(it) }
    }
}
