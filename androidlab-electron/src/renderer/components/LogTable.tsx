/**
 * Virtualized log table — the QTableView + LevelBadgeDelegate + MessageDelegate
 * of ui.py/delegates.py, rebuilt with @tanstack/react-virtual. Fixed metadata
 * columns + a Message column that either wraps (variable row height, measured)
 * or stays single-line and grows to the widest visible line so the view scrolls
 * horizontally (a port of _fit_message_width / _resize_visible_rows).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { BADGE, BADGE_TEXT, META, msgColor, tagColor } from '@core/colors'
import type { Controller } from '../state/useAppController'

const W_TIME = 112
const W_PID = 60
const W_TID = 60
const W_LEVEL = 46
const W_TAG = 220
const FIXED = W_TIME + W_PID + W_TID + W_LEVEL + W_TAG
const MSG_MIN_W = 320
const H_PAD = 6
const V_PAD = 3

const MONO = 'SF Mono, Menlo, monospace'

let measureCanvas: HTMLCanvasElement | null = null
function measureText(text: string, font: string): number {
  if (!measureCanvas) measureCanvas = document.createElement('canvas')
  const ctx = measureCanvas.getContext('2d')
  if (!ctx) return text.length * 8
  ctx.font = font
  return ctx.measureText(text).width
}

export interface LogTableProps {
  c: Controller
  selectedRows: ReadonlySet<number>
  onRowMouseDown: (row: number, e: React.MouseEvent) => void
  onRowContextMenu: (row: number, e: React.MouseEvent) => void
}

export function LogTable({ c, selectedRows, onRowMouseDown, onRowContextMenu }: LogTableProps) {
  const version = useSyncExternalStore(c.store.subscribe, c.store.getSnapshot)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewportW, setViewportW] = useState(800)
  const stickBottomRef = useRef(false)

  const rowCount = c.store.rowCount()
  const rowHeight = Math.round(c.fontPt * 1.5) + 2 * V_PAD

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 12,
    measureElement: c.wrap
      ? (el) => (el as HTMLElement).getBoundingClientRect().height
      : undefined
  })

  // Re-measure when font / wrap change (heights depend on both).
  useLayoutEffect(() => {
    virtualizer.measure()
  }, [c.fontPt, c.wrap, version, virtualizer])

  // Track viewport width for the horizontal-fill computation.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportW(el.clientWidth))
    ro.observe(el)
    setViewportW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const items = virtualizer.getVirtualItems()

  // Non-wrap: grow the Message column to at least fill the viewport and to the
  // widest visible line, so the horizontal scrollbar reveals long rows.
  let contentWidth = viewportW
  if (!c.wrap) {
    const font = `${c.fontPt}px ${MONO}`
    let msgW = Math.max(MSG_MIN_W, viewportW - FIXED - 4)
    for (const it of items) {
      const e = c.store.entryAt(it.index)
      if (e) msgW = Math.max(msgW, measureText(e.msg, font) + 2 * H_PAD + 14)
    }
    contentWidth = Math.max(viewportW, FIXED + msgW)
  }

  // Auto-scroll to newest (matches ui.py's scrollToBottom on flush/filter).
  useEffect(() => {
    if (!c.autoscroll) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [rowCount, c.autoscroll, version])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (el) stickBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4
  }, [])

  return (
    <div className="log-view">
      <div className="log-header" style={{ width: c.wrap ? '100%' : contentWidth, marginLeft: 0 }}>
        <div className="col" style={{ width: W_TIME }}>
          Time
        </div>
        <div className="col" style={{ width: W_PID, textAlign: 'right' }}>
          PID
        </div>
        <div className="col" style={{ width: W_TID, textAlign: 'right' }}>
          TID
        </div>
        <div className="col" style={{ width: W_LEVEL, textAlign: 'center' }}>
          Lvl
        </div>
        <div className="col" style={{ width: W_TAG }}>
          Tag
        </div>
        <div className="col" style={{ flex: 1 }}>
          Message
        </div>
      </div>

      <div className="log-scroll" ref={scrollRef} onScroll={onScroll}>
        <div
          className="log-rows"
          style={{
            height: virtualizer.getTotalSize(),
            width: c.wrap ? '100%' : contentWidth
          }}
        >
          {items.map((vi) => {
            const e = c.store.entryAt(vi.index)
            if (!e) return null
            const selected = selectedRows.has(vi.index)
            return (
              <div
                key={vi.key}
                className={`log-row${selected ? ' selected' : ''}`}
                data-index={vi.index}
                ref={c.wrap ? virtualizer.measureElement : undefined}
                style={{
                  transform: `translateY(${vi.start}px)`,
                  fontSize: c.fontPt,
                  minHeight: c.wrap ? undefined : rowHeight
                }}
                onMouseDown={(ev) => onRowMouseDown(vi.index, ev)}
                onContextMenu={(ev) => onRowContextMenu(vi.index, ev)}
              >
                <div className="cell meta" style={{ width: W_TIME, color: META }}>
                  {e.time}
                </div>
                <div className="cell meta num" style={{ width: W_PID, color: META }}>
                  {e.pid ? e.pid : ''}
                </div>
                <div className="cell meta num" style={{ width: W_TID, color: META }}>
                  {e.tid ? e.tid : ''}
                </div>
                <div
                  className="cell"
                  style={{ width: W_LEVEL, display: 'flex', justifyContent: 'center' }}
                >
                  <span
                    className="level-badge"
                    style={{ background: BADGE[e.level] ?? BADGE['?'], color: BADGE_TEXT }}
                  >
                    {e.level}
                  </span>
                </div>
                <div className="cell" style={{ width: W_TAG, color: tagColor(e.tag) }}>
                  {e.tag}
                </div>
                <div
                  className={`cell msg${c.wrap ? '' : ' nowrap'}`}
                  style={{ color: msgColor(e.level) }}
                >
                  {e.msg}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
