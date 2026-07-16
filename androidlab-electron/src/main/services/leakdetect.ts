/**
 * Memory-leak detection service. Faithful port of leakdetect.py's LeakDetectWorker
 * + provision_shark: capture a **debuggable** app's managed heap with
 * `am dumpheap`, poll until the dump stops growing, pull the `.hprof`, and run
 * LeakCanary's Shark `analyze` on it — the same application-leak traces
 * LeakCanary prints in-app, with no instrumentation.
 *
 * The Java runtime + Shark jars are provisioned on first use (system Java, else
 * a downloaded JRE; Shark jars from Maven), cached under the app-support tools/
 * dir. Streaming progress + a terminal done event mirror the QThread signals;
 * every device-side / local child is killed on cancel and in shutdown().
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { run } from './adb'
import {
  CancelledError,
  downloadFile,
  provisionJava,
  toolsDir,
  type IsCancelled,
  type Progress
} from './tools'
import {
  REMOTE_HPROF,
  SHARK_JARS,
  SHARK_MAIN,
  SHARK_VERSION,
  heapDumpFailed,
  isValidReport,
  jarFilename,
  jarUrl
} from '@core/leakdetect'

export interface LeakCallbacks {
  onProgress: (message: string) => void
  onDone: (ok: boolean, report: string, hprofPath: string, pkg: string) => void
}

function sharkDir(): string {
  const d = join(toolsDir(), `shark-${SHARK_VERSION}`)
  mkdirSync(d, { recursive: true })
  return d
}

function jarPath(artifact: string, version: string): string {
  return join(sharkDir(), jarFilename(artifact, version))
}

/** The classpath if every Shark jar is already cached, else null. */
function cachedShark(): string | null {
  const paths = SHARK_JARS.map(([, a, v]) => jarPath(a, v))
  return paths.every((p) => existsSync(p)) ? paths.join(delimiter) : null
}

/** Download any missing Shark jar; return the classpath (null on any failure). */
async function downloadShark(progress: Progress, isCancelled: IsCancelled): Promise<string | null> {
  for (let i = 0; i < SHARK_JARS.length; i++) {
    const jar = SHARK_JARS[i]
    const [, art, ver] = jar
    const dest = jarPath(art, ver)
    if (existsSync(dest)) continue
    try {
      await downloadFile(jarUrl(jar), dest, progress, isCancelled, `Shark ${i + 1}/${SHARK_JARS.length} (${art})`)
    } catch (e) {
      if (e instanceof CancelledError) throw e
      return null
    }
  }
  return cachedShark()
}

/** Return [java, classpath], downloading whatever's missing. Throws on failure. */
async function provisionShark(
  progress: Progress,
  isCancelled: IsCancelled
): Promise<[string, string]> {
  const java = await provisionJava(progress, isCancelled)
  const cp = cachedShark() ?? (await downloadShark(progress, isCancelled))
  if (!cp) {
    throw new Error('Could not download the Shark analyzer jars (check your network connection).')
  }
  return [java, cp]
}

/** ~/Downloads if it exists, else ~ — where the pulled .hprof is kept. */
function outDir(): string {
  const d = join(homedir(), 'Downloads')
  return existsSync(d) ? d : homedir()
}

export class LeakDetectService {
  private running = false
  private cancelled = false
  private serial = ''
  private pkg = ''
  private proc: ChildProcess | null = null

  constructor(
    private readonly adb: string,
    private readonly cb: LeakCallbacks
  ) {}

  get isRunning(): boolean {
    return this.running
  }

  /** Kick off the whole capture → analyze flow (no-op if one is already running). */
  start(serial: string, pkg: string): boolean {
    if (this.running) return false
    this.running = true
    this.cancelled = false
    this.serial = serial
    this.pkg = pkg
    void this.detect().finally(() => {
      this.running = false
      this.proc = null
    })
    return true
  }

  cancel(): void {
    this.cancelled = true
    this.proc?.kill('SIGKILL')
  }

  shutdown(): void {
    this.cancel()
  }

  private isCancelled = (): boolean => this.cancelled

  private done(ok: boolean, report: string, hprof: string): void {
    this.cb.onDone(ok, report, hprof, this.pkg)
  }

  private async detect(): Promise<void> {
    // 1) provisioning (Java + Shark jars)
    let java: string
    let cp: string
    try {
      this.cb.onProgress('Preparing the Shark analyzer…')
      ;[java, cp] = await provisionShark(this.cb.onProgress, this.isCancelled)
    } catch (e) {
      if (e instanceof CancelledError) return this.done(false, 'Cancelled.', '')
      return this.done(false, e instanceof Error ? e.message : String(e), '')
    }

    // 2) capture the managed heap dump
    try {
      await run(this.adb, this.serial, ['shell', 'rm', '-f', REMOTE_HPROF], 10000)
      this.cb.onProgress(`Capturing heap dump of ${this.pkg}…`)
      const r = await run(this.adb, this.serial, ['shell', 'am', 'dumpheap', this.pkg, REMOTE_HPROF], 60000)
      const blob = r.stdout + r.stderr
      if (heapDumpFailed(blob)) {
        return this.done(
          false,
          'Heap dump failed — the app must be debuggable (or the device rooted).\n\n' + blob.trim(),
          ''
        )
      }
    } catch (e) {
      return this.done(false, `adb error: ${e instanceof Error ? e.message : String(e)}`, '')
    }
    if (this.cancelled) return this.done(false, 'Cancelled.', '')

    // 3) wait for the dump to stop growing, then pull it
    this.cb.onProgress('Waiting for the dump to finish…')
    const size = await this.waitStable()
    if (this.cancelled) return this.done(false, 'Cancelled.', '')
    if (!size) {
      return this.done(
        false,
        'No heap dump was produced — the app may not be debuggable, or it stopped during the dump.',
        ''
      )
    }

    const local = join(outDir(), `${this.pkg}.hprof`)
    this.cb.onProgress(`Pulling heap dump (${Math.round(size / 1e6)} MB)…`)
    try {
      await run(this.adb, this.serial, ['pull', REMOTE_HPROF, local], 180000)
      await run(this.adb, this.serial, ['shell', 'rm', '-f', REMOTE_HPROF], 10000)
    } catch (e) {
      return this.done(false, `Failed to pull the heap dump: ${e instanceof Error ? e.message : String(e)}`, '')
    }
    if (!existsSync(local) || statSync(local).size === 0) {
      return this.done(false, 'The pulled heap dump was empty.', '')
    }
    if (this.cancelled) return this.done(false, 'Cancelled.', local)

    // 4) analyze with Shark
    this.cb.onProgress('Analyzing the heap with Shark (this can take a minute)…')
    let report: string
    try {
      report = await this.analyze(java, cp, local)
    } catch (e) {
      if (e instanceof CancelledError) return this.done(false, 'Cancelled.', local)
      const msg = e instanceof Error ? e.message : String(e)
      return this.done(false, msg === 'timeout' ? 'Shark analysis timed out.' : `Shark failed to run: ${msg}`, local)
    }
    if (this.cancelled) return this.done(false, 'Cancelled.', local)
    if (!isValidReport(report)) {
      return this.done(false, 'Shark did not return a report:\n\n' + (report || '(no output)'), local)
    }
    this.done(true, report, local)
  }

  /** Run Shark's `analyze` command; resolve with the report (stdout or stderr). */
  private analyze(java: string, cp: string, local: string): Promise<string> {
    return new Promise((resolve, reject) => {
      // Only steer JAVA_HOME/PATH toward a *downloaded* JRE (a system Java is
      // invoked as-is). Mirrors DecompileWorker._java_env.
      const env = { ...process.env }
      const dj = join(toolsDir(), 'jre')
      if (java.startsWith(dj + '/')) {
        const jbin = java.slice(0, java.lastIndexOf('/'))
        env.PATH = jbin + delimiter + (env.PATH ?? '')
        env.JAVA_HOME = jbin.slice(0, jbin.lastIndexOf('/'))
      }
      const proc = spawn(java, ['-cp', cp, SHARK_MAIN, '-h', local, 'analyze'], { env })
      this.proc = proc
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        proc.kill('SIGKILL')
        reject(new Error('timeout'))
      }, 600000)
      proc.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
      proc.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')))
      proc.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      proc.on('close', () => {
        clearTimeout(timer)
        if (this.proc === proc) this.proc = null
        if (this.cancelled) {
          reject(new CancelledError())
          return
        }
        resolve(out.trim() || err.trim())
      })
    })
  }

  /** Poll the remote file size until it stops growing; return the final size. */
  private async waitStable(): Promise<number> {
    const stat =
      `stat -c %s ${REMOTE_HPROF} 2>/dev/null || ` +
      `toybox stat -c %s ${REMOTE_HPROF} 2>/dev/null || echo 0`
    let prev = -1
    let stable = 0
    for (let i = 0; i < 90; i++) {
      if (this.cancelled) return 0
      let size = 0
      try {
        const out = (await run(this.adb, this.serial, ['shell', stat], 10000)).stdout.trim()
        const lines = out.split('\n')
        const last = lines[lines.length - 1]
        size = /^\d+$/.test(last) ? parseInt(last, 10) : 0
      } catch {
        size = 0
      }
      if (size && size === prev) {
        stable++
        if (stable >= 2) return size // unchanged across two polls → done
      } else {
        stable = 0
      }
      prev = size
      await new Promise((r) => setTimeout(r, 1000))
    }
    return prev > 0 ? prev : 0
  }
}
