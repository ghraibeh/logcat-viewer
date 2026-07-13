/**
 * Mock GPS location service. Faithful port of mocklocation.py's device layer:
 *
 *  - `MockSetupWorker`  -> setup()  (install the helper APK if absent, then grant
 *                                    it the `android:mock_location` app-op),
 *  - the `set`/`stop` command drivers (`MockLocationView._send_set` / `_disable`
 *    / `shutdown`, which used `QProcess.startDetached(set_args/stop_args)`).
 *
 * Cleanup (CLAUDE.md hard rule #3 — no orphaned mock): the service tracks the
 * serial it last sent a `set` to (`activeSerial`) and `shutdown()` sends a `stop`
 * to it, so no mock outlives the app even if the renderer teardown can't complete
 * an async round-trip on window close. Switching devices stops the old one first.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { run } from './adb'
import { HELPER_APK_NAME, HELPER_PKG, MOCK_APPOP, setArgs, stopArgs } from '@core/mocklocation'

export interface MockResult {
  ok: boolean
  message: string
}

/** Packaged -> resources root; dev -> the project `resources/` dir (mirrors how
 *  adb.ts resolves process.resourcesPath, with a dev fallback). */
function helperApkPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, HELPER_APK_NAME)
  return join(app.getAppPath(), 'resources', HELPER_APK_NAME)
}

export class MockLocationService {
  /** The serial with a live mock we haven't stopped yet (null = nothing mocking). */
  private activeSerial: string | null = null

  constructor(private readonly adb: string) {}

  // --- setup (MockSetupWorker) ---------------------------------------------
  /** Ensure the helper is installed and allowed to mock. */
  async setup(serial: string): Promise<MockResult> {
    try {
      const already = await this.isInstalled(serial)
      if (!already) {
        const r = await this.install(serial)
        if (!r.ok) return r
      }
      await this.appopsAllow(serial)
      if (!(await this.appopIsAllow(serial))) {
        return {
          ok: false,
          message:
            "Couldn't grant the mock-location permission (appops). Enable USB debugging (Secure settings) may be required."
        }
      }
      return { ok: true, message: already ? 'Helper ready' : 'Helper installed' }
    } catch (e) {
      return { ok: false, message: `Setup failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  private async isInstalled(serial: string): Promise<boolean> {
    const r = await run(this.adb, serial, ['shell', 'pm', 'list', 'packages', HELPER_PKG], 8000)
    return r.stdout.includes(HELPER_PKG)
  }

  private async install(serial: string): Promise<MockResult> {
    const apk = helperApkPath()
    if (!existsSync(apk)) return { ok: false, message: `Bundled helper APK is missing:\n${apk}` }
    const r = await run(this.adb, serial, ['install', '-r', '-g', apk], 180000)
    if (r.code === 0 && r.stdout.includes('Success')) return { ok: true, message: 'installed' }
    // Some devices reject grant-at-install (-g); retry plain, then grant perms.
    const r2 = await run(this.adb, serial, ['install', '-r', apk], 180000)
    if (r2.code === 0 && r2.stdout.includes('Success')) {
      for (const perm of [
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION'
      ]) {
        await run(this.adb, serial, ['shell', 'pm', 'grant', HELPER_PKG, perm], 8000)
      }
      return { ok: true, message: 'installed' }
    }
    const blob = (r.stderr || r.stdout || r2.stderr || r2.stdout || '').trim().split('\n').filter(Boolean)
    return { ok: false, message: 'Install failed: ' + (blob.length ? blob[blob.length - 1] : 'unknown error') }
  }

  private async appopsAllow(serial: string): Promise<void> {
    await run(this.adb, serial, ['shell', 'appops', 'set', HELPER_PKG, MOCK_APPOP, 'allow'], 8000)
  }

  private async appopIsAllow(serial: string): Promise<boolean> {
    const r = await run(this.adb, serial, ['shell', 'appops', 'get', HELPER_PKG, MOCK_APPOP], 8000)
    return r.stdout.toLowerCase().includes('allow')
  }

  // --- set / stop (the QProcess.startDetached drivers) ---------------------
  /** Start/update the mock at lat,lng. `setArgs` carries its own `-s <serial>`,
   *  so pass serial=null to `run` (which would otherwise prepend a second one). */
  async set(
    serial: string,
    lat: number,
    lng: number,
    acc: number | null = 5,
    alt: number | null = null
  ): Promise<MockResult> {
    this.activeSerial = serial
    const r = await run(this.adb, null, setArgs(serial, lat, lng, acc, alt), 15000)
    const err = (r.stderr || '').trim()
    if (r.code !== 0 && err) return { ok: false, message: err.split('\n').pop() ?? 'set failed' }
    return { ok: true, message: 'ok' }
  }

  /** Stop mocking + tear down the providers on `serial`. */
  async stop(serial: string): Promise<MockResult> {
    const r = await run(this.adb, null, stopArgs(serial), 15000)
    if (this.activeSerial === serial) this.activeSerial = null
    const err = (r.stderr || '').trim()
    if (r.code !== 0 && err) return { ok: false, message: err.split('\n').pop() ?? 'stop failed' }
    return { ok: true, message: 'ok' }
  }

  /** No mock may outlive the app: stop whatever serial is still mocking. */
  shutdown(): void {
    const serial = this.activeSerial
    if (!serial) return
    this.activeSerial = null
    void run(this.adb, null, stopArgs(serial), 8000).catch(() => {
      /* best-effort on close */
    })
  }
}
