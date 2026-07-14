/**
 * Wireless adb pure builders/parsers — port of wireless.py's Qt-free layer.
 * These return adb args WITHOUT a leading `-s <serial>` (the service adds it via
 * the shared `run` helper), except `connectArgs`, which is a host-side command
 * that must never carry a serial.
 */

/** Restart adbd on the device in TCP/IP mode on `port` (default 5555). */
export const tcpipArgs = (port = 5555): string[] => ['tcpip', String(port)]

/** Read the device's routing table (we scrape the wlan `src` IP out of it). */
export const ipRouteArgs = (): string[] => ['shell', 'ip', 'route']

/** Host-side connect to `host:port` — no `-s <serial>`. */
export const connectArgs = (hostPort: string): string[] => ['connect', hostPort]

/** The device's wlan IP from `ip route` (the `src` of the wlan subnet). */
export function parseDeviceIp(ipRouteOut: string): string | null {
  for (const line of ipRouteOut.split('\n')) {
    if (line.includes('wlan')) {
      const m = /\bsrc\s+(\d+\.\d+\.\d+\.\d+)/.exec(line)
      if (m) return m[1]
    }
  }
  const m = /\bsrc\s+(\d+\.\d+\.\d+\.\d+)/.exec(ipRouteOut)
  return m ? m[1] : null
}

/** Did an adb wireless op succeed? (mirrors wireless.py's looks_ok). */
export function looksOk(out: string): boolean {
  const low = out.toLowerCase()
  return (
    low.includes('successfully paired') ||
    low.includes('connected to') ||
    low.includes('already connected') ||
    low.includes('restarting in tcp')
  )
}
