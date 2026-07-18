/**
 * iOS device wiring for the network intercept — the go-ios counterpart to
 * AndroidWiring. Two differences from Android drive everything here:
 *
 *  1. No programmatic global proxy. go-ios `httpproxy` needs a supervision p12
 *     (supervised devices only), so on a normal iPhone we CANNOT force a proxy.
 *     Instead the proxy binds to the Mac's LAN IP and the user points the
 *     device's Wi-Fi proxy at it once (same as Charles/Proxyman). `unwire` can't
 *     un-set it — the UI reminds the user to turn it off.
 *  2. The MITM CA ships as a configuration profile (`ios profile add`) built from
 *     the host CA's DER bytes; the user approves it (Settings ▸ VPN & Device
 *     Management) and enables trust (Settings ▸ General ▸ About ▸ Certificate
 *     Trust Settings) — iOS never auto-trusts a non-MDM root.
 *
 * The proxy/MITM engine (services/intercept.ts) is untouched — this only supplies
 * the DeviceWiring hooks.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CA_PROFILE_NAME,
  caMobileconfig,
  findCaProfile,
  profileAddArgs,
  profileListArgs,
  profileRemoveArgs
} from '@core/goios'
import type { CaMaterial, CertPushResult, DeviceWiring, WiringCallbacks } from './intercept'

/** Run go-ios; never throws (mirrors goios.ts's run). */
function runGoIos(bin: string, args: string[], timeoutMs = 30000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code: err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      })
    })
  })
}

function lastLine(stderr: string, stdout: string, fallback: string): string {
  const out = (stderr || stdout || '').trim()
  if (!out) return fallback
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? fallback
}

/** This Mac's LAN IPv4 (the address the iPhone points its Wi-Fi proxy at).
 *  Prefers en0 (Wi-Fi on macOS); '' if only loopback is up. */
export function hostLanIp(): string {
  const ifaces = networkInterfaces()
  const prefer = ifaces['en0'] ? ['en0'] : []
  const order = [...prefer, ...Object.keys(ifaces).filter((k) => k !== 'en0')]
  for (const name of order) {
    for (const i of ifaces[name] ?? []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return ''
}

const PROXY_STEPS = (hostPort: string): string =>
  `Set the iPhone's Wi-Fi proxy to ${hostPort} — Settings ▸ Wi-Fi ▸ (i) ▸ Configure Proxy ▸ Manual.`

export class IosWiring implements DeviceWiring {
  readonly bindHost = '0.0.0.0' // reachable from the iPhone over the LAN
  readonly autoInstallCertOnStart = false // the CA needs manual approve + trust

  // The go-ios wiring never needs to push status or signal a drop (no watchdog,
  // no live proxy state), so it ignores the WiringCallbacks AndroidWiring uses —
  // the ctor still accepts them so the wiringFor factory builds both the same way.
  constructor(
    private readonly bin: string,
    readonly serial: string,
    _cb: WiringCallbacks
  ) {}

  async wire(port: number): Promise<{ ok: boolean; message: string }> {
    const ip = hostLanIp()
    if (!ip) {
      return {
        ok: true,
        message: `Connect the iPhone to the same Wi-Fi as this Mac, then set its Wi-Fi proxy to this Mac's IP : ${port}.`
      }
    }
    return { ok: true, message: PROXY_STEPS(`${ip}:${port}`) }
  }

  /** No programmatic proxy to undo (it's a manual Wi-Fi setting). The CA profile
   *  is left installed on purpose so future sessions don't re-prompt. */
  unwire(): void {
    /* nothing — the UI reminds the user to turn the Wi-Fi proxy off */
  }

  async installCert(ca: CaMaterial): Promise<CertPushResult> {
    const dir = mkdtempSync(join(tmpdir(), 'androidlab-ca-'))
    const file = join(dir, 'androidlabkit-ca.mobileconfig')
    try {
      writeFileSync(file, caMobileconfig(ca.certDerBase64), 'utf8')
      const r = await runGoIos(this.bin, profileAddArgs(this.serial, file), 30000)
      if (r.code !== 0) {
        return { ok: false, message: `Couldn't send the CA profile: ${lastLine(r.stderr, r.stdout, 'profile add failed')}`, dir: '' }
      }
      return {
        ok: true,
        message:
          `Sent the ${CA_PROFILE_NAME} profile — on the iPhone: approve it (Settings ▸ General ▸ VPN & Device ` +
          `Management), then TRUST it (Settings ▸ General ▸ About ▸ Certificate Trust Settings).`,
        dir: ''
      }
    } catch (e) {
      return { ok: false, message: `Couldn't build the CA profile: ${e instanceof Error ? e.message : String(e)}`, dir: '' }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Remove the MobileLabKit CA profile from the device (used for cleanup / a UI
 *  "Remove CA" action). Best-effort; returns a user-facing result. */
export async function removeIosCaProfile(bin: string, udid: string): Promise<CertPushResult> {
  const list = await runGoIos(bin, profileListArgs(udid), 15000)
  const id = findCaProfile(list.stdout || list.stderr)
  if (!id) return { ok: true, message: 'No MobileLabKit CA profile installed', dir: '' }
  const r = await runGoIos(bin, profileRemoveArgs(udid, id), 20000)
  if (r.code !== 0) {
    return { ok: false, message: `Couldn't remove the CA profile: ${lastLine(r.stderr, r.stdout, 'profile remove failed')}`, dir: '' }
  }
  return { ok: true, message: 'Removed the MobileLabKit CA profile', dir: '' }
}
