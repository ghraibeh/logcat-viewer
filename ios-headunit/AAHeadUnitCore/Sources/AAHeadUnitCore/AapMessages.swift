import Foundation

/// The Android Auto message subset a head unit needs — message-id tables, enum values, and
/// hand-written proto2 encoders/decoders. The Swift twin of the Electron head unit's
/// `proto.ts`; field numbers transcribed from headunit-revived's generated protobuf.
/// proto2, UNPACKED repeated fields, fields always written explicitly (so status=SUCCESS(0)
/// still hits the wire).
public enum ControlMsg {
    public static let versionRequest = 1
    public static let versionResponse = 2
    public static let sslHandshake = 3
    public static let authComplete = 4
    public static let serviceDiscoveryRequest = 5
    public static let serviceDiscoveryResponse = 6
    public static let channelOpenRequest = 7
    public static let channelOpenResponse = 8
    public static let pingRequest = 11
    public static let pingResponse = 12
    public static let navFocusRequest = 13
    public static let navFocusNotification = 14
    public static let byeByeRequest = 15
    public static let byeByeResponse = 16
    public static let voiceSessionNotification = 17
    public static let audioFocusRequest = 18
    public static let audioFocusNotification = 19
}

public enum MediaMsg {
    public static let data = 0x0000
    public static let codecConfig = 0x0001
    public static let setup = 0x8000
    public static let start = 0x8001
    public static let stop = 0x8002
    public static let config = 0x8003
    public static let ack = 0x8004
    public static let microphoneRequest = 0x8005
    public static let microphoneResponse = 0x8006
    public static let videoFocusRequest = 0x8007
    public static let videoFocusNotification = 0x8008
}

public enum SensorMsg {
    public static let startRequest = 0x8001
    public static let startResponse = 0x8002
    public static let event = 0x8003
}

public enum InputMsg {
    public static let event = 0x8001
    public static let bindingRequest = 0x8002
    public static let bindingResponse = 0x8003
}

public enum MessageStatus { public static let success = 0 }
public enum MediaCodecType { public static let audioPcm = 1; public static let videoH264BP = 3 }
public enum AudioStreamType { public static let none = 0; public static let speech = 1; public static let system = 2; public static let media = 3 }
public enum SensorType { public static let night = 10; public static let drivingStatus = 13 }
public enum DrivingStatus { public static let unrestricted = 0 }
public enum VideoFocusMode { public static let projected = 1; public static let native = 2 }

public enum AudioFocusRequestType {
    public static let none = 0, gain = 1, gainTransient = 2, gainTransientMayDuck = 3, release = 4
}
public enum AudioFocusState {
    public static let gain = 1, gainTransient = 2, loss = 3, lossTransientCanDuck = 4,
                      lossTransient = 5, gainMediaOnly = 6, gainTransientGuidanceOnly = 7
}
public enum NavFocusType { public static let navFocus1 = 1; public static let navFocus2 = 2 }
public enum TouchAction {
    public static let down = 0, up = 1, move = 2, cancel = 3, pointerDown = 5, pointerUp = 6
}

/// VideoCodecResolutionType — the fixed AA resolution ladder.
public enum Resolution: Int {
    case r800x480 = 1, r1280x720 = 2, r1920x1080 = 3, r720x1280 = 6, r1080x1920 = 7
    public var dims: (Int, Int) {
        switch self {
        case .r800x480: return (800, 480)
        case .r1280x720: return (1280, 720)
        case .r1920x1080: return (1920, 1080)
        case .r720x1280: return (720, 1280)
        case .r1080x1920: return (1080, 1920)
        }
    }
}

// --- encoders ---------------------------------------------------------------------------

public enum AapEncode {
    public static func channelOpenResponse() -> [UInt8] {
        PbWriter().varint(1, MessageStatus.success).finish()
    }
    public static func authComplete() -> [UInt8] {
        PbWriter().varint(1, MessageStatus.success).finish()
    }
    public static func pingRequest(_ ts: UInt64) -> [UInt8] { PbWriter().varint(1, ts).finish() }
    public static func pingResponse(_ ts: UInt64) -> [UInt8] { PbWriter().varint(1, ts).finish() }

    public static func audioFocusNotification(_ state: Int, unsolicited: Bool) -> [UInt8] {
        PbWriter().varint(1, state).bool(2, unsolicited).finish()
    }
    public static func navFocusNotification(_ type: Int) -> [UInt8] {
        PbWriter().varint(1, type).finish()
    }
    public static func byeByeResponse() -> [UInt8] { [] }

    public static func sensorStartResponse() -> [UInt8] {
        PbWriter().varint(1, MessageStatus.success).finish()
    }
    /// SensorBatch { drivingStatus(13) = { status(1) = UNRESTRICTED } } — THE projection gate.
    public static func sensorEventDrivingStatus() -> [UInt8] {
        PbWriter().msg(13, PbWriter().varint(1, DrivingStatus.unrestricted)).finish()
    }
    public static func sensorEventNight(_ isNight: Bool) -> [UInt8] {
        PbWriter().msg(10, PbWriter().bool(1, isNight)).finish()
    }
    /// Media Config { status(1)=HEADUNIT(2), maxUnacked(2)=16, configurationIndices(3)+=0 }
    public static func mediaConfig() -> [UInt8] {
        PbWriter().varint(1, 2).varint(2, 16).varint(3, 0).finish()
    }
    public static func mediaAck(_ sessionId: Int) -> [UInt8] {
        PbWriter().varint(1, sessionId).varint(2, 1).finish()
    }
    public static func microphoneResponse(_ sessionId: Int) -> [UInt8] {
        PbWriter().varint(1, 0).varint(2, sessionId).finish()
    }
    public static func videoFocusNotification() -> [UInt8] {
        PbWriter().varint(1, VideoFocusMode.projected).bool(2, true).finish()
    }
    public static func bindingResponse() -> [UInt8] {
        PbWriter().varint(1, MessageStatus.success).finish()
    }
    /// InputReport { timestamp(1), touchEvent(3) = { pointerData(1)={x,y,id}, actionIndex(2)=0, action(3) } }
    public static func inputReportTouch(_ ts: UInt64, _ x: Int, _ y: Int, _ action: Int, pointerId: Int = 0) -> [UInt8] {
        let pointer = PbWriter().varint(1, x).varint(2, y).varint(3, pointerId)
        let touch = PbWriter().msg(1, pointer).varint(2, 0).varint(3, action)
        return PbWriter().varint(1, ts).msg(3, touch).finish()
    }
}

// --- decoders ---------------------------------------------------------------------------

public enum AapDecode {
    public static func serviceDiscoveryRequest(_ c: [UInt8]) -> (name: String?, brand: String?) {
        guard let f = try? decodeFields(c) else { return (nil, nil) }
        return (f.str(4), f.str(5))
    }
    public static func audioFocusRequest(_ c: [UInt8]) -> Int? { (try? decodeFields(c))?.num(1) }
    public static func pingTimestamp(_ c: [UInt8]) -> UInt64? { (try? decodeFields(c))?.big(1) }
    public static func channelOpenRequest(_ c: [UInt8]) -> (priority: Int?, serviceId: Int?) {
        guard let f = try? decodeFields(c) else { return (nil, nil) }
        return (f.num(1), f.num(2))
    }
    public static func sensorRequestType(_ c: [UInt8]) -> Int? { (try? decodeFields(c))?.num(1) }
    public static func mediaStartSession(_ c: [UInt8]) -> Int { (try? decodeFields(c))?.num(1) ?? 0 }
    public static func microphoneOpen(_ c: [UInt8]) -> Bool { ((try? decodeFields(c))?.num(1) ?? 0) != 0 }
    public static func byeByeReason(_ c: [UInt8]) -> Int? { (try? decodeFields(c))?.num(1) }
}
