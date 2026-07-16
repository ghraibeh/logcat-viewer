/**
 * iOS NSUserDefaults (plutil json) → shared Pref[] adapter tests.
 */
import { describe, expect, it } from 'vitest'
import { plistJsonToPrefs } from '@core/iosprefs'

describe('plistJsonToPrefs', () => {
  it('maps JS types to Pref types and sorts by key', () => {
    const prefs = plistJsonToPrefs(
      JSON.stringify({ name: 'x', count: 5, pi: 3.14, on: true, tags: ['a', 'b'] })
    )
    expect(prefs.map((p) => p.key)).toEqual(['count', 'name', 'on', 'pi', 'tags'])
    const byKey = Object.fromEntries(prefs.map((p) => [p.key, p]))
    expect(byKey.count).toMatchObject({ type: 'int', value: '5' })
    expect(byKey.pi).toMatchObject({ type: 'float', value: '3.14' })
    expect(byKey.on).toMatchObject({ type: 'boolean', value: 'true' })
    expect(byKey.name).toMatchObject({ type: 'string', value: 'x' })
    // arrays/dicts collapse to a read-only JSON view under `set`
    expect(byKey.tags).toMatchObject({ type: 'set', value: '["a","b"]' })
  })

  it('returns [] for non-object / invalid input', () => {
    expect(plistJsonToPrefs('[]')).toEqual([])
    expect(plistJsonToPrefs('not json')).toEqual([])
    expect(plistJsonToPrefs('42')).toEqual([])
  })
})
