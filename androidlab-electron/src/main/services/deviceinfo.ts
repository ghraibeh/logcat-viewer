/**
 * Android Device-Info service. Runs the one-round-trip `adb shell` probe from
 * core/deviceinfo.ts and aggregates it into the AndroidDeviceInfo the shared
 * Device Info dashboard renders — the adb counterpart to goios.deviceInfo().
 * Read-only; a short query, so it stays request/response (no worker thread).
 */
import { run } from './adb'
import { buildProbe, parseDeviceInfo, type AndroidDeviceInfo } from '@core/deviceinfo'

export async function readDeviceInfo(adb: string, serial: string): Promise<AndroidDeviceInfo | null> {
  const r = await run(adb, serial, ['shell', buildProbe()], 15000)
  if (!r.stdout.trim()) return null
  return parseDeviceInfo(r.stdout, serial)
}
