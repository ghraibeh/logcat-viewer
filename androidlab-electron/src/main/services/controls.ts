/**
 * Device Controls service. Faithful port of controls.py's StateWorker (one
 * shell round-trip reading every toggle, + per-app bucket/locale) and CmdWorker
 * (run a sequence of adb argvs, report the first failure). Request/response.
 */
import { run } from './adb'
import {
  getAppLocalesArgs,
  getStandbyBucketArgs,
  interpretState,
  parseAppLocales,
  parseState,
  readStateScript,
  type ControlsState
} from '@core/controls'

export interface ControlsReadResult {
  ok: boolean
  message: string
  state: ControlsState | null
}

export async function readControlsState(
  adb: string,
  serial: string,
  pkg: string | null
): Promise<ControlsReadResult> {
  const r = await run(adb, serial, ['shell', readStateScript()], 15000)
  if (!r.stdout && r.stderr) return { ok: false, message: r.stderr.trim(), state: null }
  const state = interpretState(parseState(r.stdout))
  if (pkg) {
    state.bucket = (await run(adb, serial, getStandbyBucketArgs(pkg), 10000)).stdout.trim()
    state.appLocales = parseAppLocales((await run(adb, serial, getAppLocalesArgs(pkg), 10000)).stdout)
  }
  return { ok: true, message: '', state }
}

export async function applyControls(
  adb: string,
  serial: string,
  argvs: string[][],
  label: string
): Promise<{ ok: boolean; message: string }> {
  for (const argv of argvs) {
    const r = await run(adb, serial, argv, 15000)
    const err = (r.stderr || '').trim()
    if (r.code !== 0 && err) {
      return { ok: false, message: `${label}: ${err.split('\n').pop()}` }
    }
  }
  return { ok: true, message: label }
}
