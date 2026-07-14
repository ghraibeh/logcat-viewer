/**
 * Android-Studio-style log coloring: subtle per-level message text, solid level
 * badges, and a distinct stable color per tag.
 * Faithful port of logcat_viewer/colors.py (QColor -> hex strings for CSS).
 */

/** Which palette variant is live — set from the renderer's theme engine. */
type LogTheme = 'dark' | 'light'
let logTheme: LogTheme = 'dark'

/** Metadata columns (time / pid / tid) — quiet. Mid-gray reads on both themes. */
export const META = '#767c88'

/** Message text: light and calm; warnings/errors are the ones that grab the eye. */
export const MSG_TEXT: Record<string, string> = {
  V: '#8b929e',
  D: '#c3cddd',
  I: '#cdd6c6',
  W: '#e7c86a',
  E: '#ff8f88',
  F: '#ff8f88',
  '?': '#c3c9d2'
}

/** Message text tuned for a light background (the dark ones are near-invisible). */
const MSG_TEXT_LIGHT: Record<string, string> = {
  V: '#767d8a',
  D: '#525b6b',
  I: '#4a7d40',
  W: '#9a6c00',
  E: '#cc3a30',
  F: '#cc3a30',
  '?': '#4b5262'
}

/** Solid level badge (gutter chip). */
export const BADGE: Record<string, string> = {
  V: '#565e6b',
  D: '#3d6fb0',
  I: '#4c8a3f',
  W: '#b0851f',
  E: '#c1443c',
  F: '#d64b43',
  '?': '#565e6b'
}
export const BADGE_TEXT = '#eef2f8'

/** Per-tag palette — distinct hues that read well on a dark canvas. */
const TAG_PALETTE = [
  '#e0a45e', // tan
  '#57c0c0', // teal
  '#c58fe0', // purple
  '#8fbf6b', // green
  '#6f9ff0', // blue
  '#ef8f6b', // coral
  '#e57fa0', // pink
  '#d6c15e', // gold
  '#5fb0e0', // sky
  '#9fd06b', // lime
  '#b08ff0', // violet
  '#5fc0a0', // mint
  '#e07f7f', // salmon
  '#7fb0d0' // steel
]

/** The same hues, darkened/saturated so they read on a light canvas. */
const TAG_PALETTE_LIGHT = [
  '#a86a1f', // tan
  '#128a8a', // teal
  '#8a44c0', // purple
  '#4f8a2f', // green
  '#2f66d0', // blue
  '#cc5a30', // coral
  '#c23f68', // pink
  '#9a7f10', // gold
  '#2470b0', // sky
  '#5f8a2f', // lime
  '#7040c0', // violet
  '#1f8a68', // mint
  '#c04545', // salmon
  '#3f6f9a' // steel
]

const tagCache = new Map<string, string>()

/**
 * Select the light/dark log palettes. Called by the renderer theme engine on
 * every switch; clears the per-tag cache so tags re-resolve in the new palette.
 */
export function setLogTheme(mode: LogTheme): void {
  if (mode === logTheme) return
  logTheme = mode
  tagCache.clear()
}

/** Deterministic per-tag color (same tag -> same hue across the session). */
export function tagColor(tag: string): string {
  if (!tag) {
    return META
  }
  const cached = tagCache.get(tag)
  if (cached !== undefined) {
    return cached
  }
  let h = 0
  for (let i = 0; i < tag.length; i++) {
    // `>>> 0` == Python's `& 0xFFFFFFFF` (ToUint32 keeps it 32-bit unsigned).
    h = (h * 31 + tag.charCodeAt(i)) >>> 0
  }
  const palette = logTheme === 'light' ? TAG_PALETTE_LIGHT : TAG_PALETTE
  const color = palette[h % palette.length]
  tagCache.set(tag, color)
  return color
}

/** Foreground color for a message cell, by level. */
export function msgColor(level: string): string {
  const table = logTheme === 'light' ? MSG_TEXT_LIGHT : MSG_TEXT
  return table[level] ?? table['?']
}
