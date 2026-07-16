/**
 * Real device renders for the Device Info hero, from the community AppleDB CDN
 * (img.appledb.dev). These are Apple's product images, so we NEVER bundle them
 * in the repo — they're fetched on demand and cached per-user under app-support
 * (like a browser cache), and the UI falls back to the drawn CSS phone when
 * offline or when a model has no render. Fetching happens in the main process
 * (the renderer's CSP forbids remote hosts); the image is handed back as a
 * data: URI, which the renderer's `img-src 'self' data:` allows.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const API = 'https://api.appledb.dev/device'
const IMG = 'https://img.appledb.dev/device@256'

interface AppleDbDevice {
  colors?: Array<{ key?: string; name?: string }>
  imageKey?: string
}

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'ios-device-images')
  mkdirSync(dir, { recursive: true })
  return dir
}

function toDataUri(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString('base64')}`
}

/** A device render as a data: URI (cached), or null if unavailable/offline. */
export async function deviceImage(identifier: string): Promise<string | null> {
  // Guard: identifier goes into a URL + a filename.
  if (!identifier || !/^[A-Za-z0-9,.\-_]+$/.test(identifier)) return null
  const file = join(cacheDir(), `${identifier}.png`)
  if (existsSync(file)) {
    try {
      return toDataUri(readFileSync(file))
    } catch {
      /* fall through to refetch */
    }
  }
  try {
    const metaRes = await fetch(`${API}/${encodeURIComponent(identifier)}.json`, {
      signal: AbortSignal.timeout(8000)
    })
    if (!metaRes.ok) return null
    const meta = (await metaRes.json()) as AppleDbDevice
    const color = meta.colors?.[0]?.key ?? meta.colors?.[0]?.name
    const key = meta.imageKey ?? identifier
    if (!color) return null
    const imgRes = await fetch(`${IMG}/${encodeURIComponent(key)}/${encodeURIComponent(color)}.png`, {
      signal: AbortSignal.timeout(8000)
    })
    if (!imgRes.ok) return null
    const buf = Buffer.from(await imgRes.arrayBuffer())
    if (buf.length === 0) return null
    try {
      writeFileSync(file, buf)
    } catch {
      /* cache is best-effort */
    }
    return toDataUri(buf)
  } catch {
    return null
  }
}
