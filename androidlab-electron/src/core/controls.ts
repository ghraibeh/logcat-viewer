/**
 * Device Controls pure builders/parsers. Faithful port of controls.py's Qt-free
 * layer: the one-round-trip state read script, the marker parser + interpreter,
 * bucket-name canonicalization, and every setter (each returns a list of adb
 * argvs, WITHOUT the leading `-s <serial>` which the service adds).
 */

/** Binder SYSPROPS_TRANSACTION poke so debug.* sysprops apply without a restart. */
export const SYSPROPS_POKE = ['shell', 'service', 'call', 'activity', '1599295570']

export const BUCKETS = ['active', 'working_set', 'frequent', 'rare', 'restricted']

const BUCKET_NUMS: Record<string, string> = {
  '5': 'exempted',
  '10': 'active',
  '20': 'working_set',
  '30': 'frequent',
  '40': 'rare',
  '45': 'restricted',
  '50': 'never'
}

export const DALTONIZER: Array<[string, number]> = [
  ['Off', -1],
  ['Grayscale', 0],
  ['Protan', 11],
  ['Deutan', 12],
  ['Tritan', 13]
]
export const OVERLAYS: Array<[string, string]> = [
  ['Off', ''],
  ['480p', '720x480/142'],
  ['720p', '1280x720/213'],
  ['1080p', '1920x1080/320']
]
export const ROTATIONS: Array<[string, number]> = [
  ['Auto', -1],
  ['0°', 0],
  ['90°', 1],
  ['180°', 2],
  ['270°', 3]
]
export const TIMEOUTS: Array<[string, number]> = [
  ['15s', 15000],
  ['30s', 30000],
  ['1m', 60000],
  ['10m', 600000],
  ['30m', 1800000]
]
export const FONT_SCALES: Array<[string, number]> = [
  ['0.85×', 0.85],
  ['1×', 1.0],
  ['1.15×', 1.15],
  ['1.3×', 1.3]
]

const READS: Array<[string, string]> = [
  ['night', 'cmd uimode night'],
  ['font_scale', 'settings get system font_scale'],
  ['density', 'wm density'],
  ['anim', 'settings get global animator_duration_scale'],
  ['show_touches', 'settings get system show_touches'],
  ['pointer', 'settings get system pointer_location'],
  ['layout', 'getprop debug.layout'],
  ['hwui', 'getprop debug.hwui.profile'],
  ['rtl', 'settings get global debug.force_rtl'],
  ['overdraw', 'getprop debug.hwui.overdraw'],
  [
    'dalt',
    'settings get secure accessibility_display_daltonizer_enabled; settings get secure accessibility_display_daltonizer'
  ],
  ['wifi', 'cmd wifi status'],
  ['data', 'settings get global mobile_data'],
  ['airplane', 'settings get global airplane_mode_on'],
  ['anr', 'settings get secure anr_show_background'],
  ['rot', 'settings get system accelerometer_rotation; settings get system user_rotation'],
  ['bright', 'settings get system screen_brightness; settings get system screen_brightness_mode'],
  ['timeout', 'settings get system screen_off_timeout'],
  ['loc', 'settings get secure location_mode'],
  ['bt', 'settings get global bluetooth_on'],
  ['lowpower', 'settings get global low_power'],
  ['datasaver', 'cmd netpolicy get restrict-background'],
  ['proxy', 'settings get global http_proxy'],
  ['overlay', 'settings get global overlay_display_devices'],
  ['finish', 'settings get global always_finish_activities'],
  ['stay', 'settings get global stay_on_while_plugged_in'],
  ['battery', 'dumpsys battery'],
  ['doze', 'dumpsys deviceidle get deep']
]

export function readStateScript(): string {
  return READS.map(([k, cmd]) => `echo @@${k}@@; ${cmd} 2>/dev/null`).join('; ')
}

export function parseState(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let key: string | null = null
  for (const line of text.split('\n')) {
    const m = /^@@(\w+)@@\s*$/.exec(line.trim())
    if (m) {
      key = m[1]
      out[key] = ''
    } else if (key !== null) {
      out[key] += line + '\n'
    }
  }
  const result: Record<string, string> = {}
  for (const k of Object.keys(out)) result[k] = out[k].trim()
  return result
}

function firstNum(s: string | undefined, def: number | null = null): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(s ?? '')
  return m ? parseFloat(m[0]) : def
}

const trunc = (n: number): number => Math.trunc(n)

export interface ControlsState {
  night: boolean
  fontScale: number
  density: number | null
  densityOverridden: boolean
  animOff: boolean
  showTouches: boolean
  pointer: boolean
  layout: boolean
  hwui: boolean
  rtl: boolean
  overdraw: boolean
  dalt: number
  wifi: boolean
  data: boolean
  airplane: boolean
  anr: boolean
  rotation: number
  brightness: number
  brightAuto: boolean
  timeoutMs: number
  location: boolean
  bluetooth: boolean
  batterySaver: boolean
  dataSaver: boolean
  proxy: string
  overlay: string
  finish: boolean
  stay: boolean
  batteryLevel: number | null
  batteryPowered: boolean
  dozeIdle: boolean
  bucket?: string
  appLocales?: string
}

export function interpretState(s: Record<string, string>): ControlsState {
  const get = (k: string): string => s[k] ?? ''
  const batt = get('battery')
  const level = /level:\s*(\d+)/.exec(batt)
  const powered = /(AC|USB|Wireless) powered: true/.test(batt)
  const dens = get('density')
  const over = /Override density:\s*(\d+)/.exec(dens)
  const phys = /Physical density:\s*(\d+)/.exec(dens)
  const densMatch = over || phys
  const daltLines = [...get('dalt').split('\n'), '', '']
  const daltOn = daltLines[0].trim() === '1'
  const daltVal = firstNum(daltLines[1])
  const wifiLine = (get('wifi').split('\n')[0] || '').toLowerCase()
  const rotLines = [...get('rot').split('\n'), '', '']
  const brightLines = [...get('bright').split('\n'), '', '']
  const overlay = get('overlay').trim()
  const proxyRaw = get('proxy').trim()
  // `null` / `:0` (our disabled sentinel) / empty all mean "no proxy set".
  const proxy = proxyRaw === '' || proxyRaw.toLowerCase() === 'null' || proxyRaw === ':0' ? '' : proxyRaw

  return {
    night: get('night').toLowerCase().includes('yes'),
    fontScale: firstNum(get('font_scale'), 1.0) || 1.0,
    density: densMatch ? parseInt(densMatch[1], 10) : null,
    densityOverridden: over !== null,
    animOff: (firstNum(get('anim'), 1.0) || 0.0) === 0.0,
    showTouches: get('show_touches') === '1',
    pointer: get('pointer') === '1',
    layout: get('layout') === 'true',
    hwui: get('hwui').includes('visual_bars'),
    rtl: get('rtl') === '1',
    overdraw: get('overdraw').includes('show'),
    dalt: daltOn && daltVal !== null ? trunc(daltVal) : -1,
    wifi: wifiLine.includes('is enabled'),
    data: get('data') === '1',
    airplane: get('airplane') === '1',
    anr: get('anr') === '1',
    rotation: rotLines[0].trim() === '1' ? -1 : trunc(firstNum(rotLines[1], 0) || 0),
    brightness: trunc(firstNum(brightLines[0], 128) || 128),
    brightAuto: brightLines[1].trim() === '1',
    timeoutMs: trunc(firstNum(get('timeout'), 0) || 0),
    location: !['0', 'null'].includes(get('loc') || '0'),
    bluetooth: get('bt') === '1',
    batterySaver: get('lowpower') === '1',
    dataSaver: get('datasaver').toLowerCase().includes('enabled'),
    proxy,
    overlay: overlay === '' || overlay === 'null' ? '' : overlay,
    finish: get('finish') === '1',
    stay: !['0', 'null'].includes(get('stay') || '0'),
    batteryLevel: level ? parseInt(level[1], 10) : null,
    batteryPowered: powered,
    dozeIdle: get('doze').toUpperCase() === 'IDLE'
  }
}

export function bucketName(raw: string | null | undefined): string | null {
  const s = (raw || '').trim().toLowerCase()
  if (!s) return null
  if (BUCKETS.includes(s) || s === 'exempted' || s === 'never') return s
  return BUCKET_NUMS[s.split(/\s+/)[0]] ?? null
}

export function parseAppLocales(text: string): string {
  const m = /\[([^\]]*)\]/.exec(text || '')
  return m ? m[1].trim() : ''
}

export function getAppLocalesArgs(pkg: string): string[] {
  return ['shell', 'cmd', 'locale', 'get-app-locales', pkg, '--user', '0']
}
export function getStandbyBucketArgs(pkg: string): string[] {
  return ['shell', 'am', 'get-standby-bucket', pkg]
}

// --- setter builders: each returns a list of adb argvs ----------------------
type Argvs = string[][]

export const setNight = (on: boolean): Argvs => [['shell', 'cmd', 'uimode', 'night', on ? 'yes' : 'no']]
export const setFontScale = (scale: number): Argvs => [
  ['shell', 'settings', 'put', 'system', 'font_scale', String(scale)]
]
export const setDensity = (dpi: number | null): Argvs => [
  ['shell', 'wm', 'density', dpi ? String(dpi) : 'reset']
]
export const setAnimations = (off: boolean): Argvs =>
  ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'].map((key) => [
    'shell',
    'settings',
    'put',
    'global',
    key,
    off ? '0' : '1'
  ])
export const setShowTouches = (on: boolean): Argvs => [
  ['shell', 'settings', 'put', 'system', 'show_touches', on ? '1' : '0']
]
export const setPointerLocation = (on: boolean): Argvs => [
  ['shell', 'settings', 'put', 'system', 'pointer_location', on ? '1' : '0']
]
export const setLayoutBounds = (on: boolean): Argvs => [
  ['shell', 'setprop', 'debug.layout', on ? 'true' : 'false'],
  SYSPROPS_POKE
]
export const setHwuiProfile = (on: boolean): Argvs => [
  ['shell', 'setprop', 'debug.hwui.profile', on ? 'visual_bars' : 'false'],
  SYSPROPS_POKE
]
export const setForceRtl = (on: boolean): Argvs => [
  ['shell', 'settings', 'put', 'global', 'debug.force_rtl', on ? '1' : '0'],
  SYSPROPS_POKE
]
export const setOverdraw = (on: boolean): Argvs => [
  ['shell', 'setprop', 'debug.hwui.overdraw', on ? 'show' : 'false'],
  SYSPROPS_POKE
]
export const setColorSpace = (mode: number): Argvs =>
  mode < 0
    ? [['shell', 'settings', 'put', 'secure', 'accessibility_display_daltonizer_enabled', '0']]
    : [
        ['shell', 'settings', 'put', 'secure', 'accessibility_display_daltonizer', String(mode)],
        ['shell', 'settings', 'put', 'secure', 'accessibility_display_daltonizer_enabled', '1']
      ]
export const setWifi = (on: boolean): Argvs => [
  ['shell', 'cmd', 'wifi', 'set-wifi-enabled', on ? 'enabled' : 'disabled']
]
export const setMobileData = (on: boolean): Argvs => [['shell', 'svc', 'data', on ? 'enable' : 'disable']]
export const setAirplane = (on: boolean): Argvs => [
  ['shell', 'cmd', 'connectivity', 'airplane-mode', on ? 'enable' : 'disable']
]
export const setShowAnrs = (on: boolean): Argvs => [
  ['shell', 'settings', 'put', 'secure', 'anr_show_background', on ? '1' : '0']
]
export const setRotation = (mode: number): Argvs =>
  mode < 0
    ? [['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '1']]
    : [
        ['shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'],
        ['shell', 'settings', 'put', 'system', 'user_rotation', String(mode)]
      ]
export const setBrightness = (value: number): Argvs => [
  ['shell', 'settings', 'put', 'system', 'screen_brightness', String(value)]
]
export const setAutoBrightness = (on: boolean): Argvs => [
  ['shell', 'settings', 'put', 'system', 'screen_brightness_mode', on ? '1' : '0']
]
export const setScreenTimeout = (ms: number): Argvs => [
  ['shell', 'settings', 'put', 'system', 'screen_off_timeout', String(ms)]
]
export const setLocation = (on: boolean): Argvs => [
  ['shell', 'cmd', 'location', 'set-location-enabled', on ? 'true' : 'false']
]
export const setBluetooth = (on: boolean): Argvs => [
  ['shell', 'cmd', 'bluetooth_manager', on ? 'enable' : 'disable']
]
export const setBatterySaver = (on: boolean): Argvs => [
  ['shell', 'settings', 'put', 'global', 'low_power', on ? '1' : '0']
]
export const setDataSaver = (on: boolean): Argvs => [
  ['shell', 'cmd', 'netpolicy', 'set', 'restrict-background', on ? 'true' : 'false']
]
// Global HTTP proxy. `setProxy` points every app at host:port (e.g. a laptop
// running Charles/Fiddler/Burp); `clearProxy` disables it. We disable with the
// `:0` sentinel rather than `settings delete` — on many OEM builds (notably
// Samsung One UI) deleting the row leaves the live proxy applied. Matches
// intercept.ts's clearProxyArgs.
export const PROXY_RE = /^[A-Za-z0-9._-]+:\d{1,5}$/
export const isValidProxy = (value: string): boolean => PROXY_RE.test(value.trim())
export const setProxy = (hostPort: string): Argvs => [
  ['shell', 'settings', 'put', 'global', 'http_proxy', hostPort.trim()]
]
export const clearProxy = (): Argvs => [['shell', 'settings', 'put', 'global', 'http_proxy', ':0']]
export const setOverlayDisplay = (spec: string): Argvs =>
  spec
    ? [['shell', 'settings', 'put', 'global', 'overlay_display_devices', spec]]
    : [['shell', 'settings', 'delete', 'global', 'overlay_display_devices']]
export const setAppLocale = (pkg: string, locale: string): Argvs => [
  ['shell', 'cmd', 'locale', 'set-app-locales', pkg, '--user', '0', '--locales', locale]
]
export const setFinishActivities = (on: boolean): Argvs => [
  ['shell', 'settings', 'put', 'global', 'always_finish_activities', on ? '1' : '0']
]
export const setStayAwake = (on: boolean): Argvs => [
  ['shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', on ? '7' : '0']
]
export const setBatteryLevel = (level: number): Argvs => [
  ['shell', 'dumpsys', 'battery', 'unplug'],
  ['shell', 'dumpsys', 'battery', 'set', 'level', String(level)]
]
export const resetBattery = (): Argvs => [['shell', 'dumpsys', 'battery', 'reset']]
export const setDoze = (on: boolean): Argvs =>
  on
    ? [
        ['shell', 'dumpsys', 'battery', 'unplug'],
        ['shell', 'dumpsys', 'deviceidle', 'force-idle']
      ]
    : [
        ['shell', 'dumpsys', 'deviceidle', 'unforce'],
        ['shell', 'dumpsys', 'battery', 'reset']
      ]
export const setStandbyBucket = (pkg: string, bucket: string): Argvs => [
  ['shell', 'am', 'set-standby-bucket', pkg, bucket]
]

// --- reboot / power actions -------------------------------------------------
// Reboots are adb-level commands (NOT `adb shell`); power-off goes through the
// shell. Each returns adb argvs without the leading `-s <serial>` (the service
// adds it). Issuing any of these drops the adb connection — the device
// reappears when it finishes booting. True fastboot *flashing* needs the
// separate `fastboot` binary (the device leaves adb in bootloader mode) and is
// intentionally out of scope; we only expose rebooting *into* those modes.
export const reboot = (): Argvs => [['reboot']]
export const rebootRecovery = (): Argvs => [['reboot', 'recovery']]
export const rebootBootloader = (): Argvs => [['reboot', 'bootloader']]
export const rebootFastboot = (): Argvs => [['reboot', 'fastboot']]
export const powerOff = (): Argvs => [['shell', 'reboot', '-p']]

export interface PowerAction {
  key: string
  title: string
  desc: string
  button: string
  argvs: Argvs
  /** styled as destructive + a stronger confirmation (needs physical access to undo). */
  danger?: boolean
}

export const POWER_ACTIONS: PowerAction[] = [
  { key: 'reboot', title: 'Reboot', desc: 'Restart the device normally', button: 'Reboot', argvs: reboot() },
  {
    key: 'recovery',
    title: 'Reboot to recovery',
    desc: 'Boot into the recovery partition',
    button: 'Reboot',
    argvs: rebootRecovery()
  },
  {
    key: 'bootloader',
    title: 'Reboot to bootloader',
    desc: 'Bootloader — fastboot mode',
    button: 'Reboot',
    argvs: rebootBootloader()
  },
  {
    key: 'fastbootd',
    title: 'Reboot to fastbootd',
    desc: 'Userspace fastboot (fastbootd)',
    button: 'Reboot',
    argvs: rebootFastboot()
  },
  {
    key: 'poweroff',
    title: 'Power off',
    desc: 'Shut the device down',
    button: 'Power off',
    argvs: powerOff(),
    danger: true
  }
]

// --- reset options ----------------------------------------------------------
// Direct-adb resets, each guarded by an in-app confirmation.
//  • factoryReset broadcasts to the MasterClearReceiver — needs the
//    MASTER_CLEAR permission, so it works on emulators / rooted devices but
//    fails with a SecurityException on locked production builds.
//  • resetNetwork has no pure-shell command, so it opens the device's own
//    reset screen. Passed as a single-quoted shell string so the on-device
//    shell doesn't try to expand the `$` inside the component name.
//  • resetAppPrefs maps to `pm reset-permissions` (the only adb-reachable part
//    of "reset app preferences"): it revokes every app's runtime permissions.
//  • resetAllSettings restores the system/secure/global settings tables to
//    their defaults (data is kept); best-effort across all three namespaces.
export const factoryReset = (): Argvs => [
  [
    'shell',
    'am',
    'broadcast',
    '-a',
    'android.intent.action.FACTORY_RESET',
    '-n',
    'android/com.android.server.MasterClearReceiver'
  ]
]
export const resetNetwork = (): Argvs => [
  ['shell', "am start -n 'com.android.settings/.Settings$ResetMobileNetworkSettingsActivity'"]
]
export const resetAppPrefs = (): Argvs => [['shell', 'pm', 'reset-permissions']]
export const resetAllSettings = (): Argvs => [
  [
    'shell',
    'settings reset system trusted_defaults; settings reset secure trusted_defaults; settings reset global trusted_defaults'
  ]
]

export interface ResetAction {
  key: string
  title: string
  desc: string
  confirmTitle: string
  confirmBody: string
  confirmButton: string
  argvs: Argvs
  /** the device reboots / drops off adb (factory reset) → skip the state re-read. */
  disconnects?: boolean
}

export const RESET_ACTIONS: ResetAction[] = [
  {
    key: 'network',
    title: 'Reset network settings',
    desc: 'Wi-Fi, mobile & Bluetooth — opens the on-device reset screen',
    confirmTitle: 'Reset network settings?',
    confirmBody:
      'Opens the device’s network-reset screen — confirm there to forget every saved Wi-Fi network, cellular APN and Bluetooth pairing.',
    confirmButton: 'Open reset screen',
    argvs: resetNetwork()
  },
  {
    key: 'appprefs',
    title: 'Reset app permissions',
    desc: 'Revoke every app’s runtime permissions (pm reset-permissions)',
    confirmTitle: 'Reset app permissions?',
    confirmBody:
      'Revokes all runtime permissions for every app on the device — apps will re-prompt on next use. This cannot be undone.',
    confirmButton: 'Reset',
    argvs: resetAppPrefs()
  },
  {
    key: 'allsettings',
    title: 'Reset all settings',
    desc: 'Restore system / secure / global settings to defaults',
    confirmTitle: 'Reset all settings?',
    confirmBody:
      'Restores every device setting (display, sound, network toggles, developer options…) to its default. Your data and apps are kept. This cannot be undone.',
    confirmButton: 'Reset',
    argvs: resetAllSettings()
  },
  {
    key: 'factory',
    title: 'Factory reset (erase all data)',
    desc: 'Wipe everything — needs MASTER_CLEAR (emulator / rooted only)',
    confirmTitle: 'Erase ALL data?',
    confirmBody:
      'This ERASES EVERYTHING — apps, accounts, files, settings — and reboots the device. There is no undo. On a locked (non-rooted) production device it fails with a permission error.',
    confirmButton: 'Erase everything',
    argvs: factoryReset(),
    disconnects: true
  }
]
