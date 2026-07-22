import Foundation
import Network

/// The MLK1 mirror wire protocol — the Swift twin of android-mirror's `MirrorProtocol.kt`.
/// Both ends of that protocol are ours, so there is no negotiation: framing is exactly
///
///   stream  := header unit*                          (sender → receiver direction)
///   header  := magic(4)="MLK1"  capW(i32) capH(i32) realW(i32) realH(i32)
///   unit    := len(i32)  kind(i8)  payload(len bytes)
///             kind 0=video (Annex-B H.264 AU), 1=config (SPS/PPS), 2=audio PCM, 3=meta
///
/// and the reverse (receiver → sender) control channel on the same socket:
///
///   touch    := type(i8)=1  action(i8: 0 down,1 move,2 up,3 cancel)  x(i32) y(i32) dtMs(i32)
///   needIdr  := type(i8)=2                       (no payload — "send me a keyframe now")
///
/// All integers big-endian (Java DataOutputStream order). Audio is raw interleaved PCM
/// 48 kHz / 2 ch / 16-bit. Video dimensions are authoritative from the SPS, the header's
/// capW/capH are advisory; realW/realH define the coordinate space for touch events.
enum MirrorWire {
    static let serviceType = "_mlkmirror._tcp"
    static let defaultPort: UInt16 = 8899
    static let txtVersionKey = "v"
    static let protoVersion = "1"
    static let magic: [UInt8] = [0x4D, 0x4C, 0x4B, 0x31] // "MLK1"

    static let kindVideo: UInt8 = 0
    static let kindConfig: UInt8 = 1
    static let kindAudio: UInt8 = 2
    static let kindMeta: UInt8 = 3
    static let maxUnit = 8 << 20 // 8 MB sanity ceiling, same as the Kotlin side

    static let ctrlTouch: UInt8 = 1
    static let ctrlNeedIdr: UInt8 = 2

    static let audioSampleRate = 48_000
    static let audioChannels = 2

    struct Header {
        let capW: Int32, capH: Int32, realW: Int32, realH: Int32
    }

    struct Touch {
        let action: Int32, x: Int32, y: Int32, dtMs: Int32
    }

    // --- big-endian byte packing ---------------------------------------------------------

    static func putInt32(_ v: Int32, into data: inout Data) {
        var be = v.bigEndian
        withUnsafeBytes(of: &be) { data.append(contentsOf: $0) }
    }

    static func int32(_ bytes: Data, at offset: Int) -> Int32 {
        var v: Int32 = 0
        _ = withUnsafeMutableBytes(of: &v) { dst in
            bytes.copyBytes(to: dst, from: offset ..< offset + 4)
        }
        return Int32(bigEndian: v)
    }

    static func headerData(capW: Int32, capH: Int32, realW: Int32, realH: Int32) -> Data {
        var d = Data(magic)
        putInt32(capW, into: &d); putInt32(capH, into: &d)
        putInt32(realW, into: &d); putInt32(realH, into: &d)
        return d
    }

    static func parseHeader(_ d: Data) throws -> Header {
        guard d.count >= 20, Array(d.prefix(4)) == magic else {
            throw MirrorError.badPeer("not a MobileLabKit Mirror stream")
        }
        return Header(capW: int32(d, at: 4), capH: int32(d, at: 8),
                      realW: int32(d, at: 12), realH: int32(d, at: 16))
    }

    static func unitData(kind: UInt8, payload: Data) -> Data {
        var d = Data(capacity: payload.count + 5)
        putInt32(Int32(payload.count), into: &d)
        d.append(kind)
        d.append(payload)
        return d
    }

    static func touchData(_ t: Touch) -> Data {
        var d = Data(capacity: 14)
        d.append(ctrlTouch)
        d.append(UInt8(truncatingIfNeeded: t.action))
        putInt32(t.x, into: &d); putInt32(t.y, into: &d); putInt32(t.dtMs, into: &d)
        return d
    }

    static func needIdrData() -> Data { Data([ctrlNeedIdr]) }

    /// Parse a KIND_META payload (16 bytes: capW capH realW realH) — sender rotated.
    static func parseMeta(_ d: Data) -> Header? {
        guard d.count >= 16 else { return nil }
        return Header(capW: int32(d, at: 0), capH: int32(d, at: 4),
                      realW: int32(d, at: 8), realH: int32(d, at: 12))
    }
}

enum MirrorError: Error, CustomStringConvertible {
    case badPeer(String)
    case closed(String)
    var description: String {
        switch self {
        case .badPeer(let s): return s
        case .closed(let s): return s
        }
    }
}

// --- H.264 Annex-B helpers ---------------------------------------------------------------

enum AnnexB {
    /// Iterate NAL units in an Annex-B buffer: calls body(offsetOfPayload, length, nalType).
    static func forEachNal(_ data: Data, _ body: (Int, Int, Int) -> Void) {
        let n = data.count
        var i = 0
        var starts: [Int] = [] // payload start offsets
        let bytes = [UInt8](data)
        while i + 2 < n {
            if bytes[i] == 0, bytes[i + 1] == 0 {
                if bytes[i + 2] == 1 {
                    starts.append(i + 3); i += 3; continue
                }
                if i + 3 < n, bytes[i + 2] == 0, bytes[i + 3] == 1 {
                    starts.append(i + 4); i += 4; continue
                }
            }
            i += 1
        }
        for (idx, s) in starts.enumerated() {
            // NAL runs to the next start code (minus its prefix) or the end of the buffer.
            var end = n
            if idx + 1 < starts.count {
                let next = starts[idx + 1]
                // Walk back over the start code prefix (3 or 4 bytes) before the next NAL.
                end = next - 3
                if end > 0, bytes[end - 1] == 0 { end -= 1 }
            }
            if s < end { body(s, end - s, Int(bytes[s] & 0x1F)) }
        }
    }

    static func containsNal(type: Int, in data: Data) -> Bool {
        var found = false
        forEachNal(data) { _, _, t in if t == type { found = true } }
        return found
    }

    /// Extract SPS (type 7) and PPS (type 8) payloads from an Annex-B config unit.
    static func parameterSets(from data: Data) -> (sps: Data, pps: Data)? {
        var sps: Data?
        var pps: Data?
        forEachNal(data) { off, len, t in
            if t == 7, sps == nil { sps = data.subdata(in: off ..< off + len) }
            if t == 8, pps == nil { pps = data.subdata(in: off ..< off + len) }
        }
        guard let s = sps, let p = pps else { return nil }
        return (s, p)
    }

    /// Repackage an Annex-B access unit as AVCC (4-byte big-endian length prefixes),
    /// dropping SPS/PPS NALs (they live in the format description, not the sample).
    static func toAVCC(_ data: Data) -> Data {
        var out = Data(capacity: data.count + 16)
        forEachNal(data) { off, len, t in
            if t == 7 || t == 8 { return } // parameter sets never go in AVCC samples
            var be = UInt32(len).bigEndian
            withUnsafeBytes(of: &be) { out.append(contentsOf: $0) }
            out.append(data.subdata(in: off ..< off + len))
        }
        return out
    }

    /// Convert one AVCC-framed sample (from VideoToolbox) to Annex-B.
    static func avccToAnnexB(_ data: Data) -> Data {
        var out = Data(capacity: data.count + 16)
        var i = 0
        let startCode: [UInt8] = [0, 0, 0, 1]
        while i + 4 <= data.count {
            let len = Int(MirrorWire.int32(data, at: i))
            i += 4
            guard len > 0, i + len <= data.count else { break }
            out.append(contentsOf: startCode)
            out.append(data.subdata(in: i ..< i + len))
            i += len
        }
        return out
    }
}
