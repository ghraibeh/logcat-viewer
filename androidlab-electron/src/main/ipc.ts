/**
 * Register all IPC handlers and forward the live logcat stream to the renderer.
 * This is the single boundary between the privileged main process (subprocess +
 * fs + dialogs) and the sandboxed renderer.
 */
import { ipcMain, dialog, shell, BrowserWindow, app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { AppSettings, Device, MirrorPopoutInfo, PresetMap } from '@shared/types'
import { MirrorWindowManager } from './mirrorWindow'
import { findAdb, listDevices, listApps, resolvePids, forceCrash } from './services/adb'
import { DeviceWatcher } from './services/devicewatch'
import { readDeviceInfo } from './services/deviceinfo'
import * as goios from './services/goios'
import * as devicekit from './services/devicekit'
import * as iosfiles from './services/iosfiles'
import { LogcatReader } from './services/logcat'
import { ShellSession } from './services/shell'
import { MonitorService } from './services/monitor'
import { LeakDetectService } from './services/leakdetect'
import { captureInspect } from './services/inspector'
import { MirrorService } from './services/mirror'
import { IosMirrorService } from './services/iosmirror'
import { IosAirplayService } from './services/iosairplay'
import { MlkMirrorService } from './services/mlkmirror'
import { AaHeadUnitService } from './services/aaheadunit'
import * as iosinput from './services/iosinput'
import type { IosInputConfig } from '@core/iosinput'
import { readControlsState, applyControls } from './services/controls'
import { enableWirelessDebug } from './services/wireless'
import { loadSettings, saveSettings } from './services/settings'
import { MockLocationService } from './services/mocklocation'
import { DbService } from './services/db'
import { IosDbService } from './services/iosdb'
import { FilesService } from './services/files'
import { ToolboxService } from './services/toolbox'
import { PrefsService } from './services/prefs'
import { CrashService } from './services/crash'
import { AppMgrService } from './services/appmgr'
import { InterceptService, AndroidWiring, type DeviceWiring, type WiringCallbacks } from './services/intercept'
import { IosWiring } from './services/interceptIos'
import { installApks } from './services/apk'
import { deviceImage } from './services/deviceimage'
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
  let leak: LeakDetectService | null = null
  let db: DbService | null = null
  let iosDb: IosDbService | null = null
  let files: FilesService | null = null
  let toolbox: ToolboxService | null = null
  let prefs: PrefsService | null = null
  let crash: CrashService | null = null
  let appmgr: AppMgrService | null = null
  let mockloc: MockLocationService | null = null
  let mirrorSvc: MirrorService | null = null
  let iosMirrorSvc: IosMirrorService | null = null
  let iosAirplaySvc: IosAirplayService | null = null
  let mlkMirrorSvc: MlkMirrorService | null = null
  let aaSvc: AaHeadUnitService | null = null
  // One PTY-backed session per renderer shell tab, keyed by the tab's id.
  const shellSessions = new Map<string, ShellSession>()
  let intercept: InterceptService | null = null

  // Cache of the last merged device list so handlers can tell a serial's
  // platform (Android via adb vs iOS via go-ios) and route accordingly.
  let lastDevices: Device[] = []
  const isIos = (serial: string): boolean =>
    lastDevices.some((d) => d.serial === serial && d.platform === 'ios')

  const send = (channel: string, ...args: unknown[]): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }

  // Fan an event out to every live window. Used for the mirror frame/H.264
  // streams so they reach whichever window currently hosts the dock — the main
  // window OR the detached pop-out window (only one mounts the dock at a time).
  const broadcast = (channel: string, ...args: unknown[]): void => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(channel, ...args)
    }
  }

  // The detached mirror window; on close it tells the main window to re-dock.
  const mirrorWin = new MirrorWindowManager(() => send(IPC.mirrorPopoutClosed))

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

  // Session cache of iOS UDIDs already made Wi-Fi-ready, so auto-enable fires
  // once per device (not on every list rebuild). Cleared only on app restart.
  const wifiReady = new Set<string>()

  // Auto-switch to Wi-Fi: the instant an iOS device is seen over USB, enable its
  // "Show when on Wi-Fi" lockdown value (unless the user opted it out). usbmuxd
  // hides the Wi-Fi entry while USB is present, so this is prep — when the cable
  // comes out the device reappears over Wi-Fi on its own (same UDID ⇒ the app
  // keeps it selected). Fire-and-forget so it never slows enumeration.
  const autoEnableWifi = (bin: string, devices: Device[]): void => {
    const s = loadSettings()
    if (!s.autoWifi) return
    for (const d of devices) {
      // Enroll any iOS device we can currently reach over USB (that's when
      // usbmux lets us flip its Wi-Fi-sync lockdown value).
      if (d.platform !== 'ios' || !d.transports.includes('usb')) continue
      if (wifiReady.has(d.serial) || s.wifiOptOut.includes(d.serial)) continue
      void goios
        .wifiConnections(bin, d.serial, 'enable')
        .then((r) => {
          if (r.ok) {
            wifiReady.add(d.serial)
            console.error(`[wifi] auto-enabled Wi-Fi connections for ${d.serial}`)
          }
        })
        .catch(() => {})
    }
  }

  // The app's device list is the union of adb (Android) + go-ios (iOS). Either
  // backend being absent just contributes an empty list.
  const buildDeviceList = async (): Promise<Device[]> => {
    const adb = findAdb()
    const android = adb ? await listDevices(adb) : []
    const iosBin = goios.findGoIos()
    const ios = iosBin ? await goios.listDevices(iosBin).catch(() => []) : []
    if (iosBin) {
      autoEnableWifi(iosBin, ios)
      // Auto-start the developer tunnel: the moment any iOS device is present,
      // bring up the shared agent (it then tunnels every device on its own loop,
      // USB or Wi-Fi) so dev-tier is ready without the user enabling it.
      if (ios.length > 0 && loadSettings().autoTunnel) {
        void goios.ensureAgentRunning(iosBin).catch(() => {})
      }
    }
    return [...android, ...ios]
  }

  ipcMain.handle(IPC.adbListDevices, async () => {
    lastDevices = await buildDeviceList()
    return lastDevices
  })

  // --- hotplug: push the device list on USB attach/detach (no manual refresh) --
  const deviceSig = (list: Device[]): string =>
    list
      .map((d) => `${d.serial}:${d.state}:${d.online}`)
      .sort()
      .join('|')

  // Serialise rebuilds (a build can outlast the next trigger) and re-run once more
  // if another change arrived mid-build, so we never miss or overlap.
  let building = false
  let pending = false
  const rebuildDevices = async (): Promise<void> => {
    if (building) {
      pending = true
      return
    }
    building = true
    try {
      do {
        pending = false
        const list = await buildDeviceList()
        if (deviceSig(list) !== deviceSig(lastDevices)) {
          lastDevices = list
          send(IPC.devicesChanged, list)
        }
      } while (pending)
    } finally {
      building = false
    }
  }

  const deviceWatcher = new DeviceWatcher({
    findAdb,
    findGoIos: goios.findGoIos,
    onChange: () => void rebuildDevices()
  })
  deviceWatcher.start()

  // Self-heal loop. `ios listen` only signals on attach/detach, so a device that is
  // ALREADY connected when we launch may never produce an event — and the single
  // initial poll can miss it (a slow/racing usbmux right after launch), or the first
  // autoTunnel attempt can lose a race with the Wi-Fi auto-enable. Either way the
  // device would be absent from the list and the tunnel would never come up (observed
  // on `open`/double-click launches: `ios listen` runs but no tunnel). Periodically
  // re-running the full rebuild re-detects the device (updating the UI list too),
  // re-fires autoTunnel, and retries a missing tunnel. rebuildDevices is serialized,
  // autoEnableWifi fires once per device, and ensureAgent is coalesced + early-returns
  // when healthy — so this only fills gaps, it never churns a working tunnel.
  const tunnelHeal = setInterval(() => {
    void rebuildDevices()
  }, 5000)

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

  ipcMain.handle(IPC.adbDeviceInfo, async (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return null
    return await readDeviceInfo(adb, serial)
  })

  ipcMain.handle(IPC.logcatStart, (_e, serial: string, clearFirst: boolean) => {
    if (!serial) return false
    if (isIos(serial)) {
      const bin = goios.findGoIos()
      if (!bin) return false
      // iOS: stream `ios syslog`, reshaped to threadtime so the shared parser reads it.
      return goios.syslogStart(
        bin,
        serial,
        (lines) => send(IPC.logcatLines, lines),
        (s) => send(IPC.logcatState, s)
      )
    }
    const adb = findAdb()
    if (!adb) return false
    ensureReader(adb).start(serial, clearFirst)
    return true
  })

  ipcMain.handle(IPC.logcatStop, () => {
    reader?.stop()
    goios.syslogStop()
    return true
  })

  ipcMain.handle(IPC.logcatRunning, () => (reader?.running ?? false) || goios.syslogRunning())

  // --- interactive adb shell (one PTY per tab, keyed by id) ----------------
  const ensureShell = (id: string, adb: string): ShellSession => {
    let s = shellSessions.get(id)
    if (!s) {
      // Each session tags its output with its id so the right terminal receives it.
      s = new ShellSession(adb, {
        onData: (text) => send(IPC.shellData, id, text),
        onState: (state) => send(IPC.shellState, id, state)
      })
      shellSessions.set(id, s)
    }
    return s
  }

  ipcMain.handle(
    IPC.shellStart,
    (_e, id: string, kind: 'device' | 'local', serial: string, cols: number, rows: number) => {
      const adb = findAdb()
      // Local shell needs no adb/device; device shell needs both.
      if (kind === 'device' && (!adb || !serial)) return false
      ensureShell(id, adb ?? '').start(kind, serial, cols, rows)
      return true
    }
  )

  ipcMain.handle(IPC.shellWrite, (_e, id: string, data: string) => {
    shellSessions.get(id)?.write(data)
    return true
  })

  ipcMain.handle(IPC.shellResize, (_e, id: string, cols: number, rows: number) => {
    shellSessions.get(id)?.resize(cols, rows)
    return true
  })

  ipcMain.handle(IPC.shellStop, (_e, id: string) => {
    const s = shellSessions.get(id)
    if (s) {
      s.stop()
      shellSessions.delete(id)
    }
    return true
  })

  ipcMain.handle(IPC.shellRunning, (_e, id: string) => shellSessions.get(id)?.running ?? false)

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
      if (!serial) return false
      if (isIos(serial)) {
        const bin = goios.findGoIos()
        if (!bin) return false
        void goios.monitorStart(
          bin,
          serial,
          intervalMs,
          (s) => send(IPC.monitorSample, s),
          (m) => send(IPC.monitorFailed, m)
        )
        return true
      }
      const adb = findAdb()
      if (!adb) return false
      ensureMonitor(adb).start(serial, pkg, intervalMs)
      return true
    }
  )

  ipcMain.handle(IPC.monitorStop, () => {
    monitor?.stop()
    goios.monitorStop()
    return true
  })

  // --- memory-leak detection (LeakCanary/Shark) ---------------------------
  const ensureLeak = (adb: string): LeakDetectService => {
    if (!leak) {
      leak = new LeakDetectService(adb, {
        onProgress: (message) => send(IPC.leakProgress, message),
        onDone: (ok, report, hprofPath, pkg) => send(IPC.leakDone, { ok, report, hprofPath, pkg })
      })
    }
    return leak
  }

  ipcMain.handle(IPC.leakStart, (_e, serial: string, pkg: string) => {
    const adb = findAdb()
    if (!adb || !serial || !pkg) return false
    return ensureLeak(adb).start(serial, pkg)
  })

  ipcMain.handle(IPC.leakCancel, () => {
    leak?.cancel()
    return true
  })

  ipcMain.handle(IPC.leakSaveReport, async (_e, html: string, pkg: string) => {
    const win = getWindow()
    if (!win) return { ok: false, message: 'no window', dir: '' }
    const safe = (pkg || 'app').replace(/[^a-zA-Z0-9._-]/g, '_')
    const res = await dialog.showSaveDialog(win, {
      title: 'Save leak report',
      defaultPath: join(homedir(), 'Downloads', `leak-report-${safe}.html`),
      filters: [
        { name: 'HTML', extensions: ['html'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return { ok: false, message: 'cancelled', dir: '' }
    try {
      writeFileSync(res.filePath, html, 'utf8')
    } catch (e) {
      return { ok: false, message: `Couldn't save: ${e instanceof Error ? e.message : String(e)}`, dir: '' }
    }
    return { ok: true, message: `Leak report saved to ${res.filePath.split('/').pop()}`, dir: dirname(res.filePath) }
  })

  ipcMain.handle(IPC.inspectCapture, async (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) {
      return { ok: false, message: 'no device selected', pngBase64: '', xml: '' }
    }
    return await captureInspect(adb, serial)
  })

  // --- screen mirror ------------------------------------------------------
  const ensureMirror = (adb: string): MirrorService => {
    if (!mirrorSvc) {
      mirrorSvc = new MirrorService(adb, {
        onFrame: (base64) => broadcast(IPC.mirrorFrame, base64),
        onH264: (chunk) => broadcast(IPC.mirrorH264, chunk),
        onControlReady: (ready) => broadcast(IPC.mirrorControlReady, ready),
        onFailed: (kind, message) => broadcast(IPC.mirrorFailed, { kind, message })
      })
      mirrorSvc.onRecordDone((result) => broadcast(IPC.mirrorRecordDone, result))
    }
    return mirrorSvc
  }

  ipcMain.handle(IPC.mirrorStartH264, (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return false
    ensureMirror(adb).startH264(serial)
    return true
  })

  ipcMain.handle(IPC.mirrorStartScrcpy, (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return false
    ensureMirror(adb).startScrcpy(serial)
    return true
  })

  ipcMain.handle(IPC.mirrorStartPoller, (_e, serial: string, displayId: string | null) => {
    const adb = findAdb()
    if (!adb || !serial) return false
    ensureMirror(adb).startPoller(serial, displayId)
    return true
  })

  ipcMain.handle(IPC.mirrorStop, (_e, immediate?: boolean) => {
    mirrorSvc?.stopFeed(immediate)
    return true
  })

  ipcMain.handle(IPC.mirrorInput, (_e, serial: string, logicalId: number | null, args: string[]) => {
    const adb = findAdb()
    if (adb && serial) ensureMirror(adb).input(serial, logicalId, args)
  })

  ipcMain.handle(IPC.mirrorControl, (_e, data: Uint8Array) => {
    mirrorSvc?.control(data)
  })

  ipcMain.handle(
    IPC.mirrorScreenshot,
    async (_e, serial: string, displayId: string | null, logicalId: number | null) => {
      const adb = findAdb()
      if (!adb || !serial) return { ok: false, message: 'Mirror not connected', dir: '' }
      return await ensureMirror(adb).screenshot(serial, displayId, logicalId)
    }
  )

  ipcMain.handle(IPC.mirrorRecordStart, (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return false
    return ensureMirror(adb).startRecord(serial)
  })

  ipcMain.handle(IPC.mirrorRecordStop, () => mirrorSvc?.stopRecord() ?? false)

  ipcMain.handle(IPC.mirrorListDisplays, async (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return []
    return await ensureMirror(adb).listDisplays(serial)
  })

  ipcMain.handle(IPC.mirrorIsEmulator, async (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return false
    return await ensureMirror(adb).isEmulator(serial)
  })

  ipcMain.handle(IPC.mirrorScrcpyAvailable, () => {
    const adb = findAdb()
    return adb ? ensureMirror(adb).scrcpyPath() !== null : false
  })

  ipcMain.handle(IPC.mirrorLaunchScrcpy, (_e, serial: string, logicalId: number | null) => {
    const adb = findAdb()
    if (adb && serial) ensureMirror(adb).launchScrcpy(serial, logicalId)
  })

  // Detached mirror window (Android Studio-style pop-out).
  ipcMain.handle(IPC.mirrorPopoutOpen, (_e, info: MirrorPopoutInfo) => mirrorWin.open(info))
  ipcMain.handle(IPC.mirrorPopoutClose, (_e, redock: boolean) => mirrorWin.close(redock))
  ipcMain.handle(IPC.mirrorPopoutUpdate, (_e, info: MirrorPopoutInfo) => mirrorWin.update(info))
  ipcMain.handle(IPC.mirrorPopoutInfo, () => mirrorWin.getInfo())
  ipcMain.handle(IPC.mirrorPopoutFullscreen, () => mirrorWin.toggleFullScreen())

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

  ipcMain.handle(IPC.wirelessEnable, async (_e, serial: string) => {
    const adb = findAdb()
    if (!adb || !serial) return { ok: false, message: 'no device selected' }
    return await enableWirelessDebug(adb, serial)
  })

  // iOS "Show this device when on Wi-Fi" (lockdown, via patched go-ios).
  ipcMain.handle(IPC.wirelessIosGet, async (_e, udid: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid) return { ok: false, enabled: false, message: 'no device selected' }
    return await goios.wifiConnections(bin, udid, 'get')
  })
  ipcMain.handle(IPC.wirelessIosSet, async (_e, udid: string, enabled: boolean) => {
    const bin = goios.findGoIos()
    if (!bin || !udid) return { ok: false, enabled: false, message: 'no device selected' }
    const r = await goios.wifiConnections(bin, udid, enabled ? 'enable' : 'disable')
    // Remember an explicit user choice so auto-enable respects it: opting out
    // when they disable, clearing the opt-out (and priming wifiReady) on enable.
    if (r.ok) {
      const s = loadSettings()
      const optOut = new Set(s.wifiOptOut)
      if (enabled) {
        optOut.delete(udid)
        wifiReady.add(udid)
      } else {
        optOut.add(udid)
        wifiReady.delete(udid)
      }
      saveSettings({ wifiOptOut: [...optOut] })
    }
    return r
  })

  // App settings (auto-Wi-Fi toggle + per-device opt-outs).
  ipcMain.handle(IPC.settingsGet, () => loadSettings())
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => saveSettings(patch))

  // --- mock GPS location --------------------------------------------------
  const ensureMockloc = (adb: string): MockLocationService => {
    if (!mockloc) mockloc = new MockLocationService(adb)
    return mockloc
  }

  // Mock GPS. Android drives a helper-APK service; iOS drives go-ios's DVT
  // simulate-location (tunnel + Developer Disk Image mount). Same MockResult
  // shape → the shared LocationView works unchanged for both.
  ipcMain.handle(IPC.mocklocSetup, async (_e, serial: string) => {
    if (!serial) return { ok: false, message: 'No device selected' }
    if (isIos(serial)) {
      const bin = goios.findGoIos()
      return bin ? await goios.mockSetup(bin, serial) : { ok: false, message: 'go-ios not found' }
    }
    const adb = findAdb()
    if (!adb) return { ok: false, message: 'No device selected' }
    return await ensureMockloc(adb).setup(serial)
  })

  ipcMain.handle(
    IPC.mocklocSet,
    async (_e, serial: string, lat: number, lng: number, acc?: number, alt?: number) => {
      if (!serial) return { ok: false, message: 'No device selected' }
      if (isIos(serial)) {
        const bin = goios.findGoIos()
        return bin ? await goios.setLocation(bin, serial, lat, lng) : { ok: false, message: 'go-ios not found' }
      }
      const adb = findAdb()
      if (!adb) return { ok: false, message: 'No device selected' }
      return await ensureMockloc(adb).set(serial, lat, lng, acc ?? null, alt ?? null)
    }
  )

  ipcMain.handle(IPC.mocklocStop, async (_e, serial: string) => {
    if (!serial) return { ok: false, message: 'No device selected' }
    if (isIos(serial)) {
      const bin = goios.findGoIos()
      return bin ? await goios.resetLocation(bin, serial) : { ok: false, message: 'go-ios not found' }
    }
    const adb = findAdb()
    if (!adb) return { ok: false, message: 'No device selected' }
    return await ensureMockloc(adb).stop(serial)
  })

  // --- database inspector -------------------------------------------------
  const ensureDb = (adb: string): DbService => {
    if (!db) db = new DbService(adb)
    return db
  }
  // iOS DB backend (fsync pull → same sql.js readers as Android). `bin` non-null
  // only when the serial is an iOS device.
  const iosDbFor = (serial: string): IosDbService | null => {
    if (!isIos(serial)) return null
    const bin = goios.findGoIos()
    if (!bin) return null
    if (!iosDb) iosDb = new IosDbService(bin)
    return iosDb
  }

  ipcMain.handle(IPC.dbList, async (_e, serial: string, pkg: string) => {
    if (!serial || !pkg) {
      return { ok: false, dbs: [], message: 'no device / app selected', usedSu: false, hasSqlite3: false }
    }
    const ios = iosDbFor(serial)
    if (ios) return await ios.list(serial, pkg)
    const adb = findAdb()
    if (!adb) return { ok: false, dbs: [], message: 'no device / app selected', usedSu: false, hasSqlite3: false }
    return await ensureDb(adb).list(serial, pkg)
  })

  ipcMain.handle(IPC.dbOpen, async (_e, serial: string, pkg: string, name: string, force: boolean) => {
    if (!serial || !pkg) return { ok: false, name, tables: [], message: 'no device / app selected' }
    const ios = iosDbFor(serial)
    if (ios) return await ios.open(serial, pkg, name, force)
    const adb = findAdb()
    if (!adb) return { ok: false, name, tables: [], message: 'no device / app selected' }
    return await ensureDb(adb).open(serial, pkg, name, force)
  })

  ipcMain.handle(
    IPC.dbReadTable,
    async (_e, serial: string, pkg: string, name: string, table: string, limit: number, offset: number) => {
      if (!serial || !pkg) {
        return { ok: false, cols: [], rows: [], total: -1, truncated: false, rowids: null, message: 'no device' }
      }
      const ios = iosDbFor(serial)
      if (ios) return await ios.readTable(serial, pkg, name, table, limit, offset)
      const adb = findAdb()
      if (!adb) {
        return { ok: false, cols: [], rows: [], total: -1, truncated: false, rowids: null, message: 'no device' }
      }
      return await ensureDb(adb).readTable(serial, pkg, name, table, limit, offset)
    }
  )

  ipcMain.handle(IPC.dbQuery, async (_e, serial: string, pkg: string, name: string, sql: string) => {
    if (!serial || !pkg) {
      return { ok: false, cols: [], rows: [], total: -1, truncated: false, rowids: null, message: 'no device' }
    }
    const ios = iosDbFor(serial)
    if (ios) return await ios.runQuery(serial, pkg, name, sql)
    const adb = findAdb()
    if (!adb) {
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
      if (!serial || !pkg) return { ok: false, message: 'no device / app selected' }
      if (isIos(serial)) return { ok: false, message: 'Editing iOS databases is not supported yet (read-only).' }
      const adb = findAdb()
      if (!adb) return { ok: false, message: 'no device / app selected' }
      return await ensureDb(adb).edit(serial, pkg, name, table, col, rowid, value, setNull)
    }
  )

  ipcMain.handle(IPC.dbExport, async (_e, serial: string, pkg: string, name: string, suggested: string) => {
    const win = getWindow()
    if (!serial || !pkg || !win) return { ok: false, message: 'no device / app selected', dir: '' }
    const res = await dialog.showSaveDialog(win, {
      title: `Export '${name}' as a .db file`,
      defaultPath: join(homedir(), 'Downloads', suggested),
      filters: [
        { name: 'SQLite database', extensions: ['db'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return { ok: false, message: 'cancelled', dir: '' }
    const ios = iosDbFor(serial)
    if (ios) return await ios.exportDb(serial, pkg, name, res.filePath)
    const adb = findAdb()
    if (!adb) return { ok: false, message: 'no device / app selected', dir: '' }
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

  // iOS: browse the app container via fsync (read-only). `bin` non-null only for
  // an iOS device; the container is per-app, so `pkg` is required.
  const iosFilesBin = (serial: string): string | null => (isIos(serial) ? goios.findGoIos() : null)
  const IOS_FILES_READONLY = 'iOS containers are read-only here — upload/new-folder/rename/delete aren’t supported yet.'

  ipcMain.handle(IPC.filesList, async (_e, serial: string, path: string, pkg: string | null, rootMode: boolean) => {
    if (!serial) return { ok: false, path, entries: [], error: 'No device selected', usedSu: false }
    const bin = iosFilesBin(serial)
    if (bin) {
      if (!pkg) return { ok: false, path, entries: [], error: 'Select an app to browse its container', usedSu: false }
      return await iosfiles.list(bin, serial, pkg, path)
    }
    const adb = findAdb()
    if (!adb) return { ok: false, path, entries: [], error: 'No device selected', usedSu: false }
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
      if (!serial) return { ok: false, message: 'No device selected', dir: '' }
      const bin = iosFilesBin(serial)
      if (bin) {
        if (!pkg) return { ok: false, message: 'Select an app to browse its container', dir: '' }
        return await iosfiles.pull(bin, serial, pkg, path, items, destDir)
      }
      const adb = findAdb()
      if (!adb) return { ok: false, message: 'No device selected', dir: '' }
      return await ensureFiles(adb).pull(serial, path, pkg, rootMode, items, destDir)
    }
  )

  ipcMain.handle(
    IPC.filesPush,
    async (_e, serial: string, path: string, pkg: string | null, rootMode: boolean, sources: string[]) => {
      if (isIos(serial)) return { ok: false, message: IOS_FILES_READONLY, dir: '' }
      const adb = findAdb()
      if (!adb || !serial) return { ok: false, message: 'No device selected', dir: '' }
      return await ensureFiles(adb).push(serial, path, pkg, rootMode, sources)
    }
  )

  ipcMain.handle(
    IPC.filesMkdir,
    async (_e, serial: string, path: string, pkg: string | null, rootMode: boolean, name: string) => {
      if (isIos(serial)) return { ok: false, message: IOS_FILES_READONLY }
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
      if (isIos(serial)) return { ok: false, message: IOS_FILES_READONLY }
      const adb = findAdb()
      if (!adb || !serial) return { ok: false, message: 'No device selected' }
      return await ensureFiles(adb).rename(serial, path, pkg, rootMode, oldName, newName)
    }
  )

  ipcMain.handle(
    IPC.filesDelete,
    async (_e, serial: string, path: string, pkg: string | null, rootMode: boolean, names: string[]) => {
      if (isIos(serial)) return { ok: false, message: IOS_FILES_READONLY }
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
      if (!serial) return { ok: false, message: 'No device selected', localPath: '' }
      const bin = iosFilesBin(serial)
      if (bin) {
        if (!pkg) return { ok: false, message: 'Select an app to browse its container', localPath: '' }
        return await iosfiles.openEntry(bin, serial, pkg, path, name, kind)
      }
      const adb = findAdb()
      if (!adb) return { ok: false, message: 'No device selected', localPath: '' }
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

  // iOS prefs = NSUserDefaults plists (read-only). Same PrefsListResult/Load shape.
  const iosPrefsBin = (serial: string): string | null => (isIos(serial) ? goios.findGoIos() : null)

  ipcMain.handle(IPC.prefsList, async (_e, serial: string, pkg: string) => {
    if (!serial || !pkg) return { ok: false, files: [], error: 'no device / app selected', usedSu: false }
    const bin = iosPrefsBin(serial)
    if (bin) return await goios.iosPrefsList(bin, serial, pkg)
    const adb = findAdb()
    if (!adb) return { ok: false, files: [], error: 'no device / app selected', usedSu: false }
    return await ensurePrefs(adb).list(serial, pkg)
  })

  ipcMain.handle(IPC.prefsLoad, async (_e, serial: string, pkg: string, fname: string) => {
    if (!serial || !pkg) return { ok: false, error: 'no device / app selected', fname, prefs: [] }
    const bin = iosPrefsBin(serial)
    if (bin) return await goios.iosPrefsLoad(bin, serial, pkg, fname)
    const adb = findAdb()
    if (!adb) return { ok: false, error: 'no device / app selected', fname, prefs: [] }
    return await ensurePrefs(adb).load(serial, pkg, fname)
  })

  ipcMain.handle(IPC.prefsSave, async (_e, serial: string, pkg: string, fname: string, values: Pref[]) => {
    if (!serial || !pkg) return { ok: false, error: 'no device / app selected' }
    // Writing NSUserDefaults back isn't supported yet (would need a plist rebuild
    // + fsync push while the app may hold cached defaults) — read-only on iOS.
    if (isIos(serial)) return { ok: false, error: 'Editing iOS preferences is not supported yet (read-only).' }
    const adb = findAdb()
    if (!adb) return { ok: false, error: 'no device / app selected' }
    return await ensurePrefs(adb).save(serial, pkg, fname, values)
  })

  ipcMain.handle(IPC.prefsForceStop, async (_e, serial: string, pkg: string) => {
    if (!serial || !pkg) return false
    if (isIos(serial)) {
      const bin = goios.findGoIos()
      if (!bin) return false
      return (await goios.kill(bin, serial, pkg)).ok
    }
    const adb = findAdb()
    if (!adb) return false
    return await ensurePrefs(adb).forceStop(serial, pkg)
  })

  // --- crash & ANR viewer (Apps ▸ Crashes sub-tab) ------------------------
  const ensureCrash = (adb: string): CrashService => {
    if (!crash) crash = new CrashService(adb)
    return crash
  }

  ipcMain.handle(IPC.crashScan, async (_e, serial: string) => {
    if (!serial) return { ok: false, message: 'no device selected', items: [] }
    // iOS crash reports (.ips) → same CrashItem shape the shared CrashView renders.
    if (isIos(serial)) {
      const bin = goios.findGoIos()
      if (!bin) return { ok: false, message: 'go-ios binary not found', items: [] }
      return await goios.crashReports(bin, serial)
    }
    const adb = findAdb()
    if (!adb) return { ok: false, message: 'no device selected', items: [] }
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

  // --- iOS Apps tab (go-ios backend) --------------------------------------
  ipcMain.handle(IPC.iosDeviceInfo, async (_e, udid: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid) return null
    return await goios.deviceInfo(bin, udid)
  })

  ipcMain.handle(IPC.iosDeviceIp, async (_e, udid: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid) return null
    return await goios.deviceIp(bin, udid)
  })

  ipcMain.handle(IPC.iosDeviceImage, (_e, identifier: string) => deviceImage(identifier))

  ipcMain.handle(IPC.iosListApps, async (_e, udid: string) => {
    const bin = goios.findGoIos()
    if (!bin) return { ok: false, apps: [], error: 'go-ios binary not found' }
    if (!udid) return { ok: false, apps: [], error: 'No device selected' }
    return await goios.listApps(bin, udid)
  })

  ipcMain.handle(IPC.iosAppIcon, async (_e, udid: string, bundleId: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid || !bundleId) return { dataUrl: null, unavailable: false }
    return await goios.appIcon(bin, udid, bundleId)
  })

  ipcMain.handle(IPC.iosChooseIpa, async () => {
    const win = getWindow()
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Select an .ipa to install',
      defaultPath: homedir(),
      properties: ['openFile'],
      filters: [
        { name: 'iOS app packages', extensions: ['ipa'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
  })

  ipcMain.handle(IPC.iosInstall, async (_e, udid: string, ipaPath: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid || !ipaPath) return { ok: false, message: 'No device / file selected' }
    return await goios.install(bin, udid, ipaPath)
  })

  ipcMain.handle(IPC.iosUninstall, async (_e, udid: string, bundleId: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid || !bundleId) return { ok: false, message: 'No device / app selected' }
    return await goios.uninstall(bin, udid, bundleId)
  })

  // iOS developer tier — userspace tunnel + process control.
  ipcMain.handle(IPC.iosTunnelStatus, async (_e, udid: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid) return { ready: false }
    return await goios.getTunnelStatus(bin, udid)
  })

  ipcMain.handle(IPC.iosTunnelStart, async (_e, udid: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid) return { ok: false, message: 'No device selected' }
    return await goios.startTunnel(bin, udid)
  })

  ipcMain.handle(IPC.iosTunnelStop, () => {
    goios.stopTunnel()
    return true
  })

  ipcMain.handle(IPC.iosProcesses, async (_e, udid: string, appsOnly: boolean) => {
    const bin = goios.findGoIos()
    if (!bin || !udid) return { ok: false, processes: [], error: 'No device selected' }
    return await goios.processes(bin, udid, appsOnly)
  })

  ipcMain.handle(IPC.iosLaunch, async (_e, udid: string, bundleId: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid || !bundleId) return { ok: false, message: 'No device / app selected' }
    return await goios.launch(bin, udid, bundleId)
  })

  ipcMain.handle(IPC.iosKill, async (_e, udid: string, bundleId: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid || !bundleId) return { ok: false, message: 'No device / app selected' }
    return await goios.kill(bin, udid, bundleId)
  })

  // --- iOS screen mirror (macOS native AVFoundation/VideoToolbox H.264 helper) ---
  const ensureIosMirror = (bin: string): IosMirrorService => {
    if (!iosMirrorSvc) {
      iosMirrorSvc = new IosMirrorService(bin, {
        onH264: (chunk) => broadcast(IPC.iosMirrorH264, chunk),
        onState: (state) => broadcast(IPC.iosMirrorState, state),
        onFailed: (message) => broadcast(IPC.iosMirrorFailed, message)
      })
    }
    return iosMirrorSvc
  }

  // The AirPlay (Wi-Fi) receiver broadcasts on the SAME channels as the USB mirror,
  // so the renderer's decoder is feed-agnostic; only one feed runs at a time.
  const ensureIosAirplay = (): IosAirplayService => {
    if (!iosAirplaySvc) {
      iosAirplaySvc = new IosAirplayService({
        onH264: (chunk) => broadcast(IPC.iosMirrorH264, chunk),
        onState: (state) => broadcast(IPC.iosMirrorState, state),
        onFailed: (message) => broadcast(IPC.iosMirrorFailed, message)
      })
    }
    return iosAirplaySvc
  }

  ipcMain.handle(
    IPC.iosMirrorStart,
    (_e, udid: string, mode?: 'usb' | 'airplay', resolution?: { width: number; height: number }) => {
      if (mode === 'airplay') {
        // Wi-Fi path: the phone initiates. Tear down the USB feed and advertise the
        // receiver (no udid needed — the user picks "MobileLabKit" on the device).
        iosMirrorSvc?.stopFeed(true)
        ensureIosAirplay().start(resolution)
        return true
      }
      // USB path (default): CoreMediaIO capture of the cabled device.
      iosAirplaySvc?.stop(true)
      const bin = goios.findGoIos()
      if (!bin || !udid) return false
      ensureIosMirror(bin).start(udid)
      return true
    }
  )

  ipcMain.handle(IPC.iosMirrorStop, (_e, immediate?: boolean) => {
    iosMirrorSvc?.stopFeed(immediate)
    iosAirplaySvc?.stop(immediate)
    return true
  })

  // Android→Mac screen-mirror receiver (our private _mlkmirror._tcp service). Phone-
  // initiated like AirPlay, but on its own channels — plus a PCM audio channel that has
  // no equivalent in the iOS/AirPlay paths (those play audio natively in their helpers).
  const ensureMlkMirror = (): MlkMirrorService => {
    if (!mlkMirrorSvc) {
      mlkMirrorSvc = new MlkMirrorService({
        onH264: (chunk) => broadcast(IPC.mlkMirrorH264, chunk),
        onPcm: (chunk) => broadcast(IPC.mlkMirrorPcm, chunk),
        onState: (state) => broadcast(IPC.mlkMirrorState, state),
        onFailed: (message) => broadcast(IPC.mlkMirrorFailed, message)
      })
    }
    return mlkMirrorSvc
  }

  ipcMain.handle(IPC.mlkMirrorStart, () => ensureMlkMirror().start())
  ipcMain.handle(IPC.mlkMirrorStop, () => {
    mlkMirrorSvc?.stop()
    return true
  })

  // Android Auto head unit: the Mac runs the AA GAL protocol as a wireless head-unit server
  // (arm's-length utilityProcess helper) and fires the gearhead wireless-startup broadcast so
  // the selected phone projects to us. H.264/status stream up; touches go back down.
  const ensureAa = (): AaHeadUnitService | null => {
    if (!aaSvc) {
      const adb = findAdb()
      if (!adb) return null
      aaSvc = new AaHeadUnitService(adb, {
        onH264: (chunk) => broadcast(IPC.aaH264, chunk),
        onPcm: (channel, rate, channels, chunk) => broadcast(IPC.aaPcm, channel, rate, channels, chunk),
        onMicOpen: (open) => broadcast(IPC.aaMicOpen, open),
        onStatus: (message) => broadcast(IPC.aaStatus, message),
        onStreaming: () => broadcast(IPC.aaStreaming),
        onEnded: (reason) => broadcast(IPC.aaEnded, reason),
        onFailed: (message) => broadcast(IPC.aaFailed, message)
      })
    }
    return aaSvc
  }

  ipcMain.handle(IPC.aaStart, (_e, serial: string) => {
    const svc = ensureAa()
    if (!svc) return { ok: false, message: 'adb not found' }
    return svc.start(serial)
  })
  ipcMain.handle(IPC.aaStop, () => {
    aaSvc?.stop()
    return true
  })
  ipcMain.handle(IPC.aaTouch, (_e, action: number, x: number, y: number) => {
    aaSvc?.touch(action, x, y)
    return true
  })
  ipcMain.handle(IPC.aaMicData, (_e, bytes: Uint8Array) => {
    aaSvc?.micData(bytes)
    return true
  })

  // One mute preference, applied to whichever feed is live (USB plays the device
  // audio on this Mac; AirPlay plays the decoded AAC). Setting both keeps them in
  // lockstep so toggling the feed path doesn't surprise the user with sound state.
  ipcMain.handle(IPC.iosMirrorSetMuted, (_e, muted: boolean) => {
    iosMirrorSvc?.setMuted(muted)
    iosAirplaySvc?.setMuted(muted)
    return muted
  })
  ipcMain.handle(IPC.iosMirrorGetMuted, () => iosMirrorSvc?.getMuted() ?? iosAirplaySvc?.getMuted() ?? false)

  ipcMain.handle(IPC.iosMirrorSaveFrame, (_e, pngBase64: string) => {
    const b64 = pngBase64.replace(/^data:image\/png;base64,/, '')
    if (!b64) return { ok: false, message: 'No frame to save', dir: '' }
    const dl = join(homedir(), 'Downloads')
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    const dest = join(dl, `screenshot-ios-${stamp}.png`)
    try {
      writeFileSync(dest, Buffer.from(b64, 'base64'))
      return { ok: true, message: `Saved ${dest.split('/').pop()}`, dir: dl }
    } catch (e) {
      return { ok: false, message: `Cannot save screenshot: ${e instanceof Error ? e.message : String(e)}`, dir: '' }
    }
  })

  // --- iOS touch/keyboard forwarding (WebDriverAgent/DeviceKit via go-ios) ---
  ipcMain.handle(IPC.iosInputGetConfig, () => iosinput.loadConfig())
  ipcMain.handle(IPC.iosInputSetConfig, (_e, cfg: Partial<IosInputConfig>) => iosinput.saveConfig(cfg))
  ipcMain.handle(IPC.iosInputChooseKey, (_e, kind: 'p8' | 'p12' | 'profile') => iosinput.chooseFile(getWindow(), kind))
  ipcMain.handle(IPC.iosInputProvision, async (_e, udid: string, cfg: IosInputConfig) => {
    const bin = goios.findGoIos()
    if (!bin || !udid) return { ok: false, message: 'go-ios or device unavailable' }
    const result = await iosinput.provision(bin, udid, cfg, (line) => send(IPC.iosInputProgress, line))
    send(IPC.iosInputDone, result)
    return result
  })
  ipcMain.handle(IPC.iosInputCancel, () => {
    iosinput.cancelProvision()
    return true
  })
  ipcMain.handle(IPC.iosInputStatus, async (_e, udid: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid) return false
    return iosinput.status(bin, udid)
  })
  ipcMain.handle(IPC.iosInputSize, async (_e, udid: string) => {
    const bin = goios.findGoIos()
    if (!bin || !udid) return null
    return iosinput.size(bin, udid)
  })
  ipcMain.handle(IPC.iosInputTap, (_e, udid: string, x: number, y: number) => {
    const bin = goios.findGoIos()
    if (bin && udid) iosinput.tap(bin, udid, x, y)
    return true
  })
  ipcMain.handle(IPC.iosInputSwipe, (_e, udid: string, x1: number, y1: number, x2: number, y2: number, durationSec?: number) => {
    const bin = goios.findGoIos()
    if (bin && udid) iosinput.swipe(bin, udid, x1, y1, x2, y2, durationSec)
    return true
  })
  ipcMain.handle(IPC.iosInputGesture, (_e, udid: string, points: Array<{ x: number; y: number; t: number }>) => {
    const bin = goios.findGoIos()
    if (bin && udid && Array.isArray(points)) iosinput.gesture(bin, udid, points)
    return true
  })
  ipcMain.handle(
    IPC.iosInputDrag,
    (_e, udid: string, phase: 'start' | 'move' | 'end', x: number, y: number, flick?: { x: number; y: number; durMs: number }) => {
      const bin = goios.findGoIos()
      if (!bin || !udid) return true
      if (phase === 'start') iosinput.dragStart(bin, udid, x, y)
      else if (phase === 'move') iosinput.dragMove(bin, udid, x, y)
      else iosinput.dragEnd(bin, udid, x, y, flick)
      return true
    }
  )
  ipcMain.handle(IPC.iosInputType, (_e, udid: string, text: string) => {
    const bin = goios.findGoIos()
    if (bin && udid) iosinput.type(bin, udid, text)
    return true
  })
  ipcMain.handle(IPC.iosInputKey, (_e, udid: string, domKey: string, modifiers: string[]) => {
    const bin = goios.findGoIos()
    if (bin && udid && domKey) iosinput.key(bin, udid, domKey, Array.isArray(modifiers) ? modifiers : [])
    return true
  })
  ipcMain.handle(IPC.iosInputButton, (_e, udid: string, name: string) => {
    const bin = goios.findGoIos()
    if (bin && udid) iosinput.button(bin, udid, name)
    return true
  })

  // --- network HTTP intercept ---------------------------------------------
  // Per-device wiring: adb (Android) vs go-ios (iOS). The proxy/MITM engine is
  // shared; only the DeviceWiring differs. Resolved per serial at start().
  const wiringFor = (serial: string): DeviceWiring | null => {
    const cb: WiringCallbacks = {
      onStatus: (message) => send(IPC.interceptStatus, message),
      onDisconnect: () => intercept?.stop()
    }
    if (isIos(serial)) {
      const bin = goios.findGoIos()
      return bin ? new IosWiring(bin, serial, cb) : null
    }
    const adb = findAdb()
    return adb ? new AndroidWiring(adb, serial, cb) : null
  }

  const ensureIntercept = (): InterceptService => {
    if (!intercept) {
      intercept = new InterceptService(wiringFor, {
        onFlows: (flows) => send(IPC.interceptFlows, flows),
        onStarted: (port) => send(IPC.interceptStarted, port),
        onStatus: (message) => send(IPC.interceptStatus, message),
        onFailed: (message) => send(IPC.interceptFailed, message)
      })
    }
    return intercept
  }

  ipcMain.handle(IPC.interceptStart, async (_e, serial: string, port: number, decrypt: boolean) => {
    if (!serial) {
      send(IPC.interceptFailed, 'No device selected')
      return false
    }
    await ensureIntercept().start(serial, port, decrypt)
    return true
  })

  ipcMain.handle(IPC.interceptStop, () => {
    intercept?.stop()
    return true
  })

  ipcMain.handle(IPC.interceptSetDecrypt, (_e, on: boolean) => {
    intercept?.setDecrypt(on)
    return true
  })

  ipcMain.handle(IPC.interceptInstallCert, async (_e, serial: string) => {
    if (!serial) return { ok: false, message: 'No device selected', dir: '' }
    return await ensureIntercept().installCert(serial)
  })

  ipcMain.handle(IPC.interceptDetail, (_e, id: number) => {
    return ensureIntercept().detail(id)
  })

  ipcMain.handle(IPC.interceptSaveBody, async (_e, id: number) => {
    const win = getWindow()
    if (!win || !intercept) return { ok: false, message: 'Intercept not running', dir: '' }
    const res = await dialog.showSaveDialog(win, {
      title: 'Save response body',
      defaultPath: join(homedir(), 'Downloads', ensureIntercept().bodyFileName(id))
    })
    if (res.canceled || !res.filePath) return { ok: false, message: 'cancelled', dir: '' }
    return intercept.saveBody(id, res.filePath)
  })

  ipcMain.handle(IPC.interceptDownloadFlow, async (_e, id: number) => {
    const win = getWindow()
    if (!win || !intercept) return { ok: false, message: 'Intercept not running', dir: '' }
    const res = await dialog.showSaveDialog(win, {
      title: 'Download request + response',
      defaultPath: join(homedir(), 'Downloads', ensureIntercept().exportFileName(id)),
      filters: [
        { name: 'Text', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return { ok: false, message: 'cancelled', dir: '' }
    return intercept.downloadFlow(id, res.filePath)
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

  // Stop background workers + kill every spawned device child (adb/go-ios tunnel, listen,
  // forward, …) when the window goes away AND on app quit. Registering on both matters:
  // window 'closed' covers closing the window while the app stays in the dock (macOS), and
  // 'before-quit' covers Cmd-Q — and, critically, fires even for a window opened AFTER this
  // ran (the 'closed' handler is bound to one window). Without the quit path, the go-ios
  // tunnel orphaned and kept the fixed port, so reopening hit "fixed port busy". Idempotent.
  let cleanedUp = false
  const cleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    // Release the single-instance lock as we start quitting (best-effort). Harmless
    // and tidy on the real-quit path.
    try {
      app.releaseSingleInstanceLock()
    } catch {
      /* not held / already released */
    }
    clearInterval(tunnelHeal)
    mirrorWin.destroy()
    deviceWatcher.stop()
    reader?.stop()
    for (const s of shellSessions.values()) s.shutdown()
    shellSessions.clear()
    monitor?.stop()
    leak?.shutdown()
    db?.shutdown()
    files?.shutdown()
    toolbox?.shutdown()
    mockloc?.shutdown()
    mirrorSvc?.shutdown()
    iosMirrorSvc?.shutdown()
    iosAirplaySvc?.shutdown()
    mlkMirrorSvc?.shutdown()
    aaSvc?.shutdown()
    iosinput.shutdown()
    intercept?.shutdown()
    iosDb?.shutdown()
    iosfiles.shutdown()
    goios.shutdownMock()
    goios.monitorStop()
    goios.syslogStop()
    goios.stopTunnel()
    devicekit.stop()
  }
  // Tear down ONLY on real app quit (Cmd-Q → before-quit), NOT on window close.
  // On macOS the app stays alive in the dock when its window closes (see index.ts
  // window-all-closed / activate / second-instance), keeping the go-ios tunnel and
  // device watchers up so reopening the window is instant and the tunnel is already
  // there. Tearing down on window 'closed' would leave the backend half-dead while
  // the process lingers, and registerIpc only runs once — the reopened window would
  // then have no working backend. So cleanup is bound to before-quit alone.
  app.on('before-quit', cleanup)
}
