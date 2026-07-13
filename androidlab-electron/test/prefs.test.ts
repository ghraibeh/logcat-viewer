/**
 * SharedPreferences parity tests — TS equivalents of the prefs.py checks: the
 * adb command builders (run-as vs rooted su), the listing classifier, the
 * XML parse/build round-trip (the exact Android shape), and value validation.
 */
import { describe, expect, it } from 'vitest'
import * as P from '@core/prefs'

const SERIAL = 'R5CX22ZBQYJ'
const PKG = 'com.example.app'

describe('prefs adb command builders', () => {
  it('ls: run-as vs su', () => {
    expect(P.lsPrefsArgs(SERIAL, PKG)).toEqual(['-s', SERIAL, 'shell', 'run-as', PKG, 'ls', 'shared_prefs'])
    expect(P.lsPrefsArgs(SERIAL, PKG, true)).toEqual([
      '-s', SERIAL, 'shell', 'su', '-c', 'ls', `/data/data/${PKG}/shared_prefs`
    ])
  })
  it('cat streams via exec-out', () => {
    expect(P.catPrefArgs(SERIAL, PKG, 'settings.xml')).toEqual([
      '-s', SERIAL, 'exec-out', 'run-as', PKG, 'cat', 'shared_prefs/settings.xml'
    ])
    expect(P.catPrefArgs(SERIAL, PKG, 'settings.xml', true)).toEqual([
      '-s', SERIAL, 'exec-out', 'su', '-c', 'cat', `/data/data/${PKG}/shared_prefs/settings.xml`
    ])
  })
  it('write via dd of=<path>', () => {
    expect(P.writePrefArgs(SERIAL, PKG, 'settings.xml')).toEqual([
      '-s', SERIAL, 'shell', 'run-as', PKG, 'dd', 'of=shared_prefs/settings.xml'
    ])
    expect(P.writePrefArgs(SERIAL, PKG, 'settings.xml', true)).toEqual([
      '-s', SERIAL, 'shell', 'su', '-c', 'dd', `of=/data/data/${PKG}/shared_prefs/settings.xml`
    ])
  })
})

describe('classifyPrefsList', () => {
  it('keeps only .xml files, ok on clean exit', () => {
    const r = P.classifyPrefsList(0, 'settings.xml\nprefs.xml\ncache.dat\n', '')
    expect(r.ok).toBe(true)
    expect(r.files).toEqual(['settings.xml', 'prefs.xml'])
  })
  it('flags not-debuggable / no-such / denied as not ok', () => {
    expect(P.classifyPrefsList(0, '', 'run-as: package not debuggable').ok).toBe(false)
    expect(P.classifyPrefsList(1, '', 'ls: no such file or directory').ok).toBe(false)
    expect(P.classifyPrefsList(0, '', 'Permission denied').ok).toBe(false)
  })
})

describe('prefs XML parse/build', () => {
  const XML =
    "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>\n" +
    '    <string name="greeting">hello &amp; welcome</string>\n' +
    '    <int name="count" value="42" />\n' +
    '    <boolean name="dark" value="true" />\n' +
    '    <long name="ts" value="1700000000000" />\n' +
    '    <float name="ratio" value="1.5" />\n' +
    '    <set name="tags">\n        <string>a</string>\n        <string>b</string>\n    </set>\n' +
    '</map>\n'

  it('parses each typed row (order preserved)', () => {
    const prefs = P.parsePrefsXml(XML)
    expect(prefs).toEqual([
      { key: 'greeting', type: 'string', value: 'hello & welcome' },
      { key: 'count', type: 'int', value: '42' },
      { key: 'dark', type: 'boolean', value: 'true' },
      { key: 'ts', type: 'long', value: '1700000000000' },
      { key: 'ratio', type: 'float', value: '1.5' },
      { key: 'tags', type: 'set', value: 'a, b' }
    ])
  })

  it('round-trips build -> parse', () => {
    const prefs = P.parsePrefsXml(XML)
    const rebuilt = P.buildPrefsXml(prefs)
    expect(P.parsePrefsXml(rebuilt)).toEqual(prefs)
    // the declaration + <map> shape is preserved verbatim
    expect(rebuilt.startsWith("<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\n<map>")).toBe(true)
    expect(rebuilt.endsWith('</map>\n')).toBe(true)
  })

  it('escapes text + attribute values', () => {
    const xml = P.buildPrefsXml([{ key: 'a<b', type: 'string', value: 'x & y < z' }])
    expect(xml).toContain('<string name="a&lt;b">x &amp; y &lt; z</string>')
  })

  it('empty / non-XML input yields no rows', () => {
    expect(P.parsePrefsXml('')).toEqual([])
    expect(P.parsePrefsXml('not xml at all')).toEqual([])
  })
})

describe('validatePrefValue', () => {
  it('accepts valid values', () => {
    expect(P.validatePrefValue('int', '42')).toBeNull()
    expect(P.validatePrefValue('long', '1700000000000')).toBeNull()
    expect(P.validatePrefValue('float', '1.5')).toBeNull()
    expect(P.validatePrefValue('boolean', 'true')).toBeNull()
    expect(P.validatePrefValue('boolean', 'false')).toBeNull()
    expect(P.validatePrefValue('string', 'anything')).toBeNull()
  })
  it('rejects invalid values', () => {
    expect(P.validatePrefValue('int', 'nope')).toBe('not a valid int')
    expect(P.validatePrefValue('int', String(2 ** 31))).toBe('int out of 32-bit range')
    expect(P.validatePrefValue('float', 'x')).toBe('not a valid float')
    expect(P.validatePrefValue('boolean', 'yes')).toBe('boolean must be true or false')
  })
})
