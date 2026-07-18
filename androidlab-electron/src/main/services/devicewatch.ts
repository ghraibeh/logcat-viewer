/**
 * Hotplug device watcher — turns USB attach/detach into a push so the top-bar
 * device list updates on its own, no manual refresh. Two long-lived event streams
 * act purely as *change triggers*; on any signal the caller re-lists devices once
 * (adb + go-ios union) and diffs. Both streams are cross-platform:
 *
 *   • Android — `adb track-devices`: the adb server streams the device set on every
 *     change (length-prefixed frames). We don't parse the payload — any stdout data
 *     means "something changed". Also auto-starts the adb server if it's not up.
 *   • iOS — `ios listen`: usbmuxd attach/detach events as JSON lines
 *     ({"MessageType":"Attached"|"Detached", …}). Classic-tier (no tunnel/DDI).
 *
 * Each stream self-restarts if its child dies (adb server bounce, USB hiccup), and
 * both are killed on shutdown (CLAUDE.md Rule 3/4 — no orphaned children).
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface DeviceWatcherOpts {
  /** Resolve the adb binary (or null if unavailable) — evaluated per (re)start. */
  findAdb: () => string | null
  /** Resolve the go-ios binary (or null if unavailable). */
  findGoIos: () => string | null
  /** Debounced "the device set may have changed" signal. */
  onChange: () => void
}

// Coalesce bursts (adb emits several frames while enumerating) into one rebuild.
const DEBOUNCE_MS = 400
// Restart backoff: quick if the stream ran a while, slow if it died immediately
// (missing/failing command) so we don't spin.
const RESTART_OK_MS = 3000
const RESTART_FAST_FAIL_MS = 20000

export class DeviceWatcher {
  private adbProc: ChildProcess | null = null
  private iosProc: ChildProcess | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(private readonly opts: DeviceWatcherOpts) {}

  start(): void {
    this.stopped = false
    this.startAdb()
    this.startIos()
  }

  private fire(): void {
    if (this.stopped) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = null
      if (!this.stopped) this.opts.onChange()
    }, DEBOUNCE_MS)
  }

  private startAdb(): void {
    if (this.stopped || this.adbProc) return
    const adb = this.opts.findAdb()
    if (!adb) {
      // adb not present yet — retry later in case it appears / the path resolves.
      this.scheduleRestart('adb', RESTART_FAST_FAIL_MS)
      return
    }
    const startedAt = Date.now()
    try {
      const p = spawn(adb, ['track-devices'], { stdio: ['ignore', 'pipe', 'ignore'] })
      this.adbProc = p
      p.stdout?.on('data', () => this.fire())
      p.on('error', () => {})
      p.on('exit', () => {
        if (this.adbProc === p) this.adbProc = null
        this.scheduleRestart('adb', Date.now() - startedAt < 1500 ? RESTART_FAST_FAIL_MS : RESTART_OK_MS)
      })
    } catch {
      this.scheduleRestart('adb', RESTART_FAST_FAIL_MS)
    }
  }

  private startIos(): void {
    if (this.stopped || this.iosProc) return
    const bin = this.opts.findGoIos()
    if (!bin) {
      this.scheduleRestart('ios', RESTART_FAST_FAIL_MS)
      return
    }
    const startedAt = Date.now()
    try {
      const p = spawn(bin, ['listen'], { stdio: ['ignore', 'pipe', 'ignore'] })
      this.iosProc = p
      let buf = ''
      p.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        // Only real attach/detach events trigger a rebuild — ignore go-ios log noise.
        if (/"MessageType"\s*:\s*"(Attached|Detached)"/.test(buf)) {
          buf = ''
          this.fire()
        }
        if (buf.length > 65536) buf = buf.slice(-4096)
      })
      p.on('error', () => {})
      p.on('exit', () => {
        if (this.iosProc === p) this.iosProc = null
        this.scheduleRestart('ios', Date.now() - startedAt < 1500 ? RESTART_FAST_FAIL_MS : RESTART_OK_MS)
      })
    } catch {
      this.scheduleRestart('ios', RESTART_FAST_FAIL_MS)
    }
  }

  private scheduleRestart(which: 'adb' | 'ios', delayMs: number): void {
    if (this.stopped) return
    setTimeout(() => {
      if (this.stopped) return
      if (which === 'adb') this.startAdb()
      else this.startIos()
    }, delayMs)
  }

  stop(): void {
    this.stopped = true
    if (this.debounce) {
      clearTimeout(this.debounce)
      this.debounce = null
    }
    for (const p of [this.adbProc, this.iosProc]) {
      try {
        p?.kill()
      } catch {
        /* already gone */
      }
    }
    this.adbProc = null
    this.iosProc = null
  }
}
