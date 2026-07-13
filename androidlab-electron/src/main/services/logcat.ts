/**
 * Live `adb logcat -v threadtime` reader.
 * Faithful port of logcat_viewer/adb.py's LogcatReader (QProcess -> spawn):
 * spawns adb, batches decoded lines on stdout, keeps the partial tail, and
 * reports started/stopped/error state.
 */
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { LogcatState } from '@shared/types'

const NEWLINE = 0x0a

export interface LogcatCallbacks {
  onLines: (lines: string[]) => void
  onState: (state: LogcatState) => void
  onError: (message: string) => void
}

export class LogcatReader {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf: Buffer = Buffer.alloc(0)

  constructor(
    private readonly adb: string,
    private readonly cb: LogcatCallbacks
  ) {}

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null && !this.proc.killed
  }

  start(serial: string, clearFirst = false): void {
    this.stop()
    if (clearFirst) {
      try {
        execFile(this.adb, ['-s', serial, 'logcat', '-c'], { timeout: 8000 }, () => {})
      } catch {
        /* ignore */
      }
    }
    this.buf = Buffer.alloc(0)
    // Default stdio ('pipe' for all three) -> ChildProcessWithoutNullStreams;
    // we simply never write to stdin.
    const proc = spawn(this.adb, ['-s', serial, 'logcat', '-v', 'threadtime'])
    this.proc = proc

    proc.on('spawn', () => this.cb.onState('started'))
    proc.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    proc.stderr.on('data', (chunk: Buffer) => {
      const data = chunk.toString('utf8').trim()
      if (data) this.cb.onError(data)
    })
    proc.on('close', () => {
      if (this.proc === proc) this.proc = null
      this.cb.onState('stopped')
    })
    proc.on('error', (err) => {
      this.cb.onError(`process error: ${err.message}`)
      this.cb.onState('error')
    })
  }

  stop(): void {
    if (this.proc !== null) {
      const proc = this.proc
      this.proc = null
      proc.stdout.removeAllListeners('data')
      proc.kill('SIGKILL')
      this.cb.onState('stopped')
    }
  }

  private onStdout(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const lastNl = this.buf.lastIndexOf(NEWLINE)
    if (lastNl < 0) return
    // Everything up to (not including) the final newline; keep the partial tail.
    const complete = this.buf.subarray(0, lastNl)
    this.buf = this.buf.subarray(lastNl + 1)
    const text = complete.toString('utf8')
    const lines = text.split('\n')
    if (lines.length > 0) this.cb.onLines(lines)
  }
}
