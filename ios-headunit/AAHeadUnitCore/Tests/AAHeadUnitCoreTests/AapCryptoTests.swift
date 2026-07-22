import XCTest
import Security
@testable import AAHeadUnitCore

/// Proves the iOS-specific unknown: that Secure Transport, driven purely over in-memory
/// buffers (the SSLSetIOFuncs "memory BIO"), completes a real TLS 1.2 handshake with the
/// handshake bytes shuttled by hand — which is exactly how AA carries them inside
/// SSL_HANDSHAKE messages. If this passes, the head unit's TLS design is sound on iOS.
///
/// The head unit is the client (AapCrypto). We stand up a throwaway Secure Transport SERVER
/// on the other end of the same in-memory pump to play the phone.
final class AapCryptoTests: XCTestCase {

    func testInMemoryHandshakeCompletesAndEncrypts() throws {
        let identity = try makeSelfSignedIdentity()
        let client = try AapCrypto(identity: identity)
        let server = try TestTlsServer(identity: identity)

        // Pump: client ⇄ server until both report finished, shuttling ciphertext by hand
        // exactly as AapTransport would frame it into SSL_HANDSHAKE messages.
        var toServer = try client.startHandshake()
        XCTAssertFalse(toServer.isEmpty, "ClientHello must be produced")

        var rounds = 0
        while !(client.finished && server.finished) {
            rounds += 1
            XCTAssertLessThan(rounds, 20, "handshake should converge quickly")
            let toClient = try server.pump(toServer)
            toServer = client.finished ? [] : try client.processHandshake(toClient)
            if server.finished && client.finished { break }
            if toServer.isEmpty && toClient.isEmpty { break }
        }
        XCTAssertTrue(client.finished, "client (head unit) handshake finished")
        XCTAssertTrue(server.finished, "server (phone) handshake finished")

        // Application data both directions through the established session.
        let plaintext: [UInt8] = Array("android-auto".utf8)
        let record = try client.encrypt(plaintext)
        XCTAssertFalse(record.isEmpty)
        let decoded = try server.decrypt(record)
        XCTAssertEqual(decoded, plaintext, "server decrypts what the head unit encrypted")

        let back = try server.encrypt([0x01, 0x02, 0x03])
        XCTAssertEqual(try client.decrypt(back), [0x01, 0x02, 0x03], "head unit decrypts the reply")
    }
}

// --- test helpers: a minimal Secure Transport server + a self-signed identity ------------

/// Server-side mirror of AapCrypto for the test's "phone" end.
private final class TestTlsServer {
    let finishedFlag = Box(false)
    var finished: Bool { finishedFlag.value }
    private let ctx: SSLContext
    private var inBuf: [UInt8] = []
    private var outBuf: [UInt8] = []

    init(identity: SecIdentity) throws {
        ctx = SSLCreateContext(nil, .serverSide, .streamType)!
        SSLSetConnection(ctx, Unmanaged.passUnretained(self).toOpaque())
        SSLSetIOFuncs(ctx, { conn, data, len in
            let me = Unmanaged<TestTlsServer>.fromOpaque(conn).takeUnretainedValue()
            let want = len.pointee, have = me.inBuf.count, n = min(want, have)
            if n > 0 { data.copyMemory(from: me.inBuf, byteCount: n); me.inBuf.removeFirst(n) }
            len.pointee = n
            return n < want ? errSSLWouldBlock : errSecSuccess
        }, { conn, data, len in
            let me = Unmanaged<TestTlsServer>.fromOpaque(conn).takeUnretainedValue()
            let n = len.pointee
            let p = data.assumingMemoryBound(to: UInt8.self)
            me.outBuf.append(contentsOf: UnsafeBufferPointer(start: p, count: n))
            len.pointee = n
            return errSecSuccess
        })
        SSLSetCertificate(ctx, [identity] as CFArray)
        SSLSetProtocolVersionMin(ctx, .tlsProtocol12)
        SSLSetProtocolVersionMax(ctx, .tlsProtocol12)
    }

    /// Feed inbound ciphertext, advance the handshake, return outbound ciphertext.
    func pump(_ incoming: [UInt8]) throws -> [UInt8] {
        inBuf.append(contentsOf: incoming)
        if !finished {
            let st = SSLHandshake(ctx)
            if st == errSecSuccess { finishedFlag.value = true }
            else if st != errSSLWouldBlock && st != errSSLPeerAuthCompleted {
                throw AapCrypto.CryptoError.io("server-handshake", st)
            }
        }
        defer { outBuf.removeAll(keepingCapacity: true) }
        return outBuf
    }

    func encrypt(_ plain: [UInt8]) throws -> [UInt8] {
        var w = 0
        try plain.withUnsafeBytes { if SSLWrite(ctx, $0.baseAddress, $0.count, &w) != errSecSuccess { throw err("write") } }
        defer { outBuf.removeAll(keepingCapacity: true) }
        return outBuf
    }

    func decrypt(_ cipher: [UInt8]) throws -> [UInt8] {
        inBuf.append(contentsOf: cipher)
        var out: [UInt8] = [], scratch = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            var r = 0
            let st = scratch.withUnsafeMutableBytes { SSLRead(ctx, $0.baseAddress!, $0.count, &r) }
            if r > 0 { out.append(contentsOf: scratch[0 ..< r]) }
            if st == errSSLWouldBlock { break }
            if st == errSecSuccess { if r == 0 { break } else { continue } }
            throw err("read")
        }
        return out
    }

    private func err(_ s: String) -> Error { AapCrypto.CryptoError.io("server-\(s)", -1) }
    final class Box<T> { var value: T; init(_ v: T) { value = v } }
}

/// A self-signed RSA identity in the keychain for the test (cert + key as one SecIdentity).
private func makeSelfSignedIdentity() throws -> SecIdentity {
    // Generate an RSA keypair, self-sign a minimal cert, import as a PKCS#12 identity.
    // Uses `openssl` (present on the build host) to avoid hand-rolling ASN.1 in the test.
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("aahu-tls-\(ProcessInfo.processInfo.globallyUniqueString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let key = dir.appendingPathComponent("k.pem")
    let crt = dir.appendingPathComponent("c.pem")
    let p12 = dir.appendingPathComponent("id.p12")

    // Prefer Homebrew OpenSSL 3 (has `-legacy`, needed so SecPKCS12Import accepts the p12);
    // /usr/bin/openssl is LibreSSL here and lacks it.
    let opensslPath = ["/opt/homebrew/bin/openssl", "/usr/local/bin/openssl", "/usr/bin/openssl"]
        .first { FileManager.default.isExecutableFile(atPath: $0) } ?? "/usr/bin/openssl"
    func run(_ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: opensslPath)
        p.arguments = args
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run(); p.waitUntilExit()
        if p.terminationStatus != 0 { throw AapCrypto.CryptoError.setup("openssl \(args.first ?? "")", p.terminationStatus) }
    }
    try run(["req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-keyout", key.path, "-out", crt.path, "-days", "3650",
             "-subj", "/CN=MLK Head Unit"])
    // `-legacy`: OpenSSL 3 defaults to PBKDF2/AES p12 encryption that Apple's
    // SecPKCS12Import rejects (errSecAuthFailed / -25293). Legacy PBE (SHA1-3DES) imports
    // cleanly — a test-fixture detail; the app controls its own bundled identity format.
    try run(["pkcs12", "-export", "-legacy", "-inkey", key.path, "-in", crt.path,
             "-out", p12.path, "-passout", "pass:test", "-name", "headunit"])

    let data = try Data(contentsOf: p12)

    // Import into a throwaway keychain. On macOS, SecPKCS12Import from a CLI/test bundle
    // fails with errSecAuthFailed (-25293) against the login keychain (no UI to authorize);
    // a temporary keychain we create + unlock ourselves sidesteps that. iOS has no such
    // step — the data-protection keychain imports directly — so this is macOS-test-only.
    let kcPath = dir.appendingPathComponent("t.keychain").path
    var keychain: SecKeychain?
    let pw = Array("test".utf8)
    let cst = SecKeychainCreate(kcPath, UInt32(pw.count), pw, false, nil, &keychain)
    guard cst == errSecSuccess, let kc = keychain else {
        throw AapCrypto.CryptoError.setup("keychain-create", cst)
    }
    defer { SecKeychainDelete(kc) }

    var items: CFArray?
    let opts: [String: Any] = [
        kSecImportExportPassphrase as String: "test",
        kSecImportExportKeychain as String: kc,
    ]
    let st = SecPKCS12Import(data as CFData, opts as CFDictionary, &items)
    guard st == errSecSuccess,
          let arr = items as? [[String: Any]],
          let first = arr.first,
          let idAny = first[kSecImportItemIdentity as String]
    else { throw AapCrypto.CryptoError.setup("pkcs12-import", st) }
    return (idAny as! SecIdentity)
}

private extension UnsafeMutableRawPointer {
    func copyMemory(from bytes: [UInt8], byteCount: Int) {
        bytes.withUnsafeBytes { self.copyMemory(from: $0.baseAddress!, byteCount: byteCount) }
    }
}
