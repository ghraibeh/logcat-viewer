/**
 * iOS AirPlay screen-mirror receiver service (macOS) — the Wi-Fi counterpart to
 * services/iosmirror.ts (the USB CoreMediaIO path).
 *
 * Here the phone initiates: a bundled native receiver (`resources/airplayscreen`,
 * built from native/macos/airplay/* — the vendored RPiPlay core, GPL-3.0) advertises
 * "AndroidLab" over Bonjour and runs the AirPlay/FairPlay handshake. When the user
 * picks it in Control Center ▸ Screen Mirroring, the receiver decrypts the mirror
 * stream and writes **Annex-B H.264** to stdout — byte-for-byte what iosscreen emits,
 * so the renderer's existing WebCodecs decoder handles both paths identically. This
 * service just spawns the receiver and forwards its bytes/state on the SAME channels
 * the USB mirror uses (the renderer stays feed-agnostic).
 *
 * The receiver also decodes the AirPlay AAC-ELD audio and plays it on this Mac; mute
 * is a SIGUSR2 toggle (same contract as the USB helper), tracked here so a respawn
 * re-syncs the preference.
 *
 * macOS-only. View-only — AirPlay mirroring carries no input channel back to the
 * device (touch forwarding stays on the USB path).
 */
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { IosMirrorState } from '@shared/types'

export interface IosAirplayCallbacks {
  /** Raw Annex-B H.264 bytes from the receiver; renderer re-frames + decodes. */
  onH264: (chunk: Uint8Array) => void
  /** Feed state (waiting for the phone to connect vs live). */
  onState: (state: IosMirrorState) => void
  /** The receiver could not start (helper missing, port in use, unsupported OS). */
  onFailed: (message: string) => void
}

/** The Bonjour name the receiver advertises — what the user taps on the phone. */
export const AIRPLAY_NAME = 'AndroidLab'

/** Advertised AirPlay display resolution (the phone mirrors at up to this). */
export interface AirplayResolution {
  width: number
  height: number
}
const DEFAULT_RES: AirplayResolution = { width: 1920, height: 1080 }

// A dock<->popout move unmounts the old dock (stop, grace) then mounts the new one
// (start) a beat later. Deferring teardown lets the follow-up start cancel it, so the
// AirPlay receiver keeps running across the hand-off — the phone stays connected
// instead of being dropped and forced to re-pick "AndroidLab". Mirrors iosmirror.ts.
const HANDOFF_GRACE_MS = 3000

export class IosAirplayService {
  private proc: ChildProcess | null = null
  private runToken = 0
  private alive = false
  private gotData = false
  private teardownTimer: ReturnType<typeof setTimeout> | null = null
  private resKey = `${DEFAULT_RES.width}x${DEFAULT_RES.height}`
  // Host-audio mute preference vs the receiver's actual state (a fresh receiver
  // starts unmuted). SIGUSR2 only toggles, so sync compares the two.
  private mutedWanted = false
  private helperMuted = false

  constructor(private readonly cb: IosAirplayCallbacks) {}

  /** Start (or reattach to) the receiver at `resolution`. A dock<->popout hand-off
   *  re-invokes this with the SAME resolution while the receiver is still up → no-op
   *  (keeps streaming). A genuine resolution change respawns with the new dims. */
  start(resolution: AirplayResolution = DEFAULT_RES): void {
    this.cancelTeardown()
    const key = `${resolution.width}x${resolution.height}`
    if (this.proc && this.alive && this.resKey === key) return // reattach — keep streaming
    this.hardStop()
    this.resKey = key
    const token = ++this.runToken
    void this.startReceiver(token)
  }

  /** Stop the receiver. Defaults to a grace timer so a dock<->popout hand-off can
   *  cancel it; `immediate` (a genuine close / mode switch) tears down now. */
  stop(immediate = false): void {
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

  // --- host-audio mute ------------------------------------------------------
  /** Set the mute preference; applied to the receiver at once (a later-spawned
   *  receiver picks it up once it starts streaming). Returns the effective value. */
  setMuted(muted: boolean): boolean {
    this.mutedWanted = muted
    this.syncMute()
    return this.mutedWanted
  }

  getMuted(): boolean {
    return this.mutedWanted
  }

  /** Bring the receiver's actual mute state in line with the preference via SIGUSR2.
   *  Gated on gotData so the signal never races a just-spawned process's handler. */
  private syncMute(): void {
    if (!this.proc || !this.alive || !this.gotData) return
    if (this.helperMuted === this.mutedWanted) return
    try {
      this.proc.kill('SIGUSR2')
      this.helperMuted = this.mutedWanted
    } catch {
      /* receiver vanished — the next spawn re-syncs */
    }
  }

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

  private async startReceiver(token: number): Promise<void> {
    if (process.platform !== 'darwin') {
      this.cb.onFailed('AirPlay mirroring is available on macOS only.')
      return
    }
    const helper = resolveHelper()
    if (!helper) {
      this.cb.onFailed('The AirPlay receiver (resources/airplayscreen) is missing from this build.')
      return
    }
    this.cb.onState({
      mode: 'airplay',
      waiting: true,
      message: `On your iPhone, open Control Center ▸ Screen Mirroring and pick “${AIRPLAY_NAME}”.`
    })

    const proc = spawn(helper, [AIRPLAY_NAME, this.resKey], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.proc = proc
    this.alive = true
    this.gotData = false
    this.helperMuted = false // a fresh receiver always starts unmuted
    let err = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      if (token !== this.runToken) return
      if (!this.gotData) {
        this.gotData = true
        this.cb.onState({ mode: 'airplay', waiting: false, message: 'Live stream (AirPlay)' })
        this.syncMute()
      }
      this.cb.onH264(new Uint8Array(chunk))
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      err += text
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (t) console.error(`[airplayscreen] ${t}`)
      }
      // The receiver logs a disconnect when the phone stops mirroring — fall back to
      // the waiting state so the dock re-shows the "pick AndroidLab" hint.
      if (token === this.runToken && /client disconnected/i.test(text)) {
        this.gotData = false
        this.cb.onState({
          mode: 'airplay',
          waiting: true,
          message: `Disconnected. On your iPhone, pick “${AIRPLAY_NAME}” again in Screen Mirroring.`
        })
      }
    })
    proc.on('error', (e) => {
      if (token === this.runToken) this.cb.onFailed(`Could not start the AirPlay receiver: ${e.message}`)
    })
    proc.on('close', () => {
      if (this.proc === proc) {
        this.proc = null
        this.alive = false
      }
      if (token !== this.runToken) return
      // Exited without ever streaming — surface a helpful reason.
      if (!this.gotData) this.cb.onFailed(receiverFailure(err))
    })
  }

  shutdown(): void {
    this.cancelTeardown()
    this.hardStop()
  }
}

/** Locate the bundled `airplayscreen` receiver: packaged → resources/, dev → project. */
function resolveHelper(): string | null {
  const cands = app.isPackaged
    ? [join(process.resourcesPath, 'airplayscreen')]
    : [join(app.getAppPath(), 'resources', 'airplayscreen'), join(process.cwd(), 'resources', 'airplayscreen')]
  for (const c of cands) if (existsSync(c)) return c
  return null
}

/** Turn the receiver's stderr into a user-facing reason. */
function receiverFailure(stderr: string): string {
  if (/dnssd_init failed/i.test(stderr)) {
    return 'AirPlay could not advertise on the network — another receiver may be using the name, or Bonjour is blocked. Check that Wi-Fi is on and try again.'
  }
  if (/raop_start failed|raop_init failed/i.test(stderr)) {
    return 'The AirPlay receiver could not open its network port. Make sure no other AirPlay app is running and retry.'
  }
  const last = stderr.split('\n').map((l) => l.trim()).filter(Boolean).pop()
  return last ? `AirPlay receiver failed: ${last}` : 'The AirPlay receiver failed to start.'
}
