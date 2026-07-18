import { describe, it, expect } from 'vitest'
import { parsePlist } from '../src/core/bplist'
import { plistValueToPrefs } from '../src/core/iosprefs'

// A real Apple-produced binary plist (`plutil -convert binary1`) covering every
// type NSUserDefaults emits: string (with entities + unicode/emoji), int, real,
// bool, date, data, nested array + dict. Notably `plutil -convert json` REFUSES
// this file (the <data>/<date> members make it "Invalid object for JSON format"),
// which is exactly why the pure-JS reader replaces plutil.
const BIN_B64 =
  'YnBsaXN0MDDaAQIDBAUGBwgJCgsMDQ4SFxgZGhtWdm9sdW1lXxAPYW5hbHl0aWNzT3B0T3V0WGZpcnN0UnVu' +
  'W3JlY2VudEl0ZW1zW3dpbmRvd0ZyYW1lVWVtb2ppWHVzZXJuYW1lVXRva2VuWmxhc3RPcGVuZWRbbGF1bmNo' +
  'Q291bnQjP+gAAAAAAAAICaMPEAxVYWxwaGEQBwjSExQVFlF4UXkQZBDIbxAPAGMAYQBmAOkAIAC3ACBl5Wcs' +
  'ip4AIAC3ACDYPN+JXxATcGVuZ3VpbiAmIGNvIDx0ZXN0PklIZWxsbyBpT1MzQcgFOfQAAAAQKggdJDY/S1dd' +
  'Zmx3g4yNjpKYmpugoqSmqMnf6fIAAAAAAAABAQAAAAAAAAAcAAAAAAAAAAAAAAAAAAAA9A=='

describe('parsePlist — binary (bplist00)', () => {
  const root = parsePlist(Buffer.from(BIN_B64, 'base64')) as Record<string, unknown>

  it('decodes scalars, entities, unicode and emoji', () => {
    expect(root.username).toBe('penguin & co <test>')
    expect(root.emoji).toBe('café · 日本語 · 🎉')
    expect(root.launchCount).toBe(42)
    expect(root.volume).toBeCloseTo(0.75, 10)
    expect(root.firstRun).toBe(true)
    expect(root.analyticsOptOut).toBe(false)
  })

  it('decodes date → ISO string and data → base64 (what plutil json cannot)', () => {
    expect(root.lastOpened).toBe('2026-07-17T14:30:00.000Z')
    expect(root.token).toBe('SGVsbG8gaU9T') // base64 of "Hello iOS"
    expect(Buffer.from(root.token as string, 'base64').toString('utf8')).toBe('Hello iOS')
  })

  it('decodes nested array and dict', () => {
    expect(root.recentItems).toEqual(['alpha', 7, false])
    expect(root.windowFrame).toEqual({ x: 100, y: 200 })
  })

  it('feeds the shared Pref[] converter (types inferred correctly)', () => {
    const prefs = plistValueToPrefs(root)
    const by = Object.fromEntries(prefs.map((p) => [p.key, p]))
    expect(by.launchCount).toMatchObject({ type: 'int', value: '42' })
    expect(by.volume).toMatchObject({ type: 'float', value: '0.75' })
    expect(by.firstRun).toMatchObject({ type: 'boolean', value: 'true' })
    expect(by.username).toMatchObject({ type: 'string', value: 'penguin & co <test>' })
    // nested array/dict render as the read-only flattened `set` view
    expect(by.recentItems.type).toBe('set')
    expect(by.windowFrame.type).toBe('set')
    // keys are sorted case-insensitively
    expect(prefs.map((p) => p.key)).toEqual([...prefs.map((p) => p.key)].sort((a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1))
  })
})

describe('parsePlist — XML fallback', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>name</key><string>a &amp; b</string>
  <key>count</key><integer>3</integer>
  <key>ratio</key><real>1.5</real>
  <key>enabled</key><true/>
  <key>disabled</key><false/>
  <key>tags</key><array><string>x</string><string>y</string></array>
  <key>nested</key><dict><key>k</key><integer>9</integer></dict>
  <key>empty</key><string></string>
</dict>
</plist>`

  it('decodes the standard element set', () => {
    expect(parsePlist(Buffer.from(xml, 'utf8'))).toEqual({
      name: 'a & b',
      count: 3,
      ratio: 1.5,
      enabled: true,
      disabled: false,
      tags: ['x', 'y'],
      nested: { k: 9 },
      empty: ''
    })
  })
})

describe('parsePlist — errors', () => {
  it('throws on a non-plist buffer', () => {
    expect(() => parsePlist(Buffer.from('just some text', 'utf8'))).toThrow()
  })
})
