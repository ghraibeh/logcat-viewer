/**
 * Wireless adb service — port of wireless.py's WirelessWorker "switch" op:
 * flip the current (USB) device to Wi-Fi by reading its wlan IP, restarting
 * adbd in TCP/IP mode (`tcpip 5555`), and connecting to `<ip>:5555`.
 * Request/response, run off the UI thread by the IPC handler.
 */
import { run } from './adb'
import { connectArgs, ipRouteArgs, looksOk, parseDeviceIp, tcpipArgs } from '@core/wireless'

export interface WirelessResult {
  ok: boolean
  message: string
  address?: string
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function enableWirelessDebug(adb: string, serial: string): Promise<WirelessResult> {
  const route = await run(adb, serial, ipRouteArgs(), 10000)
  const ip = parseDeviceIp(route.stdout)
  if (!ip) {
    return { ok: false, message: "Couldn't find the device's Wi-Fi IP (is Wi-Fi connected?)" }
  }
  const tcp = await run(adb, serial, tcpipArgs(), 15000)
  const tcpOut = `${tcp.stdout}\n${tcp.stderr}`
  if (tcpOut.toLowerCase().includes('error')) {
    return { ok: false, message: tcpOut.trim() }
  }
  await delay(1500) // adbd restarts in TCP mode
  const address = `${ip}:5555`
  const conn = await run(adb, null, connectArgs(address), 15000)
  const out = `${conn.stdout}\n${conn.stderr}`.trim()
  return { ok: looksOk(out), message: out || '(no output)', address }
}
