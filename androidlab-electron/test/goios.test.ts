/**
 * go-ios pure-helper parity tests — the parsers/arg-builders that turn
 * `ios list` / `ios info` / `ios apps` output into the Apps-tab data model.
 * Fixtures are synthetic (no real device PII).
 */
import { describe, expect, it } from 'vitest'
import * as G from '@core/goios'

describe('parseDeviceListDetails', () => {
  const entry = (udid: string, conn: string): string =>
    `{"Udid":"${udid}","ProductName":"iPhone OS","ProductType":"iPhone16,2","ProductVersion":"26.5.2","ConnectionType":"${conn}"}`

  it('reads udid + transports from a --details document', () => {
    const out = `{"deviceList":[${entry('00008130-AAA', 'USB')},${entry('00008120-BBB', 'Network')}]}`
    expect(G.parseDeviceListDetails(out)).toEqual([
      { udid: '00008130-AAA', transports: ['usb'] },
      { udid: '00008120-BBB', transports: ['wifi'] }
    ])
  })

  it('groups a device visible over both transports — USB listed first, either order', () => {
    for (const [a, b] of [
      ['USB', 'Network'],
      ['Network', 'USB']
    ]) {
      const out = `{"deviceList":[${entry('UDID-1', a)},${entry('UDID-1', b)}]}`
      expect(G.parseDeviceListDetails(out)).toEqual([{ udid: 'UDID-1', transports: ['usb', 'wifi'] }])
    }
  })

  it('tolerates structured log lines prepended on stdout', () => {
    const out = ['{"level":"warn","msg":"agent not running"}', `{"deviceList":[${entry('UDID-1', 'USB')}]}`].join('\n')
    expect(G.parseDeviceListDetails(out)).toEqual([{ udid: 'UDID-1', transports: ['usb'] }])
  })

  it('returns [] for empty / junk output', () => {
    expect(G.parseDeviceListDetails('')).toEqual([])
    expect(G.parseDeviceListDetails('not json at all')).toEqual([])
  })
})

describe('wificonnections', () => {
  it('builds get/enable/disable argv', () => {
    expect(G.wifiConnectionsArgs('UDID-1', 'enable')).toEqual(['wificonnections', 'enable', '--udid', 'UDID-1'])
    expect(G.wifiConnectionsArgs('UDID-1', 'get')).toEqual(['wificonnections', 'get', '--udid', 'UDID-1'])
  })

  it('parses the resulting state (log noise tolerated)', () => {
    expect(G.parseWifiConnections('{"EnableWifiConnections":true}')).toBe(true)
    const noisy = ['{"level":"info","msg":"x"}', '{"EnableWifiConnections":false}'].join('\n')
    expect(G.parseWifiConnections(noisy)).toBe(false)
    expect(G.parseWifiConnections('boom')).toBeNull()
  })
})

describe('parseInfo + deviceLabel', () => {
  const info = '{"DeviceName":"Test Phone","ProductType":"iPhone16,2","ProductVersion":"26.5.2","Extra":1}'

  it('distils the labelling fields', () => {
    expect(G.parseInfo(info)).toEqual({ name: 'Test Phone', model: 'iPhone16,2', version: '26.5.2' })
  })

  it('builds a "<name> — <model> · iOS <ver>" label', () => {
    const f = G.parseInfo(info)
    expect(G.deviceLabel('UDID-1', f)).toEqual({
      label: 'Test Phone — iPhone16,2 · iOS 26.5.2',
      description: 'iPhone16,2 · iOS 26.5.2'
    })
  })

  it('falls back to the UDID when info is missing', () => {
    expect(G.deviceLabel('UDID-1', null)).toEqual({ label: 'UDID-1', description: '' })
  })
})

describe('ipArgs + parseNetworkInfo', () => {
  it('builds the `ios ip` command', () => {
    expect(G.ipArgs('UDID-1')).toEqual(['ip', '--udid', 'UDID-1'])
  })

  it('reads Mac/IPv4/IPv6 from the ip document', () => {
    const out = '{"Mac":"a4:f8:41:aa:bb:cc","IPv4":"192.168.1.42","IPv6":"fe80::1"}'
    expect(G.parseNetworkInfo(out)).toEqual({
      ipv4: '192.168.1.42',
      ipv6: 'fe80::1',
      mac: 'a4:f8:41:aa:bb:cc'
    })
  })

  it('tolerates a missing IPv4/IPv6 (best-effort partial)', () => {
    expect(G.parseNetworkInfo('{"Mac":"a4:f8:41:aa:bb:cc","IPv4":"","IPv6":""}')).toEqual({
      ipv4: '',
      ipv6: '',
      mac: 'a4:f8:41:aa:bb:cc'
    })
  })

  it('skips prepended log lines and keeps the ip document', () => {
    const out = ['{"level":"warn","msg":"agent not running"}', '{"Mac":"m","IPv4":"10.0.0.5","IPv6":""}'].join('\n')
    expect(G.parseNetworkInfo(out)).toEqual({ ipv4: '10.0.0.5', ipv6: '', mac: 'm' })
  })

  it('returns all-empty for junk / empty output', () => {
    expect(G.parseNetworkInfo('')).toEqual({ ipv4: '', ipv6: '', mac: '' })
    expect(G.parseNetworkInfo('not json')).toEqual({ ipv4: '', ipv6: '', mac: '' })
  })
})

describe('parseApps', () => {
  const APPS = JSON.stringify([
    {
      CFBundleIdentifier: 'com.example.zeta',
      CFBundleDisplayName: 'Zeta',
      CFBundleShortVersionString: '2.0',
      CFBundleVersion: '2.0.99',
      ApplicationType: 'User',
      MinimumOSVersion: '18.0',
      SignerIdentity: 'Apple iPhone OS Application Signing',
      Path: '/var/containers/Bundle/Application/X/Zeta.app',
      Container: '/var/mobile/Containers/Data/Application/Y',
      NSCameraUsageDescription: 'Scan documents',
      NSLocationWhenInUseUsageDescription: 'Find nearby'
    },
    {
      CFBundleIdentifier: 'com.apple.system.thing',
      CFBundleName: 'Thing',
      ApplicationType: 'System'
    },
    { CFBundleName: 'no bundle id — skipped' }
  ])

  it('maps fields, normalizes type, and drops entries without a bundle id', () => {
    const apps = G.parseApps(APPS)
    expect(apps.map((a) => a.bundleId)).toEqual(['com.apple.system.thing', 'com.example.zeta'])
    const zeta = apps.find((a) => a.bundleId === 'com.example.zeta')!
    expect(zeta.name).toBe('Zeta')
    expect(zeta.version).toBe('2.0')
    expect(zeta.build).toBe('2.0.99')
    expect(zeta.type).toBe('User')
    expect(zeta.minOS).toBe('18.0')
  })

  it('falls back to CFBundleName when there is no display name', () => {
    const thing = G.parseApps(APPS).find((a) => a.bundleId === 'com.apple.system.thing')!
    expect(thing.name).toBe('Thing')
    expect(thing.type).toBe('System')
  })

  it('extracts declared privacy usage as [friendly label, description]', () => {
    const zeta = G.parseApps(APPS).find((a) => a.bundleId === 'com.example.zeta')!
    expect(zeta.usage).toEqual([
      ['Camera', 'Scan documents'],
      ['Location (in use)', 'Find nearby']
    ])
  })

  it('sorts by display name, case-insensitively', () => {
    // "Thing" (com.apple…) sorts before "Zeta" despite bundle-id order.
    expect(G.parseApps(APPS).map((a) => a.name)).toEqual(['Thing', 'Zeta'])
  })

  it('returns [] for non-array output', () => {
    expect(G.parseApps('{"deviceList":[]}')).toEqual([])
  })
})

describe('command builders', () => {
  it('targets the device with --udid', () => {
    expect(G.listArgs()).toEqual(['list', '--details'])
    expect(G.infoArgs('U')).toEqual(['info', '--udid', 'U'])
  })

  it('maps app-list kind to the right flags', () => {
    expect(G.appsArgs('U', 'user')).toEqual(['apps', '--udid', 'U'])
    expect(G.appsArgs('U', 'system')).toEqual(['apps', '--system', '--udid', 'U'])
    expect(G.appsArgs('U', 'all')).toEqual(['apps', '--all', '--udid', 'U'])
  })

  it('builds install / uninstall argv', () => {
    expect(G.installArgs('U', '/tmp/app.ipa')).toEqual(['install', '--path=/tmp/app.ipa', '--udid', 'U'])
    expect(G.uninstallArgs('U', 'com.example.zeta')).toEqual(['uninstall', 'com.example.zeta', '--udid', 'U'])
  })

  it('builds get-app-icon argv', () => {
    expect(G.iconArgs('U', 'com.example.zeta')).toEqual([
      'get-app-icon',
      '--bundleid=com.example.zeta',
      '--udid',
      'U'
    ])
  })

  it('builds developer-tier argv (ps / launch / kill / tunnel)', () => {
    expect(G.psArgs('U')).toEqual(['ps', '--udid', 'U'])
    expect(G.psArgs('U', true)).toEqual(['ps', '--apps', '--udid', 'U'])
    expect(G.launchArgs('U', 'com.x')).toEqual(['launch', 'com.x', '--udid', 'U'])
    expect(G.launchArgs('U', 'com.x', true)).toEqual(['launch', 'com.x', '--kill-existing', '--udid', 'U'])
    expect(G.killArgs('U', 'com.x')).toEqual(['kill', 'com.x', '--udid', 'U'])
    // No --udid: one agent manages tunnels for every connected device.
    expect(G.tunnelStartArgs()).toEqual(['tunnel', 'start', '--userspace'])
    expect(G.tunnelLsArgs()).toEqual(['tunnel', 'ls'])
  })
})

describe('parseAppIconDataUrl', () => {
  it('turns get-app-icon JSON into a data URL', () => {
    const out = '{"bundleId":"com.example.zeta","pngData":"iVBORw0KGgo="}'
    expect(G.parseAppIconDataUrl(out)).toBe('data:image/png;base64,iVBORw0KGgo=')
  })

  it('tolerates go-ios log lines prepended to the JSON', () => {
    const out = `time=2026 level=INFO msg="connecting"\n{"bundleId":"com.x","pngData":"QUJD"}`
    expect(G.parseAppIconDataUrl(out)).toBe('data:image/png;base64,QUJD')
  })

  it('returns null when there is no pngData', () => {
    expect(G.parseAppIconDataUrl('{"bundleId":"com.x","pngData":""}')).toBeNull()
    expect(G.parseAppIconDataUrl('')).toBeNull()
    expect(G.parseAppIconDataUrl('boom: could not connect')).toBeNull()
  })
})

describe('parseProcesses', () => {
  // Real `ios ps` shape (array of Pid/Name/IsApplication/RealAppName/StartDate).
  const PS = JSON.stringify([
    { IsApplication: false, Name: 'powerexceptionsd', Pid: 77, RealAppName: '/usr/libexec/powerexceptionsd', StartDate: '2026-07-13T09:09:58.474+03:00' },
    { IsApplication: true, Name: 'VLC for iOS', Pid: 6720, RealAppName: '/var/containers/Bundle/Application/X/VLC.app', StartDate: '2026-07-15T21:30:49+03:00' }
  ])

  it('maps Pid/Name/IsApplication/RealAppName and sorts by pid', () => {
    const procs = G.parseProcesses(PS)
    expect(procs.map((p) => p.pid)).toEqual([77, 6720])
    const vlc = procs.find((p) => p.pid === 6720)!
    expect(vlc.name).toBe('VLC for iOS')
    expect(vlc.isApp).toBe(true)
    expect(vlc.path).toContain('VLC.app')
  })

  it('tolerates an object-map fallback (pid -> name)', () => {
    const procs = G.parseProcesses('{"77":"powerexceptionsd","5":"launchd"}')
    expect(procs).toEqual([
      { pid: 5, name: 'launchd', isApp: false, path: '', startDate: '' },
      { pid: 77, name: 'powerexceptionsd', isApp: false, path: '', startDate: '' }
    ])
  })

  it('returns [] for junk', () => {
    expect(G.parseProcesses('nope')).toEqual([])
  })
})

describe('parseFsyncTree', () => {
  // Real `ios fsync tree` ASCII output (3-char `|  ` per depth, dirs end `/`).
  const TREE = ['|-Documents/', '|  |-FP/', '|  |  |-Backup/', '|  |-FPDB.sqlite', '|-Library/', '|  |-Caches/'].join('\n')

  it('builds full relative paths with depth + isDir', () => {
    const e = G.parseFsyncTree(TREE)
    expect(e.map((x) => x.path)).toEqual([
      'Documents',
      'Documents/FP',
      'Documents/FP/Backup',
      'Documents/FPDB.sqlite',
      'Library',
      'Library/Caches'
    ])
    const db = e.find((x) => x.name === 'FPDB.sqlite')!
    expect(db.isDir).toBe(false)
    expect(db.depth).toBe(1)
    expect(e.find((x) => x.name === 'Documents')!.isDir).toBe(true)
  })

  it('returns [] for empty/non-tree output', () => {
    expect(G.parseFsyncTree('')).toEqual([])
    expect(G.parseFsyncTree('InstallationLookupFailed')).toEqual([])
  })
})

describe('fsync arg builders', () => {
  it('targets the app container', () => {
    expect(G.fsyncTreeArgs('U', 'com.x', 'Library/Preferences')).toEqual([
      'fsync', '--app=com.x', 'tree', '--path=Library/Preferences', '--udid', 'U'
    ])
    expect(G.fsyncPullArgs('U', 'com.x', 'Documents/a.sqlite', '/tmp/a')).toEqual([
      'fsync', '--app=com.x', 'pull', '--srcPath=Documents/a.sqlite', '--dstPath=/tmp/a', '--udid', 'U'
    ])
  })
})

describe('tunnelHasUdid', () => {
  // Real `ios tunnel ls` shape.
  const LS = JSON.stringify([
    { address: 'fd3b:ac10:aafc::1', rsdPort: 61696, udid: '00008130-AAA', userspaceTun: true, userspaceTunPort: 60106 }
  ])

  it('is true when the udid has an active tunnel', () => {
    expect(G.tunnelHasUdid(LS, '00008130-AAA')).toBe(true)
  })

  it('is false for a different udid or no tunnels', () => {
    expect(G.tunnelHasUdid(LS, '00008130-ZZZ')).toBe(false)
    expect(G.tunnelHasUdid('[]', '00008130-AAA')).toBe(false)
    expect(G.tunnelHasUdid('', '00008130-AAA')).toBe(false)
  })
})

describe('userspaceTunPort', () => {
  const LS = JSON.stringify([
    { address: 'fd3b::1', rsdPort: 61696, udid: 'UDID-A', userspaceTun: true, userspaceTunPort: 60106 }
  ])
  it('reads the proxy port for the udid', () => {
    expect(G.userspaceTunPort(LS, 'UDID-A')).toBe(60106)
  })
  it('is null for an unknown udid or no port', () => {
    expect(G.userspaceTunPort(LS, 'UDID-Z')).toBeNull()
    expect(G.userspaceTunPort('[]', 'UDID-A')).toBeNull()
  })
})

describe('parseSysmontapCpu + sysmontapCpuPercent', () => {
  it('extracts cpu totals + per-core + memory from a sysmontap line', () => {
    const line =
      '{"time":"t","level":"INFO","msg":"received CPU usage data","cpu_count":6,"cpu_total_load":333.3,' +
      '"per_cpu":[11.7,21.5,6,7.7,7.8,11.7],"mem_total_kb":5850512,"mem_used_kb":3180784}'
    expect(G.parseSysmontapCpu(line)).toEqual({
      cpuCount: 6,
      cpuTotalLoad: 333.3,
      perCpu: [11.7, 21.5, 6, 7.7, 7.8, 11.7],
      memTotalKb: 5850512,
      memUsedKb: 3180784
    })
  })
  it('defaults per-core/memory when an unpatched binary omits them', () => {
    const line = '{"msg":"received CPU usage data","cpu_count":6,"cpu_total_load":100}'
    expect(G.parseSysmontapCpu(line)).toEqual({
      cpuCount: 6,
      cpuTotalLoad: 100,
      perCpu: [],
      memTotalKb: 0,
      memUsedKb: 0
    })
  })
  it('ignores non-sample / partial lines', () => {
    expect(G.parseSysmontapCpu('{"msg":"starting to monitor"}')).toBeNull()
    expect(G.parseSysmontapCpu('  {"cpu_count":6,')).toBeNull()
    expect(G.parseSysmontapCpu('')).toBeNull()
  })
  it('normalizes total load to 0-100% per core (clamped)', () => {
    expect(G.sysmontapCpuPercent(333.3, 6)).toBeCloseTo(55.55, 1)
    expect(G.sysmontapCpuPercent(1200, 6)).toBe(100)
    expect(G.sysmontapCpuPercent(50, 0)).toBe(0)
  })
})

describe('parseIosBattery', () => {
  it('merges batterycheck + batteryregistry (temp is centi-°C)', () => {
    const check = '{"BatteryCurrentCapacity":97,"BatteryIsCharging":true,"ExternalConnected":true}'
    const reg = '{"Temperature":3450,"IsCharging":true,"CurrentCapacity":97}'
    expect(G.parseIosBattery(check, reg)).toEqual({ level: 97, tempC: 34.5, powered: true })
  })
  it('falls back to registry capacity + reports unplugged', () => {
    expect(G.parseIosBattery('{}', '{"CurrentCapacity":80,"Temperature":3000,"IsCharging":false}')).toEqual({
      level: 80,
      tempC: 30,
      powered: false
    })
  })
  it('is null when no capacity is present', () => {
    expect(G.parseIosBattery('{}', '{}')).toBeNull()
  })
})

describe('syslogToThreadtime', () => {
  it('reshapes an ASL line into adb threadtime (process→tag, level, tid 0)', () => {
    const line = 'Jul 16 03:41:21 iPhone-14 audiomxd(AudioToolbox)[104] <Error>: could not fetch'
    expect(G.syslogToThreadtime(line)).toBe('07-16 03:41:21.000 104 0 E audiomxd(AudioToolbox): could not fetch')
  })
  it('maps iOS levels to the closest Android priority (Notice→I)', () => {
    const line = 'Jan  6 09:00:00 host kernel[0] <Notice>: hi'
    expect(G.syslogToThreadtime(line)).toBe('01-06 09:00:00.000 0 0 I kernel: hi')
  })
  it('returns null for a line that is not standard syslog', () => {
    expect(G.syslogToThreadtime('a continuation line with no header')).toBeNull()
    expect(G.syslogToThreadtime('')).toBeNull()
  })
})

describe('configuration-profile helpers (CA delivery)', () => {
  it('builds profile list/add/remove arg vectors', () => {
    expect(G.profileListArgs('UDID')).toEqual(['profile', 'list', '--udid', 'UDID'])
    expect(G.profileAddArgs('UDID', '/tmp/ca.mobileconfig')).toEqual(['profile', 'add', '/tmp/ca.mobileconfig', '--udid', 'UDID'])
    expect(G.profileRemoveArgs('UDID', 'com.x.y')).toEqual(['profile', 'remove', 'com.x.y', '--udid', 'UDID'])
  })

  it('parses `profile list` JSON into identifier + display name', () => {
    const out = JSON.stringify([
      {
        Identifier: 'com.androidlabkit.ca',
        Metadata: { PayloadDisplayName: 'MobileLabKit CA' }
      },
      { Identifier: 'other.profile', Metadata: { PayloadDisplayName: 'Other' } }
    ])
    const rows = G.parseProfileList(out)
    expect(rows).toEqual([
      { identifier: 'com.androidlabkit.ca', displayName: 'MobileLabKit CA' },
      { identifier: 'other.profile', displayName: 'Other' }
    ])
  })

  it('parse tolerates go-ios log lines prepended on stdout', () => {
    const out = ['{"level":"info","msg":"connecting"}', JSON.stringify([{ Identifier: 'x', Metadata: {} }])].join('\n')
    expect(G.parseProfileList(out)).toEqual([{ identifier: 'x', displayName: '' }])
  })

  it('findCaProfile matches by identifier or display name, else null', () => {
    const byId = JSON.stringify([{ Identifier: G.CA_PROFILE_IDENTIFIER, Metadata: {} }])
    expect(G.findCaProfile(byId)).toBe(G.CA_PROFILE_IDENTIFIER)
    // MCInstall sometimes reports its own hash identifier — match on the name then.
    const byName = JSON.stringify([{ Identifier: 'deadbeefhash', Metadata: { PayloadDisplayName: G.CA_PROFILE_NAME } }])
    expect(G.findCaProfile(byName)).toBe('deadbeefhash')
    expect(G.findCaProfile(JSON.stringify([{ Identifier: 'nope', Metadata: { PayloadDisplayName: 'Nope' } }]))).toBeNull()
    expect(G.findCaProfile('')).toBeNull()
  })

  it('caMobileconfig embeds the DER as a root-CA payload with our identifier', () => {
    const der = 'QUJDRA==' // base64("ABCD")
    const mc = G.caMobileconfig(der)
    expect(mc).toContain('<?xml version="1.0"')
    expect(mc).toContain('<key>PayloadType</key><string>com.apple.security.root</string>')
    expect(mc).toContain(`<data>${der}</data>`)
    expect(mc).toContain(`<string>${G.CA_PROFILE_IDENTIFIER}</string>`)
    expect(mc).toContain(`<string>${G.CA_PROFILE_NAME}</string>`)
    // top-level payload wraps the cert payload
    expect(mc).toContain('<key>PayloadType</key><string>Configuration</string>')
  })
})
