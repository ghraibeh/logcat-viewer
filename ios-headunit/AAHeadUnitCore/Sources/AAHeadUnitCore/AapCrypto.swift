import Foundation
import Security

/// TLS for the Android Auto link — the Swift twin of the Kotlin head unit's `AapCrypto.kt`.
/// The head unit is the TLS **client** and presents the head-unit certificate; the phone
/// verifies it. We do NOT verify the phone (trust-all).
///
/// The handshake bytes travel inside AA `SSL_HANDSHAKE` control messages, so — exactly like
/// the Kotlin side drives `SSLEngine` over memory BIOs — this drives Apple's Secure
/// Transport `SSLContext` over IN-MEMORY buffers via `SSLSetIOFuncs`: OpenSSL's BIO pair
/// has no Network.framework equivalent, but Secure Transport's custom read/write callbacks
/// are precisely a memory BIO. `SSLHandshake`/`SSLWrite`/`SSLRead` return
/// `errSSLWouldBlock` when they want more bytes; we shuttle ciphertext through `inBuf`/
/// `outBuf` and frame `outBuf` into `SSL_HANDSHAKE`/application records ourselves.
///
/// Secure Transport is deprecated (iOS 13+) but present and fully functional, and it is the
/// only Apple API that exposes TLS as a pumpable in-memory engine — Network.framework's TLS
/// is welded to a live socket, which the handshake-in-messages design can't use.
public final class AapCrypto: AapFrameCodec.Cryptor {

    public enum CryptoError: Error, CustomStringConvertible {
        case setup(String, OSStatus)
        case io(String, OSStatus)
        public var description: String {
            switch self {
            case .setup(let s, let st): return "TLS setup \(s) failed: \(st)"
            case .io(let s, let st): return "TLS \(s) failed: \(st)"
            }
        }
    }

    private let ctx: SSLContext
    private var inBuf: [UInt8] = []     // inbound ciphertext waiting to be read by SSLRead/Handshake
    private var outBuf: [UInt8] = []    // outbound ciphertext produced by SSLWrite/Handshake
    private var handshakeDone = false

    public var finished: Bool { handshakeDone }

    /// - Parameters:
    ///   - identity: the head-unit `SecIdentity` (cert + private key). Build it from the
    ///     bundled PKCS#12 with `SecPKCS12Import` in the app; the core stays key-agnostic.
    public init(identity: SecIdentity) throws {
        guard let c = SSLCreateContext(nil, .clientSide, .streamType) else {
            throw CryptoError.setup("create-context", -1)
        }
        ctx = c

        // Route TLS I/O through our in-memory buffers (the "memory BIO").
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var st = SSLSetConnection(ctx, refcon)
        guard st == errSecSuccess else { throw CryptoError.setup("set-connection", st) }
        st = SSLSetIOFuncs(ctx, AapCrypto.readFn, AapCrypto.writeFn)
        guard st == errSecSuccess else { throw CryptoError.setup("set-io-funcs", st) }

        // Present the head-unit identity; trust-all in the phone direction (no verification).
        st = SSLSetCertificate(ctx, [identity] as CFArray)
        guard st == errSecSuccess else { throw CryptoError.setup("set-certificate", st) }
        st = SSLSetSessionOption(ctx, .breakOnServerAuth, true) // we handle "trust" = accept
        guard st == errSecSuccess else { throw CryptoError.setup("break-on-server-auth", st) }

        SSLSetProtocolVersionMin(ctx, .tlsProtocol12)
        SSLSetProtocolVersionMax(ctx, .tlsProtocol12)
    }

    // --- handshake ------------------------------------------------------------------------

    /// Begin the handshake; returns the first bytes to send (ClientHello).
    public func startHandshake() throws -> [UInt8] {
        try pumpHandshake()
        return takeOut()
    }

    /// Feed one inbound SSL_HANDSHAKE message; return the next bytes to send (may be empty).
    /// When [finished] flips true the handshake is complete.
    public func processHandshake(_ incoming: [UInt8]) throws -> [UInt8] {
        inBuf.append(contentsOf: incoming)
        try pumpHandshake()
        return takeOut()
    }

    private func pumpHandshake() throws {
        while !handshakeDone {
            let st = SSLHandshake(ctx)
            switch st {
            case errSecSuccess:
                handshakeDone = true
            case errSSLWouldBlock:
                return // need more inbound bytes, or we've queued outbound — caller ships it
            case errSSLPeerAuthCompleted:
                continue // trust-all: accept the phone's cert and keep going
            default:
                throw CryptoError.io("handshake", st)
            }
        }
    }

    // --- application records --------------------------------------------------------------

    public func encrypt(_ plain: [UInt8]) throws -> [UInt8] {
        var written = 0
        try plain.withUnsafeBytes { raw in
            let st = SSLWrite(ctx, raw.baseAddress, raw.count, &written)
            if st != errSecSuccess { throw CryptoError.io("write", st) }
        }
        return takeOut()
    }

    public func decrypt(_ cipher: [UInt8]) throws -> [UInt8] {
        inBuf.append(contentsOf: cipher)
        var out: [UInt8] = []
        var scratch = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            var read = 0
            let st = scratch.withUnsafeMutableBytes { buf in
                SSLRead(ctx, buf.baseAddress!, buf.count, &read)
            }
            if read > 0 { out.append(contentsOf: scratch[0 ..< read]) }
            if st == errSSLWouldBlock { break }        // consumed all available records
            if st == errSecSuccess {
                if read == 0 { break }
                continue                                // more records buffered — keep draining
            }
            throw CryptoError.io("read", st)
        }
        return out
    }

    private func takeOut() -> [UInt8] {
        let o = outBuf
        outBuf.removeAll(keepingCapacity: true)
        return o
    }

    // --- Secure Transport I/O callbacks (static; recover `self` from refcon) --------------

    private static let readFn: SSLReadFunc = { conn, data, dataLength in
        let me = Unmanaged<AapCrypto>.fromOpaque(conn).takeUnretainedValue()
        let want = dataLength.pointee
        let have = me.inBuf.count
        let n = min(want, have)
        if n > 0 {
            data.copyMemory(from: me.inBuf, byteCount: n)
            me.inBuf.removeFirst(n)
        }
        dataLength.pointee = n
        return n < want ? errSSLWouldBlock : errSecSuccess
    }

    private static let writeFn: SSLWriteFunc = { conn, data, dataLength in
        let me = Unmanaged<AapCrypto>.fromOpaque(conn).takeUnretainedValue()
        let n = dataLength.pointee
        let ptr = data.assumingMemoryBound(to: UInt8.self)
        me.outBuf.append(contentsOf: UnsafeBufferPointer(start: ptr, count: n))
        dataLength.pointee = n
        return errSecSuccess
    }
}

private extension UnsafeMutableRawPointer {
    func copyMemory(from bytes: [UInt8], byteCount: Int) {
        bytes.withUnsafeBytes { self.copyMemory(from: $0.baseAddress!, byteCount: byteCount) }
    }
}
