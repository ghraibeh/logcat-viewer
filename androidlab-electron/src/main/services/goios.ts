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
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { app } from 'electron'
import { parseIpsReport } from '@core/ipscrash'
import { parsePlist } from '@core/bplist'
import { plistValueToPrefs } from '@core/iosprefs'
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
  iconArgs,
  infoArgs,
  installArgs,
  ipArgs,
  parseAppIconDataUrl,
  killArgs,
  launchArgs,
  listArgs,
  parseApps,
  parseDeviceListDetails,
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
  wifiConnectionsArgs,
  parseWifiConnections,
  type ContainerEntry,
  type IosNetworkInfo
} from '@core/goios'
import type {
  AppActionResult,
  CrashScanResult,
  Device,
  IconResult,
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

// A writable working directory for every go-ios child. CRITICAL on macOS: the iOS-17
// `tunnel start` creates a pair-record manager that writes `selfIdentity.plist`
// RELATIVE TO THE PROCESS CWD. A LaunchServices-launched app (double-click) inherits
// cwd = "/" (read-only), so the write failed with "open selfIdentity.plist: read-only
// file system" and the tunnel died — while a terminal launch (cwd = a writable dir)
// worked. THAT was the entire "works from terminal, not from double-click" split.
// Pinning cwd to an app-support dir makes go-ios write its state somewhere writable
// regardless of how the app was launched. (Also keeps pair records in one place.)
let _goiosCwd: string | undefined
function goiosCwd(): string {
  if (_goiosCwd) return _goiosCwd
  const dir = join(app.getPath('userData'), 'goios')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* fall back to app-support root if the subdir can't be made */
  }
  return (_goiosCwd = dir)
}

/** Run go-ios; never throws (mirrors adb.run). go-ios prints its data document
 *  to stdout and structured log lines (incl. the "agent not running" warning) to
 *  stderr, so parsers only ever look at stdout. Runs in a writable cwd (see
 *  goiosCwd — the tunnel/pair-record path needs it). */
function run(bin: string, args: string[], timeoutMs = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', cwd: goiosCwd() },
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

/** Pull a human-readable message out of go-ios's slog output. go-ios logs one
 *  JSON object per line ({"level":"ERROR","msg":…,"err":…}); surfacing that raw
 *  line as an error reads like a stack trace. Prefer the last ERROR/FATAL line's
 *  err/msg field; fall back to lastLine for plain output. */
function goiosError(stderr: string, stdout: string, fallback: string): string {
  let best = ''
  for (const raw of `${stderr}\n${stdout}`.split('\n')) {
    const s = raw.trim()
    if (!s.startsWith('{')) continue
    try {
      const o = JSON.parse(s) as Record<string, unknown>
      const level = typeof o.level === 'string' ? o.level.toUpperCase() : ''
      if (level !== 'ERROR' && level !== 'FATAL') continue
      const msg = [o.err, o.msg].find((v) => typeof v === 'string' && v) as string | undefined
      if (msg) best = msg
    } catch {
      /* not a log line */
    }
  }
  return best || lastLine(stderr, stdout, fallback)
}

/** `ios list --details` + a per-device `ios info` → Device[] tagged
 *  platform:'ios'. Transports come STRAIGHT from what usbmux actually reports, so
 *  a transport is listed only when the device is genuinely connected on it (USB
 *  and/or "Network"/Wi-Fi). We do NOT infer Wi-Fi from the "Show when on Wi-Fi"
 *  lockdown setting — that means enabled, not currently reachable. Caveat: usbmux
 *  suppresses the Network entry while a device is on USB, so a cabled device shows
 *  Wi-Fi only once unplugged (or when usbmux happens to list both). */
export async function listDevices(bin: string): Promise<Device[]> {
  const entries = parseDeviceListDetails((await run(bin, listArgs(), 15000)).stdout)
  const devices: Device[] = []
  for (const { udid, transports } of entries) {
    const info = parseInfo((await run(bin, infoArgs(udid), 10000)).stdout)
    const { label, description } = deviceLabel(udid, info)
    devices.push({
      serial: udid,
      state: 'device',
      description,
      online: true,
      label,
      platform: 'ios',
      transports: transports.length ? transports : ['usb']
    })
  }
  return devices
}

/** Read / flip the "Show this device when on Wi-Fi" lockdown value (Finder's
 *  checkbox; our patched go-ios `wificonnections`). Enabling makes usbmuxd
 *  discover the paired device on the local network, so every go-ios feature
 *  keeps working after the cable is unplugged. */
export async function wifiConnections(
  bin: string,
  udid: string,
  op: 'get' | 'enable' | 'disable'
): Promise<{ ok: boolean; enabled: boolean; message: string }> {
  const r = await run(bin, wifiConnectionsArgs(udid, op), 20000)
  const enabled = parseWifiConnections(r.stdout)
  if (enabled === null) {
    const raw = goiosError(r.stderr, r.stdout, 'Wi-Fi connection command failed')
    // The signature failure over Wi-Fi: the device left the network mid-command.
    const message = /not found|no ios device/i.test(raw)
      ? 'Device unreachable — it may have dropped off Wi-Fi. Reconnect it (or plug in over USB) and try again.'
      : raw
    return { ok: false, enabled: false, message }
  }
  return { ok: true, enabled, message: '' }
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

/** One app's home-screen icon as a data URL (patched go-ios `get-app-icon` over
 *  com.apple.springboardservices — classic-tier, no developer tunnel). Returns
 *  the drawn-tile fallback signal ({dataUrl:null}) on any error so the renderer
 *  just keeps its placeholder. `unavailable` is unused on iOS (the service is
 *  always present) but kept for a shared IconResult shape with Android. */
export async function appIcon(bin: string, udid: string, bundleId: string): Promise<IconResult> {
  // Serve from the on-disk cache when present — an icon is then fetched from the
  // device (one go-ios/springboardservices subprocess) at most once, and stays
  // instant across reloads, tab switches, and app restarts.
  const file = iconCacheFile(udid, bundleId)
  if (existsSync(file)) {
    try {
      return { dataUrl: `data:image/png;base64,${readFileSync(file).toString('base64')}`, unavailable: false }
    } catch {
      /* unreadable cache entry — fall through and refetch */
    }
  }
  const r = await run(bin, iconArgs(udid, bundleId), 15000).catch(() => ({ stdout: '', stderr: '' }) as never)
  const dataUrl = parseAppIconDataUrl(r.stdout)
  if (dataUrl) {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    try {
      writeFileSync(file, Buffer.from(b64, 'base64'))
    } catch {
      /* cache is best-effort */
    }
  }
  return { dataUrl, unavailable: false }
}

/** Per-user on-disk icon cache path, keyed by udid + bundle id. Segments are
 *  sanitised so a bundle id can't escape the cache directory. */
function iconCacheFile(udid: string, bundleId: string): string {
  const safe = (s: string): string => s.replace(/[^\w.-]/g, '_')
  const dir = join(app.getPath('userData'), 'ios-app-icons', safe(udid))
  mkdirSync(dir, { recursive: true })
  return join(dir, `${safe(bundleId)}.png`)
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
//
// MULTI-DEVICE: we run ONE shared go-ios tunnel AGENT (no `--udid`) that manages
// a tunnel for every connected device at once — go-ios's agent loops the device
// list and assigns each device its own userspace RSD port, all served from the
// single fixed info port (60105). So a second iPhone no longer tears down the
// first's tunnel; ensureTunnel(udid) just waits for that device's entry to appear
// in `tunnel ls`. (Our patch also lets the agent tunnel Wi-Fi devices.)
let agentProc: ChildProcess | null = null
// In-flight agent-start promise. autoTunnel fires ensureAgentRunning fire-and-forget
// on EVERY device-list rebuild, and enabling Wi-Fi makes usbmux flap (the device
// hops between its USB and Network entries) → many rebuilds in a burst. Without
// coalescing, each overlapping ensureAgent() would stopTunnel() (SIGKILL) the agent
// a previous call just spawned and they'd fight over the fixed port — the tunnel
// came up then died, surfacing as "fixed port busy". This holds a single start so
// concurrent callers share it instead of tearing each other down.
let agentStarting: Promise<AppActionResult> | null = null

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

// go-ios binds ONE fixed local port for its tunnel-info server. Only a single
// tunnel process can hold it, so a leftover `ios tunnel start` from a prior app
// session (often for a device since unplugged) squats it and every new tunnel
// then dies with "bind: address already in use" — the failure that used to make
// us tell the user to stop the stale tunnel. We self-heal instead: sweep any
// go-ios tunnel we don't own before spawning. Mirrors the mirror's
// `pkill screenrecord` cleanup ethos (CLAUDE.md Rule 3/4).
const TUNNEL_INFO_PORT = 60105

/** True if a process with this pid exists (signal 0 = existence probe). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** PIDs of host processes running go-ios `tunnel start` (best-effort, cross-
 *  platform). Matches the go-ios command line so unrelated processes are never
 *  touched; resolves [] on any failure. */
function listGoIosTunnelPids(bin: string): Promise<number[]> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const q =
        'Get-CimInstance Win32_Process | ' +
        "Where-Object { $_.CommandLine -match 'tunnel\\s+start' -and $_.CommandLine -match 'go-ios' } | " +
        'ForEach-Object { $_.ProcessId }'
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', q],
        { timeout: 6000 },
        (_e, out) =>
          resolve(
            (out ?? '')
              .split(/\r?\n/)
              .map((s) => parseInt(s.trim(), 10))
              .filter((n) => Number.isFinite(n) && n > 0)
          )
      )
      return
    }
    // macOS/Linux: `ps -axww` prints full, untruncated command lines.
    execFile('ps', ['-axww', '-o', 'pid=,command='], { timeout: 6000 }, (_e, out) => {
      const pids: number[] = []
      for (const line of (out ?? '').split('\n')) {
        const m = /^\s*(\d+)\s+(.*)$/.exec(line)
        if (!m) continue
        const cmd = m[2]
        if (/tunnel\s+start/.test(cmd) && (cmd.includes(bin) || cmd.includes('go-ios'))) {
          pids.push(parseInt(m[1], 10))
        }
      }
      resolve(pids)
    })
  })
}

/** Kill every go-ios tunnel process we don't currently own, then wait (bounded)
 *  for the fixed tunnel port to be released so a fresh spawn can bind it. */
async function sweepStaleTunnels(bin: string): Promise<number> {
  const own = agentProc?.pid
  const exclude = (p: number): boolean => p !== own && p !== process.pid
  // Kill BOTH: go-ios processes whose command line is `tunnel start` (matched by name),
  // AND — the robust part — whatever actually holds the fixed tunnel port right now. Name
  // matching alone misses a holder from a crashed run, a differently-named binary, or a
  // stale socket owned by an unrelated pid; those are exactly what triggers "fixed port
  // busy" on the next spawn. The port lookup catches them regardless.
  const byName = (await listGoIosTunnelPids(bin)).filter(exclude)
  const byPort = (await pidsOnPort(TUNNEL_INFO_PORT)).filter(exclude)
  const stale = [...new Set([...byName, ...byPort])]
  if (stale.length === 0) return 0
  console.error(`[go-ios] clearing ${stale.length} process(es) holding the tunnel port: ${stale.join(', ')}`)
  for (const pid of stale) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone or not ours to signal */
    }
  }
  // Wait for them to exit AND the fixed port to free up before we respawn.
  for (let i = 0; i < 20; i++) {
    if (!stale.some(pidAlive) && !(await portOpen(TUNNEL_INFO_PORT, 400))) break
    await delay(150)
  }
  return stale.length
}

/** PIDs holding a local TCP port (macOS/Linux via lsof, Windows via netstat). Best-effort. */
function pidsOnPort(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('netstat', ['-ano', '-p', 'tcp'], { timeout: 6000 }, (_e, out) => {
        const pids = new Set<number>()
        for (const line of (out ?? '').split(/\r?\n/)) {
          if (new RegExp(`[:.]${port}\\b`).test(line) && /LISTENING/i.test(line)) {
            const m = /(\d+)\s*$/.exec(line.trim())
            if (m) pids.add(parseInt(m[1], 10))
          }
        }
        resolve([...pids])
      })
      return
    }
    execFile('lsof', ['-ti', `tcp:${port}`], { timeout: 6000 }, (_e, out) => {
      resolve(
        (out ?? '')
          .split(/\s+/)
          .map((s) => parseInt(s.trim(), 10))
          .filter((n) => Number.isFinite(n) && n > 0)
      )
    })
  })
}

/** Spawn the shared tunnel agent and adopt it as `agentProc`. stderr is piped so
 *  an early exit (e.g. a port clash that raced the sweep) is visible in the log
 *  and the caller can react. Returns non-ok only on a synchronous spawn failure. */
function spawnAgent(bin: string): AppActionResult {
  try {
    // GOIOS_NETWORK_TUNNEL lets our patched go-ios bring the developer tunnel up
    // over Wi-Fi (a "Network" usbmux device) — upstream skips those. This makes
    // dev-tier features (process control, MJPEG mirror, monitor, mock location)
    // work cable-free, matching the auto-switch-to-Wi-Fi flow. Verified on-device.
    //
    // NOTE: RemotePairing Wi-Fi discovery (GOIOS_WIFI_PAIRING) is intentionally
    // NOT enabled here. It works (the agent can tunnel a device usbmux hasn't
    // surfaced), but that tunnel is dev-tier only — classic-tier lockdown (Info/
    // Apps/Files) does not route over it — so a device shown via that path has a
    // broken Info tab, and it toggles with usbmux's flaky Network entry, causing
    // connect/disconnect churn. The full-function Wi-Fi path is usbmux "Network"
    // (reached cable-free via GOIOS_NETWORK_TUNNEL). Re-enable only once classic-
    // tier is routed over the RemotePairing RSD tunnel. See goios-androidlab.patch.
    const child = spawn(bin, tunnelStartArgs(), {
      stdio: ['ignore', 'ignore', 'pipe'],
      // Writable cwd is REQUIRED: tunnel start writes selfIdentity.plist relative to
      // cwd; a double-clicked app's cwd is "/" (read-only) → it failed there. See goiosCwd.
      cwd: goiosCwd(),
      env: { ...process.env, GOIOS_NETWORK_TUNNEL: '1' }
    })
    agentProc = child
    let stderr = ''
    child.stderr?.on('data', (b: Buffer) => {
      stderr += b.toString('utf8')
      if (stderr.length > 8192) stderr = stderr.slice(-8192)
    })
    child.on('error', () => {
      if (agentProc === child) agentProc = null
    })
    child.on('exit', () => {
      if (agentProc === child) agentProc = null
      if (/address already in use/i.test(stderr)) {
        console.error('[go-ios] tunnel agent exited: fixed port in use (a stale agent raced the spawn)')
      }
    })
    return { ok: true, message: '' }
  } catch (e) {
    return { ok: false, message: `Could not start developer tunnel: ${errMsg(e)}` }
  }
}

/** Ensure the shared tunnel agent is running with its info server accepting
 *  connections. Idempotent AND coalesced: reuses a live agent; if a start is already
 *  in flight, joins it (so a burst of device-rebuild triggers can't tear down the
 *  agent one of them just spawned); else sweeps orphans and spawns a fresh one. */
async function ensureAgent(bin: string): Promise<AppActionResult> {
  if (agentProc && (await portOpen(TUNNEL_INFO_PORT, 800))) return { ok: true, message: 'agent active' }
  // A start is already running — join it instead of launching a competing one that
  // would SIGKILL the in-flight agent and fight over the fixed port.
  if (agentStarting) return agentStarting
  const p = startAgent(bin)
  agentStarting = p
  // Clear the latch once this start settles (only if it's still the current one).
  void p.finally(() => {
    if (agentStarting === p) agentStarting = null
  })
  return p
}

/** The actual (serialized) agent cold-start. Only ever invoked via ensureAgent's
 *  single-flight latch. Two attempts, each preceded by a sweep of orphaned agents
 *  that would otherwise hold the fixed port; the second only fires if the spawn died
 *  early (a port race), so a genuine failure still returns after one bounded wait. */
async function startAgent(bin: string): Promise<AppActionResult> {
  stopTunnel()
  for (let attempt = 0; attempt < 2; attempt++) {
    await sweepStaleTunnels(bin)
    const spawned = spawnAgent(bin)
    if (!spawned.ok) return spawned
    for (let i = 0; i < 16; i++) {
      await delay(500)
      if (agentProc && (await portOpen(TUNNEL_INFO_PORT, 500))) return { ok: true, message: 'agent started' }
      if (agentProc === null) break // died early (likely a port clash) — re-sweep & retry
    }
    stopTunnel()
  }
  return { ok: false, message: 'Developer tunnel agent did not start (fixed port busy?).' }
}

/** Ensure a HEALTHY tunnel is up for `udid`. Brings the shared agent up (once),
 *  then waits for THIS device's tunnel — the agent creates one per connected
 *  device on its own loop, so we just poll `tunnel ls` until this udid's entry is
 *  listed and its userspace proxy port is live. Other devices' tunnels are
 *  untouched (multi-device). */
async function ensureTunnel(bin: string, udid: string): Promise<AppActionResult> {
  if (await tunnelHealthy(bin, udid)) return { ok: true, message: 'tunnel active' }
  const agent = await ensureAgent(bin)
  if (!agent.ok) return agent
  // The agent's device loop + userspace negotiation take a couple seconds per
  // device; poll until this device's proxy port is live (not just listed).
  for (let i = 0; i < 24; i++) {
    await delay(500)
    if (await tunnelHealthy(bin, udid)) return { ok: true, message: 'tunnel started' }
    // If the agent itself died, try to bring it back once before giving up.
    if (agentProc === null) {
      const restart = await ensureAgent(bin)
      if (!restart.ok) return restart
    }
  }
  return {
    ok: false,
    message: 'Developer tunnel did not come up — check the device is unlocked, trusted, and has Developer Mode enabled.'
  }
}

/** Proactively bring up the shared tunnel agent (no specific device). Once it's
 *  running it creates a tunnel for EVERY connected device on its own loop (USB and
 *  — with our patch — Wi-Fi), so dev-tier is ready the moment a device appears
 *  without the user opening a dev-tier tab. Idempotent (reuses a live agent). */
export async function ensureAgentRunning(bin: string): Promise<AppActionResult> {
  return ensureAgent(bin)
}

/** Kill the shared tunnel agent, stopping every device's tunnel (called on the
 *  explicit "stop tunnel" action and on window close / app quit). Uses SIGKILL — the
 *  go-ios userspace tunnel does NOT exit promptly on SIGTERM, so a plain .kill() left it
 *  running: it orphaned when the app quit and kept holding the fixed port, which is why
 *  reopening the app hit "fixed port busy". We also force-free the port synchronously in
 *  case our handle was already lost (a prior agent we no longer track) — synchronous so it
 *  completes before the process exits on quit. */
export function stopTunnel(): void {
  const pid = agentProc?.pid
  agentProc = null
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  freeTunnelPortSync()
}

/** Synchronously SIGKILL whatever is still holding the fixed tunnel port. Best-effort;
 *  swallows everything (nothing on the port, or lsof/ps unavailable). */
function freeTunnelPortSync(): void {
  try {
    if (process.platform === 'win32') return // best-effort; skip on Windows
    const out = execFileSync('lsof', ['-ti', `tcp:${TUNNEL_INFO_PORT}`], { timeout: 3000 }).toString()
    for (const s of out.split(/\s+/)) {
      const p = parseInt(s.trim(), 10)
      if (Number.isFinite(p) && p > 0 && p !== process.pid) {
        try {
          process.kill(p, 'SIGKILL')
        } catch {
          /* gone */
        }
      }
    }
  } catch {
    /* nothing listening / lsof unavailable */
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
      proc = spawn(bin, setLocationArgs(udid, lat, lon), { stdio: ['ignore', 'ignore', 'pipe'], cwd: goiosCwd() })
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

  const proc = spawn(bin, ['sysmontap', '--udid', udid], { stdio: ['ignore', 'ignore', 'pipe'], cwd: goiosCwd() })
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
  const proc = spawn(bin, syslogArgs(udid), { stdio: ['ignore', 'pipe', 'ignore'], cwd: goiosCwd() })
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
    let prefs
    try {
      prefs = plistValueToPrefs(parsePlist(readFileSync(inner)))
    } catch (e) {
      return { ok: false, error: `Couldn't decode ${fname}: ${errMsg(e)}`, fname, prefs: [] }
    }
    return { ok: true, error: '', fname, prefs }
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
