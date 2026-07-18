/**
 * Native application menu.
 * Faithful port of MainWindow._build_menu: File -> Open Log File (Cmd+O) /
 * Export Filtered (Cmd+E) / Export Entire, and Help/App -> About MobileLabKit.
 * Menu clicks forward a MenuAction to the renderer, which runs the same flow
 * ui.py ran on those actions.
 */
import { Menu, app, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/ipc'
import type { MenuAction } from '@shared/types'

export function buildAppMenu(getWindow: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin'

  const send = (action: MenuAction): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.menuAction, action)
  }

  const aboutItem: MenuItemConstructorOptions = {
    label: `About ${app.name}`,
    click: () => send('about')
  }

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        aboutItem,
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: 'File',
    submenu: [
      { label: 'Open Log File…', accelerator: 'CmdOrCtrl+O', click: () => send('open-log') },
      {
        label: 'Export Filtered Log…',
        accelerator: 'CmdOrCtrl+E',
        click: () => send('export-filtered')
      },
      { label: 'Export Entire Log…', click: () => send('export-entire') },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  })

  template.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => send('find') }
    ]
  })

  template.push({
    label: 'View',
    submenu: [
      { label: 'Clear Log', accelerator: 'CmdOrCtrl+K', click: () => send('clear-log') },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  })

  template.push({
    role: 'window',
    submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(isMac ? [{ role: 'front' as const }] : [])]
  })

  template.push({
    role: 'help',
    submenu: isMac ? [] : [aboutItem]
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
