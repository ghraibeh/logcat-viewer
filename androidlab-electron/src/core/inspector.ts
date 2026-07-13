/**
 * Layout Inspector pure helpers. Faithful port of logcat_viewer/inspector.py's
 * Qt-free helpers: screencap/uidump arg builders, bounds parsing, uiautomator
 * XML → UiNode tree, and the deepest-then-smallest hit test.
 */
import { XMLParser } from 'fast-xml-parser'

export function screencapArgs(serial: string): string[] {
  return ['-s', serial, 'exec-out', 'screencap', '-p']
}

export function uidumpArgs(serial: string): string[] {
  // Dump the accessibility hierarchy straight to stdout (no temp file).
  return ['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty']
}

export type Bounds = [number, number, number, number]

/** '[0,63][1080,231]' -> [0, 63, 1080, 231], or null. */
export function parseBounds(s: string): Bounds | null {
  try {
    const i1 = s.indexOf(']')
    const i2 = s.lastIndexOf('[')
    if (i1 < 0 || i2 < 0) return null
    const [l, t] = s.slice(1, i1).split(',')
    const [r, b] = s.slice(i2 + 1, -1).split(',')
    const nums = [l, t, r, b].map((n) => parseInt(n, 10))
    if (nums.some((n) => Number.isNaN(n))) return null
    return nums as Bounds
  } catch {
    return null
  }
}

export interface UiNode {
  id: number
  attrs: Record<string, string>
  bounds: Bounds | null
  depth: number
  children: UiNode[]
}

export function nodeLabel(node: UiNode): string {
  const cls = (node.attrs.class || '?').split('.').pop() as string
  let rid = node.attrs['resource-id'] || ''
  rid = rid ? (rid.includes('/') ? (rid.split('/').pop() as string) : rid) : ''
  const text = node.attrs.text || ''
  const bits = [cls]
  if (rid) bits.push(`#${rid}`)
  if (text) bits.push(`“${text.slice(0, 24)}”`)
  return bits.join('  ')
}

export function nodeArea(node: UiNode): number {
  if (!node.bounds) return 2 ** 62
  const [l, t, r, b] = node.bounds
  return Math.max(0, r - l) * Math.max(0, b - t)
}

const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  processEntities: true
})

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

/** Parse a uiautomator dump into a UiNode tree. Tolerates the trailing
 *  'UI hierchary dumped to: …' noise after the XML. */
export function buildUiTree(xmlText: string): UiNode | null {
  const end = xmlText.lastIndexOf('</hierarchy>')
  if (end >= 0) xmlText = xmlText.slice(0, end + '</hierarchy>'.length)
  const start = xmlText.indexOf('<')
  if (start < 0) return null

  let parsed: Record<string, unknown>
  try {
    parsed = XML.parse(xmlText.slice(start)) as Record<string, unknown>
  } catch {
    return null
  }
  const hierarchy = parsed.hierarchy as Record<string, unknown> | undefined
  if (!hierarchy) return null

  let counter = 0
  const nextId = (): number => counter++

  const wrap = (obj: Record<string, unknown>, depth: number): UiNode => {
    const attrs: Record<string, string> = {}
    for (const k of Object.keys(obj)) {
      if (k.startsWith('@_')) attrs[k.slice(2)] = String(obj[k])
    }
    const node: UiNode = {
      id: nextId(),
      attrs,
      bounds: parseBounds(attrs.bounds ?? ''),
      depth,
      children: []
    }
    node.children = toArray(obj.node as Record<string, unknown> | Record<string, unknown>[]).map((c) =>
      wrap(c, depth + 1)
    )
    return node
  }

  const root: UiNode = { id: nextId(), attrs: { class: 'hierarchy' }, bounds: null, depth: 0, children: [] }
  root.children = toArray(
    hierarchy.node as Record<string, unknown> | Record<string, unknown>[]
  ).map((c) => wrap(c, 1))
  return root
}

/** Deepest (then smallest) node whose bounds contain (x, y). */
export function nodeAt(root: UiNode, x: number, y: number): UiNode | null {
  let best: UiNode | null = null
  const visit = (n: UiNode): void => {
    if (n.bounds) {
      const [l, t, r, b] = n.bounds
      if (l <= x && x < r && t <= y && y < b) {
        if (
          best === null ||
          n.depth > best.depth ||
          (n.depth === best.depth && nodeArea(n) < nodeArea(best))
        ) {
          best = n
        }
      }
    }
    for (const c of n.children) visit(c)
  }
  visit(root)
  return best
}
