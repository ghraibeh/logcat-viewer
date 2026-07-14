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
import { createServer, type Server, type Socket } from 'node:net'
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
  parseScrcpyVersion,
  pkillScreenrecordArgs,
  pullArgs,
  rmArgs,
  safeSerial,
  screencapArgs,
  screenrecordFileArgs,
  screenrecordH264Args,
  scrcpyKillArgs,
  scrcpyPushArgs,
  scrcpyReverseArgs,
  scrcpyReverseRemoveArgs,
  scrcpyServerArgs,
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
  /** Raw H.264 Annex-B bytes (screenrecord OR scrcpy raw_stream); renderer re-frames them. */
  onH264: (chunk: Uint8Array) => void
  /** scrcpy's control socket came up (or went away) — the renderer routes input to
   *  the control channel (interactive drag / keyboard) when true, else `adb input`. */
  onControlReady: (ready: boolean) => void
  /** A feed failed; kind lets the renderer fall back (h264/scrcpy → poller). */
  onFailed: (kind: 'h264' | 'poller', message: string) => void
}

export class MirrorService {
  private serial = ''
  private runToken = 0 // bumped on every stop/start to invalidate old loops
  private h264Proc: ChildProcess | null = null

  private scrcpyProc: ChildProcess | null = null
  private scrcpySock: Socket | null = null // video socket
  private scrcpyControl: Socket | null = null // control socket (touch/key/text)
  private scrcpyServer: Server | null = null // local listener the device connects back to
  private scrcpyScid: string | null = null
  private scrcpyVer: string | null = null

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

  /**
   * Preferred smooth path: stream from scrcpy's server (no static-screen stalls).
   * Falls back to the screenrecord H.264 loop when the server jar isn't installed.
   */
  startScrcpy(serial: string): void {
    this.stopFeed()
    this.serial = serial
    const token = ++this.runToken
    const jar = scrcpyServerPath()
    if (jar) void this.scrcpyLoop(token, jar)
    else void this.h264Loop(token)
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
    this.killScrcpy()
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

  // --- scrcpy feed --------------------------------------------------------
  private async scrcpyLoop(token: number, jar: string): Promise<void> {
    // Free the sole encoder (a stale screenrecord or old server) before starting,
    // then paint one screencap so the canvas isn't blank while the server boots.
    await run(this.adb, this.serial, pkillScreenrecordArgs(this.serial).slice(2), 6000)
    await run(this.adb, this.serial, scrcpyKillArgs(this.serial).slice(2), 6000)
    if (token !== this.runToken) return
    await this.prime(token)
    if (token !== this.runToken) return

    const version = await this.scrcpyVersion()
    const push = await run(this.adb, null, scrcpyPushArgs(this.serial, jar), 30000)
    if (token !== this.runToken) return
    if (push.code !== 0) {
      this.cb.onFailed('h264', `could not push scrcpy-server: ${push.stderr.trim() || 'push failed'}`)
      return
    }

    const scid = randScid()
    this.scrcpyScid = scid

    // Listen locally; the device connects back over an adb reverse tunnel. With a
    // reverse tunnel the server dials us only once it is fully up, and in a fixed
    // order (video socket first, then control) — no connect race, no poller fallback,
    // and a deterministic way to tell the two sockets apart.
    const server = createServer((sock) => {
      sock.on('error', () => {
        /* ignore per-socket errors */
      })
      if (!this.scrcpySock) {
        this.scrcpySock = sock
        this.readScrcpyStream(sock, token)
      } else if (!this.scrcpyControl) {
        this.scrcpyControl = sock
        sock.on('data', () => {
          /* device→client control (clipboard etc.) — unused for now */
        })
        if (token === this.runToken) this.cb.onControlReady(true)
      } else {
        sock.destroy()
      }
    })
    this.scrcpyServer = server
    const port = await new Promise<number>((resolve) => {
      server.once('error', () => resolve(0))
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
    if (token !== this.runToken) return
    if (!port) {
      this.cb.onFailed('h264', 'could not open a local port for the scrcpy tunnel')
      this.killScrcpy()
      return
    }

    const rev = await run(this.adb, null, scrcpyReverseArgs(this.serial, scid, port), 8000)
    if (token !== this.runToken) return
    if (rev.code !== 0) {
      this.cb.onFailed('h264', `adb reverse failed: ${rev.stderr.trim() || 'unknown'}`)
      this.killScrcpy()
      return
    }

    const proc = spawn(this.adb, scrcpyServerArgs(this.serial, scid, version))
    this.scrcpyProc = proc
    let serverLog = ''
    proc.stdout.on('data', (c: Buffer) => (serverLog += c.toString('utf8')))
    proc.stderr.on('data', (c: Buffer) => (serverLog += c.toString('utf8')))
    proc.on('close', () => {
      if (this.scrcpyProc === proc) this.scrcpyProc = null
    })

    // Wait for the device to dial back the video socket.
    const started = await this.waitForVideo(token)
    if (!started) {
      if (token === this.runToken) {
        const last = serverLog.trim().split('\n').filter(Boolean).pop()
        this.cb.onFailed('h264', `scrcpy stream did not start${last ? `: ${last}` : ''}`)
        this.killScrcpy()
      }
    }
  }

  /** Resolve once the video socket dials back, or false on timeout / cancel. */
  private waitForVideo(token: number): Promise<boolean> {
    const deadline = Date.now() + 6000
    return new Promise((resolve) => {
      const check = (): void => {
        if (token !== this.runToken) return resolve(false)
        if (this.scrcpySock) return resolve(true)
        if (Date.now() > deadline) return resolve(false)
        setTimeout(check, 100)
      }
      check()
    })
  }

  /** Forward the raw Annex-B bytes straight to the renderer's demuxer (raw_stream
   *  disables scrcpy's own framing, so this is the same byte shape as screenrecord). */
  private readScrcpyStream(sock: Socket, token: number): void {
    sock.on('data', (chunk: Buffer) => {
      if (token !== this.runToken) return
      this.cb.onH264(new Uint8Array(chunk))
    })
    const onEnd = (): void => {
      // Only a surprise exit matters; a deliberate stop bumps runToken first.
      if (token === this.runToken) this.cb.onFailed('h264', 'scrcpy stream ended')
    }
    sock.on('close', onEnd)
    sock.on('error', onEnd)
  }

  /** Inject a pre-encoded scrcpy control message (touch/key/text) if the control
   *  socket is up. No-op otherwise, so the renderer can call it unconditionally. */
  control(data: Uint8Array): void {
    const sock = this.scrcpyControl
    if (sock && !sock.destroyed) {
      try {
        sock.write(Buffer.from(data))
      } catch {
        /* socket went away between the check and the write */
      }
    }
  }

  private async scrcpyVersion(): Promise<string> {
    if (this.scrcpyVer) return this.scrcpyVer
    const bin = this.scrcpyPath()
    const parsed = bin
      ? await new Promise<string | null>((resolve) => {
          execFile(bin, ['--version'], { timeout: 6000 }, (err, stdout) => {
            resolve(err ? null : parseScrcpyVersion(stdout))
          })
        })
      : null
    this.scrcpyVer = parsed ?? '4.0'
    return this.scrcpyVer
  }

  /** Kill the server + sockets + local listener + adb reverse (frees the encoder).
   *  Never pkills screenrecord — recording uses that and manages its own lifecycle. */
  private killScrcpy(): void {
    const hadControl = this.scrcpyControl != null
    for (const s of [this.scrcpySock, this.scrcpyControl]) {
      try {
        s?.destroy()
      } catch {
        /* ignore */
      }
    }
    this.scrcpySock = null
    this.scrcpyControl = null
    if (hadControl) this.cb.onControlReady(false)
    if (this.scrcpyServer) {
      try {
        this.scrcpyServer.close()
      } catch {
        /* ignore */
      }
      this.scrcpyServer = null
    }
    if (this.scrcpyProc) {
      try {
        this.scrcpyProc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      this.scrcpyProc = null
    }
    if (this.scrcpyScid != null) {
      void run(this.adb, null, scrcpyReverseRemoveArgs(this.serial, this.scrcpyScid), 6000)
      this.scrcpyScid = null
    }
    void run(this.adb, this.serial, scrcpyKillArgs(this.serial).slice(2), 6000)
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
    // Recording needs the sole display encoder. Stop the scrcpy feed + streaming
    // proc so `screenrecord` can acquire it (the renderer then drops preview to the
    // screencap poller). Invalidate the feed loop so it doesn't fight the recorder.
    this.runToken++
    this.killScrcpy()
    if (this.h264Proc) {
      try {
        this.h264Proc.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      this.h264Proc = null
    }
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

/** Locate scrcpy's server jar (ships alongside the binary under share/scrcpy). */
function scrcpyServerPath(): string | null {
  const env = process.env.SCRCPY_SERVER_PATH
  if (env && existsSync(env)) return env
  const cands: string[] = []
  const bin = whichIn('scrcpy')
  if (bin) cands.push(join(dirname(bin), '..', 'share', 'scrcpy', 'scrcpy-server'))
  cands.push(
    '/opt/homebrew/share/scrcpy/scrcpy-server',
    '/usr/local/share/scrcpy/scrcpy-server',
    '/usr/share/scrcpy/scrcpy-server'
  )
  for (const c of cands) if (existsSync(c)) return c
  return null
}

/** 31-bit random → 8 lowercase hex, matching scrcpy's `scrcpy_%08x` socket name. */
function randScid(): string {
  return Math.floor(Math.random() * 0x7fffffff)
    .toString(16)
    .padStart(8, '0')
}
