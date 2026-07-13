/**
 * Device File Explorer service. Faithful port of files.py's workers:
 *   - DirListWorker -> listDir() (run-as, rooted `su` escalation)
 *   - PullWorker    -> pull()    (public `adb pull`; app-private `exec-out cat`
 *                                 for files + recursion for dirs)
 *   - PushWorker    -> push()    (public `adb push`; app-private `run-as … dd`
 *                                 over stdin + recursion)
 *   - FileOpWorker  -> mkdir()/rename()/delete()
 *   - _open_entry   -> openEntry() (pull to a temp dir so the OS can open it)
 *
 * All device work happens here in the main process; the renderer only sees JSON.
 * Access-mode selection mirrors files.py's access_for (app-private path → run-as,
 * else plain shell; a Root-su toggle forces su).
 */
import { execFile, spawn } from 'node:child_process'
import { basename, join } from 'node:path'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { run } from './adb'
import {
  accessFor,
  catArgs,
  classifyListing,
  deleteArgs,
  joinPath,
  lsArgs,
  mkdirArgs,
  renameArgs,
  type Access,
  type FileKind
} from '@core/files'
import type {
  FilesListResult,
  FilesOpResult,
  FilesOpenResult,
  FilesPullItem,
  FilesTransferResult
} from '@shared/types'

const TRANSFER_TIMEOUT = 600_000

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// --- binary-clean exec that also surfaces the exit code (Python's returncode) --
function execBinary(
  adb: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      adb,
      args,
      { timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: number }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0
        resolve({
          code,
          stdout: (stdout as Buffer) ?? Buffer.alloc(0),
          stderr: stderr ? (stderr as Buffer).toString('utf8') : ''
        })
      }
    )
  })
}

// --- transfer helpers (mirror files.py's _pull_* / _push_* / _dd_push) --------
/** `adb pull` a world-readable path (handles files and dirs). */
async function pullPublic(adb: string, serial: string, remote: string, local: string): Promise<boolean> {
  const r = await run(adb, serial, ['pull', remote, local], TRANSFER_TIMEOUT)
  return r.code === 0 && existsSync(local)
}

/** Stream one app-private file to `local` via `exec-out … cat` (binary-clean). */
async function pullPrivateFile(
  adb: string,
  serial: string,
  remote: string,
  local: string,
  a: Access
): Promise<boolean> {
  const r = await execBinary(adb, catArgs(serial, remote, a), TRANSFER_TIMEOUT)
  if (r.code !== 0) return false
  try {
    writeFileSync(local, r.stdout)
  } catch {
    return false
  }
  return true
}

/** Recursively pull an app-private directory (adb pull can't reach it). */
async function pullPrivateDir(
  adb: string,
  serial: string,
  remote: string,
  local: string,
  a: Access
): Promise<boolean> {
  mkdirSync(local, { recursive: true })
  const r = await run(adb, null, lsArgs(serial, remote, a), 60_000)
  const { entries } = classifyListing(r.code ?? 1, r.stdout, r.stderr)
  if (entries === null) return false
  let ok = true
  for (const e of entries) {
    const childR = joinPath(remote, e.name)
    const childL = join(local, e.name)
    if (e.kind === 'dir') ok = (await pullPrivateDir(adb, serial, childR, childL, a)) && ok
    else ok = (await pullPrivateFile(adb, serial, childR, childL, a)) && ok
  }
  return ok
}

/** Pull one entry to `local`. Public paths use `adb pull`; app-private paths
 *  (run-as/su set) stream via `cat` (files) or recurse (dirs). */
async function pullOne(
  adb: string,
  serial: string,
  remote: string,
  kind: FileKind,
  local: string,
  a: Access
): Promise<boolean> {
  if (!a.runAs && !a.su) return pullPublic(adb, serial, remote, local)
  if (kind === 'dir') return pullPrivateDir(adb, serial, remote, local, a)
  return pullPrivateFile(adb, serial, remote, local, a)
}

/** Stream `local` into an app-private path via `dd of=<remote>` over stdin — no
 *  shell redirect, and no need for the app to read /data/local/tmp. */
function ddPush(
  adb: string,
  serial: string,
  local: string,
  remote: string,
  a: Access
): Promise<{ ok: boolean; detail: string }> {
  const prefix = a.su ? ['su', '-c'] : ['run-as', a.runAs as string]
  const args = ['-s', serial, 'shell', ...prefix, 'dd', `of=${remote}`]
  return new Promise((resolve) => {
    const child = spawn(adb, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stderr = ''
    let settled = false
    const done = (ok: boolean, detail: string): void => {
      if (settled) return
      settled = true
      resolve({ ok, detail: detail.trim() })
    }
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (e) => done(false, errMsg(e)))
    child.on('close', (code) => done(code === 0, stderr))
    const rs = createReadStream(local)
    rs.on('error', (e) => {
      child.stdin.end()
      done(false, errMsg(e))
    })
    rs.pipe(child.stdin)
  })
}

async function pushPrivatePath(
  adb: string,
  serial: string,
  local: string,
  remote: string,
  a: Access
): Promise<{ ok: boolean; detail: string }> {
  let isDir = false
  try {
    isDir = statSync(local).isDirectory()
  } catch (e) {
    return { ok: false, detail: errMsg(e) }
  }
  if (isDir) {
    await run(adb, null, mkdirArgs(serial, remote, a), 30_000)
    let ok = true
    let detail = ''
    for (const child of readdirSync(local).sort()) {
      const r = await pushPrivatePath(adb, serial, join(local, child), joinPath(remote, child), a)
      ok = r.ok && ok
      detail = detail || r.detail
    }
    return { ok, detail }
  }
  return ddPush(adb, serial, local, remote, a)
}

async function pushPublic(
  adb: string,
  serial: string,
  local: string,
  remote: string
): Promise<{ ok: boolean; detail: string }> {
  const r = await run(adb, serial, ['push', local, remote], TRANSFER_TIMEOUT)
  const lines = (r.stderr || r.stdout || '').trim().split('\n')
  return { ok: r.code === 0, detail: lines.length ? lines[lines.length - 1] : 'push failed' }
}

export class FilesService {
  private tmpDir: string | null = null

  constructor(private readonly adb: string) {}

  private tmp(): string {
    if (!this.tmpDir) this.tmpDir = mkdtempSync(join(tmpdir(), 'androidlab-files-'))
    return this.tmpDir
  }

  // --- listing (DirListWorker: run-as → su escalation) ------------------------
  private async listOnce(serial: string, path: string, a: Access): Promise<ReturnType<typeof classifyListing>> {
    const r = await run(this.adb, null, lsArgs(serial, path, a), 25_000)
    return classifyListing(r.code ?? 1, r.stdout, r.stderr)
  }

  async listDir(
    serial: string,
    path: string,
    pkg: string | null,
    rootMode: boolean
  ): Promise<FilesListResult> {
    const a = accessFor(path, pkg, rootMode)
    const { entries, error } = await this.listOnce(serial, path, a)
    // run-as refused for a private dir → try root (su).
    if (error === 'blocked' && a.runAs && !a.su) {
      const suRes = await this.listOnce(serial, path, { runAs: null, su: true })
      if (suRes.entries !== null) {
        return { ok: true, path, entries: suRes.entries, error: '', usedSu: true }
      }
      return {
        ok: false,
        path,
        entries: [],
        error:
          `'${a.runAs}' is not debuggable and the device isn't rooted — ` +
          'its private files can’t be read.',
        usedSu: false
      }
    }
    if (entries === null) {
      const msg =
        error === 'not found'
          ? 'No such directory'
          : error === 'denied'
            ? 'Permission denied — try the Root (su) toggle on a rooted device'
            : error === 'blocked'
              ? 'Not accessible (app not debuggable and no root)'
              : `Couldn't list: ${error}`
      return { ok: false, path, entries: [], error: msg, usedSu: a.su }
    }
    return { ok: true, path, entries, error: '', usedSu: a.su }
  }

  // --- pulling (PullWorker) ---------------------------------------------------
  async pull(
    serial: string,
    path: string,
    pkg: string | null,
    rootMode: boolean,
    items: FilesPullItem[],
    destDir: string
  ): Promise<FilesTransferResult> {
    const a = accessFor(path, pkg, rootMode)
    const pulled: string[] = []
    const errors: string[] = []
    for (const { name, kind } of items) {
      const remote = joinPath(path, name)
      const local = join(destDir, name)
      let ok = false
      try {
        ok = await pullOne(this.adb, serial, remote, kind, local, a)
      } catch (e) {
        errors.push(`${name}: ${errMsg(e)}`)
        continue
      }
      if (ok) pulled.push(name)
      else errors.push(`${name}: pull failed`)
    }
    const ok = pulled.length > 0 && errors.length === 0
    let message: string
    if (pulled.length) {
      message = `Pulled ${pulled.length} item(s): ${pulled.join(', ')}`
      if (errors.length) message += `  (${errors.length} failed: ${errors.join('; ')})`
    } else {
      message = errors.length ? 'Pull failed: ' + errors.join('; ') : 'Nothing to pull'
    }
    return { ok, message, dir: destDir }
  }

  // --- pushing (PushWorker) ---------------------------------------------------
  async push(
    serial: string,
    path: string,
    pkg: string | null,
    rootMode: boolean,
    sources: string[]
  ): Promise<FilesTransferResult> {
    const a = accessFor(path, pkg, rootMode)
    const pushed: string[] = []
    const errors: string[] = []
    for (const local of sources) {
      const name = basename(local.replace(/\/+$/, ''))
      const remote = joinPath(path, name)
      const r =
        a.runAs || a.su
          ? await pushPrivatePath(this.adb, serial, local, remote, a)
          : await pushPublic(this.adb, serial, local, remote)
      if (r.ok) pushed.push(name)
      else errors.push(`${name}: ${r.detail || 'failed'}`)
    }
    const ok = pushed.length > 0 && errors.length === 0
    let message: string
    if (pushed.length) {
      message = `Pushed ${pushed.length} item(s) to ${path}: ${pushed.join(', ')}`
      if (errors.length) message += `  (${errors.length} failed: ${errors.join('; ')})`
    } else {
      message = errors.length ? 'Push failed: ' + errors.join('; ') : 'Nothing to push'
    }
    return { ok, message, dir: '' }
  }

  // --- one-shot file ops (FileOpWorker) ---------------------------------------
  private async runOp(argv: string[], okMsg: string): Promise<FilesOpResult> {
    const r = await run(this.adb, null, argv, 45_000)
    if ((r.code ?? 1) === 0) return { ok: true, message: okMsg }
    return { ok: false, message: (r.stderr || r.stdout || 'operation failed').trim() }
  }

  async mkdir(serial: string, path: string, pkg: string | null, rootMode: boolean, name: string): Promise<FilesOpResult> {
    const a = accessFor(path, pkg, rootMode)
    const target = joinPath(path, name)
    return this.runOp(mkdirArgs(serial, target, a), `Created ${target}`)
  }

  async rename(
    serial: string,
    path: string,
    pkg: string | null,
    rootMode: boolean,
    oldName: string,
    newName: string
  ): Promise<FilesOpResult> {
    const a = accessFor(path, pkg, rootMode)
    const argv = renameArgs(serial, joinPath(path, oldName), joinPath(path, newName), a)
    return this.runOp(argv, `Renamed to ${newName}`)
  }

  async delete(
    serial: string,
    path: string,
    pkg: string | null,
    rootMode: boolean,
    names: string[]
  ): Promise<FilesOpResult> {
    const a = accessFor(path, pkg, rootMode)
    const paths = names.map((n) => joinPath(path, n))
    return this.runOp(deleteArgs(serial, paths, a), `Deleted ${names.length} item(s)`)
  }

  // --- open a device file on the Mac (pull to a temp dir, hand back the path) -
  async openEntry(
    serial: string,
    path: string,
    pkg: string | null,
    rootMode: boolean,
    name: string,
    kind: FileKind
  ): Promise<FilesOpenResult> {
    const a = accessFor(path, pkg, rootMode)
    const dst = join(this.tmp(), 'open')
    rmSync(dst, { recursive: true, force: true })
    mkdirSync(dst, { recursive: true })
    const local = join(dst, name)
    const remote = joinPath(path, name)
    let ok = false
    try {
      ok = await pullOne(this.adb, serial, remote, kind, local, a)
    } catch (e) {
      return { ok: false, message: errMsg(e), localPath: '' }
    }
    if (!ok) return { ok: false, message: `Couldn't open ${name}`, localPath: '' }
    return { ok: true, message: `Opened ${name}`, localPath: local }
  }

  /** Remove staged temp files on app close (mirrors FilesView.shutdown). */
  shutdown(): void {
    if (this.tmpDir) {
      try {
        rmSync(this.tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      this.tmpDir = null
    }
  }
}
