/**
 * Monitor-parser parity tests — TS equivalents of the monitor checks in
 * tests/smoke.py, over fixtures shaped like real /proc + dumpsys output.
 */
import { describe, expect, it } from 'vitest'
import {
  BAT_MARK,
  CPU_MARK,
  GFX_MARK,
  MEM_MARK,
  buildProbe,
  cpuCoreCount,
  cpuPercent,
  memUsedKb,
  parseAppCpu,
  parseAppMeminfo,
  parseBattery,
  parseCpuCores,
  parseCpuStat,
  parseGfxinfo,
  parseLoadavg,
  parseMeminfo
} from '@core/monitor'

const STAT = `cpu  100 0 100 800 0 0 0 0 0 0
cpu0 50 0 50 400 0 0 0 0
cpu1 50 0 50 400 0 0 0 0
intr 123 4 5 6
ctxt 999`

const MEMINFO = `MemTotal:        8000000 kB
MemFree:         2000000 kB
MemAvailable:    5000000 kB
Buffers:          100000 kB
Cached:          1000000 kB`

const LOADAVG = '1.50 2.00 0.75 1/234 5678'

const BATTERY = `Current Battery Service state:
  AC powered: false
  USB powered: true
  level: 87
  temperature: 305`

const GFX = `Total frames rendered: 1000
Janky frames: 50 (5.00%)
50th percentile: 8ms
90th percentile: 16ms
95th percentile: 22ms
99th percentile: 40ms`

const CPUINFO = `  8.3% 12345/com.example.app: 5% user + 3.3% kernel
  2.0% 12346/com.example.app:child: 1% user + 1% kernel
  1.0% 999/system_server: 0.5% user + 0.5% kernel`

describe('cpu parsing', () => {
  it('parses aggregate cpu jiffies (idle + iowait)', () => {
    // sum = 100+0+100+800 = 1000; idle = idle(800) + iowait(0) = 800
    expect(parseCpuStat(STAT)).toEqual([1000, 800])
  })
  it('counts and parses per-core lines', () => {
    expect(cpuCoreCount(STAT)).toBe(2)
    expect(parseCpuCores(STAT)).toEqual([
      [500, 400],
      [500, 400]
    ])
  })
  it('computes busy% from a jiffies delta', () => {
    expect(cpuPercent([1100, 800], [1300, 850])).toBe(75)
    expect(cpuPercent(null, [1, 1])).toBeNull()
    expect(cpuPercent([10, 5], [10, 5])).toBeNull() // no delta
  })
})

describe('memory parsing', () => {
  it('parses meminfo and prefers MemAvailable', () => {
    const info = parseMeminfo(MEMINFO)
    expect(info.total).toBe(8000000)
    expect(info.available).toBe(5000000)
    expect(memUsedKb(info)).toEqual([3000000, 8000000])
  })
  it('falls back to free+buffers+cached without MemAvailable', () => {
    const info = parseMeminfo('MemTotal: 1000 kB\nMemFree: 400 kB\nBuffers: 100 kB\nCached: 200 kB')
    expect(memUsedKb(info)).toEqual([300, 1000])
  })
})

describe('loadavg + battery + gfx + app', () => {
  it('parses loadavg', () => {
    expect(parseLoadavg(LOADAVG)).toEqual([1.5, 2.0, 0.75])
  })
  it('parses battery (tenths of °C, powered)', () => {
    expect(parseBattery(BATTERY)).toEqual({ level: 87, tempC: 30.5, powered: true })
    expect(parseBattery('no battery here')).toBeNull()
  })
  it('parses gfxinfo frame stats + percentiles', () => {
    const g = parseGfxinfo(GFX)!
    expect(g.total).toBe(1000)
    expect(g.janky).toBe(50)
    expect(g.jankyPct).toBe(5.0)
    expect(g.p90).toBe(16)
    expect(g.p99).toBe(40)
  })
  it('sums app cpu across its processes (incl. :child)', () => {
    expect(parseAppCpu(CPUINFO, 'com.example.app')).toBeCloseTo(10.3, 5)
    expect(parseAppCpu(CPUINFO, 'not.here')).toBeNull()
  })
  it('parses app TOTAL PSS (new + old shapes)', () => {
    expect(parseAppMeminfo('TOTAL PSS:   123456   TOTAL RSS: 200000')).toBe(123456)
    expect(parseAppMeminfo('  TOTAL   65432   0   0')).toBe(65432)
    expect(parseAppMeminfo('nope')).toBeNull()
  })
})

describe('buildProbe', () => {
  it('device-only probe reads procfs + battery', () => {
    const p = buildProbe(null)
    expect(p).toContain('cat /proc/stat /proc/meminfo /proc/loadavg')
    expect(p).toContain(BAT_MARK)
    expect(p).not.toContain(CPU_MARK)
    expect(p).not.toContain(GFX_MARK)
  })
  it('per-app probe adds cpuinfo/meminfo/gfxinfo (quoted pkg)', () => {
    const p = buildProbe('com.example.app')
    expect(p).toContain(CPU_MARK)
    expect(p).toContain(MEM_MARK)
    expect(p).toContain(GFX_MARK)
    expect(p).toContain("dumpsys meminfo 'com.example.app'")
    expect(p).toContain("dumpsys gfxinfo 'com.example.app'")
  })
})
