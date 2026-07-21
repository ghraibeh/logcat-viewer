/**
 * Single-line text that scrolls (marquee) instead of truncating with an ellipsis — but only
 * when it actually overflows its container. Measures on mount + resize; if the text fits it
 * stays static. Gentle ping-pong with pauses at each end so it stays readable, and it honors
 * prefers-reduced-motion (falls back to a static, clipped line).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'

export function Marquee({ text, className }: { text: string; className?: string }): JSX.Element {
  const outer = useRef<HTMLSpanElement>(null)
  const inner = useRef<HTMLSpanElement>(null)
  const [over, setOver] = useState(0)

  useEffect(() => {
    const o = outer.current
    const i = inner.current
    if (!o || !i) return
    const measure = (): void => {
      const diff = i.scrollWidth - o.clientWidth
      setOver(diff > 2 ? diff : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(o)
    return () => ro.disconnect()
  }, [text])

  const style = over
    ? ({ '--mq-shift': `${over}px`, '--mq-dur': `${Math.max(3, over / 35)}s` } as CSSProperties)
    : undefined

  return (
    <span ref={outer} className={`mq${over ? ' mq--over' : ''}${className ? ` ${className}` : ''}`}>
      <span ref={inner} className="mq-inner" style={style}>
        {text}
      </span>
    </span>
  )
}
