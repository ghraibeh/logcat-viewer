/**
 * iOS screen-mirror service (macOS) — the go-ios counterpart to services/mirror.ts.
 *
 * There is no adb `screenrecord`/scrcpy on iOS. The real, smooth, low-latency path
 * is the one QuickTime itself uses: the CoreMediaIO "iOS Device" screen-capture
 * device (see the ios-mirror-goios-findings memory). A bundled native Swift helper
 * (`resources/iosscreen`) enables that CMIO device, captures full-res frames at the
 * device's native rate via AVFoundation, hardware-encodes them to H.264 with
 * VideoToolbox, and writes a raw Annex-B elementary stream to stdout — byte-for-byte
 * what the renderer's existing WebCodecs decoder (the Android scrcpy pipeline) eats.
 *
 * The helper also plays the device's AUDIO on the Mac's default output (same CMIO
 * mechanism; never on stdout, so the byte stream stays pure H.264). Mute is a
 * SIGUSR2 toggle: the helper always starts unmuted, so this service tracks the
 * user's preference and re-syncs it whenever a (re)spawned helper starts streaming.
 *
 * Unprivileged (only a camera/screen TCC prompt — the Electron app grants it), and
 * it does NOT switch the device's USB config, so go-ios/usbmux (the other iOS tabs)
 * keep working while mirroring. macOS-only; other platforms report unsupported.
 * View-only — input injection would need WebDriverAgent.
 */
import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { infoArgs } from '@core/goios'
import type { IosMirrorState } from '@shared/types'

export interface IosMirrorCallbacks {
  /** Raw Annex-B H.264 bytes from the capture helper; renderer re-frames + decodes. */
  onH264: (chunk: Uint8Array) => void
  /** Feed state changed (which tier is live + a human message). */
  onState: (state: IosMirrorState) => void
  /** The feed could not start / produce frames (device asleep, unsupported, gone). */
  onFailed: (message: string) => void
}

// A dock<->popout move unmounts the old mirror view (which calls stopFeed) and then
// mounts the new one in the other window (which calls start) a beat later. Deferring
// the actual teardown by this long lets that follow-up start cancel it, so the capture
// keeps running across the hand-off instead of being killed and re-acquired.
const HANDOFF_GRACE_MS = 3000

export class IosMirrorService {
  private udid = ''
  private runToken = 0
  private proc: ChildProcess | null = null
  // Our own liveness flag. Do NOT use proc.killed for this: Node sets proc.killed=true
  // the moment ANY signal is sent via .kill(), including the SIGUSR1 we send to force a
  // keyframe on re-attach — which would wrongly make the next hand-off think the helper
  // is dead and respawn it. This flips false only on a real terminate / process exit.
  private alive = false
  private gotData = false
  private teardownTimer: ReturnType<typeof setTimeout> | null = null
  // The user's mute preference vs what the running helper is actually doing (a fresh
  // helper always starts unmuted). SIGUSR2 only toggles, so sync compares the two.
  private mutedWanted = false
  private helperMuted = false

  constructor(
    private readonly goiosBin: string,
    private readonly cb: IosMirrorCallbacks
  ) {}

  // --- live feed ----------------------------------------------------------
  start(udid: string): void {
    // Seamless dock<->popout hand-off: if the helper is already streaming this exact
    // device, keep it running and just let the freshly-mounted view re-attach to the
    // ongoing broadcast — no kill, no CoreMediaIO re-acquire. Force a keyframe (SIGUSR1)
    // so the new decoder configures + paints at once rather than waiting for the next IDR.
    const reattach = udid === this.udid && this.proc != null && this.alive
    this.cancelTeardown()
    if (reattach) {
      try {
        this.proc?.kill('SIGUSR1')
      } catch {
        /* helper gone between the check and the signal — fall through to a restart below */
      }
      return
    }
    this.hardStop()
    this.udid = udid
    const token = ++this.runToken
    void this.startFeed(token)
  }

  /** Stop the live feed. By default on a grace timer so a dock<->popout hand-off can
   *  cancel it (see HANDOFF_GRACE_MS). `immediate` (a genuine close) tears down now. */
  stopFeed(immediate = false): void {
    if (immediate) {
      this.cancelTeardown()
      this.hardStop()
      return
    }
    if (this.teardownTimer) clearTimeout(this.teardownTimer)
    this.teardownTimer = setTimeout(() => {
      this.teardownTimer = null
      this.hardStop()
    }, HANDOFF_GRACE_MS)
  }

  private cancelTeardown(): void {
    if (this.teardownTimer) {
      clearTimeout(this.teardownTimer)
      this.teardownTimer = null
    }
  }

  // --- device-audio mute ----------------------------------------------------
  /** Set the mute preference. Applied to the live helper at once; a helper spawned
   *  later picks it up when it starts streaming. Returns the effective preference. */
  setMuted(muted: boolean): boolean {
    this.mutedWanted = muted
    this.syncMute()
    return this.mutedWanted
  }

  getMuted(): boolean {
    return this.mutedWanted
  }

  /** Bring the helper's actual mute state in line with the preference. Gated on
   *  gotData: by the time frames flow the helper's signal handlers are long
   *  installed (an unhandled SIGUSR2 would kill a just-spawned process). */
  private syncMute(): void {
    if (!this.proc || !this.alive || !this.gotData) return
    if (this.helperMuted === this.mutedWanted) return
    try {
      this.proc.kill('SIGUSR2')
      this.helperMuted = this.mutedWanted
    } catch {
      /* helper vanished — the next spawn re-syncs */
    }
  }

  /** Immediate teardown — kills the capture helper (grace timer firing, new device, quit). */
  private hardStop(): void {
    this.runToken++
    this.alive = false
    if (this.proc) {
      try {
        this.proc.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      this.proc = null
    }
    this.gotData = false
  }

  private async startFeed(token: number): Promise<void> {
    if (process.platform !== 'darwin') {
      this.cb.onFailed('The iOS screen mirror is available on macOS only.')
      return
    }
    const helper = resolveHelper()
    if (!helper) {
      this.cb.onFailed('The iOS capture helper (resources/iosscreen) is missing from this build.')
      return
    }
    this.cb.onState({ mode: 'h264', message: 'Connecting…' })

    // Match the CoreMediaIO screen device by the device's name (falls back to the
    // first iOS screen device when the name lookup fails).
    const name = await this.deviceName(this.udid)
    if (token !== this.runToken) return

    const proc = spawn(helper, name ? [name] : [], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc
    this.alive = true
    this.gotData = false
    this.helperMuted = false // a fresh helper always starts unmuted
    let err = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      if (token !== this.runToken) return
      if (!this.gotData) {
        this.gotData = true
        this.cb.onState({ mode: 'h264', message: 'Live stream' })
        this.syncMute()
      }
      this.cb.onH264(new Uint8Array(chunk))
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      err += text
      // Surface the helper's diagnostics (camera-auth, device list, polling) in the
      // main-process log so device-not-found issues are debuggable.
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (t) console.error(`[iosscreen] ${t}`)
      }
    })
    proc.on('error', (e) => {
      if (token === this.runToken) this.cb.onFailed(`Could not start the capture helper: ${e.message}`)
    })
    proc.on('close', () => {
      if (this.proc === proc) {
        this.proc = null
        this.alive = false
      }
      if (token !== this.runToken || this.gotData) return
      // Exited before producing any video — surface a helpful reason.
      this.cb.onFailed(helperFailure(err))
    })
  }

  /** The device's name via `ios info` (used to pick the right CMIO screen device). */
  private async deviceName(udid: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(this.goiosBin, infoArgs(udid), { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (e, stdout) => {
        if (e) return resolve(null)
        const m = /"DeviceName"\s*:\s*"([^"]+)"/.exec(stdout ?? '')
        resolve(m ? m[1] : null)
      })
    })
  }

  shutdown(): void {
    this.cancelTeardown()
    this.hardStop()
  }
}

/** Locate the bundled `iosscreen` helper: packaged → resources/, dev → project resources/. */
function resolveHelper(): string | null {
  const cands = app.isPackaged
    ? [join(process.resourcesPath, 'iosscreen')]
    : [join(app.getAppPath(), 'resources', 'iosscreen'), join(process.cwd(), 'resources', 'iosscreen')]
  for (const c of cands) if (existsSync(c)) return c
  return null
}

/** Turn the helper's stderr into a user-facing reason. */
function helperFailure(stderr: string): string {
  if (/no iOS screen-capture device found/i.test(stderr)) {
    return 'No iPhone screen available to capture. Make sure the device is connected, unlocked, and trusted — if it was just used for other tools, reconnect it (or reboot it) so macOS re-exposes its screen.'
  }
  if (/permission|not authorized|denied/i.test(stderr)) {
    return 'Screen capture was blocked — grant AndroidLab camera/screen-recording access in System Settings ▸ Privacy.'
  }
  const last = stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop()
  return last ? `Screen capture failed: ${last}` : 'Screen capture failed to start.'
}
