/**
 * LIVE, opt-in end-to-end check for the iOS network-intercept CA delivery.
 * Skipped by `npm test` — it only runs with a real iPhone attached AND
 * RUN_IOS_LIVE=1, so normal unit runs never shell out or touch a device:
 *
 *   RUN_IOS_LIVE=1 npx vitest run test/ios-intercept.live.test.ts
 *
 * It exercises the REAL code path: generate a throwaway root CA (node-forge, as
 * the intercept service does), build the .mobileconfig with the real core
 * builder, `ios profile add` it, read it back with `ios profile list` →
 * parseProfileList / findCaProfile, then `ios profile remove` to clean up.
 *
 * NOTE: on iOS 16+ `profile add` STAGES the profile — the device shows a
 * "Profile Downloaded" prompt and it only appears in `profile list` once the
 * user taps Install in Settings. So the add succeeding (exit 0) is the pass
 * signal; presence in the list is logged, not asserted. Declining the on-device
 * prompt discards it, and the remove step cleans up an approved one.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'
import { describe, expect, it } from 'vitest'
import {
  CA_PROFILE_NAME,
  caMobileconfig,
  findCaProfile,
  parseProfileList,
  profileAddArgs,
  profileListArgs,
  profileRemoveArgs
} from '@core/goios'

const LIVE = !!process.env.RUN_IOS_LIVE

function goIosBin(): string {
  const sub = 'go-ios-darwin-arm64_darwin_arm64'
  return join(process.cwd(), 'node_modules', 'go-ios', 'dist', sub, 'ios')
}

function firstUdid(bin: string): string {
  try {
    const out = execFileSync(bin, ['list'], { encoding: 'utf8', timeout: 8000 })
    const m = /"(\w{8}-\w{16}|\w{40})"/.exec(out)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

const bin = LIVE ? goIosBin() : ''
const udid = LIVE ? firstUdid(bin) : ''

describe.runIf(LIVE && !!udid)('iOS intercept CA delivery (live device)', () => {
  it('builds a mobileconfig the device accepts, then removes it', () => {
    // 1) throwaway root CA (same shape as InterceptService.ensureCa).
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = '01'
    cert.validity.notBefore = new Date(Date.now() - 86400000)
    cert.validity.notAfter = new Date(Date.now() + 3650 * 86400000)
    const attrs = [{ name: 'commonName', value: CA_PROFILE_NAME }]
    cert.setSubject(attrs)
    cert.setIssuer(attrs)
    cert.setExtensions([{ name: 'basicConstraints', cA: true }])
    cert.sign(keys.privateKey, forge.md.sha256.create())
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
    const derB64 = forge.util.encode64(der)

    // 2) build the profile with the REAL core builder + write it.
    const dir = mkdtempSync(join(tmpdir(), 'ioslive-'))
    const file = join(dir, 'ca.mobileconfig')
    writeFileSync(file, caMobileconfig(derB64), 'utf8')

    try {
      // 3) send it — exit 0 means go-ios accepted + delivered it (device prompts).
      const add = execFileSync(bin, profileAddArgs(udid, file), { encoding: 'utf8', timeout: 30000 })
      // eslint-disable-next-line no-console
      console.log('[live] profile add →', add.trim() || '(ok)')

      // 4) read back (may be empty until the user approves on-device).
      const list = execFileSync(bin, profileListArgs(udid), { encoding: 'utf8', timeout: 15000 })
      const rows = parseProfileList(list)
      // eslint-disable-next-line no-console
      console.log('[live] installed profiles:', rows.map((r) => r.identifier || r.displayName).join(', ') || '(none listed yet)')

      // 5) clean up any approved copy so nothing is left behind.
      const id = findCaProfile(list)
      if (id) {
        const rm = execFileSync(bin, profileRemoveArgs(udid, id), { encoding: 'utf8', timeout: 20000 })
        // eslint-disable-next-line no-console
        console.log('[live] profile remove →', rm.trim() || '(ok)')
      }
      expect(true).toBe(true) // reaching here = add + list + optional remove all ran
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
