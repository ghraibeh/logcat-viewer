/**
 * Preload: the only bridge between the sandboxed renderer and the main process.
 * Exposes a typed, minimal API over contextBridge — no ipcRenderer, no Node
 * primitives leak into the page (contextIsolation + sandbox stay intact).
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type { AndroidLabApi, Unsubscribe } from '@shared/api'
import type {
  BugreportDone,
  FlowBatch,
  IosMirrorState,
  LeakDone,
  LogcatState,
  MenuAction,
  MirrorFailed,
  MirrorPopoutInfo,
  MonkeyDone,
  PerfettoDone,
  PresetMap,
  SaveResult
} from '@shared/types'
import type { Sample } from '@core/monitor'
import type { IntentSpec } from '@core/toolbox'

function subscribe<A extends unknown[]>(
  channel: string,
  cb: (...args: A) => void
): Unsubscribe {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: AndroidLabApi = {
  adb: {
    find: () => ipcRenderer.invoke(IPC.adbFind),
    listDevices: () => ipcRenderer.invoke(IPC.adbListDevices),
    listApps: (serial) => ipcRenderer.invoke(IPC.adbListApps, serial),
    resolvePids: (serial, pkg) => ipcRenderer.invoke(IPC.adbResolvePids, serial, pkg),
    forceCrash: (serial, pkg, pids) => ipcRenderer.invoke(IPC.adbForceCrash, serial, pkg, pids),
    deviceInfo: (serial) => ipcRenderer.invoke(IPC.adbDeviceInfo, serial)
  },
  logcat: {
    start: (serial, clearFirst) => ipcRenderer.invoke(IPC.logcatStart, serial, clearFirst),
    stop: () => ipcRenderer.invoke(IPC.logcatStop),
    running: () => ipcRenderer.invoke(IPC.logcatRunning),
    onLines: (cb) => subscribe<[string[]]>(IPC.logcatLines, cb),
    onState: (cb) => subscribe<[LogcatState]>(IPC.logcatState, cb),
    onError: (cb) => subscribe<[string]>(IPC.logcatError, cb)
  },
  shell: {
    start: (id, kind, serial, cols, rows) =>
      ipcRenderer.invoke(IPC.shellStart, id, kind, serial, cols, rows),
    write: (id, data) => ipcRenderer.invoke(IPC.shellWrite, id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke(IPC.shellResize, id, cols, rows),
    stop: (id) => ipcRenderer.invoke(IPC.shellStop, id),
    running: (id) => ipcRenderer.invoke(IPC.shellRunning, id),
    onData: (cb) => subscribe<[string, string]>(IPC.shellData, cb),
    onState: (cb) => subscribe<[string, LogcatState]>(IPC.shellState, cb)
  },
  monitor: {
    start: (serial, pkg, intervalMs) => ipcRenderer.invoke(IPC.monitorStart, serial, pkg, intervalMs),
    stop: () => ipcRenderer.invoke(IPC.monitorStop),
    onSample: (cb) => subscribe<[Sample]>(IPC.monitorSample, cb),
    onFailed: (cb) => subscribe<[string]>(IPC.monitorFailed, cb)
  },
  leak: {
    start: (serial, pkg) => ipcRenderer.invoke(IPC.leakStart, serial, pkg),
    cancel: () => ipcRenderer.invoke(IPC.leakCancel),
    saveReport: (html, pkg) => ipcRenderer.invoke(IPC.leakSaveReport, html, pkg),
    onProgress: (cb) => subscribe<[string]>(IPC.leakProgress, cb),
    onDone: (cb) => subscribe<[LeakDone]>(IPC.leakDone, cb)
  },
  inspect: {
    capture: (serial) => ipcRenderer.invoke(IPC.inspectCapture, serial)
  },
  mirror: {
    startH264: (serial) => ipcRenderer.invoke(IPC.mirrorStartH264, serial),
    startScrcpy: (serial) => ipcRenderer.invoke(IPC.mirrorStartScrcpy, serial),
    startPoller: (serial, displayId) => ipcRenderer.invoke(IPC.mirrorStartPoller, serial, displayId),
    stop: (immediate) => ipcRenderer.invoke(IPC.mirrorStop, immediate),
    input: (serial, logicalId, args) => ipcRenderer.invoke(IPC.mirrorInput, serial, logicalId, args),
    control: (data) => ipcRenderer.invoke(IPC.mirrorControl, data),
    screenshot: (serial, displayId, logicalId) =>
      ipcRenderer.invoke(IPC.mirrorScreenshot, serial, displayId, logicalId),
    recordStart: (serial) => ipcRenderer.invoke(IPC.mirrorRecordStart, serial),
    recordStop: () => ipcRenderer.invoke(IPC.mirrorRecordStop),
    listDisplays: (serial) => ipcRenderer.invoke(IPC.mirrorListDisplays, serial),
    isEmulator: (serial) => ipcRenderer.invoke(IPC.mirrorIsEmulator, serial),
    scrcpyAvailable: () => ipcRenderer.invoke(IPC.mirrorScrcpyAvailable),
    launchScrcpy: (serial, logicalId) => ipcRenderer.invoke(IPC.mirrorLaunchScrcpy, serial, logicalId),
    onFrame: (cb) => subscribe<[string]>(IPC.mirrorFrame, cb),
    onH264: (cb) => subscribe<[Uint8Array]>(IPC.mirrorH264, cb),
    onControlReady: (cb) => subscribe<[boolean]>(IPC.mirrorControlReady, cb),
    onFailed: (cb) => subscribe<[MirrorFailed]>(IPC.mirrorFailed, cb),
    onRecordDone: (cb) => subscribe<[SaveResult]>(IPC.mirrorRecordDone, cb),
    openPopout: (info) => ipcRenderer.invoke(IPC.mirrorPopoutOpen, info),
    closePopout: (redock) => ipcRenderer.invoke(IPC.mirrorPopoutClose, redock),
    updatePopout: (info) => ipcRenderer.invoke(IPC.mirrorPopoutUpdate, info),
    popoutInfo: () => ipcRenderer.invoke(IPC.mirrorPopoutInfo),
    onPopoutInfo: (cb) => subscribe<[MirrorPopoutInfo]>(IPC.mirrorPopoutInfoEvent, cb),
    onPopoutClosed: (cb) => subscribe<[]>(IPC.mirrorPopoutClosed, cb),
    popoutToggleFullscreen: () => ipcRenderer.invoke(IPC.mirrorPopoutFullscreen),
    onPopoutFullscreen: (cb) => subscribe<[boolean]>(IPC.mirrorPopoutFullscreenEvent, cb)
  },
  controls: {
    read: (serial, pkg) => ipcRenderer.invoke(IPC.controlsRead, serial, pkg),
    apply: (serial, argvs, label) => ipcRenderer.invoke(IPC.controlsApply, serial, argvs, label)
  },
  wireless: {
    enable: (serial) => ipcRenderer.invoke(IPC.wirelessEnable, serial)
  },
  mockloc: {
    setup: (serial) => ipcRenderer.invoke(IPC.mocklocSetup, serial),
    set: (serial, lat, lng, acc, alt) => ipcRenderer.invoke(IPC.mocklocSet, serial, lat, lng, acc, alt),
    stop: (serial) => ipcRenderer.invoke(IPC.mocklocStop, serial)
  },
  db: {
    list: (serial, pkg) => ipcRenderer.invoke(IPC.dbList, serial, pkg),
    open: (serial, pkg, name, force) => ipcRenderer.invoke(IPC.dbOpen, serial, pkg, name, force),
    readTable: (serial, pkg, name, table, limit, offset) =>
      ipcRenderer.invoke(IPC.dbReadTable, serial, pkg, name, table, limit, offset),
    query: (serial, pkg, name, sql) => ipcRenderer.invoke(IPC.dbQuery, serial, pkg, name, sql),
    edit: (serial, pkg, name, table, col, rowid, value, setNull) =>
      ipcRenderer.invoke(IPC.dbEdit, serial, pkg, name, table, col, rowid, value, setNull),
    export: (serial, pkg, name, suggested) => ipcRenderer.invoke(IPC.dbExport, serial, pkg, name, suggested),
    exportCsv: (text, suggested, rowCount) => ipcRenderer.invoke(IPC.dbExportCsv, text, suggested, rowCount)
  },
  files: {
    list: (serial, path, pkg, rootMode) => ipcRenderer.invoke(IPC.filesList, serial, path, pkg, rootMode),
    pull: (serial, path, pkg, rootMode, items, destDir) =>
      ipcRenderer.invoke(IPC.filesPull, serial, path, pkg, rootMode, items, destDir),
    push: (serial, path, pkg, rootMode, sources) =>
      ipcRenderer.invoke(IPC.filesPush, serial, path, pkg, rootMode, sources),
    mkdir: (serial, path, pkg, rootMode, name) => ipcRenderer.invoke(IPC.filesMkdir, serial, path, pkg, rootMode, name),
    rename: (serial, path, pkg, rootMode, oldName, newName) =>
      ipcRenderer.invoke(IPC.filesRename, serial, path, pkg, rootMode, oldName, newName),
    delete: (serial, path, pkg, rootMode, names) =>
      ipcRenderer.invoke(IPC.filesDelete, serial, path, pkg, rootMode, names),
    open: (serial, path, pkg, rootMode, name, kind) =>
      ipcRenderer.invoke(IPC.filesOpen, serial, path, pkg, rootMode, name, kind),
    choosePullDir: () => ipcRenderer.invoke(IPC.filesChoosePullDir),
    choosePush: () => ipcRenderer.invoke(IPC.filesChoosePush),
    // Resolve a dropped File's on-disk path (sandbox-safe: webUtils runs here).
    pathForFile: (file) => webUtils.getPathForFile(file)
  },
  apk: {
    install: (serial, paths) => ipcRenderer.invoke(IPC.apkInstall, serial, paths)
  },
  logfile: {
    open: () => ipcRenderer.invoke(IPC.logfileOpen),
    export: (kind, text, count) => ipcRenderer.invoke(IPC.logfileExport, kind, text, count)
  },
  presets: {
    load: () => ipcRenderer.invoke(IPC.presetsLoad),
    save: (map: PresetMap) => ipcRenderer.invoke(IPC.presetsSave, map)
  },
  toolbox: {
    runIntent: (serial, spec: IntentSpec) => ipcRenderer.invoke(IPC.toolboxRunIntent, serial, spec),
    listNotifs: (serial) => ipcRenderer.invoke(IPC.toolboxListNotifs, serial),
    monkeyStart: (serial, pkg, events, seed, throttleMs) =>
      ipcRenderer.invoke(IPC.toolboxMonkeyStart, serial, pkg, events, seed, throttleMs),
    monkeyStop: () => ipcRenderer.invoke(IPC.toolboxMonkeyStop),
    onMonkeyLine: (cb) => subscribe<[string]>(IPC.toolboxMonkeyLine, cb),
    onMonkeyDone: (cb) => subscribe<[MonkeyDone]>(IPC.toolboxMonkeyDone, cb),
    perfettoStart: (serial, durationS, categories) =>
      ipcRenderer.invoke(IPC.toolboxPerfettoStart, serial, durationS, categories),
    perfettoCancel: () => ipcRenderer.invoke(IPC.toolboxPerfettoCancel),
    onPerfettoProgress: (cb) => subscribe<[string]>(IPC.toolboxPerfettoProgress, cb),
    onPerfettoDone: (cb) => subscribe<[PerfettoDone]>(IPC.toolboxPerfettoDone, cb),
    bugreportStart: (serial) => ipcRenderer.invoke(IPC.toolboxBugreportStart, serial),
    bugreportCancel: () => ipcRenderer.invoke(IPC.toolboxBugreportCancel),
    onBugreportProgress: (cb) => subscribe<[number]>(IPC.toolboxBugreportProgress, cb),
    onBugreportDone: (cb) => subscribe<[BugreportDone]>(IPC.toolboxBugreportDone, cb)
  },
  prefs: {
    list: (serial, pkg) => ipcRenderer.invoke(IPC.prefsList, serial, pkg),
    load: (serial, pkg, fname) => ipcRenderer.invoke(IPC.prefsLoad, serial, pkg, fname),
    save: (serial, pkg, fname, prefs) => ipcRenderer.invoke(IPC.prefsSave, serial, pkg, fname, prefs),
    forceStop: (serial, pkg) => ipcRenderer.invoke(IPC.prefsForceStop, serial, pkg)
  },
  crash: {
    scan: (serial) => ipcRenderer.invoke(IPC.crashScan, serial),
    retrace: (text) => ipcRenderer.invoke(IPC.crashRetrace, text),
    loadMapping: (path) => ipcRenderer.invoke(IPC.crashLoadMapping, path),
    chooseMapping: () => ipcRenderer.invoke(IPC.crashChooseMapping),
    lastMappingPath: () => ipcRenderer.invoke(IPC.crashLastMapping),
    save: (text, suggested) => ipcRenderer.invoke(IPC.crashSave, text, suggested)
  },
  appmgr: {
    list: (serial) => ipcRenderer.invoke(IPC.appmgrList, serial),
    detail: (serial, pkg, apkPath) => ipcRenderer.invoke(IPC.appmgrDetail, serial, pkg, apkPath),
    action: (serial, argv, okMsg) => ipcRenderer.invoke(IPC.appmgrAction, serial, argv, okMsg),
    clearCache: (serial, pkg) => ipcRenderer.invoke(IPC.appmgrClearCache, serial, pkg),
    bulkPerms: (serial, pkg, perms, grant) => ipcRenderer.invoke(IPC.appmgrBulkPerms, serial, pkg, perms, grant),
    icon: (serial, pkg, apkPath) => ipcRenderer.invoke(IPC.appmgrIcon, serial, pkg, apkPath),
    extractApk: (serial, pkg) => ipcRenderer.invoke(IPC.appmgrExtractApk, serial, pkg)
  },
  ios: {
    deviceInfo: (udid) => ipcRenderer.invoke(IPC.iosDeviceInfo, udid),
    deviceIp: (udid) => ipcRenderer.invoke(IPC.iosDeviceIp, udid),
    deviceImage: (identifier) => ipcRenderer.invoke(IPC.iosDeviceImage, identifier),
    listApps: (udid) => ipcRenderer.invoke(IPC.iosListApps, udid),
    chooseIpa: () => ipcRenderer.invoke(IPC.iosChooseIpa),
    install: (udid, ipaPath) => ipcRenderer.invoke(IPC.iosInstall, udid, ipaPath),
    uninstall: (udid, bundleId) => ipcRenderer.invoke(IPC.iosUninstall, udid, bundleId),
    tunnelStatus: (udid) => ipcRenderer.invoke(IPC.iosTunnelStatus, udid),
    tunnelStart: (udid) => ipcRenderer.invoke(IPC.iosTunnelStart, udid),
    tunnelStop: () => ipcRenderer.invoke(IPC.iosTunnelStop),
    processes: (udid, appsOnly) => ipcRenderer.invoke(IPC.iosProcesses, udid, appsOnly),
    launch: (udid, bundleId) => ipcRenderer.invoke(IPC.iosLaunch, udid, bundleId),
    kill: (udid, bundleId) => ipcRenderer.invoke(IPC.iosKill, udid, bundleId)
  },
  iosMirror: {
    start: (udid) => ipcRenderer.invoke(IPC.iosMirrorStart, udid),
    stop: (immediate) => ipcRenderer.invoke(IPC.iosMirrorStop, immediate),
    saveFrame: (pngBase64) => ipcRenderer.invoke(IPC.iosMirrorSaveFrame, pngBase64),
    onH264: (cb) => subscribe<[Uint8Array]>(IPC.iosMirrorH264, cb),
    onState: (cb) => subscribe<[IosMirrorState]>(IPC.iosMirrorState, cb),
    onFailed: (cb) => subscribe<[string]>(IPC.iosMirrorFailed, cb)
  },
  intercept: {
    start: (serial, port, decrypt) => ipcRenderer.invoke(IPC.interceptStart, serial, port, decrypt),
    stop: () => ipcRenderer.invoke(IPC.interceptStop),
    setDecrypt: (on) => ipcRenderer.invoke(IPC.interceptSetDecrypt, on),
    installCert: (serial) => ipcRenderer.invoke(IPC.interceptInstallCert, serial),
    detail: (id) => ipcRenderer.invoke(IPC.interceptDetail, id),
    saveBody: (id) => ipcRenderer.invoke(IPC.interceptSaveBody, id),
    downloadFlow: (id) => ipcRenderer.invoke(IPC.interceptDownloadFlow, id),
    onFlows: (cb) => subscribe<[FlowBatch]>(IPC.interceptFlows, cb),
    onStarted: (cb) => subscribe<[number]>(IPC.interceptStarted, cb),
    onStatus: (cb) => subscribe<[string]>(IPC.interceptStatus, cb),
    onFailed: (cb) => subscribe<[string]>(IPC.interceptFailed, cb)
  },
  system: {
    openPath: (p) => ipcRenderer.invoke(IPC.systemOpenPath, p),
    platform: process.platform
  },
  menu: {
    onAction: (cb) => subscribe<[MenuAction]>(IPC.menuAction, cb)
  }
}

contextBridge.exposeInMainWorld('androidlab', api)
