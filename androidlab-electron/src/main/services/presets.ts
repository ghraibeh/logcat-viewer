/**
 * Named filter presets persisted as JSON in the app-support dir.
 * Faithful port of logtools.load_presets / save_presets. The file lives at
 * <userData>/filter_presets.json (main sets the app name to "AndroidLabKit", so
 * that resolves to ~/Library/Application Support/AndroidLabKit).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { PRESETS_FILE } from '@core/logtools'
import type { PresetMap } from '@shared/types'

function presetsPath(): string {
  return join(app.getPath('userData'), PRESETS_FILE)
}

/** {name: {field: value}} — empty on missing/corrupt file (never throws). */
export function loadPresets(): PresetMap {
  try {
    const data = JSON.parse(readFileSync(presetsPath(), 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as PresetMap) : {}
  } catch {
    return {}
  }
}

export function savePresets(presets: PresetMap): boolean {
  const path = presetsPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    // indent 2 + sorted keys — matches the Python file shape exactly.
    const sorted: PresetMap = {}
    for (const k of Object.keys(presets).sort()) sorted[k] = presets[k]
    writeFileSync(path, JSON.stringify(sorted, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}
