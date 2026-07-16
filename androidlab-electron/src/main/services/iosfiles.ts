/**
 * iOS Files-browser backend. Reuses the Android `FilesView` unchanged — only the
 * device I/O differs: an app's container is listed / pulled via go-ios `fsync`
 * (house-arrest AFC, no tunnel). `FilesView` addresses the container as an
 * absolute-style path under '/', which maps to fsync-relative here ('/' → '.').
 *
 * Read-only for now (browse / download / open). Upload/mkdir/rename/delete mutate
 * the app's live data and are gated off in the IPC layer. Works for apps with
 * File Sharing enabled or your own dev-signed apps.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { shell } from 'electron'
import { containerPull, containerTree } from './goios'
import type { FileEntry, FileKind } from '@core/files'
import type { FilesListResult, FilesOpenResult, FilesPullItem, FilesTransferResult } from '@shared/types'

/** FilesView addresses the container '/'-rooted; fsync wants it relative. */
function rel(path: string): string {
  const p = path.replace(/^\/+/, '')
  return p === '' ? '.' : p
}
function remoteOf(path: string, name: string): string {
  const base = rel(path)
  return base === '.' ? name : `${base}/${name}`
}

let tmpDir: string | null = null
function tmp(): string {
  if (!tmpDir) tmpDir = mkdtempSync(join(tmpdir(), 'androidlab-iosfiles-'))
  return tmpDir
}

/** One directory level of the app container (`fsync tree`, immediate children). */
export async function list(bin: string, udid: string, pkg: string, path: string): Promise<FilesListResult> {
  const t = await containerTree(bin, udid, pkg, rel(path))
  if (!t.ok) return { ok: false, path, entries: [], error: t.error, usedSu: false }
  // `fsync tree` is recursive; the immediate children of `path` are the entries
  // at the shallowest indent level in the output.
  const minDepth = t.entries.length ? Math.min(...t.entries.map((e) => e.depth)) : 0
  const entries: FileEntry[] = t.entries
    .filter((e) => e.depth === minDepth)
    .map((e) => ({
      name: e.name,
      kind: (e.isDir ? 'dir' : 'file') as FileKind,
      size: null,
      mode: '',
      linkTarget: null,
      modified: ''
    }))
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
    const la = a.name.toLowerCase()
    const lb = b.name.toLowerCase()
    return la < lb ? -1 : la > lb ? 1 : 0
  })
  return { ok: true, path, entries, error: '', usedSu: false }
}

/** Download selected items to a chosen folder. */
export async function pull(
  bin: string,
  udid: string,
  pkg: string,
  path: string,
  items: FilesPullItem[],
  destDir: string
): Promise<FilesTransferResult> {
  const pulled: string[] = []
  const failed: string[] = []
  for (const it of items) {
    const got = await containerPull(bin, udid, pkg, remoteOf(path, it.name), destDir)
    if (got) pulled.push(it.name)
    else failed.push(it.name)
  }
  const ok = pulled.length > 0 && failed.length === 0
  let message: string
  if (pulled.length) {
    message = `Pulled ${pulled.length} item(s) to ${destDir}`
    if (failed.length) message += `  (${failed.length} failed: ${failed.join(', ')})`
  } else {
    message = `Pull failed: ${failed.join(', ') || 'nothing pulled'}`
  }
  return { ok, message, dir: destDir }
}

/** Pull a file to a temp dir and hand it to the OS. */
export async function openEntry(
  bin: string,
  udid: string,
  pkg: string,
  path: string,
  name: string,
  _kind: FileKind
): Promise<FilesOpenResult> {
  const local = await containerPull(bin, udid, pkg, remoteOf(path, name), tmp())
  if (!local || !existsSync(local)) return { ok: false, message: `Couldn't open ${name}`, localPath: '' }
  await shell.openPath(local)
  return { ok: true, message: `Opened ${name}`, localPath: local }
}

export function shutdown(): void {
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
    tmpDir = null
  }
}
