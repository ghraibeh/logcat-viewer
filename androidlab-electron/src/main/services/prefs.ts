/**
 * SharedPreferences service. Faithful port of prefs.py's workers:
 *   - PrefListWorker -> list()   (run-as first, escalate to rooted `su`)
 *   - PrefLoadWorker -> load()   (exec-out cat, binary-clean → parse XML)
 *   - PrefSaveWorker -> save()   (build XML, write via `dd of=<path>` over stdin —
 *                                 the same private-write trick as files.ts/db.ts)
 *   - _force_stop    -> forceStop()
 *
 * The reached access mode (run-as vs su) is tracked per (serial|pkg) like
 * db.ts's suByApp, so load()/save() reuse whatever list() succeeded with.
 * All device work happens here in the main process; the renderer only sees JSON.
 */
import { execFile } from 'node:child_process'
import { run } from './adb'
import {
  buildPrefsXml,
  catPrefArgs,
  classifyPrefsList,
  lsPrefsArgs,
  parsePrefsXml,
  writePrefArgs,
  type Pref
} from '@core/prefs'
import type { PrefsListResult, PrefsLoadResult, PrefsSaveResult } from '@shared/types'

const appKey = (serial: string, pkg: string): string => `${serial} ${pkg}`

/** adb with SQL/XML fed on stdin (dd reads its payload from stdin). Mirrors
 *  db.ts's runWithInput; returns the exit code + decoded stderr. */
function runWithInput(
  adb: string,
  args: string[],
  input: Buffer,
  timeoutMs: number
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      adb,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err, _stdout, stderr) => {
        const code =
          err && typeof (err as { code?: number }).code === 'number'
            ? (err as { code: number }).code
            : err
              ? 1
              : 0
        resolve({ code, stderr: stderr ? (stderr as Buffer).toString('utf8') : '' })
      }
    )
    child.stdin?.end(input)
  })
}

export class PrefsService {
  private readonly suByApp = new Map<string, boolean>()

  constructor(private readonly adb: string) {}

  // --- listing (PrefListWorker: run-as → su escalation) -----------------------
  async list(serial: string, pkg: string): Promise<PrefsListResult> {
    const r1 = await run(this.adb, null, lsPrefsArgs(serial, pkg, false), 15000)
    const c1 = classifyPrefsList(r1.code ?? 1, r1.stdout, r1.stderr)
    if (c1.ok) {
      this.suByApp.set(appKey(serial, pkg), false)
      return { ok: true, files: c1.files, error: '', usedSu: false }
    }
    const r2 = await run(this.adb, null, lsPrefsArgs(serial, pkg, true), 15000)
    const c2 = classifyPrefsList(r2.code ?? 1, r2.stdout, r2.stderr)
    if (c2.ok) {
      this.suByApp.set(appKey(serial, pkg), true)
      return { ok: true, files: c2.files, error: '', usedSu: true }
    }
    return {
      ok: false,
      files: [],
      error:
        c1.error ||
        c2.error ||
        'cannot access shared_prefs (app must be debuggable, or device rooted)',
      usedSu: false
    }
  }

  // --- loading one file (PrefLoadWorker) --------------------------------------
  async load(serial: string, pkg: string, fname: string): Promise<PrefsLoadResult> {
    const su = this.suByApp.get(appKey(serial, pkg)) ?? false
    const r = await run(this.adb, null, catPrefArgs(serial, pkg, fname, su), 20000)
    if (r.code !== 0 && !r.stdout) {
      return { ok: false, error: (r.stderr || 'read failed').trim(), fname, prefs: [] }
    }
    return { ok: true, error: '', fname, prefs: parsePrefsXml(r.stdout) }
  }

  // --- saving (PrefSaveWorker: build XML → dd over stdin) ---------------------
  async save(serial: string, pkg: string, fname: string, prefs: Pref[]): Promise<PrefsSaveResult> {
    const su = this.suByApp.get(appKey(serial, pkg)) ?? false
    const xml = buildPrefsXml(prefs)
    const r = await runWithInput(
      this.adb,
      writePrefArgs(serial, pkg, fname, su),
      Buffer.from(xml, 'utf8'),
      30000
    )
    const err = r.stderr
    const low = err.toLowerCase()
    // dd reports its copy summary on stderr even on success.
    const ok = r.code === 0 && !low.includes('denied') && !low.includes('error')
    return { ok, error: ok ? '' : err.trim() || 'write failed' }
  }

  // --- force-stop so the app re-reads on next launch --------------------------
  async forceStop(serial: string, pkg: string): Promise<boolean> {
    const r = await run(this.adb, serial, ['shell', 'am', 'force-stop', pkg], 8000)
    return r.code === 0
  }
}
