/**
 * adb binary discovery + device/app queries.
 * Faithful port of logcat_viewer/adb.py (find_adb, list_devices) and
 * logcat_viewer/apps.py (list_packages, running_processes, list_apps,
 * list_clones, resolve_pids, force_crash).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, delimiter } from 'node:path'
import { app } from 'electron'
import type { AppEntry, Device } from '@shared/types'

// Common macOS locations for adb if it isn't on PATH.
const FALLBACK_ADB = [
  join(homedir(), 'Android/sdk/platform-tools/adb'),
  join(homedir(), 'Library/Android/sdk/platform-tools/adb'),
  '/opt/homebrew/bin/adb',
  '/usr/local/bin/adb'
]

function whichAdb(): string | null {
  const paths = (process.env.PATH ?? '').split(delimiter)
  for (const dir of paths) {
    if (!dir) continue
    const cand = join(dir, 'adb')
    if (existsSync(cand)) return cand
  }
  return null
}

function bundledAdb(): string | null {
  if (!app.isPackaged) return null
  const cand = join(process.resourcesPath, 'platform-tools', 'adb')
  return existsSync(cand) ? cand : null
}

let cachedAdb: string | null | undefined

/** Resolve the adb binary: $ADB -> bundled copy -> PATH -> common SDK paths. */
export function findAdb(): string | null {
  if (cachedAdb !== undefined) return cachedAdb
  const env = process.env.ADB
  if (env && existsSync(env)) return (cachedAdb = env)
  const bundled = bundledAdb()
  if (bundled) return (cachedAdb = bundled)
  const which = whichAdb()
  if (which) return (cachedAdb = which)
  for (const cand of FALLBACK_ADB) {
    if (existsSync(cand)) return (cachedAdb = cand)
  }
  return (cachedAdb = null)
}

interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

/** Run adb with args; never throws — mirrors apps.py's try/except returning "". */
export function run(
  adb: string,
  serial: string | null,
  args: string[],
  timeoutMs = 8000
): Promise<RunResult> {
  const cmd = serial ? ['-s', serial, ...args] : args
  return new Promise((resolve) => {
    execFile(
      adb,
      cmd,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
        })
      }
    )
  })
}

/** Convenience: stdout only, '' on any error. */
async function sh(adb: string, serial: string | null, args: string[], timeoutMs = 8000): Promise<string> {
  const r = await run(adb, serial, args, timeoutMs)
  return r.stdout
}

/** Binary-clean run (screencap/screenrecord payloads). `args` should carry its
 *  own `-s <serial>` when needed. Never throws. */
export function runBinary(
  adb: string,
  args: string[],
  timeoutMs = 20000
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      adb,
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' },
      (_err, stdout, stderr) => {
        resolve({
          stdout: (stdout as Buffer) ?? Buffer.alloc(0),
          stderr: stderr ? stderr.toString('utf8') : ''
        })
      }
    )
  })
}

function deviceLabel(serial: string, description: string, online: boolean): string {
  const extra = description ? ` — ${description}` : ''
  const state = online ? '' : ''
  return `${serial}${extra}${state}`
}

/** Run `adb devices -l` and parse the table. */
export async function listDevices(adb: string): Promise<Device[]> {
  const out = await sh(adb, null, ['devices', '-l'])
  const devices: Device[] = []
  const lines = out.split('\n').slice(1) // skip "List of devices attached"
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('*')) continue
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    const serial = parts[0]
    const state = parts[1]
    const descBits: string[] = []
    for (const p of parts.slice(2)) {
      if (p.startsWith('model:')) descBits.unshift(p.split(':', 2)[1].replace(/_/g, ' '))
      else if (p.startsWith('device:')) descBits.push(p.split(':', 2)[1])
    }
    const online = state === 'device'
    const description = descBits.join(' ')
    const stateSuffix = online ? '' : ` [${state}]`
    devices.push({
      serial,
      state,
      description,
      online,
      label: deviceLabel(serial, description, online) + stateSuffix,
      platform: 'android',
      // Wireless-adb devices connect by ip:port serial; USB serials have no colon.
      transports: [serial.includes(':') ? 'wifi' : 'usb']
    })
  }
  return devices
}

/** Installed package names via `pm list packages`. */
async function listPackages(adb: string, serial: string): Promise<string[]> {
  const out = await sh(adb, serial, ['shell', 'pm', 'list', 'packages'])
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('package:'))
    .map((l) => l.slice('package:'.length))
}

/** (pid, name) for every running process — full Android process names. */
async function runningProcesses(adb: string, serial: string): Promise<Array<[number, string]>> {
  let out = await sh(adb, serial, ['shell', 'ps', '-A', '-o', 'PID,NAME'])
  const procs: Array<[number, string]> = []
  for (const line of out.split('\n')) {
    const trimmed = line.trim()
    const idx = trimmed.search(/\s/)
    if (idx <= 0) continue
    const pidStr = trimmed.slice(0, idx)
    const name = trimmed.slice(idx).trim()
    if (/^\d+$/.test(pidStr) && name) procs.push([parseInt(pidStr, 10), name])
  }
  if (procs.length === 0) {
    // fallback for `ps` builds without -o support
    out = await sh(adb, serial, ['shell', 'ps', '-A'])
    for (const line of out.split('\n')) {
      const cols = line.split(/\s+/).filter(Boolean)
      if (cols.length >= 2 && /^\d+$/.test(cols[1])) {
        procs.push([parseInt(cols[1], 10), cols[cols.length - 1]])
      }
    }
  }
  return procs
}

function baseName(name: string): string {
  return name.split(':', 1)[0]
}

const KNOWN_HOSTS = ['com.glite.poc', 'com.gbag.poc', 'top.niunaijun.blackboxa']

/** Map VA-host package -> list of cloned package names installed inside it. */
async function listClones(adb: string, serial: string): Promise<Record<string, string[]>> {
  const clones: Record<string, string[]> = {}

  // 1) rooted glob — one shot, every host.
  const out = await sh(adb, serial, ['shell', 'ls -d /data/data/*/blackbox/data/app/*/ 2>/dev/null'])
  for (const line of out.split('\n')) {
    const parts = line.trim().replace(/\/+$/, '').split('/')
    // ['', 'data', 'data', <host>, 'blackbox', 'data', 'app', <clone>]
    if (parts.length >= 8 && parts[1] === 'data' && parts[2] === 'data' && parts.includes('blackbox')) {
      ;(clones[parts[3]] ??= []).push(parts[parts.length - 1])
    }
  }
  if (Object.keys(clones).length > 0) return clones

  // 2) run-as fallback (no root).
  const candidates = new Set<string>(KNOWN_HOSTS)
  for (const [, name] of await runningProcesses(adb, serial)) {
    if (name.includes(':')) candidates.add(baseName(name))
  }
  for (const host of candidates) {
    const listing = await sh(adb, serial, ['shell', 'run-as', host, 'ls', 'blackbox/data/app/'])
    const names = listing
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !l.includes('/') &&
          !l.toLowerCase().includes('not debuggable') &&
          !l.toLowerCase().includes('no such') &&
          !l.toLowerCase().includes('unknown')
      )
    if (names.length > 0) clones[host] = names
  }
  return clones
}

/** Sorted list of OS-installed packages + VA clones, marked. */
export async function listApps(adb: string, serial: string): Promise<AppEntry[]> {
  const device = new Set(await listPackages(adb, serial))
  device.delete('')
  const cloneMap = await listClones(adb, serial)
  const cloneToHost = new Map<string, string>()
  for (const [host, cl] of Object.entries(cloneMap)) {
    for (const c of cl) cloneToHost.set(c, host)
  }
  const cloneNames = [...cloneToHost.keys()].sort()
  const deviceOnly = [...device].filter((d) => !cloneToHost.has(d)).sort()

  const entries: AppEntry[] = []
  for (const c of cloneNames) entries.push({ pkg: c, clone: true, host: cloneToHost.get(c) ?? '' })
  for (const d of deviceOnly) entries.push({ pkg: d, clone: false, host: '' })
  return entries
}

/** PIDs of processes named `package` or `package:<suffix>`. */
export async function resolvePids(adb: string, serial: string, pkg: string): Promise<number[]> {
  const pids: number[] = []
  for (const [pid, name] of await runningProcesses(adb, serial)) {
    if (name === pkg || name.startsWith(pkg + ':')) pids.push(pid)
  }
  return pids
}

/** Force an app to die: `am force-stop` + `kill -9` of the given PIDs. */
export async function forceCrash(
  adb: string,
  serial: string,
  pkg: string,
  pids: number[]
): Promise<string[]> {
  const notes: string[] = []
  if (pkg) {
    await run(adb, serial, ['shell', 'am', 'force-stop', pkg], 6000)
    notes.push(`force-stop ${pkg}`)
  }
  const uniq = [...new Set(pids)].sort((a, b) => a - b)
  if (uniq.length > 0) {
    await run(adb, serial, ['shell', 'kill', '-9', ...uniq.map(String)], 6000)
    notes.push('kill ' + uniq.join(','))
  }
  return notes
}
