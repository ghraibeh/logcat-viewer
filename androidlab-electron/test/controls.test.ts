/**
 * Controls parity tests — TS equivalents of the controls checks in
 * tests/smoke.py: the state script, marker parser, interpreter, bucket names,
 * locale parsing, and a sampling of setter builders.
 */
import { describe, expect, it } from 'vitest'
import * as C from '@core/controls'

const SECTIONS: Record<string, string> = {
  night: 'Night mode: yes',
  font_scale: '1.15',
  density: 'Physical density: 420\nOverride density: 480',
  anim: '0.0',
  show_touches: '1',
  pointer: '0',
  layout: 'true',
  hwui: 'visual_bars',
  rtl: '1',
  overdraw: 'show',
  dalt: '1\n11',
  wifi: 'Wifi is enabled',
  data: '1',
  airplane: '0',
  anr: '1',
  rot: '0\n1',
  bright: '200\n0',
  timeout: '60000',
  loc: '3',
  bt: '1',
  lowpower: '0',
  datasaver: 'Restrict background status: enabled',
  proxy: '192.168.1.5:8888',
  overlay: '1280x720/213',
  finish: '1',
  stay: '7',
  battery: 'level: 87\nAC powered: false\nUSB powered: true',
  doze: 'IDLE'
}

function buildRaw(sections: Record<string, string>): string {
  return Object.entries(sections)
    .map(([k, v]) => `@@${k}@@\n${v}`)
    .join('\n')
}

describe('read script + parse', () => {
  it('emits a marker + command per read', () => {
    const s = C.readStateScript()
    expect(s).toContain('@@night@@')
    expect(s).toContain('@@battery@@')
    expect(s).toContain('dumpsys deviceidle get deep')
    expect(s).toContain('; ')
  })
  it('parseState splits markers back into sections', () => {
    const parsed = C.parseState(buildRaw(SECTIONS))
    expect(parsed.night).toBe('Night mode: yes')
    expect(parsed.battery).toContain('level: 87')
  })
})

describe('interpretState', () => {
  const st = C.interpretState(C.parseState(buildRaw(SECTIONS)))
  it('normalizes every control', () => {
    expect(st.night).toBe(true)
    expect(st.fontScale).toBeCloseTo(1.15, 5)
    expect(st.density).toBe(480)
    expect(st.densityOverridden).toBe(true)
    expect(st.animOff).toBe(true)
    expect(st.showTouches).toBe(true)
    expect(st.pointer).toBe(false)
    expect(st.layout).toBe(true)
    expect(st.hwui).toBe(true)
    expect(st.rtl).toBe(true)
    expect(st.overdraw).toBe(true)
    expect(st.dalt).toBe(11)
    expect(st.wifi).toBe(true)
    expect(st.data).toBe(true)
    expect(st.airplane).toBe(false)
    expect(st.anr).toBe(true)
    expect(st.rotation).toBe(1)
    expect(st.brightness).toBe(200)
    expect(st.brightAuto).toBe(false)
    expect(st.timeoutMs).toBe(60000)
    expect(st.location).toBe(true)
    expect(st.bluetooth).toBe(true)
    expect(st.batterySaver).toBe(false)
    expect(st.dataSaver).toBe(true)
    expect(st.proxy).toBe('192.168.1.5:8888')
    expect(st.overlay).toBe('1280x720/213')
    expect(st.finish).toBe(true)
    expect(st.stay).toBe(true)
    expect(st.batteryLevel).toBe(87)
    expect(st.batteryPowered).toBe(true)
    expect(st.dozeIdle).toBe(true)
  })
  it('treats daltonizer-disabled as off (-1)', () => {
    const off = C.interpretState(C.parseState(buildRaw({ ...SECTIONS, dalt: '0\n11' })))
    expect(off.dalt).toBe(-1)
  })
  it('reports auto-rotate as -1', () => {
    const auto = C.interpretState(C.parseState(buildRaw({ ...SECTIONS, rot: '1\n0' })))
    expect(auto.rotation).toBe(-1)
  })
  it('treats null / :0 / empty proxy as unset', () => {
    for (const raw of ['null', ':0', '']) {
      const s = C.interpretState(C.parseState(buildRaw({ ...SECTIONS, proxy: raw })))
      expect(s.proxy).toBe('')
    }
  })
})

describe('http proxy', () => {
  it('validates host:port', () => {
    expect(C.isValidProxy('192.168.1.5:8888')).toBe(true)
    expect(C.isValidProxy('proxy.local:80')).toBe(true)
    expect(C.isValidProxy('  10.0.0.1:1 ')).toBe(true)
    expect(C.isValidProxy('192.168.1.5')).toBe(false)
    expect(C.isValidProxy('nope')).toBe(false)
    expect(C.isValidProxy('host:port')).toBe(false)
  })
  it('builds set/clear argvs (clear disables with :0, never settings delete)', () => {
    expect(C.setProxy('192.168.1.5:8888')).toEqual([
      ['shell', 'settings', 'put', 'global', 'http_proxy', '192.168.1.5:8888']
    ])
    expect(C.setProxy('  10.0.0.1:80 ')[0][5]).toBe('10.0.0.1:80')
    expect(C.clearProxy()).toEqual([['shell', 'settings', 'put', 'global', 'http_proxy', ':0']])
  })
})

describe('bucketName + locales', () => {
  it('canonicalizes bucket names and numbers', () => {
    expect(C.bucketName('40')).toBe('rare')
    expect(C.bucketName('rare')).toBe('rare')
    expect(C.bucketName('RARE')).toBe('rare')
    expect(C.bucketName('working_set')).toBe('working_set')
    expect(C.bucketName('')).toBeNull()
  })
  it('parses app-locale output', () => {
    expect(C.parseAppLocales('Locales for com.x for user 0 are [fr-FR]')).toBe('fr-FR')
    expect(C.parseAppLocales('… are []')).toBe('')
  })
})

describe('setter builders', () => {
  it('build the expected adb argvs', () => {
    expect(C.setNight(true)).toEqual([['shell', 'cmd', 'uimode', 'night', 'yes']])
    expect(C.setAnimations(true)).toHaveLength(3)
    expect(C.setAnimations(true).every((a) => a[a.length - 1] === '0')).toBe(true)
    expect(C.setColorSpace(-1)).toEqual([
      ['shell', 'settings', 'put', 'secure', 'accessibility_display_daltonizer_enabled', '0']
    ])
    expect(C.setColorSpace(11)).toHaveLength(2)
    expect(C.setOverlayDisplay('')).toEqual([
      ['shell', 'settings', 'delete', 'global', 'overlay_display_devices']
    ])
    expect(C.setDoze(true)).toEqual([
      ['shell', 'dumpsys', 'battery', 'unplug'],
      ['shell', 'dumpsys', 'deviceidle', 'force-idle']
    ])
    expect(C.setRotation(-1)).toEqual([
      ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1']
    ])
    expect(C.setRotation(2)).toHaveLength(2)
  })
})

describe('power actions', () => {
  it('build the expected adb argvs (reboots are adb-level, power-off is shell)', () => {
    expect(C.reboot()).toEqual([['reboot']])
    expect(C.rebootRecovery()).toEqual([['reboot', 'recovery']])
    expect(C.rebootBootloader()).toEqual([['reboot', 'bootloader']])
    expect(C.rebootFastboot()).toEqual([['reboot', 'fastboot']])
    expect(C.powerOff()).toEqual([['shell', 'reboot', '-p']])
  })
  it('exposes a matching POWER_ACTIONS menu with power-off flagged destructive', () => {
    const keys = C.POWER_ACTIONS.map((a) => a.key)
    expect(keys).toEqual(['reboot', 'recovery', 'bootloader', 'fastbootd', 'poweroff'])
    expect(C.POWER_ACTIONS.find((a) => a.key === 'bootloader')?.argvs).toEqual([['reboot', 'bootloader']])
    expect(C.POWER_ACTIONS.find((a) => a.key === 'poweroff')?.danger).toBe(true)
    expect(C.POWER_ACTIONS.filter((a) => a.danger)).toHaveLength(1)
  })
})

describe('reset actions', () => {
  it('builds direct-adb reset argvs', () => {
    expect(C.factoryReset()).toEqual([
      [
        'shell',
        'am',
        'broadcast',
        '-a',
        'android.intent.action.FACTORY_RESET',
        '-n',
        'android/com.android.server.MasterClearReceiver'
      ]
    ])
    expect(C.resetAppPrefs()).toEqual([['shell', 'pm', 'reset-permissions']])
    // network reset opens the device's own screen; single-quoted so the on-device
    // shell keeps the `$` in the component name instead of expanding it.
    expect(C.resetNetwork()[0][1]).toContain(
      "'com.android.settings/.Settings$ResetMobileNetworkSettingsActivity'"
    )
    expect(C.resetAllSettings()[0][1]).toContain('settings reset global trusted_defaults')
  })
  it('orders resets least-to-most destructive and flags factory as disconnecting', () => {
    const keys = C.RESET_ACTIONS.map((a) => a.key)
    expect(keys).toEqual(['network', 'appprefs', 'allsettings', 'factory'])
    expect(C.RESET_ACTIONS.filter((a) => a.disconnects).map((a) => a.key)).toEqual(['factory'])
    for (const a of C.RESET_ACTIONS) {
      expect(a.confirmTitle).toBeTruthy()
      expect(a.confirmBody).toBeTruthy()
    }
  })
})
