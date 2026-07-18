/**
 * Real device renders for the Device Info hero, from the community AppleDB CDN
 * (img.appledb.dev). These are Apple's product images, so we NEVER bundle them
 * in the repo — they're fetched on demand and cached per-user under app-support
 * (like a browser cache), and the UI falls back to the drawn CSS phone when
 * offline or when a model has no render. Fetching happens in the main process
 * (the renderer's CSP forbids remote hosts); the image is handed back as a
 * data: URI, which the renderer's `img-src 'self' data:` allows.
 *
 * AppleDB ships FRONT renders only — there is no back photo for any iPhone — so
 * alongside the front image we return the model's enclosure colour (from the
 * same metadata) and the renderer draws the back tinted to it. The colour is
 * cached in a small sidecar next to the png so a cache hit still carries it.
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IosDeviceRender } from '@core/iosdeviceinfo'

const API = 'https://api.appledb.dev/device'
const IMG = 'https://img.appledb.dev/device@256'

interface AppleDbDevice {
  colors?: Array<{ key?: string; name?: string; hex?: string }>
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

/** A device render bundle (front data: URI + enclosure colour), served from the
 *  per-user cache when present, else fetched from AppleDB. Every field is null
 *  when unavailable/offline; the renderer copes with any combination. */
export async function deviceImage(identifier: string): Promise<IosDeviceRender> {
  const empty: IosDeviceRender = { front: null, colorHex: null, colorName: null }
  // Guard: identifier goes into a URL + a filename.
  if (!identifier || !/^[A-Za-z0-9,.\-_]+$/.test(identifier)) return empty

  const dir = cacheDir()
  const pngFile = join(dir, `${identifier}.png`)
  const colorFile = join(dir, `${identifier}.color.json`)

  let front: string | null = null
  let colorHex: string | null = null
  let colorName: string | null = null

  if (existsSync(colorFile)) {
    try {
      const m = JSON.parse(readFileSync(colorFile, 'utf8')) as { colorHex?: string; colorName?: string }
      colorHex = typeof m.colorHex === 'string' ? m.colorHex : null
      colorName = typeof m.colorName === 'string' ? m.colorName : null
    } catch {
      /* refetch below */
    }
  }
  if (existsSync(pngFile)) {
    try {
      front = toDataUri(readFileSync(pngFile))
    } catch {
      /* refetch below */
    }
  }
  // Fully cached (image + colour) → done, no network.
  if (front && colorHex !== null) return { front, colorHex, colorName }

  try {
    const metaRes = await fetch(`${API}/${encodeURIComponent(identifier)}.json`, {
      signal: AbortSignal.timeout(8000)
    })
    if (!metaRes.ok) return { front, colorHex, colorName }
    const meta = (await metaRes.json()) as AppleDbDevice
    const c0 = meta.colors?.[0]
    const color = c0?.key ?? c0?.name ?? null
    // The front render and the drawn back use the SAME colour entry so they match.
    colorHex = c0?.hex ?? colorHex
    colorName = c0?.name ?? c0?.key ?? colorName
    if (colorHex !== null || colorName !== null) {
      try {
        writeFileSync(colorFile, JSON.stringify({ colorHex, colorName }))
      } catch {
        /* cache is best-effort */
      }
    }

    if (!front && color) {
      const key = meta.imageKey ?? identifier
      const imgRes = await fetch(`${IMG}/${encodeURIComponent(key)}/${encodeURIComponent(color)}.png`, {
        signal: AbortSignal.timeout(8000)
      })
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer())
        if (buf.length > 0) {
          try {
            writeFileSync(pngFile, buf)
          } catch {
            /* cache is best-effort */
          }
          front = toDataUri(buf)
        }
      }
    }
    return { front, colorHex, colorName }
  } catch {
    return { front, colorHex, colorName }
  }
}
