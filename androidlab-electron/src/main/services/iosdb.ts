/**
 * iOS Database Inspector backend. Reuses the SAME renderer (`DatabaseView`) and
 * the SAME sql.js snapshot readers as Android (`getSql`/`listTables`/
 * `readTablePage`/`runFreeQuery`, exported from services/db.ts) — only the
 * device I/O differs: databases are discovered + pulled from the app's container
 * via go-ios `fsync` (house-arrest AFC, no tunnel) instead of adb run-as.
 *
 * Read-only: iOS has no on-device `sqlite3` to write through, so `hasSqlite3` is
 * false and the edit path is disabled in the UI. Works for apps with File
 * Sharing enabled or your own dev-signed apps.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { PAGE_SIZE, QUERY_ROW_CAP, isSqliteFile } from '@core/db'
import { getSql, listTables, readTablePage, runFreeQuery } from './db'
import { containerPull, containerTree } from './goios'
import type { Database } from 'sql.js'
import type { DbListResult, DbOpenResult, DbRowsResult, SaveResult } from '@shared/types'

const SQLITE_EXT = /\.(sqlite3?|db)$/i
const SIDECAR = /-(wal|shm|journal)$/i

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
const errRows = (message: string): DbRowsResult => ({
  ok: false,
  cols: [],
  rows: [],
  total: -1,
  truncated: false,
  rowids: null,
  message
})

export class IosDbService {
  private tmpDir: string | null = null
  private readonly snapshots = new Map<string, string>() // (udid|pkg|name) -> local path
  private seq = 0

  constructor(private readonly bin: string) {}

  private tmp(): string {
    if (!this.tmpDir) this.tmpDir = mkdtempSync(join(tmpdir(), 'androidlab-iosdb-'))
    return this.tmpDir
  }

  // --- list databases in the app container (fsync tree) -----------------------
  async list(udid: string, pkg: string): Promise<DbListResult> {
    const t = await containerTree(this.bin, udid, pkg, '.')
    if (!t.ok) return { ok: false, dbs: [], message: t.error, usedSu: false, hasSqlite3: false }
    const dbs = t.entries
      .filter((e) => !e.isDir && SQLITE_EXT.test(e.name) && !SIDECAR.test(e.name))
      .map((e) => e.path)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return {
      ok: true,
      dbs,
      message: dbs.length ? `${dbs.length} database(s)` : 'No SQLite databases found in this app’s container',
      usedSu: false,
      hasSqlite3: false // no on-device sqlite3 → read-only (UI hides editing)
    }
  }

  // --- pull a snapshot (fsync pull drops the file into a dir; see goios) -------
  private async ensureSnapshot(udid: string, pkg: string, name: string, force: boolean): Promise<string | null> {
    const key = `${udid}|${pkg}|${name}`
    const cached = this.snapshots.get(key)
    if (cached && !force && existsSync(cached)) return cached
    const dir = join(this.tmp(), String(this.seq++))
    const inner = await containerPull(this.bin, udid, pkg, name, dir)
    if (inner) this.snapshots.set(key, inner)
    return inner
  }

  async open(udid: string, pkg: string, name: string, force = false): Promise<DbOpenResult> {
    const path = await this.ensureSnapshot(udid, pkg, name, force)
    if (!path) return { ok: false, name, tables: [], message: `Couldn't read '${name}' from the container` }
    const bytes = readFileSync(path)
    if (!isSqliteFile(bytes)) {
      return { ok: false, name, tables: [], message: `'${basename(name)}' is not a SQLite database` }
    }
    try {
      const SQL = await getSql()
      const db = new SQL.Database(bytes)
      try {
        const tables = listTables(db)
        return { ok: true, name, tables, message: `${basename(name)}: ${tables.length} table(s)` }
      } finally {
        db.close()
      }
    } catch (e) {
      return { ok: false, name, tables: [], message: `Couldn't open '${basename(name)}': ${errMsg(e)}` }
    }
  }

  private async withDb<T>(udid: string, pkg: string, name: string, fn: (db: Database) => T): Promise<T | { __err: string }> {
    const path = this.snapshots.get(`${udid}|${pkg}|${name}`)
    if (!path || !existsSync(path)) return { __err: `'${basename(name)}' is not connected — open it first` }
    try {
      const SQL = await getSql()
      const db = new SQL.Database(readFileSync(path))
      try {
        db.run('PRAGMA query_only = ON')
        return fn(db)
      } finally {
        db.close()
      }
    } catch (e) {
      return { __err: errMsg(e) }
    }
  }

  async readTable(udid: string, pkg: string, name: string, table: string, limit: number, offset: number): Promise<DbRowsResult> {
    const r = await this.withDb(udid, pkg, name, (db) => readTablePage(db, table, limit || PAGE_SIZE, offset))
    if ('__err' in r) return errRows(r.__err)
    return { ok: true, cols: r.cols, rows: r.rows, total: r.total, truncated: false, rowids: r.rowids, message: '' }
  }

  async runQuery(udid: string, pkg: string, name: string, sql: string): Promise<DbRowsResult> {
    const r = await this.withDb(udid, pkg, name, (db) => runFreeQuery(db, sql, QUERY_ROW_CAP))
    if ('__err' in r) return errRows(r.__err)
    return { ok: true, cols: r.cols, rows: r.rows, total: -1, truncated: r.truncated, rowids: null, message: '' }
  }

  async exportDb(udid: string, pkg: string, name: string, destPath: string): Promise<SaveResult> {
    const path = await this.ensureSnapshot(udid, pkg, name, false)
    if (!path) return { ok: false, message: `Couldn't read '${name}' from the container`, dir: '' }
    try {
      const SQL = await getSql()
      const db = new SQL.Database(readFileSync(path))
      try {
        writeFileSync(destPath, db.export())
      } finally {
        db.close()
      }
    } catch (e) {
      return { ok: false, message: `Export failed: ${errMsg(e)}`, dir: '' }
    }
    let size = 0
    try {
      size = statSync(destPath).size
    } catch {
      size = 0
    }
    return { ok: true, message: `Exported ${basename(destPath)} (${Math.round(size / 1024)} KB)`, dir: dirname(destPath) }
  }

  shutdown(): void {
    if (this.tmpDir) {
      try {
        rmSync(this.tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
      this.tmpDir = null
    }
    this.snapshots.clear()
  }
}
