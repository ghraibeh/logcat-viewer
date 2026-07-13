/**
 * Device File Explorer pure helpers. Faithful port of logcat_viewer/files.py's
 * Qt-free layer: the adb command builders (run-as + rooted `su` variants), the
 * `ls -lHA` line parser + listing classifier, `accessFor` (app-private → run-as,
 * else plain shell; Root-su forces su), the path helpers, and the drawn-icon
 * grouping / human-size formatting.
 *
 * DOM-, adb- and fs-free so it is unit-tested directly; the actual pull / push /
 * listing lives in main/services/files.ts.
 */

export const DATA_DATA = '/data/data'
export const DEFAULT_PATH = '/sdcard'

/** One navigation-pane bookmark: label, path, and whether it needs an app pick. */
export interface Place {
  label: string
  path: string
  needsApp: boolean
}

// The navigation-pane bookmarks, grouped Windows-Explorer-style.
export const QUICK_ACCESS: Place[] = [
  { label: 'App data', path: DATA_DATA, needsApp: true }, // rewritten to /data/data/<pkg>
  { label: 'Downloads', path: '/sdcard/Download', needsApp: false },
  { label: 'Pictures', path: '/sdcard/DCIM', needsApp: false }
]
export const LOCATIONS: Place[] = [
  { label: 'Internal storage', path: '/sdcard', needsApp: false },
  { label: 'Temp', path: '/data/local/tmp', needsApp: false },
  { label: 'System', path: '/system', needsApp: false },
  { label: 'Device root', path: '/', needsApp: false }
]
/** Flattened, for code that just needs every bookmark (e.g. smoke tests). */
export const PLACES: Place[] = [...QUICK_ACCESS, ...LOCATIONS]

// --- path helpers -------------------------------------------------------------
export function joinPath(base: string, name: string): string {
  if (base === '/') return '/' + name
  return base.replace(/\/+$/, '') + '/' + name
}

export function parentPath(path: string): string {
  const p = path.replace(/\/+$/, '')
  if (!p || !p.includes('/')) return '/'
  return p.slice(0, p.lastIndexOf('/')) || '/'
}

/** True if `path` lives inside the selected app's private data dir. */
export function isAppPrivate(path: string, pkg: string | null): boolean {
  if (!pkg) return false
  const root = `${DATA_DATA}/${pkg}`
  return path === root || path.startsWith(root + '/')
}

/** How a device path is reached. `runAs` set = `run-as <pkg>`; `su` = rooted. */
export interface Access {
  runAs: string | null
  su: boolean
}

const NO_ACCESS: Access = { runAs: null, su: false }

/**
 * How to reach `path` → `{ runAs, su }`. Root (su) mode wraps everything in
 * `su`; otherwise app-private paths use `run-as <pkg>` (the service escalates to
 * su if run-as is refused) and everything else uses a plain shell / adb pull-push.
 */
export function accessFor(path: string, pkg: string | null, rootMode = false): Access {
  if (rootMode) return { runAs: null, su: true }
  if (isAppPrivate(path, pkg)) return { runAs: pkg, su: false }
  return { runAs: null, su: false }
}

export function humanSize(n: number | null): string {
  if (n === null) return ''
  let size = n
  for (const unit of ['B', 'KB', 'MB', 'GB', 'TB'] as const) {
    if (size < 1024 || unit === 'TB') {
      return unit === 'B' ? `${Math.trunc(size)} ${unit}` : `${size.toFixed(1)} ${unit}`
    }
    size /= 1024
  }
  return `${size.toFixed(1)} TB`
}

// --- pure adb command builders (no device needed → covered by unit tests) -----
// No shell redirections/metacharacters — `adb shell` re-parses the command
// line, so anything fancier gets word-split on the device. run-as/su exec the
// plain binary directly, which is safe.
function shellPrefix(serial: string, a: Access): string[] {
  const base = ['-s', serial, 'shell']
  if (a.su) return [...base, 'su', '-c']
  if (a.runAs) return [...base, 'run-as', a.runAs]
  return base
}

function execOutPrefix(serial: string, a: Access): string[] {
  const base = ['-s', serial, 'exec-out']
  if (a.su) return [...base, 'su', '-c']
  if (a.runAs) return [...base, 'run-as', a.runAs]
  return base
}

/**
 * adb args to long-list a directory. `-A` includes dotfiles (not . / ..); `-H`
 * dereferences the path itself when it's a symlink (e.g. `/sdcard` →
 * `/storage/self/primary`) so we list its contents, not the link — while
 * entries *inside* still show as links.
 */
export function lsArgs(serial: string, path: string, a: Access = NO_ACCESS): string[] {
  return [...shellPrefix(serial, a), 'ls', '-lHA', path]
}

/** adb args to stream one file to stdout, binary-clean (via exec-out). */
export function catArgs(serial: string, path: string, a: Access = NO_ACCESS): string[] {
  return [...execOutPrefix(serial, a), 'cat', path]
}

export function mkdirArgs(serial: string, path: string, a: Access = NO_ACCESS): string[] {
  return [...shellPrefix(serial, a), 'mkdir', '-p', path]
}

export function renameArgs(serial: string, src: string, dst: string, a: Access = NO_ACCESS): string[] {
  return [...shellPrefix(serial, a), 'mv', src, dst]
}

export function deleteArgs(serial: string, paths: string[], a: Access = NO_ACCESS): string[] {
  return [...shellPrefix(serial, a), 'rm', '-rf', ...paths]
}

// --- listing parse ------------------------------------------------------------
export type FileKind = 'dir' | 'file' | 'link' | 'other'

export interface FileEntry {
  name: string
  kind: FileKind
  /** byte size, or null (directories / device nodes). */
  size: number | null
  /** the `ls` mode string, e.g. `drwxr-xr-x`. */
  mode: string
  /** symlink target (`name -> target`), or null. */
  linkTarget: string | null
  /** "YYYY-MM-DD HH:MM" from ls (best-effort). */
  modified: string
}

/** Lower-case extension without the dot ("" for none / directories). */
export function ext(e: FileEntry): string {
  if (e.kind === 'dir') return ''
  const dot = e.name.lastIndexOf('.')
  return dot > 0 ? e.name.slice(dot + 1).toLowerCase() : ''
}

export function typeLabel(e: FileEntry): string {
  if (e.kind === 'dir') return 'File folder'
  if (e.kind === 'link') return 'Shortcut'
  if (e.kind === 'other') return 'System file'
  const x = ext(e)
  return x ? `${x.toUpperCase()} file` : 'File'
}

const BLOCKED = ['not debuggable', 'unknown package', 'is unknown', 'package inaccessible']

const WS = new Set([' ', '\t', '\n', '\r', '\f', '\v'])

/** Mirror Python's `str.split(None, maxsplit)`: split on whitespace runs,
 *  strip leading whitespace, and keep the remainder (incl. its trailing spaces)
 *  once `maxsplit` tokens have been peeled off. */
function pySplit(s: string, maxsplit: number): string[] {
  const out: string[] = []
  let i = 0
  while (true) {
    while (i < s.length && WS.has(s[i])) i++
    if (i >= s.length) break
    if (out.length === maxsplit) {
      out.push(s.slice(i))
      break
    }
    const start = i
    while (i < s.length && !WS.has(s[i])) i++
    out.push(s.slice(start, i))
  }
  return out
}

/**
 * Parse one `ls -lA` line → FileEntry (or null for blanks / a `total` header).
 *
 * toybox long format: `mode nlink owner group size date time name`. The name is
 * everything after the 7th field (so spaces in filenames survive); symlinks show
 * `name -> target`; char/block devices print `major, minor` where the size sits,
 * shifting the name one field right.
 */
export function parseLsLine(line: string): FileEntry | null {
  const trimmed = line.replace(/[\r\n]+$/, '')
  if (!trimmed || trimmed.startsWith('total ')) return null
  const parts = pySplit(trimmed, 7)
  if (parts.length < 8 || parts[0].length < 10) return null
  const mode = parts[0]
  const c = mode[0]
  let name: string
  let size: number | null
  let modified: string
  if (c === 'c' || c === 'b') {
    // device node: "major, minor" occupies the size field, shifting name right.
    const wide = pySplit(trimmed, 8)
    name = wide.length > 8 ? wide[8] : parts[7]
    size = null
    modified = wide.length > 8 ? `${wide[6]} ${wide[7]}` : ''
  } else {
    name = parts[7]
    const n = parseInt(parts[4], 10)
    size = Number.isNaN(n) ? null : n
    modified = `${parts[5]} ${parts[6]}`
  }
  let kind: FileKind
  let linkTarget: string | null = null
  if (c === 'd') {
    kind = 'dir'
  } else if (c === 'l') {
    kind = 'link'
    const arrow = name.indexOf(' -> ')
    if (arrow >= 0) {
      linkTarget = name.slice(arrow + 4)
      name = name.slice(0, arrow)
    }
  } else if (c === '-') {
    kind = 'file'
  } else {
    kind = 'other'
  }
  return { name, kind, size, mode, linkTarget, modified }
}

export interface ListingResult {
  /** null on error; may be empty (= accessible, no entries). */
  entries: FileEntry[] | null
  /** null on success; a sentinel: 'blocked' (run-as refused → try su),
   *  'not found', 'denied', or a raw message. */
  error: string | null
}

/** Turn an `ls -lA` result into `{ entries, error }`. Directories sort first,
 *  then case-insensitively by name. */
export function classifyListing(returncode: number, stdout: string, stderr: string): ListingResult {
  if (returncode === 0) {
    const entries: FileEntry[] = []
    for (const l of stdout.split('\n')) {
      const e = parseLsLine(l)
      if (e) entries.push(e)
    }
    entries.sort((a, b) => {
      const da = a.kind !== 'dir' ? 1 : 0
      const db = b.kind !== 'dir' ? 1 : 0
      if (da !== db) return da - db
      const la = a.name.toLowerCase()
      const lb = b.name.toLowerCase()
      return la < lb ? -1 : la > lb ? 1 : 0
    })
    return { entries, error: null }
  }
  const low = (stderr || '').toLowerCase()
  if (low.includes('no such file') || low.includes('not a directory')) {
    return { entries: null, error: 'not found' }
  }
  if (BLOCKED.some((m) => low.includes(m))) return { entries: null, error: 'blocked' }
  if (low.includes('permission denied') || low.includes('operation not permitted')) {
    return { entries: null, error: 'denied' }
  }
  return { entries: null, error: stderr.trim() || "couldn't list directory" }
}

// --- drawn-icon grouping (mirrors _TINTS / _GROUPS) ---------------------------
export const TINTS: Record<string, string> = {
  img: '#38c793',
  media: '#b06bff',
  archive: '#e3b341',
  code: '#54a0ff'
}

const GROUPS: Record<string, ReadonlySet<string>> = {
  img: new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'ico']),
  media: new Set(['mp4', 'mkv', 'mov', 'avi', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']),
  archive: new Set(['zip', 'apk', 'tar', 'gz', 'rar', '7z', 'xz', 'jar', 'aab']),
  code: new Set([
    'json', 'xml', 'txt', 'log', 'html', 'js', 'java', 'kt', 'py', 'c',
    'h', 'md', 'sh', 'gradle', 'properties', 'cfg', 'yaml', 'yml'
  ])
}

/** The tint group for an extension ('img' | 'media' | 'archive' | 'code'), or null. */
export function extGroup(extension: string): string | null {
  for (const [g, exts] of Object.entries(GROUPS)) {
    if (exts.has(extension)) return g
  }
  return null
}

/** The tint colour for a file entry, or null (folders / links / untyped files). */
export function tintFor(e: FileEntry): string | null {
  if (e.kind !== 'file') return null
  const g = extGroup(ext(e))
  return g ? TINTS[g] : null
}
