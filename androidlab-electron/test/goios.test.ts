/**
 * go-ios pure-helper parity tests — the parsers/arg-builders that turn
 * `ios list` / `ios info` / `ios apps` output into the Apps-tab data model.
 * Fixtures are synthetic (no real device PII).
 */
import { describe, expect, it } from 'vitest'
import * as G from '@core/goios'

describe('parseDeviceList', () => {
  it('reads UDIDs from a deviceList document', () => {
    expect(G.parseDeviceList('{"deviceList":["00008130-AAA","00008120-BBB"]}')).toEqual([
      '00008130-AAA',
      '00008120-BBB'
    ])
  })

  it('tolerates structured log lines prepended on stdout', () => {
    const out = ['{"level":"warn","msg":"agent not running"}', '{"deviceList":["UDID-1"]}'].join('\n')
    expect(G.parseDeviceList(out)).toEqual(['UDID-1'])
  })

  it('returns [] for empty / junk output', () => {
    expect(G.parseDeviceList('')).toEqual([])
    expect(G.parseDeviceList('not json at all')).toEqual([])
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
    expect(G.listArgs()).toEqual(['list'])
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

  it('builds developer-tier argv (ps / launch / kill / tunnel)', () => {
    expect(G.psArgs('U')).toEqual(['ps', '--udid', 'U'])
    expect(G.psArgs('U', true)).toEqual(['ps', '--apps', '--udid', 'U'])
    expect(G.launchArgs('U', 'com.x')).toEqual(['launch', 'com.x', '--udid', 'U'])
    expect(G.launchArgs('U', 'com.x', true)).toEqual(['launch', 'com.x', '--kill-existing', '--udid', 'U'])
    expect(G.killArgs('U', 'com.x')).toEqual(['kill', 'com.x', '--udid', 'U'])
    expect(G.tunnelStartArgs('U')).toEqual(['tunnel', 'start', '--userspace', '--udid', 'U'])
    expect(G.tunnelLsArgs()).toEqual(['tunnel', 'ls'])
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
