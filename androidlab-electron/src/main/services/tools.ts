/**
 * External-tool provisioning — find a usable Java (or download a JRE) and a
 * generic redirect-following file downloader, cached under the app-support
 * `tools/` dir. Faithful port of the provisioning half of decompile.py
 * (system_java / cached_jre_java / download_jre + _download) that leakdetect.py
 * reuses; kept dependency-light and shared so the future jadx cluster can use it
 * too. Everything is cancelable and reports human-readable progress.
 */
import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { arch as osArch } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { adoptiumUrl } from '@core/leakdetect'

/** Thrown when a long provisioning step is cancelled mid-flight. */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'CancelledError'
  }
}

export type Progress = (message: string) => void
export type IsCancelled = () => boolean

/** ~/Library/Application Support/MobileLabKit/tools (created on demand). */
export function toolsDir(): string {
  const d = join(app.getPath('userData'), 'tools')
  mkdirSync(d, { recursive: true })
  return d
}

/** Depth-first search for a `<...>/<sub>/<name>` file, however the archive nests. */
export function findUnder(root: string, name: string, sub: string): string | null {
  if (!existsSync(root)) return null
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    if (dir.endsWith(`/${sub}`) && entries.includes(name)) return join(dir, name)
    for (const e of entries) {
      const p = join(dir, e)
      try {
        if (statSync(p).isDirectory()) stack.push(p)
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  return null
}

// `java -version` writes to stderr and exits 0 on a working JVM; treat a
// non-error exit as valid (mirrors decompile.py's _valid_java).
function checkJava(path: string | null): Promise<boolean> {
  return new Promise((resolve) => {
    if (!path || !existsSync(path)) {
      resolve(false)
      return
    }
    execFile(path, ['-version'], { timeout: 10000 }, (err) => resolve(!err))
  })
}

/** A Java on this machine: $JAVA_HOME/bin/java -> `java` on PATH -> /usr/bin/java. */
export async function systemJava(): Promise<string | null> {
  const home = process.env.JAVA_HOME
  if (home) {
    const cand = join(home, 'bin', 'java')
    if (await checkJava(cand)) return cand
  }
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue
    const cand = join(dir, 'java')
    if (existsSync(cand) && (await checkJava(cand))) return cand
  }
  if (await checkJava('/usr/bin/java')) return '/usr/bin/java'
  return null
}

/** A previously downloaded JRE's `java`, if present. */
export function cachedJreJava(): string | null {
  return findUnder(join(toolsDir(), 'jre'), 'java', 'bin')
}

/**
 * Download `url` to `dest`, following redirects, honoring cancellation, and
 * reporting MB progress. Rejects (deleting a partial file) on any error.
 */
export function downloadFile(
  url: string,
  dest: string,
  progress: Progress,
  isCancelled: IsCancelled,
  label: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      try {
        if (existsSync(dest)) rmSync(dest)
      } catch {
        /* ignore */
      }
    }
    const fail = (e: Error): void => {
      cleanup()
      reject(e)
    }

    let redirects = 0
    const request = (u: string): void => {
      if (isCancelled()) {
        fail(new CancelledError())
        return
      }
      const req = httpsGet(u, { headers: { 'User-Agent': 'MobileLabKit' } }, (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume() // drain
          if (++redirects > 8) {
            fail(new Error('too many redirects'))
            return
          }
          request(new URL(res.headers.location, u).toString())
          return
        }
        if (status !== 200) {
          res.resume()
          fail(new Error(`HTTP ${status}`))
          return
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        let got = 0
        const file = createWriteStream(dest)
        res.on('data', (chunk: Buffer) => {
          if (isCancelled()) {
            req.destroy()
            file.destroy()
            fail(new CancelledError())
            return
          }
          got += chunk.length
          const mb = (got / 1e6).toFixed(1)
          progress(total ? `${label}: ${mb} / ${(total / 1e6).toFixed(1)} MB` : `${label}: ${mb} MB`)
        })
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', (e) => fail(e))
      })
      req.on('error', (e) => fail(e))
    }
    request(url)
  })
}

/** Extract a `.tar.gz` with the system `tar` (macOS ships one; avoids a dep). */
function extractTarGz(tgz: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(dest, { recursive: true })
    execFile('tar', ['-xzf', tgz, '-C', dest], { timeout: 120000 }, (err) =>
      err ? reject(err) : resolve()
    )
  })
}

/** Download + unpack an Adoptium JRE into tools/jre; return its `java` binary. */
export async function downloadJre(
  progress: Progress,
  isCancelled: IsCancelled
): Promise<string | null> {
  const dst = join(toolsDir(), 'jre')
  const tgz = join(toolsDir(), 'jre.tar.gz')
  try {
    progress('Downloading Java runtime…')
    await downloadFile(adoptiumUrl(osArch()), tgz, progress, isCancelled, 'JRE')
    progress('Extracting Java runtime…')
    rmSync(dst, { recursive: true, force: true })
    await extractTarGz(tgz, dst)
  } catch (e) {
    if (e instanceof CancelledError) throw e
    return null
  } finally {
    try {
      if (existsSync(tgz)) rmSync(tgz)
    } catch {
      /* ignore */
    }
  }
  return findUnder(dst, 'java', 'bin')
}

/**
 * Resolve a Java binary: system Java -> cached JRE -> download one. Throws a
 * user-facing RuntimeError-equivalent if none can be obtained.
 */
export async function provisionJava(progress: Progress, isCancelled: IsCancelled): Promise<string> {
  let java = (await systemJava()) ?? cachedJreJava()
  if (!java) java = await downloadJre(progress, isCancelled)
  if (!java) {
    throw new Error(
      'Java not found and the JRE download failed. Install Java ' +
        '(e.g. `brew install openjdk`) or set JAVA_HOME.'
    )
  }
  return java
}
