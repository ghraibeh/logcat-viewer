/** Shared data types crossing the main <-> renderer IPC boundary. */
import type { PresetValues } from '@core/logtools'
import type { DbValue } from '@core/db'
import type { FileEntry, FileKind } from '@core/files'
import type { NotifItem } from '@core/toolbox'
import type { Pref } from '@core/prefs'
import type { CrashItem } from '@core/crash'
import type { AppDetail, AppInfo } from '@core/appmgr'
import type { IosAppInfo, IosProcess } from '@core/goios'
import type { DisplayFlow } from '@core/intercept'

/** Which backend a device is reached through: Android via adb, iOS via go-ios. */
export type Platform = 'android' | 'ios'

/** A transport a device is reachable over. iOS: usbmux USB vs Wi-Fi (Network)
 *  entry. Android: USB vs wireless-adb (ip:port serial). A device can expose
 *  more than one at once — the picker lists each so the user can choose. */
export type Transport = 'usb' | 'wifi'

export interface Device {
  /** adb serial (Android) or device UDID (iOS). */
  serial: string
  /** "device", "offline", "unauthorized", ... (always "device" for iOS). */
  state: string
  /** model / product info from `adb devices -l`, or "<model> · iOS <ver>". */
  description: string
  online: boolean
  /** "<serial> — <desc> [state]" (mirrors Device.label in adb.py). */
  label: string
  /** The backend this device talks to; drives per-platform feature gating. */
  platform: Platform
  /** Every transport this device is currently reachable over (>=1). A device
   *  visible over both cable and Wi-Fi lists both, so the picker can show a
   *  sub-entry per transport and let the user pick. */
  transports: Transport[]
}

/** Persisted app settings (see main/services/settings.ts). */
export interface AppSettings {
  /** Auto-enable iOS "Show this device when on Wi-Fi" the moment a device
   *  attaches over USB, so unplugging leaves it connected wirelessly. */
  autoWifi: boolean
  /** UDIDs the user explicitly turned Wi-Fi off for in the dialog — never
   *  auto-re-enable these even while autoWifi is on. */
  wifiOptOut: string[]
  /** Bring the iOS developer tunnel up automatically as soon as a device is
   *  connected (USB or Wi-Fi), so dev-tier features are ready without the user
   *  enabling it. Default on. */
  autoTunnel: boolean
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

/** A mirror feed failed; `kind` lets the renderer fall back (h264 → poller). */
export interface MirrorFailed {
  kind: 'h264' | 'poller'
  message: string
}

/** State of the iOS mirror (macOS). Two feeds, same H.264 → WebCodecs decoder:
 *  - 'h264'    : USB. Native AVFoundation + VideoToolbox helper streams H.264 off the
 *               CoreMediaIO "iOS Device" screen (the QuickTime path) — low latency,
 *               plus touch forwarding.
 *  - 'airplay' : Wi-Fi. The device AirPlay-mirrors to our bundled receiver (RPiPlay
 *               core); view-only, phone-initiated. `waiting` is true until the phone
 *               picks us in Control Center ▸ Screen Mirroring and frames arrive. */
export interface IosMirrorState {
  mode: 'h264' | 'airplay'
  message: string
  waiting?: boolean
}

/** State for the Android→Mac mirror receiver (the private _mlkmirror._tcp service).
 *  `name` is the mDNS name this Mac advertises (e.g. "Penguin's MacBook Pro (Mirror)")
 *  — shown so the user knows what to pick in the phone's Cast list. `waiting` is true
 *  until a phone connects and frames arrive. */
export interface MlkMirrorState {
  name: string
  message: string
  waiting?: boolean
}

/** Which device the detached mirror window should mirror. The main window pushes
 *  this to the popout on open and whenever the selected device changes, so the
 *  standalone window (Android Studio-style) always tracks the active device. */
export interface MirrorPopoutInfo {
  serial: string | null
  platform: Platform
  /** iOS transport, so the detached mirror defaults to the same feed path (AirPlay
   *  for a Wi-Fi-only device) as the docked view. */
  connection?: 'usb' | 'wifi'
  /** Standalone AirPlay-receiver mode (top-bar toggle) — the popped window mirrors
   *  any phone that picks "MobileLabKit", independent of the selected device. */
  receiver?: boolean
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

// --- Mock GPS location payload (mirrors mocklocation.py's worker signals) -----
/** Result of a helper setup / set / stop op (MockSetupWorker.done shape). */
export interface MockResult {
  ok: boolean
  message: string
}

// --- Memory-leak detection payload (mirrors leakdetect.py's LeakDetectWorker) -
/** Terminal state of a leak-detection run (LeakDetectWorker.done). */
export interface LeakDone {
  ok: boolean
  /** Shark's text report on success, else a user-facing error message. */
  report: string
  /** local path of the pulled .hprof ('' if capture never got that far). */
  hprofPath: string
  /** the package that was analyzed (for the report header + save filename). */
  pkg: string
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
// --- iOS App Manager payload (Apps tab, go-ios backend) -----------------------
/** Result of listing an iOS device's installed apps (`ios apps --all`). */
export interface IosAppListResult {
  ok: boolean
  apps: IosAppInfo[]
  error: string
}

/** State of the iOS-17+ developer (userspace) tunnel launch/ps/kill ride on. */
export interface TunnelStatus {
  ready: boolean
}

/** Result of listing running processes via `ios ps` (developer tunnel). */
export interface IosProcessListResult {
  ok: boolean
  processes: IosProcess[]
  error: string
}

/** Result of fetching an app's real launcher icon (AppIconWorker.done). */
export interface IconResult {
  /** base64 PNG/WebP data URL, or null (adaptive-only / no raster icon). */
  dataUrl: string | null
  /** device has no usable `unzip` — stop requesting icons. */
  unavailable: boolean
}

// --- Network Intercept payloads (mirror intercept.py's worker signals) --------
/** Batched display flows streamed from the proxy engine (intercept:flows). */
export type FlowBatch = DisplayFlow[]

/** Decoded request/response detail for the pane (main decodes via zlib). */
export interface FlowDetail {
  found: boolean
  url: string
  method: string
  scheme: string
  status: number | null
  durationMs: number | null
  respSize: number
  bodyCaptured: boolean
  note: string
  reqHeaders: Array<[string, string]>
  respHeaders: Array<[string, string]>
  reqBody: string
  respBody: string
  reqIsJson: boolean
  respIsJson: boolean
  curl: string
}

/** Result of pushing the CA cert to the device (SaveResult-shaped, dir=on-device). */
export interface CertResult {
  ok: boolean
  message: string
  dir: string
}
