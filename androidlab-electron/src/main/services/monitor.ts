/**
 * Performance-monitor poller. Faithful port of monitor.py's MonitorWorker:
 * one `adb shell` round-trip per tick reading procfs (+ optional per-app
 * dumpsys), CPU% from the jiffies delta between samples, streamed as Sample
 * events. A recursive timer (not setInterval) prevents overlapping ticks.
 */
import { run } from './adb'
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
  parseMeminfo,
  type Sample
} from '@core/monitor'

export interface MonitorCallbacks {
  onSample: (sample: Sample) => void
  onFailed: (message: string) => void
}

function partition(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep)
  return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + sep.length)]
}

export class MonitorService {
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private serial = ''
  private pkg: string | null = null
  private interval = 1000

  private prevCpu: [number, number] | null = null
  private prevCores: Array<[number, number]> = []
  private prevGfx: { total: number; janky: number } | null = null

  constructor(
    private readonly adb: string,
    private readonly cb: MonitorCallbacks
  ) {}

  start(serial: string, pkg: string | null, intervalMs: number): void {
    this.stop()
    this.serial = serial
    this.pkg = pkg || null
    this.interval = Math.max(250, intervalMs)
    this.prevCpu = null
    this.prevCores = []
    this.prevGfx = null
    this.running = true
    void this.tick()
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private tick = async (): Promise<void> => {
    if (!this.running) return
    const probe = buildProbe(this.pkg)
    const r = await run(this.adb, this.serial, ['shell', probe], 10000)
    if (!this.running) return
    if (!r.stdout && r.stderr) {
      this.cb.onFailed(r.stderr.trim() || 'device read failed')
      this.stop()
      return
    }

    let text = r.stdout
    let gfxTxt: string
    let batTxt: string
    ;[text, gfxTxt] = partition(text, GFX_MARK)
    ;[text, batTxt] = partition(text, BAT_MARK)
    const battery = parseBattery(batTxt)

    let gfx: Sample['gfx'] = null
    let app: Sample['app'] = null
    if (this.pkg) {
      gfx = parseGfxinfo(gfxTxt)
      if (gfx !== null) {
        if (this.prevGfx && gfx.total > this.prevGfx.total) {
          const df = gfx.total - this.prevGfx.total
          const dj = Math.max(0, gfx.janky - this.prevGfx.janky)
          gfx.recentPct = (100.0 * dj) / df
        }
        this.prevGfx = { total: gfx.total, janky: gfx.janky }
      }
      let rest: string
      ;[text, rest] = partition(text, CPU_MARK)
      const [cpuTxt, memTxt] = partition(rest, MEM_MARK)
      const acpu = parseAppCpu(cpuTxt, this.pkg)
      const amem = parseAppMeminfo(memTxt)
      app = { cpu: acpu, memKb: amem, running: acpu !== null || amem !== null }
    }

    const curCpu = parseCpuStat(text)
    const pct = cpuPercent(this.prevCpu, curCpu)
    if (curCpu) this.prevCpu = curCpu

    const curCores = parseCpuCores(text)
    let coresPct: Array<number | null> | null = null
    if (this.prevCores.length > 0 && this.prevCores.length === curCores.length) {
      coresPct = curCores.map((c, i) => cpuPercent(this.prevCores[i], c))
    }
    if (curCores.length > 0) this.prevCores = curCores

    this.cb.onSample({
      cpu: pct,
      mem: memUsedKb(parseMeminfo(text)),
      load: parseLoadavg(text),
      cores: cpuCoreCount(text),
      coresPct,
      battery,
      gfx,
      app
    })

    if (this.running) this.timer = setTimeout(this.tick, this.interval)
  }
}
