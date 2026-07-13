/**
 * Android-Studio-style log coloring: subtle per-level message text, solid level
 * badges, and a distinct stable color per tag.
 * Faithful port of logcat_viewer/colors.py (QColor -> hex strings for CSS).
 */

/** Metadata columns (time / pid / tid) — quiet. */
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

const tagCache = new Map<string, string>()

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
  const color = TAG_PALETTE[h % TAG_PALETTE.length]
  tagCache.set(tag, color)
  return color
}

/** Foreground color for a message cell, by level. */
export function msgColor(level: string): string {
  return MSG_TEXT[level] ?? MSG_TEXT['?']
}
