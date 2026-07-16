/**
 * Device-Info aggregation for the visual Device Info tab. Pure parsers over the
 * (no-tunnel) go-ios lockdown payloads — `ios info`, `ios diskspace`,
 * `ios batterycheck` + `ios batteryregistry` — plus small spec maps that turn a
 * bare ProductType/HardwarePlatform into human specs (marketing name, chip, RAM,
 * display). DOM-/fs-free so it's unit-tested; device I/O lives in the service.
 */

export interface IosStorage {
  totalBytes: number
  freeBytes: number
}
export interface IosBatteryInfo {
  level: number
  healthPct: number | null
  cycleCount: number | null
  tempC: number | null
  charging: boolean
  designCapacity: number | null
  nominalCapacity: number | null
}
export interface IosDeviceInfo {
  name: string
  productType: string
  marketingName: string
  deviceClass: string
  osName: string
  osVersion: string
  buildVersion: string
  modelNumber: string
  regionInfo: string
  chip: string
  cpuArch: string
  hardwarePlatform: string
  ram: string
  display: string
  activated: boolean
  passwordProtected: boolean
  timeZone: string
  uses24h: boolean
  telephony: boolean
  simStatus: string
  baseband: string
  storage: IosStorage | null
  battery: IosBatteryInfo | null
  /** Curated extra rows for the "All details" grid: [label, value]. */
  details: Array<[string, string]>
}

interface Spec {
  name: string
  chip?: string
  ram?: string
  display?: string
}

// ProductType → marketing name + specs. Covers recent iPhones (the ones this
// tool is likely pointed at); unknown models fall back to the ProductType and a
// platform-derived chip. RAM/display are only asserted where confidently known.
const SPECS: Record<string, Spec> = {
  // iPhone 16 family (A18 / A18 Pro)
  'iPhone17,1': { name: 'iPhone 16 Pro', chip: 'A18 Pro', ram: '8 GB', display: '6.3-inch · 2622×1206 · 120 Hz' },
  'iPhone17,2': { name: 'iPhone 16 Pro Max', chip: 'A18 Pro', ram: '8 GB', display: '6.9-inch · 2868×1320 · 120 Hz' },
  'iPhone17,3': { name: 'iPhone 16', chip: 'A18', ram: '8 GB', display: '6.1-inch · 2556×1179 · 60 Hz' },
  'iPhone17,4': { name: 'iPhone 16 Plus', chip: 'A18', ram: '8 GB', display: '6.7-inch · 2796×1290 · 60 Hz' },
  // iPhone 15 family
  'iPhone16,1': { name: 'iPhone 15 Pro', chip: 'A17 Pro', ram: '8 GB', display: '6.1-inch · 2556×1179 · 120 Hz' },
  'iPhone16,2': { name: 'iPhone 15 Pro Max', chip: 'A17 Pro', ram: '8 GB', display: '6.7-inch · 2796×1290 · 120 Hz' },
  'iPhone15,4': { name: 'iPhone 15', chip: 'A16 Bionic', ram: '6 GB', display: '6.1-inch · 2556×1179 · 60 Hz' },
  'iPhone15,5': { name: 'iPhone 15 Plus', chip: 'A16 Bionic', ram: '6 GB', display: '6.7-inch · 2796×1290 · 60 Hz' },
  // iPhone 14 family
  'iPhone15,2': { name: 'iPhone 14 Pro', chip: 'A16 Bionic', ram: '6 GB', display: '6.1-inch · 2556×1179 · 120 Hz' },
  'iPhone15,3': { name: 'iPhone 14 Pro Max', chip: 'A16 Bionic', ram: '6 GB', display: '6.7-inch · 2796×1290 · 120 Hz' },
  'iPhone14,7': { name: 'iPhone 14', chip: 'A15 Bionic', ram: '6 GB', display: '6.1-inch · 2532×1170 · 60 Hz' },
  'iPhone14,8': { name: 'iPhone 14 Plus', chip: 'A15 Bionic', ram: '6 GB', display: '6.7-inch · 2778×1284 · 60 Hz' },
  // iPhone 13 family
  'iPhone14,2': { name: 'iPhone 13 Pro', chip: 'A15 Bionic', ram: '6 GB', display: '6.1-inch · 2532×1170 · 120 Hz' },
  'iPhone14,3': { name: 'iPhone 13 Pro Max', chip: 'A15 Bionic', ram: '6 GB', display: '6.7-inch · 2778×1284 · 120 Hz' },
  'iPhone14,4': { name: 'iPhone 13 mini', chip: 'A15 Bionic', ram: '4 GB', display: '5.4-inch · 2340×1080 · 60 Hz' },
  'iPhone14,5': { name: 'iPhone 13', chip: 'A15 Bionic', ram: '4 GB', display: '6.1-inch · 2532×1170 · 60 Hz' },
  'iPhone14,6': { name: 'iPhone SE (3rd gen)', chip: 'A15 Bionic', ram: '4 GB', display: '4.7-inch · 1334×750 · 60 Hz' },
  // iPhone 12 family
  'iPhone13,1': { name: 'iPhone 12 mini', chip: 'A14 Bionic', ram: '4 GB' },
  'iPhone13,2': { name: 'iPhone 12', chip: 'A14 Bionic', ram: '4 GB' },
  'iPhone13,3': { name: 'iPhone 12 Pro', chip: 'A14 Bionic', ram: '6 GB' },
  'iPhone13,4': { name: 'iPhone 12 Pro Max', chip: 'A14 Bionic', ram: '6 GB' }
}

// HardwarePlatform → chip, so even unmapped ProductTypes get an accurate SoC.
const PLATFORM_CHIP: Record<string, string> = {
  t8140: 'A18 Pro', t8150: 'A18',
  t8130: 'A17 Pro', t8120: 'A16 Bionic', t8110: 'A15 Bionic',
  t8101: 'A14 Bionic', t8030: 'A13 Bionic', t8027: 'A12 Bionic', t8015: 'A11 Bionic'
}

function str(o: Record<string, unknown>, key: string): string {
  const v = o[key]
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}
function bool(o: Record<string, unknown>, key: string): boolean {
  return o[key] === true || o[key] === 'true'
}
function num(o: Record<string, unknown>, key: string): number | null {
  const v = o[key]
  return typeof v === 'number' ? v : null
}
function safeParse(json: string): Record<string, unknown> {
  try {
    const o = JSON.parse(json.trim())
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function osNameFor(deviceClass: string): string {
  const c = deviceClass.toLowerCase()
  if (c === 'ipad') return 'iPadOS'
  if (c === 'watch') return 'watchOS'
  if (c === 'appletv' || c === 'tv') return 'tvOS'
  return 'iOS'
}

/** Aggregate the raw go-ios payloads into a display-ready IosDeviceInfo. */
export function parseDeviceInfo(
  infoJson: string,
  diskJson: string,
  batteryRegistryJson: string,
  batteryCheckJson: string
): IosDeviceInfo {
  const info = safeParse(infoJson)
  const disk = safeParse(diskJson)
  const reg = safeParse(batteryRegistryJson)
  const chk = safeParse(batteryCheckJson)

  const productType = str(info, 'ProductType')
  const platform = str(info, 'HardwarePlatform')
  const spec = SPECS[productType]
  const deviceClass = str(info, 'DeviceClass') || 'iPhone'

  const totalBytes = num(disk, 'TotalBytes')
  const freeBytes = num(disk, 'FreeBytes')
  const storage: IosStorage | null =
    totalBytes && freeBytes !== null ? { totalBytes, freeBytes } : null

  const level = num(chk, 'BatteryCurrentCapacity') ?? num(reg, 'CurrentCapacity')
  const design = num(reg, 'DesignCapacity')
  const nominal = num(reg, 'NominalChargeCapacity')
  const temp = num(reg, 'Temperature')
  const battery: IosBatteryInfo | null =
    level === null
      ? null
      : {
          level,
          healthPct: design && nominal ? Math.round((nominal / design) * 1000) / 10 : null,
          cycleCount: num(reg, 'CycleCount'),
          tempC: temp !== null ? Math.round(temp / 10) / 10 : null,
          charging: bool(reg, 'IsCharging') || bool(chk, 'BatteryIsCharging'),
          designCapacity: design,
          nominalCapacity: nominal
        }

  // Curated detail rows (identifiers included — it's the user's own device, the
  // point of an About screen). Only include what's present.
  const detailKeys: Array<[string, string]> = [
    ['Serial Number', 'SerialNumber'],
    ['UDID', 'UniqueDeviceID'],
    ['Model Number', 'ModelNumber'],
    ['Board ID', 'BoardId'],
    ['Chip ID', 'ChipID'],
    ['Hardware Model', 'HardwareModel'],
    ['Wi-Fi Address', 'WiFiAddress'],
    ['Bluetooth Address', 'BluetoothAddress'],
    ['Firmware', 'FirmwareVersion'],
    ['Baseband', 'BasebandVersion'],
    ['Region', 'RegionInfo'],
    ['Time Zone', 'TimeZone'],
    ['Boot Session', 'BootSessionID']
  ]
  const details = detailKeys
    .map(([label, key]) => [label, str(info, key)] as [string, string])
    .filter(([, v]) => v !== '')

  return {
    name: str(info, 'DeviceName') || deviceClass,
    productType,
    marketingName: spec?.name ?? productType ?? 'Unknown device',
    deviceClass,
    osName: osNameFor(deviceClass),
    osVersion: str(info, 'HumanReadableProductVersionString') || str(info, 'ProductVersion'),
    buildVersion: str(info, 'BuildVersion'),
    modelNumber: str(info, 'ModelNumber'),
    regionInfo: str(info, 'RegionInfo'),
    chip: spec?.chip ?? PLATFORM_CHIP[platform] ?? '',
    cpuArch: str(info, 'CPUArchitecture'),
    hardwarePlatform: platform,
    ram: spec?.ram ?? '',
    display: spec?.display ?? '',
    activated: str(info, 'ActivationState') === 'Activated',
    passwordProtected: bool(info, 'PasswordProtected'),
    timeZone: str(info, 'TimeZone'),
    uses24h: bool(info, 'Uses24HourClock'),
    telephony: bool(info, 'TelephonyCapability'),
    simStatus: /ready/i.test(str(info, 'SIMStatus')) ? 'Ready' : str(info, 'SIMStatus') ? 'No SIM' : '',
    baseband: str(info, 'BasebandVersion'),
    storage,
    battery,
    details
  }
}

/** Human GB string, e.g. 255515160576 → "238 GB" (binary GiB, Settings-style). */
export function fmtGB(bytes: number): string {
  return `${Math.round(bytes / 1024 ** 3)} GB`
}
