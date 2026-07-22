import Foundation

/// H.264 Annex-B bitstream helpers shared by the video path: locate NAL units, detect a NAL
/// type, extract SPS/PPS parameter sets, and repackage an access unit as AVCC (4-byte
/// length prefixes) for VideoToolbox / AVSampleBufferDisplayLayer. Pure byte logic, no
/// platform APIs — same implementation the mirror receiver uses.
public enum AnnexB {
    /// Iterate NAL units: body(payloadOffset, length, nalType).
    public static func forEachNal(_ data: Data, _ body: (Int, Int, Int) -> Void) {
        let bytes = [UInt8](data)
        let n = bytes.count
        var i = 0
        var starts: [Int] = []
        while i + 2 < n {
            if bytes[i] == 0, bytes[i + 1] == 0 {
                if bytes[i + 2] == 1 { starts.append(i + 3); i += 3; continue }
                if i + 3 < n, bytes[i + 2] == 0, bytes[i + 3] == 1 { starts.append(i + 4); i += 4; continue }
            }
            i += 1
        }
        for (idx, s) in starts.enumerated() {
            var end = n
            if idx + 1 < starts.count {
                let next = starts[idx + 1]
                end = next - 3
                if end > 0, bytes[end - 1] == 0 { end -= 1 }
            }
            if s < end { body(s, end - s, Int(bytes[s] & 0x1F)) }
        }
    }

    public static func containsNal(type: Int, in data: Data) -> Bool {
        var found = false
        forEachNal(data) { _, _, t in if t == type { found = true } }
        return found
    }

    /// SPS (type 7) + PPS (type 8) payloads from a config/keyframe buffer.
    public static func parameterSets(from data: Data) -> (sps: Data, pps: Data)? {
        var sps: Data?
        var pps: Data?
        forEachNal(data) { off, len, t in
            if t == 7, sps == nil { sps = data.subdata(in: off ..< off + len) }
            if t == 8, pps == nil { pps = data.subdata(in: off ..< off + len) }
        }
        guard let s = sps, let p = pps else { return nil }
        return (s, p)
    }

    /// Repackage an Annex-B access unit as AVCC (4-byte BE length prefixes), dropping SPS/PPS
    /// NALs (they live in the format description, not the sample).
    public static func toAVCC(_ data: Data) -> Data {
        var out = Data(capacity: data.count + 16)
        forEachNal(data) { off, len, t in
            if t == 7 || t == 8 { return }
            var be = UInt32(len).bigEndian
            withUnsafeBytes(of: &be) { out.append(contentsOf: $0) }
            out.append(data.subdata(in: off ..< off + len))
        }
        return out
    }
}
