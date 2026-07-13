/**
 * Toolbox service. Faithful port of the five toolbox worker classes:
 *   - AmWorker        -> runIntent      (capture am stdout+stderr; am reports
 *                                        bad intents on stdout)         [req/resp]
 *   - MonkeyWorker    -> startMonkey/stopMonkey  (stream lines; ALWAYS kill the
 *                                        on-device monkey in a finally)  [stream]
 *   - PerfettoWorker  -> capturePerfetto/cancelPerfetto (capture -> pull ->
 *                                        ~/Downloads, cancelable)        [stream]
 *   - NotifWorker     -> listNotifications                               [req/resp]
 *   - BugreportWorker -> startBugreport/cancelBugreport (stream [ NN%]
 *                                        progress -> ~/Downloads)        [stream]
 *
 * Streaming tools use child_process.spawn (like logcat.ts); request/response
 * tools use adb.run. Every device-side child is killed on stop/cancel and in
 * shutdown() — a straggler monkey keeps injecting events, and perfetto /
 * bugreport are long-running.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { run } from './adb'
import {
  KILL_MONKEY,
  buildAmArgs,
  isMonkeyCrash,
  monkeyArgs,
  parseBugreportProgress,
  parseNotifications,
  perfettoArgs,
  pullTraceArgs,
  intentLooksBad,
  type IntentSpec,
  type NotifItem
} from '@core/toolbox'

export interface ToolboxCallbacks {
  onMonkeyLine: (line: string) => void
  onMonkeyDone: (ok: boolean, summary: string) => void
  onPerfettoProgress: (message: string) => void
  onPerfettoDone: (ok: boolean, message: string, path: string, dir: string) => void
  onBugreportProgress: (pct: number) => void
  onBugreportDone: (ok: boolean, message: string, dir: string) => void
}

/** ~/Downloads if it exists, else ~ (mirrors the Python view's dest logic). */
function downloadsDir(): string {
  const d = join(homedir(), 'Downloads')
  return existsSync(d) ? d : homedir()
}

function stamp(): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const d = new Date()
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

/** A newline splitter that buffers a partial tail across chunks. */
class LineBuffer {
  private buf = ''
  push(chunk: Buffer, onLine: (line: string) => void): void {
    this.buf += chunk.toString('utf8')
    const parts = this.buf.split('\n')
    this.buf = parts.pop() ?? ''
    for (const l of parts) onLine(l)
  }
  flush(onLine: (line: string) => void): void {
    if (this.buf) {
      onLine(this.buf)
      this.buf = ''
    }
  }
}

export class ToolboxService {
  private monkeyProc: ChildProcessWithoutNullStreams | null = null
  private monkeySerial = ''
  private monkeyStopped = false

  private perfettoProc: ChildProcessWithoutNullStreams | null = null
  private perfettoCancelled = false
  private perfettoTimedOut = false
  private perfettoTimer: ReturnType<typeof setTimeout> | null = null

  private bugreportProc: ChildProcessWithoutNullStreams | null = null
  private bugreportCancelled = false

  constructor(
    private readonly adb: string,
    private readonly cb: ToolboxCallbacks
  ) {}

  // --- Intents (AmWorker) ---------------------------------------------------
  async runIntent(serial: string, spec: IntentSpec): Promise<{ ok: boolean; output: string }> {
    const r = await run(this.adb, serial, buildAmArgs(spec), 25000)
    const out = `${r.stdout}\n${r.stderr}`.trim()
    return { ok: !intentLooksBad(out, r.code), output: out || '(no output)' }
  }

  // --- Notifications (NotifWorker) ------------------------------------------
  async listNotifications(
    serial: string
  ): Promise<{ ok: boolean; message: string; items: NotifItem[] }> {
    const r = await run(this.adb, serial, ['shell', 'dumpsys', 'notification', '--noredact'], 20000)
    if (!r.stdout && r.stderr) return { ok: false, message: r.stderr.trim(), items: [] }
    const items = parseNotifications(r.stdout)
    return { ok: true, message: `${items.length} active notification(s)`, items }
  }

  // --- Monkey (MonkeyWorker) ------------------------------------------------
  startMonkey(serial: string, pkg: string, events: number, seed: number, throttleMs: number): void {
    this.stopMonkey() // safety: never two monkeys at once
    this.monkeySerial = serial
    this.monkeyStopped = false
    const proc = spawn(this.adb, ['-s', serial, ...monkeyArgs(pkg, events, seed, throttleMs)])
    this.monkeyProc = proc
    let crashed = false
    const lines = new LineBuffer()
    const onLine = (raw: string): void => {
      const line = raw.replace(/\s+$/, '')
      if (!line) return
      if (isMonkeyCrash(line)) crashed = true
      this.cb.onMonkeyLine(line)
    }
    // Python merges stderr into stdout (stderr=STDOUT); share one buffer.
    proc.stdout.on('data', (c: Buffer) => lines.push(c, onLine))
    proc.stderr.on('data', (c: Buffer) => lines.push(c, onLine))
    proc.on('error', (err) => {
      if (this.monkeyProc === proc) this.monkeyProc = null
      void this.killDeviceMonkey(serial)
      this.cb.onMonkeyDone(false, `monkey failed: ${err.message}`)
    })
    proc.on('close', (code) => {
      if (this.monkeyProc === proc) this.monkeyProc = null
      lines.flush(onLine)
      // finally: never leave a monkey running on the device.
      void this.killDeviceMonkey(serial)
      if (this.monkeyStopped) this.cb.onMonkeyDone(true, 'Monkey stopped')
      else if (crashed)
        this.cb.onMonkeyDone(false, "Monkey aborted — the app crashed or ANR'd (see the Crashes tab)")
      else this.cb.onMonkeyDone(code === 0, code === 0 ? 'Monkey finished' : `monkey exited with code ${code}`)
    })
  }

  stopMonkey(): void {
    this.monkeyStopped = true
    this.monkeyProc?.kill('SIGKILL') // killDeviceMonkey runs in the close handler
  }

  private async killDeviceMonkey(serial: string): Promise<void> {
    try {
      await run(this.adb, serial, ['shell', KILL_MONKEY], 8000)
    } catch {
      /* ignore */
    }
  }

  // --- Perfetto (PerfettoWorker) --------------------------------------------
  capturePerfetto(serial: string, durationS: number, categories: string[]): void {
    this.cancelPerfetto() // safety
    const dir = downloadsDir()
    const dest = join(dir, `trace-${stamp()}.perfetto-trace`)
    this.perfettoCancelled = false
    this.perfettoTimedOut = false
    const proc = spawn(this.adb, ['-s', serial, ...perfettoArgs(durationS, categories)])
    this.perfettoProc = proc
    let stderr = ''
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    // perfetto -t self-terminates; guard timer matches Python's communicate timeout.
    this.perfettoTimer = setTimeout(
      () => {
        if (this.perfettoProc === proc) {
          this.perfettoTimedOut = true
          proc.kill('SIGKILL')
        }
      },
      (durationS + 30) * 1000
    )
    proc.on('error', (err) => {
      this.finishPerfetto(proc)
      this.cb.onPerfettoDone(false, err.message, '', '')
    })
    proc.on('close', (code) => {
      this.finishPerfetto(proc)
      if (this.perfettoTimedOut) {
        this.cb.onPerfettoDone(false, 'perfetto timed out', '', '')
        return
      }
      if (this.perfettoCancelled) {
        this.cb.onPerfettoDone(false, 'Cancelled', '', '')
        return
      }
      if (code !== 0) {
        const hint = stderr.trim().split('\n').filter(Boolean).pop() || 'requires Android 9+'
        this.cb.onPerfettoDone(false, `perfetto failed: ${hint}`, '', '')
        return
      }
      this.cb.onPerfettoProgress('Pulling trace…')
      void run(this.adb, serial, pullTraceArgs(dest), 120000).then((r) => {
        if (r.code !== 0) {
          this.cb.onPerfettoDone(false, (r.stderr || r.stdout).trim(), '', '')
          return
        }
        this.cb.onPerfettoDone(true, `Trace saved: ${basename(dest)}`, dest, dir)
      })
    })
    this.cb.onPerfettoProgress('Recording…')
  }

  cancelPerfetto(): void {
    this.perfettoCancelled = true
    this.perfettoProc?.kill('SIGKILL')
  }

  private finishPerfetto(proc: ChildProcessWithoutNullStreams): void {
    if (this.perfettoProc === proc) this.perfettoProc = null
    if (this.perfettoTimer) {
      clearTimeout(this.perfettoTimer)
      this.perfettoTimer = null
    }
  }

  // --- Bugreport (BugreportWorker) ------------------------------------------
  startBugreport(serial: string): void {
    this.cancelBugreport() // safety
    const dir = downloadsDir()
    const safe = serial.replace(/[^a-zA-Z0-9]/g, '_')
    const dest = join(dir, `bugreport-${safe}-${stamp()}.zip`)
    this.bugreportCancelled = false
    const proc = spawn(this.adb, ['-s', serial, 'bugreport', dest])
    this.bugreportProc = proc
    const lines = new LineBuffer()
    const onLine = (line: string): void => {
      const pct = parseBugreportProgress(line)
      if (pct !== null) this.cb.onBugreportProgress(pct)
    }
    // Python merges stderr into stdout (stderr=STDOUT); share one buffer.
    proc.stdout.on('data', (c: Buffer) => lines.push(c, onLine))
    proc.stderr.on('data', (c: Buffer) => lines.push(c, onLine))
    proc.on('error', (err) => {
      if (this.bugreportProc === proc) this.bugreportProc = null
      this.cb.onBugreportDone(false, `bugreport failed: ${err.message}`, '')
    })
    proc.on('close', (code) => {
      if (this.bugreportProc === proc) this.bugreportProc = null
      lines.flush(onLine)
      if (this.bugreportCancelled) this.cb.onBugreportDone(false, 'Bugreport cancelled', '')
      else if (code === 0 && existsSync(dest))
        this.cb.onBugreportDone(true, `Bugreport saved: ${basename(dest)}`, dir)
      else this.cb.onBugreportDone(false, `bugreport exited with code ${code}`, '')
    })
  }

  cancelBugreport(): void {
    this.bugreportCancelled = true
    this.bugreportProc?.kill('SIGKILL')
  }

  /** Kill every live device-side child (mirrors ToolboxView.shutdown fan-out). */
  shutdown(): void {
    this.monkeyStopped = true
    this.perfettoCancelled = true
    this.bugreportCancelled = true
    if (this.perfettoTimer) {
      clearTimeout(this.perfettoTimer)
      this.perfettoTimer = null
    }
    this.monkeyProc?.kill('SIGKILL')
    this.perfettoProc?.kill('SIGKILL')
    this.bugreportProc?.kill('SIGKILL')
    if (this.monkeySerial) void this.killDeviceMonkey(this.monkeySerial)
    this.monkeyProc = null
    this.perfettoProc = null
    this.bugreportProc = null
  }
}
