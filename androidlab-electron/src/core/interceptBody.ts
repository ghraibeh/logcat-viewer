/**
 * Body decode + curl/export presentation for captured flows.
 * Faithful port of intercept.py's `decode_body` / `pretty_body` / `flow_to_curl`
 * / `build_flow_export`. Split out from `intercept.ts` because it uses
 * `node:zlib` — this module is imported ONLY by the main process and the tests
 * (Node environments), never by the sandboxed renderer.
 */
import {
  brotliDecompressSync,
  constants as zlibConstants,
  gunzipSync,
  inflateRawSync,
  inflateSync
} from 'node:zlib'
import { flowUrl, headerGet, humanSize, type Flow } from './intercept'

type Headers = ReadonlyArray<readonly [string, string]>

/**
 * Undo Content-Encoding so text/JSON bodies aren't shown as raw binary.
 * gzip/zstd are detected by magic bytes (so an already-decoded body is left
 * untouched); deflate/brotli fall back to the header. Any failure returns the
 * original bytes — decoding is best-effort and must never raise.
 */
export function decodeBody(body: Uint8Array | null, headers: Headers): Uint8Array | null {
  if (!body || body.length === 0) return body
  const buf = Buffer.from(body)
  const enc = (headerGet(headers, 'Content-Encoding') || '').toLowerCase()
  try {
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      // gzip
      try {
        return gunzipSync(buf)
      } catch {
        // truncated → best effort (tolerate a missing trailer)
        try {
          return gunzipSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH })
        } catch {
          return body
        }
      }
    }
    if (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
      // zstd — matches Python's optional-`zstandard` path: when the codec isn't
      // available the body is left as-is rather than raising.
      return body
    }
    if (enc.includes('deflate')) {
      try {
        return inflateSync(buf)
      } catch {
        try {
          return inflateRawSync(buf)
        } catch {
          return body
        }
      }
    } else if (enc.includes('br')) {
      return brotliDecompressSync(buf)
    }
  } catch {
    return body
  }
  return body
}

/** Decode + pretty-print a body for display (mirrors `pretty_body`). */
export function prettyBody(body: Uint8Array | null, headers: Headers): string {
  if (!body || body.length === 0) return ''
  const decoded = decodeBody(body, headers)
  if (!decoded) return ''
  const buf = Buffer.from(decoded)
  let text: string
  try {
    text = buf.toString('utf8')
    // Buffer.toString never throws; detect undecodable bytes via the replacement
    // char round-trip so binary payloads show as "<N bytes binary>" like Python.
    if (text.includes('�') && !Buffer.from(text, 'utf8').equals(buf)) {
      return `<${buf.length} bytes binary>`
    }
  } catch {
    return `<${buf.length} bytes binary>`
  }
  const ctype = (headerGet(headers, 'Content-Type') || '').toLowerCase()
  if (ctype.includes('json') || text[0] === '{' || text[0] === '[') {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }
  return text
}

/** Build a `curl` command reproducing the request (mirrors `flow_to_curl`). */
export function flowToCurl(f: Flow): string {
  const parts = [`curl -X ${f.method} '${flowUrl(f)}'`]
  for (const [k, v] of f.reqHeaders) {
    const lk = k.toLowerCase()
    if (lk === 'content-length' || lk === 'proxy-connection' || lk === 'connection') continue
    parts.push(`-H '${k}: ${v}'`)
  }
  if (f.reqBody && f.reqBody.length > 0) {
    const buf = Buffer.from(f.reqBody)
    const text = buf.toString('utf8')
    // Only inline a UTF-8-clean body (Python skips on UnicodeDecodeError).
    if (!(text.includes('�') && !Buffer.from(text, 'utf8').equals(buf))) {
      parts.push(`--data-raw '${text}'`)
    }
  }
  return parts.join(' \\\n  ')
}

/**
 * A complete, human-readable dump of one flow: request + response, headers and
 * (decoded) bodies — everything about that URL (mirrors `build_flow_export`).
 */
export function buildFlowExport(f: Flow): string {
  const out: string[] = [`# ${f.method} ${flowUrl(f)}`]
  const meta: string[] = []
  if (f.status !== null) meta.push(`status ${f.status}`)
  if (f.durationMs !== null) meta.push(`${f.durationMs} ms`)
  if (f.respSize) meta.push(humanSize(f.respSize))
  if (meta.length) out.push('# ' + meta.join('  ·  '))

  out.push('', '===== REQUEST =====', `${f.method} ${f.path}  (${f.scheme})`)
  for (const [k, v] of f.reqHeaders) out.push(`${k}: ${v}`)
  const req = prettyBody(f.reqBody, f.reqHeaders)
  if (req) out.push('', req)

  out.push('', '===== RESPONSE =====', f.status !== null ? `HTTP ${f.status}` : '(no response)')
  for (const [k, v] of f.respHeaders) out.push(`${k}: ${v}`)
  if (f.bodyCaptured) {
    const resp = prettyBody(f.respBody, f.respHeaders)
    if (resp) out.push('', resp)
  } else {
    out.push('', f.note || '(encrypted — body not captured)')
  }
  return out.join('\n') + '\n'
}
