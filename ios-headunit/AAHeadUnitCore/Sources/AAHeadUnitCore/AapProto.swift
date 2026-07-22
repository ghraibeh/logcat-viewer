import Foundation

/// Wire constants for the (modern) Android Auto protocol — the Swift twin of the working
/// Kotlin head unit's `AapProto.kt`. Framing on the link:
///
///   [channelId:1][flags:1][frameSize:2 BE] (+[totalSize:4 BE] when flags has FIRST) [payload]
///
/// flags = frameType | encryptionType | messageType. The decrypted payload starts with a
/// 2-byte BE message id, then the protobuf.
public enum AapProto {
    // Channel ids (head unit assigns these).
    public static let chControl = 0
    public static let chSensor = 1
    public static let chVideo = 2
    public static let chInput = 3
    public static let chAudioSpeech = 4
    public static let chAudioSystem = 5
    public static let chAudioMedia = 6
    public static let chMic = 7
    public static let chBluetooth = 8
    public static let chMediaPlayback = 9
    public static let chNav = 10

    public static func isAudio(_ ch: Int) -> Bool {
        ch == chAudioSpeech || ch == chAudioSystem || ch == chAudioMedia
    }
    public static func isMediaLike(_ ch: Int) -> Bool {
        ch == chVideo || ch == chMic || isAudio(ch)
    }

    // flags byte components
    public static let frameMiddle = 0
    public static let frameFirst = 1
    public static let frameLast = 2
    public static let frameBulk = 3
    public static let frameTypeMask = 3
    public static let encPlain = 0
    public static let encEncrypted = 1 << 3   // 0x08
    public static let msgSpecific = 0
    public static let msgControl = 1 << 2      // 0x04

    public static let versionMajor = 1
    public static let versionMinor = 2

    // Control message ids on the raw (pre-protobuf) path.
    public static let versionRequest = 1
    public static let versionResponse = 2
    public static let sslHandshake = 3         // MESSAGE_ENCAPSULATED_SSL
    public static let authComplete = 4

    public static let maxFramePayload = 0x4000

    public static func channelName(_ id: Int) -> String {
        switch id {
        case chControl: return "CONTROL"
        case chSensor: return "SENSOR"
        case chVideo: return "VIDEO"
        case chInput: return "INPUT"
        case chAudioSpeech: return "AUD_SPEECH"
        case chAudioSystem: return "AUD_SYSTEM"
        case chAudioMedia: return "AUD_MEDIA"
        case chMic: return "MIC"
        case chBluetooth: return "BT"
        case chMediaPlayback: return "MEDIA_PB"
        case chNav: return "NAV"
        default: return "CH\(id)"
        }
    }

    // Big-endian helpers.
    public static func u16be(_ v: Int) -> [UInt8] { [UInt8((v >> 8) & 0xff), UInt8(v & 0xff)] }
    public static func u32be(_ v: Int) -> [UInt8] {
        [UInt8((v >> 24) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)]
    }
    public static func readU16(_ b: [UInt8], _ o: Int) -> Int {
        (Int(b[o]) << 8) | Int(b[o + 1])
    }
    public static func readU32(_ b: [UInt8], _ o: Int) -> Int {
        (Int(b[o]) << 24) | (Int(b[o + 1]) << 16) | (Int(b[o + 2]) << 8) | Int(b[o + 3])
    }
}
