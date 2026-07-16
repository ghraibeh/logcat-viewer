/**
 * Per-platform feature gating. AndroidLab's tabs were all built on adb's deep
 * `shell` access; iOS reaches devices through go-ios's fixed set of lockdown
 * services, so most tabs have no iOS equivalent (yet). Rather than scatter
 * `platform === 'ios'` checks through the UI, the renderer consults this map to
 * decide which outer tabs to show — unsupported ones are simply hidden.
 *
 * As iOS support grows (e.g. syslog for the Logs tab), add the platform to the
 * relevant entry here; no other UI change is needed.
 */
import type { Device, Platform } from './types'

/** Tab id (from App.tsx TABS) -> the platforms that currently support it. */
export const TAB_SUPPORT: Record<string, Platform[]> = {
  logs: ['android'],
  location: ['android', 'ios'],
  network: ['android'],
  databases: ['android', 'ios'],
  files: ['android', 'ios'],
  apps: ['android', 'ios'],
  monitor: ['android'],
  inspector: ['android'],
  controls: ['android'],
  toolbox: ['android'],
  shell: ['android']
}

export function tabSupported(tabId: string, platform: Platform): boolean {
  return TAB_SUPPORT[tabId]?.includes(platform) ?? false
}

/** Resolve the platform of the currently-selected device (defaults to android
 *  when nothing is selected, so the full Android UI shows on an empty picker). */
export function platformOf(devices: Device[], serial: string | null): Platform {
  if (!serial) return 'android'
  return devices.find((d) => d.serial === serial)?.platform ?? 'android'
}
