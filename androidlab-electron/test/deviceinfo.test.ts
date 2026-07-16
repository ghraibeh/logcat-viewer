/**
 * Android Device-Info aggregation tests. Synthetic fixtures (no real device PII).
 */
import { describe, expect, it } from 'vitest'
import {
  buildProbe,
  fmtGB,
  fmtRam,
  parseBattery,
  parseDensity,
  parseDeviceInfo,
  parseGetprop,
  parseRamBytes,
  parseResolution,
  parseStorage,
  parseUptime,
  splitSections
} from '@core/deviceinfo'

const PROPS = [
  '[ro.product.model]: [Pixel 8 Pro]',
  '[ro.product.manufacturer]: [google]',
  '[ro.product.brand]: [google]',
  '[ro.product.device]: [husky]',
  '[ro.product.board]: [zuma]',
  '[ro.product.cpu.abi]: [arm64-v8a]',
  '[ro.build.version.release]: [14]',
  '[ro.build.version.sdk]: [34]',
  '[ro.build.version.security_patch]: [2024-05-05]',
  '[ro.build.display.id]: [AP2A.240505.004]',
  '[ro.build.id]: [AP2A.240505.004]',
  '[ro.build.type]: [user]',
  '[ro.build.tags]: [release-keys]',
  '[ro.build.fingerprint]: [google/husky/husky:14/AP2A.240505.004/x:user/release-keys]',
  '[ro.bootloader]: [husky-1.0]',
  '[ro.hardware]: [zuma]',
  '[ro.soc.manufacturer]: [Google]',
  '[ro.soc.model]: [Tensor G3]',
  '[ro.crypto.state]: [encrypted]',
  '[ro.serialno]: [PROPSERIAL123]',
  '[gsm.operator.alpha]: [Test Carrier,]',
  '[gsm.sim.state]: [READY,ABSENT]',
  '[gsm.version.baseband]: [g5300-11111-AA]'
].join('\n')

const BATTERY = [
  'Current Battery Service state:',
  '  AC powered: false',
  '  USB powered: true',
  '  status: 2',
  '  health: 2',
  '  level: 76',
  '  scale: 100',
  '  voltage: 4123',
  '  temperature: 291',
  '  technology: Li-ion'
].join('\n')

const STORAGE = [
  'Filesystem     1K-blocks     Used Available Use% Mounted on',
  '/dev/block/dm-45 118552576 61234176  55318400  53% /data'
].join('\n')

const MEM = ['MemTotal:        8123456 kB', 'MemFree:         1000000 kB', 'MemAvailable:    4000000 kB'].join('\n')
const SIZE = 'Physical size: 1080x2400'
const DENSITY = 'Physical density: 480'
const ROUTE = [
  'default via 192.168.1.1 dev wlan0 proto static',
  '192.168.1.0/24 dev wlan0 proto kernel scope link src 192.168.1.42'
].join('\n')
const UPTIME = '93784.19 350210.55'
const KERNEL = 'Linux localhost 5.15.94-android14-11 #1 SMP PREEMPT Wed Jan 1 00:00:00 UTC 2024 aarch64'
const DEVNAME = 'My Pixel'

function fixture(over: Partial<Record<string, string>> = {}): string {
  const sections: Record<string, string> = {
    props: PROPS,
    battery: BATTERY,
    storage: STORAGE,
    mem: MEM,
    size: SIZE,
    density: DENSITY,
    route: ROUTE,
    uptime: UPTIME,
    kernel: KERNEL,
    devname: DEVNAME,
    ...over
  }
  return Object.entries(sections)
    .map(([k, v]) => `@@${k}@@\n${v}`)
    .join('\n')
}

describe('buildProbe / splitSections', () => {
  it('emits an echo marker before each command', () => {
    const probe = buildProbe()
    expect(probe).toContain('echo @@props@@; getprop 2>/dev/null')
    expect(probe).toContain('echo @@battery@@; dumpsys battery 2>/dev/null')
  })

  it('splits marker-delimited output back into sections', () => {
    const s = splitSections(fixture())
    expect(s.size).toBe('Physical size: 1080x2400')
    expect(s.devname).toBe('My Pixel')
  })
})

describe('individual parsers', () => {
  it('parseGetprop reads [key]: [value] pairs', () => {
    const p = parseGetprop(PROPS)
    expect(p['ro.product.model']).toBe('Pixel 8 Pro')
    expect(p['ro.build.version.sdk']).toBe('34')
  })

  it('parseBattery maps status/health codes and scales units', () => {
    const b = parseBattery(BATTERY)!
    expect(b.level).toBe(76)
    expect(b.status).toBe('Charging')
    expect(b.health).toBe('Good')
    expect(b.tempC).toBe(29.1)
    expect(b.voltageV).toBe(4.12)
    expect(b.charging).toBe(true)
  })

  it('parseStorage reads the /data row as bytes', () => {
    const st = parseStorage(STORAGE)!
    expect(st.totalBytes).toBe(118552576 * 1024)
    expect(st.freeBytes).toBe(55318400 * 1024)
  })

  it('parseStorage reads the Samsung /data/user/0 mount', () => {
    const oneui = 'Filesystem       1K-blocks     Used Available Use% Mounted on\n/dev/block/dm-70 109930496 54708916  55090508  50% /data/user/0'
    const st = parseStorage(oneui)!
    expect(st.totalBytes).toBe(109930496 * 1024)
    expect(st.freeBytes).toBe(55090508 * 1024)
  })

  it('parseStorage tolerates a wrapped long filesystem name', () => {
    const wrapped = 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/mapper/really-long-name\n 100 40 60 40% /data'
    const st = parseStorage(wrapped)!
    expect(st.totalBytes).toBe(100 * 1024)
    expect(st.freeBytes).toBe(60 * 1024)
  })

  it('parseRamBytes reads MemTotal', () => {
    expect(parseRamBytes(MEM)).toBe(8123456 * 1024)
  })

  it('parseResolution / parseDensity prefer an Override when set', () => {
    expect(parseResolution(SIZE)).toBe('1080 × 2400')
    expect(parseResolution('Physical size: 1080x2400\nOverride size: 720x1600')).toBe('720 × 1600')
    expect(parseDensity(DENSITY)).toBe('480 dpi')
    expect(parseDensity('Physical density: 480\nOverride density: 420')).toBe('420 dpi')
  })

  it('parseUptime formats /proc/uptime seconds', () => {
    expect(parseUptime(UPTIME)).toBe('1d 2h 3m')
    expect(parseUptime('45.0 100.0')).toBe('0m')
  })

  it('fmtGB rounds to whole binary GiB', () => {
    expect(fmtGB(8123456 * 1024)).toBe('8 GB')
  })

  it('fmtRam snaps MemTotal up to the marketed size', () => {
    expect(fmtRam(7788986368)).toBe('8 GB') // A55: 7.25 GiB reported → 8 GB
    expect(fmtRam(5.7 * 1024 ** 3)).toBe('6 GB')
    expect(fmtRam(3.6 * 1024 ** 3)).toBe('4 GB')
    expect(fmtRam(11.2 * 1024 ** 3)).toBe('12 GB')
  })
})

describe('parseDeviceInfo', () => {
  const d = parseDeviceInfo(fixture())

  it('resolves the hero identity + friendly name', () => {
    expect(d.name).toBe('My Pixel')
    expect(d.model).toBe('Pixel 8 Pro')
    expect(d.manufacturer).toBe('Google') // capitalized
    expect(d.androidName).toBe('Android 14')
    expect(d.sdk).toBe('34')
  })

  it('derives the chip from ro.soc.* and the display string', () => {
    expect(d.chip).toBe('Google Tensor G3')
    expect(d.display).toBe('1080 × 2400 · 480 dpi')
    expect(d.ram).toBe('8 GB')
  })

  it('reads storage, battery, and Wi-Fi IP', () => {
    expect(d.storage?.totalBytes).toBe(118552576 * 1024)
    expect(d.battery?.level).toBe(76)
    expect(d.ip).toBe('192.168.1.42')
  })

  it('cleans dual-SIM carrier strings and flags telephony', () => {
    expect(d.carrier).toBe('Test Carrier')
    expect(d.simState).toBe('READY,ABSENT')
    expect(d.telephony).toBe(true)
  })

  it('collapses a duplicated dual-SIM baseband', () => {
    const dual = parseDeviceInfo(fixture({ props: PROPS.replace('[gsm.version.baseband]: [g5300-11111-AA]', '[gsm.version.baseband]: [g5300-11111-AA,g5300-11111-AA]') }))
    expect(dual.radio).toBe('g5300-11111-AA')
  })

  it('falls back to the adb serial when ro.serialno is hidden', () => {
    const hidden = parseDeviceInfo(fixture({ props: PROPS.replace('[ro.serialno]: [PROPSERIAL123]', '[ro.serialno]: []') }), 'ADBSERIAL999')
    expect(hidden.serial).toBe('ADBSERIAL999')
  })

  it('uses the model when no device_name is set', () => {
    const noName = parseDeviceInfo(fixture({ devname: 'null' }))
    expect(noName.name).toBe('Pixel 8 Pro')
  })

  it('builds a details grid that omits empty rows', () => {
    const keys = d.details.map(([k]) => k)
    expect(keys).toContain('Security patch')
    expect(keys).toContain('Kernel')
    expect(d.details.every(([, v]) => v !== '')).toBe(true)
  })
})
