/**
 * Android Auto head-unit service (Android). The Mac acts as a **wireless head unit**: it runs the
 * Android Auto GAL protocol as a TCP server (via an arm's-length `utilityProcess` helper — the
 * protocol code is GPLv3 and lives in vendor/aa-headunit/, never imported here), then fires
 * Google's hidden wireless-startup broadcast at the phone so stock Android Auto TCP-connects back
 * to us over Wi-Fi and projects its car UI. Verified end-to-end (H.264 1280×720) on a Galaxy A55.
 *
 * Flow: fork helper → helper binds an ephemeral port + reports it → we `am broadcast` the trigger
 * with this Mac's LAN IP + that port (over the bundled adb, to the selected serial) → the phone
 * connects to the helper's server → the helper streams H.264/PCM + status up, we relay to the
 * renderer; touches go back down to the helper's input channel.
 *
 * Prereqs (surfaced to the user by the view): phone + Mac on the same Wi-Fi subnet; Android Auto
 * developer mode enabled on the phone; no firewall blocking the inbound port.
 */
import { app, utilityProcess, type UtilityProcess } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'

export interface AaCallbacks {
  /** Raw Annex-B H.264 (incl. codec-config NALs) in order; renderer re-frames + decodes. */
  onH264: (chunk: Uint8Array) => void
  /** PCM audio (16-bit) for a given AA channel, with its sample rate + channel count. */
  onPcm: (channel: number, rate: number, channels: number, chunk: Uint8Array) => void
  /** The phone opened/closed the mic (Assistant/voice) — renderer starts/stops capture. */
  onMicOpen: (open: boolean) => void
  /** Human status line (handshake progress, channel opens, connection state). */
  onStatus: (message: string) => void
  /** Video is flowing — the car UI is live. */
  onStreaming: () => void
  /** Session ended (phone disconnected / byebye). */
  onEnded: (reason: string) => void
  /** Could not start (helper missing, trigger failed, bad Wi-Fi). */
  onFailed: (message: string) => void
}

type HelperMsg =
  | { type: 'listening'; port: number }
  | { type: 'status'; message: string }
  | { type: 'phoneInfo'; name: string; brand: string }
  | { type: 'channel'; channel: number }
  | { type: 'streaming' }
  | { type: 'h264'; data: Uint8Array }
  | { type: 'pcm'; channel: number; rate: number; channels: number; data: Uint8Array }
  | { type: 'micOpen'; open: boolean }
  | { type: 'ended'; reason: string }
  | { type: 'error'; message: string }

const GEARHEAD = 'com.google.android.projection.gearhead'
const WIRELESS_RECEIVER = `${GEARHEAD}/com.google.android.apps.auto.wireless.setup.receiver.WirelessStartupReceiver`
const WIRELESS_START_ACTION = 'com.google.android.apps.auto.wireless.setup.receiver.wirelessstartup.START'

export class AaHeadUnitService {
  private proc: UtilityProcess | null = null

  constructor(
    private readonly adbPath: string,
    private readonly cb: AaCallbacks
  ) {}

  /** Start projecting from `serial`. Forks the helper, then triggers Android Auto to connect. */
  start(serial: string, res = '1280x720', density = 240): { ok: boolean; message: string } {
    this.stop()

    const helper = resolveHelper()
    if (!helper) {
      const m = 'The Android Auto head-unit helper is missing from this build (vendor/aa-headunit).'
      this.cb.onFailed(m)
      return { ok: false, message: m }
    }
    const creds = resolveCreds()
    if (!creds) {
      const m = 'The Android Auto head-unit certificate is missing from this build.'
      this.cb.onFailed(m)
      return { ok: false, message: m }
    }
    const ip = lanIpv4()
    if (!ip) {
      const m = 'No Wi-Fi/LAN IPv4 address found on this Mac — join the same Wi-Fi as the phone.'
      this.cb.onFailed(m)
      return { ok: false, message: m }
    }

    this.cb.onStatus('Starting head-unit server…')
    const proc = utilityProcess.fork(helper, [], { stdio: 'pipe' })
    this.proc = proc

    proc.stderr?.on('data', (b: Buffer) => {
      for (const line of b.toString('utf8').split('\n')) {
        const t = line.trim()
        if (t) console.error(`[aa-headunit] ${t}`)
      }
    })
    proc.stdout?.on('data', (b: Buffer) => {
      for (const line of b.toString('utf8').split('\n')) {
        const t = line.trim()
        if (t) console.log(`[aa-headunit] ${t}`)
      }
    })

    proc.on('message', (msg: HelperMsg) => {
      switch (msg.type) {
        case 'listening':
          this.cb.onStatus(`Listening on ${ip}:${msg.port} — triggering Android Auto…`)
          this.fireTrigger(serial, ip, msg.port)
          break
        case 'status':
          this.cb.onStatus(msg.message)
          break
        case 'phoneInfo':
          this.cb.onStatus(`Phone: ${msg.name} (${msg.brand})`)
          break
        case 'channel':
          break
        case 'streaming':
          this.cb.onStreaming()
          break
        case 'h264':
          this.cb.onH264(msg.data)
          break
        case 'pcm':
          this.cb.onPcm(msg.channel, msg.rate, msg.channels, msg.data)
          break
        case 'micOpen':
          this.cb.onMicOpen(msg.open)
          break
        case 'ended':
          this.cb.onEnded(msg.reason)
          break
        case 'error':
          this.cb.onFailed(msg.message)
          break
      }
    })
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null
    })

    proc.postMessage({
      type: 'start',
      port: 0,
      res,
      density,
      certPem: creds.cert,
      keyPem: creds.key
    })
    return { ok: true, message: `Head unit starting on ${ip}` }
  }

  /** Forward a touch event to the phone (device coordinates; action per AA PointerAction). */
  touch(action: number, x: number, y: number): void {
    this.proc?.postMessage({ type: 'touch', action, x, y })
  }

  /** Feed captured mic PCM (16-bit mono 16 kHz) to the phone (Assistant/voice). */
  micData(bytes: Uint8Array): void {
    this.proc?.postMessage({ type: 'micData', data: bytes })
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.postMessage({ type: 'stop' })
        this.proc.kill()
      } catch {
        /* already gone */
      }
      this.proc = null
    }
  }

  shutdown(): void {
    this.stop()
  }

  /** Fire Google's hidden wireless-startup broadcast so AA connects to ip:port over Wi-Fi. */
  private fireTrigger(serial: string, ip: string, port: number): void {
    const args = [
      '-s',
      serial,
      'shell',
      'am',
      'broadcast',
      '-n',
      WIRELESS_RECEIVER,
      '-a',
      WIRELESS_START_ACTION,
      '--es',
      'ip_address',
      ip,
      '--ei',
      'projection_port',
      String(port)
    ]
    execFile(this.adbPath, args, { timeout: 10000 }, (err, _stdout, stderr) => {
      if (err) {
        this.cb.onFailed(
          `Could not trigger Android Auto: ${stderr.trim() || err.message}. ` +
            'Make sure Android Auto is set up and developer mode is on.'
        )
      } else {
        this.cb.onStatus('Triggered — waiting for the phone to connect…')
      }
    })
  }
}

/** Locate the bundled helper: packaged → resources/aa-headunit/, dev → vendor/aa-headunit/dist. */
function resolveHelper(): string | null {
  const cands = app.isPackaged
    ? [join(process.resourcesPath, 'aa-headunit', 'electron-helper.js')]
    : [
        join(app.getAppPath(), 'vendor', 'aa-headunit', 'dist', 'src', 'electron-helper.js'),
        join(process.cwd(), 'vendor', 'aa-headunit', 'dist', 'src', 'electron-helper.js')
      ]
  for (const c of cands) if (existsSync(c)) return c
  return null
}

/** Read the head-unit TLS credential (PEM strings) from the same layout as the helper. */
function resolveCreds(): { cert: string; key: string } | null {
  const dirs = app.isPackaged
    ? [join(process.resourcesPath, 'aa-headunit', 'assets')]
    : [
        join(app.getAppPath(), 'vendor', 'aa-headunit', 'assets'),
        join(process.cwd(), 'vendor', 'aa-headunit', 'assets')
      ]
  for (const d of dirs) {
    const cert = join(d, 'headunit_cert.pem')
    const key = join(d, 'headunit_key.pem')
    if (existsSync(cert) && existsSync(key)) {
      return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') }
    }
  }
  return null
}

/** This Mac's primary private LAN IPv4 (the address the phone will connect back to). */
function lanIpv4(): string | null {
  const ifaces = networkInterfaces()
  // Prefer en0-style Wi-Fi first, then any private IPv4.
  const priv = (a: string): boolean =>
    a.startsWith('192.168.') || a.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
  const order = Object.keys(ifaces).sort((a, b) => (a === 'en0' ? -1 : b === 'en0' ? 1 : 0))
  for (const name of order) {
    for (const info of ifaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal && priv(info.address)) return info.address
    }
  }
  return null
}
