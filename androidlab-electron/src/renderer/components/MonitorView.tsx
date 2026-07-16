/**
 * Performance Monitor dashboard — port of monitor.py's MonitorView: CPU / Memory
 * / Battery / UI-Rendering cards with history spark-lines, a per-core CPU meter,
 * a refresh-rate selector, and a per-app overlay following the shared App picker.
 * Polls only while mounted (the tab is only rendered when active).
 */
import { useEffect, useRef, useState } from 'react'
import type { Sample } from '@core/monitor'
import type { Controller } from '../state/useAppController'
import { PALETTE } from '../theme'
import { SparkGraph, SPARK_MAXLEN } from './SparkGraph'
import { CoreBars } from './CoreBars'
import { Icon } from './Icon'

const INTERVALS: Array<[string, number]> = [
  ['0.5 s', 500],
  ['1 s', 1000],
  ['2 s', 2000],
  ['5 s', 5000]
]
const APP_COLOR = PALETTE.AMBER

interface MonState {
  cpuValue: string
  cpuSub: string
  cpuApp: string
  memValue: string
  memSub: string
  memApp: string
  batValue: string
  batSub: string
  gfxValue: string
  gfxSub: string
  cores: Array<number | null>
  cpuHist: Array<number | null>
  cpuAppHist: Array<number | null>
  memHist: Array<number | null>
  memAppHist: Array<number | null>
  batHist: Array<number | null>
  gfxHist: Array<number | null>
}

function initState(serial: string | null, pkg: string | null): MonState {
  const msg = serial ? 'waiting for device…' : 'No device selected'
  return {
    cpuValue: '—',
    cpuSub: msg,
    cpuApp: pkg ? `■ ${pkg}: …` : '',
    memValue: '—',
    memSub: msg,
    memApp: pkg ? `■ ${pkg}: …` : '',
    batValue: '—',
    batSub: msg,
    gfxValue: '—',
    gfxSub: pkg ? 'waiting for frames…' : 'pick an app to see its frame stats',
    cores: [],
    cpuHist: [],
    cpuAppHist: [],
    memHist: [],
    memAppHist: [],
    batHist: [],
    gfxHist: []
  }
}

const push = (arr: Array<number | null>, v: number | null): Array<number | null> =>
  [...arr, v].slice(-SPARK_MAXLEN)
const gb = (kb: number): string => (kb / 1024 / 1024).toFixed(2)
const mb = (kb: number): string => Math.round(kb / 1024).toLocaleString()

function applySample(prev: MonState, s: Sample, pkg: string | null): MonState {
  const next: MonState = { ...prev }
  const app = s.app
  const acpu = app?.cpu ?? null

  if (s.cpu === null) {
    next.cpuValue = '…'
  } else {
    next.cpuValue = `${Math.round(s.cpu)}%`
    next.cpuHist = push(prev.cpuHist, s.cpu / 100)
    next.cpuAppHist = push(prev.cpuAppHist, acpu === null ? null : acpu / 100)
  }
  if (s.coresPct !== null) next.cores = s.coresPct
  const bits: string[] = []
  if (s.cores) bits.push(`${s.cores} cores`)
  if (s.load) bits.push('load ' + s.load.map((x) => x.toFixed(2)).join(' / '))
  next.cpuSub = bits.join('   ·   ') || ' '

  if (s.mem) {
    const [used, total] = s.mem
    const frac = total ? used / total : 0
    next.memValue = `${gb(used)} / ${gb(total)} GB  (${Math.round(frac * 100)}%)`
    const amem = app?.memKb ?? null
    next.memHist = push(prev.memHist, frac)
    next.memAppHist = push(prev.memAppHist, !amem || !total ? null : amem / total)
    next.memSub = `${gb(total - used)} GB free`
  }

  if (s.battery) {
    next.batValue = `${s.battery.level}%`
    const b: string[] = []
    if (s.battery.tempC !== null) b.push(`${s.battery.tempC.toFixed(1)} °C`)
    b.push(s.battery.powered ? 'charging' : 'unplugged')
    next.batSub = b.join('   ·   ')
    next.batHist = push(prev.batHist, s.battery.level / 100)
  }

  if (pkg) {
    const gfx = s.gfx
    if (gfx) {
      const shown = gfx.recentPct ?? gfx.jankyPct ?? 0
      next.gfxValue = `${shown.toFixed(1)}% janky`
      const pcts = ([50, 90, 95, 99] as const)
        .filter((p) => gfx[`p${p}` as 'p50'] !== undefined)
        .map((p) => `p${p} ${gfx[`p${p}` as 'p50']}ms`)
        .join('  ')
      next.gfxSub =
        `${gfx.total.toLocaleString()} frames · ${gfx.janky.toLocaleString()} janky ` +
        `(${gfx.jankyPct.toFixed(1)}% lifetime)   ${pcts}`
      next.gfxHist = push(prev.gfxHist, Math.min(1, shown / 100))
    } else {
      next.gfxValue = '—'
      next.gfxSub = 'no frames rendered (app visible?)'
    }
  }

  if (app !== null && pkg) {
    next.cpuApp = acpu !== null ? `■ ${pkg}: ${Math.round(acpu)}%` : `■ ${pkg}: not running`
    const amem = app.memKb
    next.memApp = amem ? `■ ${pkg}: ${mb(amem)} MB PSS` : `■ ${pkg}: not running`
  }
  return next
}

function Card({
  name,
  value,
  sub,
  app,
  graph
}: {
  name: string
  value: string
  sub: string
  app: string
  graph: React.ReactNode
}) {
  return (
    <div className="mon-card">
      <div className="mon-caption">{name}</div>
      <div className="mon-value">{value}</div>
      <div className="mon-sub">{sub}</div>
      <div className="mon-app" style={{ color: APP_COLOR }}>
        {app}
      </div>
      <div className="mon-graph">{graph}</div>
    </div>
  )
}

export function MonitorView({
  c,
  onDetectLeaks
}: {
  c: Controller
  onDetectLeaks: (serial: string, pkg: string) => void
}) {
  const [interval, setIntervalMs] = useState(1000)
  const [st, setSt] = useState<MonState>(() => initState(c.serial, c.appPkg))
  const pkgRef = useRef(c.appPkg)
  pkgRef.current = c.appPkg

  // Single sample subscription for the component's lifetime.
  useEffect(() => {
    const offSample = window.androidlab.monitor.onSample((s) =>
      setSt((prev) => applySample(prev, s, pkgRef.current))
    )
    const offFailed = window.androidlab.monitor.onFailed(() =>
      setSt((prev) => ({ ...prev, cpuSub: 'Could not read device stats' }))
    )
    return () => {
      offSample()
      offFailed()
      void window.androidlab.monitor.stop()
    }
  }, [])

  // (Re)start polling on device / app / interval change; reset the readouts.
  useEffect(() => {
    setSt(initState(c.serial, c.appPkg))
    if (c.serial) void window.androidlab.monitor.start(c.serial, c.appPkg, interval)
    else void window.androidlab.monitor.stop()
  }, [c.serial, c.appPkg, interval])

  return (
    <div className="mon-view">
      <div className="mon-head">
        <span className="mon-heading">Device Performance</span>
        <span className="grow" />
        <button
          disabled={!c.serial || !c.appPkg}
          title={
            !c.serial
              ? 'Select a device first'
              : !c.appPkg
                ? 'Pick an app (left) — its heap is captured and analyzed for leaks'
                : `Capture ${c.appPkg}'s heap and analyze it with LeakCanary/Shark (app must be debuggable)`
          }
          onClick={() => {
            if (c.serial && c.appPkg) onDetectLeaks(c.serial, c.appPkg)
          }}
        >
          <Icon name="search" size={15} />
          Detect leaks
        </button>
        <span className="label">Refresh</span>
        <select value={interval} onChange={(e) => setIntervalMs(Number(e.target.value))}>
          {INTERVALS.map(([label, ms]) => (
            <option key={ms} value={ms}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="mon-cards">
        <Card
          name="CPU"
          value={st.cpuValue}
          sub={st.cpuSub}
          app={st.cpuApp}
          graph={
            <SparkGraph values={st.cpuHist} appValues={st.cpuAppHist} color={PALETTE.ACCENT} appColor={APP_COLOR} />
          }
        />
        <Card
          name="Memory"
          value={st.memValue}
          sub={st.memSub}
          app={st.memApp}
          graph={
            <SparkGraph values={st.memHist} appValues={st.memAppHist} color={PALETTE.GREEN} appColor={APP_COLOR} />
          }
        />
        <Card
          name="Battery"
          value={st.batValue}
          sub={st.batSub}
          app=""
          graph={<SparkGraph values={st.batHist} appValues={[]} color={PALETTE.GREEN_H} appColor={APP_COLOR} />}
        />
        <Card
          name="UI Rendering (jank)"
          value={st.gfxValue}
          sub={st.gfxSub}
          app=""
          graph={<SparkGraph values={st.gfxHist} appValues={[]} color={PALETTE.RED} appColor={APP_COLOR} />}
        />
        <div className="mon-card span2">
          <div className="mon-caption">PER-CORE CPU</div>
          <div className="mon-graph">
            <CoreBars values={st.cores} />
          </div>
        </div>
      </div>
    </div>
  )
}
