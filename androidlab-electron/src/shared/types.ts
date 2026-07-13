/** Shared data types crossing the main <-> renderer IPC boundary. */
import type { PresetValues } from '@core/logtools'
import type { DbValue } from '@core/db'
import type { FileEntry, FileKind } from '@core/files'
import type { NotifItem } from '@core/toolbox'
import type { Pref } from '@core/prefs'
import type { CrashItem } from '@core/crash'
import type { AppDetail, AppInfo } from '@core/appmgr'

export interface Device {
  serial: string
  /** "device", "offline", "unauthorized", ... */
  state: string
  /** model / product info from `adb devices -l` */
  description: string
  online: boolean
  /** "<serial> — <desc> [state]" (mirrors Device.label in adb.py) */
  label: string
}

/** One app entry for the picker. `clone` marks a VA-host clone package. */
export interface AppEntry {
  pkg: string
  clone: boolean
  /** VA host package a clone lives inside (for pulling clone APKs); '' otherwise. */
  host: string
}

export interface AppList {
  apps: AppEntry[]
}

export interface InstallResult {
  ok: boolean
  message: string
  /** Full adb output (expandable detail). */
  output: string
  names: string
}

export interface OpenedLog {
  path: string
  content: string
}

export interface SaveResult {
  ok: boolean
  message: string
  /** Local directory of the saved file, for an "Open Folder" affordance. */
  dir: string
}

export interface InspectResult {
  ok: boolean
  message: string
  /** base64-encoded PNG screenshot (empty on failure). */
  pngBase64: string
  /** raw uiautomator hierarchy XML (empty on failure). */
  xml: string
}

// --- Database Inspector payloads (mirror dbinspect.py's worker signals) -------
/** Result of listing an app's `databases/` dir (DbListWorker.done). */
export interface DbListResult {
  ok: boolean
  dbs: string[]
  message: string
  /** databases were reached via rooted `su` (affects later pull/edit). */
  usedSu: boolean
  /** device has an on-device `sqlite3` binary (needed to edit values). */
  hasSqlite3: boolean
}

/** One table/view of a database (DbOpenWorker tables entry). */
export interface DbTableInfo {
  name: string
  type: 'table' | 'view'
  /** row count, or -1 if it couldn't be counted (e.g. a broken view). */
  count: number
}

/** Result of pulling + introspecting one database (DbOpenWorker.done). */
export interface DbOpenResult {
  ok: boolean
  name: string
  tables: DbTableInfo[]
  message: string
}

/** A page of table rows or a free-form query result (QueryWorker.done). */
export interface DbRowsResult {
  ok: boolean
  cols: string[]
  rows: DbValue[][]
  /** total row count for a table page; -1 for a free query. */
  total: number
  /** a free query hit the row cap. */
  truncated: boolean
  /** per-row rowid for edits (parallel to rows); null = not editable. */
  rowids: Array<number | null> | null
  message: string
}

/** Result of a live on-device cell edit (EditWorker.done). */
export interface DbEditResult {
  ok: boolean
  message: string
}

// --- File Explorer payloads (mirror files.py's worker signals) ----------------
/** Result of listing one directory (DirListWorker.done). */
export interface FilesListResult {
  ok: boolean
  /** the directory actually listed (commits only on success). */
  path: string
  entries: FileEntry[]
  /** empty on success, else a user-facing message. */
  error: string
  /** reached via rooted `su` (run-as was refused and escalated). */
  usedSu: boolean
}

/** One entry to pull, as sent from the renderer (child of the current dir). */
export interface FilesPullItem {
  name: string
  kind: FileKind
}

/** Result of a transfer (PullWorker / PushWorker.done) — SaveResult shape. */
export interface FilesTransferResult {
  ok: boolean
  message: string
  /** local directory of the pulled files (for an "Open Folder" affordance). */
  dir: string
}

/** Result of a mkdir / rename / delete op (FileOpWorker.done). */
export interface FilesOpResult {
  ok: boolean
  message: string
}

/** Result of opening a device file on the Mac (pulled to a temp dir). */
export interface FilesOpenResult {
  ok: boolean
  message: string
  /** local path of the pulled copy to hand to the OS ('' on failure). */
  localPath: string
}

// --- Toolbox payloads (mirror the five toolbox worker signals) ----------------
/** Result of firing one intent (AmWorker.done). */
export interface IntentResult {
  ok: boolean
  /** captured `am` output (am reports bad intents on stdout). */
  output: string
}

/** Result of a notification dump (NotifWorker.done). */
export interface NotifsResult {
  ok: boolean
  message: string
  items: NotifItem[]
}

/** Terminal state of a monkey run (MonkeyWorker.done). */
export interface MonkeyDone {
  ok: boolean
  summary: string
}

/** Terminal state of a perfetto capture (PerfettoWorker.done). */
export interface PerfettoDone {
  ok: boolean
  message: string
  /** local trace path ('' on failure). */
  path: string
  /** local directory (for an "Open Folder" affordance; '' on failure). */
  dir: string
}

/** Terminal state of a bugreport (BugreportWorker.done). */
export interface BugreportDone {
  ok: boolean
  message: string
  /** local directory of the saved zip ('' on failure). */
  dir: string
}

export type LogcatState = 'started' | 'stopped' | 'error'

export type MenuAction =
  | 'open-log'
  | 'export-filtered'
  | 'export-entire'
  | 'about'
  | 'clear-log'
  | 'find'

export type PresetMap = Record<string, PresetValues>

// --- Prefs payloads (Apps ▸ Prefs sub-tab — mirror prefs.py's worker signals) -
/** Result of listing an app's `shared_prefs/` dir (PrefListWorker.done). */
export interface PrefsListResult {
  ok: boolean
  files: string[]
  error: string
  /** reached via rooted `su` (run-as was refused and escalated). */
  usedSu: boolean
}
/** Result of loading + parsing one prefs file (PrefLoadWorker.done). */
export interface PrefsLoadResult {
  ok: boolean
  error: string
  fname: string
  prefs: Pref[]
}
/** Result of writing a prefs file back to the device (PrefSaveWorker.done). */
export interface PrefsSaveResult {
  ok: boolean
  error: string
}

// --- Crash payloads (Apps ▸ Crashes sub-tab — mirror crash.py's worker signals) --
/** Result of a crash scan (CrashScanWorker.done). */
export interface CrashScanResult {
  ok: boolean
  message: string
  items: CrashItem[]
}
/** Result of loading + parsing a mapping.txt (MappingLoadWorker.done). */
export interface MappingLoadResult {
  ok: boolean
  path: string
  /** number of class mappings found (0 => not a usable mapping). */
  classCount: number
  error: string
}

// --- App Manager payloads (Apps tab — mirror appmgr.py's worker signals) ------
/** Result of listing installed apps (AppListWorker.done). */
export interface AppListResult {
  ok: boolean
  apps: AppInfo[]
  error: string
}
/** Result of reading one app's detail (AppDetailWorker.done). */
export interface AppDetailResult {
  ok: boolean
  detail: AppDetail | null
  error: string
}
/** Result of a state-changing app action (AppActionWorker/ClearCache/BulkPerm). */
export interface AppActionResult {
  ok: boolean
  message: string
}
/** Result of fetching an app's real launcher icon (AppIconWorker.done). */
export interface IconResult {
  /** base64 PNG/WebP data URL, or null (adaptive-only / no raster icon). */
  dataUrl: string | null
  /** device has no usable `unzip` — stop requesting icons. */
  unavailable: boolean
}
