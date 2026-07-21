/** The typed surface exposed to the renderer via contextBridge (window.androidlab). */
import type { Sample } from '@core/monitor'
import type { ControlsState } from '@core/controls'
import type {
  AppActionResult,
  AppDetailResult,
  AppList,
  AppListResult,
  AppSettings,
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
  MlkMirrorState,
  MlkCastState,
  MlkCastReceiver,
  MlkScreen,
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
import type { IosInputConfig } from '@core/iosinput'
import type { Pref } from '@core/prefs'
import type { DisplayInfo } from '@core/mirror'
import type { AndroidDeviceInfo } from '@core/deviceinfo'
import type { IosDeviceInfo, IosDeviceRender } from '@core/iosdeviceinfo'
import type { IosNetworkInfo } from '@core/goios'

export type Unsubscribe = () => void

export interface AndroidLabApi {
  adb: {
    find(): Promise<{ path: string | null }>
    listDevices(): Promise<Device[]>
    listApps(serial: string): Promise<AppList>
    resolvePids(serial: string, pkg: string): Promise<number[]>
    forceCrash(serial: string, pkg: string, pids: number[]): Promise<string[]>
    /** Aggregated "About this device" info for the Device Info tab. */
    deviceInfo(serial: string): Promise<AndroidDeviceInfo | null>
    /** Hotplug push: fires with the fresh device list whenever a device is
     *  plugged in or unplugged (USB), so the picker updates without a refresh. */
    onDevicesChanged(cb: (devices: Device[]) => void): Unsubscribe
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
    /** Stop the live feed (a running MP4 recording keeps going). `immediate` tears down
     *  now (a genuine close); the default defers briefly so a popout hand-off can cancel it. */
    stop(immediate?: boolean): Promise<boolean>
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
    /** Popout window: toggle the OS window between fullscreen and windowed. */
    popoutToggleFullscreen(): Promise<void>
    /** Popout window: the OS-window fullscreen state changed (button/Esc/green button). */
    onPopoutFullscreen(cb: (fullscreen: boolean) => void): Unsubscribe
  }
  controls: {
    read(serial: string, pkg: string | null): Promise<{ ok: boolean; message: string; state: ControlsState | null }>
    apply(serial: string, argvs: string[][], label: string): Promise<{ ok: boolean; message: string }>
  }
  wireless: {
    /** Android: flip the current USB device to Wi-Fi adb (tcpip 5555 + connect). */
    enable(serial: string): Promise<{ ok: boolean; message: string; address?: string }>
    /** iOS: read the "Show this device when on Wi-Fi" lockdown state. */
    iosGet(udid: string): Promise<{ ok: boolean; enabled: boolean; message: string }>
    /** iOS: enable/disable Wi-Fi connections; returns the resulting state. */
    iosSet(udid: string, enabled: boolean): Promise<{ ok: boolean; enabled: boolean; message: string }>
  }
  settings: {
    /** Read persisted app settings. */
    get(): Promise<AppSettings>
    /** Merge a partial patch and persist; returns the merged settings. */
    patch(patch: Partial<AppSettings>): Promise<AppSettings>
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
    /** Aggregated device info (lockdown + disk + battery) for the Device Info tab. */
    deviceInfo(udid: string): Promise<IosDeviceInfo>
    /** Detect the device's current Wi-Fi/LAN IP (`ios ip` pcapd sniff; classic-tier,
     *  no tunnel). `ipv4` is '' when idle / off Wi-Fi / not caught in time. */
    deviceIp(udid: string): Promise<IosNetworkInfo | null>
    /** The device-render bundle for `identifier` from the AppleDB CDN (front
     *  photo + enclosure colour for the drawn back), cached per-user; fields are
     *  null when offline / no render exists. */
    deviceImage(identifier: string): Promise<IosDeviceRender>
    listApps(udid: string): Promise<IosAppListResult>
    /** One app's home-screen icon (masked PNG from com.apple.springboardservices,
     *  classic-tier). `dataUrl` is null when unavailable; the caller keeps its
     *  drawn-tile placeholder. */
    appIcon(udid: string, bundleId: string): Promise<IconResult>
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
  /** iOS screen mirror (macOS, view-only). Two feeds share one WebCodecs decoder:
   *  'usb' — a native AVFoundation+VideoToolbox helper streams H.264 off the
   *  CoreMediaIO "iOS Device" screen (the QuickTime path); 'airplay' — the device
   *  AirPlay-mirrors over Wi-Fi to a bundled receiver. USB is the default. */
  iosMirror: {
    /** Begin a feed. `mode` 'usb' (default, needs the cabled `udid`) or 'airplay'
     *  (Wi-Fi; the user picks "MobileLabKit" in Control Center on the phone).
     *  `resolution` (AirPlay only) sets the advertised display size the phone mirrors
     *  at — larger is sharper. Ignored on the USB path (always native resolution). */
    start(
      udid: string,
      mode?: 'usb' | 'airplay',
      resolution?: { width: number; height: number }
    ): Promise<boolean>
    /** Stop the feed + kill the capture helper. `immediate` tears down now (a genuine
     *  close); the default defers briefly so a dock<->popout hand-off can cancel it. */
    stop(immediate?: boolean): Promise<boolean>
    /** Save a PNG the renderer grabbed from the mirror canvas to ~/Downloads. */
    saveFrame(pngBase64: string): Promise<SaveResult>
    /** Mute/unmute the device audio the helper plays on this Mac. Returns the
     *  effective preference (kept in main, so it survives dock<->popout remounts). */
    setMuted(muted: boolean): Promise<boolean>
    /** Read the current mute preference (for a freshly mounted mirror view). */
    getMuted(): Promise<boolean>
    onH264(cb: (chunk: Uint8Array) => void): Unsubscribe
    onState(cb: (state: IosMirrorState) => void): Unsubscribe
    onFailed(cb: (message: string) => void): Unsubscribe
  }
  /** Android→Mac screen mirror RECEIVER. The Mac advertises `_mlkmirror._tcp` over mDNS
   *  and listens on TCP; the MobileLabKit Mirror Android app casts its screen (+ audio)
   *  to it. View-only (screen + audio), phone-initiated — same model as the AirPlay
   *  receiver but for Android → this Mac. */
  mlkMirror: {
    /** Start advertising + listening. Resolves with the receiver name the phone will
     *  see in its Cast list (e.g. "Penguin's MacBook Pro (Mirror)"), or null on failure. */
    start(): Promise<string | null>
    /** Stop advertising + close any active stream. */
    stop(): Promise<boolean>
    onH264(cb: (chunk: Uint8Array) => void): Unsubscribe
    /** Raw 48kHz stereo 16-bit interleaved PCM audio from the casting phone. */
    onPcm(cb: (chunk: Uint8Array) => void): Unsubscribe
    onState(cb: (state: MlkMirrorState) => void): Unsubscribe
    onFailed(cb: (message: string) => void): Unsubscribe
  }
  /** Mac→Android cast SENDER: capture this Mac's screen, H.264-encode in-page with
   *  WebCodecs, and stream it to the MobileLabKit Mirror Android app (in Receive mode)
   *  over the same _mlkmirror._tcp wire protocol. Video-only. */
  mlkCast: {
    /** Discover phones in "Receive a screen" mode over mDNS. The callback fires with the
     *  current list as receivers appear; the returned Unsubscribe stops the browse. */
    browse(cb: (receivers: MlkCastReceiver[]) => void): Unsubscribe
    /** Capturable displays with a preview thumbnail (data URL) — for the screen picker. */
    getScreens(): Promise<MlkScreen[]>
    /** Choose which display getDisplayMedia captures next (by id); null = primary. */
    setSource(id: string | null): Promise<boolean>
    /** Connect to a receiver at host:port and send the stream header. True on success. */
    connect(host: string, port: number, width: number, height: number): Promise<boolean>
    /** Push one Annex-B chunk from the encoder; `key` marks a keyframe. Fire-and-forget. */
    push(chunk: Uint8Array, key: boolean): void
    /** Stop casting + close the socket. */
    stop(): Promise<boolean>
    onState(cb: (state: MlkCastState) => void): Unsubscribe
    onFailed(cb: (message: string) => void): Unsubscribe
  }
  /** Android Auto head unit (Android). The Mac runs the AA GAL protocol as a wireless
   *  head-unit server and triggers the selected phone (via a hidden gearhead broadcast) to
   *  project its car UI to us over Wi-Fi. Interactive: touches forward to the phone.
   *  Prereqs: phone + Mac on the same Wi-Fi; Android Auto developer mode on. */
  androidAuto: {
    /** Start the head-unit server for `serial` and trigger AA to connect. */
    start(serial: string): Promise<{ ok: boolean; message: string }>
    /** Stop projecting + kill the helper. */
    stop(): Promise<boolean>
    /** Forward a touch (device coordinates; action = AA PointerAction: 0=down,1=up,2=move). */
    touch(action: number, x: number, y: number): Promise<boolean>
    /** Feed captured mic PCM (16-bit mono 16kHz) to the phone for Assistant/voice. */
    micData(bytes: Uint8Array): Promise<boolean>
    onH264(cb: (chunk: Uint8Array) => void): Unsubscribe
    /** 16-bit PCM audio for an AA channel (rate/channels per the advertised sink). */
    onPcm(cb: (channel: number, rate: number, channels: number, chunk: Uint8Array) => void): Unsubscribe
    /** The phone opened (true) or closed (false) the mic — start/stop local capture. */
    onMicOpen(cb: (open: boolean) => void): Unsubscribe
    onStatus(cb: (message: string) => void): Unsubscribe
    onStreaming(cb: () => void): Unsubscribe
    onEnded(cb: (reason: string) => void): Unsubscribe
    onFailed(cb: (message: string) => void): Unsubscribe
  }
  /** iOS touch/keyboard forwarding (macOS, go-ios). View-only until the user supplies
   *  an App Store Connect signing identity and an on-device agent (WDA/DeviceKit) is
   *  provisioned + installed. Then mouse/keyboard map to `ui tap/swipe/type`. */
  iosInput: {
    /** Persisted signing config (method + cert/profile or ASC key paths + agent). */
    getConfig(): Promise<IosInputConfig>
    /** Save config (identifiers + file paths only — never key bytes or the P12 password). */
    setConfig(cfg: Partial<IosInputConfig>): Promise<IosInputConfig>
    /** Pick a signing asset file (.p8 / .p12 / .mobileprovision); returns its path. */
    chooseFile(kind: 'p8' | 'p12' | 'profile'): Promise<string | null>
    /** Sign + install the agent (manual P12+profile, or ASC → P12+profile first) then
     *  verify; progress via onProgress. Takes the live config so the P12 password is
     *  passed through, never persisted. */
    provision(udid: string, cfg: IosInputConfig): Promise<{ ok: boolean; message: string }>
    /** Cancel a running provision. */
    cancel(): Promise<boolean>
    /** Is the agent installed + reachable (tunnel + `ui status`)? */
    status(udid: string): Promise<boolean>
    /** Device size in the points `tap`/`swipe` expect (for canvas → device mapping). */
    size(udid: string): Promise<{ width: number; height: number } | null>
    tap(udid: string, x: number, y: number): Promise<boolean>
    swipe(udid: string, x1: number, y1: number, x2: number, y2: number, durationSec?: number): Promise<boolean>
    /** Replay a full captured finger path (device points + ms timestamps) as ONE gesture —
     *  DeviceKit via `device.io.gesture`, WebDriverAgent via a multi-waypoint W3C `/actions`
     *  sequence (`pathToPointerActions`). Available as an alternative "replay on release" drag;
     *  the mirror itself uses the hybrid `drag` (live tracking + momentum flick) below. */
    gesture(udid: string, points: Array<{ x: number; y: number; t: number }>): Promise<boolean>
    /** The mirror's HYBRID drag. `start` at press, `move` as the finger moves (streams short
     *  swipe segments so content tracks live — coarse ~2-3 steps/sec, the XCTest floor), `end`
     *  on release. Pass `flick` on `end` (a velocity-projected target + duration) to append a
     *  momentum swipe from the release point so a flick keeps scrolling. iOS can't stream touch,
     *  so live tracking is choppy; the flick is what makes it feel smooth. */
    drag(
      udid: string,
      phase: 'start' | 'move' | 'end',
      x: number,
      y: number,
      flick?: { x: number; y: number; durMs: number }
    ): Promise<boolean>
    type(udid: string, text: string): Promise<boolean>
    /** Forward one physical keystroke live. `domKey` is a DOM KeyboardEvent.key (a char, or
     *  'Enter'/'Backspace'/'ArrowUp'/…); `modifiers` are held (command/control/option/shift/fn).
     *  Special keys + ⌘/⌃ combos work on DeviceKit; WDA fallback handles plain keys. */
    key(udid: string, domKey: string, modifiers: string[]): Promise<boolean>
    /** Press a device button. `home` → homescreen; `appswitcher`/`history`/`recents`
     *  → the App Switcher (emulated swipe-up-and-hold); anything else → WDA pressButton
     *  (e.g. `volumeUp`/`volumeDown`). */
    button(udid: string, name: string): Promise<boolean>
    onProgress(cb: (line: string) => void): Unsubscribe
    onDone(cb: (result: { ok: boolean; message: string }) => void): Unsubscribe
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
