/**
 * iOS touch/keyboard forwarding service (macOS, go-ios).
 *
 * Persists the user's App Store Connect signing identity (Key ID + Issuer ID + a
 * path to the `.p8` — NEVER the key bytes), provisions a P12 + profile from it,
 * signs + installs the on-device automation agent (DeviceKit / WebDriverAgent),
 * and then exposes `ui tap/swipe/type/button/size` for the mirror to inject input.
 * All `ui` commands go over the iOS-17+ developer tunnel (reused from services/goios).
 *
 * Unlike the screen mirror, this is NOT self-contained: it needs the user's Apple
 * signing identity and downloads + installs an agent app onto the device.
 */
import { app, dialog, safeStorage, type BrowserWindow } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import {
  appsListArgs,
  ascReady,
  defaultConfig,
  findWdaBundleId,
  forwardArgs,
  manualReady,
  parseUiSize,
  provisionArgs,
  runWdaArgs,
  uiInstallArgs,
  uiSizeArgs,
  uiStatusArgs,
  WDA_LOCAL_URL,
  WDA_PORT,
  type IosInputConfig,
  type UiDriverOpts
} from '@core/iosinput'
import { deviceKitKey, pathToGestureActions, pathToPointerActions, wdaKeyValue, type DkPathPoint } from '@core/iosinput'
import * as devicekit from './devicekit'
import { startTunnel } from './goios'

/** `ui status`/`ui size` (called once when enabling touch) still go through go-ios;
 *  the hot path (tap/swipe/type) talks to WebDriverAgent's HTTP API directly. */
const WDA_DRIVER: UiDriverOpts = { driver: 'wda', wdaUrl: WDA_LOCAL_URL }
/** `ui size` when DeviceKit is the active agent (its runner serves :12004). */
const DK_DRIVER: UiDriverOpts = { driver: 'devicekit' }

/** Which agent the injection hot-path routes to. DeviceKit (WebSocket + full-path
 *  gesture) is preferred; WebDriverAgent (HTTP) is the fallback. Set by ensureAgent(). */
type ActiveAgent = 'devicekit' | 'wda' | null
let activeAgent: ActiveAgent = null

function configPath(): string {
  return join(app.getPath('userData'), 'ios-input.json')
}

/** Directory for generated signing assets (P12 + provisioning profile). */
function assetsDir(): string {
  const d = join(app.getPath('userData'), 'ios-agent')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

export function loadConfig(): IosInputConfig {
  const def = defaultConfig()
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>
    const str = (k: string, d: string): string => (typeof raw[k] === 'string' ? (raw[k] as string) : d)
    const cfg: IosInputConfig = {
      method: raw.method === 'asc' ? 'asc' : 'manual',
      agent: raw.agent === 'wda' ? 'wda' : 'devicekit',
      p12Path: str('p12Path', ''),
      p12Password: '',
      profilePath: str('profilePath', ''),
      keyId: str('keyId', ''),
      issuerId: str('issuerId', ''),
      p8Path: str('p8Path', ''),
      bundleId: str('bundleId', def.bundleId),
      provisioned: raw.provisioned === true
    }
    // The P12 password is persisted ENCRYPTED (macOS Keychain via safeStorage), never
    // plaintext. Fall back to a plaintext field only if encryption is unavailable.
    const enc = str('p12PasswordEnc', '')
    if (enc && safeStorage.isEncryptionAvailable()) {
      try {
        cfg.p12Password = safeStorage.decryptString(Buffer.from(enc, 'base64'))
      } catch {
        /* stale/other-key ciphertext — leave blank */
      }
    } else {
      cfg.p12Password = str('p12Password', '')
    }
    return cfg
  } catch {
    return def
  }
}

export function saveConfig(cfg: Partial<IosInputConfig>): IosInputConfig {
  const merged = { ...loadConfig(), ...cfg }
  const { p12Password, ...rest } = merged
  const onDisk: Record<string, unknown> = { ...rest }
  // Encrypt the P12 password at rest (OS keychain-backed). No plaintext key material.
  if (p12Password) {
    if (safeStorage.isEncryptionAvailable()) {
      onDisk.p12PasswordEnc = safeStorage.encryptString(p12Password).toString('base64')
    } else {
      onDisk.p12Password = p12Password
    }
  }
  writeFileSync(configPath(), JSON.stringify(onDisk, null, 2), 'utf8')
  return { ...merged }
}

type PickKind = 'p8' | 'p12' | 'profile'
const PICK: Record<PickKind, { title: string; name: string; ext: string[] }> = {
  p8: { title: 'Select your App Store Connect API key (.p8)', name: 'App Store Connect API key', ext: ['p8'] },
  p12: { title: 'Select your signing certificate (.p12)', name: 'PKCS#12 certificate', ext: ['p12', 'pfx'] },
  profile: { title: 'Select your provisioning profile', name: 'Provisioning profile', ext: ['mobileprovision'] }
}

/** File picker for a signing asset — returns its path (we never copy the file). */
export async function chooseFile(win: BrowserWindow | null, kind: PickKind): Promise<string | null> {
  const k = PICK[kind] ?? PICK.p12
  const opts = {
    title: k.title,
    properties: ['openFile'] as Array<'openFile'>,
    filters: [{ name: k.name, extensions: k.ext }]
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
}

// --- go-ios exec helper ------------------------------------------------------
interface RunResult {
  code: number
  stdout: string
  stderr: string
}
function run(bin: string, args: string[], timeout = 120000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/** Last non-empty line of stderr/stdout (go-ios reports errors on either). */
function lastLine(...streams: string[]): string {
  for (const s of streams) {
    const line = s
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop()
    if (line) return line
  }
  return ''
}

// --- P12 re-encode (Keychain → go-ios legacy format) -------------------------
// go-ios's Go PKCS#12 reader only understands the legacy ciphers (3DES key +
// RC2-40 cert); modern Keychain Access exports use AES (PBES2) and fail with
// "pkcs12: certificate missing". Re-encode the user's .p12 to the legacy format so
// any Keychain export just works — the plaintext key only ever transits a pipe.
function opensslBin(): string {
  for (const c of ['/opt/homebrew/bin/openssl', '/usr/local/bin/openssl', '/usr/bin/openssl']) {
    if (existsSync(c)) return c
  }
  return 'openssl'
}

function supportsLegacy(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(bin, ['pkcs12', '-help'], { timeout: 6000 }, (_e, stdout, stderr) => {
      resolve(/-legacy\b/.test(`${stdout ?? ''}${stderr ?? ''}`))
    })
  })
}

function opensslVersion(bin: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, ['version'], { timeout: 6000 }, (_e, stdout) => resolve((stdout ?? '').trim()))
  })
}

/** Re-encode `p12Path` (any cipher) → a legacy .p12 go-ios can read, same password.
 *  `openssl pkcs12 -export` needs a file input (not stdin), so it's a two-step: decrypt
 *  to a PEM, then export as legacy. The plaintext PEM lives only inside the user-only
 *  app-support dir and is deleted immediately (even on error). Returns the new path, or
 *  null if openssl couldn't read the input (wrong password / not a p12).
 *  Emits verbose openssl diagnostics through `onProgress` so failures are visible in the
 *  UI log (which step, exit code, stderr, and whether the cert/key survived each step). */
type LegacyResult = { path: string } | { error: string }

async function toLegacyP12(p12Path: string, password: string, onProgress: (line: string) => void): Promise<LegacyResult> {
  const bin = opensslBin()
  const [ver, legacy] = await Promise.all([opensslVersion(bin), supportsLegacy(bin)]) // OpenSSL 3 needs -legacy to WRITE old ciphers
  onProgress(`openssl: ${bin}${ver ? ` — ${ver}` : ''}`)
  onProgress(`legacy provider: ${legacy ? 'available' : 'unavailable'}; input password: ${password ? 'provided' : '(blank)'}`)
  const out = join(assetsDir(), 'signing.p12')
  const pem = join(assetsDir(), 'signing.pem')
  const env = { ...process.env, P12PW: password }
  const run = (args: string[]): Promise<{ code: number; stderr: string }> =>
    new Promise((resolve) => {
      execFile(bin, args, { env, timeout: 30000 }, (e, _o, stderr) => {
        const code = e && typeof (e as { code?: number }).code === 'number' ? (e as { code: number }).code : e ? 1 : 0
        resolve({ code, stderr: (stderr ?? '').trim() })
      })
    })
  const emitStderr = (s: string): void => {
    for (const l of s.split('\n').map((x) => x.trim()).filter(Boolean)) onProgress(`  openssl: ${l}`)
  }
  try {
    if (existsSync(out)) rmSync(out)
    if (existsSync(pem)) rmSync(pem)
  } catch {
    /* ignore */
  }
  try {
    // 1) decrypt → unencrypted PEM. PREFER the legacy provider when available: OpenSSL 3
    //    loads it IN ADDITION to the default, so it reads both modern (PBES2/AES) key bags
    //    AND legacy (RC2-40) cert bags — exactly the mix macOS Keychain produces. The
    //    default provider ALONE errors on a legacy cert bag ("RC2-40-CBC unsupported") and
    //    drops everything, so fall back to it only when the legacy provider is unavailable.
    const readArgs = (extra: string[]): string[] => ['pkcs12', '-in', p12Path, '-passin', 'env:P12PW', '-nodes', '-out', pem, ...extra]
    onProgress(`Step 1/2: reading the .p12 (${legacy ? 'legacy' : 'default'} provider)…`)
    let r = await run(readArgs(legacy ? ['-legacy'] : []))
    if (r.stderr) emitStderr(r.stderr)
    onProgress(`  exit ${r.code}; PEM written: ${existsSync(pem) ? 'yes' : 'no'}`)
    if ((r.code !== 0 || !existsSync(pem)) && legacy) {
      onProgress('Step 1/2: retrying the read with the default provider…')
      try {
        if (existsSync(pem)) rmSync(pem)
      } catch {
        /* ignore */
      }
      r = await run(readArgs([]))
      if (r.stderr) emitStderr(r.stderr)
      onProgress(`  exit ${r.code}; PEM written: ${existsSync(pem) ? 'yes' : 'no'}`)
    }
    if (r.code !== 0 || !existsSync(pem)) {
      onProgress('Step 1/2 FAILED: could not decrypt the .p12 (wrong password, or not a certificate export).')
      return { error: 'Could not read the .p12 — check the password is correct and the file is a certificate export.' }
    }
    // Diagnostic: did the read keep BOTH the certificate and the private key? A PEM with a
    // key but no cert is the classic "pkcs12: certificate missing" cause downstream.
    try {
      const pemText = readFileSync(pem, 'utf8')
      const hasCert = /-----BEGIN CERTIFICATE-----/.test(pemText)
      const hasKey = /-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(pemText)
      onProgress(`  PEM contents: certificate ${hasCert ? '✓' : '✗ MISSING'}, private key ${hasKey ? '✓' : '✗ MISSING'}`)
      if (!hasCert) {
        onProgress('Step 1/2 FAILED: the .p12 decrypted but contains no certificate.')
        return {
          error:
            'This .p12 has the private key but NO certificate. In Keychain Access, export the item under "My Certificates" (the certificate row with a ▸ that reveals the key) — not the standalone key under "Keys".'
        }
      }
    } catch {
      /* non-fatal — continue to the export */
    }
    // 2) re-export as legacy (3DES key + RC2-40 cert) — the only PKCS#12 go-ios reads.
    onProgress('Step 2/2: re-encoding as a legacy .p12…')
    const w = await run(['pkcs12', '-export', '-in', pem, '-passout', 'env:P12PW', '-out', out, ...(legacy ? ['-legacy'] : [])])
    if (w.stderr) emitStderr(w.stderr)
    onProgress(`  exit ${w.code}; .p12 written: ${existsSync(out) ? 'yes' : 'no'}`)
    if (w.code !== 0 || !existsSync(out)) {
      onProgress('Step 2/2 FAILED: could not re-encode to the legacy format.')
      return { error: 'Could not re-encode the certificate to the legacy format openssl/go-ios needs.' }
    }
    onProgress('Certificate ready (legacy .p12).')
    return { path: out }
  } finally {
    try {
      if (existsSync(pem)) rmSync(pem)
    } catch {
      /* ignore */
    }
  }
}

// --- provision + install -----------------------------------------------------
let provProc: ChildProcess | null = null
let provToken = 0

/** Sign + install the on-device agent, then verify it. Two routes:
 *  - manual: use the user's own `.p12` + `.mobileprovision` directly (no ASC).
 *  - asc: create the P12 + profile from an App Store Connect API key first.
 *  Takes the LIVE config from the modal (so the P12 password never touches disk).
 *  Long-running; reports progress lines. Returns ok + a final message. */
export async function provision(
  bin: string,
  udid: string,
  cfg: IosInputConfig,
  onProgress: (line: string) => void
): Promise<{ ok: boolean; message: string }> {
  const token = ++provToken
  let p12: string
  let profile: string
  let p12password: string | undefined

  if (cfg.method === 'manual') {
    if (!manualReady(cfg)) return { ok: false, message: 'Select your certificate (.p12) and provisioning profile (.mobileprovision) first.' }
    if (!existsSync(cfg.p12Path)) return { ok: false, message: 'The .p12 file no longer exists at the saved path — re-select it.' }
    if (!existsSync(cfg.profilePath)) return { ok: false, message: 'The .mobileprovision file no longer exists — re-select it.' }
    // Keychain exports use AES, which go-ios's Go PKCS#12 reader rejects — re-encode
    // to the legacy format it understands (same password).
    onProgress('Preparing the certificate…')
    const legacy = await toLegacyP12(cfg.p12Path, cfg.p12Password || '', onProgress)
    if (token !== provToken) return { ok: false, message: 'cancelled' }
    if ('error' in legacy) {
      return { ok: false, message: legacy.error }
    }
    p12 = legacy.path
    profile = cfg.profilePath
    p12password = cfg.p12Password || undefined
  } else {
    if (!ascReady(cfg)) return { ok: false, message: 'Enter your Key ID, Issuer ID, .p8 path, and bundle id first.' }
    if (!existsSync(cfg.p8Path)) return { ok: false, message: 'The .p8 key file no longer exists at the saved path — re-select it.' }
    p12 = join(assetsDir(), 'agent.p12')
    profile = join(assetsDir(), 'agent.mobileprovision')
    onProgress('Creating signing assets via App Store Connect…')
    const prov = await runCancelable(bin, provisionArgs(udid, cfg, p12, profile))
    if (token !== provToken) return { ok: false, message: 'cancelled' }
    if (prov.code !== 0 || !existsSync(p12) || !existsSync(profile)) {
      return { ok: false, message: `Provisioning failed: ${lastLine(prov.stderr, prov.stdout) || 'App Store Connect rejected the request'}` }
    }
  }

  // Sign + install the agent (downloads the agent IPA when no --path is given).
  onProgress(`Signing + installing the ${cfg.agent === 'wda' ? 'WebDriverAgent' : 'DeviceKit'} agent (this can take a minute)…`)
  const inst = await runCancelable(bin, uiInstallArgs(udid, cfg.agent, p12, profile, p12password))
  if (token !== provToken) return { ok: false, message: 'cancelled' }
  if (inst.code !== 0) {
    for (const l of `${inst.stderr}\n${inst.stdout}`.split('\n').map((x) => x.trim()).filter(Boolean)) onProgress(`  go-ios: ${l}`)
    return { ok: false, message: `Install failed: ${lastLine(inst.stderr, inst.stdout) || 'could not sign/install the agent'}` }
  }

  // Launch the agent (runwda + forward) and confirm it answers.
  saveConfig({ provisioned: true })
  onProgress('Launching the agent + verifying it responds…')
  const reachable = await ensureAgent(bin, udid, onProgress)
  return {
    ok: true,
    message: reachable
      ? 'Touch input is ready — the agent is installed and reachable.'
      : 'Agent installed. First launch can take a moment (or a "Trust" tap on the device) — enable the 👆 touch button in the mirror to start it.'
  }
}

// --- agent runtime (WebDriverAgent) ------------------------------------------
// `ui tap/status/...` connect to a locally-listening agent; they do NOT launch it.
// So we keep two long-lived go-ios children per device: `runwda` (the XCUITest
// runner, which serves WDA on device port 8100) and `forward` (device 8100 →
// 127.0.0.1:8100). Both are torn down on device switch / app quit.
let wdaProc: ChildProcess | null = null
let fwdProc: ChildProcess | null = null
let agentUdid: string | null = null

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Spawn a long-lived, detached-from-us go-ios child, logging nothing to disk. */
function spawnAgentChild(bin: string, args: string[]): ChildProcess {
  const child = spawn(bin, args, { stdio: 'ignore' })
  child.on('error', () => {})
  return child
}

function stopAgent(): void {
  for (const p of [wdaProc, fwdProc]) {
    if (p) {
      try {
        p.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
  wdaProc = null
  fwdProc = null
  agentUdid = null
  wdaSession = null // the forwarded :8100 is gone with it
}

/** Is WDA answering right now? (quick, no launch) */
async function wdaReady(bin: string, udid: string, timeout = 8000): Promise<boolean> {
  const r = await run(bin, uiStatusArgs(udid, WDA_DRIVER), timeout)
  return r.code === 0 && /"ready"\s*:\s*true/i.test(r.stdout)
}

/** Ensure an input agent is up for this device, preferring **WebDriverAgent**. Measured on
 *  device: WDA types ~6× faster than the pinned DeviceKit 0.0.18 (whose `device.io.text` has a
 *  ~1.8s fixed cost) AND supports Backspace/arrows via `/wda/keys`, with equivalent tap/drag
 *  latency — so it's the better default across the board. DeviceKit stays as a fallback (its
 *  WebSocket path is only a win if a newer DeviceKit with fast text/`device.io.keys` is
 *  installed). Sets `activeAgent` so the injection hot-path routes correctly. */
export async function ensureAgent(bin: string, udid: string, onProgress: (line: string) => void = () => {}): Promise<boolean> {
  // Honor the user's configured agent. Only ONE XCUITest session can run at a time, so
  // whichever we pick, the other runner is torn down first. DeviceKit is required for
  // hardware buttons other than home (lock / volume) — WDA's pressButton can't do them.
  const prefer = loadConfig().agent
  if (prefer === 'devicekit') {
    stopAgent() // tear down any WDA runner first
    if (await devicekit.ensure(bin, udid, onProgress)) {
      activeAgent = 'devicekit'
      return true
    }
    // DeviceKit couldn't come up — fall back to WDA (home + gestures still work; volume won't).
    if (await ensureWda(bin, udid, onProgress)) {
      activeAgent = 'wda'
      return true
    }
    activeAgent = null
    return false
  }
  // Prefer WDA. If it comes up, tear down any DeviceKit runner and route to WDA.
  if (await ensureWda(bin, udid, onProgress)) {
    devicekit.stop()
    activeAgent = 'wda'
    return true
  }
  // Fallback: DeviceKit (WebSocket). Tear down any WDA runner first.
  stopAgent()
  const ok = await devicekit.ensure(bin, udid, onProgress)
  activeAgent = ok ? 'devicekit' : null
  return ok
}

/** WebDriverAgent path: install-check → launch `runwda` + `forward` → poll `ui status`.
 *  Idempotent; ~40s budget. Switching device tears down the old runner. */
async function ensureWda(bin: string, udid: string, onProgress: (line: string) => void = () => {}): Promise<boolean> {
  if (agentUdid && agentUdid !== udid) stopAgent()

  const tun = await startTunnel(bin, udid)
  if (!tun.ok) {
    onProgress(`  agent: tunnel not up (${tun.message})`)
    return false
  }
  // Already running? (children alive + WDA answering)
  if (wdaProc && fwdProc && agentUdid === udid && (await wdaReady(bin, udid))) return true

  // Find the installed WebDriverAgent runner bundle id (go-ios rebrands it).
  const apps = await run(bin, appsListArgs(udid), 30000)
  const wdaBundle = findWdaBundleId(apps.stdout)
  if (!wdaBundle) {
    onProgress('  agent: WebDriverAgent is not installed — (re)install the input agent first.')
    return false
  }
  onProgress(`  agent: launching ${wdaBundle}…`)

  // (Re)start the runner + port forward.
  stopAgent()
  agentUdid = udid
  wdaProc = spawnAgentChild(bin, runWdaArgs(udid, wdaBundle))
  fwdProc = spawnAgentChild(bin, forwardArgs(udid, WDA_PORT, WDA_PORT))
  wdaProc.on('exit', () => {
    if (wdaProc && agentUdid === udid) {
      wdaProc = null
    }
  })

  // Poll until WDA answers (test-runner boot + first HTTP bind take a few seconds).
  for (let i = 0; i < 20; i++) {
    if (agentUdid !== udid) return false // device switched under us
    await delay(2000)
    if (!wdaProc) {
      onProgress('  agent: the WebDriverAgent runner exited early — check signing/Trust on the device.')
      return false
    }
    if (await wdaReady(bin, udid, 6000)) {
      onProgress('  agent: ready.')
      return true
    }
  }
  onProgress('  agent: not ready yet (timed out waiting for WebDriverAgent).')
  return false
}

/** Fast "is the agent reachable" gate for the hot path (nav buttons / injection): if the
 *  runner + forward children are alive for this device, assume up (a stale WDA session is
 *  recreated by withSession anyway); otherwise do the full ensureAgent cold-start. Lets the
 *  nav buttons work without the touch toggle, yet stay snappy after the first press. */
async function ensureUp(bin: string, udid: string): Promise<boolean> {
  if (activeAgent === 'devicekit' && devicekit.reachable()) return true
  if (activeAgent === 'wda' && wdaProc && fwdProc && agentUdid === udid) return true
  return ensureAgent(bin, udid)
}

/** Stop the agent runtime (device switch / app quit). */
export function shutdown(): void {
  cancelProvision()
  devicekit.stop()
  stopAgent()
  sizeCache = null
}

/** Run a long go-ios step as the tracked `provProc` so cancelProvision() can kill it. */
function runCancelable(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    provProc = child
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')))
    const done = (code: number): void => {
      if (provProc === child) provProc = null
      resolve({ code, stdout, stderr })
    }
    child.on('close', (c) => done(c ?? 0))
    child.on('error', () => done(1))
  })
}

export function cancelProvision(): void {
  provToken++
  if (provProc) {
    try {
      provProc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    provProc = null
  }
}

/** Is the agent installed + reachable right now? Launches WDA if needed (this is what
 *  the mirror's touch toggle calls), so the first call can take a few seconds. */
export async function status(bin: string, udid: string): Promise<boolean> {
  if (!loadConfig().provisioned) return false
  return ensureAgent(bin, udid)
}

// --- input injection: direct WebDriverAgent HTTP ------------------------------
// Spawning `ios ui tap` per gesture cost ~700ms (process launch + a NEW WDA session
// each time + go-ios probing an endpoint this WDA build rejects, then falling back to
// W3C /actions). Instead talk to WDA's HTTP server (127.0.0.1:8100, forwarded by
// ensureAgent) DIRECTLY, over ONE reused session created with quiescence/idle waits
// disabled (~360ms → about half the latency). Gestures are serialized so they never
// overlap (overlapping taps make WDA mis-route them — the "not always correct" bug).

interface WdaResp {
  status: number
  json: Record<string, unknown> | null
  text: string
}

/** One HTTP call to the forwarded WDA. Never throws (resolves an error shape). */
function wda(method: string, path: string, body?: unknown, timeout = 12000): Promise<WdaResp> {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: WDA_PORT,
        method,
        path,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': data.length } : {})
        },
        timeout
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: Record<string, unknown> | null = null
          try {
            json = JSON.parse(text) as Record<string, unknown>
          } catch {
            /* non-JSON */
          }
          resolve({ status: res.statusCode ?? 0, json, text })
        })
      }
    )
    req.on('error', () => resolve({ status: 0, json: null, text: '' }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, json: null, text: '' })
    })
    if (data) req.write(data)
    req.end()
  })
}

let wdaSession: string | null = null

/** WDA sessions are app-scoped and die on app switches ("invalid session id"). Create
 *  one lazily with quiescence + idle waits OFF so taps are as fast as this WDA allows. */
async function ensureSession(): Promise<string | null> {
  if (wdaSession) return wdaSession
  const r = await wda('POST', '/session', {
    capabilities: { alwaysMatch: { 'appium:waitForQuiescence': false } },
    desiredCapabilities: { shouldWaitForQuiescence: false, shouldUseCompactResponses: true }
  })
  const sid = r.json && typeof r.json.sessionId === 'string' ? (r.json.sessionId as string) : null
  if (!sid) return null
  wdaSession = sid
  // Zero the idle/animation waits — this is what drops a tap from ~600ms to ~360ms.
  await wda('POST', `/session/${sid}/appium/settings`, {
    settings: { shouldWaitForQuiescence: false, waitForIdleTimeout: 0, animationCoolOffTimeout: 0, snapshotMaxDepth: 1, useCompactResponses: true }
  })
  return sid
}

/** True if the response says the session went stale (app switch / home). */
function sessionInvalid(r: WdaResp): boolean {
  return r.status === 404 || /invalid session id|session does not exist/i.test(r.text)
}

/** Run a WDA action against the live session, recreating it once if it went stale. */
async function withSession(fn: (sid: string) => Promise<WdaResp>): Promise<void> {
  let sid = await ensureSession()
  if (!sid) return
  let r = await fn(sid)
  if (sessionInvalid(r)) {
    wdaSession = null
    sid = await ensureSession()
    if (!sid) return
    r = await fn(sid)
  }
}

// Serialize gestures: each one waits for the previous to finish so WDA processes them
// in the order the user made them (and never two at once).
let inputChain: Promise<void> = Promise.resolve()
function enqueue(job: () => Promise<void>): void {
  inputChain = inputChain.then(job, job)
}

/** A W3C pointer gesture: press at (x1,y1), optionally drag to (x2,y2) over `moveMs`. */
function pointerGesture(x1: number, y1: number, x2: number, y2: number, moveMs: number): unknown {
  const acts: Array<Record<string, unknown>> = [
    { type: 'pointerMove', duration: 0, x: Math.round(x1), y: Math.round(y1) },
    { type: 'pointerDown', button: 0 }
  ]
  if (x2 !== x1 || y2 !== y1 || moveMs > 0) {
    acts.push({ type: 'pointerMove', duration: Math.max(0, Math.round(moveMs)), x: Math.round(x2), y: Math.round(y2) })
  }
  acts.push({ type: 'pointerUp', button: 0 })
  return { actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: acts }] }
}

// The device size (points) is stable per device, but `ui size` spawns a go-ios
// subprocess (~hundreds of ms) — far too slow to run on every nav-button press.
// Cache it per-udid so the app-switcher gesture reads it instantly after the first
// call. Cleared on app quit; the udid key makes a device switch a natural miss.
let sizeCache: { udid: string; width: number; height: number } | null = null

/** `ui size` → points, cached per device (agent must already be up). */
async function cachedSize(bin: string, udid: string): Promise<{ width: number; height: number } | null> {
  if (sizeCache && sizeCache.udid === udid) return { width: sizeCache.width, height: sizeCache.height }
  const driver = activeAgent === 'devicekit' ? DK_DRIVER : WDA_DRIVER
  const r = await run(bin, uiSizeArgs(udid, driver), 12000)
  const sz = parseUiSize(r.stdout)
  if (sz) sizeCache = { udid, ...sz }
  return sz
}

/** Device screen size in points (for canvas mapping). Uses the active agent's driver. */
export async function size(bin: string, udid: string): Promise<{ width: number; height: number } | null> {
  if (!(await ensureAgent(bin, udid))) return null
  return cachedSize(bin, udid)
}

/** Fire-and-forget injection, serialized so gestures land in order. Routes to DeviceKit
 *  (WebSocket JSON-RPC) when it's the active agent, else WebDriverAgent (HTTP session). */
export function tap(_bin: string, _udid: string, x: number, y: number): void {
  enqueue(async () => {
    if (activeAgent === 'devicekit') {
      await devicekit.tap(x, y)
      return
    }
    await withSession((sid) => wda('POST', `/session/${sid}/actions`, pointerGesture(x, y, x, y, 0)))
  })
}

/** A drag as the user's FULL captured finger path (device points + ms timestamps). Replayed
 *  as ONE faithful gesture so the drag's real velocity carries iOS momentum-scroll — on
 *  DeviceKit via `device.io.gesture`, on WebDriverAgent via a multi-waypoint W3C `/actions`
 *  sequence (`pathToPointerActions`, every kept sample with its real inter-sample duration).
 *  iOS still synthesizes it as one atomic event — there is no streaming touch on a stock device
 *  (see the mirror input notes) — but a single velocity-accurate gesture feels far smoother than
 *  repeated lifting swipe segments. */
export function gesture(_bin: string, _udid: string, points: DkPathPoint[]): void {
  if (!points || points.length === 0) return
  enqueue(async () => {
    if (activeAgent === 'devicekit') {
      await devicekit.gesture(pathToGestureActions(points))
      return
    }
    const actions = pathToPointerActions(points)
    if (actions.length === 0) return
    await withSession((sid) =>
      wda('POST', `/session/${sid}/actions`, { actions: [{ type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions }] }, 15000)
    )
  })
}

// --- live drag streaming + momentum finish (the mirror's HYBRID drag) ---------
// While the finger moves we stream short swipe SEGMENTS so the content tracks the cursor
// live (coalesced — a fast drag never backs up a queue). On release the renderer can hand
// us a `flick` (a velocity-matched final swipe from the release point) so a flick keeps
// scrolling with native momentum. iOS can't stream touch — each segment is one atomic
// ~360ms XCTest gesture that LIFTS the finger (see the mirror input notes) — so live
// tracking is coarse (~2-3 steps/sec, choppy); the release flick is what makes it feel
// smooth. Everything runs on this one dragPump chain (one segment in flight at a time),
// so the tracking segments and the final flick are strictly ordered and never overlap.
let dragActive = false
let dragAnchor: { x: number; y: number } | null = null
let dragTarget: { x: number; y: number } | null = null
let dragInFlight = false
let dragFlick: { x: number; y: number; durMs: number } | null = null
// Each streamed segment is a full down→move→up touch, so it must move MORE than iOS's
// tap-vs-pan slop (~10 device points) — otherwise iOS treats the little segment as a TAP at
// its press point and, on the home screen or a list, OPENS whatever is under it (the reported
// "drag opens the app under the start point" bug). Measured on-device: a ~4pt segment did
// nothing / could tap, a 20pt segment reliably registered as a pan (paged the home screen).
// So gate every segment (incl. the first, which presses at the drag's start point) at 20pt.
// The trade-off is coarser live tracking; a slow sub-20pt drag simply injects nothing.
const DRAG_MIN_DELTA = 20 // device points — below this a segment would be a tap, not a drag

/** Inject one swipe segment from→to over `moveMs` (DeviceKit WebSocket or WDA HTTP). */
function dragSegment(from: { x: number; y: number }, to: { x: number; y: number }, moveMs: number): Promise<unknown> {
  if (activeAgent === 'devicekit') {
    return devicekit.gesture([
      { type: 'press', duration: 0, x: Math.round(from.x), y: Math.round(from.y), button: 0 },
      { type: 'move', duration: moveMs / 1000, x: Math.round(to.x), y: Math.round(to.y), button: 0 },
      { type: 'release', duration: 0, x: Math.round(to.x), y: Math.round(to.y), button: 0 }
    ])
  }
  return withSession((sid) => wda('POST', `/session/${sid}/actions`, pointerGesture(from.x, from.y, to.x, to.y, moveMs), 12000))
}

async function dragPump(): Promise<void> {
  if (dragInFlight || !dragAnchor || !dragTarget) return
  const from = dragAnchor
  const to = dragTarget
  const moved = Math.abs(to.x - from.x) + Math.abs(to.y - from.y)
  if (moved >= DRAG_MIN_DELTA) {
    // Tracking segment: 50ms swipe from the last position to the newest target.
    dragInFlight = true
    try {
      await dragSegment(from, to, 50)
    } finally {
      dragAnchor = to // next segment starts where this one ended → contiguous scroll
      dragInFlight = false
      void dragPump() // chase the latest target
    }
    return
  }
  // Tracking has caught up to the release point.
  if (dragActive) return // still dragging — wait for the next move
  if (dragFlick) {
    // Momentum finish: one fast swipe from the release point at the real release velocity,
    // so iOS applies native momentum-scroll. Playing it over `durMs` with the caller-projected
    // distance encodes that velocity. This is the last drag action for this gesture.
    const flick = dragFlick
    dragFlick = null
    dragInFlight = true
    try {
      await dragSegment(to, { x: flick.x, y: flick.y }, flick.durMs)
    } finally {
      dragAnchor = null
      dragTarget = null
      dragInFlight = false
    }
    return
  }
  dragAnchor = null
  dragTarget = null
}

/** Begin a streamed drag at the down point (no injection yet — just the anchor). */
export function dragStart(_bin: string, _udid: string, x: number, y: number): void {
  dragActive = true
  dragAnchor = { x, y }
  dragTarget = { x, y }
  dragFlick = null
}
/** Update the target as the finger moves; the pump sends a segment when it's free. */
export function dragMove(_bin: string, _udid: string, x: number, y: number): void {
  if (!dragActive) return
  dragTarget = { x, y }
  void dragPump()
}
/** Finish the drag at (x,y). If `flick` is given (a projected target + duration), a final
 *  velocity-matched momentum swipe follows once live tracking catches up to the release point. */
export function dragEnd(_bin: string, _udid: string, x: number, y: number, flick?: { x: number; y: number; durMs: number }): void {
  dragActive = false
  dragTarget = { x, y }
  dragFlick = flick && flick.durMs > 0 ? { x: flick.x, y: flick.y, durMs: flick.durMs } : null
  void dragPump()
}

export function swipe(_bin: string, _udid: string, x1: number, y1: number, x2: number, y2: number, durationSec?: number): void {
  const raw = durationSec && durationSec > 0 ? durationSec * 1000 : 120
  const moveMs = Math.max(20, Math.min(300, raw))
  enqueue(async () => {
    if (activeAgent === 'devicekit') {
      await devicekit.gesture([
        { type: 'press', duration: 0, x: Math.round(x1), y: Math.round(y1), button: 0 },
        { type: 'move', duration: moveMs / 1000, x: Math.round(x2), y: Math.round(y2), button: 0 },
        { type: 'release', duration: 0, x: Math.round(x2), y: Math.round(y2), button: 0 }
      ])
      return
    }
    await withSession((sid) => wda('POST', `/session/${sid}/actions`, pointerGesture(x1, y1, x2, y2, moveMs), 12000))
  })
}

export function type(_bin: string, _udid: string, text: string): void {
  enqueue(async () => {
    if (activeAgent === 'devicekit') {
      await devicekit.text(text)
      return
    }
    await withSession((sid) => wda('POST', `/session/${sid}/wda/keys`, { value: Array.from(text) }))
  })
}

// --- keyboard forwarding (batched) -------------------------------------------
// One XCTest call per keystroke is ~360ms → typing crawls. So COALESCE consecutive
// printable chars into ONE `device.io.text`: while a text call is in flight, further
// chars accumulate into the next op and go out as a single batch. A special key (Enter/
// Backspace/…) breaks the batch (its own op) to keep ordering exact.
type KeyOp = { kind: 'text'; text: string } | { kind: 'key'; domKey: string; modifiers: string[] }
const keyOps: KeyOp[] = []
let keyInFlight = false

async function runKeyOp(op: KeyOp): Promise<void> {
  if (activeAgent === 'devicekit') {
    // Pinned DeviceKit 0.0.18 has only `device.io.text` (no `device.io.keys`): type text
    // batches + Enter (as newline); other special keys go through `keys` (no-op on 0.0.18).
    if (op.kind === 'text') {
      await devicekit.text(op.text)
      return
    }
    const hasCmdCtrl = op.modifiers.includes('command') || op.modifiers.includes('control')
    if (op.domKey === 'Enter' && !hasCmdCtrl) {
      await devicekit.text('\n')
      return
    }
    const k = deviceKitKey(op.domKey)
    if (k) await devicekit.keys([{ key: k, modifiers: op.modifiers }])
    return
  }
  // WebDriverAgent: /wda/keys takes the whole W3C set (incl. Backspace/arrows).
  if (op.kind === 'text') {
    await withSession((sid) => wda('POST', `/session/${sid}/wda/keys`, { value: Array.from(op.text) }))
    return
  }
  const value = wdaKeyValue(op.domKey)
  if (value) await withSession((sid) => wda('POST', `/session/${sid}/wda/keys`, { value }))
}

async function keyPump(): Promise<void> {
  if (keyInFlight) return
  const op = keyOps.shift()
  if (!op) return
  keyInFlight = true
  try {
    await runKeyOp(op)
  } finally {
    keyInFlight = false
    void keyPump()
  }
}

/** Live keyboard forwarding: one physical keystroke → the device. `domKey` is the raw DOM
 *  `KeyboardEvent.key`; `modifiers` are command/control/option/shift/fn. Printable chars are
 *  batched (coalesced) so fast typing sends few `device.io.text` calls instead of one/char. */
export function key(_bin: string, _udid: string, domKey: string, modifiers: string[]): void {
  const hasCmdCtrl = modifiers.includes('command') || modifiers.includes('control')
  if (domKey.length === 1 && !hasCmdCtrl) {
    const last = keyOps[keyOps.length - 1]
    if (last && last.kind === 'text') last.text += domKey
    else keyOps.push({ kind: 'text', text: domKey })
  } else {
    keyOps.push({ kind: 'key', domKey, modifiers })
  }
  void keyPump()
}

export function button(bin: string, udid: string, name: string): void {
  enqueue(async () => {
    // Nav buttons must work WITHOUT the touch toggle, so make sure an agent is up first.
    if (!(await ensureUp(bin, udid))) return

    if (activeAgent === 'devicekit') {
      // App switcher: iOS has no hardware button — emulate the home-indicator gesture
      // (bottom edge → up → HOLD). Uses the device size (points) so it scales.
      if (name === 'appswitcher' || name === 'history' || name === 'recents') {
        const sz = await cachedSize(bin, udid)
        if (sz) {
          const cx = Math.round(sz.width / 2)
          const h = sz.height
          // Same proven path (bottom edge → up → hold), ~3× faster: a quick drag up
          // then a short dwell. The dwell (not the drag speed) is what opens the stack
          // vs. going home, so we keep a real hold but trim it hard.
          await devicekit.gesture([
            { type: 'press', duration: 0, x: cx, y: h - 1, button: 0 },
            { type: 'move', duration: 0.06, x: cx, y: Math.round(h * 0.55), button: 0 }, // fast drag up
            { type: 'move', duration: 0.22, x: cx, y: Math.round(h * 0.5), button: 0 }, // minimal hold (floor before it goes home)
            { type: 'release', duration: 0, x: cx, y: Math.round(h * 0.5), button: 0 }
          ])
        }
        return
      }
      // DeviceKit's XCUIDevice button names are camelCase (home / volumeUp / volumeDown / lock).
      await devicekit.button(DK_BUTTON_NAME[name] ?? name)
      return
    }

    // --- WebDriverAgent fallback ---
    // Home: SpringBoard (leaves the app → session goes stale, so drop it).
    if (name === 'home') {
      await wda('POST', '/wda/homescreen')
      wdaSession = null
      return
    }
    // App switcher: the Face-ID home-indicator gesture (slow drag up + HOLD).
    if (name === 'appswitcher' || name === 'history' || name === 'recents') {
      await withSession(async (sid) => {
        const wr = await wda('GET', `/session/${sid}/window/size`)
        const v = wr.json?.value as { width?: number; height?: number } | undefined
        const w = v?.width ?? 0
        const h = v?.height ?? 0
        if (!w || !h) return wr
        const cx = Math.round(w / 2)
        const gesture = {
          actions: [
            {
              type: 'pointer',
              id: 'finger1',
              parameters: { pointerType: 'touch' },
              actions: [
                { type: 'pointerMove', duration: 0, x: cx, y: h - 1 },
                { type: 'pointerDown', button: 0 },
                { type: 'pointerMove', duration: 60, x: cx, y: Math.round(h * 0.55) }, // fast drag up
                { type: 'pointerMove', duration: 220, x: cx, y: Math.round(h * 0.5) }, // minimal hold
                { type: 'pointerUp', button: 0 }
              ]
            }
          ]
        }
        return wda('POST', `/session/${sid}/actions`, gesture, 12000)
      })
      wdaSession = null
      return
    }
    // WDA's pressButton wants camelCase (volumeUp/volumeDown); the renderer sends the
    // DeviceKit-style lowercase canonical name, so map it here. (WDA only reliably does
    // home/volume via pressButton on newer builds; volume needs DeviceKit on go-ios's fork.)
    const wdaName = WDA_BUTTON_NAME[name] ?? name
    await withSession((sid) => wda('POST', `/session/${sid}/wda/pressButton`, { name: wdaName }))
  })
}

/** Canonical (lowercase) button name → WebDriverAgent's pressButton spelling. */
const WDA_BUTTON_NAME: Record<string, string> = {
  volumeup: 'volumeUp',
  volumedown: 'volumeDown',
  home: 'home',
  lock: 'lock'
}

/** Canonical (lowercase) button name → DeviceKit's XCUIDevice.Button spelling (camelCase). */
const DK_BUTTON_NAME: Record<string, string> = {
  volumeup: 'volumeUp',
  volumedown: 'volumeDown',
  home: 'home',
  lock: 'lock'
}
