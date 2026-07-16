/**
 * Android Device-Info aggregation for the visual "About this device" tab (the
 * first tab when an Android device is selected). Pure parsers over ONE batched
 * `adb shell` probe — `getprop`, `dumpsys battery`, `df`, `/proc/meminfo`,
 * `wm size`/`wm density`, `ip route`, `/proc/uptime`, `uname` — split apart by
 * `@@key@@` markers (the same trick controls.ts uses to read every toggle in a
 * single round-trip). DOM-/adb-free so it's unit-tested; device I/O lives in
 * main/services/deviceinfo.ts. This mirrors the iOS iosdeviceinfo.ts shape so the
 * shared Device Info dashboard renders both platforms from one component.
 */
import { parseDeviceIp } from './wireless'

export interface AndroidStorage {
  totalBytes: number
  freeBytes: number
}
export interface AndroidBattery {
  level: number
  status: string
  health: string
  tempC: number | null
  voltageV: number | null
  technology: string
  charging: boolean
}
export interface AndroidDeviceInfo {
  name: string
  model: string
  manufacturer: string
  brand: string
  device: string
  androidVersion: string
  androidName: string
  sdk: string
  buildId: string
  fingerprint: string
  securityPatch: string
  abi: string
  hardware: string
  board: string
  bootloader: string
  buildType: string
  buildTags: string
  kernel: string
  serial: string
  chip: string
  radio: string
  ram: string
  ramBytes: number | null
  resolution: string
  density: string
  display: string
  ip: string
  carrier: string
  simState: string
  telephony: boolean
  encryption: string
  uptime: string
  storage: AndroidStorage | null
  battery: AndroidBattery | null
  /** Curated extra rows for the "All details" grid: [label, value]. */
  details: Array<[string, string]>
}

// Each section is prefixed on-device with `echo @@key@@` and parsed back apart —
// one adb round-trip for the whole dashboard.
const READS: Array<[string, string]> = [
  ['props', 'getprop'],
  ['battery', 'dumpsys battery'],
  ['storage', 'df -k /data'],
  ['mem', 'cat /proc/meminfo'],
  ['size', 'wm size'],
  ['density', 'wm density'],
  ['route', 'ip route'],
  ['uptime', 'cat /proc/uptime'],
  ['kernel', 'uname -a'],
  ['devname', 'settings get global device_name']
]

/** The one-round-trip shell probe (mirrors controls.readStateScript). */
export function buildProbe(): string {
  return READS.map(([k, cmd]) => `echo @@${k}@@; ${cmd} 2>/dev/null`).join('; ')
}

/** Split the marker-delimited probe output back into its sections. */
export function splitSections(text: string): Record<string, string> {
  const raw: Record<string, string> = {}
  let key: string | null = null
  for (const line of text.split('\n')) {
    const m = /^@@(\w+)@@\s*$/.exec(line.trim())
    if (m) {
      key = m[1]
      raw[key] = ''
    } else if (key !== null) {
      raw[key] += line + '\n'
    }
  }
  const out: Record<string, string> = {}
  for (const k of Object.keys(raw)) out[k] = raw[k].trim()
  return out
}

/** `[key]: [value]` getprop lines → a flat map. */
export function parseGetprop(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\[([^\]]+)\]:\s*\[(.*)\]$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

const BATTERY_STATUS: Record<string, string> = {
  '1': 'Unknown',
  '2': 'Charging',
  '3': 'Discharging',
  '4': 'Not charging',
  '5': 'Full'
}
const BATTERY_HEALTH: Record<string, string> = {
  '1': 'Unknown',
  '2': 'Good',
  '3': 'Overheating',
  '4': 'Dead',
  '5': 'Over voltage',
  '6': 'Failure',
  '7': 'Cold'
}

export function parseBattery(text: string): AndroidBattery | null {
  const level = /^\s*level:\s*(\d+)/m.exec(text)
  if (!level) return null
  const statusN = /^\s*status:\s*(\d+)/m.exec(text)
  const healthN = /^\s*health:\s*(\d+)/m.exec(text)
  const temp = /^\s*temperature:\s*(-?\d+)/m.exec(text)
  const volt = /^\s*voltage:\s*(\d+)/m.exec(text)
  const tech = /^\s*technology:\s*(.+)$/m.exec(text)
  return {
    level: parseInt(level[1], 10),
    status: statusN ? (BATTERY_STATUS[statusN[1]] ?? '') : '',
    health: healthN ? (BATTERY_HEALTH[healthN[1]] ?? '') : '',
    tempC: temp ? parseInt(temp[1], 10) / 10 : null,
    // dumpsys reports mV (~4300) on phones, occasionally µV on some tablets.
    voltageV: volt ? mvToVolts(parseInt(volt[1], 10)) : null,
    technology: tech ? tech[1].trim() : '',
    charging:
      (statusN && (statusN[1] === '2' || statusN[1] === '5')) ||
      /(AC|USB|Wireless) powered:\s*true/.test(text)
  }
}

function mvToVolts(v: number): number {
  const volts = v > 100000 ? v / 1_000_000 : v / 1000
  return Math.round(volts * 100) / 100
}

/** The `/data` row of `df -k` → bytes. Prefers the row mounted under /data
 *  (Samsung/One UI reports it as `/data/user/0`), falling back to the first
 *  numeric row. Tolerates the long-filesystem wrap (the size columns land on the
 *  continuation line with the mount point). */
export function parseStorage(text: string): AndroidStorage | null {
  const rowRe = /(\d+)\s+(\d+)\s+(\d+)\s+\d+%?\s+(\/\S*)/g
  let best: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(text)) !== null) {
    if (m[4].startsWith('/data')) {
      best = m
      break
    }
    if (!best) best = m
  }
  if (!best) return null
  const total = parseInt(best[1], 10) * 1024
  const free = parseInt(best[3], 10) * 1024
  if (!total) return null
  return { totalBytes: total, freeBytes: free }
}

/** MemTotal (kB) from /proc/meminfo → bytes. */
export function parseRamBytes(text: string): number | null {
  const m = /MemTotal:\s*(\d+)\s*kB/i.exec(text)
  return m ? parseInt(m[1], 10) * 1024 : null
}

/** `wm size` → "WxH" (prefers an Override size when one is set). */
export function parseResolution(text: string): string {
  const over = /Override size:\s*(\d+)x(\d+)/i.exec(text)
  const phys = /Physical size:\s*(\d+)x(\d+)/i.exec(text)
  const m = over ?? phys
  return m ? `${m[1]} × ${m[2]}` : ''
}

/** `wm density` → "NNN dpi" (prefers an Override density). */
export function parseDensity(text: string): string {
  const over = /Override density:\s*(\d+)/i.exec(text)
  const phys = /Physical density:\s*(\d+)/i.exec(text)
  const m = over ?? phys
  return m ? `${m[1]} dpi` : ''
}

/** First `/proc/uptime` field (seconds) → "1d 2h 33m". */
export function parseUptime(text: string): string {
  const m = /^\s*([\d.]+)/.exec(text)
  if (!m) return ''
  const s = Math.floor(parseFloat(m[1]))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  parts.push(`${mm}m`)
  return parts.join(' ')
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s
}

/** Trim trailing separators from dual-SIM carrier strings ("Zain JO," → "Zain JO"). */
function cleanCarrier(s: string): string {
  return s.replace(/[,\s]+$/g, '').trim()
}

/** Collapse a dual-SIM value that just repeats the same token ("X,X" → "X"). */
function dedupeCsv(s: string): string {
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean)
  return parts.every((x) => x === parts[0]) ? (parts[0] ?? '') : parts.join(', ')
}

/** Aggregate the batched probe output into a display-ready AndroidDeviceInfo.
 *  `fallbackSerial` is the adb serial, used when ro.serialno is unreadable
 *  (Android 8+ hides it from apps but the adb transport serial always works). */
export function parseDeviceInfo(raw: string, fallbackSerial = ''): AndroidDeviceInfo {
  const s = splitSections(raw)
  const p = parseGetprop(s.props ?? '')
  const g = (k: string): string => p[k] ?? ''

  const model = g('ro.product.model')
  const manufacturer = g('ro.product.manufacturer')
  const brand = g('ro.product.brand')
  const androidVersion = g('ro.build.version.release')
  const sdk = g('ro.build.version.sdk')

  const devName = (s.devname ?? '').trim()
  const name = devName && devName.toLowerCase() !== 'null' ? devName : model || cap(manufacturer)

  const soc = [g('ro.soc.manufacturer'), g('ro.soc.model')].map((x) => x.trim()).filter(Boolean).join(' ')
  const chip = soc || g('ro.board.platform') || g('ro.hardware')

  const ramBytes = parseRamBytes(s.mem ?? '')
  const resolution = parseResolution(s.size ?? '')
  const density = parseDensity(s.density ?? '')
  const carrier = cleanCarrier(g('gsm.operator.alpha'))
  const simState = cleanCarrier(g('gsm.sim.state'))
  const radio = dedupeCsv(g('gsm.version.baseband') || g('ro.baseband'))
  const serial = g('ro.serialno') || fallbackSerial
  const kernel = (s.kernel ?? '').trim()
  const kernelRelease = /\b(\d+\.\d+\.\d+\S*)/.exec(kernel)?.[1] ?? kernel

  const details: Array<[string, string]> = [
    ['Manufacturer', cap(manufacturer)],
    ['Model', model],
    ['Codename', g('ro.product.device')],
    ['Brand', cap(brand)],
    ['Android version', androidVersion ? `${androidVersion} (API ${sdk})` : ''],
    ['Build number', g('ro.build.display.id') || g('ro.build.id')],
    ['Security patch', g('ro.build.version.security_patch')],
    ['Build type', [g('ro.build.type'), g('ro.build.tags')].filter(Boolean).join(' · ')],
    ['Fingerprint', g('ro.build.fingerprint')],
    ['Kernel', kernelRelease],
    ['Bootloader', g('ro.bootloader')],
    ['Baseband', radio],
    ['SoC', soc],
    ['CPU ABI', g('ro.product.cpu.abi')],
    ['Hardware', g('ro.hardware')],
    ['Serial number', serial],
    ['Encryption', cap(g('ro.crypto.state'))],
    ['Uptime', parseUptime(s.uptime ?? '')]
  ].filter(([, v]) => v !== '') as Array<[string, string]>

  return {
    name,
    model,
    manufacturer: cap(manufacturer),
    brand: cap(brand),
    device: g('ro.product.device'),
    androidVersion,
    androidName: androidVersion ? `Android ${androidVersion}` : '',
    sdk,
    buildId: g('ro.build.display.id') || g('ro.build.id'),
    fingerprint: g('ro.build.fingerprint'),
    securityPatch: g('ro.build.version.security_patch'),
    abi: g('ro.product.cpu.abi'),
    hardware: g('ro.hardware'),
    board: g('ro.product.board') || g('ro.board.platform'),
    bootloader: g('ro.bootloader'),
    buildType: g('ro.build.type'),
    buildTags: g('ro.build.tags'),
    kernel: kernelRelease,
    serial,
    chip,
    radio,
    ram: ramBytes ? fmtRam(ramBytes) : '',
    ramBytes,
    resolution,
    density,
    display: [resolution, density].filter(Boolean).join(' · '),
    ip: parseDeviceIp(s.route ?? '') ?? '',
    carrier,
    simState,
    telephony: !!(carrier || (simState && !/^absent$/i.test(simState))),
    encryption: cap(g('ro.crypto.state')),
    uptime: parseUptime(s.uptime ?? ''),
    storage: parseStorage(s.storage ?? ''),
    battery: parseBattery(s.battery ?? ''),
    details
  }
}

/** Human GB string, e.g. 8231301120 → "8 GB" (binary GiB, Settings-style). */
export function fmtGB(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`
}

// Standard shipped RAM sizes; MemTotal always under-reports (the kernel + secure
// carveouts reserve a few hundred MB), so an 8 GB phone reads ~7.25 GiB.
const RAM_SIZES = [1, 2, 3, 4, 6, 8, 12, 16, 18, 24, 32]

/** RAM string that snaps MemTotal up to the marketed size when it's within reach
 *  (7.25 GiB → "8 GB"), else falls back to a plain rounded GiB. */
export function fmtRam(bytes: number): string {
  const gib = bytes / 1024 ** 3
  const nominal = RAM_SIZES.find((s) => s >= gib && s - gib <= 1.25)
  return `${nominal ?? Math.round(gib)} GB`
}
