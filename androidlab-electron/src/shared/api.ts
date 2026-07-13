/** The typed surface exposed to the renderer via contextBridge (window.androidlab). */
import type { Sample } from '@core/monitor'
import type { ControlsState } from '@core/controls'
import type {
  AppActionResult,
  AppDetailResult,
  AppList,
  AppListResult,
  BugreportDone,
  CrashScanResult,
  DbEditResult,
  DbListResult,
  DbOpenResult,
  DbRowsResult,
  Device,
  FilesListResult,
  FilesOpResult,
  FilesOpenResult,
  FilesPullItem,
  FilesTransferResult,
  IconResult,
  InspectResult,
  InstallResult,
  IntentResult,
  LogcatState,
  MappingLoadResult,
  MenuAction,
  MirrorFailed,
  MockResult,
  MonkeyDone,
  NotifsResult,
  OpenedLog,
  PerfettoDone,
  PrefsListResult,
  PrefsLoadResult,
  PrefsSaveResult,
  PresetMap,
  SaveResult
} from './types'
import type { FileKind } from '@core/files'
import type { IntentSpec } from '@core/toolbox'
import type { Pref } from '@core/prefs'
import type { DisplayInfo } from '@core/mirror'

export type Unsubscribe = () => void

export interface AndroidLabApi {
  adb: {
    find(): Promise<{ path: string | null }>
    listDevices(): Promise<Device[]>
    listApps(serial: string): Promise<AppList>
    resolvePids(serial: string, pkg: string): Promise<number[]>
    forceCrash(serial: string, pkg: string, pids: number[]): Promise<string[]>
  }
  logcat: {
    start(serial: string, clearFirst: boolean): Promise<boolean>
    stop(): Promise<boolean>
    running(): Promise<boolean>
    onLines(cb: (lines: string[]) => void): Unsubscribe
    onState(cb: (state: LogcatState) => void): Unsubscribe
    onError(cb: (message: string) => void): Unsubscribe
  }
  shell: {
    /** Open an interactive PTY sized to the terminal: the device's `adb shell`
     *  ('device') or this Mac's login shell ('local'). serial is ignored for local. */
    start(kind: 'device' | 'local', serial: string, cols: number, rows: number): Promise<boolean>
    /** Forward raw keystrokes (incl. Ctrl-C, arrows) to the shell's pty. */
    write(data: string): Promise<boolean>
    /** Resize the remote pty when the terminal is resized. */
    resize(cols: number, rows: number): Promise<boolean>
    stop(): Promise<boolean>
    running(): Promise<boolean>
    /** Raw pty output (ANSI included) from the shell. */
    onData(cb: (data: string) => void): Unsubscribe
    onState(cb: (state: LogcatState) => void): Unsubscribe
  }
  monitor: {
    start(serial: string, pkg: string | null, intervalMs: number): Promise<boolean>
    stop(): Promise<boolean>
    onSample(cb: (sample: Sample) => void): Unsubscribe
    onFailed(cb: (message: string) => void): Unsubscribe
  }
  inspect: {
    capture(serial: string): Promise<InspectResult>
  }
  mirror: {
    /** Start the low-latency H.264 feed (raw bytes arrive via onH264). */
    startH264(serial: string): Promise<boolean>
    /** Start the screencap PNG poller (fallback / secondary displays). */
    startPoller(serial: string, displayId: string | null): Promise<boolean>
    /** Stop the live feed (a running MP4 recording keeps going). */
    stop(): Promise<boolean>
    /** One-shot `input` (tap/swipe/keyevent/text), routed to `logicalId` if set. */
    input(serial: string, logicalId: number | null, args: string[]): Promise<void>
    /** Save a full-res PNG to ~/Downloads. */
    screenshot(serial: string, displayId: string | null, logicalId: number | null): Promise<SaveResult>
    recordStart(serial: string): Promise<boolean>
    recordStop(): Promise<boolean>
    listDisplays(serial: string): Promise<DisplayInfo[]>
    /** True if the device is an emulator (slow screenrecord → default to preview). */
    isEmulator(serial: string): Promise<boolean>
    scrcpyAvailable(): Promise<boolean>
    launchScrcpy(serial: string, logicalId: number | null): Promise<void>
    onFrame(cb: (base64: string) => void): Unsubscribe
    onH264(cb: (chunk: Uint8Array) => void): Unsubscribe
    onFailed(cb: (failed: MirrorFailed) => void): Unsubscribe
    onRecordDone(cb: (result: SaveResult) => void): Unsubscribe
  }
  controls: {
    read(serial: string, pkg: string | null): Promise<{ ok: boolean; message: string; state: ControlsState | null }>
    apply(serial: string, argvs: string[][], label: string): Promise<{ ok: boolean; message: string }>
  }
  mockloc: {
    /** Install the helper APK if absent + grant the mock-location app-op. */
    setup(serial: string): Promise<MockResult>
    /** Start/update the mock at lat,lng (acc metres, optional altitude). */
    set(serial: string, lat: number, lng: number, acc?: number, alt?: number): Promise<MockResult>
    /** Stop mocking + tear down the providers (device reacquires a real fix). */
    stop(serial: string): Promise<MockResult>
  }
  db: {
    list(serial: string, pkg: string): Promise<DbListResult>
    open(serial: string, pkg: string, name: string, force: boolean): Promise<DbOpenResult>
    readTable(
      serial: string,
      pkg: string,
      name: string,
      table: string,
      limit: number,
      offset: number
    ): Promise<DbRowsResult>
    query(serial: string, pkg: string, name: string, sql: string): Promise<DbRowsResult>
    edit(
      serial: string,
      pkg: string,
      name: string,
      table: string,
      col: string,
      rowid: number,
      value: string | null,
      setNull: boolean
    ): Promise<DbEditResult>
    export(serial: string, pkg: string, name: string, suggested: string): Promise<SaveResult>
    exportCsv(text: string, suggested: string, rowCount: number): Promise<SaveResult>
  }
  files: {
    list(serial: string, path: string, pkg: string | null, rootMode: boolean): Promise<FilesListResult>
    pull(
      serial: string,
      path: string,
      pkg: string | null,
      rootMode: boolean,
      items: FilesPullItem[],
      destDir: string
    ): Promise<FilesTransferResult>
    push(
      serial: string,
      path: string,
      pkg: string | null,
      rootMode: boolean,
      sources: string[]
    ): Promise<FilesTransferResult>
    mkdir(serial: string, path: string, pkg: string | null, rootMode: boolean, name: string): Promise<FilesOpResult>
    rename(
      serial: string,
      path: string,
      pkg: string | null,
      rootMode: boolean,
      oldName: string,
      newName: string
    ): Promise<FilesOpResult>
    delete(
      serial: string,
      path: string,
      pkg: string | null,
      rootMode: boolean,
      names: string[]
    ): Promise<FilesOpResult>
    open(
      serial: string,
      path: string,
      pkg: string | null,
      rootMode: boolean,
      name: string,
      kind: FileKind
    ): Promise<FilesOpenResult>
    choosePullDir(): Promise<string | null>
    choosePush(): Promise<string[]>
    /** Resolve the on-disk path of a File dropped from Finder (Electron webUtils). */
    pathForFile(file: File): string
  }
  apk: {
    choose(): Promise<string[]>
    install(serial: string, paths: string[]): Promise<InstallResult>
  }
  logfile: {
    open(): Promise<OpenedLog | null>
    export(kind: 'filtered' | 'full', text: string, count: number): Promise<SaveResult>
  }
  presets: {
    load(): Promise<PresetMap>
    save(map: PresetMap): Promise<boolean>
  }
  toolbox: {
    runIntent(serial: string, spec: IntentSpec): Promise<IntentResult>
    listNotifs(serial: string): Promise<NotifsResult>
    monkeyStart(
      serial: string,
      pkg: string,
      events: number,
      seed: number,
      throttleMs: number
    ): Promise<boolean>
    monkeyStop(): Promise<boolean>
    onMonkeyLine(cb: (line: string) => void): Unsubscribe
    onMonkeyDone(cb: (done: MonkeyDone) => void): Unsubscribe
    perfettoStart(serial: string, durationS: number, categories: string[]): Promise<boolean>
    perfettoCancel(): Promise<boolean>
    onPerfettoProgress(cb: (message: string) => void): Unsubscribe
    onPerfettoDone(cb: (done: PerfettoDone) => void): Unsubscribe
    bugreportStart(serial: string): Promise<boolean>
    bugreportCancel(): Promise<boolean>
    onBugreportProgress(cb: (pct: number) => void): Unsubscribe
    onBugreportDone(cb: (done: BugreportDone) => void): Unsubscribe
  }
  prefs: {
    list(serial: string, pkg: string): Promise<PrefsListResult>
    load(serial: string, pkg: string, fname: string): Promise<PrefsLoadResult>
    save(serial: string, pkg: string, fname: string, prefs: Pref[]): Promise<PrefsSaveResult>
    forceStop(serial: string, pkg: string): Promise<boolean>
  }
  crash: {
    scan(serial: string): Promise<CrashScanResult>
    retrace(text: string): Promise<string>
    loadMapping(path: string): Promise<MappingLoadResult>
    chooseMapping(): Promise<string | null>
    lastMappingPath(): Promise<string>
    save(text: string, suggested: string): Promise<SaveResult>
  }
  appmgr: {
    list(serial: string): Promise<AppListResult>
    detail(serial: string, pkg: string, apkPath: string): Promise<AppDetailResult>
    action(serial: string, argv: string[], okMsg: string): Promise<AppActionResult>
    clearCache(serial: string, pkg: string): Promise<AppActionResult>
    bulkPerms(serial: string, pkg: string, perms: string[], grant: boolean): Promise<AppActionResult>
    icon(serial: string, pkg: string, apkPath: string): Promise<IconResult>
    extractApk(serial: string, pkg: string): Promise<SaveResult>
  }
  system: {
    openPath(p: string): Promise<void>
    platform: NodeJS.Platform
  }
  menu: {
    onAction(cb: (action: MenuAction) => void): Unsubscribe
  }
}
