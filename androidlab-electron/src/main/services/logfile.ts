/**
 * Open a saved logcat file and export the (filtered/entire) buffer to text.
 * Faithful port of MainWindow.open_log_file / export_log (the fs + dialog side;
 * the renderer builds the export text via core/logtools.exportText and parses
 * opened files via core/parser.parseLine, exactly as ui.py does).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import type { OpenedLog, SaveResult } from '@shared/types'

export async function openLog(win: BrowserWindow): Promise<OpenedLog | null> {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open a saved logcat file',
    defaultPath: join(homedir(), 'Downloads'),
    properties: ['openFile'],
    filters: [
      { name: 'Log files', extensions: ['txt', 'log'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const path = res.filePaths[0]
  const content = readFileSync(path, 'utf8')
  return { path, content }
}

function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

export async function exportLog(
  win: BrowserWindow,
  kind: 'filtered' | 'full',
  text: string,
  lineCount: number
): Promise<SaveResult> {
  const defaultPath = join(homedir(), 'Downloads', `logcat-${kind}-${timestamp()}.txt`)
  const res = await dialog.showSaveDialog(win, {
    title: `Export ${kind} log (${lineCount.toLocaleString()} lines)`,
    defaultPath,
    filters: [{ name: 'Log files', extensions: ['txt', 'log'] }]
  })
  if (res.canceled || !res.filePath) {
    return { ok: false, message: 'cancelled', dir: '' }
  }
  try {
    writeFileSync(res.filePath, text, 'utf8')
  } catch (exc) {
    return { ok: false, message: `Export failed: ${exc instanceof Error ? exc.message : exc}`, dir: '' }
  }
  const base = res.filePath.split('/').pop() ?? res.filePath
  return {
    ok: true,
    message: `${lineCount.toLocaleString()} lines → ${base}`,
    dir: dirname(res.filePath)
  }
}
