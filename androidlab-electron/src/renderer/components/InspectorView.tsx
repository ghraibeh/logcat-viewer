/**
 * Layout Inspector — port of inspector.py's InspectorView: capture a screenshot
 * + uiautomator hierarchy, then two-way selection between the screenshot (click
 * to pick the node under the cursor) and the hierarchy tree, with a properties
 * table for the selected node.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildUiTree,
  nodeAt,
  nodeLabel,
  type Bounds,
  type UiNode
} from '@core/inspector'
import { PALETTE } from '../theme'
import type { Controller } from '../state/useAppController'
import { Icon } from './Icon'
import { EmptyState, type EmptyStateProps } from './EmptyState'

function findPath(root: UiNode, id: number): UiNode[] {
  const path: UiNode[] = []
  const walk = (n: UiNode, acc: UiNode[]): boolean => {
    const next = [...acc, n]
    if (n.id === id) {
      path.push(...next)
      return true
    }
    return n.children.some((c) => walk(c, next))
  }
  walk(root, [])
  return path
}

function ShotCanvas({
  img,
  selection,
  onPick
}: {
  img: HTMLImageElement | null
  selection: Bounds | null
  onPick: (x: number, y: number) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const fitRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)

  const draw = useCallback((): void => {
    const canvas = ref.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return
    const cw = parent.clientWidth
    const ch = parent.clientHeight
    if (cw === 0 || ch === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(cw * dpr)
    canvas.height = Math.round(ch * dpr)
    canvas.style.width = `${cw}px`
    canvas.style.height = `${ch}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = PALETTE.BG
    ctx.fillRect(0, 0, cw, ch)
    if (!img) {
      // The guided <EmptyState> overlay (see below) covers this pane when there
      // is no capture yet; the canvas just paints its background.
      fitRef.current = null
      return
    }
    const scale = Math.min(cw / img.width, ch / img.height)
    const w = img.width * scale
    const h = img.height * scale
    const x = (cw - w) / 2
    const y = (ch - h) / 2
    fitRef.current = { x, y, w, h }
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(img, x, y, w, h)
    if (selection) {
      const sx = w / img.width
      const sy = h / img.height
      const [l, t, r, b] = selection
      ctx.fillStyle = 'rgba(110, 123, 255, 0.16)'
      ctx.strokeStyle = PALETTE.ACCENT
      ctx.lineWidth = 2
      const rx = x + l * sx
      const ry = y + t * sy
      const rw = (r - l) * sx
      const rh = (b - t) * sy
      ctx.fillRect(rx, ry, rw, rh)
      ctx.strokeRect(rx, ry, rw, rh)
    }
  }, [img, selection])

  useEffect(() => {
    draw()
    const parent = ref.current?.parentElement
    if (!parent) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(draw)
    })
    ro.observe(parent)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [draw])

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const fit = fitRef.current
    if (!fit || !img) return
    const rect = ref.current!.getBoundingClientRect()
    const px = e.clientX - rect.left - fit.x
    const py = e.clientY - rect.top - fit.y
    if (px >= 0 && px < fit.w && py >= 0 && py < fit.h) {
      onPick(Math.round((px * img.width) / fit.w), Math.round((py * img.height) / fit.h))
    }
  }

  return <canvas ref={ref} onClick={onClick} />
}

function TreeNode({
  node,
  selectedId,
  expanded,
  onToggle,
  onSelect
}: {
  node: UiNode
  selectedId: number | null
  expanded: ReadonlySet<number>
  onToggle: (id: number) => void
  onSelect: (node: UiNode) => void
}) {
  const isOpen = expanded.has(node.id)
  const hasKids = node.children.length > 0
  return (
    <div>
      <div
        id={`insp-node-${node.id}`}
        className={`insp-node${node.id === selectedId ? ' selected' : ''}`}
        style={{ paddingLeft: node.depth * 12 }}
        onClick={() => onSelect(node)}
      >
        <span
          className="insp-twisty"
          onClick={(e) => {
            e.stopPropagation()
            if (hasKids) onToggle(node.id)
          }}
        >
          {hasKids ? <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={12} /> : null}
        </span>
        <span>{nodeLabel(node)}</span>
      </div>
      {isOpen
        ? node.children.map((c) => (
            <TreeNode
              key={c.id}
              node={c}
              selectedId={selectedId}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))
        : null}
    </div>
  )
}

export function InspectorView({ c }: { c: Controller }) {
  const [root, setRoot] = useState<UiNode | null>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selection, setSelection] = useState<Bounds | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [capturing, setCapturing] = useState(false)
  const [status, setStatus] = useState('')

  // Reset when the device changes.
  useEffect(() => {
    setRoot(null)
    setImg(null)
    setSelectedId(null)
    setSelection(null)
    setStatus('')
  }, [c.serial])

  const selectedNode = useMemo(() => {
    if (root === null || selectedId === null) return null
    let found: UiNode | null = null
    const walk = (n: UiNode): void => {
      if (n.id === selectedId) found = n
      else n.children.forEach(walk)
    }
    walk(root)
    return found as UiNode | null
  }, [root, selectedId])

  const selectNode = useCallback((node: UiNode) => {
    setSelectedId(node.id)
    setSelection(node.bounds)
  }, [])

  const onPick = useCallback(
    (x: number, y: number) => {
      if (!root) return
      const node = nodeAt(root, x, y)
      if (!node) return
      selectNode(node)
      // Ensure ancestors are expanded, then scroll the row into view.
      const path = findPath(root, node.id)
      setExpanded((prev) => new Set([...prev, ...path.map((p) => p.id)]))
      setTimeout(() => document.getElementById(`insp-node-${node.id}`)?.scrollIntoView({ block: 'nearest' }), 0)
    },
    [root, selectNode]
  )

  const capture = useCallback(async () => {
    if (!c.serial) {
      setStatus('No device selected')
      return
    }
    setCapturing(true)
    setStatus('Capturing…')
    const res = await window.androidlab.inspect.capture(c.serial)
    setCapturing(false)
    if (!res.ok) {
      setStatus(`✗ ${res.message}`)
      return
    }
    const tree = buildUiTree(res.xml)
    const image = new Image()
    image.onload = () => setImg(image)
    image.src = `data:image/png;base64,${res.pngBase64}`
    setRoot(tree)
    setSelectedId(null)
    setSelection(null)
    // Expand to depth 3 by default (like tree.expandToDepth(3)).
    const exp = new Set<number>()
    if (tree) {
      const walk = (n: UiNode): void => {
        if (n.depth <= 3) exp.add(n.id)
        n.children.forEach(walk)
      }
      walk(tree)
    }
    setExpanded(exp)
    let count = 0
    const countNodes = (n: UiNode): void => {
      count++
      n.children.forEach(countNodes)
    }
    if (tree) tree.children.forEach(countNodes)
    setStatus(`${count} views captured`)
  }, [c.serial])

  const toggle = useCallback((id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const props = useMemo(() => {
    if (!selectedNode) return [] as Array<[string, string]>
    const entries = Object.entries(selectedNode.attrs)
    const primary = entries.filter(([, v]) => v !== '' && v !== 'false')
    const falsy = entries.filter(([, v]) => v === 'false')
    return [...primary, ...falsy]
  }, [selectedNode])

  // Guided placeholder for the (empty) screenshot pane — mirrors the Logs / DB
  // treatment: connect a device → capture → (busy) → recover from a failure.
  const captureFailed = status.startsWith('✗')
  const canvasScene: EmptyStateProps = capturing
    ? {
        icon: 'camera',
        pulse: true,
        title: 'Capturing…',
        body: 'Grabbing a screenshot and the view hierarchy from the device.'
      }
    : !c.serial
      ? {
          icon: 'phone',
          title: 'No device connected',
          body: 'Connect a device to inspect its on-screen layout.',
          actions: [{ label: 'Refresh devices', icon: 'refresh', primary: true, onClick: () => void c.refreshDevices() }]
        }
      : captureFailed
        ? {
            icon: 'alertTriangle',
            tone: 'warn',
            title: 'Capture failed',
            body: status.replace(/^✗\s*/, ''),
            actions: [{ label: 'Try again', icon: 'refresh', primary: true, onClick: () => void capture() }]
          }
        : {
            icon: 'camera',
            title: 'Inspect the current screen',
            body: 'Capture a screenshot and the uiautomator view hierarchy to explore every view — its bounds, text and properties.',
            actions: [{ label: 'Capture', icon: 'camera', primary: true, onClick: () => void capture() }],
            hint: 'Then click the screenshot or a tree row to select a view.'
          }

  return (
    <div className="insp-view">
      <div className="insp-bar">
        <button
          disabled={capturing}
          title="Screenshot + uiautomator view-hierarchy dump of the current screen"
          onClick={() => void capture()}
        >
          {capturing ? (
            'Capturing…'
          ) : (
            <>
              <Icon name="camera" size={15} />
              Capture
            </>
          )}
        </button>
        <span className="insp-hint">Click the screenshot or the tree to inspect a view</span>
        <span className="insp-status">{status}</span>
      </div>
      <div className="insp-split">
        <div className="insp-canvas-wrap">
          <ShotCanvas img={img} selection={selection} onPick={onPick} />
          {!img ? (
            <div className="empty-overlay">
              <EmptyState {...canvasScene} />
            </div>
          ) : null}
        </div>
        <div className="insp-right">
          <div className="insp-tree">
            {root ? (
              root.children.map((n) => (
                <TreeNode
                  key={n.id}
                  node={n}
                  selectedId={selectedId}
                  expanded={expanded}
                  onToggle={toggle}
                  onSelect={selectNode}
                />
              ))
            ) : (
              <div className="empty-overlay">
                <EmptyState
                  compact
                  icon="eye"
                  title="View hierarchy"
                  body="Capture a screen to load its view tree here."
                />
              </div>
            )}
          </div>
          <div className="insp-props">
            {root && !selectedNode ? (
              <div className="empty-overlay">
                <EmptyState
                  compact
                  title="No view selected"
                  body="Click the screenshot or a tree row to see a view’s properties."
                />
              </div>
            ) : (
              <table>
                <tbody>
                  {props.map(([k, v]) => (
                    <tr key={k}>
                      <td className="k">{k}</td>
                      <td className="v">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
