/**
 * One consistent identity this Mac advertises across EVERY mirror path — the AirPlay receiver
 * and the MobileLabKit (_mlkmirror._tcp) receiver both use this, so a phone sees the same name
 * whether it's AirPlaying or casting: "<Computer Name> (MobileLabKit)". Recognizable (it's your
 * Mac) and branded, and it disambiguates when several Macs run the app on the same network.
 */
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'

let cached: string | null = null

export function deviceLabel(): string {
  if (cached) return cached
  let base = ''
  try {
    if (process.platform === 'darwin') {
      base = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { timeout: 2000 })
        .toString()
        .trim()
    }
  } catch {
    /* fall through to hostname */
  }
  if (!base) base = hostname().replace(/\.local$/, '')
  cached = `${base} (MobileLabKit)`
  return cached
}
