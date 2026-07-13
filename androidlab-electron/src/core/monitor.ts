/**
 * Device performance-monitor parsers. Faithful port of logcat_viewer/monitor.py's
 * pure helpers (build_probe + parse_* + cpu_percent). DOM/adb-free so they're
 * unit-tested directly; the poller lives in main/services/monitor.ts.
 */

/** The three procfs files, concatenated (told apart by line shape). */
const PROBE = 'cat /proc/stat /proc/meminfo /proc/loadavg'

export const CPU_MARK = '@@CPU@@'
export const MEM_MARK = '@@MEM@@'
export const BAT_MARK = '@@BAT@@'
export const GFX_MARK = '@@GFX@@'

const LOADAVG_RE = /^\s*(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)/
// dumpsys cpuinfo rows: "  8.3% 12345/com.example.app: 5% user + 3.3% kernel"
const APP_CPU_RE = /^\s*([\d.]+)%\s+\d+\/(\S+?):/gm

export interface Battery {
  level: number
  tempC: number | null
  powered: boolean
}
export interface Gfx {
  total: number
  janky: number
  jankyPct: number
  recentPct?: number
  p50?: number
  p90?: number
  p95?: number
  p99?: number
}
export interface AppStats {
  cpu: number | null
  memKb: number | null
  running: boolean
}
export interface Sample {
  cpu: number | null
  mem: [number, number] | null
  load: [number, number, number] | null
  cores: number
  coresPct: Array<number | null> | null
  battery: Battery | null
  gfx: Gfx | null
  app: AppStats | null
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** The one-round-trip shell probe: procfs + battery, plus per-app cpuinfo /
 *  meminfo / gfxinfo when an app is being watched. */
export function buildProbe(pkg: string | null): string {
  let script = PROBE
  if (pkg) {
    const q = shellQuote(pkg)
    script +=
      `; echo ${CPU_MARK}; dumpsys cpuinfo 2>/dev/null` +
      `; echo ${MEM_MARK}; dumpsys meminfo ${q} 2>/dev/null`
  }
  script += `; echo ${BAT_MARK}; dumpsys battery 2>/dev/null`
  if (pkg) {
    const q = shellQuote(pkg)
    script += `; echo ${GFX_MARK}; dumpsys gfxinfo ${q} 2>/dev/null`
  }
  return script
}

const digits = (tokens: string[]): number[] => tokens.filter((x) => /^\d+$/.test(x)).map(Number)

export function parseBattery(text: string): Battery | null {
  const m = /level:\s*(\d+)/.exec(text)
  if (!m) return null
  const out: Battery = {
    level: parseInt(m[1], 10),
    tempC: null,
    powered: /(AC|USB|Wireless) powered: true/.test(text)
  }
  const t = /temperature:\s*(-?\d+)/.exec(text)
  if (t) out.tempC = parseInt(t[1], 10) / 10.0
  return out
}

export function parseGfxinfo(text: string): Gfx | null {
  const total = /Total frames rendered:\s*(\d+)/.exec(text)
  if (!total) return null
  const out: Gfx = { total: parseInt(total[1], 10), janky: 0, jankyPct: 0.0 }
  const j = /Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/.exec(text)
  if (j) {
    out.janky = parseInt(j[1], 10)
    out.jankyPct = parseFloat(j[2])
  }
  for (const pct of [50, 90, 95, 99] as const) {
    const m = new RegExp(`${pct}th percentile:\\s*(\\d+)ms`).exec(text)
    if (m) out[`p${pct}` as 'p50' | 'p90' | 'p95' | 'p99'] = parseInt(m[1], 10)
  }
  return out
}

export function parseAppCpu(text: string, pkg: string): number | null {
  let total: number | null = null
  APP_CPU_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = APP_CPU_RE.exec(text)) !== null) {
    if (m[2].split(':', 1)[0] === pkg) total = (total ?? 0) + parseFloat(m[1])
  }
  return total
}

export function parseAppMeminfo(text: string): number | null {
  const m = /TOTAL PSS:\s*(\d+)/.exec(text) // newer Android
  if (m) return parseInt(m[1], 10)
  const m2 = /^\s*TOTAL\s+(\d+)/m.exec(text) // older table: PSS is col 1
  return m2 ? parseInt(m2[1], 10) : null
}

export function parseCpuStat(text: string): [number, number] | null {
  for (const line of text.split('\n')) {
    const parts = line.split(/\s+/).filter(Boolean)
    if (parts.length > 0 && parts[0] === 'cpu') {
      const nums = digits(parts.slice(1))
      if (nums.length < 4) return null
      const idle = nums[3] + (nums.length > 4 ? nums[4] : 0)
      return [nums.reduce((a, b) => a + b, 0), idle]
    }
  }
  return null
}

export function cpuCoreCount(text: string): number {
  let n = 0
  for (const l of text.split('\n')) if (/^cpu\d+\b/.test(l)) n++
  return n
}

export function parseCpuCores(text: string): Array<[number, number]> {
  const cores: Array<[number, number, number]> = []
  for (const line of text.split('\n')) {
    const m = /^cpu(\d+)\b/.exec(line)
    if (!m) continue
    const nums = digits(line.split(/\s+/).filter(Boolean).slice(1))
    if (nums.length >= 4) {
      const idle = nums[3] + (nums.length > 4 ? nums[4] : 0)
      cores.push([parseInt(m[1], 10), nums.reduce((a, b) => a + b, 0), idle])
    }
  }
  cores.sort((a, b) => a[0] - b[0])
  return cores.map(([, t, i]) => [t, i])
}

const MEM_WANT: Record<string, string> = {
  MemTotal: 'total',
  MemAvailable: 'available',
  MemFree: 'free',
  Buffers: 'buffers',
  Cached: 'cached',
  SwapTotal: 'swap_total',
  SwapFree: 'swap_free'
}

export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const ci = line.indexOf(':')
    if (ci < 0) continue
    const key = line.slice(0, ci)
    if (key in MEM_WANT) {
      const tok = line.slice(ci + 1).trim().split(/\s+/)
      if (tok[0] && /^\d+$/.test(tok[0])) out[MEM_WANT[key]] = parseInt(tok[0], 10)
    }
  }
  return out
}

export function memUsedKb(info: Record<string, number>): [number, number] | null {
  const total = info.total
  if (!total) return null
  let used: number
  if ('available' in info) used = total - info.available
  else used = total - (info.free ?? 0) - (info.buffers ?? 0) - (info.cached ?? 0)
  return [Math.max(0, used), total]
}

export function parseLoadavg(text: string): [number, number, number] | null {
  for (const line of text.split('\n')) {
    const m = LOADAVG_RE.exec(line)
    if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]
  }
  return null
}

export function cpuPercent(
  prev: [number, number] | null,
  cur: [number, number] | null
): number | null {
  if (!prev || !cur) return null
  const dt = cur[0] - prev[0]
  const di = cur[1] - prev[1]
  if (dt <= 0) return null
  return Math.max(0.0, Math.min(100.0, (100.0 * (dt - di)) / dt))
}
