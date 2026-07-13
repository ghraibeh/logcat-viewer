/**
 * App Manager pure helpers. Faithful, Qt-free port of appmgr.py's layer: the
 * adb command builders, the `pm list packages` / `dumpsys package` / `cmd appops`
 * parsers, the running-services parser, the APK-icon picker, and the human-size
 * formatter. DOM-/adb-/fs-free so it is unit-tested directly; the device I/O
 * lives in main/services/appmgr.ts.
 *
 * Every builder returns adb args WITH the leading `-s <serial>` (mirroring the
 * sibling core modules; the service passes serial=null to adb.run).
 */

// App-ops modes an app op can be set to (the values `appops set` accepts).
export const APPOP_MODES = ['allow', 'deny', 'ignore', 'default', 'foreground'] as const
export type AppOpMode = (typeof APPOP_MODES)[number]

// Component state verbs (the `pm` sub-commands for a `<pkg>/<component>`).
export const COMPONENT_STATES: Record<string, string> = {
  enable: 'enable',
  disable: 'disable',
  default: 'default-state'
}

// --- data models --------------------------------------------------------------
export interface AppInfo {
  package: string
  apkPath: string
  versionCode: string
  uid: string
  installer: string
  system: boolean
  enabled: boolean
}

export interface Permission {
  name: string
  granted: boolean | null // True/False, or null if only requested
  runtime: boolean // a changeable (dangerous) runtime permission
}

export interface Component {
  name: string
  enabled: boolean
}

export interface AppOp {
  op: string
  mode: string
}

export interface RunningService {
  component: string
  pid: number | null
  process: string
  foreground: boolean
  started: boolean
}

export interface AppDetail {
  package: string
  general: Record<string, string>
  permissions: Permission[]
  activities: Component[]
  services: Component[]
  receivers: Component[]
  providers: Component[]
  appops: AppOp[]
  signatures: string[]
  running: RunningService[]
}

// --- pure command builders ----------------------------------------------------
function sh(serial: string): string[] {
  return ['-s', serial, 'shell']
}

export function listPackagesArgs(serial: string, withUid = true): string[] {
  const flags = ['-f', '-i', '--show-versioncode']
  if (withUid) flags.push('-U')
  return [...sh(serial), 'pm', 'list', 'packages', ...flags]
}

export function listFilteredArgs(serial: string, flag: string): string[] {
  return [...sh(serial), 'pm', 'list', 'packages', flag]
}

export function dumpsysArgs(serial: string, pkg: string): string[] {
  return [...sh(serial), 'dumpsys', 'package', pkg]
}

export function runningServicesArgs(serial: string, pkg: string): string[] {
  return [...sh(serial), 'dumpsys', 'activity', 'services', pkg]
}

export function appopsGetArgs(serial: string, pkg: string, cmd = true): string[] {
  return [...sh(serial), ...(cmd ? ['cmd', 'appops', 'get', pkg] : ['appops', 'get', pkg])]
}

export function appopsSetArgs(serial: string, pkg: string, op: string, mode: string): string[] {
  return [...sh(serial), 'cmd', 'appops', 'set', pkg, op, mode]
}

export function statSizeArgs(serial: string, path: string): string[] {
  return [...sh(serial), 'stat', '-c', '%s', path]
}

export function duArgs(serial: string, pkg: string, sub = '.'): string[] {
  return [...sh(serial), 'run-as', pkg, 'du', '-sk', sub]
}

export function launchArgs(serial: string, pkg: string): string[] {
  return [...sh(serial), 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']
}

export function forceStopArgs(serial: string, pkg: string): string[] {
  return [...sh(serial), 'am', 'force-stop', pkg]
}

export function clearArgs(serial: string, pkg: string): string[] {
  return [...sh(serial), 'pm', 'clear', pkg]
}

export function clearCacheArgs(serial: string, pkg: string): string[] {
  return [...sh(serial), 'pm', 'clear', '--cache-only', pkg]
}

export function runasClearCacheArgs(serial: string, pkg: string): string[] {
  return [...sh(serial), 'run-as', pkg, 'rm', '-rf', 'cache', 'code_cache']
}

export function suClearCacheArgs(serial: string, pkg: string): string[] {
  return [...sh(serial), 'su', '-c', 'rm', '-rf', `/data/data/${pkg}/cache`, `/data/data/${pkg}/code_cache`]
}

export function enableArgs(serial: string, pkg: string): string[] {
  return [...sh(serial), 'pm', 'enable', pkg]
}

export function disableArgs(serial: string, pkg: string): string[] {
  return [...sh(serial), 'pm', 'disable-user', '--user', '0', pkg]
}

export function uninstallArgs(serial: string, pkg: string, keepData = false): string[] {
  // host-side `adb uninstall` (not a shell command)
  return ['-s', serial, 'uninstall', ...(keepData ? ['-k'] : []), pkg]
}

export function grantArgs(serial: string, pkg: string, perm: string): string[] {
  return [...sh(serial), 'pm', 'grant', pkg, perm]
}

export function revokeArgs(serial: string, pkg: string, perm: string): string[] {
  return [...sh(serial), 'pm', 'revoke', pkg, perm]
}

export function componentArgs(serial: string, pkg: string, component: string, state: string): string[] {
  const verb = COMPONENT_STATES[state]
  return [...sh(serial), 'pm', verb, `${pkg}/${component}`]
}

export function appInfoArgs(serial: string, pkg: string): string[] {
  return [
    ...sh(serial),
    'am',
    'start',
    '-a',
    'android.settings.APPLICATION_DETAILS_SETTINGS',
    '-d',
    `package:${pkg}`
  ]
}

export function unzipListArgs(serial: string, apkPath: string): string[] {
  return [...sh(serial), 'unzip', '-l', apkPath]
}

export function unzipExtractArgs(serial: string, apkPath: string, entry: string): string[] {
  return ['-s', serial, 'exec-out', 'unzip', '-p', apkPath, entry]
}

/** Remote paths of an OS-installed package's APK(s) via `pm path` (base + splits). */
export function pmPathArgs(serial: string, pkg: string): string[] {
  return [...sh(serial), 'pm', 'path', pkg]
}

export function parseApkPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('package:'))
    .map((l) => l.slice('package:'.length))
}

// density buckets, best → worst; higher score wins when picking a raster icon
const ICON_DENSITY: Record<string, number> = {
  xxxhdpi: 6,
  xxhdpi: 5,
  xhdpi: 4,
  hdpi: 3,
  tvdpi: 2,
  mdpi: 1,
  ldpi: 0,
  nodpi: 0
}

export function parseZipEntries(stdout: string): string[] {
  const entries: string[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.split(/\s+/).filter(Boolean)
    if (parts.length > 0) entries.push(parts[parts.length - 1])
  }
  return entries
}

/** Choose the best *raster* launcher icon from an APK's entry list. Mirrors
 *  appmgr.pick_launcher_icon (adaptive-only apps → null → drawn tile fallback). */
export function pickLauncherIcon(entries: string[]): string | null {
  let best: string | null = null
  let bestScore = -1
  for (const e of entries) {
    const el = e.toLowerCase()
    if (!(el.startsWith('res/') && (el.endsWith('.png') || el.endsWith('.webp')))) continue
    const parts = e.split('/')
    if (parts.length < 3) continue
    const qual = parts[1].toLowerCase() // e.g. "mipmap-xxxhdpi"
    const stem = (parts[parts.length - 1].split('.').slice(0, -1).join('.') || parts[parts.length - 1]).toLowerCase()
    if (!stem.includes('launcher') && !stem.includes('icon')) continue
    if (stem.includes('foreground') || stem.includes('background')) continue // adaptive layers
    let score: number
    if (stem === 'ic_launcher') score = 400
    else if (stem.includes('round')) score = 100
    else if (stem.includes('launcher')) score = 200
    else score = 50 // generic "*icon*"
    if (qual.startsWith('mipmap')) score += 30
    for (const [dens, val] of Object.entries(ICON_DENSITY)) {
      if (qual.endsWith(dens)) {
        score += val
        break
      }
    }
    if (score > bestScore) {
      best = e
      bestScore = score
    }
  }
  return best
}

// --- pure parsers -------------------------------------------------------------
export function parsePkgListLine(line: string): {
  package: string
  apkPath: string
  versionCode: string
  uid: string
  installer: string
} | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('package:')) return null
  const body = trimmed.slice('package:'.length).trim()
  if (!body) return null
  const parts = body.split(/\s+/)
  const head = parts[0]
  const extras = parts.slice(1)
  let apkPath: string
  let pkg: string
  if (head.includes('=')) {
    const idx = head.lastIndexOf('=')
    apkPath = head.slice(0, idx)
    pkg = head.slice(idx + 1)
  } else {
    apkPath = ''
    pkg = head
  }
  const info = { package: pkg, apkPath, versionCode: '', uid: '', installer: '' }
  for (const tok of extras) {
    if (tok.startsWith('versionCode:')) info.versionCode = tok.slice(tok.indexOf(':') + 1)
    else if (tok.startsWith('uid:')) info.uid = tok.slice(tok.indexOf(':') + 1)
    else if (tok.startsWith('installer:')) {
      const v = tok.slice(tok.indexOf(':') + 1)
      info.installer = v === 'null' || v === '' ? '' : v
    }
  }
  return info
}

export function parsePackageNames(stdout: string): Set<string> {
  const out = new Set<string>()
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('package:')) {
      const name = line.slice('package:'.length).trim().split(/\s+/)[0]
      if (name) out.add(name)
    }
  }
  return out
}

export function buildAppList(detailedStdout: string, system: Set<string>, disabled: Set<string>): AppInfo[] {
  const apps: AppInfo[] = []
  for (const line of detailedStdout.split('\n')) {
    const d = parsePkgListLine(line)
    if (!d) continue
    apps.push({
      package: d.package,
      apkPath: d.apkPath,
      versionCode: d.versionCode,
      uid: d.uid,
      installer: d.installer,
      system: system.has(d.package),
      enabled: !disabled.has(d.package)
    })
  }
  apps.sort((a, b) => {
    const la = a.package.toLowerCase()
    const lb = b.package.toLowerCase()
    return la < lb ? -1 : la > lb ? 1 : 0
  })
  return apps
}

const PERM_RE = /^[\w.]+$/

function isPerm(name: string): boolean {
  return !!name && name.includes('.') && PERM_RE.test(name)
}

function search1(text: string, pat: RegExp): string {
  const m = pat.exec(text)
  return m ? m[1].trim() : ''
}

export function parsePermissions(text: string): Permission[] {
  const granted = new Map<string, boolean>()
  const requested = new Set<string>()
  const runtime = new Set<string>()
  let mode: 'req' | 'install' | 'runtime' | null = null
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    const low = s.toLowerCase()
    if (low.startsWith('requested permissions:')) {
      mode = 'req'
      continue
    }
    if (low.startsWith('install permissions:')) {
      mode = 'install'
      continue
    }
    if (low.startsWith('runtime permissions:')) {
      mode = 'runtime'
      continue
    }
    if (low.startsWith('declared permissions:')) {
      mode = null
      continue
    }
    if (!s) continue
    // A new section header (ends with ':' but isn't a permission row) ends the block.
    if (mode && s.endsWith(':') && !s.includes('granted=') && !isPerm(s.slice(0, -1))) {
      mode = null
      continue
    }
    if (mode === 'req') {
      const name = s.split(':')[0].trim()
      if (isPerm(name)) requested.add(name)
    } else if ((mode === 'install' || mode === 'runtime') && s.includes('granted=')) {
      const name = s.split(':')[0].trim()
      if (isPerm(name)) {
        const g = s.includes('granted=true')
        granted.set(name, (granted.get(name) ?? false) || g)
        requested.add(name)
        if (mode === 'runtime') runtime.add(name)
      }
    }
  }
  return [...requested]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((n) => ({ name: n, granted: granted.has(n) ? (granted.get(n) as boolean) : null, runtime: runtime.has(n) }))
}

// Resolver-table section headers in `dumpsys package` and the AppDetail field.
const RESOLVER_SECTIONS: Record<string, keyof Pick<AppDetail, 'activities' | 'services' | 'receivers' | 'providers'>> =
  {
    'activity resolver table:': 'activities',
    'receiver resolver table:': 'receivers',
    'service resolver table:': 'services',
    'provider resolver table:': 'providers'
  }

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fullClass(pkg: string, comp: string): string {
  if (comp.startsWith('.')) return pkg + comp
  if (!comp.includes('.')) return pkg + '.' + comp
  return comp
}

/** Best-effort component enumeration from the resolver tables, filtered to
 *  `package`. Mirrors appmgr.parse_components. */
export function parseComponents(text: string, pkg: string): {
  activities: Component[]
  services: Component[]
  receivers: Component[]
  providers: Component[]
} {
  const found: Record<'activities' | 'services' | 'receivers' | 'providers', Set<string>> = {
    activities: new Set(),
    services: new Set(),
    receivers: new Set(),
    providers: new Set()
  }
  const disabled = new Set<string>()
  const tokRe = new RegExp(escapeRegex(pkg) + '/([\\w.$]+)', 'g')
  let section: keyof typeof found | null = null
  let grabbingDisabled = false
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    const low = s.toLowerCase()
    if (low in RESOLVER_SECTIONS) {
      section = RESOLVER_SECTIONS[low]
      grabbingDisabled = false
      continue
    }
    if (low.startsWith('disabledcomponents:')) {
      grabbingDisabled = true
      section = null
      continue
    }
    if (
      low.startsWith('enabledcomponents:') ||
      low.startsWith('packages:') ||
      low.startsWith('shared users:') ||
      low.startsWith('key set manager:') ||
      low.startsWith('preferred activities')
    ) {
      grabbingDisabled = false
      if (low.startsWith('packages:') || low.startsWith('shared users:') || low.startsWith('key set manager:')) {
        section = null
      }
      continue
    }
    if (grabbingDisabled) {
      if ((!!s && isPerm(s)) || (s.includes('.') && !s.includes(' ') && !!s)) {
        disabled.add(fullClass(pkg, s))
      } else if (s && !s.startsWith(pkg)) {
        grabbingDisabled = false
      }
    }
    if (section) {
      for (const m of s.matchAll(tokRe)) found[section].add(m[1])
    }
  }
  const build = (set: Set<string>): Component[] =>
    [...set]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((c) => ({ name: c, enabled: !disabled.has(fullClass(pkg, c)) }))
  return {
    activities: build(found.activities),
    services: build(found.services),
    receivers: build(found.receivers),
    providers: build(found.providers)
  }
}

const APPOP_RE = /([A-Z][A-Z0-9_]+):\s*(allow|deny|ignore|default|foreground)/

export function parseAppops(text: string): AppOp[] {
  const seen = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const m = APPOP_RE.exec(raw)
    if (m && !seen.has(m[1])) seen.set(m[1], m[2])
  }
  return [...seen.entries()].map(([op, mode]) => ({ op, mode }))
}

const GENERAL_FIELDS: Array<[string, RegExp]> = [
  ['versionName', /\bversionName=(.+)/],
  ['versionCode', /\bversionCode=(\S+)/],
  ['minSdk', /\bminSdk=(\S+)/],
  ['targetSdk', /\btargetSdk=(\S+)/],
  ['userId', /\buserId=(\S+)/],
  ['codePath', /\bcodePath=(\S+)/],
  ['dataDir', /\bdataDir=(\S+)/],
  ['primaryCpuAbi', /\bprimaryCpuAbi=(\S+)/],
  ['installerPackageName', /\binstallerPackageName=(\S+)/],
  ['firstInstallTime', /\bfirstInstallTime=(.+)/],
  ['lastUpdateTime', /\blastUpdateTime=(.+)/]
]

export function parseGeneral(text: string): Record<string, string> {
  const g: Record<string, string> = {}
  for (const [key, pat] of GENERAL_FIELDS) {
    const val = search1(text, pat)
    if (val && val.toLowerCase() !== 'null') g[key] = val
  }
  const fm = /\bflags=\[\s*(.*?)\s*\]/.exec(text)
  if (fm) g.flags = fm[1]
  const sm = /\bsplits=\[(.*?)\]/.exec(text)
  if (sm && sm[1]) g.splits = sm[1]
  return g
}

export function parseSignatures(text: string): string[] {
  const out: string[] = []
  const prefixes = ['signatures=', 'signing details:', 'Signing KeySets:', 'PackageSignatures']
  for (const raw of text.split('\n')) {
    const s = raw.trim()
    if (prefixes.some((p) => s.startsWith(p))) out.push(s)
  }
  const m = /signatureScheme=(\S+)/.exec(text)
  if (m) out.push(`signatureScheme=${m[1]}`)
  return out
}

// "* ServiceRecord{27e4bd2 u0 com.example/.MyService}" (newer builds append
// extras like " c:<caller>" inside the braces after the component).
const SVC_REC_RE = /\* ServiceRecord\{\S+ u\d+ ([^}\s]+)[^}]*\}/g
const SVC_PROC_RE = /app=ProcessRecord\{\S+ (\d+):(\S+?)[/}]/

export function parseRunningServices(text: string): RunningService[] {
  const heads = [...text.matchAll(SVC_REC_RE)]
  const out: RunningService[] = []
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index ?? 0
    const end = i + 1 < heads.length ? (heads[i + 1].index ?? text.length) : text.length
    const block = text.slice(start, end)
    const pm = SVC_PROC_RE.exec(block)
    out.push({
      component: heads[i][1],
      pid: pm ? parseInt(pm[1], 10) : null,
      process: pm ? pm[2] : '',
      foreground: block.includes('isForeground=true'),
      started: block.includes('startRequested=true')
    })
  }
  return out
}

export function parseAppDetail(pkg: string, dumpsys: string, appops: string): AppDetail {
  const comps = parseComponents(dumpsys, pkg)
  return {
    package: pkg,
    general: parseGeneral(dumpsys),
    permissions: parsePermissions(dumpsys),
    activities: comps.activities,
    services: comps.services,
    receivers: comps.receivers,
    providers: comps.providers,
    appops: parseAppops(appops),
    signatures: parseSignatures(dumpsys),
    running: []
  }
}

/** `pm`/`am` print Success/Failure to stdout even on returncode 0. Mirrors _op_ok. */
export function opOk(returncode: number, stdout: string): boolean {
  const head = (stdout || '').trim().toLowerCase()
  if (
    head.startsWith('failure') ||
    head.startsWith('failed') ||
    head.startsWith('error') ||
    head.startsWith('exception')
  ) {
    return false
  }
  return returncode === 0
}

export function humanBytes(n: number): string {
  let size = n
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB'] as const) {
    if (size < 1024) return unit === 'B' ? `${Math.round(size)} ${unit}` : `${size.toFixed(1)} ${unit}`
    size /= 1024
  }
  return `${size.toFixed(1)} PB`
}

// The Info sub-tab rows: [label, general key].
export const INFO_ROWS: Array<[string, string]> = [
  ['Package', 'package'],
  ['Version name', 'versionName'],
  ['Version code', 'versionCode'],
  ['UID', 'userId'],
  ['Min SDK', 'minSdk'],
  ['Target SDK', 'targetSdk'],
  ['ABI', 'primaryCpuAbi'],
  ['Installer', 'installerPackageName'],
  ['First install', 'firstInstallTime'],
  ['Last update', 'lastUpdateTime'],
  ['Data dir', 'dataDir'],
  ['Code path', 'codePath'],
  ['APK size', 'apkSize'],
  ['Data size', 'dataSize'],
  ['Cache size', 'cacheSize'],
  ['Splits', 'splits'],
  ['Flags', 'flags']
]
