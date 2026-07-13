/**
 * A drawn app tile (rounded gradient square + initial). Placeholder equivalent
 * of appmgr.app_icon's drawn tile; Phase 3 will load real APK icons lazily.
 */
import { useMemo } from 'react'

const TILE_COLORS: Array<[string, string]> = [
  ['#e0a45e', '#c77f36'],
  ['#57c0c0', '#2f9a9a'],
  ['#c58fe0', '#9c5fc7'],
  ['#8fbf6b', '#5f9a3f'],
  ['#6f9ff0', '#3f6fc7'],
  ['#ef8f6b', '#c75f3f'],
  ['#e57fa0', '#c74f77'],
  ['#5fb0e0', '#2f80c0']
]

function hueIndex(pkg: string): number {
  let h = 0
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0
  return h % TILE_COLORS.length
}

export function AppIcon({ pkg, size = 22, all = false }: { pkg: string; size?: number; all?: boolean }) {
  const [c0, c1] = useMemo(() => (all ? ['#3a3f4d', '#272a34'] : TILE_COLORS[hueIndex(pkg)]), [pkg, all])
  const letter = all ? '∗' : (pkg.replace(/^[^a-zA-Z]+/, '')[0] ?? pkg[0] ?? '?').toUpperCase()
  const id = useMemo(() => 'g' + Math.abs(hueIndex(pkg + String(size))), [pkg, size])
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" className="icon" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={c0} />
          <stop offset="1" stopColor={c1} />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="20" height="20" rx="6" fill={`url(#${id})`} />
      <text
        x="11"
        y="11"
        dominantBaseline="central"
        textAnchor="middle"
        fill="#fff"
        fontSize="11"
        fontWeight="700"
        fontFamily="-apple-system, sans-serif"
      >
        {letter}
      </text>
    </svg>
  )
}
