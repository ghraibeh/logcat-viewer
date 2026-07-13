/**
 * Log session tools: export the (filtered) buffer to text, and named
 * filter-preset field definitions. Pure helpers (Qt-free / fs-free) — the
 * file persistence lives in the main process (see services/presets.ts).
 * Faithful port of logcat_viewer/logtools.py.
 */
import type { LogEntry } from './parser'

export const PRESETS_FILE = 'filter_presets.json'

/** Keys the filter bar round-trips through a preset (all strings/bools/int). */
export const PRESET_FIELDS = [
  'min_priority',
  'text',
  'text_regex',
  'tag',
  'tag_regex',
  'pids',
  'exclude',
  'exclude_regex'
] as const

export type PresetField = (typeof PRESET_FIELDS)[number]
export type PresetValues = Partial<Record<PresetField, string | number | boolean>>

function pad(n: number, width: number): string {
  return String(n).padStart(width, ' ')
}

/**
 * One threadtime-shaped text line for a LogEntry (raw when we have it, so an
 * exported file round-trips through parseLine unchanged).
 */
export function entryLine(e: LogEntry): string {
  return e.raw || `${e.time} ${pad(e.pid, 5)} ${pad(e.tid, 5)} ${e.level} ${e.tag}: ${e.msg}`
}

export function exportText(entries: LogEntry[]): string {
  return entries.map(entryLine).join('\n') + (entries.length > 0 ? '\n' : '')
}

/** Keep only known fields (forward/backward-compatible preset files). */
export function cleanPreset(values: Record<string, unknown>): PresetValues {
  const out: PresetValues = {}
  for (const k of PRESET_FIELDS) {
    if (k in values) {
      out[k] = values[k] as string | number | boolean
    }
  }
  return out
}
