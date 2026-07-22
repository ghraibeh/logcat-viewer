import XCTest
@testable import AAHeadUnitCore

/// Pass-through cryptor: proves the framing codec independent of TLS (and stands in for the
/// plaintext handshake phase, where frames aren't encrypted).
final class PassThroughCrypto: AapFrameCodec.Cryptor {
    var encryptCalls = 0
    var decryptCalls = 0
    func encrypt(_ plain: [UInt8]) throws -> [UInt8] { encryptCalls += 1; return plain }
    func decrypt(_ cipher: [UInt8]) throws -> [UInt8] { decryptCalls += 1; return cipher }
}

final class AapFrameTests: XCTestCase {

    func testSingleFrameRoundTrip() throws {
        let codec = AapFrameCodec(crypto: PassThroughCrypto())
        let content: [UInt8] = [0xDE, 0xAD, 0xBE, 0xEF]
        let wire = try codec.encode(channel: AapProto.chControl, messageId: AapProto.versionRequest,
                                    content: content, encrypted: false)
        // [ch][flags][size:2][payload...]; version request id=1 on control channel → no 0x04 bit.
        XCTAssertEqual(Int(wire[0]), AapProto.chControl)
        XCTAssertEqual(Int(wire[1]) & AapProto.frameTypeMask, AapProto.frameBulk)
        let msgs = codec.feed(wire)
        XCTAssertEqual(msgs.count, 1)
        XCTAssertEqual(msgs[0].messageId, AapProto.versionRequest)
        XCTAssertEqual(msgs[0].content, content)
    }

    func testControlBitOnNonControlChannel() throws {
        let codec = AapFrameCodec(crypto: PassThroughCrypto())
        // CHANNEL_OPEN_RESPONSE (id 8) on the VIDEO channel MUST carry the 0x04 control bit —
        // this is the exact fix that unblocked video on the Kotlin head unit.
        let wire = try codec.encode(channel: AapProto.chVideo, messageId: 8, content: [1, 2], encrypted: false)
        XCTAssertNotEqual(Int(wire[1]) & AapProto.msgControl, 0, "0x04 control bit must be set")
        // A media-specific id (>26) on the same channel must NOT set it.
        let wire2 = try codec.encode(channel: AapProto.chVideo, messageId: 0x8008, content: [1], encrypted: false)
        XCTAssertEqual(Int(wire2[1]) & AapProto.msgControl, 0, "specific messages stay 0x00")
    }

    func testMultiFrameReassembly() throws {
        let codec = AapFrameCodec(crypto: PassThroughCrypto())
        let big = (0 ..< (AapProto.maxFramePayload * 2 + 500)).map { UInt8($0 & 0xff) }
        let wire = try codec.encode(channel: AapProto.chVideo, messageId: 0x8001, content: big, encrypted: false)
        // First frame carries the 4-byte totalSize; expect FIRST + MIDDLE + LAST.
        XCTAssertEqual(Int(wire[1]) & AapProto.frameTypeMask, AapProto.frameFirst)
        let msgs = codec.feed(wire)
        XCTAssertEqual(msgs.count, 1)
        XCTAssertEqual(msgs[0].content, big)
    }

    func testPartialThenComplete() throws {
        let codec = AapFrameCodec(crypto: PassThroughCrypto())
        let wire = try codec.encode(channel: AapProto.chControl, messageId: 2, content: [9, 9, 9], encrypted: false)
        // Deliver the wire in two arbitrary splits — a complete message only after the tail.
        let cut = 3
        XCTAssertEqual(codec.feed(Array(wire[0 ..< cut])).count, 0)
        let msgs = codec.feed(Array(wire[cut...]))
        XCTAssertEqual(msgs.count, 1)
        XCTAssertEqual(msgs[0].content, [9, 9, 9])
    }

    func testInterleavedChannelsReassembleIndependently() throws {
        let codec = AapFrameCodec(crypto: PassThroughCrypto())
        let a = (0 ..< (AapProto.maxFramePayload + 10)).map { UInt8($0 & 0xff) }   // 2 frames on VIDEO
        let b: [UInt8] = [7, 7, 7]                                                // 1 frame on AUD_MEDIA
        var wire = try codec.encode(channel: AapProto.chVideo, messageId: 0x8001, content: a, encrypted: false)
        // Slot an AUD_MEDIA bulk frame between VIDEO's FIRST and LAST, as the phone does.
        let firstLen = 8 + AapProto.maxFramePayload
        let audio = try codec.encode(channel: AapProto.chAudioMedia, messageId: 0x8002, content: b, encrypted: false)
        wire.insert(contentsOf: audio, at: firstLen)
        let msgs = codec.feed(wire)
        XCTAssertEqual(msgs.count, 2)
        XCTAssertEqual(msgs.first { $0.channel == AapProto.chAudioMedia }?.content, b)
        XCTAssertEqual(msgs.first { $0.channel == AapProto.chVideo }?.content, a)
    }
}
