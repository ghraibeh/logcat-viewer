/**
 * Register all IPC handlers and forward the live logcat stream to the renderer.
 * This is the single boundary between the privileged main process (subprocess +
 * fs + dialogs) and the sandboxed renderer.
 */
import { ipcMain, dialog, shell, type BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { PresetMap } from '@shared/types'
import { findAdb, listDevices, listApps, resolvePids, forceCrash } from './services/adb'
import { LogcatReader } from './services/logcat'
import { MonitorService } from './services/monitor'
import { captureInspect } from './services/inspector'
import { readControlsState, applyControls } from './services/controls'
import { DbService } from './services/db'
import { FilesService } from './services/files'
import { ToolboxService } from './services/toolbox'
import { PrefsService } from './services/prefs'
import { CrashService } from './services/crash'
import { AppMgrService } from './services/appmgr'
import { installApks } from './services/apk'
import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { FileKind } from '@core/files'
import type { IntentSpec } from '@core/toolbox'
import type { Pref } from '@core/prefs'
import type { FilesPullItem } from '@shared/types'
import { openLog, exportLog } from './services/logfile'
import { loadPresets, savePresets } from './services/presets'

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  let reader: LogcatReader | null = null
  let monitor: MonitorService | null = null
  let db: DbService | null = null
  let files: FilesService | null = null
  let toolbox: ToolboxService | null = null
  let prefs: PrefsService | null = null
  let crash: CrashService | null = null
  let appmgr: AppMgrService | null = null

  const send = (channel: string, ...args: unknown[]): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  const ensureReader = (adb: string): LogcatReader => {
    if (!reader) {
      reader = new LogcatReader(adb, {
        onLines: (lines) => send(IPC.logcatLines, lines),
        onState: (state) => send(IPC.logcatState, state),
        onError: (message) => send(IPC.logcatError, message)
      })
    }
    return reader
  }

  ipcMain.handle(IPC.adbFind, () => ({ path: findAdb() }))

  ipcMain.handle(IPC.adbListDevices, async () => {
    const adb = findAdb()
    return adb ? await listDevices(adb) : []
  })

  ipcMain.handle(IPC.adbListApps, async (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return { apps: [] }
    return { apps: await listApps(adb, serial) }
  })

  ipcMain.handle(IPC.adbResolvePids, async (_e, serial: string, pkg: string) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return []
    return await resolvePids(adb, serial, pkg)
  })

  ipcMain.handle(IPC.adbForceCrash, async (_e, serial: string, pkg: string, pids: number[]) => {
    const adb = findAdb()
    if (!adb || !serial) return []
    return await forceCrash(adb, serial, pkg, pids)
  })

  ipcMain.handle(IPC.logcatStart, (_e, serial: string, clearFirst: boolean) => {
    const adb = findAdb()
    if (!adb || !serial) return false
    ensureReader(adb).start(serial, clearFirst)
    return true
  })

  ipcMain.handle(IPC.logcatStop, () => {
    reader?.stop()
    return true
  })

  ipcMain.handle(IPC.logcatRunning, () => reader?.running ?? false)

  const ensureMonitor = (adb: string): MonitorService => {
    if (!monitor) {
      monitor = new MonitorService(adb, {
        onSample: (sample) => send(IPC.monitorSample, sample),
        onFailed: (message) => send(IPC.monitorFailed, message)
      })
    }
    return monitor
  }

  ipcMain.handle(
    IPC.monitorStart,
    (_e, serial: string, pkg: string | null, intervalMs: number) => {
      const adb = findAdb()
      if (!adb || !serial) return false
      ensureMonitor(adb).start(serial, pkg, intervalMs)
      return true
    }
  )

  ipcMain.handle(IPC.monitorStop, () => {
    monitor?.stop()
    return true
  })

  ipcMain.handle(IPC.inspectCapture, async (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) {
      return { ok: false, message: 'no device selected', pngBase64: '', xml: '' }
    }
    return await captureInspect(adb, serial)
  })

  ipcMain.handle(IPC.controlsRead, async (_e, serial: string, pkg: string | null) => {
    const adb = findAdb()
    if (!adb || !serial) return { ok: false, message: 'no device selected', state: null }
    return await readControlsState(adb, serial, pkg)
  })

  ipcMain.handle(
    IPC.controlsApply,
    async (_e, serial: string, argvs: string[][], label: string) => {
      const adb = findAdb()
      if (!adb || !serial) return { ok: false, message: 'no device selected' }
      return await applyControls(adb, serial, argvs, label)
    }
  )

  // --- database inspector -------------------------------------------------
  const ensureDb = (adb: string): DbService => {
    if (!db) db = new DbService(adb)
    return db
  }

  ipcMain.handle(IPC.dbList, async (_e, serial: string, pkg: string) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) {
      return { ok: false, dbs: [], message: 'no device / app selected', usedSu: false, hasSqlite3: false }
    }
    return await ensureDb(adb).list(serial, pkg)
  })

  ipcMain.handle(IPC.dbOpen, async (_e, serial: string, pkg: string, name: string, force: boolean) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return { ok: false, name, tables: [], message: 'no device / app selected' }
    return await ensureDb(adb).open(serial, pkg, name, force)
  })

  ipcMain.handle(
    IPC.dbReadTable,
    async (_e, serial: string, pkg: string, name: string, table: string, limit: number, offset: number) => {
      const adb = findAdb()
      if (!adb || !serial || !pkg) {
        return { ok: false, cols: [], rows: [], total: -1, truncated: false, rowids: null, message: 'no device' }
      }
      return await ensureDb(adb).readTable(serial, pkg, name, table, limit, offset)
    }
  )

  ipcMain.handle(IPC.dbQuery, async (_e, serial: string, pkg: string, name: string, sql: string) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) {
      return { ok: false, cols: [], rows: [], total: -1, truncated: false, rowids: null, message: 'no device' }
    }
    return await ensureDb(adb).runQuery(serial, pkg, name, sql)
  })

  ipcMain.handle(
    IPC.dbEdit,
    async (
      _e,
      serial: string,
      pkg: string,
      name: string,
      table: string,
      col: string,
      rowid: number,
      value: string | null,
      setNull: boolean
    ) => {
      const adb = findAdb()
      if (!adb || !serial || !pkg) return { ok: false, message: 'no device / app selected' }
      return await ensureDb(adb).edit(serial, pkg, name, table, col, rowid, value, setNull)
    }
  )

  ipcMain.handle(IPC.dbExport, async (_e, serial: string, pkg: string, name: string, suggested: string) => {
    const adb = findAdb()
    const win = getWindow()
    if (!adb || !serial || !pkg || !win) return { ok: false, message: 'no device / app selected', dir: '' }
    const res = await dialog.showSaveDialog(win, {
      title: `Export '${name}' as a .db file`,
      defaultPath: join(homedir(), 'Downloads', suggested),
      filters: [
        { name: 'SQLite database', extensions: ['db'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return { ok: false, message: 'cancelled', dir: '' }
    return await ensureDb(adb).exportDb(serial, pkg, name, res.filePath)
  })

  ipcMain.handle(IPC.dbExportCsv, async (_e, text: string, suggested: string, rowCount: number) => {
    const adb = findAdb()
    const win = getWindow()
    if (!win) return { ok: false, message: 'no window', dir: '' }
    const res = await dialog.showSaveDialog(win, {
      title: 'Export results as CSV',
      defaultPath: join(homedir(), 'Downloads', suggested),
      filters: [
        { name: 'CSV files', extensions: ['csv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return { ok: false, message: 'cancelled', dir: '' }
    return ensureDb(adb ?? '').saveCsv(text, res.filePath, rowCount)
  })

  // --- file explorer ------------------------------------------------------
  const ensureFiles = (adb: string): FilesService => {
    if (!files) files = new FilesService(adb)
    return files
  }

  ipcMain.handle(IPC.filesList, async (_e, serial: string, path: string, pkg: string | null, rootMode: boolean) => {
    const adb = findAdb()
    if (!adb || !serial) return { ok: false, path, entries: [], error: 'No device selected', usedSu: false }
    return await ensureFiles(adb).listDir(serial, path, pkg, rootMode)
  })

  ipcMain.handle(
    IPC.filesPull,
    async (
      _e,
      serial: string,
      path: string,
      pkg: string | null,
      rootMode: boolean,
      items: FilesPullItem[],
      destDir: string
    ) => {
      const adb = findAdb()
      if (!adb || !serial) return { ok: false, message: 'No device selected', dir: '' }
      return await ensureFiles(adb).pull(serial, path, pkg, rootMode, items, destDir)
    }
  )

  ipcMain.handle(
    IPC.filesPush,
    async (_e, serial: string, path: string, pkg: string | null, rootMode: boolean, sources: string[]) => {
      const adb = findAdb()
      if (!adb || !serial) return { ok: false, message: 'No device selected', dir: '' }
      return await ensureFiles(adb).push(serial, path, pkg, rootMode, sources)
    }
  )

  ipcMain.handle(
    IPC.filesMkdir,
    async (_e, serial: string, path: string, pkg: string | null, rootMode: boolean, name: string) => {
      const adb = findAdb()
      if (!adb || !serial) return { ok: false, message: 'No device selected' }
      return await ensureFiles(adb).mkdir(serial, path, pkg, rootMode, name)
    }
  )

  ipcMain.handle(
    IPC.filesRename,
    async (
      _e,
      serial: string,
      path: string,
      pkg: string | null,
      rootMode: boolean,
      oldName: string,
      newName: string
    ) => {
      const adb = findAdb()
      if (!adb || !serial) return { ok: false, message: 'No device selected' }
      return await ensureFiles(adb).rename(serial, path, pkg, rootMode, oldName, newName)
    }
  )

  ipcMain.handle(
    IPC.filesDelete,
    async (_e, serial: string, path: string, pkg: string | null, rootMode: boolean, names: string[]) => {
      const adb = findAdb()
      if (!adb || !serial) return { ok: false, message: 'No device selected' }
      return await ensureFiles(adb).delete(serial, path, pkg, rootMode, names)
    }
  )

  ipcMain.handle(
    IPC.filesOpen,
    async (
      _e,
      serial: string,
      path: string,
      pkg: string | null,
      rootMode: boolean,
      name: string,
      kind: FileKind
    ) => {
      const adb = findAdb()
      if (!adb || !serial) return { ok: false, message: 'No device selected', localPath: '' }
      return await ensureFiles(adb).openEntry(serial, path, pkg, rootMode, name, kind)
    }
  )

  ipcMain.handle(IPC.filesChoosePullDir, async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Download to…',
      defaultPath: join(homedir(), 'Downloads'),
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.filesChoosePush, async () => {
    const win = getWindow()
    if (!win) return []
    const res = await dialog.showOpenDialog(win, {
      title: 'Upload file(s) to the device',
      defaultPath: homedir(),
      properties: ['openFile', 'multiSelections']
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle(IPC.apkChoose, async () => {
    const win = getWindow()
    if (!win) return []
    const res = await dialog.showOpenDialog(win, {
      title: 'Select APK(s) to install',
      defaultPath: homedir(),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Android packages', extensions: ['apk'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return res.canceled ? [] : res.filePaths
  })

  ipcMain.handle(IPC.apkInstall, async (_e, serial: string, paths: string[]) => {
    const adb = findAdb()
    if (!adb || !serial) return { ok: false, message: 'No device selected', output: '', names: '' }
    return await installApks(adb, serial, paths)
  })

  // --- toolbox ------------------------------------------------------------
  const ensureToolbox = (adb: string): ToolboxService => {
    if (!toolbox) {
      toolbox = new ToolboxService(adb, {
        onMonkeyLine: (line) => send(IPC.toolboxMonkeyLine, line),
        onMonkeyDone: (ok, summary) => send(IPC.toolboxMonkeyDone, { ok, summary }),
        onPerfettoProgress: (message) => send(IPC.toolboxPerfettoProgress, message),
        onPerfettoDone: (ok, message, path, dir) =>
          send(IPC.toolboxPerfettoDone, { ok, message, path, dir }),
        onBugreportProgress: (pct) => send(IPC.toolboxBugreportProgress, pct),
        onBugreportDone: (ok, message, dir) => send(IPC.toolboxBugreportDone, { ok, message, dir })
      })
    }
    return toolbox
  }

  ipcMain.handle(IPC.toolboxRunIntent, async (_e, serial: string, spec: IntentSpec) => {
    const adb = findAdb()
    if (!adb || !serial) return { ok: false, output: 'Intents: no device selected' }
    return await ensureToolbox(adb).runIntent(serial, spec)
  })

  ipcMain.handle(IPC.toolboxListNotifs, async (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return { ok: false, message: 'Notifications: no device selected', items: [] }
    return await ensureToolbox(adb).listNotifications(serial)
  })

  ipcMain.handle(
    IPC.toolboxMonkeyStart,
    (_e, serial: string, pkg: string, events: number, seed: number, throttleMs: number) => {
      const adb = findAdb()
      if (!adb || !serial || !pkg) return false
      ensureToolbox(adb).startMonkey(serial, pkg, events, seed, throttleMs)
      return true
    }
  )

  ipcMain.handle(IPC.toolboxMonkeyStop, () => {
    toolbox?.stopMonkey()
    return true
  })

  ipcMain.handle(
    IPC.toolboxPerfettoStart,
    (_e, serial: string, durationS: number, categories: string[]) => {
      const adb = findAdb()
      if (!adb || !serial) return false
      ensureToolbox(adb).capturePerfetto(serial, durationS, categories)
      return true
    }
  )

  ipcMain.handle(IPC.toolboxPerfettoCancel, () => {
    toolbox?.cancelPerfetto()
    return true
  })

  ipcMain.handle(IPC.toolboxBugreportStart, (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return false
    ensureToolbox(adb).startBugreport(serial)
    return true
  })

  ipcMain.handle(IPC.toolboxBugreportCancel, () => {
    toolbox?.cancelBugreport()
    return true
  })

  // --- SharedPreferences editor (Apps ▸ Prefs sub-tab) --------------------
  const ensurePrefs = (adb: string): PrefsService => {
    if (!prefs) prefs = new PrefsService(adb)
    return prefs
  }

  ipcMain.handle(IPC.prefsList, async (_e, serial: string, pkg: string) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return { ok: false, files: [], error: 'no device / app selected', usedSu: false }
    return await ensurePrefs(adb).list(serial, pkg)
  })

  ipcMain.handle(IPC.prefsLoad, async (_e, serial: string, pkg: string, fname: string) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return { ok: false, error: 'no device / app selected', fname, prefs: [] }
    return await ensurePrefs(adb).load(serial, pkg, fname)
  })

  ipcMain.handle(IPC.prefsSave, async (_e, serial: string, pkg: string, fname: string, values: Pref[]) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return { ok: false, error: 'no device / app selected' }
    return await ensurePrefs(adb).save(serial, pkg, fname, values)
  })

  ipcMain.handle(IPC.prefsForceStop, async (_e, serial: string, pkg: string) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return false
    return await ensurePrefs(adb).forceStop(serial, pkg)
  })

  // --- crash & ANR viewer (Apps ▸ Crashes sub-tab) ------------------------
  const ensureCrash = (adb: string): CrashService => {
    if (!crash) crash = new CrashService(adb)
    return crash
  }

  ipcMain.handle(IPC.crashScan, async (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return { ok: false, message: 'no device selected', items: [] }
    return await ensureCrash(adb).scan(serial)
  })

  ipcMain.handle(IPC.crashRetrace, (_e, text: string) => {
    const adb = findAdb()
    return ensureCrash(adb ?? '').retrace(text)
  })

  ipcMain.handle(IPC.crashLoadMapping, async (_e, path: string) => {
    const adb = findAdb()
    return await ensureCrash(adb ?? '').loadMapping(path)
  })

  ipcMain.handle(IPC.crashLastMapping, () => {
    const adb = findAdb()
    return ensureCrash(adb ?? '').lastMappingPath()
  })

  ipcMain.handle(IPC.crashChooseMapping, async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Load R8/ProGuard mapping',
      defaultPath: homedir(),
      properties: ['openFile'],
      filters: [
        { name: 'Mapping files', extensions: ['txt', 'map'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.crashSave, async (_e, text: string, suggested: string) => {
    const win = getWindow()
    if (!win) return { ok: false, message: 'no window', dir: '' }
    const res = await dialog.showSaveDialog(win, {
      title: 'Save crash record',
      defaultPath: join(homedir(), 'Downloads', suggested),
      filters: [
        { name: 'Text', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return { ok: false, message: 'cancelled', dir: '' }
    try {
      writeFileSync(res.filePath, text, 'utf8')
    } catch (e) {
      return { ok: false, message: `Couldn't save: ${e instanceof Error ? e.message : String(e)}`, dir: '' }
    }
    return { ok: true, message: `Crash record saved to ${res.filePath.split('/').pop()}`, dir: dirname(res.filePath) }
  })

  // --- app manager (Apps tab) ---------------------------------------------
  const ensureAppmgr = (adb: string): AppMgrService => {
    if (!appmgr) appmgr = new AppMgrService(adb)
    return appmgr
  }

  ipcMain.handle(IPC.appmgrList, async (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return { ok: false, apps: [], error: 'No device selected' }
    return await ensureAppmgr(adb).list(serial)
  })

  ipcMain.handle(IPC.appmgrDetail, async (_e, serial: string, pkg: string, apkPath: string) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return { ok: false, detail: null, error: 'No device / app selected' }
    return await ensureAppmgr(adb).detail(serial, pkg, apkPath)
  })

  ipcMain.handle(IPC.appmgrAction, async (_e, serial: string, argv: string[], okMsg: string) => {
    const adb = findAdb()
    if (!adb || !serial) return { ok: false, message: 'No device selected' }
    return await ensureAppmgr(adb).action(argv, okMsg)
  })

  ipcMain.handle(IPC.appmgrClearCache, async (_e, serial: string, pkg: string) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return { ok: false, message: 'No device / app selected' }
    return await ensureAppmgr(adb).clearCache(serial, pkg)
  })

  ipcMain.handle(IPC.appmgrBulkPerms, async (_e, serial: string, pkg: string, perms: string[], grant: boolean) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return { ok: false, message: 'No device / app selected' }
    return await ensureAppmgr(adb).bulkPerms(serial, pkg, perms, grant)
  })

  ipcMain.handle(IPC.appmgrIcon, async (_e, serial: string, pkg: string, apkPath: string) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return { dataUrl: null, unavailable: false }
    return await ensureAppmgr(adb).icon(serial, pkg, apkPath)
  })

  ipcMain.handle(IPC.appmgrExtractApk, async (_e, serial: string, pkg: string) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return { ok: false, message: 'No device / app selected', dir: '' }
    return await ensureAppmgr(adb).extractApk(serial, pkg)
  })

  ipcMain.handle(IPC.logfileOpen, async () => {
    const win = getWindow()
    return win ? await openLog(win) : null
  })

  ipcMain.handle(
    IPC.logfileExport,
    async (_e, kind: 'filtered' | 'full', text: string, count: number) => {
      const win = getWindow()
      if (!win) return { ok: false, message: 'no window', dir: '' }
      return await exportLog(win, kind, text, count)
    }
  )

  ipcMain.handle(IPC.presetsLoad, () => loadPresets())
  ipcMain.handle(IPC.presetsSave, (_e, map: PresetMap) => savePresets(map))

  ipcMain.handle(IPC.systemOpenPath, async (_e, p: string) => {
    if (p) await shell.openPath(p)
  })

  // Stop background workers when the window goes away (mirrors closeEvent).
  const win = getWindow()
  win?.on('closed', () => {
    reader?.stop()
    monitor?.stop()
    db?.shutdown()
    files?.shutdown()
    toolbox?.shutdown()
  })
}
