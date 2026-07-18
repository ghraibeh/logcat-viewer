/**
 * DeviceKit (mobile-next) runtime — the WebSocket JSON-RPC input agent.
 *
 * Launches the DeviceKit XCUITest runner (`ios runtest`) + forwards its device port
 * 12004, then holds a PERSISTENT WebSocket (`ws://127.0.0.1:12004/ws`) for low-overhead
 * JSON-RPC injection. Its `device.io.gesture` takes a full press→move…→release path, so a
 * drag replays the user's ACTUAL finger motion (curve + velocity + momentum) over one live
 * socket instead of a crude 2-point swipe. `iosinput.ts` prefers this agent and falls back
 * to WebDriverAgent (services/iosinput WDA path) when DeviceKit isn't installed/reachable.
 *
 * NOTE: this still bottoms out in iOS's on-device XCTest event synthesis (~360ms per
 * gesture) — that floor is the device's, shared by WDA/DeviceKit/idb alike; the WebSocket
 * removes transport overhead and enables the faithful full-path drag, not the floor.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import WebSocket from 'ws'
import {
  appsListArgs,
  DEVICEKIT_LOCAL_WS,
  DEVICEKIT_PORT,
  dkButtonParams,
  dkGestureParams,
  dkKeysParams,
  dkRpc,
  dkTapParams,
  dkTextParams,
  findDeviceKitBundleId,
  forwardArgs,
  runDeviceKitArgs,
  type DkAction,
  type DkKeyCombo
} from '@core/iosinput'
import { startTunnel } from './goios'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let proc: ChildProcess | null = null
let fwd: ChildProcess | null = null
let dkUdid: string | null = null
let sock: WebSocket | null = null
let connecting: Promise<boolean> | null = null
let rpcId = 1
const pending = new Map<number, (msg: Record<string, unknown>) => void>()

function run(bin: string, args: string[], timeout = 30000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, stdout: stdout ?? '' })
    })
  })
}

/** GET /health on the forwarded DeviceKit — "ok" when the runner is serving. */
function health(timeout = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port: DEVICEKIT_PORT, path: '/health', method: 'GET', timeout }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve(/ok/i.test(Buffer.concat(chunks).toString('utf8'))))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

export function stop(): void {
  if (sock) {
    try {
      sock.close()
    } catch {
      /* ignore */
    }
    sock = null
  }
  for (const p of [proc, fwd]) {
    if (p) {
      try {
        p.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
  proc = null
  fwd = null
  dkUdid = null
  pending.clear()
}

/** Open (or reuse) the persistent WebSocket to the forwarded DeviceKit. */
function connect(): Promise<boolean> {
  if (sock && sock.readyState === WebSocket.OPEN) return Promise.resolve(true)
  if (connecting) return connecting
  connecting = new Promise<boolean>((resolve) => {
    let done = false
    const finish = (v: boolean): void => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    const s = new WebSocket(DEVICEKIT_LOCAL_WS)
    s.on('open', () => {
      sock = s
      finish(true)
    })
    s.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>
        const id = typeof msg.id === 'number' ? msg.id : null
        if (id != null) {
          const cb = pending.get(id)
          if (cb) {
            pending.delete(id)
            cb(msg)
          }
        }
      } catch {
        /* ignore non-JSON */
      }
    })
    s.on('close', () => {
      if (sock === s) sock = null
    })
    s.on('error', () => finish(false))
    setTimeout(() => {
      if (!done) {
        try {
          s.close()
        } catch {
          /* ignore */
        }
        finish(false)
      }
    }, 8000)
  }).finally(() => {
    connecting = null
  })
  return connecting
}

/** One JSON-RPC call over the socket. Resolves the response (or null on any failure). */
async function call(method: string, params: Record<string, unknown>, timeout = 15000): Promise<Record<string, unknown> | null> {
  if (!(await connect())) return null
  const s = sock
  if (!s || s.readyState !== WebSocket.OPEN) return null
  return new Promise((resolve) => {
    const id = rpcId++
    const t = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, timeout)
    pending.set(id, (msg) => {
      clearTimeout(t)
      resolve(msg)
    })
    try {
      s.send(JSON.stringify(dkRpc(id, method, params)))
    } catch {
      clearTimeout(t)
      pending.delete(id)
      resolve(null)
    }
  })
}

/** Is DeviceKit launched + the WebSocket open right now? (no launch) */
export function reachable(): boolean {
  return !!proc && !!fwd && !!sock && sock.readyState === WebSocket.OPEN
}

/** Ensure DeviceKit is installed, launched, forwarded, and the WebSocket is open.
 *  Idempotent (fast when already up). Returns false if DeviceKit isn't installed or
 *  couldn't come up (the caller then falls back to WDA). */
export async function ensure(bin: string, udid: string, onProgress: (line: string) => void = () => {}): Promise<boolean> {
  if (dkUdid && dkUdid !== udid) stop()
  const tun = await startTunnel(bin, udid)
  if (!tun.ok) return false
  if (reachable() && dkUdid === udid && (await health())) return true

  const apps = await run(bin, appsListArgs(udid))
  const bundle = findDeviceKitBundleId(apps.stdout)
  if (!bundle) {
    onProgress('  agent: DeviceKit not installed — falling back to WebDriverAgent.')
    return false
  }
  onProgress(`  agent: launching DeviceKit ${bundle}…`)
  stop()
  dkUdid = udid
  proc = spawn(bin, runDeviceKitArgs(udid, bundle), { stdio: 'ignore' })
  proc.on('error', () => {})
  proc.on('exit', () => {
    if (dkUdid === udid) proc = null
  })
  fwd = spawn(bin, forwardArgs(udid, DEVICEKIT_PORT, DEVICEKIT_PORT), { stdio: 'ignore' })
  fwd.on('error', () => {})

  for (let i = 0; i < 18; i++) {
    if (dkUdid !== udid) return false
    await delay(2000)
    if (!proc) {
      onProgress('  agent: the DeviceKit runner exited early — check signing/Trust on the device.')
      return false
    }
    if (await health()) {
      if (await connect()) {
        onProgress('  agent: DeviceKit ready (WebSocket).')
        return true
      }
    }
  }
  onProgress('  agent: DeviceKit not ready (timed out).')
  return false
}

// --- injection (JSON-RPC over the live socket) -------------------------------
export function tap(x: number, y: number): Promise<unknown> {
  return call('device.io.tap', dkTapParams(x, y), 8000)
}
/** Full-path drag: press → moves (with real per-segment timing) → release, one gesture. */
export function gesture(actions: DkAction[]): Promise<unknown> {
  return call('device.io.gesture', dkGestureParams(actions), 20000)
}
export function text(s: string): Promise<unknown> {
  return call('device.io.text', dkTextParams(s), 12000)
}
export function keys(combos: DkKeyCombo[]): Promise<unknown> {
  return call('device.io.keys', dkKeysParams(combos), 8000)
}
export function button(name: string): Promise<unknown> {
  return call('device.io.button', dkButtonParams(name), 8000)
}
