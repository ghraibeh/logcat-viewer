/**
 * Screen-mirror service — port of the QThread workers in logcat_viewer/mirror.py
 * (H264MirrorWorker, MirrorWorker, ScreenshotWorker, RecordWorker,
 * DisplayListWorker) and the one-shot `input` sends.
 *
 * The low-latency path streams `screenrecord --output-format=h264` bytes straight
 * to the renderer, which decodes them with WebCodecs (PyAV's job in Python). The
 * fallback path polls `screencap -p` and streams PNG frames. Only one feed runs
 * at a time; MP4 recording needs the device's sole display encoder, so the live
 * feed drops to the poller while recording.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, basename, delimiter } from 'node:path'
import { run, runBinary } from './adb'
import {
  CAPTURE_THREADS,
  H264_BITRATE,
  buildDisplayList,
  dumpsysDisplayArgs,
  emulatorProbeArgs,
  isEmulatorProps,
  inputArgs,
  pkillScreenrecordArgs,
  pullArgs,
  rmArgs,
  safeSerial,
  screencapArgs,
  screenrecordFileArgs,
  screenrecordH264Args,
  surfaceFlingerDisplaysArgs,
  type DisplayInfo
} from '@core/mirror'
import type { SaveResult } from '@shared/types'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

function isPng(buf: Buffer): boolean {
  return buf.length >= 4 && PNG_MAGIC.every((b, i) => buf[i] === b)
}

function captureDir(): string {
  const dl = join(homedir(), 'Downloads')
  return existsSync(dl) ? dl : homedir()
}

function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export interface MirrorCallbacks {
  /** PNG frame (base64) — poller output and the H.264 prime frame. */
  onFrame: (base64: string) => void
  /** Raw H.264 Annex-B bytes from screenrecord. */
  onH264: (chunk: Uint8Array) => void
  /** A feed failed; kind lets the renderer fall back (h264 → poller). */
  onFailed: (kind: 'h264' | 'poller', message: string) => void
}

export class MirrorService {
  private serial = ''
  private runToken = 0 // bumped on every stop/start to invalidate old loops
  private h264Proc: ChildProcess | null = null

  private recProc: ChildProcess | null = null
  private recStopping = false
  private recTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly adb: string,
    private readonly cb: MirrorCallbacks
  ) {}

  // --- live feed ----------------------------------------------------------
  startH264(serial: string): void {
    this.stopFeed()
    this.serial = serial
    const token = ++this.runToken
    void this.h264Loop(token)
  }

  startPoller(serial: string, displayId: string | null): void {
    this.stopFeed()
    this.serial = serial
    const token = ++this.runToken
    for (let i = 0; i < CAPTURE_THREADS; i++) {
      void this.pollLoop(token, displayId, i * 55)
    }
  }

  /** Stop only the live feed (leaves any recording running, like mirror.py). */
  stopFeed(): void {
    this.runToken++
    if (this.h264Proc) {
      try {
        this.h264Proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      this.h264Proc = null
    }
    void run(this.adb, this.serial, pkillScreenrecordArgs(this.serial).slice(2), 6000)
  }

  private async h264Loop(token: number): Promise<void> {
    // Clear any straggler holding the sole display encoder, let it free, then
    // paint the current screen at once (H.264 emits nothing until a redraw).
    await run(this.adb, this.serial, pkillScreenrecordArgs(this.serial).slice(2), 6000)
    await delay(120)
    if (token !== this.runToken) return
    await this.prime(token)

    let total = 0
    while (token === this.runToken) {
      const proc = spawn(this.adb, screenrecordH264Args(this.serial, H264_BITRATE))
      this.h264Proc = proc
      let session = 0
      let stderr = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        if (token !== this.runToken) return
        session += chunk.length
        total += chunk.length
        this.cb.onH264(new Uint8Array(chunk))
      })
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      const code = await new Promise<number>((resolve) => {
        proc.on('close', (c) => resolve(c ?? 0))
        proc.on('error', () => resolve(-1))
      })
      if (this.h264Proc === proc) this.h264Proc = null
      if (token !== this.runToken) break
      if (session === 0) {
        if (total === 0) {
          // Never produced video — report so the renderer drops to the poller.
          this.cb.onFailed('h264', stderr.trim() || (code < 0 ? 'could not start screenrecord' : 'no video stream'))
          return
        }
        await delay(150) // brief gap before reconnecting
      }
    }
    // Never leave a device-side encoder session behind.
    await run(this.adb, this.serial, pkillScreenrecordArgs(this.serial).slice(2), 6000)
  }

  private async prime(token: number): Promise<void> {
    const shot = await runBinary(this.adb, screencapArgs(this.serial), 6000)
    if (token !== this.runToken) return
    if (isPng(shot.stdout)) this.cb.onFrame(shot.stdout.toString('base64'))
  }

  private async pollLoop(token: number, displayId: string | null, startDelayMs: number): Promise<void> {
    if (startDelayMs) await delay(startDelayMs)
    let misses = 0
    while (token === this.runToken) {
      const shot = await runBinary(this.adb, screencapArgs(this.serial, displayId), 10000)
      if (token !== this.runToken) return
      if (isPng(shot.stdout)) {
        misses = 0
        this.cb.onFrame(shot.stdout.toString('base64'))
      } else {
        misses++
        if (misses > 5) {
          this.cb.onFailed('poller', 'no screen data (device offline?)')
          return
        }
        await delay(120)
      }
    }
  }

  // --- one-shot input -----------------------------------------------------
  input(serial: string, logicalId: number | null, args: string[]): void {
    // Fire-and-forget; taps must feel instant.
    execFile(this.adb, inputArgs(serial, logicalId, args), { timeout: 8000 }, () => {})
  }

  /** Whether the device is an emulator (its screenrecord encoder is slow). */
  async isEmulator(serial: string): Promise<boolean> {
    const r = await run(this.adb, null, emulatorProbeArgs(serial), 6000)
    return isEmulatorProps(r.stdout)
  }

  // --- displays -----------------------------------------------------------
  async listDisplays(serial: string): Promise<DisplayInfo[]> {
    const sf = await run(this.adb, null, surfaceFlingerDisplaysArgs(serial), 10000)
    const dp = await run(this.adb, null, dumpsysDisplayArgs(serial), 10000)
    return buildDisplayList(sf.stdout, dp.stdout)
  }

  // --- screenshot ---------------------------------------------------------
  async screenshot(serial: string, displayId: string | null, logicalId: number | null): Promise<SaveResult> {
    const shot = await runBinary(this.adb, screencapArgs(serial, displayId), 20000)
    if (!isPng(shot.stdout)) {
      return { ok: false, message: `Screenshot failed: ${shot.stderr.trim() || 'no image data'}`, dir: '' }
    }
    const tag = displayId == null ? '' : `-display${logicalId}`
    const dest = join(captureDir(), `screenshot-${safeSerial(serial)}${tag}-${stamp()}.png`)
    try {
      writeFileSync(dest, shot.stdout)
    } catch (e) {
      return { ok: false, message: `Cannot write ${dest}: ${e instanceof Error ? e.message : String(e)}`, dir: '' }
    }
    return { ok: true, message: `Saved ${basename(dest)}`, dir: dirname(dest) }
  }

  // --- MP4 recording (main display only) ----------------------------------
  startRecord(serial: string): boolean {
    if (this.recProc) return false
    this.serial = serial
    this.recStopping = false
    const remote = `/sdcard/androidlab-${stamp()}.mp4`
    const dest = join(captureDir(), `screenrecord-${safeSerial(serial)}-${stamp()}.mp4`)
    const proc = spawn(this.adb, screenrecordFileArgs(serial, remote))
    this.recProc = proc
    let out = ''
    proc.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    proc.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')))
    // Re-issue SIGINT each tick while stopping so we win the start-vs-stop race.
    this.recTimer = setInterval(() => {
      if (this.recStopping) void run(this.adb, serial, pkillScreenrecordArgs(serial, 'INT').slice(2), 6000)
    }, 300)
    proc.on('close', () => void this.finishRecord(serial, remote, dest, out))
    proc.on('error', () => void this.finishRecord(serial, remote, dest, out))
    return true
  }

  stopRecord(): boolean {
    if (!this.recProc) return false
    this.recStopping = true
    return true
  }

  private recordDone: ((r: SaveResult) => void) | null = null

  /** Register the one-shot completion callback for the in-flight recording. */
  onRecordDone(cb: (r: SaveResult) => void): void {
    this.recordDone = cb
  }

  private async finishRecord(serial: string, remote: string, dest: string, recMsg: string): Promise<void> {
    if (this.recTimer) {
      clearInterval(this.recTimer)
      this.recTimer = null
    }
    this.recProc = null
    this.recStopping = false
    const pull = await run(this.adb, null, pullArgs(serial, remote, dest), 180000)
    await run(this.adb, null, rmArgs(serial, remote), 10000)
    let result: SaveResult
    if (pull.code === 0 && existsSync(dest) && safeSize(dest) > 0) {
      result = { ok: true, message: `Saved ${basename(dest)}`, dir: dirname(dest) }
    } else {
      const reason = (pull.stderr || pull.stdout || recMsg || 'screenrecord produced no file').trim()
      const last = reason.split('\n').filter(Boolean).pop() || 'unknown'
      result = { ok: false, message: `Recording failed: ${last}`, dir: '' }
    }
    this.recordDone?.(result)
  }

  // --- scrcpy -------------------------------------------------------------
  scrcpyPath(): string | null {
    return whichIn('scrcpy')
  }

  launchScrcpy(serial: string, logicalId: number | null): void {
    const scrcpy = this.scrcpyPath()
    if (!scrcpy) return
    const args = ['-s', serial, ...(logicalId != null ? ['--display-id', String(logicalId)] : [])]
    const child = spawn(scrcpy, args, { detached: true, stdio: 'ignore' })
    child.unref()
  }

  shutdown(): void {
    this.stopFeed()
    if (this.recProc) {
      this.recStopping = true
      void run(this.adb, this.serial, pkillScreenrecordArgs(this.serial, 'INT').slice(2), 6000)
    }
    if (this.recTimer) {
      clearInterval(this.recTimer)
      this.recTimer = null
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function safeSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function whichIn(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const cand = join(dir, bin)
    if (existsSync(cand)) return cand
  }
  for (const cand of ['/opt/homebrew/bin/' + bin, '/usr/local/bin/' + bin]) {
    if (existsSync(cand)) return cand
  }
  return null
}
