import Foundation

/// A fully-reassembled, decrypted Android Auto message handed up to the channel layer.
public struct AapMessage {
    public let channel: Int
    public let encrypted: Bool
    public let messageId: Int
    public let content: [UInt8] // protobuf (message id already stripped)
}

/// Framing codec for the AA link — the pure, deterministic half of the Kotlin
/// `AapTransport` (encode a message → frames; feed inbound bytes → complete messages),
/// with TLS factored out behind [Cryptor] so this stays testable with a pass-through.
///
/// Split from transport I/O on purpose: the socket/thread/stall-watchdog half belongs to
/// the app target (NWConnection on iOS), but this — the exact byte layout and the
/// per-frame-decrypt-in-receive-order rule that AA's interleaved streams demand — is where
/// the subtle bugs live, so it round-trips under test without a device.
public final class AapFrameCodec {

    /// TLS seam. The real engine is [AapCrypto]; tests use a pass-through.
    public protocol Cryptor: AnyObject {
        func encrypt(_ plain: [UInt8]) throws -> [UInt8]
        func decrypt(_ cipher: [UInt8]) throws -> [UInt8]
    }

    private let crypto: Cryptor
    private var rx: [UInt8] = []                    // inbound bytes not yet a whole frame
    private var assembling: [Int: [UInt8]] = [:]    // per-channel PLAINTEXT reassembly

    public init(crypto: Cryptor) { self.crypto = crypto }

    /// Encode one message into one or more wire frames.
    public func encode(channel: Int, messageId: Int, content: [UInt8], encrypted: Bool) throws -> [UInt8] {
        let plain = AapProto.u16be(messageId) + content
        let enc = encrypted ? AapProto.encEncrypted : AapProto.encPlain
        let body = encrypted ? try crypto.encrypt(plain) : plain

        var out: [UInt8] = []
        let chunk = AapProto.maxFramePayload
        let total = body.count
        let multi = total > chunk
        var off = 0
        while off < total {
            let n = min(chunk, total - off)
            let frameType: Int = {
                if !multi { return AapProto.frameBulk }
                if off == 0 { return AapProto.frameFirst }
                if off + n >= total { return AapProto.frameLast }
                return AapProto.frameMiddle
            }()
            // Control-type messages (id 1..26) on a NON-control channel must set the 0x04
            // control bit so the phone routes them to its control parser, not the channel's
            // media namespace. THE fix that unblocked the Kotlin head unit — see its note.
            let msgFlag = (channel != AapProto.chControl && (1...26).contains(messageId))
                ? AapProto.msgControl : AapProto.msgSpecific
            out.append(UInt8(channel))
            out.append(UInt8(frameType | enc | msgFlag))
            out.append(contentsOf: AapProto.u16be(n))
            if frameType == AapProto.frameFirst { out.append(contentsOf: AapProto.u32be(total)) }
            out.append(contentsOf: body[off ..< off + n])
            off += n
        }
        return out
    }

    /// Feed inbound bytes; return every complete message they now form (possibly none).
    public func feed(_ data: [UInt8]) -> [AapMessage] {
        rx.append(contentsOf: data)
        var messages: [AapMessage] = []
        var pos = 0
        while true {
            if rx.count - pos < 4 { break }
            let channel = Int(rx[pos])
            let flags = Int(rx[pos + 1])
            let frameType = flags & AapProto.frameTypeMask
            let headerLen = frameType == AapProto.frameFirst ? 8 : 4
            if rx.count - pos < headerLen { break }
            let frameSize = AapProto.readU16(Array(rx[(pos + 2)...]), 0)
            let frameEnd = pos + headerLen + frameSize
            if rx.count < frameEnd { break } // wait for the rest of this frame
            let payload = Array(rx[(pos + headerLen) ..< frameEnd])
            pos = frameEnd
            if let m = handleFrame(channel: channel, flags: flags, frameType: frameType, payload: payload) {
                messages.append(m)
            }
        }
        if pos > 0 { rx.removeFirst(pos) }
        return messages
    }

    private func handleFrame(channel: Int, flags: Int, frameType: Int, payload: [UInt8]) -> AapMessage? {
        let encrypted = (flags & AapProto.encEncrypted) != 0
        // Decrypt EACH frame here, in receive order — TLS is one ordered record stream and
        // the phone interleaves frames across channels. Reassembly happens on plaintext.
        let plain: [UInt8]
        if encrypted {
            guard let d = try? crypto.decrypt(payload) else { return nil }
            plain = d
        } else {
            plain = payload
        }

        let complete: [UInt8]
        switch frameType {
        case AapProto.frameBulk:
            complete = plain
        case AapProto.frameFirst:
            assembling[channel] = plain
            return nil
        case AapProto.frameMiddle:
            assembling[channel, default: []].append(contentsOf: plain)
            return nil
        case AapProto.frameLast:
            guard var acc = assembling.removeValue(forKey: channel) else { return nil }
            acc.append(contentsOf: plain)
            complete = acc
        default:
            return nil
        }

        guard complete.count >= 2 else { return nil }
        let messageId = AapProto.readU16(complete, 0)
        return AapMessage(channel: channel, encrypted: encrypted,
                          messageId: messageId, content: Array(complete[2...]))
    }
}
