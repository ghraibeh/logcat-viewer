/**
 * Main process entry: app lifecycle + the single main window.
 * Equivalent of logcat_viewer/__main__.py + the QMainWindow shell in ui.py.
 */
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { app, BrowserWindow, nativeImage, session, shell } from 'electron'
import { registerIpc } from './ipc'
import { buildAppMenu } from './menu'
import { IPC } from '@shared/ipc'

// app.name drives the app-support dir (~/Library/Application Support/MobileLabKit)
// and the menu-bar / dock name on macOS.
app.setName('MobileLabKit')
app.setAboutPanelOptions({
  applicationName: 'MobileLabKit',
  applicationVersion: app.getVersion(),
  copyright: 'Copyright © 2026 Mahmoud Alghraibeh'
})

// The committed app icon (build/icon.png). Used for the window icon everywhere
// and the dock icon in dev — a packaged .app gets its icon from the bundle, but
// while running via `electron .` the process is Electron.app, so its dock icon
// (and menu-bar name) would otherwise be Electron's. See scripts/patch-dev-name.js.
const iconPath = join(app.getAppPath(), 'build', 'icon.png')

let mainWindow: BrowserWindow | null = null
const getWindow = (): BrowserWindow | null => mainWindow

/**
 * macOS: strip `com.apple.quarantine` from our own app bundle at startup.
 *
 * When the app is delivered to another Mac (DMG / download / AirDrop), macOS
 * stamps `com.apple.quarantine` on EVERY nested file. Right-click→Open (or
 * clearing quarantine on the .app) only un-quarantines the app's MAIN executable —
 * the bundled helper binaries (go-ios, adb, scrcpy-server, iosscreen, airplayscreen
 * and their dylibs) stay quarantined. macOS AMFI then SIGKILLs any of them the
 * instant we spawn it (the child dies with exit 137), even though its ad-hoc code
 * signature is valid. That is exactly why the developer tunnel "can't start" on a
 * machine other than the one that built it: `go-ios tunnel start` is killed before
 * it can bind the fixed port.
 *
 * We are already running (the user approved the app), so we can clear quarantine
 * from our own bundle. Recursive, best-effort, synchronous (must finish before the
 * first device poll spawns a helper). Absolute `xattr` path so it works under the
 * minimal PATH a Finder-launched app inherits. Notarization is the "proper" fix,
 * but this makes an un-notarized ad-hoc build fully self-healing on any Mac.
 */
function clearBundledQuarantine(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  // process.resourcesPath = <App>.app/Contents/Resources → the .app bundle is two up.
  const appBundle = join(process.resourcesPath, '..', '..')
  try {
    execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appBundle], { timeout: 10000 })
  } catch {
    /* xattr missing, or nothing quarantined — spawns still work if already clean */
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#16171c',
    title: 'MobileLabKit',
    icon: iconPath,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Location tab hosts the MapLibre map in an isolated <webview> guest with
      // its OWN CSP (set in map.html), so the strict main-window CSP stays intact.
      webviewTag: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Desktop-tool feel: no accidental pinch / Ctrl-wheel page zoom.
  mainWindow.webContents.on('did-finish-load', () => {
    void mainWindow?.webContents.setVisualZoomLevelLimits(1, 1)
    mainWindow?.webContents.setZoomFactor(1)
  })

  // Security: never let the renderer open new windows or navigate away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (process.env.ANDROIDLAB_SMOKE === 'inspector') runInspectorSmoke(mainWindow)
  else if (process.env.ANDROIDLAB_SMOKE) runSmoke(mainWindow)
}

/**
 * Live Inspector reproduction: capture from the attached device, then dispatch
 * real clicks on the screenshot and measure the canvas height after each to
 * prove it doesn't grow/zoom. Runs with ANDROIDLAB_SMOKE=inspector.
 */
function runInspectorSmoke(win: BrowserWindow): void {
  const errors: string[] = []
  const watchdog = setTimeout(() => {
    console.log('INSP TIMEOUT')
    app.exit(2)
  }, 30000)
  app.on('before-quit', () => clearTimeout(watchdog))
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message)
  })
  const js = <T>(code: string): Promise<T> => win.webContents.executeJavaScript(code) as Promise<T>
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const canvasH = (): Promise<number> =>
    js<number>(
      `Math.round((document.querySelector('.insp-view canvas')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height)`
    )

  win.webContents.on('did-finish-load', async () => {
    await sleep(1000)
    await js(`[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Inspector')?.click()`)
    await sleep(400)
    const winH = await js<number>('window.innerHeight')
    const heights: number[] = [await canvasH()]
    // Click the Capture button (first button in the inspector bar).
    await js(`document.querySelector('.insp-bar button')?.click()`)
    // Poll up to ~8s for the hierarchy tree to populate.
    let nodes = 0
    for (let i = 0; i < 40; i++) {
      await sleep(200)
      nodes = await js<number>(`document.querySelectorAll('.insp-node').length`)
      if (nodes > 0) break
    }
    await sleep(500)
    heights.push(await canvasH())
    const snap = (): Promise<string> =>
      js<string>(
        `JSON.stringify(['toolbar','tabbar','insp-view','insp-bar','insp-split','insp-canvas-wrap','insp-right','status-bar'].map(c=>{const e=document.querySelector('.'+c);return [c, e?Math.round(e.getBoundingClientRect().height):-1]}).concat([['docScrollTop',Math.round(document.documentElement.scrollTop)],['bodyH',Math.round(document.body.getBoundingClientRect().height)]]))`
      )
    console.log('INSP snap pre-click: ' + (await snap()))
    // Dispatch three real clicks on the screenshot canvas.
    for (let i = 0; i < 3; i++) {
      await js(`(()=>{const c=document.querySelector('.insp-view canvas');if(!c)return;const r=c.getBoundingClientRect();c.dispatchEvent(new MouseEvent('click',{clientX:r.left+r.width/2,clientY:r.top+r.height*0.4,bubbles:true}));})()`)
      await sleep(400)
      heights.push(await canvasH())
    }
    console.log('INSP snap post-click: ' + (await snap()))
    const selected = await js<number>(`document.querySelectorAll('.insp-node.selected').length`)
    const maxJump = heights.slice(1).reduce((m, h, i) => Math.max(m, h - heights[i]), 0)
    const stable = maxJump <= 2 && heights[heights.length - 1] < winH && heights[0] > 0
    console.log(`INSP winH=${winH} heights=${heights.join(',')} nodes=${nodes} selected=${selected} errors=${errors.length}`)
    console.log(stable && nodes > 0 ? 'INSP PASS' : 'INSP FAIL')
    app.exit(stable && nodes > 0 ? 0 : 1)
  })
}

/**
 * Offline end-to-end smoke: boot the window, capture renderer console errors,
 * push synthetic threadtime lines through the real logcat IPC channel, then
 * read back how many rows the virtualized table rendered. Exits non-zero on any
 * renderer error or if no rows appear. Runs only when ANDROIDLAB_SMOKE is set.
 */
function runSmoke(win: BrowserWindow): void {
  const errors: string[] = []
  const watchdog = setTimeout(() => {
    console.log('SMOKE TIMEOUT (window never finished loading)')
    console.log('SMOKE FAIL')
    app.exit(2)
  }, 15000)
  app.on('before-quit', () => clearTimeout(watchdog))
  win.webContents.on('console-message', (_e, level, message) => {
    // levels: 0=log 1=warning 2=error 3=info
    if (level >= 2) errors.push(message)
    console.log(`[renderer] ${message}`)
  })
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`render-process-gone: ${d.reason}`))
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`did-fail-load ${code} ${desc}`))

  const sample = [
    '07-09 14:23:01.123  1234  1250 D BActivityThread: smoke debug line',
    '07-09 14:23:01.200  1234  1250 I System.out: hello from smoke',
    '07-09 14:23:01.300  1234  1250 W ActivityManager: a warning',
    '07-09 14:23:01.400  1234  1250 E AndroidRuntime: an error line',
    '--------- beginning of crash'
  ]

  const monitorSample = {
    cpu: 50,
    mem: [3_000_000, 8_000_000],
    load: [1.2, 1.0, 0.8],
    cores: 2,
    coresPct: [40, 60],
    battery: { level: 80, tempC: 30.0, powered: false },
    gfx: null,
    app: null
  }

  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      win.webContents.send(IPC.logcatLines, sample)
      setTimeout(async () => {
        const rows = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.log-row').length`
        )) as number
        const first = (await win.webContents.executeJavaScript(
          `(document.querySelector('.log-row .cell.msg')||{}).textContent || ''`
        )) as string

        // Switch to the Monitor tab, push a sample, read the CPU readout.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Monitor')?.click()`
        )
        await new Promise((r) => setTimeout(r, 200))
        win.webContents.send(IPC.monitorSample, monitorSample)
        await new Promise((r) => setTimeout(r, 400))
        const monCpu = (await win.webContents.executeJavaScript(
          `(document.querySelector('.mon-value')||{}).textContent || ''`
        )) as string
        const hasSpark = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('canvas.spark').length`
        )) as number

        // Switch to the Inspector tab; verify the view + canvas mount.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Inspector')?.click()`
        )
        // Poll for the Inspector canvas to mount (avoids a fixed-wait flake).
        let inspReady = 0
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 150))
          inspReady = (await win.webContents.executeJavaScript(
            `document.querySelectorAll('.insp-view canvas').length`
          )) as number
          if (inspReady >= 1) break
        }
        // Regression guard for the "sliding down" bug: canvas height must be
        // stable across frames and fit within the window.
        const h1 = (await win.webContents.executeJavaScript(
          `Math.round((document.querySelector('.insp-view canvas')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height)`
        )) as number
        await new Promise((r) => setTimeout(r, 500))
        const h2 = (await win.webContents.executeJavaScript(
          `Math.round((document.querySelector('.insp-view canvas')||{getBoundingClientRect:()=>({height:0})}).getBoundingClientRect().height)`
        )) as number
        const winH = (await win.webContents.executeJavaScript(`window.innerHeight`)) as number
        const inspStable = h1 > 0 && Math.abs(h1 - h2) <= 1 && h1 < winH

        // Switch to Controls; verify the settings cards + switches mount.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Controls')?.click()`
        )
        await new Promise((r) => setTimeout(r, 200))
        const ctrlSwitches = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.ctrl-view .switch').length`
        )) as number

        // Switch to Databases; verify the DB view mounts.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Databases')?.click()`
        )
        await new Promise((r) => setTimeout(r, 200))
        const dbReady = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.db-view').length`
        )) as number

        // Switch to Files; verify the explorer command bar mounts.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Files')?.click()`
        )
        await new Promise((r) => setTimeout(r, 200))
        const filesReady = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.files-cmdbar').length`
        )) as number

        // Switch to Toolbox; verify the sub-tabbed view mounts.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Toolbox')?.click()`
        )
        await new Promise((r) => setTimeout(r, 200))
        const toolboxReady = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.tb-view').length`
        )) as number

        // Switch to Apps; verify the manager + its Prefs / Crashes sub-tabs mount.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim().replace(/\\s*●$/,'')==='Apps')?.click()`
        )
        await new Promise((r) => setTimeout(r, 250))
        const appsReady = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.am-view').length`
        )) as number
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.am-tabs .tab')].find(t=>t.textContent.trim().startsWith('Prefs'))?.click()`
        )
        await new Promise((r) => setTimeout(r, 200))
        const prefsReady = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.prefs-view').length`
        )) as number
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.am-tabs .tab')].find(t=>t.textContent.trim().startsWith('Crashes'))?.click()`
        )
        await new Promise((r) => setTimeout(r, 200))
        const crashReady = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.crash-view').length`
        )) as number

        // Switch to Location; verify the mock-GPS chrome (coordinate controls)
        // mounts. The map <webview> is NOT required to load — this only asserts
        // the view + its two Lat/Lng inputs render with no HOST console errors.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Location')?.click()`
        )
        await new Promise((r) => setTimeout(r, 300))
        const locReady = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.loc-view .loc-bar').length && document.querySelectorAll('.loc-view .loc-input').length>=2 ? 1 : 0`
        )) as number

        // Switch to Shell; verify the xterm terminal mounts (no device in smoke,
        // so it never spawns adb/node-pty — this only asserts the view renders).
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Shell')?.click()`
        )
        await new Promise((r) => setTimeout(r, 300))
        const shellReady = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.shell-view .shell-term .xterm').length`
        )) as number
        // Open a second shell session and verify both panes/tabs mount (the
        // multi-tab feature): each pane keeps its own xterm + pty.
        await win.webContents.executeJavaScript(`document.querySelector('.shell-tab-add')?.click()`)
        await new Promise((r) => setTimeout(r, 300))
        const shellPanes = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.shell-view .shell-panes .shell-pane .xterm').length`
        )) as number
        const shellTabs = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.shell-view .shell-tabs .shell-tab').length`
        )) as number
        // Rename the first tab: double-click → type → Enter, then verify the label.
        await win.webContents.executeJavaScript(
          `document.querySelector('.shell-view .shell-tab')?.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`
        )
        await new Promise((r) => setTimeout(r, 150))
        await win.webContents.executeJavaScript(`
          (() => {
            const inp = document.querySelector('.shell-view .shell-tab .rename');
            if (!inp) return;
            const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
            set.call(inp, 'Renamed');
            inp.dispatchEvent(new Event('input',{bubbles:true}));
            inp.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
          })()
        `)
        await new Promise((r) => setTimeout(r, 150))
        const shellRenamed = (await win.webContents.executeJavaScript(
          `(document.querySelector('.shell-view .shell-tab .label')||{}).textContent === 'Renamed' ? 1 : 0`
        )) as number

        // Switch to Network HTTP; verify the intercept chrome (filter bar +
        // flow table + Enable button) mounts. No device in smoke, so the proxy
        // never binds a port / generates a CA / hits the network — this only
        // asserts the view renders with no HOST renderer errors.
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('.tab')].find(t=>t.textContent.trim()==='Network HTTP')?.click()`
        )
        await new Promise((r) => setTimeout(r, 300))
        const networkReady = (await win.webContents.executeJavaScript(
          `document.querySelectorAll('.net-view .net-filter').length && document.querySelectorAll('.net-view .net-table').length && document.querySelectorAll('.net-view .net-enable').length ? 1 : 0`
        )) as number

        console.log(
          `SMOKE rows=${rows} first=${JSON.stringify(first)} monCpu=${JSON.stringify(monCpu)} sparks=${hasSpark} insp=${inspReady} stable=${inspStable} ctrl=${ctrlSwitches} db=${dbReady} files=${filesReady} toolbox=${toolboxReady} apps=${appsReady} prefs=${prefsReady} crash=${crashReady} location=${locReady} shell=${shellReady} shellPanes=${shellPanes} shellTabs=${shellTabs} shellRenamed=${shellRenamed} network=${networkReady} errors=${errors.length}`
        )
        if (errors.length) console.log('SMOKE ERRORS:\n' + errors.join('\n'))
        const ok =
          rows === 4 &&
          first.length > 0 &&
          monCpu.includes('50%') &&
          hasSpark >= 4 &&
          inspReady >= 1 &&
          inspStable &&
          ctrlSwitches >= 10 &&
          dbReady >= 1 &&
          filesReady >= 1 &&
          toolboxReady >= 1 &&
          appsReady >= 1 &&
          prefsReady >= 1 &&
          crashReady >= 1 &&
          shellReady >= 1 &&
          shellPanes >= 2 &&
          shellTabs >= 2 &&
          shellRenamed === 1 &&
          networkReady >= 1 &&
          errors.length === 0
        console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL')
        app.exit(ok ? 0 : 1)
      }, 800)
    }, 400)
  })
}

// Single-instance lock. A second copy of the app (classically: the dev build
// launched while the installed .app is already open) would spawn its OWN go-ios
// tunnel agent and fight the first over the fixed tunnel port (60105) — the
// "fixed port busy" failure when opening iOS apps. Refuse to start a second
// instance and just focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // A relaunch (double-click / dock) while we're already running. Focus the
    // existing window, or re-create it if the user had closed it (macOS keeps us
    // alive with no window) — this is the reopen path, and it reuses the live
    // backend + tunnel rather than starting a second process.
    const win = getWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    } else {
      createWindow()
    }
  })

  app.whenReady().then(() => {
    // FIRST: un-quarantine our bundled helper binaries so spawning go-ios/adb/etc.
    // isn't SIGKILLed by macOS on a machine other than the one that built the app.
    // Must run before registerIpc/createWindow — the renderer's first device poll
    // spawns go-ios. See clearBundledQuarantine().
    clearBundledQuarantine()

    // In dev the process is Electron.app, so the dock shows Electron's icon —
    // override it. A packaged .app already carries build/icon.icns in its bundle.
    if (process.platform === 'darwin' && !app.isPackaged) {
      const img = nativeImage.createFromPath(iconPath)
      if (!img.isEmpty()) app.dock?.setIcon(img)
    }

    // Grant microphone access to our own renderer — the Android Auto head unit captures the
    // Mac's mic (getUserMedia) and streams it to the phone for Assistant/voice. macOS still
    // gates this behind its own TCC prompt (NSMicrophoneUsageDescription); this just stops
    // Chromium from auto-denying the in-page request.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
      cb(permission === 'media')
    })
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
      return permission === 'media'
    })

    registerIpc(getWindow)
    buildAppMenu(getWindow)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

// Standard macOS lifecycle: closing the window does NOT quit the app — it stays
// alive in the dock and reopening just re-shows the window (see 'activate' and
// 'second-instance', which createWindow when none is open). This is deliberate for
// THIS app: it owns a long-lived go-ios developer tunnel (fixed port 60105) plus
// device watchers/proxies. Quitting on close and re-launching a fresh process ran
// into a single-instance-lock race — reopening while the old instance was still
// shutting down hit !requestSingleInstanceLock() and quit silently ("close then
// reopen stopped working"). Staying alive means there's only ever ONE process and
// the tunnel stays up across a window close, so reopening is instant and the tunnel
// is already there. Everything is torn down on real quit (Cmd-Q → before-quit →
// cleanup), NOT on window close — so the backend is never left half-alive. On
// Windows/Linux, keep the convention of quitting when the last window closes.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
