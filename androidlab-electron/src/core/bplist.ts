/**
 * Pure-JS Apple property-list reader — the cross-platform replacement for shelling
 * out to macOS `plutil`. iOS `NSUserDefaults` are stored as binary plists
 * (`bplist00`); a few apps write the XML form. `parsePlist` decodes either into
 * plain JS values so the iOS Prefs viewer works on every OS (no `/usr/bin/plutil`
 * dependency) — and, unlike `plutil -convert json`, it doesn't choke on prefs that
 * contain `<data>`/`<date>` values (that conversion errors out, so those files
 * previously failed to load even on macOS).
 *
 * Values come back JSON-ready to match plutil's intended `-convert json` shape:
 * dates → ISO strings, `<data>` → base64 strings, integers/reals → numbers, and
 * dict/array nest as objects/arrays. DOM-/fs-free so it is unit-tested directly
 * (test/bplist.test.ts).
 */

// Seconds between the Unix epoch (1970-01-01) and the CoreFoundation/Cocoa epoch
// (2001-01-01), both UTC. Binary-plist dates are doubles in the CF epoch.
const CF_EPOCH_OFFSET = 978307200

/** Parse a binary or XML property list into JSON-ready JS values. Throws on an
 *  unrecognised format or a malformed buffer. */
export function parsePlist(buf: Buffer): unknown {
  if (buf.length >= 8 && buf.toString('latin1', 0, 6) === 'bplist') {
    return parseBinaryPlist(buf)
  }
  const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).replace(/^﻿/, '').trimStart()
  if (head.startsWith('<?xml') || head.startsWith('<plist') || head.startsWith('<!DOCTYPE plist')) {
    return parseXmlPlist(buf.toString('utf8'))
  }
  throw new Error('not a recognised plist (neither bplist00 nor XML)')
}

// --- binary (bplist00) --------------------------------------------------------

/** Read a big-endian unsigned integer of `size` bytes (size ≤ 6 keeps it within
 *  Number's safe range — used for offsets/refs, which are tiny in practice). */
function readUIntBE(buf: Buffer, offset: number, size: number): number {
  let v = 0
  for (let i = 0; i < size; i++) v = v * 256 + buf[offset + i]
  return v
}

/** Read a plist integer value: 1/2/4 bytes unsigned, 8/16 bytes signed (two's
 *  complement per the CF format). */
function readInt(buf: Buffer, offset: number, size: number): number {
  switch (size) {
    case 1:
      return buf.readUInt8(offset)
    case 2:
      return buf.readUInt16BE(offset)
    case 4:
      return buf.readUInt32BE(offset)
    case 8:
      return Number(buf.readBigInt64BE(offset))
    case 16: {
      const hi = buf.readBigInt64BE(offset)
      const lo = buf.readBigUInt64BE(offset + 8)
      return Number((hi << 64n) + lo)
    }
    default:
      throw new Error(`unsupported int size ${size}`)
  }
}

/** Decode a UTF-16 big-endian string of `units` code units (Node has no native
 *  utf16be); concatenating code units preserves surrogate pairs. */
function utf16beToString(buf: Buffer, start: number, units: number): string {
  let s = ''
  for (let i = 0; i < units; i++) s += String.fromCharCode(buf.readUInt16BE(start + i * 2))
  return s
}

function parseBinaryPlist(buf: Buffer): unknown {
  if (buf.length < 40) throw new Error('binary plist too small')
  const trailer = buf.length - 32
  const offsetIntSize = buf[trailer + 6]
  const objectRefSize = buf[trailer + 7]
  const numObjects = readUIntBE(buf, trailer + 8, 8)
  const topObject = readUIntBE(buf, trailer + 16, 8)
  const offsetTableOffset = readUIntBE(buf, trailer + 24, 8)
  if (!offsetIntSize || !objectRefSize || numObjects <= 0) throw new Error('malformed binary plist trailer')

  const offsetTable = new Array<number>(numObjects)
  for (let i = 0; i < numObjects; i++) {
    offsetTable[i] = readUIntBE(buf, offsetTableOffset + i * offsetIntSize, offsetIntSize)
  }

  // Length of a variable-length object (data/string/array/set/dict). When the
  // marker's low nibble is 0xF the count lives in a following int object.
  const readLength = (off: number, objInfo: number): [count: number, dataOff: number] => {
    if (objInfo !== 0x0f) return [objInfo, off]
    const m = buf[off]
    if ((m & 0xf0) !== 0x10) throw new Error('expected int length marker')
    const n = 1 << (m & 0x0f)
    return [readInt(buf, off + 1, n), off + 1 + n]
  }

  const readRef = (pos: number): number => readUIntBE(buf, pos, objectRefSize)
  const stack = new Set<number>() // guards against a container referencing itself

  const parseObject = (idx: number): unknown => {
    if (idx >= numObjects) throw new Error('object index out of range')
    if (stack.has(idx)) throw new Error('cyclic plist reference')
    let off = offsetTable[idx]
    const marker = buf[off]
    const objType = marker & 0xf0
    const objInfo = marker & 0x0f
    off += 1

    switch (objType) {
      case 0x00: // singletons
        if (marker === 0x08) return false
        if (marker === 0x09) return true
        return null // 0x00 null / 0x0F fill
      case 0x10: // int
        return readInt(buf, off, 1 << objInfo)
      case 0x20: // real
        if (objInfo === 2) return buf.readFloatBE(off)
        if (objInfo === 3) return buf.readDoubleBE(off)
        throw new Error(`unsupported real size ${1 << objInfo}`)
      case 0x30: // date (8-byte double, CF epoch)
        return new Date((buf.readDoubleBE(off) + CF_EPOCH_OFFSET) * 1000).toISOString()
      case 0x40: {
        // data → base64 string
        const [len, dOff] = readLength(off, objInfo)
        return buf.toString('base64', dOff, dOff + len)
      }
      case 0x50: {
        // ASCII string
        const [len, sOff] = readLength(off, objInfo)
        return buf.toString('latin1', sOff, sOff + len)
      }
      case 0x60: {
        // UTF-16BE string (count is in UTF-16 code units)
        const [len, sOff] = readLength(off, objInfo)
        return utf16beToString(buf, sOff, len)
      }
      case 0x80: // UID (CF$UID) — rare in prefs; keep it visible as an object
        return { UID: readUIntBE(buf, off, objInfo + 1) }
      case 0xa0:
      case 0xc0: {
        // array / set → array
        const [count, aOff] = readLength(off, objInfo)
        const arr: unknown[] = []
        stack.add(idx)
        for (let i = 0; i < count; i++) arr.push(parseObject(readRef(aOff + i * objectRefSize)))
        stack.delete(idx)
        return arr
      }
      case 0xd0: {
        // dict: `count` key refs followed by `count` value refs
        const [count, kOff] = readLength(off, objInfo)
        const vOff = kOff + count * objectRefSize
        const obj: Record<string, unknown> = {}
        stack.add(idx)
        for (let i = 0; i < count; i++) {
          const key = parseObject(readRef(kOff + i * objectRefSize))
          obj[String(key)] = parseObject(readRef(vOff + i * objectRefSize))
        }
        stack.delete(idx)
        return obj
      }
      default:
        throw new Error(`unknown plist object type 0x${objType.toString(16)}`)
    }
  }

  return parseObject(topObject)
}

// --- XML plist (fallback) -----------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&') // last, so decoded text isn't re-decoded
}

interface XmlTag {
  name: string
  close: boolean
  selfClose: boolean
}

/** Minimal XML property-list parser — covers the standard element set. Binary is
 *  the common on-device form; this handles apps that wrote the XML variant. */
function parseXmlPlist(xml: string): unknown {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '')
  const len = body.length
  let i = 0

  const readTag = (): XmlTag | null => {
    for (;;) {
      const lt = body.indexOf('<', i)
      if (lt < 0) {
        i = len
        return null
      }
      const gt = body.indexOf('>', lt)
      if (gt < 0) {
        i = len
        return null
      }
      let raw = body.slice(lt + 1, gt).trim()
      i = gt + 1
      if (raw.startsWith('?') || raw.startsWith('!')) continue // prolog / doctype
      const selfClose = raw.endsWith('/')
      if (selfClose) raw = raw.slice(0, -1).trim()
      const close = raw.startsWith('/')
      if (close) raw = raw.slice(1).trim()
      return { name: raw.split(/\s/)[0], close, selfClose }
    }
  }

  // Text content between the just-consumed open tag and its matching close tag.
  const readText = (tag: string): string => {
    const closeIdx = body.indexOf('</' + tag, i)
    const end = closeIdx < 0 ? len : closeIdx
    const text = body.slice(i, end)
    i = closeIdx < 0 ? len : body.indexOf('>', closeIdx) + 1
    return decodeEntities(text.trim())
  }

  const valueFromOpenTag = (tag: XmlTag): unknown => {
    if (tag.selfClose) {
      switch (tag.name) {
        case 'true':
          return true
        case 'false':
          return false
        case 'dict':
          return {}
        case 'array':
          return []
        default:
          return '' // <string/> / <data/> etc.
      }
    }
    switch (tag.name) {
      case 'true':
        return true
      case 'false':
        return false
      case 'string':
        return readText('string')
      case 'integer':
        return parseInt(readText('integer'), 10)
      case 'real':
        return parseFloat(readText('real'))
      case 'date':
        return readText('date')
      case 'data':
        return readText('data').replace(/\s+/g, '')
      case 'dict':
        return parseDict()
      case 'array':
        return parseArray()
      default:
        throw new Error(`unexpected plist element <${tag.name}>`)
    }
  }

  const parseNextValue = (): unknown => {
    const tag = readTag()
    if (!tag) throw new Error('unexpected end of plist')
    return valueFromOpenTag(tag)
  }

  function parseDict(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (;;) {
      const t = readTag()
      if (!t) throw new Error('unterminated <dict>')
      if (t.close && t.name === 'dict') return out
      if (t.name !== 'key') throw new Error('expected <key> in <dict>')
      const key = readText('key')
      out[key] = parseNextValue()
    }
  }

  function parseArray(): unknown[] {
    const out: unknown[] = []
    for (;;) {
      const save = i
      const t = readTag()
      if (!t) throw new Error('unterminated <array>')
      if (t.close && t.name === 'array') return out
      i = save // rewind and parse this element as a value
      out.push(parseNextValue())
    }
  }

  for (;;) {
    const t = readTag()
    if (!t) throw new Error('no <plist> root')
    if (t.name === 'plist' && !t.close) break
  }
  return parseNextValue()
}
