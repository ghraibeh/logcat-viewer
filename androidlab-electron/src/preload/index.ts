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
  LogcatState,
  MenuAction,
  MonkeyDone,
  PerfettoDone,
  PresetMap
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
    forceCrash: (serial, pkg, pids) => ipcRenderer.invoke(IPC.adbForceCrash, serial, pkg, pids)
  },
  logcat: {
    start: (serial, clearFirst) => ipcRenderer.invoke(IPC.logcatStart, serial, clearFirst),
    stop: () => ipcRenderer.invoke(IPC.logcatStop),
    running: () => ipcRenderer.invoke(IPC.logcatRunning),
    onLines: (cb) => subscribe<[string[]]>(IPC.logcatLines, cb),
    onState: (cb) => subscribe<[LogcatState]>(IPC.logcatState, cb),
    onError: (cb) => subscribe<[string]>(IPC.logcatError, cb)
  },
  monitor: {
    start: (serial, pkg, intervalMs) => ipcRenderer.invoke(IPC.monitorStart, serial, pkg, intervalMs),
    stop: () => ipcRenderer.invoke(IPC.monitorStop),
    onSample: (cb) => subscribe<[Sample]>(IPC.monitorSample, cb),
    onFailed: (cb) => subscribe<[string]>(IPC.monitorFailed, cb)
  },
  inspect: {
    capture: (serial) => ipcRenderer.invoke(IPC.inspectCapture, serial)
  },
  controls: {
    read: (serial, pkg) => ipcRenderer.invoke(IPC.controlsRead, serial, pkg),
    apply: (serial, argvs, label) => ipcRenderer.invoke(IPC.controlsApply, serial, argvs, label)
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
    choose: () => ipcRenderer.invoke(IPC.apkChoose),
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
  system: {
    openPath: (p) => ipcRenderer.invoke(IPC.systemOpenPath, p),
    platform: process.platform
  },
  menu: {
    onAction: (cb) => subscribe<[MenuAction]>(IPC.menuAction, cb)
  }
}

contextBridge.exposeInMainWorld('androidlab', api)
