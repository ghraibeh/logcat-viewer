/** A row of per-core vertical bars, heat-colored by load — canvas port of
 *  monitor.py's CoreBars. */
import { Canvas } from './Canvas'
import { PALETTE } from '../theme'

function heat(pct: number | null): string {
  if (pct === null) return PALETTE.BORDER_2
  if (pct < 50) return PALETTE.GREEN
  if (pct < 80) return PALETTE.AMBER
  return PALETTE.RED
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

export function CoreBars({ values }: { values: Array<number | null> }) {
  return (
    <Canvas
      className="core-bars"
      style={{ width: '100%', height: '100%' }}
      deps={[values]}
      draw={(ctx, w, h) => {
        ctx.fillStyle = PALETTE.BG
        ctx.fillRect(0, 0, w, h)
        const n = values.length
        if (n === 0) {
          ctx.fillStyle = PALETTE.TEXT_DIM
          ctx.font = '12px -apple-system, sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText('waiting for per-core data…', w / 2, h / 2)
          return
        }
        const topPad = 16
        const bottomPad = 16
        const trackH = h - topPad - bottomPad
        const gap = 8
        const bw = (w - gap * (n + 1)) / n
        const base = h - bottomPad
        ctx.textAlign = 'center'
        for (let i = 0; i < n; i++) {
          const pct = values[i]
          const x = gap + i * (bw + gap)
          ctx.fillStyle = PALETTE.SURFACE_2
          roundRect(ctx, x, topPad, bw, trackH, 4)
          ctx.fill()
          const val = pct === null ? 0 : Math.max(0, Math.min(100, pct))
          const fh = Math.round((trackH * val) / 100)
          if (fh > 0) {
            ctx.fillStyle = heat(pct)
            roundRect(ctx, x, base - fh, bw, fh, 4)
            ctx.fill()
          }
          ctx.fillStyle = PALETTE.TEXT
          ctx.font = '11px -apple-system, sans-serif'
          ctx.textBaseline = 'bottom'
          ctx.fillText(pct === null ? '–' : `${Math.round(val)}%`, x + bw / 2, topPad - 2)
          ctx.fillStyle = PALETTE.TEXT_DIM
          ctx.textBaseline = 'top'
          ctx.fillText(`C${i}`, x + bw / 2, base + 2)
        }
      }}
    />
  )
}
