/**
 * Minimal protobuf wire-format codec — just what the Android Auto message subset needs
 * (varint / bool / enum / string / bytes / nested message / repeated), zero dependencies.
 * Field numbers live in proto.ts; this file is only the wire format.
 */

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

function varintBytes(value: number | bigint): Buffer {
  let v = BigInt(value);
  if (v < 0n) v &= 0xffffffffffffffffn; // negative int32/int64 → 10-byte two's-complement varint
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
  } while (v !== 0n);
  return Buffer.from(out);
}

export class PbWriter {
  private parts: Buffer[] = [];

  /** varint field: int32/int64/uint/enum. */
  varint(field: number, value: number | bigint): this {
    this.parts.push(varintBytes((field << 3) | WIRE_VARINT), varintBytes(value));
    return this;
  }

  bool(field: number, value: boolean): this {
    return this.varint(field, value ? 1 : 0);
  }

  string(field: number, value: string): this {
    return this.bytes(field, Buffer.from(value, 'utf8'));
  }

  bytes(field: number, value: Buffer): this {
    this.parts.push(varintBytes((field << 3) | WIRE_LEN), varintBytes(value.length), value);
    return this;
  }

  /** Nested message (also used for each element of a repeated message field). */
  msg(field: number, value: PbWriter | Buffer): this {
    return this.bytes(field, Buffer.isBuffer(value) ? value : value.finish());
  }

  finish(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export type PbValue = bigint | Buffer;

/**
 * Decode a message into field number → values (repeated fields accumulate in order).
 * varint → bigint; length-delimited → Buffer; fixed32/64 → Buffer (unused by AA subset).
 * Throws on truncated input or deprecated group wire types.
 */
export function decodeFields(buf: Buffer): Map<number, PbValue[]> {
  const out = new Map<number, PbValue[]>();
  let pos = 0;
  const readVarint = (): bigint => {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= buf.length) throw new Error('pb: truncated varint');
      const b = buf[pos++];
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return v;
      shift += 7n;
      if (shift > 63n) throw new Error('pb: varint too long');
    }
  };
  while (pos < buf.length) {
    const tag = Number(readVarint());
    const field = tag >>> 3;
    const wire = tag & 7;
    let value: PbValue;
    switch (wire) {
      case WIRE_VARINT:
        value = readVarint();
        break;
      case WIRE_FIXED64:
        if (pos + 8 > buf.length) throw new Error('pb: truncated fixed64');
        value = buf.subarray(pos, pos + 8);
        pos += 8;
        break;
      case WIRE_LEN: {
        const len = Number(readVarint());
        if (pos + len > buf.length) throw new Error('pb: truncated bytes');
        value = buf.subarray(pos, pos + len);
        pos += len;
        break;
      }
      case WIRE_FIXED32:
        if (pos + 4 > buf.length) throw new Error('pb: truncated fixed32');
        value = buf.subarray(pos, pos + 4);
        pos += 4;
        break;
      default:
        throw new Error(`pb: unsupported wire type ${wire}`);
    }
    const list = out.get(field);
    if (list) list.push(value);
    else out.set(field, [value]);
  }
  return out;
}

/** First varint value of a field, as number (enums, small ints), or undefined. */
export function fieldNum(fields: Map<number, PbValue[]>, field: number): number | undefined {
  const v = fields.get(field)?.[0];
  return typeof v === 'bigint' ? Number(v) : undefined;
}

/** First varint value of a field, as bigint (timestamps), or undefined. */
export function fieldBig(fields: Map<number, PbValue[]>, field: number): bigint | undefined {
  const v = fields.get(field)?.[0];
  return typeof v === 'bigint' ? v : undefined;
}
