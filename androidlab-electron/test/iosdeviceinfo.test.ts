/**
 * Device-Info aggregation tests. Synthetic fixtures (no real device PII).
 */
import { describe, expect, it } from 'vitest'
import { parseDeviceInfo, fmtGB } from '@core/iosdeviceinfo'

const INFO = JSON.stringify({
  DeviceName: 'Test Phone',
  ProductType: 'iPhone16,2',
  DeviceClass: 'iPhone',
  ProductVersion: '26.5.2',
  HumanReadableProductVersionString: '26.5.2',
  BuildVersion: '23F84',
  ModelNumber: 'MU793',
  RegionInfo: 'AA/A',
  CPUArchitecture: 'arm64e',
  HardwarePlatform: 't8130',
  ActivationState: 'Activated',
  PasswordProtected: false,
  TimeZone: 'Asia/Amman',
  Uses24HourClock: false,
  TelephonyCapability: true,
  SIMStatus: 'kCTSIMSupportSIMStatusReady',
  BasebandVersion: '3.50.08',
  SerialNumber: 'SERIAL123',
  UniqueDeviceID: 'UDID-XYZ',
  WiFiAddress: 'aa:bb:cc:dd:ee:ff'
})
const DISK = JSON.stringify({ TotalBytes: 255515160576, FreeBytes: 12987228160, BlockSize: 4096 })
const REG = JSON.stringify({ Temperature: 3279, IsCharging: true, CurrentCapacity: 98, DesignCapacity: 4395, NominalChargeCapacity: 3909, CycleCount: 614 })
const CHK = JSON.stringify({ BatteryCurrentCapacity: 98, BatteryIsCharging: true, ExternalConnected: true })

describe('parseDeviceInfo', () => {
  const d = parseDeviceInfo(INFO, DISK, REG, CHK)

  it('resolves marketing name / chip / RAM / display from ProductType', () => {
    expect(d.marketingName).toBe('iPhone 15 Pro Max')
    expect(d.chip).toBe('A17 Pro')
    expect(d.ram).toBe('8 GB')
    expect(d.display).toContain('120 Hz')
  })

  it('maps identity + system fields', () => {
    expect(d.name).toBe('Test Phone')
    expect(d.osName).toBe('iOS')
    expect(d.osVersion).toBe('26.5.2')
    expect(d.buildVersion).toBe('23F84')
    expect(d.activated).toBe(true)
    expect(d.telephony).toBe(true)
    expect(d.simStatus).toBe('Ready')
    expect(d.timeZone).toBe('Asia/Amman')
    expect(d.uses24h).toBe(false)
  })

  it('carries storage bytes', () => {
    expect(d.storage).toEqual({ totalBytes: 255515160576, freeBytes: 12987228160 })
  })

  it('derives battery health = nominal/design and keeps cycles + temp', () => {
    expect(d.battery?.level).toBe(98)
    expect(d.battery?.healthPct).toBeCloseTo(88.9, 1) // 3909/4395
    expect(d.battery?.cycleCount).toBe(614)
    expect(d.battery?.tempC).toBeCloseTo(32.8, 1)
    expect(d.battery?.charging).toBe(true)
  })

  it('includes identifier detail rows (About-screen style)', () => {
    const map = Object.fromEntries(d.details)
    expect(map['Serial Number']).toBe('SERIAL123')
    expect(map['UDID']).toBe('UDID-XYZ')
    expect(map['Wi-Fi Address']).toBe('aa:bb:cc:dd:ee:ff')
  })

  it('falls back to platform chip + ProductType name for unknown models', () => {
    const u = parseDeviceInfo(
      JSON.stringify({ ProductType: 'iPhone99,9', HardwarePlatform: 't8120', DeviceClass: 'iPhone' }),
      '{}',
      '{}',
      '{}'
    )
    expect(u.marketingName).toBe('iPhone99,9')
    expect(u.chip).toBe('A16 Bionic')
    expect(u.storage).toBeNull()
    expect(u.battery).toBeNull()
  })
})

describe('fmtGB', () => {
  it('formats bytes as binary GB', () => {
    expect(fmtGB(255515160576)).toBe('238 GB')
    expect(fmtGB(12987228160)).toBe('12 GB')
  })
})
