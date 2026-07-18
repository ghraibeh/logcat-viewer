/**
 * go-ios pure helpers — the iOS counterpart to core/appmgr.ts. Parsers and arg
 * builders for `ios list` / `ios info` / `ios apps`, plus a JSON-loose reader
 * that tolerates go-ios's structured log lines mixed onto stdout. DOM-/fs-/spawn-
 * free so it is unit-tested directly; the device I/O lives in
 * main/services/goios.ts.
 *
 * go-ios targets a device with a global `--udid <udid>` flag (the equivalent of
 * adb's `-s <serial>`); every builder that needs a device embeds it. Unlike adb,
 * the "serial" is the device UDID and there is no `shell` — each capability is a
 * discrete go-ios sub-command.
 */

import type { Battery } from './monitor'

// The three application classes `ios apps --all` reports; anything else is unknown.
export type IosAppType = 'User' | 'System' | 'Hidden' | 'Unknown'

/** One installed iOS app, distilled from an `ios apps` Info.plist entry. */
export interface IosAppInfo {
  bundleId: string
  name: string
  /** CFBundleShortVersionString (the marketing version). */
  version: string
  /** CFBundleVersion (the build number). */
  build: string
  type: IosAppType
  minOS: string
  signer: string
  path: string
  /** Data-container path (present for User apps). */
  container: string
  /** [friendly label, description] of each declared NS*UsageDescription privacy
   *  string — iOS's static declaration of what the app says it uses. */
  usage: Array<[string, string]>
}

/** Fields read off `ios info` to describe a connected device. */
export interface IosDeviceFields {
  name: string
  /** ProductType, e.g. "iPhone16,2". */
  model: string
  /** ProductVersion, e.g. "26.5.2". */
  version: string
}

/** Device network addresses from `ios ip` (a pcapd sniff of the device's own
 *  traffic). Any field the sniff couldn't determine is an empty string. */
export interface IosNetworkInfo {
  /** Wi-Fi/LAN IPv4, e.g. "192.168.1.42" ('' when idle, off Wi-Fi, or timed out). */
  ipv4: string
  /** IPv6 address if one was observed ('' otherwise). */
  ipv6: string
  /** Hardware Wi-Fi MAC (lockdown WiFiAddress). */
  mac: string
}

// --- JSON-loose reader --------------------------------------------------------
/** Parse every JSON value on stdout. go-ios normally prints one JSON document,
 *  but depending on log level it can prepend structured log lines; try the whole
 *  buffer first, then fall back to scanning line-by-line and keeping what parses. */
function jsonValues(stdout: string): unknown[] {
  const text = (stdout ?? '').trim()
  if (!text) return []
  try {
    return [JSON.parse(text)]
  } catch {
    /* mixed log lines — scan below */
  }
  const vals: unknown[] = []
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    if (!s || (s[0] !== '{' && s[0] !== '[')) continue
    try {
      vals.push(JSON.parse(s))
    } catch {
      /* skip non-JSON noise */
    }
  }
  return vals
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  return typeof v === 'string' ? v : ''
}

// --- device parsers -----------------------------------------------------------
/** Transport a usbmuxd entry reaches the device over. 'wifi' entries appear once
 *  the device's "Show when on Wi-Fi" lockdown value is enabled (see
 *  wifiConnectionsArgs) and it's on the same network as this host. */
export type IosConnection = 'usb' | 'wifi'

export interface IosDeviceEntry {
  udid: string
  /** Every transport this UDID is currently listed on ('usb' before 'wifi'). */
  transports: IosConnection[]
}

/** Entries from `ios list --details` → {"deviceList":[{Udid, ConnectionType, …}]}.
 *  A device visible over both cable and Wi-Fi shows one usbmuxd entry per
 *  transport (ConnectionType "USB" + "Network"); we group them by UDID and
 *  collect the transports so the picker can offer both (USB listed first). */
export function parseDeviceListDetails(stdout: string): IosDeviceEntry[] {
  const byUdid = new Map<string, Set<IosConnection>>()
  const order: string[] = []
  for (const v of jsonValues(stdout)) {
    if (!isObj(v) || !Array.isArray(v.deviceList)) continue
    for (const e of v.deviceList as unknown[]) {
      if (!isObj(e)) continue
      const udid = str(e, 'Udid')
      if (!udid) continue
      const conn: IosConnection = str(e, 'ConnectionType') === 'Network' ? 'wifi' : 'usb'
      if (!byUdid.has(udid)) {
        byUdid.set(udid, new Set())
        order.push(udid)
      }
      byUdid.get(udid)!.add(conn)
    }
  }
  return order.map((udid) => {
    const set = byUdid.get(udid)!
    const transports: IosConnection[] = []
    if (set.has('usb')) transports.push('usb')
    if (set.has('wifi')) transports.push('wifi')
    return { udid, transports }
  })
}

/** `ios wificonnections` output → the resulting EnableWifiConnections state
 *  ({"EnableWifiConnections": bool}), or null if the command failed. */
export function parseWifiConnections(stdout: string): boolean | null {
  for (const v of jsonValues(stdout)) {
    if (isObj(v) && typeof v.EnableWifiConnections === 'boolean') return v.EnableWifiConnections
  }
  return null
}

/** Distil an `ios info` document to the fields we label a device with. */
export function parseInfo(stdout: string): IosDeviceFields | null {
  for (const v of jsonValues(stdout)) {
    if (isObj(v) && ('ProductVersion' in v || 'DeviceName' in v)) {
      return { name: str(v, 'DeviceName'), model: str(v, 'ProductType'), version: str(v, 'ProductVersion') }
    }
  }
  return null
}

/** Parse `ios ip` output — {"Mac":…,"IPv4":…,"IPv6":…} — into IosNetworkInfo.
 *  Fields the sniff couldn't fill come back as empty strings. */
export function parseNetworkInfo(stdout: string): IosNetworkInfo {
  for (const v of jsonValues(stdout)) {
    if (isObj(v) && ('IPv4' in v || 'IPv6' in v || 'Mac' in v)) {
      return { ipv4: str(v, 'IPv4'), ipv6: str(v, 'IPv6'), mac: str(v, 'Mac') }
    }
  }
  return { ipv4: '', ipv6: '', mac: '' }
}

/** Human label + description for a device, mirroring adb.ts's "<id> — <desc>". */
export function deviceLabel(udid: string, f: IosDeviceFields | null): { label: string; description: string } {
  if (!f) return { label: udid, description: '' }
  const name = f.name || udid
  const description = [f.model, f.version ? `iOS ${f.version}` : ''].filter(Boolean).join(' · ')
  return { label: description ? `${name} — ${description}` : name, description }
}

// --- app parsers --------------------------------------------------------------
// NS*UsageDescription Info.plist keys → a friendly capability label. This is the
// app's *declared* (static) privacy footprint — iOS has no adb-style runtime
// permission dump, so this is the closest honest analogue for the Info panel.
const USAGE_LABELS: Record<string, string> = {
  NSCameraUsageDescription: 'Camera',
  NSMicrophoneUsageDescription: 'Microphone',
  NSPhotoLibraryUsageDescription: 'Photos',
  NSPhotoLibraryAddUsageDescription: 'Photos (add only)',
  NSContactsUsageDescription: 'Contacts',
  NSLocationWhenInUseUsageDescription: 'Location (in use)',
  NSLocationAlwaysUsageDescription: 'Location (always)',
  NSLocationAlwaysAndWhenInUseUsageDescription: 'Location (always)',
  NSCalendarsUsageDescription: 'Calendars',
  NSCalendarsFullAccessUsageDescription: 'Calendars',
  NSRemindersUsageDescription: 'Reminders',
  NSRemindersFullAccessUsageDescription: 'Reminders',
  NSMotionUsageDescription: 'Motion & fitness',
  NSFaceIDUsageDescription: 'Face ID',
  NSBluetoothAlwaysUsageDescription: 'Bluetooth',
  NSBluetoothPeripheralUsageDescription: 'Bluetooth',
  NSLocalNetworkUsageDescription: 'Local network',
  NSAppleMusicUsageDescription: 'Media library',
  NSSpeechRecognitionUsageDescription: 'Speech recognition',
  NSHealthShareUsageDescription: 'Health (read)',
  NSHealthUpdateUsageDescription: 'Health (write)',
  NSUserTrackingUsageDescription: 'Tracking (App Tracking Transparency)'
}

function parseUsage(o: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const seen = new Set<string>()
  for (const [key, label] of Object.entries(USAGE_LABELS)) {
    if (typeof o[key] === 'string' && !seen.has(label)) {
      seen.add(label)
      out.push([label, (o[key] as string).trim()])
    }
  }
  return out
}

function normType(t: unknown): IosAppType {
  return t === 'User' || t === 'System' || t === 'Hidden' ? t : 'Unknown'
}

/** Parse an `ios apps [--all|--system]` array into sorted IosAppInfo rows. */
export function parseApps(stdout: string): IosAppInfo[] {
  let arr: unknown[] | null = null
  for (const v of jsonValues(stdout)) {
    if (Array.isArray(v)) {
      arr = v
      break
    }
  }
  if (!arr) return []
  const out: IosAppInfo[] = []
  for (const item of arr) {
    if (!isObj(item)) continue
    const bundleId = str(item, 'CFBundleIdentifier')
    if (!bundleId) continue
    out.push({
      bundleId,
      name: str(item, 'CFBundleDisplayName') || str(item, 'CFBundleName') || bundleId,
      version: str(item, 'CFBundleShortVersionString'),
      build: str(item, 'CFBundleVersion'),
      type: normType(item.ApplicationType),
      minOS: str(item, 'MinimumOSVersion'),
      signer: str(item, 'SignerIdentity'),
      path: str(item, 'Path'),
      container: str(item, 'Container'),
      usage: parseUsage(item)
    })
  }
  out.sort((a, b) => {
    const la = a.name.toLowerCase()
    const lb = b.name.toLowerCase()
    return la < lb ? -1 : la > lb ? 1 : 0
  })
  return out
}

// --- command builders ---------------------------------------------------------
/** `--details` carries each entry's ConnectionType (USB vs Wi-Fi) — see
 *  parseDeviceListDetails. */
export function listArgs(): string[] {
  return ['list', '--details']
}

/** Get/flip the "Show this device when on Wi-Fi" lockdown value (our patched
 *  go-ios `wificonnections` command). Always prints the resulting state. */
export function wifiConnectionsArgs(udid: string, op: 'get' | 'enable' | 'disable'): string[] {
  return ['wificonnections', op, '--udid', udid]
}

export function infoArgs(udid: string): string[] {
  return ['info', '--udid', udid]
}

/** `ios ip` — sniff the device's live packet capture to report its Wi-Fi IP.
 *  Classic-tier (no developer tunnel); our patched go-ios bounds it with an
 *  internal timeout and returns its best guess rather than blocking. */
export function ipArgs(udid: string): string[] {
  return ['ip', '--udid', udid]
}

export function appsArgs(udid: string, kind: 'user' | 'system' | 'all' = 'all'): string[] {
  const flags = kind === 'all' ? ['--all'] : kind === 'system' ? ['--system'] : []
  return ['apps', ...flags, '--udid', udid]
}

export function installArgs(udid: string, ipaPath: string): string[] {
  return ['install', `--path=${ipaPath}`, '--udid', udid]
}

export function uninstallArgs(udid: string, bundleId: string): string[] {
  return ['uninstall', bundleId, '--udid', udid]
}

// The iOS Info sub-panel rows: [label, IosAppInfo key]. Mirrors appmgr INFO_ROWS.
export const IOS_INFO_ROWS: Array<[string, keyof IosAppInfo]> = [
  ['Name', 'name'],
  ['Bundle ID', 'bundleId'],
  ['Version', 'version'],
  ['Build', 'build'],
  ['Type', 'type'],
  ['Min iOS', 'minOS'],
  ['Signer', 'signer'],
  ['Bundle path', 'path'],
  ['Data container', 'container']
]

// --- developer tier: process control (needs the iOS-17+ userspace tunnel) -----
/** One running process from `ios ps`. */
export interface IosProcess {
  pid: number
  name: string
  /** true for user/app processes (IsApplication), false for daemons/services. */
  isApp: boolean
  /** RealAppName (executable path or .app bundle path). */
  path: string
  /** ISO start time (StartDate), '' if absent. */
  startDate: string
}

function num(o: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number') return v
    if (typeof v === 'string' && /^\d+$/.test(v)) return parseInt(v, 10)
  }
  return 0
}

/** Parse `ios ps` output. The normal shape is an array of
 *  {Pid, Name, IsApplication, RealAppName, StartDate}; an object map
 *  (pid -> name) is tolerated as a fallback. */
export function parseProcesses(stdout: string): IosProcess[] {
  for (const v of jsonValues(stdout)) {
    if (Array.isArray(v)) {
      const out: IosProcess[] = []
      for (const item of v) {
        if (!isObj(item)) continue
        const pid = num(item, 'Pid', 'pid', 'ProcessIdentifier')
        const name = str(item, 'Name') || str(item, 'name') || str(item, 'ExecutableName')
        if (!pid && !name) continue
        out.push({
          pid,
          name,
          isApp: item.IsApplication === true || item.isApplication === true,
          path: str(item, 'RealAppName') || str(item, 'realAppName') || str(item, 'Path'),
          startDate: str(item, 'StartDate') || str(item, 'startDate')
        })
      }
      return out.sort((a, b) => a.pid - b.pid)
    }
    if (isObj(v)) {
      // object map: { "77": "powerexceptionsd", ... }
      const out: IosProcess[] = []
      for (const [k, name] of Object.entries(v)) {
        if (/^\d+$/.test(k) && typeof name === 'string') {
          out.push({ pid: parseInt(k, 10), name, isApp: false, path: '', startDate: '' })
        }
      }
      if (out.length) return out.sort((a, b) => a.pid - b.pid)
    }
  }
  return []
}

/** True if `ios tunnel ls` reports an active tunnel for `udid`
 *  (entries look like {address, rsdPort, udid, userspaceTun, ...}). */
export function tunnelHasUdid(stdout: string, udid: string): boolean {
  for (const v of jsonValues(stdout)) {
    if (Array.isArray(v)) {
      return v.some((e) => isObj(e) && str(e, 'udid') === udid)
    }
  }
  return false
}

/** The local userspace-proxy port DVT services dial for `udid`'s tunnel, or null
 *  if not listed / not a userspace tunnel. A tunnel can be *listed* yet have this
 *  port dead (bind lost to a competing tunnel), which is why we probe it. */
export function userspaceTunPort(stdout: string, udid: string): number | null {
  for (const v of jsonValues(stdout)) {
    if (Array.isArray(v)) {
      const e = v.find((x) => isObj(x) && str(x, 'udid') === udid)
      if (isObj(e)) {
        const p = num(e, 'userspaceTunPort')
        return p > 0 ? p : null
      }
    }
  }
  return null
}

export function psArgs(udid: string, appsOnly = false): string[] {
  return ['ps', ...(appsOnly ? ['--apps'] : []), '--udid', udid]
}

export function launchArgs(udid: string, bundleId: string, killExisting = false): string[] {
  return ['launch', bundleId, ...(killExisting ? ['--kill-existing'] : []), '--udid', udid]
}

export function killArgs(udid: string, bundleId: string): string[] {
  return ['kill', bundleId, '--udid', udid]
}

/** Start the no-sudo userspace tunnel AGENT (long-lived daemon). No `--udid`, so
 *  one agent manages tunnels for EVERY connected device (it loops over the device
 *  list, assigning each its own userspace RSD port) — the basis for multi-device
 *  dev-tier. Per-device readiness is then read from `tunnel ls`. */
export function tunnelStartArgs(): string[] {
  return ['tunnel', 'start', '--userspace']
}

export function tunnelLsArgs(): string[] {
  return ['tunnel', 'ls']
}

// --- Developer Disk Image mount + location simulation (DVT, needs tunnel) -----
// The DDI must be mounted before any DVT service (simulate-location, WDA/ui).
// Our patched go-ios fixes the TSS-94 that blocked `image auto` upstream (it now
// applies the manifest's RestoreRequestRules → EPRO/ESEC=true). See the memory
// note "go-ios DDI mount fix".

export function imageListArgs(udid: string): string[] {
  return ['image', 'list', '--udid', udid]
}

/** Auto-download (into basedir) + mount the matching Developer Disk Image. */
export function imageAutoArgs(udid: string, basedir: string): string[] {
  return ['image', 'auto', '--basedir', basedir, '--udid', udid]
}

/** `image list` prints the mounted image's signature when one is mounted, or a
 *  lone "none" line when nothing is. */
export function imageIsMounted(stdout: string): boolean {
  return /"signature"\s*:/.test(stdout) || /image signature/i.test(stdout)
}

export function setLocationArgs(udid: string, lat: number, lon: number): string[] {
  return ['setlocation', `--lat=${lat}`, `--lon=${lon}`, '--udid', udid]
}

export function resetLocationArgs(udid: string): string[] {
  return ['resetlocation', '--udid', udid]
}

// --- performance monitor (sysmontap CPU + battery; needs the tunnel for CPU) ---
// go-ios's `sysmontap` streams one slog line per sample carrying the system CPU;
// its memory/per-process data is requested but discarded by the CLI (would need
// a deeper go-ios patch to surface — memory/per-app are left null for now).

export function syslogArgs(udid: string): string[] {
  return ['syslog', '--udid', udid]
}

// --- iOS syslog → adb-threadtime bridge ---------------------------------------
// `ios syslog` emits classic ASL lines like:
//   "Jul 16 03:41:21 iPhone-14 audiomxd(AudioToolbox)[104] <Notice>: message"
// We reshape each into an adb `logcat -v threadtime` line so the shared parser +
// log table render it unchanged: process→tag, iOS level→closest Android
// priority, and tid 0 (iOS syslog carries no thread id).
const SYSLOG_MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12'
}
const SYSLOG_LEVEL: Record<string, string> = {
  debug: 'D', info: 'I', notice: 'I', default: 'I',
  warning: 'W', warn: 'W', error: 'E', err: 'E',
  fault: 'F', critical: 'F', alert: 'F', emergency: 'F'
}
const SYSLOG_RE = /^(\w{3}) +(\d+) (\d{2}:\d{2}:\d{2}) \S+ (.+?)\[(\d+)\] <([^>]+)>: ?([\s\S]*)$/

/** Reshape one `ios syslog` message into an adb-threadtime line, or null if it
 *  doesn't parse (skipped rather than shown with a bogus timestamp). */
export function syslogToThreadtime(msg: string): string | null {
  const m = SYSLOG_RE.exec(msg.trimEnd())
  if (!m) return null
  const [, mon, day, time, proc, pid, level, message] = m
  const mm = SYSLOG_MONTHS[mon] ?? '01'
  const dd = day.padStart(2, '0')
  const lvl = SYSLOG_LEVEL[level.toLowerCase()] ?? 'I'
  const tag = proc.trim().replace(/:/g, '') // a tag must not contain the ": " separator
  return `${mm}-${dd} ${time}.000 ${pid} 0 ${lvl} ${tag}: ${message.trimStart()}`
}

export function batteryCheckArgs(udid: string): string[] {
  return ['batterycheck', '--udid', udid]
}
export function batteryRegistryArgs(udid: string): string[] {
  return ['batteryregistry', '--udid', udid]
}
export function diskspaceArgs(udid: string): string[] {
  return ['diskspace', '--udid', udid]
}

export interface SysmontapSample {
  cpuCount: number
  /** Summed across cores (100 == one fully-busy core). */
  cpuTotalLoad: number
  /** Per-core total load, each 0–100 (from our patched go-ios `per_cpu`). */
  perCpu: number[]
  /** Device RAM total / in-use, in KiB (our patched go-ios; 0 if unavailable). */
  memTotalKb: number
  memUsedKb: number
}

/** Parse one `sysmontap` line → a sample, or null if it isn't a CPU sample.
 *  per_cpu/mem_* come from our patched go-ios (see scripts/build-goios.sh); an
 *  unpatched binary simply yields empty per-core + zero memory. */
export function parseSysmontapCpu(line: string): SysmontapSample | null {
  const t = line.trim()
  if (!t.startsWith('{')) return null
  try {
    const o = JSON.parse(t)
    if (isObj(o) && o.msg === 'received CPU usage data' && typeof o.cpu_total_load === 'number') {
      return {
        cpuCount: typeof o.cpu_count === 'number' ? o.cpu_count : 0,
        cpuTotalLoad: o.cpu_total_load,
        perCpu: Array.isArray(o.per_cpu) ? o.per_cpu.filter((x): x is number => typeof x === 'number') : [],
        memTotalKb: typeof o.mem_total_kb === 'number' ? o.mem_total_kb : 0,
        memUsedKb: typeof o.mem_used_kb === 'number' ? o.mem_used_kb : 0
      }
    }
  } catch {
    /* partial chunk / non-JSON log line */
  }
  return null
}

/** System CPU as 0–100% (total load / cores, clamped). */
export function sysmontapCpuPercent(cpuTotalLoad: number, cpuCount: number): number {
  if (cpuCount <= 0) return 0
  return Math.max(0, Math.min(100, cpuTotalLoad / cpuCount))
}

/** Battery {level, tempC, powered} from `batterycheck` + `batteryregistry` JSON. */
export function parseIosBattery(checkJson: string, registryJson: string): Battery | null {
  const parse = (s: string): Record<string, unknown> => {
    try {
      const o = JSON.parse(s.trim())
      return isObj(o) ? o : {}
    } catch {
      return {}
    }
  }
  const c = parse(checkJson)
  const r = parse(registryJson)
  const level =
    typeof c.BatteryCurrentCapacity === 'number'
      ? c.BatteryCurrentCapacity
      : typeof r.CurrentCapacity === 'number'
        ? r.CurrentCapacity
        : null
  if (level === null) return null
  // batteryregistry Temperature is centi-°C (e.g. 3450 → 34.5 °C).
  const tempC = typeof r.Temperature === 'number' ? r.Temperature / 100 : null
  const powered = c.BatteryIsCharging === true || c.ExternalConnected === true || r.IsCharging === true
  return { level, tempC, powered }
}

// --- app-container file access (house-arrest AFC via `ios fsync`, no tunnel) ---
// Works for apps with UIFileSharingEnabled or your own dev-signed apps; used by
// the iOS Files browser, DB inspector, and Prefs editor.
export function fsyncTreeArgs(udid: string, bundleId: string, path = '.'): string[] {
  return ['fsync', `--app=${bundleId}`, 'tree', `--path=${path}`, '--udid', udid]
}
export function fsyncPullArgs(udid: string, bundleId: string, remote: string, local: string): string[] {
  return ['fsync', `--app=${bundleId}`, 'pull', `--srcPath=${remote}`, `--dstPath=${local}`, '--udid', udid]
}
export function fsyncPushArgs(udid: string, bundleId: string, local: string, remote: string): string[] {
  return ['fsync', `--app=${bundleId}`, 'push', `--srcPath=${local}`, `--dstPath=${remote}`, '--udid', udid]
}

/** One entry from a parsed `fsync tree` listing (path relative to the tree root). */
export interface ContainerEntry {
  path: string
  name: string
  isDir: boolean
  depth: number
}

/** Parse `ios fsync tree` ASCII output into entries with full relative paths.
 *  Lines look like `|-Documents/`, `|  |-FPDB.sqlite`, `|  |  |-Backup/` — a
 *  3-char `|  ` per depth level, directories suffixed with `/`. */
export function parseFsyncTree(stdout: string): ContainerEntry[] {
  const out: ContainerEntry[] = []
  const stack: string[] = []
  for (const raw of stdout.split('\n')) {
    const m = /^((?:\|\s\s)*)\|-(.+)$/.exec(raw.replace(/\r$/, ''))
    if (!m) continue
    const depth = m[1].length / 3
    const isDir = m[2].endsWith('/')
    const name = isDir ? m[2].slice(0, -1) : m[2]
    if (!name || name === '.') continue
    stack[depth] = name
    stack.length = depth + 1
    out.push({ path: stack.join('/'), name, isDir, depth })
  }
  return out
}

// --- configuration profiles (MCInstall — classic tier, no developer tunnel) ---
// Used by the iOS network-intercept CA delivery: install our MITM root CA as a
// config profile the user approves + trusts on-device. `profile list`/`remove`
// take/return the profile's Identifier (its top-level PayloadIdentifier).

/** The fixed identifier + display name of the CA profile we install (constant so
 *  a re-install replaces rather than duplicates, and removal can target it). */
export const CA_PROFILE_IDENTIFIER = 'com.androidlabkit.ca'
export const CA_PROFILE_NAME = 'AndroidLabKit CA'

export function profileListArgs(udid: string): string[] {
  return ['profile', 'list', '--udid', udid]
}
export function profileAddArgs(udid: string, file: string): string[] {
  return ['profile', 'add', file, '--udid', udid]
}
export function profileRemoveArgs(udid: string, identifier: string): string[] {
  return ['profile', 'remove', identifier, '--udid', udid]
}

export interface InstalledProfile {
  identifier: string
  displayName: string
}

/** Parse `ios profile list` (a JSON array) → identifier + display name rows. */
export function parseProfileList(stdout: string): InstalledProfile[] {
  for (const v of jsonValues(stdout)) {
    if (!Array.isArray(v)) continue
    const out: InstalledProfile[] = []
    for (const item of v) {
      if (!isObj(item)) continue
      const meta = isObj(item.Metadata) ? item.Metadata : {}
      out.push({
        identifier: str(item, 'Identifier'),
        displayName: str(meta, 'PayloadDisplayName')
      })
    }
    return out
  }
  return []
}

/** Find our CA profile's installed Identifier (matched by identifier OR the
 *  display name), or null if it isn't present. */
export function findCaProfile(stdout: string): string | null {
  for (const p of parseProfileList(stdout)) {
    if (p.identifier === CA_PROFILE_IDENTIFIER || p.displayName === CA_PROFILE_NAME) {
      return p.identifier || CA_PROFILE_IDENTIFIER
    }
  }
  return null
}

/** A minimal .mobileconfig that installs a DER-encoded cert as a trusted root
 *  CA (`com.apple.security.root`). `derBase64` is the cert's DER bytes, base64.
 *  The user still approves the profile (Settings ▸ VPN & Device Management) and
 *  enables trust (Settings ▸ General ▸ About ▸ Certificate Trust Settings) —
 *  iOS never auto-trusts a non-MDM root. Fixed UUIDs → idempotent re-install. */
export function caMobileconfig(derBase64: string): string {
  const CERT_UUID = 'A11DAB00-0000-4000-8000-000000000001'
  const ROOT_UUID = 'A11DAB00-0000-4000-8000-000000000002'
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>PayloadContent</key>',
    '  <array>',
    '    <dict>',
    '      <key>PayloadType</key><string>com.apple.security.root</string>',
    '      <key>PayloadVersion</key><integer>1</integer>',
    `      <key>PayloadIdentifier</key><string>${CA_PROFILE_IDENTIFIER}.cert</string>`,
    `      <key>PayloadUUID</key><string>${CERT_UUID}</string>`,
    `      <key>PayloadDisplayName</key><string>${CA_PROFILE_NAME}</string>`,
    '      <key>PayloadCertificateFileName</key><string>androidlabkit-ca.cer</string>',
    '      <key>PayloadContent</key>',
    `      <data>${derBase64}</data>`,
    '    </dict>',
    '  </array>',
    '  <key>PayloadType</key><string>Configuration</string>',
    '  <key>PayloadVersion</key><integer>1</integer>',
    `  <key>PayloadIdentifier</key><string>${CA_PROFILE_IDENTIFIER}</string>`,
    `  <key>PayloadUUID</key><string>${ROOT_UUID}</string>`,
    `  <key>PayloadDisplayName</key><string>${CA_PROFILE_NAME}</string>`,
    '  <key>PayloadDescription</key><string>Installs the AndroidLabKit HTTPS-decryption certificate for network inspection.</string>',
    '  <key>PayloadRemovalDisallowed</key><false/>',
    '</dict>',
    '</plist>',
    ''
  ].join('\n')
}
