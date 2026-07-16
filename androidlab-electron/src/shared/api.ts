/** The typed surface exposed to the renderer via contextBridge (window.androidlab). */
import type { Sample } from '@core/monitor'
import type { ControlsState } from '@core/controls'
import type {
  AppActionResult,
  AppDetailResult,
  AppList,
  AppListResult,
  BugreportDone,
  CertResult,
  CrashScanResult,
  FlowBatch,
  FlowDetail,
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
  IosAppListResult,
  IosMirrorState,
  IosProcessListResult,
  LeakDone,
  LogcatState,
  MappingLoadResult,
  MenuAction,
  MirrorFailed,
  MirrorPopoutInfo,
  MockResult,
  MonkeyDone,
  NotifsResult,
  OpenedLog,
  PerfettoDone,
  PrefsListResult,
  PrefsLoadResult,
  PrefsSaveResult,
  PresetMap,
  SaveResult,
  TunnelStatus
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
    /** Open an interactive PTY sized to the terminal, scoped to a tab `id`: the
     *  device's `adb shell` ('device') or this Mac's login shell ('local').
     *  serial is ignored for local. Multiple ids run concurrently. */
    start(id: string, kind: 'device' | 'local', serial: string, cols: number, rows: number): Promise<boolean>
    /** Forward raw keystrokes (incl. Ctrl-C, arrows) to the tab's pty. */
    write(id: string, data: string): Promise<boolean>
    /** Resize the tab's remote pty when its terminal is resized. */
    resize(id: string, cols: number, rows: number): Promise<boolean>
    stop(id: string): Promise<boolean>
    running(id: string): Promise<boolean>
    /** Raw pty output (ANSI included), tagged with the originating tab `id`. */
    onData(cb: (id: string, data: string) => void): Unsubscribe
    onState(cb: (id: string, state: LogcatState) => void): Unsubscribe
  }
  monitor: {
    start(serial: string, pkg: string | null, intervalMs: number): Promise<boolean>
    stop(): Promise<boolean>
    onSample(cb: (sample: Sample) => void): Unsubscribe
    onFailed(cb: (message: string) => void): Unsubscribe
  }
  leak: {
    /** Capture a debuggable app's heap + analyze it with Shark. Progress and
     *  the terminal report arrive via onProgress / onDone. */
    start(serial: string, pkg: string): Promise<boolean>
    /** Cancel a running detection (kills the on-device dump / local analyzer). */
    cancel(): Promise<boolean>
    /** Save the visual report as a self-contained HTML file (save dialog). */
    saveReport(html: string, pkg: string): Promise<SaveResult>
    onProgress(cb: (message: string) => void): Unsubscribe
    onDone(cb: (done: LeakDone) => void): Unsubscribe
  }
  inspect: {
    capture(serial: string): Promise<InspectResult>
  }
  mirror: {
    /** Start the raw screenrecord H.264 feed (bytes arrive via onH264). */
    startH264(serial: string): Promise<boolean>
    /** Start the scrcpy-server feed — raw Annex-B via onH264 (same demuxer as
     *  screenrecord); falls back to the screenrecord H.264 loop if the jar is absent. */
    startScrcpy(serial: string): Promise<boolean>
    /** Start the screencap PNG poller (fallback / secondary displays). */
    startPoller(serial: string, displayId: string | null): Promise<boolean>
    /** Stop the live feed (a running MP4 recording keeps going). */
    stop(): Promise<boolean>
    /** One-shot `input` (tap/swipe/keyevent/text), routed to `logicalId` if set. */
    input(serial: string, logicalId: number | null, args: string[]): Promise<void>
    /** Inject a pre-encoded scrcpy control message (touch/key/text) over the control
     *  socket — no-op unless scrcpy control is active (see onControlReady). */
    control(data: Uint8Array): Promise<void>
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
    /** scrcpy control channel became available (true) or went away (false). */
    onControlReady(cb: (ready: boolean) => void): Unsubscribe
    onFailed(cb: (failed: MirrorFailed) => void): Unsubscribe
    onRecordDone(cb: (result: SaveResult) => void): Unsubscribe
    // --- detached mirror window (Android Studio-style pop-out) ---
    /** Detach the mirror into its own OS window for the given device. */
    openPopout(info: MirrorPopoutInfo): Promise<void>
    /** Close the popout window; `redock` re-attaches it as the in-app dock. */
    closePopout(redock: boolean): Promise<void>
    /** Push the currently-selected device to an open popout window. */
    updatePopout(info: MirrorPopoutInfo): Promise<void>
    /** Popout window: read which device it should mirror (on first mount). */
    popoutInfo(): Promise<MirrorPopoutInfo>
    /** Popout window: the main window switched device. */
    onPopoutInfo(cb: (info: MirrorPopoutInfo) => void): Unsubscribe
    /** Main window: the popout was closed — re-dock the mirror. */
    onPopoutClosed(cb: () => void): Unsubscribe
  }
  controls: {
    read(serial: string, pkg: string | null): Promise<{ ok: boolean; message: string; state: ControlsState | null }>
    apply(serial: string, argvs: string[][], label: string): Promise<{ ok: boolean; message: string }>
  }
  wireless: {
    /** Flip the current USB device to Wi-Fi: tcpip 5555 + connect to its wlan IP. */
    enable(serial: string): Promise<{ ok: boolean; message: string; address?: string }>
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
  /** iOS Apps tab (go-ios backend). `udid` is the device serial. */
  ios: {
    listApps(udid: string): Promise<IosAppListResult>
    /** Open a file dialog for a signed .ipa; returns its path or null. */
    chooseIpa(): Promise<string | null>
    install(udid: string, ipaPath: string): Promise<AppActionResult>
    uninstall(udid: string, bundleId: string): Promise<AppActionResult>
    // Developer tier (iOS-17+ userspace tunnel — no sudo).
    /** Is the developer tunnel currently active for this device? */
    tunnelStatus(udid: string): Promise<TunnelStatus>
    /** Bring the userspace tunnel up (spawns + waits); auto-invoked by launch/kill/processes too. */
    tunnelStart(udid: string): Promise<AppActionResult>
    /** Tear the managed tunnel down. */
    tunnelStop(): Promise<boolean>
    /** Running processes (`ios ps`); `appsOnly` filters to applications. */
    processes(udid: string, appsOnly: boolean): Promise<IosProcessListResult>
    /** Launch an app by bundle id. */
    launch(udid: string, bundleId: string): Promise<AppActionResult>
    /** Force-quit an app by bundle id. */
    kill(udid: string, bundleId: string): Promise<AppActionResult>
  }
  /** iOS screen mirror (macOS, view-only). A native AVFoundation+VideoToolbox
   *  helper streams H.264 off the CoreMediaIO "iOS Device" screen (the QuickTime
   *  path); the renderer decodes it with WebCodecs — the Android mirror pipeline. */
  iosMirror: {
    /** Begin the H.264 feed for `udid`. */
    start(udid: string): Promise<boolean>
    /** Stop the feed + kill the capture helper. */
    stop(): Promise<boolean>
    /** Save a PNG the renderer grabbed from the mirror canvas to ~/Downloads. */
    saveFrame(pngBase64: string): Promise<SaveResult>
    onH264(cb: (chunk: Uint8Array) => void): Unsubscribe
    onState(cb: (state: IosMirrorState) => void): Unsubscribe
    onFailed(cb: (message: string) => void): Unsubscribe
  }
  intercept: {
    /** Wire the device + bind the proxy; result arrives via onStarted/onFailed. */
    start(serial: string, port: number, decrypt: boolean): Promise<boolean>
    /** Stop capture + restore the device proxy + drop the reverse tunnel. */
    stop(): Promise<boolean>
    /** Toggle HTTPS decryption on the running session. */
    setDecrypt(on: boolean): Promise<boolean>
    /** Push the CA cert to the device + open Security settings. */
    installCert(serial: string): Promise<CertResult>
    /** Decoded request/response detail for one flow (by id). */
    detail(id: number): Promise<FlowDetail>
    /** Save a flow's (decoded) response body to a file (save dialog). */
    saveBody(id: number): Promise<SaveResult>
    /** Save a full request+response dump of a flow (save dialog). */
    downloadFlow(id: number): Promise<SaveResult>
    onFlows(cb: (flows: FlowBatch) => void): Unsubscribe
    onStarted(cb: (port: number) => void): Unsubscribe
    onStatus(cb: (message: string) => void): Unsubscribe
    onFailed(cb: (message: string) => void): Unsubscribe
  }
  system: {
    openPath(p: string): Promise<void>
    platform: NodeJS.Platform
  }
  menu: {
    onAction(cb: (action: MenuAction) => void): Unsubscribe
  }
}
