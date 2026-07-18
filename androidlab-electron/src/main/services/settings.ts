/**
 * App settings persisted as JSON in the app-support dir (same pattern as
 * presets.ts). Currently just the iOS auto-Wi-Fi behavior; grows as needed.
 * Reads never throw — a missing/corrupt file falls back to defaults.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AppSettings } from '@shared/types'

const DEFAULTS: AppSettings = { autoWifi: true, wifiOptOut: [] }

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Partial<AppSettings>
    return {
      autoWifi: typeof raw.autoWifi === 'boolean' ? raw.autoWifi : DEFAULTS.autoWifi,
      wifiOptOut: Array.isArray(raw.wifiOptOut)
        ? raw.wifiOptOut.filter((s): s is string => typeof s === 'string')
        : []
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Merge a partial patch over the current settings and persist. Returns the
 *  merged result so callers/renderer stay in sync without a re-read. */
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...loadSettings(), ...patch }
  const path = settingsPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* best-effort — settings are non-critical */
  }
  return next
}
