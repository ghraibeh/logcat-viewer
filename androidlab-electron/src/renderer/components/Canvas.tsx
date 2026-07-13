/** A DPR-correct canvas that redraws via a callback on resize + dependency change. */
import { useEffect, useRef } from 'react'

export function Canvas({
  draw,
  deps,
  className,
  style
}: {
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void
  deps: unknown[]
  className?: string
  style?: React.CSSProperties
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawRef = useRef(draw)
  drawRef.current = draw

  const render = (): void => {
    const canvas = ref.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    const w = parent.clientWidth
    const h = parent.clientHeight
    if (w === 0 || h === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    drawRef.current(ctx, w, h)
  }

  useEffect(() => {
    render()
    const parent = ref.current?.parentElement
    if (!parent) return
    // Defer redraw to rAF so a resize-triggered canvas resize doesn't re-enter
    // the observer synchronously (avoids the benign "ResizeObserver loop" warning).
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(render)
    })
    ro.observe(parent)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => render(), deps)

  return <canvas ref={ref} className={className} style={style} />
}
