/**
 * Crash & ANR service. Faithful port of crash.py's workers + settings:
 *   - CrashScanWorker   -> scan()        (crash buffer + all dropbox crash tags,
 *                                          merged, sorted newest-first)
 *   - MappingLoadWorker -> loadMapping()  (read + parse a mapping.txt)
 *   - retrace()          applies the loaded mapping to a trace on demand
 *   - load/save_last_mapping_path -> remembered across sessions in the app-support
 *     dir (crash_settings.json), matching the Python file.
 *
 * The parsed Mapping (potentially many MB / millions of entries) stays here in
 * the main process; the renderer requests retraced text on demand rather than
 * shipping the whole map across IPC.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { run } from './adb'
import {
  CRASH_TAGS,
  crashBufferArgs,
  dropboxPrintArgs,
  parseMapping,
  retrace,
  splitCrashBlocks,
  splitDropboxPrint,
  type CrashItem,
  type Mapping
} from '@core/crash'
import type { CrashScanResult, MappingLoadResult } from '@shared/types'

const SETTINGS_FILE = 'crash_settings.json'

function settingsPath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE)
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export class CrashService {
  private mapping: Mapping | null = null

  constructor(private readonly adb: string) {}

  // --- scan (CrashScanWorker) -------------------------------------------------
  async scan(serial: string): Promise<CrashScanResult> {
    let items: CrashItem[] = []
    try {
      const buf = await run(this.adb, null, crashBufferArgs(serial), 20000)
      items = items.concat(splitCrashBlocks(buf.stdout))
      for (const tag of CRASH_TAGS) {
        try {
          const r = await run(this.adb, null, dropboxPrintArgs(serial, tag), 20000)
          items = items.concat(splitDropboxPrint(r.stdout, tag))
        } catch {
          /* tag missing / redacted on this build — keep the rest */
        }
      }
    } catch (e) {
      return { ok: false, message: `crash scan failed: ${errMsg(e)}`, items: [] }
    }
    // Newest first (stable): dropbox timestamps are full dates, buffer intra-day.
    items.sort((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0))
    return { ok: true, message: `${items.length} record(s)`, items }
  }

  // --- mapping (MappingLoadWorker) --------------------------------------------
  async loadMapping(path: string): Promise<MappingLoadResult> {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch (e) {
      return { ok: false, path, classCount: 0, error: errMsg(e) }
    }
    const mp = parseMapping(text)
    const classCount = Object.keys(mp.classes).length
    if (classCount === 0) {
      return { ok: false, path, classCount: 0, error: 'no class mappings found' }
    }
    this.mapping = mp
    this.saveLastMappingPath(path)
    return { ok: true, path, classCount, error: '' }
  }

  /** Retrace `text` with the loaded mapping (returns it unchanged if none). */
  retrace(text: string): string {
    return this.mapping ? retrace(this.mapping, text) : text
  }

  // --- last-mapping-path persistence (crash_settings.json) --------------------
  lastMappingPath(): string {
    try {
      const data = JSON.parse(readFileSync(settingsPath(), 'utf8')) as { last_mapping?: string }
      const p = data.last_mapping ?? ''
      return p && existsSync(p) ? p : ''
    } catch {
      return ''
    }
  }

  private saveLastMappingPath(path: string): void {
    try {
      const p = settingsPath()
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, JSON.stringify({ last_mapping: path }), 'utf8')
    } catch {
      /* ignore */
    }
  }
}
