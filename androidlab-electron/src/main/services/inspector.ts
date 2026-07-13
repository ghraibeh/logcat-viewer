/**
 * Layout Inspector capture. Faithful port of inspector.py's InspectWorker: one
 * pass that grabs a PNG screenshot (binary-clean) + a uiautomator hierarchy
 * dump, validates both, and returns them (PNG as base64 for the IPC boundary).
 */
import { run, runBinary } from './adb'
import { screencapArgs, uidumpArgs } from '@core/inspector'
import type { InspectResult } from '@shared/types'

export async function captureInspect(adb: string, serial: string): Promise<InspectResult> {
  const shot = await runBinary(adb, screencapArgs(serial), 20000)
  const dump = await run(adb, null, uidumpArgs(serial), 25000)
  const xml = dump.stdout

  const png = shot.stdout
  const isPng = png.length >= 4 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
  if (!isPng) {
    return { ok: false, message: 'screencap returned no image', pngBase64: '', xml: '' }
  }
  if (!xml.includes('<hierarchy')) {
    const err = dump.stderr.trim()
    return { ok: false, message: `uiautomator dump failed: ${err || 'no XML'}`, pngBase64: '', xml: '' }
  }
  return { ok: true, message: 'captured', pngBase64: png.toString('base64'), xml }
}
