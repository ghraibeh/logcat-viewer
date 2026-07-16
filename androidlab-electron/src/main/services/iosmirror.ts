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

export class IosMirrorService {
  private udid = ''
  private runToken = 0
  private proc: ChildProcess | null = null
  private gotData = false

  constructor(
    private readonly goiosBin: string,
    private readonly cb: IosMirrorCallbacks
  ) {}

  // --- live feed ----------------------------------------------------------
  start(udid: string): void {
    this.stopFeed()
    this.udid = udid
    const token = ++this.runToken
    void this.startFeed(token)
  }

  /** Stop the live feed + kill the capture helper (idempotent). */
  stopFeed(): void {
    this.runToken++
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
    this.gotData = false
    let err = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      if (token !== this.runToken) return
      if (!this.gotData) {
        this.gotData = true
        this.cb.onState({ mode: 'h264', message: 'Live stream' })
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
      if (this.proc === proc) this.proc = null
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
    this.stopFeed()
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
