/**
 * App Manager service. Faithful port of appmgr.py's workers:
 *   - AppListWorker    -> list()        (pm list packages -f -i -U + system/disabled sets)
 *   - AppDetailWorker  -> detail()      (dumpsys + appops + APK/data/cache sizes + running)
 *   - AppActionWorker  -> action()      (generic one-shot for every state-changing op —
 *                                        the renderer sends the adb argv, like controls.ts)
 *   - ClearCacheWorker -> clearCache()  (pm --cache-only → run-as rm → su rm chain)
 *   - BulkPermWorker   -> bulkPerms()   (Grant all / Revoke all runtime perms)
 *   - AppIconWorker    -> icon()        (unzip -l/-p an APK → densest raster ic_launcher)
 *   - PullWorker       -> extractApk()  (pm path → adb pull base + splits to ~/Downloads/<pkg>)
 *
 * All device work happens here in the main process; the renderer only sees JSON.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { run, runBinary } from './adb'
import {
  appopsGetArgs,
  buildAppList,
  clearCacheArgs,
  dumpsysArgs,
  duArgs,
  grantArgs,
  humanBytes,
  listFilteredArgs,
  listPackagesArgs,
  opOk,
  parseApkPaths,
  parseAppDetail,
  parsePackageNames,
  parseRunningServices,
  parseZipEntries,
  pickLauncherIcon,
  pmPathArgs,
  revokeArgs,
  runasClearCacheArgs,
  runningServicesArgs,
  statSizeArgs,
  suClearCacheArgs,
  unzipExtractArgs,
  unzipListArgs
} from '@core/appmgr'
import type {
  AppActionResult,
  AppDetailResult,
  AppListResult,
  IconResult,
  SaveResult
} from '@shared/types'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** last line of trimmed output, or a fallback (mirrors `detail[-1] if detail`). */
function lastLine(stderr: string, stdout: string, fallback: string): string {
  const out = (stderr || stdout || '').trim()
  if (!out) return fallback
  const lines = out.split('\n')
  return lines[lines.length - 1]
}

/** ~/Downloads if it exists, else ~ (mirrors the shared dest logic). */
function downloadsDir(): string {
  const d = join(homedir(), 'Downloads')
  return existsSync(d) ? d : homedir()
}

/** Sniff a raster image's mime from magic bytes (icons are png/webp). */
function imageMime(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  return null
}

export class AppMgrService {
  constructor(private readonly adb: string) {}

  // --- app list (AppListWorker) -----------------------------------------------
  async list(serial: string): Promise<AppListResult> {
    let det = await run(this.adb, null, listPackagesArgs(serial, true), 25000)
    if (det.code !== 0 || !det.stdout.includes('package:')) {
      det = await run(this.adb, null, listPackagesArgs(serial, false), 25000)
    }
    const system = parsePackageNames((await run(this.adb, null, listFilteredArgs(serial, '-s'), 25000)).stdout)
    const disabled = parsePackageNames((await run(this.adb, null, listFilteredArgs(serial, '-d'), 25000)).stdout)
    const apps = buildAppList(det.stdout, system, disabled)
    if (apps.length === 0) {
      return { ok: false, apps: [], error: (det.stderr || 'No packages returned').trim() }
    }
    return { ok: true, apps, error: '' }
  }

  // --- app detail (AppDetailWorker) -------------------------------------------
  async detail(serial: string, pkg: string, apkPath: string): Promise<AppDetailResult> {
    const dump = (await run(this.adb, null, dumpsysArgs(serial, pkg), 25000)).stdout
    const ops = await run(this.adb, null, appopsGetArgs(serial, pkg, true), 25000)
    let opsOut = ops.stdout
    if (ops.code !== 0 || !opsOut.trim()) {
      opsOut = (await run(this.adb, null, appopsGetArgs(serial, pkg, false), 25000)).stdout
    }
    if (dump.includes('Unable to find package') || !dump.trim()) {
      return { ok: false, detail: null, error: `Package ${pkg} not found` }
    }
    const detail = parseAppDetail(pkg, dump, opsOut)
    detail.general.apkSize = apkPath ? await this.statSize(serial, apkPath) : ''
    detail.general.dataSize = await this.du(serial, pkg, '.')
    detail.general.cacheSize = await this.du(serial, pkg, 'cache')
    const r = await run(this.adb, null, runningServicesArgs(serial, pkg), 10000)
    detail.running = parseRunningServices(r.stdout)
    return { ok: true, detail, error: '' }
  }

  private async statSize(serial: string, apkPath: string): Promise<string> {
    const r = await run(this.adb, null, statSizeArgs(serial, apkPath), 8000)
    const v = r.stdout.trim()
    return /^\d+$/.test(v) ? humanBytes(parseInt(v, 10)) : ''
  }

  private async du(serial: string, pkg: string, sub: string): Promise<string> {
    const r = await run(this.adb, null, duArgs(serial, pkg, sub), 8000)
    const first = r.stdout.trim().split(/\s+/)[0] ?? ''
    return /^\d+$/.test(first) ? humanBytes(parseInt(first, 10) * 1024) : ''
  }

  // --- generic action (AppActionWorker) — argv already carries `-s <serial>` --
  async action(argv: string[], okMsg: string): Promise<AppActionResult> {
    const r = await run(this.adb, null, argv, 90000)
    if (opOk(r.code ?? 1, r.stdout)) return { ok: true, message: okMsg }
    return { ok: false, message: lastLine(r.stderr, r.stdout, `${okMsg} failed`) }
  }

  // --- clear cache (ClearCacheWorker) -----------------------------------------
  async clearCache(serial: string, pkg: string): Promise<AppActionResult> {
    const attempts: Array<[string, string[]]> = [
      ['pm --cache-only', clearCacheArgs(serial, pkg)],
      ['run-as', runasClearCacheArgs(serial, pkg)],
      ['su', suClearCacheArgs(serial, pkg)]
    ]
    const errors: string[] = []
    for (const [label, argv] of attempts) {
      const r = await run(this.adb, null, argv, 60000)
      if (opOk(r.code ?? 1, r.stdout)) {
        return { ok: true, message: `Cleared cache for ${pkg} (via ${label})` }
      }
      const detail = (r.stderr || r.stdout || '').trim().replace(/\n/g, ' ')
      errors.push(`${label}: ${detail.slice(0, 80) || 'failed'}`)
    }
    return { ok: false, message: 'Could not clear cache — ' + errors.join('; ') }
  }

  // --- bulk permission change (BulkPermWorker) --------------------------------
  async bulkPerms(serial: string, pkg: string, perms: string[], grant: boolean): Promise<AppActionResult> {
    const verb = grant ? 'grant' : 'revoke'
    const title = verb[0].toUpperCase() + verb.slice(1)
    const builder = grant ? grantArgs : revokeArgs
    let okN = 0
    const fails: string[] = []
    for (const perm of perms) {
      const r = await run(this.adb, null, builder(serial, pkg, perm), 30000)
      if (opOk(r.code ?? 1, r.stdout)) okN += 1
      else {
        const detail = (r.stderr || r.stdout || '').trim().replace(/\n/g, ' ')
        fails.push(`${perm.split('.').pop()}: ${detail.slice(0, 50) || 'failed'}`)
      }
    }
    if (okN && fails.length === 0) return { ok: true, message: `${title}ed ${okN} permission(s)` }
    if (okN) {
      return { ok: true, message: `${title}ed ${okN}, ${fails.length} failed (${fails.slice(0, 3).join('; ')})` }
    }
    return { ok: false, message: `Could not ${verb} permissions — ${fails.slice(0, 4).join('; ')}` }
  }

  // --- app icon (AppIconWorker) -----------------------------------------------
  async icon(serial: string, _pkg: string, apkPath: string): Promise<IconResult> {
    if (!apkPath) return { dataUrl: null, unavailable: false }
    const listing = await run(this.adb, null, unzipListArgs(serial, apkPath), 15000)
    if (listing.code !== 0) {
      const err = (listing.stderr || '').toLowerCase()
      const miss = err.includes('not found') || err.includes('inaccessible')
      return { dataUrl: null, unavailable: miss }
    }
    const entry = pickLauncherIcon(parseZipEntries(listing.stdout))
    if (!entry) return { dataUrl: null, unavailable: false }
    const blob = await runBinary(this.adb, unzipExtractArgs(serial, apkPath, entry), 20000)
    const mime = imageMime(blob.stdout)
    if (!mime) return { dataUrl: null, unavailable: false }
    return { dataUrl: `data:${mime};base64,${blob.stdout.toString('base64')}`, unavailable: false }
  }

  // --- extract APK (PullWorker) -----------------------------------------------
  async extractApk(serial: string, pkg: string): Promise<SaveResult> {
    const remotes = parseApkPaths((await run(this.adb, null, pmPathArgs(serial, pkg), 15000)).stdout)
    if (remotes.length === 0) {
      return { ok: false, message: `No APK found on device for ${pkg}`, dir: '' }
    }
    const dest = join(downloadsDir(), pkg)
    try {
      mkdirSync(dest, { recursive: true })
    } catch (e) {
      return { ok: false, message: `Cannot create ${dest}: ${errMsg(e)}`, dir: '' }
    }
    const pulled: string[] = []
    const errors: string[] = []
    for (const remote of remotes) {
      const name = basename(remote)
      const local = join(dest, name)
      const r = await run(this.adb, serial, ['pull', remote, local], 180000)
      if (r.code === 0 && existsSync(local)) pulled.push(name)
      else errors.push(`${name}: ${lastLine(r.stderr, r.stdout, 'pull failed')}`)
    }
    const ok = pulled.length > 0 && errors.length === 0
    let message: string
    if (pulled.length) {
      message = `Pulled ${pulled.length} file(s): ${pulled.join(', ')}`
      if (errors.length) message += `  (${errors.length} failed: ${errors.join('; ')})`
    } else {
      message = 'Pull failed: ' + errors.join('; ')
    }
    return { ok, message, dir: dest }
  }
}
