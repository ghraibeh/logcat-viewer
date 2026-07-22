import Foundation

/// Minimal protobuf wire-format codec — just what the Android Auto message subset needs
/// (varint / bool / enum / string / bytes / nested message / repeated), zero dependencies.
/// The Swift twin of the Electron head unit's `pb.ts`. Field numbers live in `AapMessages`;
/// this file is only the wire format.
public final class PbWriter {
    private var parts: [UInt8] = []

    private static let wireVarint = 0
    private static let wireLen = 2

    public init() {}

    private func appendVarint(_ value: UInt64) {
        var v = value
        repeat {
            var b = UInt8(v & 0x7f)
            v >>= 7
            if v != 0 { b |= 0x80 }
            parts.append(b)
        } while v != 0
    }

    /// varint field: int32/int64/uint/enum. Negative values become 10-byte two's-complement.
    @discardableResult public func varint(_ field: Int, _ value: Int) -> PbWriter {
        appendVarint(UInt64(bitPattern: Int64(field << 3 | Self.wireVarint)))
        appendVarint(UInt64(bitPattern: Int64(value)))
        return self
    }

    @discardableResult public func varint(_ field: Int, _ value: UInt64) -> PbWriter {
        appendVarint(UInt64(field << 3 | Self.wireVarint))
        appendVarint(value)
        return self
    }

    @discardableResult public func bool(_ field: Int, _ value: Bool) -> PbWriter {
        varint(field, value ? 1 : 0)
    }

    @discardableResult public func string(_ field: Int, _ value: String) -> PbWriter {
        bytes(field, Array(value.utf8))
    }

    @discardableResult public func bytes(_ field: Int, _ value: [UInt8]) -> PbWriter {
        appendVarint(UInt64(field << 3 | Self.wireLen))
        appendVarint(UInt64(value.count))
        parts.append(contentsOf: value)
        return self
    }

    /// Nested message (also used for each element of a repeated message field).
    @discardableResult public func msg(_ field: Int, _ value: PbWriter) -> PbWriter {
        bytes(field, value.finish())
    }

    public func finish() -> [UInt8] { parts }
}

/// A decoded protobuf value: varint → UInt64; length-delimited → bytes.
public enum PbValue {
    case varint(UInt64)
    case bytes([UInt8])
}

/// Decode a message into field number → values (repeated fields accumulate in order).
/// Throws on truncated input or unsupported (group) wire types. Mirrors `decodeFields` in pb.ts.
public func decodeFields(_ buf: [UInt8]) throws -> [Int: [PbValue]] {
    var out: [Int: [PbValue]] = [:]
    var pos = 0

    func readVarint() throws -> UInt64 {
        var v: UInt64 = 0
        var shift: UInt64 = 0
        while true {
            if pos >= buf.count { throw PbError.truncated("varint") }
            let b = buf[pos]; pos += 1
            v |= UInt64(b & 0x7f) << shift
            if b & 0x80 == 0 { return v }
            shift += 7
            if shift > 63 { throw PbError.truncated("varint too long") }
        }
    }

    while pos < buf.count {
        let tag = Int(try readVarint())
        let field = tag >> 3
        let wire = tag & 7
        let value: PbValue
        switch wire {
        case 0:
            value = .varint(try readVarint())
        case 1: // fixed64
            guard pos + 8 <= buf.count else { throw PbError.truncated("fixed64") }
            value = .bytes(Array(buf[pos ..< pos + 8])); pos += 8
        case 2: // length-delimited
            let len = Int(try readVarint())
            guard pos + len <= buf.count else { throw PbError.truncated("bytes") }
            value = .bytes(Array(buf[pos ..< pos + len])); pos += len
        case 5: // fixed32
            guard pos + 4 <= buf.count else { throw PbError.truncated("fixed32") }
            value = .bytes(Array(buf[pos ..< pos + 4])); pos += 4
        default:
            throw PbError.unsupportedWire(wire)
        }
        out[field, default: []].append(value)
    }
    return out
}

public enum PbError: Error {
    case truncated(String)
    case unsupportedWire(Int)
}

public extension Dictionary where Key == Int, Value == [PbValue] {
    /// First varint value of a field, as Int (enums, small ints), or nil.
    func num(_ field: Int) -> Int? {
        if case .varint(let v)? = self[field]?.first { return Int(bitPattern: UInt(v)) }
        return nil
    }
    /// First varint value of a field, as UInt64 (timestamps), or nil.
    func big(_ field: Int) -> UInt64? {
        if case .varint(let v)? = self[field]?.first { return v }
        return nil
    }
    /// First length-delimited value decoded as a UTF-8 string, or nil.
    func str(_ field: Int) -> String? {
        if case .bytes(let b)? = self[field]?.first { return String(decoding: b, as: UTF8.self) }
        return nil
    }
}
