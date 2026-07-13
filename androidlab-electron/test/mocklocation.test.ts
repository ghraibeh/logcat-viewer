/**
 * Mock GPS parity tests — TS equivalents of the mocklocation checks: the
 * set/stop adb arg builders (string extras + precision), coordinate validators,
 * the map document.title bridge parsers, and the preset list.
 */
import { describe, expect, it } from 'vitest'
import {
  HELPER_PKG,
  MOCK_APPOP,
  PRESETS,
  SERVICE,
  fmtCoord,
  formatG,
  mapLoadedStatus,
  parseCoordField,
  parseTitle,
  setArgs,
  stopArgs,
  validCoord,
  validLat,
  validLng
} from '@core/mocklocation'

describe('constants', () => {
  it('helper package + service + appop match the committed helper APK', () => {
    expect(HELPER_PKG).toBe('com.logcatviewer.mocklocation')
    expect(SERVICE).toBe('com.logcatviewer.mocklocation/.MockService')
    expect(MOCK_APPOP).toBe('android:mock_location')
  })
})

describe('setArgs', () => {
  it('carries -s serial + start-foreground-service with the set command', () => {
    const a = setArgs('R5CX', 37.7749, -122.4194)
    expect(a.slice(0, 6)).toEqual(['-s', 'R5CX', 'shell', 'am', 'start-foreground-service', '-n'])
    expect(a[6]).toBe(SERVICE)
    expect(a.join(' ')).toContain('--es cmd set')
  })

  it('passes lat/lng as fixed 7-decimal STRING extras (full precision)', () => {
    const a = setArgs('S', 12.3456789, -98.7654321)
    // --es (not --ef) preserves precision beyond a 32-bit float.
    expect(a.join(' ')).toContain('--es lat 12.3456789')
    expect(a.join(' ')).toContain('--es lng -98.7654321')
  })

  it('formats lat/lng to exactly 7 decimals', () => {
    const a = setArgs('S', 1, 2)
    const i = a.indexOf('lat')
    expect(a[i + 1]).toBe('1.0000000')
    const j = a.indexOf('lng')
    expect(a[j + 1]).toBe('2.0000000')
  })

  it('appends acc/alt only when provided (as %g extras)', () => {
    expect(setArgs('S', 1, 2).join(' ')).not.toContain('--es acc')
    const a = setArgs('S', 1, 2, 5)
    expect(a.slice(-3)).toEqual(['--es', 'acc', '5'])
    const b = setArgs('S', 1, 2, 5, 100)
    expect(b.join(' ')).toContain('--es acc 5')
    expect(b.slice(-3)).toEqual(['--es', 'alt', '100'])
  })
})

describe('stopArgs', () => {
  it('carries -s serial + the stop command', () => {
    expect(stopArgs('R5CX')).toEqual([
      '-s',
      'R5CX',
      'shell',
      'am',
      'start-foreground-service',
      '-n',
      SERVICE,
      '--es',
      'cmd',
      'stop'
    ])
  })
})

describe('number formatting', () => {
  it('fmtCoord is fixed 7-decimals', () => {
    expect(fmtCoord(0)).toBe('0.0000000')
    expect(fmtCoord(-0.1278)).toBe('-0.1278000')
  })
  it('formatG drops trailing zeros like Python %g', () => {
    expect(formatG(5)).toBe('5')
    expect(formatG(5.5)).toBe('5.5')
    expect(formatG(0)).toBe('0')
    expect(formatG(100)).toBe('100')
  })
})

describe('coordinate validators', () => {
  it('validLat/validLng enforce ±90 / ±180', () => {
    expect(validLat(90)).toBe(true)
    expect(validLat(-90)).toBe(true)
    expect(validLat(90.1)).toBe(false)
    expect(validLng(180)).toBe(true)
    expect(validLng(-180)).toBe(true)
    expect(validLng(180.1)).toBe(false)
    expect(validLat(NaN)).toBe(false)
    expect(validCoord(37.77, -122.41)).toBe(true)
    expect(validCoord(37.77, -999)).toBe(false)
  })
  it('parseCoordField mirrors Python float(): trimmed, null on empty/invalid', () => {
    expect(parseCoordField(' 37.7749 ')).toBe(37.7749)
    expect(parseCoordField('-122')).toBe(-122)
    expect(parseCoordField('')).toBeNull()
    expect(parseCoordField('   ')).toBeNull()
    expect(parseCoordField('1abc')).toBeNull()
    expect(parseCoordField('abc')).toBeNull()
  })
})

describe('parseTitle (MOCKLOC bridge)', () => {
  it('parses a picked coordinate + seq', () => {
    const p = parseTitle('MOCKLOC:37.7749000,-122.4194000|7')
    expect(p).not.toBeNull()
    expect(p!.lat).toBeCloseTo(37.7749, 6)
    expect(p!.lng).toBeCloseTo(-122.4194, 6)
    expect(p!.seq).toBe(7)
  })
  it('tolerates a missing seq', () => {
    const p = parseTitle('MOCKLOC:1.5,2.5')
    expect(p).toEqual({ lat: 1.5, lng: 2.5, seq: 0 })
  })
  it('rejects non-pick / malformed titles', () => {
    expect(parseTitle('map')).toBeNull()
    expect(parseTitle('MAPLOADED:ok')).toBeNull()
    expect(parseTitle('MOCKLOC:notanumber,2|1')).toBeNull()
    expect(parseTitle('MOCKLOC:1,2,3|1')).toBeNull()
    expect(parseTitle('MOCKLOC:1|1')).toBeNull()
  })
})

describe('mapLoadedStatus (MAPLOADED bridge)', () => {
  it('reads the map-ready signal, null for anything else', () => {
    expect(mapLoadedStatus('MAPLOADED:ok')).toBe(true)
    expect(mapLoadedStatus('MAPLOADED:err')).toBe(false)
    expect(mapLoadedStatus('MOCKLOC:1,2|1')).toBeNull()
    expect(mapLoadedStatus('map')).toBeNull()
  })
})

describe('presets', () => {
  it('ships the seven preset cities with valid coordinates', () => {
    expect(PRESETS.length).toBe(7)
    expect(PRESETS.map((p) => p.name)).toContain('San Francisco')
    expect(PRESETS.map((p) => p.name)).toContain('Tokyo')
    for (const p of PRESETS) expect(validCoord(p.lat, p.lng)).toBe(true)
  })
})
