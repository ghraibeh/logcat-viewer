/**
 * History graph of fractions in [0,1] — canvas port of monitor.py's SparkGraph.
 * The primary series is filled; an optional secondary (selected-app) series is a
 * plain line. Newest sample pinned to the right edge; nulls create gaps.
 */
import { Canvas } from './Canvas'
import { PALETTE } from '../theme'

export const SPARK_MAXLEN = 120

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

type Pt = { x: number; y: number } | null

function drawSeries(
  ctx: CanvasRenderingContext2D,
  pts: Pt[],
  color: string,
  h: number,
  fill: boolean
): void {
  const fillColor = hexToRgba(color, 46 / 255)
  let seg: Array<{ x: number; y: number }> = []
  const flush = (): void => {
    if (seg.length >= 2) {
      if (fill) {
        ctx.beginPath()
        ctx.moveTo(seg[0].x, seg[0].y)
        for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y)
        ctx.lineTo(seg[seg.length - 1].x, h)
        ctx.lineTo(seg[0].x, h)
        ctx.closePath()
        ctx.fillStyle = fillColor
        ctx.fill()
      }
      ctx.beginPath()
      ctx.moveTo(seg[0].x, seg[0].y)
      for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y)
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.lineJoin = 'round'
      ctx.stroke()
    }
    seg = []
  }
  for (const pt of pts) {
    if (pt === null) flush()
    else seg.push(pt)
  }
  flush()
}

export function SparkGraph({
  values,
  appValues,
  color,
  appColor
}: {
  values: Array<number | null>
  appValues: Array<number | null>
  color: string
  appColor: string
}) {
  return (
    <Canvas
      className="spark"
      style={{ width: '100%', height: '100%' }}
      deps={[values, appValues, color, appColor]}
      draw={(ctx, w, h) => {
        ctx.fillStyle = PALETTE.BG
        ctx.fillRect(0, 0, w, h)
        ctx.strokeStyle = PALETTE.BORDER
        ctx.lineWidth = 1
        for (const frac of [0.25, 0.5, 0.75]) {
          const y = Math.round(h - frac * h) + 0.5
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(w, y)
          ctx.stroke()
        }
        const step = w / (SPARK_MAXLEN - 1)
        const points = (vals: Array<number | null>): Pt[] => {
          const n = vals.length
          const x0 = w - (n - 1) * step
          return vals.map((v, i) => (v === null ? null : { x: x0 + i * step, y: h - 2 - v * (h - 4) }))
        }
        drawSeries(ctx, points(values), color, h, true)
        if (appValues.some((v) => v !== null)) drawSeries(ctx, points(appValues), appColor, h, false)
      }}
    />
  )
}
