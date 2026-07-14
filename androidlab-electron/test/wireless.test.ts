/**
 * Wireless adb parity tests — TS equivalents of wireless.py's smoke checks:
 * the arg builders, wlan-IP scraping from `ip route`, and success detection.
 */
import { describe, expect, it } from 'vitest'
import * as W from '@core/wireless'

describe('wireless builders', () => {
  it('build args without a baked-in serial (the service adds -s)', () => {
    expect(W.tcpipArgs()).toEqual(['tcpip', '5555'])
    expect(W.tcpipArgs(1234)).toEqual(['tcpip', '1234'])
    expect(W.ipRouteArgs()).toEqual(['shell', 'ip', 'route'])
    expect(W.connectArgs('10.0.0.4:5555')).toEqual(['connect', '10.0.0.4:5555'])
  })
})

describe('parseDeviceIp', () => {
  it('prefers the wlan src IP over other interfaces', () => {
    const route = [
      '10.0.2.0/24 dev radio0 proto kernel scope link src 10.0.2.15',
      '192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.77'
    ].join('\n')
    expect(W.parseDeviceIp(route)).toBe('192.168.1.77')
  })
  it('falls back to any src when there is no wlan line', () => {
    expect(W.parseDeviceIp('default via 10.0.0.1 dev eth0 src 10.0.0.5')).toBe('10.0.0.5')
  })
  it('returns null when no src is present', () => {
    expect(W.parseDeviceIp('no routes here')).toBeNull()
  })
})

describe('looksOk', () => {
  it('accepts every adb success phrasing, rejects failures', () => {
    expect(W.looksOk('connected to 192.168.1.77:5555')).toBe(true)
    expect(W.looksOk('already connected to 192.168.1.77:5555')).toBe(true)
    expect(W.looksOk('restarting in TCP mode port: 5555')).toBe(true)
    expect(W.looksOk('successfully paired to 192.168.1.77:37000')).toBe(true)
    expect(W.looksOk('cannot connect: connection refused')).toBe(false)
    expect(W.looksOk('(no output)')).toBe(false)
  })
})
