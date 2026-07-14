/**
 * Network Intercept — Qt-free, browser-safe helpers.
 * Faithful port of the pure pieces of logcat_viewer/intercept.py:
 *   - TLS/HTTP wire parsing (parseSni / parseHead / splitUrl / parseStatus / headerGet)
 *   - the Flow shape (+ url getter / search field) and the display projection
 *   - FlowFilterSpec (method / status-class / substring|regex filter)
 *   - the pure adb command builders + proxy-restore + device watchdog script
 *   - presentation helpers that need no Node builtins: humanSize, looksJson,
 *     buildJsonTree, headersHtml, method/status color mapping, columns.
 *
 * IMPORTANT: this module must stay import-clean for the renderer bundle (no
 * `node:*` imports). The body-decode / curl / export helpers that need
 * `node:zlib` live in `interceptBody.ts` (main + tests only).
 */

// --- constants ----------------------------------------------------------------
export const DEFAULT_PORT = 8099
export const MAX_BODY = 1_048_576 // capture at most 1 MB of any single body (relay is unbounded)
export const FLOW_CAP = 5000 // ring-buffer of captured flows
export const PEEK_BYTES = 8192 // bytes sniffed from a CONNECT tunnel to read the TLS SNI
export const RELAY_CHUNK = 65536
export const STREAM_LIMIT = 1 << 20 // header buffer ceiling (headers up to 1 MB)

// --- palette (mirrors renderer theme.ts PALETTE — core stays standalone) ------
const C_TEXT = '#e9ebf3'
const C_DIM = '#7e8595'
const C_ACCENT = '#6e7bff'
const C_GREEN = '#31c96e'
const C_AMBER = '#e3a812'
const C_RED = '#f25a52'

// --- pure adb command builders (no device needed → covered by unit tests) -----
/** adb args to tunnel device `127.0.0.1:port` back to the host's port. */
export function reverseArgs(serial: string, port: number): string[] {
  return ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]
}

/** adb args to point the device's global HTTP proxy at the reverse tunnel. */
export function setProxyArgs(serial: string, port: number): string[] {
  return ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', `127.0.0.1:${port}`]
}

/**
 * adb args to disable the global HTTP proxy (`:0` = disabled, no reboot).
 * Preferred over `settings delete` for clearing: on many OEM builds (notably
 * Samsung One UI) *deleting* the row leaves the live proxy applied — apps keep
 * routing through the (now dead) tunnel until Wi-Fi toggles or a reboot.
 */
export function clearProxyArgs(serial: string): string[] {
  return ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0']
}

/** adb args to read the device's current global HTTP proxy (`null` = unset). */
export function getProxyArgs(serial: string): string[] {
  return ['-s', serial, 'shell', 'settings', 'get', 'global', 'http_proxy']
}

// A device proxy value is host:port-ish; anything with shell metacharacters is
// rejected (defence-in-depth, since it's embedded in the on-device shell script).
const SAFE_PROXY = /^[A-Za-z0-9._:\-[\]]+$/

/**
 * The device's genuine prior proxy to restore, or '' if it had none.
 * Empty / `null` / `:0` / our-own `127.0.0.1:` tunnel / anything with unsafe
 * characters → '' (meaning: delete the setting, the true clean state).
 */
export function realProxy(original: string): string {
  const val = (original || '').trim()
  if (
    val &&
    val.toLowerCase() !== 'null' &&
    val !== ':0' &&
    !val.startsWith('127.0.0.1:') &&
    SAFE_PROXY.test(val)
  ) {
    return val
  }
  return ''
}

/**
 * adb args to put the proxy back as it was before we touched it — the prior
 * proxy verbatim, or reliably disable it (`:0`) if the device had none.
 */
export function restoreProxyArgs(serial: string, original: string): string[] {
  const val = realProxy(original)
  if (val) return ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', val]
  return clearProxyArgs(serial)
}

/**
 * The device-shell command that restores the original proxy (or disables it
 * with `:0` if the device had none — never `settings delete`).
 */
export function proxyRestoreCmd(original: string): string {
  const val = realProxy(original)
  return `settings put global http_proxy ${val ? val : ':0'}`
}

/**
 * A tiny device-side script (run over a held-open `adb shell`) that self-heals
 * the proxy when the host goes away without a clean teardown.
 *
 *  - Unclean drop (unplug / reboot / adb-kill / app crash): the held-open shell
 *    loses its host. With a PTY it gets SIGHUP → the trap restores; without one
 *    (adb `shell` allocates none) it only sees stdin EOF → `read` FAILS → the
 *    `|| <restore>` runs. Either path puts the proxy back. Verified on a real
 *    One UI device where SIGHUP is NOT delivered on client death and *only* the
 *    EOF path fires — the earlier `read; trap -` form disarmed and left the
 *    proxy dangling (CLAUDE.md #3 hazard). `exit 0` in the trap keeps a
 *    signal-path restore from also running `||`.
 *  - Normal stop: the app writes one byte to stdin → `read` SUCCEEDS → the
 *    `|| <restore>` is skipped and the script exits WITHOUT restoring (the host
 *    restores synchronously), so a stray trap can't clobber a new session.
 */
export function proxyWatchdogScript(original: string): string {
  const cmd = proxyRestoreCmd(original)
  return `trap '${cmd}; exit 0' HUP INT TERM; read _ 2>/dev/null || ${cmd}`
}

/** adb args to remove the reverse tunnel for `port`. */
export function reverseRemoveArgs(serial: string, port: number): string[] {
  return ['-s', serial, 'reverse', '--remove', `tcp:${port}`]
}

// --- TLS / HTTP wire helpers --------------------------------------------------
/**
 * Best-effort Server Name Indication from a TLS ClientHello. Any malformed
 * input returns null — SNI is a nicety and must never break the tunnel.
 */
export function parseSni(data: Uint8Array): string | null {
  try {
    if (data.length < 43 || data[0] !== 0x16 || data[5] !== 0x01) return null
    const u16 = (i: number): number => (data[i] << 8) | data[i + 1]
    let idx = 5 + 4 // skip record header (5) + handshake type/len (4)
    idx += 2 // client version
    idx += 32 // random
    idx += 1 + data[idx] // session id
    idx += 2 + u16(idx) // cipher suites
    idx += 1 + data[idx] // compression methods
    const extTotal = u16(idx)
    idx += 2
    const end = Math.min(data.length, idx + extTotal)
    while (idx + 4 <= end) {
      const etype = u16(idx)
      const elen = u16(idx + 2)
      idx += 4
      if (etype === 0x0000) {
        // server_name extension
        let p = idx + 2 // skip server_name_list length
        p += 1 // name type (host_name)
        const nlen = u16(p)
        p += 2
        let name = ''
        for (let i = 0; i < nlen && p + i < data.length; i++) name += String.fromCharCode(data[p + i])
        return name || null
      }
      idx += elen
    }
    return null
  } catch {
    return null
  }
}

/** Split an HTTP head into (start-line, [[name, value], ...]). */
export function parseHead(raw: Uint8Array | string): [string, Array<[string, string]>] {
  const buf = typeof raw === 'string' ? Buffer.from(raw, 'latin1') : Buffer.from(raw)
  const sep = buf.indexOf('\r\n\r\n')
  const headPart = sep >= 0 ? buf.subarray(0, sep) : buf
  const text = headPart.toString('latin1')
  const lines = text.split('\r\n')
  const start = lines.length > 0 ? lines[0] : ''
  const headers: Array<[string, string]> = []
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':')
    if (i >= 0) headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()])
  }
  return [start, headers]
}

/** Case-insensitive first-match header lookup (mirrors `_header_get`). */
export function headerGet(headers: ReadonlyArray<readonly [string, string]>, name: string): string | null {
  const low = name.toLowerCase()
  for (const [k, v] of headers) {
    if (k.toLowerCase() === low) return v
  }
  return null
}

/** Parse a proxy absolute-form request target into [scheme, host, port, path]. */
export function splitUrl(target: string): [string, string, number, string] {
  let scheme: string
  let rest: string
  const schemeIdx = target.indexOf('://')
  if (schemeIdx >= 0) {
    scheme = target.slice(0, schemeIdx)
    rest = target.slice(schemeIdx + 3)
  } else {
    scheme = 'http'
    rest = target
  }
  const slash = rest.indexOf('/')
  let hostport: string
  let path: string
  if (slash >= 0) {
    hostport = rest.slice(0, slash)
    path = '/' + rest.slice(slash + 1)
  } else {
    hostport = rest
    path = '/'
  }
  if (hostport.includes('@')) hostport = hostport.split('@').slice(1).join('@')
  const colon = hostport.indexOf(':')
  const host = colon >= 0 ? hostport.slice(0, colon) : hostport
  const portStr = colon >= 0 ? hostport.slice(colon + 1) : ''
  const port = /^\d+$/.test(portStr) ? parseInt(portStr, 10) : scheme === 'https' ? 443 : 80
  return [scheme, host, port, path]
}

/** Parse the numeric status out of an HTTP response start-line, or null. */
export function parseStatus(startLine: string): number | null {
  const parts = startLine.split(' ')
  if (parts.length >= 2 && /^\d+$/.test(parts[1])) return parseInt(parts[1], 10)
  return null
}

// --- captured request/response ------------------------------------------------
/** One captured request/response — the full record held in the main process. */
export interface Flow {
  id: number
  ts: number
  method: string
  scheme: string
  host: string
  port: number
  path: string
  status: number | null
  reqHeaders: Array<[string, string]>
  respHeaders: Array<[string, string]>
  reqSize: number
  respSize: number
  durationMs: number | null
  reqBody: Uint8Array | null
  respBody: Uint8Array | null
  reqTruncated: boolean
  respTruncated: boolean
  bodyCaptured: boolean
  note: string
  search: string
}

export interface MakeFlowInit {
  method?: string
  scheme?: string
  host?: string
  port?: number
  path?: string
  status?: number | null
  reqHeaders?: Array<[string, string]>
  respHeaders?: Array<[string, string]>
  reqSize?: number
  respSize?: number
  durationMs?: number | null
  reqBody?: Uint8Array | null
  respBody?: Uint8Array | null
  reqTruncated?: boolean
  respTruncated?: boolean
  bodyCaptured?: boolean
  note?: string
  ts?: number
}

/** Build a Flow, filling defaults and computing `search` (mirrors Flow.__init__). */
export function makeFlow(init: MakeFlowInit): Flow {
  const host = init.host ?? ''
  const path = init.path ?? '/'
  return {
    id: 0,
    ts: init.ts ?? Date.now() / 1000,
    method: init.method ?? '',
    scheme: init.scheme ?? 'http',
    host,
    port: init.port ?? 80,
    path,
    status: init.status ?? null,
    reqHeaders: init.reqHeaders ?? [],
    respHeaders: init.respHeaders ?? [],
    reqSize: init.reqSize ?? 0,
    respSize: init.respSize ?? 0,
    durationMs: init.durationMs ?? null,
    reqBody: init.reqBody ?? null,
    respBody: init.respBody ?? null,
    reqTruncated: init.reqTruncated ?? false,
    respTruncated: init.respTruncated ?? false,
    bodyCaptured: init.bodyCaptured ?? true,
    note: init.note ?? '',
    search: (host + ' ' + path).toLowerCase()
  }
}

/** The Flow.url property: scheme://host[:port]/path (hides default 80/443). */
export function flowUrl(f: Pick<Flow, 'scheme' | 'host' | 'port' | 'path'>): string {
  const hostport = f.port === 80 || f.port === 443 ? f.host : `${f.host}:${f.port}`
  return `${f.scheme}://${hostport}${f.path}`
}

/**
 * The lightweight projection streamed to the renderer (no body bytes / headers).
 * Everything the flow table + filter need; bodies stay in the main process.
 */
export interface DisplayFlow {
  id: number
  ts: number
  method: string
  scheme: string
  host: string
  port: number
  path: string
  status: number | null
  reqSize: number
  respSize: number
  durationMs: number | null
  contentType: string
  bodyCaptured: boolean
  note: string
  search: string
}

/** Project a full Flow to its display record (Content-Type / tunnel resolved). */
export function toDisplayFlow(f: Flow): DisplayFlow {
  return {
    id: f.id,
    ts: f.ts,
    method: f.method,
    scheme: f.scheme,
    host: f.host,
    port: f.port,
    path: f.path,
    status: f.status,
    reqSize: f.reqSize,
    respSize: f.respSize,
    durationMs: f.durationMs,
    contentType: headerGet(f.respHeaders, 'Content-Type') || (f.bodyCaptured ? '' : 'tunnel'),
    bodyCaptured: f.bodyCaptured,
    note: f.note,
    search: f.search
  }
}

// --- filter -------------------------------------------------------------------
/** The subset of fields FlowFilterSpec.match reads (Flow and DisplayFlow both fit). */
export interface FlowMatchable {
  method: string
  status: number | null
  search: string
}

/** Method / status-class / host+path filter for the flow table. */
export class FlowFilterSpec {
  method: string
  statusClass: number
  textQuery: string
  textRegex: boolean

  private textRe: RegExp | null = null
  errors: Record<string, string> = {}

  constructor(init: { method?: string; statusClass?: number; textQuery?: string; textRegex?: boolean } = {}) {
    this.method = init.method ?? '' // "" = any
    this.statusClass = init.statusClass ?? 0 // 0 = any, else 2/3/4/5 for 2xx..5xx
    this.textQuery = init.textQuery ?? '' // substring or regex over host+path
    this.textRegex = init.textRegex ?? false
  }

  compile(): this {
    this.errors = {}
    this.textRe = null
    if (this.textQuery && this.textRegex) {
      try {
        this.textRe = new RegExp(this.textQuery, 'i')
      } catch (exc) {
        this.errors.text = exc instanceof Error ? exc.message : String(exc)
      }
    }
    return this
  }

  hasError(key: string): boolean {
    return key in this.errors
  }

  match(f: FlowMatchable): boolean {
    if (this.method && f.method.toUpperCase() !== this.method.toUpperCase()) return false
    if (this.statusClass) {
      if (f.status === null || Math.floor(f.status / 100) !== this.statusClass) return false
    }
    if (this.textQuery) {
      if (this.textRe !== null) {
        if (!this.textRe.test(f.search)) return false
      } else if (!this.textRegex) {
        if (!f.search.includes(this.textQuery.toLowerCase())) return false
      }
    }
    return true
  }
}

// --- table columns ------------------------------------------------------------
export const COL_METHOD = 0
export const COL_STATUS = 1
export const COL_SOURCE = 2
export const COL_HOST = 3
export const COL_PATH = 4
export const COL_TYPE = 5
export const COL_SIZE = 6
export const COL_TIME = 7
export const FLOW_HEADERS = ['Method', 'Status', '', 'Host', 'Path', 'Type', 'Size', 'Time']

const METHOD_COLORS: Record<string, string> = {
  GET: C_ACCENT,
  POST: C_GREEN,
  PUT: C_AMBER,
  PATCH: C_AMBER,
  DELETE: C_RED,
  HEAD: C_DIM,
  OPTIONS: C_DIM,
  CONNECT: C_DIM
}

/** Per-method accent color (matches _method_color). */
export function methodColor(method: string): string {
  return METHOD_COLORS[(method || '').toUpperCase()] ?? C_ACCENT
}

/** Per-status color: 5xx red / 4xx amber / 3xx accent / 2xx green / else dim. */
export function statusColor(status: number | null): string {
  if (status === null) return C_DIM
  const map: Record<number, string> = { 5: C_RED, 4: C_AMBER, 3: C_ACCENT, 2: C_GREEN }
  return map[Math.floor(status / 100)] ?? C_DIM
}

/** Per-row accent: status color if known, else accent for https / dim for http. */
export function rowAccent(f: Pick<DisplayFlow, 'status' | 'scheme'>): string {
  if (f.status !== null) return statusColor(f.status)
  return f.scheme === 'https' ? C_ACCENT : C_DIM
}

export const FLOW_TEXT = C_TEXT
export const FLOW_DIM = C_DIM

// --- presentation helpers (no Node builtins) ----------------------------------
/** Human-readable byte size (mirrors `_human_size`). */
export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** Whether `text` parses as a JSON object/array (mirrors `looks_json`). */
export function looksJson(text: string): boolean {
  const t = (text || '').trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return false
  try {
    JSON.parse(t)
    return true
  } catch {
    return false
  }
}

export type JsonKind = 'object' | 'array' | 'string' | 'number' | 'bool' | 'null'
export interface JsonTreeNode {
  key: string
  kind: JsonKind
  /** display text for the value cell (`{N}` / `[N]` / the scalar) */
  text: string
  children?: JsonTreeNode[]
}

function jsonNode(key: string, value: unknown): JsonTreeNode {
  if (Array.isArray(value)) {
    return { key, kind: 'array', text: `[${value.length}]`, children: value.map((v, i) => jsonNode(String(i), v)) }
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return { key, kind: 'object', text: `{${entries.length}}`, children: entries.map(([k, v]) => jsonNode(k, v)) }
  }
  if (typeof value === 'boolean') return { key, kind: 'bool', text: value ? 'true' : 'false' }
  if (value === null) return { key, kind: 'null', text: 'null' }
  if (typeof value === 'string') return { key, kind: 'string', text: value }
  return { key, kind: 'number', text: String(value) }
}

/** Build the collapsible JSON tree structure (mirrors populate_json_tree). */
export function buildJsonTree(text: string): JsonTreeNode[] | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (Array.isArray(data)) return data.map((v, i) => jsonNode(String(i), v))
  if (data !== null && typeof data === 'object') {
    return Object.entries(data as Record<string, unknown>).map(([k, v]) => jsonNode(k, v))
  }
  return [{ key: '', kind: jsonNode('', data).kind, text: jsonNode('', data).text }]
}

/** HTML-escape (mirrors html.escape used by `_headers_html`). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A themed 2-column headers table (mirrors `_headers_html`). */
export function headersHtml(pairs: ReadonlyArray<readonly [string, string]>): string {
  const rows = pairs
    .map(
      ([k, v]) =>
        `<tr><td style="color:${C_DIM};padding:1px 14px 1px 0;white-space:nowrap;vertical-align:top">${escapeHtml(
          k
        )}</td>` + `<td style="color:${C_TEXT};word-break:break-all">${escapeHtml(v)}</td></tr>`
    )
    .join('')
  return `<table style="font-family:Menlo,monospace;font-size:12px;border-collapse:collapse">${rows}</table>`
}
