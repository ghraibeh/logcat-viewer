/**
 * Mock GPS location — pure, Qt-free layer ported from mocklocation.py.
 *
 * Modern Android (6+) won't accept a mock fix from adb directly — only from an
 * app selected as the system "mock location app". A tiny bundled helper APK
 * (`resources/mocklocation.apk`, source in `../android-helper/`) runs a
 * foreground service and pushes the coordinate to the OS via LocationManager
 * test providers. This module holds the device-free bits so they're unit-tested:
 *
 *  - `setArgs` / `stopArgs`  — the adb argv the service fires (each carries its
 *    own leading `-s <serial>`, exactly like the Python builders),
 *  - coordinate validators + formatters,
 *  - the map's `document.title` bridge parsers (`parseTitle` / `mapLoadedStatus`),
 *  - the preset location list.
 *
 * The coordinate only ever travels Mac -> device over the local adb link.
 */

export const HELPER_PKG = 'com.logcatviewer.mocklocation'
export const SERVICE = `${HELPER_PKG}/.MockService`
export const MOCK_APPOP = 'android:mock_location'

/** Bundled helper APK filename (resolved to a real path by the main service). */
export const HELPER_APK_NAME = 'mocklocation.apk'

// --- number formatting -------------------------------------------------------
/** lat/lng as fixed 7-decimals, mirroring Python's `f"{x:.7f}"`. */
export function fmtCoord(n: number): string {
  return n.toFixed(7)
}

/** Mirror of Python's `format(n, 'g')` (6 significant figures, no trailing
 *  zeros). Only accuracy/altitude go through this. */
export function formatG(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  if (n === 0) return '0'
  const s = n.toPrecision(6)
  const eIdx = s.indexOf('e')
  if (eIdx === -1) {
    return s.indexOf('.') === -1 ? s : s.replace(/\.?0+$/, '')
  }
  const mantissa = s.slice(0, eIdx)
  const exp = s.slice(eIdx)
  const m = mantissa.indexOf('.') === -1 ? mantissa : mantissa.replace(/\.?0+$/, '')
  return m + exp
}

// --- command builders (no device needed → covered by tests) ------------------
/**
 * adb argv (WITH a leading `-s <serial>`, like the Python `set_args`) to
 * start/update the mock at `lat,lng`. lat/lng are passed as **string** extras
 * (`--es`) so full precision survives — `--ef` is a 32-bit float and rounds off.
 */
export function setArgs(
  serial: string,
  lat: number,
  lng: number,
  acc: number | null = null,
  alt: number | null = null
): string[] {
  const args = [
    '-s',
    serial,
    'shell',
    'am',
    'start-foreground-service',
    '-n',
    SERVICE,
    '--es',
    'cmd',
    'set',
    '--es',
    'lat',
    fmtCoord(lat),
    '--es',
    'lng',
    fmtCoord(lng)
  ]
  if (acc !== null) args.push('--es', 'acc', formatG(acc))
  if (alt !== null) args.push('--es', 'alt', formatG(alt))
  return args
}

/** adb argv (WITH a leading `-s <serial>`) to stop mocking and tear down the
 *  test providers (the helper then reacquires a real fix). */
export function stopArgs(serial: string): string[] {
  return ['-s', serial, 'shell', 'am', 'start-foreground-service', '-n', SERVICE, '--es', 'cmd', 'stop']
}

// --- coordinate validators ---------------------------------------------------
export function validLat(lat: number): boolean {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90
}
export function validLng(lng: number): boolean {
  return Number.isFinite(lng) && lng >= -180 && lng <= 180
}
export function validCoord(lat: number, lng: number): boolean {
  return validLat(lat) && validLng(lng)
}

/** Parse a Lat/Lng text field the way Python's `float(edit.text())` does:
 *  trimmed, dot-decimal, `null` if empty or not a finite number. */
export function parseCoordField(text: string): number | null {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

// --- map <-> host bridge parsers ---------------------------------------------
export interface TitlePick {
  lat: number
  lng: number
  seq: number
}

/**
 * Parse the map's picked-coordinate title `MOCKLOC:lat,lng|seq` (mirrors
 * `MockLocationView._on_title`). Returns null for any non-pick / malformed title.
 */
export function parseTitle(title: string): TitlePick | null {
  const PREFIX = 'MOCKLOC:'
  if (!title.startsWith(PREFIX)) return null
  const payload = title.slice(PREFIX.length).split('|', 1)[0]
  const parts = payload.split(',')
  if (parts.length !== 2) return null
  const lat = Number(parts[0])
  const lng = Number(parts[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const bar = title.indexOf('|')
  const seqRaw = bar === -1 ? '' : title.slice(bar + 1)
  const seq = parseInt(seqRaw, 10)
  return { lat, lng, seq: Number.isFinite(seq) ? seq : 0 }
}

/** Parse the map-ready title `MAPLOADED:ok` / `MAPLOADED:err`. Returns
 *  `true`/`false` for a load signal, or `null` for any other title. */
export function mapLoadedStatus(title: string): boolean | null {
  const PREFIX = 'MAPLOADED:'
  if (!title.startsWith(PREFIX)) return null
  return title.slice(PREFIX.length).trim() === 'ok'
}

// --- preset locations --------------------------------------------------------
export interface Preset {
  name: string
  lat: number
  lng: number
}

export const PRESETS: Preset[] = [
  { name: 'San Francisco', lat: 37.7749, lng: -122.4194 },
  { name: 'New York', lat: 40.7128, lng: -74.006 },
  { name: 'London', lat: 51.5074, lng: -0.1278 },
  { name: 'Paris', lat: 48.8566, lng: 2.3522 },
  { name: 'Tokyo', lat: 35.6762, lng: 139.6503 },
  { name: 'Dubai', lat: 25.2048, lng: 55.2708 },
  { name: 'Sydney', lat: -33.8688, lng: 151.2093 }
]
