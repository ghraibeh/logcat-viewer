/**
 * go-ios binary discovery + device/app queries — the iOS counterpart to
 * services/adb.ts. Resolves the bundled `ios` binary (from the `go-ios` npm
 * package's per-platform `dist/`), runs it via execFile (never throws), and
 * exposes the Apps-tab operations that work over plain usbmux/lockdown WITHOUT
 * the iOS-17+ developer tunnel: device detection, app listing, install, and
 * uninstall. Tunnel-gated developer services (perf, process control, screenshot)
 * are deliberately not surfaced here yet.
 *
 * All device work happens in the main process; the renderer only sees JSON.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { app } from 'electron'
import { parseIpsReport } from '@core/ipscrash'
import { plistJsonToPrefs } from '@core/iosprefs'
import { parseDeviceInfo, type IosDeviceInfo } from '@core/iosdeviceinfo'
import type { CrashItem } from '@core/crash'
import type { Battery, Sample } from '@core/monitor'
import {
  appsArgs,
  batteryCheckArgs,
  batteryRegistryArgs,
  deviceLabel,
  diskspaceArgs,
  fsyncPullArgs,
  fsyncTreeArgs,
  imageAutoArgs,
  imageIsMounted,
  imageListArgs,
  infoArgs,
  installArgs,
  ipArgs,
  killArgs,
  launchArgs,
  listArgs,
  parseApps,
  parseDeviceList,
  parseFsyncTree,
  parseInfo,
  parseNetworkInfo,
  parseIosBattery,
  parseProcesses,
  parseSysmontapCpu,
  psArgs,
  setLocationArgs,
  syslogArgs,
  syslogToThreadtime,
  sysmontapCpuPercent,
  tunnelHasUdid,
  tunnelLsArgs,
  tunnelStartArgs,
  uninstallArgs,
  userspaceTunPort,
  type ContainerEntry,
  type IosNetworkInfo
} from '@core/goios'
import type {
  AppActionResult,
  CrashScanResult,
  Device,
  IosAppListResult,
  IosProcessListResult,
  MockResult,
  PrefsListResult,
  PrefsLoadResult,
  TunnelStatus
} from '@shared/types'

// The `go-ios` npm package ships prebuilt binaries under dist/<triple>/ for every
// platform; pick the one matching this host.
const GOIOS_SUBDIR: Record<string, string> = {
  'darwin-arm64': 'go-ios-darwin-arm64_darwin_arm64',
  'darwin-x64': 'go-ios-darwin-amd64_darwin_amd64',
  'linux-arm64': 'go-ios-linux-arm64_linux_arm64',
  'linux-x64': 'go-ios-linux-amd64_linux_amd64',
  'win32-x64': 'go-ios-windows-amd64_windows_amd64'
}

function binName(): string {
  return process.platform === 'win32' ? 'ios.exe' : 'ios'
}

/** Candidate paths inside node_modules (the dev path — packaged builds use the
 *  bundled copy in resources/, staged via electron-builder extraResources). */
function nodeModulesCandidates(): string[] {
  const sub = GOIOS_SUBDIR[`${process.platform}-${process.arch}`]
  if (!sub) return []
  const rel = join('node_modules', 'go-ios', 'dist', sub, binName())
  return [join(app.getAppPath(), rel), join(process.cwd(), rel)]
}

function whichGoIos(): string | null {
  const paths = (process.env.PATH ?? '').split(delimiter)
  for (const dir of paths) {
    if (!dir) continue
    const cand = join(dir, binName())
    if (existsSync(cand)) return cand
  }
  return null
}

let cached: string | null | undefined

/** Resolve the go-ios binary: $GO_IOS -> bundled copy -> node_modules -> PATH. */
export function findGoIos(): string | null {
  if (cached !== undefined) return cached
  const env = process.env.GO_IOS
  if (env && existsSync(env)) return (cached = env)
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'go-ios', binName())
    if (existsSync(bundled)) return (cached = bundled)
  }
  for (const cand of nodeModulesCandidates()) {
    if (existsSync(cand)) return (cached = cand)
  }
  return (cached = whichGoIos())
}

interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

/** Run go-ios; never throws (mirrors adb.run). go-ios prints its data document
 *  to stdout and structured log lines (incl. the "agent not running" warning) to
 *  stderr, so parsers only ever look at stdout. */
function run(bin: string, args: string[], timeoutMs = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code:
            err && typeof (err as { code?: number }).code === 'number'
              ? (err as { code: number }).code
              : err
                ? 1
                : 0
        })
      }
    )
  })
}

/** Last non-empty line of stderr/stdout, or a fallback (mirrors appmgr.lastLine). */
function lastLine(stderr: string, stdout: string, fallback: string): string {
  const out = (stderr || stdout || '').trim()
  if (!out) return fallback
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? fallback
}

/** `ios list` + a per-device `ios info` → Device[] tagged platform:'ios'. */
export async function listDevices(bin: string): Promise<Device[]> {
  const udids = parseDeviceList((await run(bin, listArgs(), 10000)).stdout)
  const devices: Device[] = []
  for (const udid of udids) {
    const info = parseInfo((await run(bin, infoArgs(udid), 10000)).stdout)
    const { label, description } = deviceLabel(udid, info)
    devices.push({ serial: udid, state: 'device', description, online: true, label, platform: 'ios' })
  }
  return devices
}

/** All installed apps (`ios apps --all`); the renderer filters User/System/Hidden. */
export async function listApps(bin: string, udid: string): Promise<IosAppListResult> {
  const r = await run(bin, appsArgs(udid, 'all'), 30000)
  const apps = parseApps(r.stdout)
  if (apps.length === 0) {
    return { ok: false, apps: [], error: lastLine(r.stderr, r.stdout, 'No apps returned') }
  }
  return { ok: true, apps, error: '' }
}

/** Install a signed .ipa (`ios install --path=`). */
export async function install(bin: string, udid: string, ipaPath: string): Promise<AppActionResult> {
  const r = await run(bin, installArgs(udid, ipaPath), 300000)
  if (r.code === 0) return { ok: true, message: `Installed ${basename(ipaPath)}` }
  return { ok: false, message: lastLine(r.stderr, r.stdout, 'Install failed') }
}

/** Uninstall an app by bundle id (`ios uninstall <bundleId>`). */
export async function uninstall(bin: string, udid: string, bundleId: string): Promise<AppActionResult> {
  const r = await run(bin, uninstallArgs(udid, bundleId), 60000)
  if (r.code === 0) return { ok: true, message: `Uninstalled ${bundleId}` }
  return { ok: false, message: lastLine(r.stderr, r.stdout, 'Uninstall failed') }
}

/** Aggregate lockdown info + disk + battery into the Device Info payload. All of
 *  these are classic-tier (no developer tunnel needed). */
export async function deviceInfo(bin: string, udid: string): Promise<IosDeviceInfo> {
  const [info, disk, reg, chk] = await Promise.all([
    run(bin, infoArgs(udid), 12000),
    run(bin, diskspaceArgs(udid), 10000),
    run(bin, batteryRegistryArgs(udid), 10000),
    run(bin, batteryCheckArgs(udid), 10000)
  ])
  return parseDeviceInfo(info.stdout, disk.stdout, reg.stdout, chk.stdout)
}

/** Detect the device's current Wi-Fi/LAN IP via `ios ip` — a pcapd sniff of the
 *  device's own traffic. Classic-tier (no developer tunnel). Our patched go-ios
 *  bounds the sniff internally (~12s) and returns its best guess; run()'s longer
 *  timeout is just a backstop. ipv4 comes back '' when the device is idle, off
 *  Wi-Fi, or nothing was caught in time — the caller renders that as "not
 *  detected" and lets the user retry. Kept OUT of deviceInfo() so the dashboard
 *  paints immediately and the (slower) IP fills in progressively. */
export async function deviceIp(bin: string, udid: string): Promise<IosNetworkInfo> {
  const r = await run(bin, ipArgs(udid), 16000)
  return parseNetworkInfo(r.stdout)
}

// --- developer tier: the iOS-17+ userspace tunnel + process control ----------
// launch / kill / ps go through go-ios's DVT (instruments) services, which on
// iOS 17+ are only reachable over a RemoteXPC tunnel. The `--userspace` tunnel
// needs no root, so the main process spawns and owns it like any other worker.
let tunnelProc: ChildProcess | null = null

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Can we open a TCP connection to a local port? Used to confirm the tunnel's
 *  userspace RSD proxy is actually accepting connections. */
function portOpen(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port }, () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
    sock.setTimeout(timeoutMs, () => {
      sock.destroy()
      resolve(false)
    })
  })
}

/** A tunnel is *healthy* only if `tunnel ls` lists it AND its userspace RSD
 *  proxy port is actually accepting connections. A tunnel can be listed with a
 *  dead proxy port (it lost the bind to a competing tunnel) — then DVT services
 *  like setlocation fail with "connection refused"; treat that as not-ready so
 *  we respawn a clean tunnel instead of reusing the broken one. */
async function tunnelHealthy(bin: string, udid: string): Promise<boolean> {
  const r = await run(bin, tunnelLsArgs(), 6000)
  if (!tunnelHasUdid(r.stdout, udid)) return false
  const port = userspaceTunPort(r.stdout, udid)
  if (port === null) return true // kernel tunnel (no userspace proxy) — assume ok
  return portOpen(port)
}

/** Ensure a HEALTHY userspace tunnel is up for `udid`; spawn one and wait if
 *  needed. Respawns if an existing tunnel is listed but its proxy port is dead. */
async function ensureTunnel(bin: string, udid: string): Promise<AppActionResult> {
  if (await tunnelHealthy(bin, udid)) return { ok: true, message: 'tunnel active' }
  // No healthy tunnel — tear down ours (wrong device, or listed-but-broken) and
  // spawn a fresh one.
  stopTunnel()
  try {
    tunnelProc = spawn(bin, tunnelStartArgs(udid), { stdio: 'ignore' })
    tunnelProc.on('exit', () => {
      tunnelProc = null
    })
  } catch (e) {
    return { ok: false, message: `Could not start developer tunnel: ${errMsg(e)}` }
  }
  // Userspace negotiation takes ~1–2s; poll until the proxy port is live (not
  // just listed), so DVT services can actually connect once we return.
  for (let i = 0; i < 20; i++) {
    await delay(500)
    if (await tunnelHealthy(bin, udid)) return { ok: true, message: 'tunnel started' }
  }
  return {
    ok: false,
    message: 'Developer tunnel did not come up — check the device is unlocked, trusted, and has Developer Mode enabled.'
  }
}

/** Kill the managed tunnel (called on window close). */
export function stopTunnel(): void {
  if (tunnelProc) {
    try {
      tunnelProc.kill()
    } catch {
      /* already gone */
    }
    tunnelProc = null
  }
}

/** Report whether a healthy developer tunnel is currently active for `udid`. */
export async function getTunnelStatus(bin: string, udid: string): Promise<TunnelStatus> {
  return { ready: await tunnelHealthy(bin, udid) }
}

/** Explicitly bring the tunnel up (the UI's "Enable process control" + the mirror).
 *  DVT services (process list, screenshot, the MJPEG mirror) only need this tunnel
 *  — NOT a mounted Developer Image — on iOS 17+. */
export async function startTunnel(bin: string, udid: string): Promise<AppActionResult> {
  return ensureTunnel(bin, udid)
}

/** Running processes via `ios ps` (auto-starts the tunnel if needed). */
export async function processes(bin: string, udid: string, appsOnly: boolean): Promise<IosProcessListResult> {
  const ens = await ensureTunnel(bin, udid)
  if (!ens.ok) return { ok: false, processes: [], error: ens.message }
  const r = await run(bin, psArgs(udid, appsOnly), 20000)
  const list = parseProcesses(r.stdout)
  if (list.length === 0 && r.code !== 0) {
    return { ok: false, processes: [], error: lastLine(r.stderr, r.stdout, 'Could not list processes') }
  }
  return { ok: true, processes: list, error: '' }
}

/** Launch an app by bundle id (`ios launch`; auto-starts the tunnel). */
export async function launch(bin: string, udid: string, bundleId: string): Promise<AppActionResult> {
  const ens = await ensureTunnel(bin, udid)
  if (!ens.ok) return { ok: false, message: ens.message }
  const r = await run(bin, launchArgs(udid, bundleId), 30000)
  if (r.code === 0) {
    // go-ios logs "Process launched pid N" to stderr.
    const m = /pid["\s:]+(\d+)/i.exec(`${r.stderr}\n${r.stdout}`)
    return { ok: true, message: m ? `Launched (pid ${m[1]})` : `Launched ${bundleId}` }
  }
  return { ok: false, message: lastLine(r.stderr, r.stdout, 'Launch failed') }
}

/** Kill/force-quit an app by bundle id (`ios kill`; auto-starts the tunnel). */
export async function kill(bin: string, udid: string, bundleId: string): Promise<AppActionResult> {
  const ens = await ensureTunnel(bin, udid)
  if (!ens.ok) return { ok: false, message: ens.message }
  const r = await run(bin, killArgs(udid, bundleId), 20000)
  if (r.code === 0) return { ok: true, message: `Force-quit ${bundleId}` }
  return { ok: false, message: lastLine(r.stderr, r.stdout, 'Force-quit failed') }
}

// --- Developer Disk Image mount + mock location (DVT: needs tunnel + DDI) ------
// simulate-location is DVT-gated: it needs the userspace tunnel AND the DDI
// mounted. `image auto` mounts it (our patched go-ios fixes the upstream TSS-94).
// The mount is cached per device by iOS, so ensureImageMounted is a cheap no-op
// once done.
//
// iOS 17+ (RSD) location model: `ios setlocation` runs the DVT
// LocationSimulationService and BLOCKS, holding the simulation open until it
// gets SIGINT — on which it restores the device's real location. So a mock is a
// long-lived child process: set = (re)spawn it; stop = SIGINT it. (`ios
// resetlocation` uses the legacy lockdown service that returns InvalidService on
// iOS 17+, so we never use it — SIGINT is the reset.)
let mockProc: ChildProcess | null = null
let mockedUdid: string | null = null

/** SIGINT the running simulation so go-ios restores the real location, then drop it. */
function stopMockProc(): void {
  if (mockProc) {
    try {
      mockProc.kill('SIGINT')
    } catch {
      /* already gone */
    }
    mockProc = null
  }
}

/** Where downloaded DDIs are cached (app-support, survives restarts). */
function ddiCacheDir(): string {
  const dir = join(app.getPath('userData'), 'ios-ddi')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function imageMounted(bin: string, udid: string): Promise<boolean> {
  // go-ios writes `image list`'s result (the mounted signature, or "none") to
  // stderr via slog — not stdout — so check both.
  const r = await run(bin, imageListArgs(udid), 15000)
  return imageIsMounted(`${r.stdout}\n${r.stderr}`)
}

/** Ensure the Developer Disk Image is mounted (idempotent). */
async function ensureImageMounted(bin: string, udid: string): Promise<AppActionResult> {
  if (await imageMounted(bin, udid)) return { ok: true, message: 'developer image mounted' }
  const r = await run(bin, imageAutoArgs(udid, ddiCacheDir()), 120000)
  if (await imageMounted(bin, udid)) return { ok: true, message: 'developer image mounted' }
  return {
    ok: false,
    message: lastLine(
      r.stderr,
      r.stdout,
      'Could not mount the Developer Disk Image — is Developer Mode on and the device unlocked?'
    )
  }
}

/** Mock-location "setup": bring the tunnel up + mount the DDI (the iOS analogue
 *  of installing the Android helper APK). */
export async function mockSetup(bin: string, udid: string): Promise<MockResult> {
  const ens = await ensureTunnel(bin, udid)
  if (!ens.ok) return ens
  return ensureImageMounted(bin, udid)
}

/** Set (or update) the simulated location. Spawns the long-lived `ios
 *  setlocation` (which holds the simulation until SIGINT); replaces any prior
 *  one. Accuracy/altitude are Android-only and ignored on iOS. Resolves ok once
 *  the process is up (it blocks by design), or with the error if it exits early
 *  (e.g. tunnel/RSD not reachable). */
export async function setLocation(bin: string, udid: string, lat: number, lon: number): Promise<MockResult> {
  const ens = await ensureTunnel(bin, udid)
  if (!ens.ok) return ens
  const mount = await ensureImageMounted(bin, udid)
  if (!mount.ok) return mount
  stopMockProc() // replace any active simulation

  return new Promise<MockResult>((resolve) => {
    let settled = false
    const done = (r: MockResult): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }
    let proc: ChildProcess
    try {
      proc = spawn(bin, setLocationArgs(udid, lat, lon), { stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (e) {
      return done({ ok: false, message: `Set location failed: ${errMsg(e)}` })
    }
    mockProc = proc
    mockedUdid = udid
    let errBuf = ''
    proc.stderr?.on('data', (d: Buffer) => {
      errBuf += d.toString()
    })
    // setlocation blocks while holding the sim; an early exit means it failed.
    proc.on('exit', () => {
      if (mockProc === proc) {
        mockProc = null
        mockedUdid = null
      }
      done({ ok: false, message: lastLine(errBuf, '', 'Set location failed') })
    })
    // Still running after a beat ⇒ the simulation is live.
    setTimeout(() => done({ ok: true, message: `Mocking ${lat}, ${lon}` }), 1500)
  })
}

/** Stop simulating and restore the device's real location (SIGINT the sim). */
export async function resetLocation(_bin: string, udid: string): Promise<MockResult> {
  stopMockProc()
  if (mockedUdid === udid) mockedUdid = null
  return { ok: true, message: 'Location reset' }
}

/** Stop an active mock on app close (SIGINT so go-ios restores the real fix). */
export function shutdownMock(): void {
  stopMockProc()
  mockedUdid = null
}

// --- performance monitor (sysmontap CPU stream + battery poll) ----------------
// `ios sysmontap` streams system CPU; battery comes from lockdown diagnostics.
// Memory + per-app are not exposed by go-ios's sysmontap CLI (it discards the
// per-process/physFootprint data), so those Sample fields stay null until a
// deeper go-ios patch surfaces them.
let monitorProc: ChildProcess | null = null
let monitorBatteryTimer: ReturnType<typeof setInterval> | null = null

/** Read the current battery (best-effort; null if unavailable). */
async function readBattery(bin: string, udid: string): Promise<Battery | null> {
  const [c, r] = await Promise.all([
    run(bin, batteryCheckArgs(udid), 8000),
    run(bin, batteryRegistryArgs(udid), 8000)
  ])
  return parseIosBattery(c.stdout || c.stderr, r.stdout || r.stderr)
}

/** Start the perf monitor: ensure the tunnel, stream sysmontap CPU, poll battery,
 *  and emit a Sample (throttled to ~intervalMs) for the shared MonitorView. */
export async function monitorStart(
  bin: string,
  udid: string,
  intervalMs: number,
  onSample: (s: Sample) => void,
  onFailed: (message: string) => void
): Promise<boolean> {
  monitorStop()
  const ens = await ensureTunnel(bin, udid)
  if (!ens.ok) {
    onFailed(ens.message)
    return false
  }

  let battery: Battery | null = await readBattery(bin, udid).catch(() => null)
  monitorBatteryTimer = setInterval(() => {
    void readBattery(bin, udid)
      .then((b) => {
        if (b) battery = b
      })
      .catch(() => {})
  }, 5000)

  const proc = spawn(bin, ['sysmontap', '--udid', udid], { stdio: ['ignore', 'ignore', 'pipe'] })
  monitorProc = proc
  const throttle = Math.max(250, intervalMs)
  let buf = ''
  let lastEmit = 0
  proc.stderr?.on('data', (d: Buffer) => {
    buf += d.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? '' // keep the partial last line
    for (const line of lines) {
      const s = parseSysmontapCpu(line)
      if (!s) continue
      const now = Date.now()
      if (now - lastEmit < throttle) continue
      lastEmit = now
      onSample({
        cpu: sysmontapCpuPercent(s.cpuTotalLoad, s.cpuCount),
        mem: s.memTotalKb > 0 ? [s.memUsedKb, s.memTotalKb] : null,
        load: null,
        cores: s.cpuCount,
        coresPct: s.perCpu.length > 0 ? s.perCpu : null,
        battery,
        gfx: null,
        app: null
      })
    }
  })
  proc.on('exit', (code) => {
    if (monitorProc === proc) monitorProc = null
    if (code && code !== 0) onFailed('sysmontap stopped unexpectedly')
  })
  return true
}

/** Stop the perf monitor (SIGINT the stream + cancel the battery poll). */
export function monitorStop(): void {
  if (monitorProc) {
    try {
      monitorProc.kill('SIGINT')
    } catch {
      /* already gone */
    }
    monitorProc = null
  }
  if (monitorBatteryTimer) {
    clearInterval(monitorBatteryTimer)
    monitorBatteryTimer = null
  }
}

// --- live device log (`ios syslog`, no tunnel — the iOS logcat analogue) ------
// Streams the classic ASL syslog and reshapes each line into adb-threadtime so
// the shared logcat parser/table renders it unchanged. go-ios emits one JSON
// object per line ({"msg": "<raw syslog line>"}).
let syslogProc: ChildProcess | null = null

export function syslogRunning(): boolean {
  return syslogProc !== null
}

export function syslogStart(
  bin: string,
  udid: string,
  onLines: (lines: string[]) => void,
  onState: (state: string) => void
): boolean {
  syslogStop()
  const proc = spawn(bin, syslogArgs(udid), { stdio: ['ignore', 'pipe', 'ignore'] })
  syslogProc = proc
  proc.on('spawn', () => onState('started'))
  let buf = ''
  proc.stdout?.on('data', (d: Buffer) => {
    buf += d.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? '' // keep the partial tail
    const out: string[] = []
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      let msg = t
      try {
        const o = JSON.parse(t) as { msg?: unknown }
        if (o && typeof o.msg === 'string') msg = o.msg
      } catch {
        /* not JSON — treat the whole line as the message */
      }
      const tt = syslogToThreadtime(msg)
      if (tt) out.push(tt)
    }
    if (out.length) onLines(out)
  })
  proc.on('exit', () => {
    if (syslogProc === proc) syslogProc = null
    onState('stopped')
  })
  return true
}

export function syslogStop(): void {
  if (syslogProc) {
    try {
      syslogProc.kill()
    } catch {
      /* already gone */
    }
    syslogProc = null
  }
}

// --- crash reports (no tunnel — CrashReportCopyMobile lockdown service) --------
/** Recursively collect files under `dir` (crash cp nests a Retired/ subdir). */
function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    try {
      if (statSync(full).isDirectory()) walkFiles(full, out)
      else out.push(full)
    } catch {
      /* skip unreadable */
    }
  }
  return out
}

/** Copy the device's crash reports and parse them into CrashItem[] (the shape
 *  the shared CrashView renders). Analytics/diagnostics are filtered out. */
export async function crashReports(bin: string, udid: string): Promise<CrashScanResult> {
  let dir: string
  try {
    dir = mkdtempSync(join(tmpdir(), 'androidlab-ios-crash-'))
  } catch (e) {
    return { ok: false, message: `crash scan failed: ${errMsg(e)}`, items: [] }
  }
  try {
    await run(bin, ['crash', 'cp', '*', dir, '--udid', udid], 90000)
    const items: CrashItem[] = []
    for (const f of walkFiles(dir)) {
      if (!/\.(ips|crash|panic|synced)$/i.test(f) && !/\.ips\./i.test(f)) continue
      let raw: string
      try {
        raw = readFileSync(f, 'utf8')
      } catch {
        continue
      }
      const item = parseIpsReport(basename(f), raw)
      if (item) items.push(item)
    }
    items.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0))
    return { ok: true, message: `${items.length} report(s)`, items }
  } catch (e) {
    return { ok: false, message: `crash scan failed: ${errMsg(e)}`, items: [] }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort cleanup */
    }
  }
}

// --- app-container access (house-arrest AFC via `ios fsync`, no tunnel) --------
/** A friendlier message for the common house-arrest failure. */
function containerErr(combo: string): string {
  if (/InstallationLookupFailed/i.test(combo)) {
    return "This app's container isn't accessible — iOS only opens containers for apps with File Sharing enabled or your own dev-signed apps."
  }
  return combo.split('\n').map((l) => l.trim()).filter(Boolean).pop() || "Couldn't open the app container"
}

/** List one directory level of an app's container (`fsync tree`, parsed). */
export async function containerTree(
  bin: string,
  udid: string,
  bundleId: string,
  path = '.'
): Promise<{ ok: boolean; entries: ContainerEntry[]; error: string }> {
  const r = await run(bin, fsyncTreeArgs(udid, bundleId, path), 30000)
  const entries = parseFsyncTree(r.stdout)
  if (entries.length === 0 && /InstallationLookupFailed|no such|not found|failed/i.test(r.stderr + r.stdout)) {
    return { ok: false, entries: [], error: containerErr(r.stderr + r.stdout) }
  }
  return { ok: true, entries, error: '' }
}

/** Pull one file out of an app's container. go-ios `fsync pull` treats --dstPath
 *  as a destination DIRECTORY and drops the file inside it under its basename, so
 *  we pull into `destDir` and return the resolved file path (or null). */
export async function containerPull(
  bin: string,
  udid: string,
  bundleId: string,
  remote: string,
  destDir: string
): Promise<string | null> {
  mkdirSync(destDir, { recursive: true })
  await run(bin, fsyncPullArgs(udid, bundleId, remote, destDir), 120000)
  const file = join(destDir, basename(remote))
  return existsSync(file) ? file : null
}

/** Convert a (possibly binary) plist to JSON via macOS plutil. '' on failure.
 *  Note: the format specifier is `json` (not `json1`). */
function plutilToJson(localPath: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', localPath],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => resolve(err ? '' : (stdout ?? ''))
    )
  })
}

// --- iOS SharedPreferences analogue: NSUserDefaults plists --------------------
/** List an app's Library/Preferences/*.plist (the NSUserDefaults files). The
 *  scoped tree can report the plist at a non-zero depth, so extract .plist
 *  basenames directly from the listing rather than filtering by depth. */
export async function iosPrefsList(bin: string, udid: string, bundleId: string): Promise<PrefsListResult> {
  const r = await run(bin, fsyncTreeArgs(udid, bundleId, 'Library/Preferences'), 30000)
  if (/InstallationLookupFailed/i.test(r.stderr + r.stdout)) {
    return { ok: false, files: [], error: containerErr(r.stderr + r.stdout), usedSu: false }
  }
  const files = [...new Set(r.stdout.match(/[A-Za-z0-9][^\s|/]*\.plist/g) ?? [])]
  return { ok: true, files, error: '', usedSu: false }
}

/** Pull + decode one NSUserDefaults plist into the shared Pref[] shape. */
export async function iosPrefsLoad(
  bin: string,
  udid: string,
  bundleId: string,
  fname: string
): Promise<PrefsLoadResult> {
  const dir = mkdtempSync(join(tmpdir(), 'androidlab-ios-prefs-'))
  try {
    const inner = await containerPull(bin, udid, bundleId, `Library/Preferences/${fname}`, dir)
    if (!inner) return { ok: false, error: `Couldn't read ${fname} from the device`, fname, prefs: [] }
    const json = await plutilToJson(inner)
    if (!json) return { ok: false, error: `Couldn't decode ${fname} (plutil convert failed)`, fname, prefs: [] }
    return { ok: true, error: '', fname, prefs: plistJsonToPrefs(json) }
  } catch (e) {
    return { ok: false, error: errMsg(e), fname, prefs: [] }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
}
