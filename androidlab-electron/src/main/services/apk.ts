/**
 * Install APK(s) to the selected device.
 * Faithful port of MainWindow.install_apks / _on_install_done: several APKs at
 * once are treated as splits of one app (install-multiple), `-r -d` flags, and
 * success is "exit 0 with 'Success' in the output".
 */
import { basename } from 'node:path'
import { run } from './adb'
import type { InstallResult } from '@shared/types'

export async function installApks(
  adb: string,
  serial: string,
  paths: string[]
): Promise<InstallResult> {
  const apks = paths.filter((p) => p.toLowerCase().endsWith('.apk'))
  if (apks.length === 0) {
    return { ok: false, message: 'No .apk files selected', output: '', names: '' }
  }
  const names = apks.map((p) => basename(p)).join(', ')
  const verb = apks.length === 1 ? 'install' : 'install-multiple'
  const r = await run(adb, serial, [verb, '-r', '-d', ...apks], 180000)
  const out = (r.stdout + '\n' + r.stderr).trim()
  if (r.code === 0 && out.includes('Success')) {
    return { ok: true, message: `Installed ${names}`, output: out, names }
  }
  const reason =
    out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? `adb exited with code ${r.code}`
  return { ok: false, message: `Install failed: ${reason}`, output: out, names }
}
