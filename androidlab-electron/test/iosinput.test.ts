/**
 * iOS touch/keyboard forwarding core tests — argv builders for the go-ios signing
 * + UI-injection flow, and the `ui size` parser used to map canvas clicks to points.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BUNDLE_ID,
  DEVICEKIT_XCTEST_CONFIG,
  MAX_GESTURE_POINTS,
  MAX_POINTER_ACTION_POINTS,
  computeFlick,
  WDA_LOCAL_URL,
  WDA_PORT,
  appsListArgs,
  ascReady,
  defaultConfig,
  deviceKitKey,
  dkGestureParams,
  dkKeysParams,
  dkRpc,
  dkTapParams,
  findDeviceKitBundleId,
  wdaKeyValue,
  findWdaBundleId,
  forwardArgs,
  manualReady,
  methodReady,
  parseUiSize,
  pathToGestureActions,
  pathToPointerActions,
  provisionArgs,
  runDeviceKitArgs,
  runWdaArgs,
  uiButtonArgs,
  uiDriverFlags,
  uiInstallArgs,
  uiSizeArgs,
  uiSwipeArgs,
  uiTapArgs,
  uiTypeArgs,
  type DkPathPoint,
  type IosSigning
} from '../src/core/iosinput'

const UDID = '00008110-001A40220100A01E'
const SIGN: IosSigning = {
  keyId: 'ABC123DEFG',
  issuerId: '69a6de70-1234-47e3-e053-0000',
  p8Path: '/Users/me/AuthKey_ABC123DEFG.p8',
  bundleId: 'com.example.uiagent',
  agent: 'devicekit'
}

describe('iosinput config', () => {
  it('defaults to the manual (cert+profile) method, WDA, not provisioned', () => {
    const c = defaultConfig()
    expect(c.method).toBe('manual')
    expect(c.agent).toBe('wda')
    expect(c.bundleId).toBe(DEFAULT_BUNDLE_ID)
    expect(c.provisioned).toBe(false)
  })

  it('ascReady requires all ASC identity fields', () => {
    expect(ascReady(SIGN)).toBe(true)
    expect(ascReady({ ...SIGN, keyId: '' })).toBe(false)
    expect(ascReady({ ...SIGN, p8Path: '  ' })).toBe(false)
  })

  it('manualReady requires a cert + profile (password optional)', () => {
    expect(manualReady({ p12Path: '/c.p12', profilePath: '/p.mobileprovision' })).toBe(true)
    expect(manualReady({ p12Path: '', profilePath: '/p.mobileprovision' })).toBe(false)
    expect(manualReady({ p12Path: '/c.p12', profilePath: '  ' })).toBe(false)
  })

  it('methodReady dispatches on the selected method', () => {
    const c = defaultConfig()
    expect(methodReady({ ...c, method: 'manual', p12Path: '/c.p12', profilePath: '/p.mp' })).toBe(true)
    expect(methodReady({ ...c, method: 'manual' })).toBe(false)
    expect(methodReady({ ...c, method: 'asc', ...SIGN })).toBe(true)
    expect(methodReady({ ...c, method: 'asc' })).toBe(false)
  })
})

describe('uiInstall password', () => {
  it('adds --p12password only when provided', () => {
    expect(uiInstallArgs(UDID, 'devicekit', '/a.p12', '/a.mp')).not.toContain('--p12password=')
    expect(uiInstallArgs(UDID, 'devicekit', '/a.p12', '/a.mp', 'secret')).toContain('--p12password=secret')
  })
})

describe('provision + install args', () => {
  it('provisionArgs passes the ASC key + output paths + udid', () => {
    const a = provisionArgs(UDID, SIGN, '/out/agent.p12', '/out/agent.mobileprovision')
    expect(a.slice(0, 3)).toEqual(['sign', 'provision', 'appstoreconnect'])
    expect(a).toContain('--bundleid=com.example.uiagent')
    expect(a).toContain('--asc-key-id=ABC123DEFG')
    expect(a).toContain('--asc-issuer-id=69a6de70-1234-47e3-e053-0000')
    expect(a).toContain('--asc-private-key=/Users/me/AuthKey_ABC123DEFG.p8')
    expect(a).toContain('--p12-output=/out/agent.p12')
    expect(a).toContain('--profile-output=/out/agent.mobileprovision')
    expect(a).toContain(`--udid=${UDID}`)
  })

  it('uiInstallArgs targets the chosen agent with the signed assets', () => {
    expect(uiInstallArgs(UDID, 'devicekit', '/o/a.p12', '/o/a.mp')).toEqual([
      'ui',
      'install',
      'devicekit',
      '--p12file=/o/a.p12',
      '--profile=/o/a.mp',
      `--udid=${UDID}`
    ])
    expect(uiInstallArgs(UDID, 'wda', '/o/a.p12', '/o/a.mp')[2]).toBe('wda')
  })
})

describe('injection args', () => {
  it('tap rounds to integer flags', () => {
    expect(uiTapArgs(UDID, 12.4, 88.9)).toEqual(['ui', 'tap', '--x=12', '--y=89', `--udid=${UDID}`])
  })

  it('swipe includes duration only when given', () => {
    expect(uiSwipeArgs(UDID, 1, 2, 3, 4)).toEqual([
      'ui',
      'swipe',
      '--from-x=1',
      '--from-y=2',
      '--to-x=3',
      '--to-y=4',
      `--udid=${UDID}`
    ])
    expect(uiSwipeArgs(UDID, 1, 2, 3, 4, 0.5)).toContain('--duration=0.5')
  })

  it('type passes text as a single --text arg (no shell escaping needed)', () => {
    expect(uiTypeArgs(UDID, 'hi there')).toEqual(['ui', 'type', '--text=hi there', `--udid=${UDID}`])
  })

  it('button is positional', () => {
    expect(uiButtonArgs(UDID, 'home')).toEqual(['ui', 'button', 'home', `--udid=${UDID}`])
  })

  it('size args target the device', () => {
    expect(uiSizeArgs(UDID)).toEqual(['ui', 'size', `--udid=${UDID}`])
  })
})

describe('agent runtime (WDA launch + driver flags)', () => {
  const WDA = 'com.deviceboxhq.goios.WebDriverAgentRunner.xctrunner'

  it('runWdaArgs sets all three bundle ids + xctest config', () => {
    const a = runWdaArgs(UDID, WDA)
    expect(a[0]).toBe('runwda')
    expect(a).toContain(`--bundleid=${WDA}`)
    expect(a).toContain(`--testrunnerbundleid=${WDA}`)
    expect(a).toContain('--xctestconfig=WebDriverAgentRunner.xctest')
    expect(a).toContain(`--udid=${UDID}`)
  })

  it('forwardArgs forwards host->device port', () => {
    expect(forwardArgs(UDID, WDA_PORT, WDA_PORT)).toEqual(['forward', '8100', '8100', `--udid=${UDID}`])
  })

  it('appsListArgs lists installed apps', () => {
    expect(appsListArgs(UDID)).toEqual(['apps', '--list', `--udid=${UDID}`])
  })

  it('findWdaBundleId picks the WebDriverAgentRunner.xctrunner line', () => {
    const out = [
      'com.penguin.notifire.PenguinNotifire PenguinNotifire 1.0',
      `${WDA} WebDriverAgentRunner-Runner 1.0`,
      'com.mobilenext.devicekit-iosUITests.xctrunner Device Kit 0.0.18'
    ].join('\n')
    expect(findWdaBundleId(out)).toBe(WDA)
    expect(findWdaBundleId('no agent here foo 1.0')).toBeNull()
  })

  it('uiDriverFlags adds --driver + matching url; nothing when omitted', () => {
    expect(uiDriverFlags()).toEqual([])
    expect(uiDriverFlags({ driver: 'wda', wdaUrl: WDA_LOCAL_URL })).toEqual(['--driver=wda', `--wda-url=${WDA_LOCAL_URL}`])
    expect(uiDriverFlags({ driver: 'devicekit', devicekitUrl: 'http://127.0.0.1:12004' })).toEqual([
      '--driver=devicekit',
      '--devicekit-url=http://127.0.0.1:12004'
    ])
  })

  it('injection builders append driver flags after --udid', () => {
    const d = { driver: 'wda' as const, wdaUrl: WDA_LOCAL_URL }
    expect(uiTapArgs(UDID, 5, 6, d)).toEqual(['ui', 'tap', '--x=5', '--y=6', `--udid=${UDID}`, '--driver=wda', `--wda-url=${WDA_LOCAL_URL}`])
    expect(uiButtonArgs(UDID, 'home', d).slice(-2)).toEqual(['--driver=wda', `--wda-url=${WDA_LOCAL_URL}`])
    expect(uiSwipeArgs(UDID, 1, 2, 3, 4, 0.5, d).slice(-2)).toEqual(['--driver=wda', `--wda-url=${WDA_LOCAL_URL}`])
    // backward-compatible: no driver arg → no extra flags
    expect(uiTapArgs(UDID, 5, 6)).toEqual(['ui', 'tap', '--x=5', '--y=6', `--udid=${UDID}`])
  })
})

describe('DeviceKit agent (WebSocket JSON-RPC + full-path gesture)', () => {
  const DK = 'com.mobilenext.devicekit-iosUITests.xctrunner'

  it('runDeviceKitArgs launches the runner with the right xctest-config', () => {
    const a = runDeviceKitArgs(UDID, DK)
    expect(a[0]).toBe('runtest')
    expect(a).toContain(`--test-runner-bundle-id=${DK}`)
    expect(a).toContain(`--xctest-config=${DEVICEKIT_XCTEST_CONFIG}`)
    expect(a).toContain(`--udid=${UDID}`)
  })

  it('findDeviceKitBundleId picks the devicekit-iosUITests.xctrunner line', () => {
    const out = [
      'com.penguin.notifire.PenguinNotifire PenguinNotifire 1.0',
      'com.deviceboxhq.goios.WebDriverAgentRunner.xctrunner WebDriverAgentRunner-Runner 1.0',
      `${DK} Device Kit 0.0.18`
    ].join('\n')
    expect(findDeviceKitBundleId(out)).toBe(DK)
    expect(findDeviceKitBundleId('no agent here')).toBeNull()
  })

  it('dkRpc wraps a JSON-RPC 2.0 envelope', () => {
    expect(dkRpc(7, 'device.io.tap', { x: 1, y: 2 })).toEqual({ jsonrpc: '2.0', id: 7, method: 'device.io.tap', params: { x: 1, y: 2 } })
  })

  it('dkTapParams rounds + tags deviceId', () => {
    expect(dkTapParams(12.6, 88.2)).toEqual({ x: 13, y: 88, deviceId: 'any' })
  })

  it('dkGestureParams wraps actions', () => {
    const acts = [{ type: 'press' as const, duration: 0, x: 1, y: 2, button: 0 }]
    expect(dkGestureParams(acts)).toEqual({ actions: acts, deviceId: 'any' })
  })

  it('pathToGestureActions builds press→moves→release with per-segment timing', () => {
    const path: DkPathPoint[] = [
      { x: 100, y: 700, t: 1000 },
      { x: 100, y: 500, t: 1100 },
      { x: 100, y: 300, t: 1250 }
    ]
    const a = pathToGestureActions(path)
    expect(a[0]).toEqual({ type: 'press', duration: 0, x: 100, y: 700, button: 0 })
    expect(a[1]).toEqual({ type: 'move', duration: 0.1, x: 100, y: 500, button: 0 }) // 100ms
    expect(a[2]).toEqual({ type: 'move', duration: 0.15, x: 100, y: 300, button: 0 }) // 150ms
    expect(a[3]).toEqual({ type: 'release', duration: 0, x: 100, y: 300, button: 0 })
  })

  it('pathToGestureActions handles a single point (degenerate tap)', () => {
    const a = pathToGestureActions([{ x: 5, y: 6, t: 0 }])
    expect(a.map((x) => x.type)).toEqual(['press', 'release'])
  })

  it('pathToGestureActions downsamples a huge path but keeps first + last', () => {
    const path: DkPathPoint[] = Array.from({ length: 300 }, (_, i) => ({ x: i, y: i * 2, t: i * 10 }))
    const a = pathToGestureActions(path)
    // press + <=MAX moves + release
    expect(a.length).toBeLessThanOrEqual(MAX_GESTURE_POINTS + 1)
    expect(a[0]).toMatchObject({ type: 'press', x: 0, y: 0 })
    expect(a[a.length - 1]).toMatchObject({ type: 'release', x: 299, y: 598 })
  })

  it('pathToPointerActions builds a W3C down→moves(with real ms)→up sequence', () => {
    const path: DkPathPoint[] = [
      { x: 100, y: 700, t: 1000 },
      { x: 100, y: 500, t: 1100 },
      { x: 100, y: 300, t: 1250 }
    ]
    const a = pathToPointerActions(path)
    expect(a[0]).toEqual({ type: 'pointerMove', duration: 0, x: 100, y: 700 })
    expect(a[1]).toEqual({ type: 'pointerDown', button: 0 })
    expect(a[2]).toEqual({ type: 'pointerMove', duration: 100, x: 100, y: 500 }) // real 100ms preserved
    expect(a[3]).toEqual({ type: 'pointerMove', duration: 150, x: 100, y: 300 }) // → velocity for momentum
    expect(a[4]).toEqual({ type: 'pointerUp', button: 0 })
  })

  it('pathToPointerActions on a single point is a bare tap (down→up, no move segment)', () => {
    const a = pathToPointerActions([{ x: 5, y: 6, t: 0 }])
    expect(a.map((x) => x.type)).toEqual(['pointerMove', 'pointerDown', 'pointerUp'])
  })

  it('pathToPointerActions caps a huge path at MAX_POINTER_ACTION_POINTS, keeping first + last', () => {
    const path: DkPathPoint[] = Array.from({ length: 300 }, (_, i) => ({ x: i, y: i * 2, t: i * 10 }))
    const a = pathToPointerActions(path)
    const moves = a.filter((x) => x.type === 'pointerMove')
    // one pointerMove is the initial move-to-first (before pointerDown); total kept ≤ cap
    expect(moves.length).toBeLessThanOrEqual(MAX_POINTER_ACTION_POINTS)
    expect(a[0]).toMatchObject({ type: 'pointerMove', x: 0, y: 0 })
    expect(moves[moves.length - 1]).toMatchObject({ x: 299, y: 598 }) // last real sample preserved
    expect(a[a.length - 1]).toMatchObject({ type: 'pointerUp' })
  })
})

describe('computeFlick (hybrid drag momentum finish)', () => {
  const size = { width: 400, height: 800 }

  it('projects a fast upward flick along the release velocity', () => {
    // moving up ~2000 pt/s over the last 60ms (y decreasing)
    const path = [
      { x: 200, y: 600, t: 0 },
      { x: 200, y: 540, t: 30 },
      { x: 200, y: 480, t: 60 }
    ]
    const f = computeFlick(path, { x: 200, y: 480 }, size)
    expect(f).toBeDefined()
    expect(f!.durMs).toBe(90)
    expect(f!.x).toBe(200)
    // velocity ≈ -2000 pt/s, projected 90ms → ~180pt further up
    expect(f!.y).toBeGreaterThan(280)
    expect(f!.y).toBeLessThan(320)
  })

  it('returns undefined for a slow release (settle, not a flick)', () => {
    const path = [
      { x: 200, y: 600, t: 0 },
      { x: 200, y: 596, t: 60 },
      { x: 200, y: 594, t: 120 } // ~50 pt/s
    ]
    expect(computeFlick(path, { x: 200, y: 594 }, size)).toBeUndefined()
  })

  it('clamps the projected target to the device bounds', () => {
    const path = [
      { x: 200, y: 120, t: 0 },
      { x: 200, y: 40, t: 30 },
      { x: 200, y: 5, t: 60 } // very fast toward the top edge
    ]
    const f = computeFlick(path, { x: 200, y: 5 }, size)
    expect(f).toBeDefined()
    expect(f!.y).toBeGreaterThanOrEqual(0) // never negative / off-screen
  })

  it('returns undefined without enough samples', () => {
    expect(computeFlick([{ x: 1, y: 1, t: 0 }], { x: 1, y: 1 }, size)).toBeUndefined()
    expect(computeFlick([], { x: 0, y: 0 }, size)).toBeUndefined()
  })
})

describe('keyboard forwarding (DOM key -> agent)', () => {
  it('deviceKitKey passes literal chars through + maps named keys', () => {
    expect(deviceKitKey('a')).toBe('a')
    expect(deviceKitKey('A')).toBe('A')
    expect(deviceKitKey('!')).toBe('!')
    expect(deviceKitKey('Enter')).toBe('return')
    expect(deviceKitKey('Backspace')).toBe('backspace')
    expect(deviceKitKey('ArrowUp')).toBe('up')
    expect(deviceKitKey(' ')).toBe('space')
    expect(deviceKitKey('F5')).toBe('f5')
    expect(deviceKitKey('Shift')).toBeNull()
    expect(deviceKitKey('Meta')).toBeNull()
  })

  it('dkKeysParams wraps combos', () => {
    expect(dkKeysParams([{ key: 'a', modifiers: ['command'] }])).toEqual({ keys: [{ key: 'a', modifiers: ['command'] }], deviceId: 'any' })
  })

  it('wdaKeyValue maps named keys to W3C codes + chars to themselves', () => {
    expect(wdaKeyValue('a')).toEqual(['a'])
    expect(wdaKeyValue('Enter')).toEqual([''])
    expect(wdaKeyValue('Backspace')).toEqual([''])
    expect(wdaKeyValue('ArrowLeft')).toEqual([''])
    expect(wdaKeyValue(' ')).toEqual([' '])
    expect(wdaKeyValue('Shift')).toBeNull()
  })
})

describe('parseUiSize', () => {
  it('reads width/height from JSON', () => {
    expect(parseUiSize('{"width":393,"height":852}')).toEqual({ width: 393, height: 852 })
  })
  it('tolerates casing/whitespace and rounds', () => {
    expect(parseUiSize('{ "Width" : 390.0 , "Height" : 844.5 }')).toEqual({ width: 390, height: 845 })
  })
  it('returns null when absent or zero', () => {
    expect(parseUiSize('no size here')).toBeNull()
    expect(parseUiSize('{"width":0,"height":0}')).toBeNull()
  })
})
