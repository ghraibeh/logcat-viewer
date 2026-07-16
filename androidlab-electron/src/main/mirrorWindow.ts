/**
 * The detached screen-mirror window (Android Studio-style pop-out).
 *
 * A second, slim `BrowserWindow` that loads the same renderer bundle at the
 * `#mirror` route — the renderer entry (`main.tsx`) sees that hash and mounts
 * `<MirrorWindow>` (just the mirror dock) instead of the full app shell. The
 * mirror feed itself is unchanged: `ipc.ts` broadcasts the `mirror:*` frame/
 * H.264 events to *all* windows, so whichever window currently hosts the dock
 * receives them (only one does at a time — the main window unmounts its dock
 * while popped out).
 *
 * This class owns just the window lifecycle + the "which device" handshake:
 * the main window pushes a `MirrorPopoutInfo` on open and on every device
 * switch; the popout reads it on mount and via `onPopoutInfo`. When the window
 * closes (native X or the dock-back button) it fires `notifyRedock` so the main
 * window re-attaches the in-app dock — unless the close was an explicit full
 * close initiated from the main window (see `close(false)`).
 */
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { MirrorPopoutInfo } from '@shared/types'

const iconPath = join(app.getAppPath(), 'build', 'icon.png')

export class MirrorWindowManager {
  private win: BrowserWindow | null = null
  private info: MirrorPopoutInfo = { serial: null, platform: 'android' }
  /** Set when the main window initiates a full close so the `closed` handler
   *  does NOT ask the main window to re-dock. */
  private suppressRedock = false

  /** @param notifyRedock called when the popout closes and the mirror should
   *  return to the in-app dock. */
  constructor(private readonly notifyRedock: () => void) {}

  isOpen(): boolean {
    return !!this.win && !this.win.isDestroyed()
  }

  getInfo(): MirrorPopoutInfo {
    return this.info
  }

  /** Open the popout for `info` (or focus + retarget an already-open one). */
  open(info: MirrorPopoutInfo): void {
    this.info = info
    if (this.isOpen()) {
      this.pushInfo()
      this.win!.focus()
      return
    }
    const win = new BrowserWindow({
      width: 420,
      height: 860,
      minWidth: 300,
      minHeight: 480,
      show: false,
      backgroundColor: '#16171c',
      title: 'Screen Mirror — AndroidLabKit',
      icon: iconPath,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    this.win = win

    win.on('ready-to-show', () => win.show())
    win.webContents.on('did-finish-load', () => {
      void win.webContents.setVisualZoomLevelLimits(1, 1)
      win.webContents.setZoomFactor(1)
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e) => e.preventDefault())

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) void win.loadURL(`${devUrl}#mirror`)
    else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'mirror' })

    win.on('closed', () => {
      this.win = null
      const suppressed = this.suppressRedock
      this.suppressRedock = false
      if (!suppressed) this.notifyRedock()
    })
  }

  /** Retarget an open popout at a new device (main window switched device). */
  update(info: MirrorPopoutInfo): void {
    this.info = info
    this.pushInfo()
  }

  private pushInfo(): void {
    if (this.isOpen()) this.win!.webContents.send(IPC.mirrorPopoutInfoEvent, this.info)
  }

  /** Close the window. `redock` re-attaches the in-app dock; `false` is a full
   *  close initiated from the main window (no re-dock). */
  close(redock: boolean): void {
    if (!this.isOpen()) return
    this.suppressRedock = !redock
    this.win!.close()
  }

  /** Tear down without re-docking (app/main-window shutting down). */
  destroy(): void {
    this.suppressRedock = true
    if (this.isOpen()) this.win!.destroy()
    this.win = null
  }
}
