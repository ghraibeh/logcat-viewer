/**
 * Inspector-parser parity tests — TS equivalents of the parse_bounds /
 * build_ui_tree / node_at checks in tests/smoke.py.
 */
import { describe, expect, it } from 'vitest'
import { buildUiTree, nodeAt, nodeArea, nodeLabel, parseBounds, type UiNode } from '@core/inspector'

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
    <node index="0" class="android.widget.Button" resource-id="com.x:id/ok" text="OK" clickable="true" bounds="[100,200][300,280]" />
    <node index="1" class="android.widget.TextView" text="Hello" bounds="[0,300][1080,360]" />
  </node>
</hierarchy>
UI hierchary dumped to: /dev/tty`

describe('parseBounds', () => {
  it('parses a bounds pair', () => {
    expect(parseBounds('[0,63][1080,231]')).toEqual([0, 63, 1080, 231])
  })
  it('returns null for malformed input', () => {
    expect(parseBounds('nonsense')).toBeNull()
    expect(parseBounds('')).toBeNull()
  })
})

describe('buildUiTree', () => {
  it('parses the hierarchy, tolerating trailing dump noise', () => {
    const root = buildUiTree(DUMP)!
    expect(root).not.toBeNull()
    expect(root.depth).toBe(0)
    expect(root.children).toHaveLength(1)
    const frame = root.children[0]
    expect(frame.attrs.class).toBe('android.widget.FrameLayout')
    expect(frame.children).toHaveLength(2)
    expect(frame.bounds).toEqual([0, 0, 1080, 2400])
  })

  it('builds friendly node labels (class #id “text”)', () => {
    const root = buildUiTree(DUMP)!
    const button = root.children[0].children[0]
    expect(nodeLabel(button)).toBe('Button  #ok  “OK”')
    expect(nodeArea(button)).toBe(200 * 80)
  })

  it('returns null when there is no XML', () => {
    expect(buildUiTree('no markup here')).toBeNull()
  })
})

describe('nodeAt (deepest then smallest)', () => {
  const root = buildUiTree(DUMP)!
  const label = (n: UiNode | null) => (n ? (n.attrs.class || '').split('.').pop() : null)

  it('hits the deepest node under a point', () => {
    expect(label(nodeAt(root, 200, 240))).toBe('Button')
    expect(label(nodeAt(root, 500, 320))).toBe('TextView')
  })
  it('falls back to the container when no child matches', () => {
    expect(label(nodeAt(root, 5, 5))).toBe('FrameLayout')
  })
  it('returns null outside all bounds', () => {
    expect(nodeAt(root, 5000, 5000)).toBeNull()
  })
})
