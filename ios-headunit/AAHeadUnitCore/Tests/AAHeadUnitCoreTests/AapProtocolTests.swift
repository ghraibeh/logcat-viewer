import XCTest
@testable import AAHeadUnitCore

final class PbTests: XCTestCase {
    func testVarintStringNestedRoundTrip() throws {
        let w = PbWriter()
            .varint(1, 5)
            .bool(2, true)
            .string(3, "hi")
            .msg(4, PbWriter().varint(1, 42))
            .finish()
        let f = try decodeFields(w)
        XCTAssertEqual(f.num(1), 5)
        XCTAssertEqual(f.num(2), 1)
        XCTAssertEqual(f.str(3), "hi")
        if case .bytes(let nested)? = f[4]?.first {
            XCTAssertEqual(try decodeFields(nested).num(1), 42)
        } else { XCTFail("nested message missing") }
    }

    func testRepeatedFieldsAccumulate() throws {
        // Two services (field 1) as the discovery response packs them.
        let w = PbWriter().msg(1, PbWriter().varint(1, 7)).msg(1, PbWriter().varint(1, 9)).finish()
        let f = try decodeFields(w)
        XCTAssertEqual(f[1]?.count, 2)
    }

    func testDrivingStatusMatchesKnownBytes() {
        // SensorBatch { drivingStatus(13) = { status(1) = 0 } }
        // field 13 LEN (tag 0x6a), len 2, inner: field 1 varint 0 (0x08 0x00).
        XCTAssertEqual(AapEncode.sensorEventDrivingStatus(), [0x6a, 0x02, 0x08, 0x00])
    }

    func testAuthCompleteIsClassic0800() {
        XCTAssertEqual(AapEncode.authComplete(), [0x08, 0x00])
    }
}

final class DiscoveryTests: XCTestCase {
    func testResponseParsesAndAdvertisesAllServices() throws {
        let cfg = HuConfig(resolution: .r1080x1920, densityDpi: 280)
        let resp = Discovery.buildServiceDiscoveryResponse(cfg)
        let f = try decodeFields(resp)
        // 9 services advertised (sensor, video, input, 3 audio, mic, media-pb, nav).
        XCTAssertEqual(f[1]?.count, 9)
        // Head-unit brand + display name present.
        XCTAssertEqual(f.str(2), "AndroidLab")
        XCTAssertEqual(f.str(14), "AndroidLab")
        // Each service carries its channel id in field 1.
        var ids: [Int] = []
        for v in f[1] ?? [] { if case .bytes(let b) = v, let id = (try? decodeFields(b))?.num(1) { ids.append(id) } }
        XCTAssertEqual(Set(ids), [0 == 0 ? AapProto.chSensor : 0, AapProto.chVideo, AapProto.chInput,
                                  AapProto.chAudioSystem, AapProto.chAudioSpeech, AapProto.chAudioMedia,
                                  AapProto.chMic, AapProto.chMediaPlayback, AapProto.chNav].reduce(into: Set<Int>()) { $0.insert($1) })
    }
}

// --- session state-machine test: drive the handshake through capture buffers -------------

final class SessionTests: XCTestCase {

    /// Captures every outbound message the session produces.
    final class CaptureSender: MessageSender {
        struct Sent { let channel: Int; let messageId: Int; let content: [UInt8]; let encrypted: Bool }
        var sent: [Sent] = []
        func send(channel: Int, messageId: Int, content: [UInt8], encrypted: Bool) {
            sent.append(Sent(channel: channel, messageId: messageId, content: content, encrypted: encrypted))
        }
        func last(_ id: Int) -> Sent? { sent.last { $0.messageId == id } }
    }

    /// Fake TLS engine: one handshake round-trip, then "finished".
    final class FakeCrypto: HandshakeEngine {
        private(set) var finished = false
        func startHandshake() throws -> [UInt8] { [0xAA] }          // "ClientHello"
        func processHandshake(_ incoming: [UInt8]) throws -> [UInt8] { finished = true; return [] }
    }

    final class Clock: MonoClock { func nowNanos() -> UInt64 { 123_456_789 } }

    final class Delegate: SessionDelegate {
        var streamingFired = false
        var video: [[UInt8]] = []
        var channelsOpened: [Int] = []
        func session(status: String) {}
        func session(phoneName: String, brand: String) {}
        func session(channelOpened: Int) { channelsOpened.append(channelOpened) }
        func session(videoData: [UInt8], codecConfig: Bool) { video.append(videoData) }
        func session(audioData: [UInt8], channel: Int) {}
        func session(micOpen: Bool) {}
        func sessionStreaming() { streamingFired = true }
        func sessionEnded(reason: String) {}
        func scheduleRepeating(seconds: Double, _ body: @escaping () -> Void) -> Any { NSObject() }
        func cancelScheduled(_ token: Any) {}
    }

    func testHandshakeThroughAuthComplete() {
        let sender = CaptureSender()
        let crypto = FakeCrypto()
        let delegate = Delegate()
        let session = AaSession(sender: sender, crypto: crypto,
                                config: HuConfig(resolution: .r1080x1920),
                                clock: Clock(), delegate: delegate)

        session.begin()
        XCTAssertEqual(sender.last(ControlMsg.versionRequest)?.channel, AapProto.chControl)

        // Phone → version response → we send ClientHello (SSL_HANDSHAKE, plaintext).
        session.handle(channel: AapProto.chControl, messageId: ControlMsg.versionResponse,
                       content: AapProto.u16be(1) + AapProto.u16be(2))
        XCTAssertEqual(sender.last(ControlMsg.sslHandshake)?.content, [0xAA])
        XCTAssertEqual(sender.last(ControlMsg.sslHandshake)?.encrypted, false)

        // Phone → handshake reply → TLS finishes → AUTH_COMPLETE.
        session.handle(channel: AapProto.chControl, messageId: ControlMsg.sslHandshake, content: [0xBB])
        XCTAssertEqual(sender.last(ControlMsg.authComplete)?.content, [0x08, 0x00])
    }

    func testSensorOpenPushesDrivingStatusGate() {
        let sender = CaptureSender(); let delegate = Delegate()
        let session = AaSession(sender: sender, crypto: FakeCrypto(),
                                config: HuConfig(resolution: .r1080x1920), clock: Clock(), delegate: delegate)
        // Channel-open on SENSOR → open response (with 0x04-worthy id 8, encrypted) + driving status.
        session.handle(channel: AapProto.chSensor, messageId: ControlMsg.channelOpenRequest, content: [])
        XCTAssertTrue(delegate.channelsOpened.contains(AapProto.chSensor))
        XCTAssertNotNil(sender.sent.last { $0.messageId == SensorMsg.event })
    }

    func testVideoDataStripsTimestampAndAcks() {
        let sender = CaptureSender(); let delegate = Delegate()
        let session = AaSession(sender: sender, crypto: FakeCrypto(),
                                config: HuConfig(resolution: .r1080x1920), clock: Clock(), delegate: delegate)
        let ts: [UInt8] = [0, 0, 0, 0, 0, 0, 0, 1]
        let nalu: [UInt8] = [0, 0, 0, 1, 0x67, 0x42] // Annex-B start + SPS-ish
        session.handle(channel: AapProto.chVideo, messageId: MediaMsg.data, content: ts + nalu)
        XCTAssertEqual(delegate.video.first, nalu, "8-byte timestamp stripped")
        XCTAssertTrue(delegate.streamingFired)
        XCTAssertNotNil(sender.last(MediaMsg.ack), "each data frame is ACKed")
    }
}
