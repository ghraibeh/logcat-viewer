/**
 * The application controller — a hook that reproduces MainWindow's data/stream/
 * filter/device/app/presets/IO logic from logcat_viewer/ui.py. UI-only ephemeral
 * state (selection, dialogs, context menu) lives in App.tsx; this owns the model.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseLine, type LogEntry } from '@core/parser'
import { FilterSpec } from '@core/filters'
import { PRIORITY } from '@core/priorities'
import { exportText, cleanPreset, type PresetValues } from '@core/logtools'
import type { AppEntry, Device, Platform, PresetMap, SaveResult, InstallResult } from '@shared/types'
import { platformOf } from '@shared/capabilities'
import { LogStore } from '@core/logStore'

const FLUSH_MS = 100
const FILTER_DEBOUNCE_MS = 150
const RATE_MS = 1000
const APP_PID_REFRESH_MS = 3000
const MAX_PENDING = 200_000
export const DEFAULT_FONT_PT = 12
export const FONT_MIN = 8
export const FONT_MAX = 30

export interface LevelOption {
  name: string
  priority: number
}
export const LEVEL_OPTIONS: LevelOption[] = [
  { name: 'All levels', priority: 0 },
  { name: 'Verbose', priority: PRIORITY.V },
  { name: 'Debug', priority: PRIORITY.D },
  { name: 'Info', priority: PRIORITY.I },
  { name: 'Warn', priority: PRIORITY.W },
  { name: 'Error', priority: PRIORITY.E },
  { name: 'Fatal', priority: PRIORITY.F }
]

export interface FilterFields {
  level: number // min priority; 0 = All levels
  text: string
  textRegex: boolean
  tag: string
  tagRegex: boolean
  pids: string
  exclude: string
  excludeRegex: boolean
}

const EMPTY_FILTER: FilterFields = {
  level: 0,
  text: '',
  textRegex: false,
  tag: '',
  tagRegex: false,
  pids: '',
  exclude: '',
  excludeRegex: false
}

export interface FieldErrors {
  tag: boolean
  pid: boolean
  text: boolean
  exclude: boolean
}

export function useAppController() {
  const store = useMemo(() => new LogStore(), [])

  const [adbPath, setAdbPath] = useState<string | null>(null)
  const [adbReady, setAdbReady] = useState(false)
  const [devices, setDevices] = useState<Device[]>([])
  const [serial, setSerialState] = useState<string | null>(null)
  const [apps, setApps] = useState<AppEntry[]>([])
  const [appPkg, setAppPkg] = useState<string | null>(null)
  const [appPids, setAppPids] = useState<ReadonlySet<number> | null>(null)

  const [streaming, setStreaming] = useState(false)
  const [paused, setPausedState] = useState(false)
  const [rate, setRate] = useState(0)
  const [dropped, setDropped] = useState(0)
  const [buffered, setBuffered] = useState(0)

  const [filter, setFilter] = useState<FilterFields>(EMPTY_FILTER)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({
    tag: false,
    pid: false,
    text: false,
    exclude: false
  })
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const [wrap, setWrapState] = useState(false)
  const [autoscroll, setAutoscroll] = useState(false)
  const [fontPt, setFontPt] = useState(DEFAULT_FONT_PT)

  const [presets, setPresets] = useState<PresetMap>({})
  const [currentPreset, setCurrentPreset] = useState<string>('')

  // Bumps each time the live stream shows a FATAL EXCEPTION / ANR line. The Apps
  // tab (outer ● badge), its Crashes sub-tab, and the crash view's debounced
  // rescan all react to this counter (mirrors ui.py's _flag_live_crash fan-out).
  const [liveCrashSeq, setLiveCrashSeq] = useState(0)

  // refs used inside timers / event handlers (avoid stale closures)
  const pendingRef = useRef<LogEntry[]>([])
  const recvSinceTickRef = useRef(0)
  const droppedRef = useRef(0)
  const pausedRef = useRef(false)
  const appPkgRef = useRef<string | null>(null)
  const appPidsRef = useRef<ReadonlySet<number> | null>(null)
  const serialRef = useRef<string | null>(null)
  // Mirror of `devices` for use inside stable callbacks (reloadApps) that must
  // know the current device's platform without re-subscribing.
  const devicesRef = useRef<Device[]>([])
  const filterRef = useRef<FilterFields>(EMPTY_FILTER)

  // Platform of the selected device — drives per-platform tab/feature gating.
  const platform = useMemo<Platform>(() => platformOf(devices, serial), [devices, serial])

  useEffect(() => {
    filterRef.current = filter
  }, [filter])
  useEffect(() => {
    appPkgRef.current = appPkg
  }, [appPkg])
  useEffect(() => {
    appPidsRef.current = appPids
  }, [appPids])
  useEffect(() => {
    serialRef.current = serial
  }, [serial])

  // --- filter application ------------------------------------------------
  const applyFilter = useCallback(() => {
    const f = filterRef.current
    const spec = new FilterSpec({
      minPriority: f.level,
      tagQuery: f.tag.trim(),
      tagRegex: f.tagRegex,
      pids: f.pids,
      packageName: appPkgRef.current ?? '',
      packagePids: appPidsRef.current,
      textQuery: f.text,
      textRegex: f.textRegex,
      excludeQuery: f.exclude,
      excludeRegex: f.excludeRegex
    }).compile()
    store.setFilter(spec)
    setFieldErrors({
      tag: spec.hasError('tag'),
      pid: spec.hasError('pid'),
      text: spec.hasError('text'),
      exclude: spec.hasError('exclude')
    })
  }, [store])

  const filterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleFilter = useCallback(() => {
    if (filterTimer.current) clearTimeout(filterTimer.current)
    filterTimer.current = setTimeout(applyFilter, FILTER_DEBOUNCE_MS)
  }, [applyFilter])

  // Debounced fields (typing) vs immediate fields (level/regex/app).
  const setFilterField = useCallback(
    <K extends keyof FilterFields>(key: K, value: FilterFields[K], immediate = false) => {
      setFilter((prev) => {
        const next = { ...prev, [key]: value }
        filterRef.current = next
        return next
      })
      if (immediate) applyFilter()
      else scheduleFilter()
    },
    [applyFilter, scheduleFilter]
  )

  const clearFilters = useCallback(() => {
    const next: FilterFields = { ...EMPTY_FILTER }
    filterRef.current = next
    setFilter(next)
    applyFilter()
  }, [applyFilter])

  const advancedHasHiddenActive =
    !advancedOpen && (filter.tag.trim() !== '' || filter.pids.trim() !== '' || filter.exclude.trim() !== '')

  // --- streaming pipeline (flush + rate timers) --------------------------
  useEffect(() => {
    const off = window.androidlab.logcat.onLines((lines) => {
      const pending = pendingRef.current
      let sawCrash = false
      for (const line of lines) {
        const e = parseLine(line)
        if (e !== null) {
          pending.push(e)
          // Cheap tag/msg test on already-parsed entries (mirrors ui.py's
          // FATAL EXCEPTION / ANR check that pings the crash view).
          if (
            (e.tag === 'AndroidRuntime' && e.msg.startsWith('FATAL EXCEPTION')) ||
            (e.tag === 'ActivityManager' && e.msg.startsWith('ANR in'))
          ) {
            sawCrash = true
          }
        }
      }
      if (sawCrash) setLiveCrashSeq((n) => n + 1)
      recvSinceTickRef.current += lines.length
      if (pending.length > MAX_PENDING) {
        droppedRef.current += pending.length - MAX_PENDING
        pending.splice(0, pending.length - MAX_PENDING)
      }
    })
    const offState = window.androidlab.logcat.onState((state) => {
      window.androidlab.logcat.running().then(setStreaming)
      if (state === 'stopped') {
        setPausedState(false)
        pausedRef.current = false
      }
    })
    const offErr = window.androidlab.logcat.onError(() => {
      /* surfaced by the caller via status if needed */
    })
    return () => {
      off()
      offState()
      offErr()
    }
  }, [])

  const flush = useCallback(() => {
    if (pausedRef.current || pendingRef.current.length === 0) return
    const batch = pendingRef.current
    pendingRef.current = []
    store.appendBatch(batch)
  }, [store])

  useEffect(() => {
    const flushId = setInterval(flush, FLUSH_MS)
    const rateId = setInterval(() => {
      setRate(recvSinceTickRef.current)
      recvSinceTickRef.current = 0
      setBuffered(pendingRef.current.length)
      if (droppedRef.current !== 0) setDropped(droppedRef.current)
    }, RATE_MS)
    return () => {
      clearInterval(flushId)
      clearInterval(rateId)
    }
  }, [flush])

  // --- devices / apps ----------------------------------------------------
  const reloadApps = useCallback(async () => {
    const s = serialRef.current
    // Clear immediately (before the async fetch) so a device switch never shows
    // the previous device's apps while the new list loads.
    setApps([])
    if (!s) return
    // iOS has no adb package list — populate the shared picker from go-ios so the
    // Databases/Files tabs (which follow c.appPkg) can select an app. User apps
    // only (dev-signed / file-sharing apps are the container-accessible ones).
    const dev = devicesRef.current.find((d) => d.serial === s)
    if (dev?.platform === 'ios') {
      const r = await window.androidlab.ios.listApps(s)
      setApps(
        r.ok ? r.apps.filter((a) => a.type === 'User').map((a) => ({ pkg: a.bundleId, clone: false, host: '' })) : []
      )
      return
    }
    const list = await window.androidlab.adb.listApps(s)
    setApps(list.apps)
  }, [])

  const resolvePids = useCallback(async (pkg: string): Promise<Set<number>> => {
    const s = serialRef.current
    if (!s || !pkg) return new Set()
    return new Set(await window.androidlab.adb.resolvePids(s, pkg))
  }, [])

  const selectApp = useCallback(
    async (pkg: string | null) => {
      const cleaned = pkg && pkg !== 'All apps' ? pkg : null
      if (!cleaned) {
        appPkgRef.current = null
        appPidsRef.current = null
        setAppPkg(null)
        setAppPids(null)
        applyFilter()
        return
      }
      // iOS: no adb PID resolution — just set the selected package (drives the
      // Databases/Files tabs + the Apps sub-tabs).
      const dev = devicesRef.current.find((d) => d.serial === serialRef.current)
      if (dev?.platform === 'ios') {
        appPkgRef.current = cleaned
        appPidsRef.current = null
        setAppPkg(cleaned)
        setAppPids(null)
        applyFilter()
        return
      }
      const switched = cleaned !== appPkgRef.current
      appPkgRef.current = cleaned
      setAppPkg(cleaned)
      const resolved = await resolvePids(cleaned)
      let next: ReadonlySet<number>
      if (switched || appPidsRef.current === null) next = resolved
      else if (resolved.size > 0) next = new Set([...appPidsRef.current, ...resolved])
      else next = appPidsRef.current
      appPidsRef.current = next
      setAppPids(next)
      applyFilter()
    },
    [applyFilter, resolvePids]
  )

  // Re-resolve the selected app's PIDs so a restart/launch is picked up (only
  // ever adds newly-seen PIDs; never drops known ones). Mirrors _refresh_app_pids.
  useEffect(() => {
    const id = setInterval(async () => {
      const pkg = appPkgRef.current
      if (!pkg) return
      const resolved = await resolvePids(pkg)
      if (resolved.size === 0) return
      const merged = appPidsRef.current === null ? resolved : new Set([...appPidsRef.current, ...resolved])
      const cur = appPidsRef.current
      const changed = cur === null || merged.size !== cur.size || [...merged].some((p) => !cur.has(p))
      if (changed) {
        appPidsRef.current = merged
        setAppPids(merged)
        applyFilter()
      }
    }, APP_PID_REFRESH_MS)
    return () => clearInterval(id)
  }, [applyFilter, resolvePids])

  // Reset the selected app (picker + DB/Files/Logs all follow c.appPkg) — it
  // belonged to the previous device.
  const clearAppSelection = useCallback(() => {
    appPkgRef.current = null
    appPidsRef.current = null
    setAppPkg(null)
    setAppPids(null)
    applyFilter()
  }, [applyFilter])

  const setSerial = useCallback(
    (s: string | null) => {
      serialRef.current = s
      setSerialState(s)
      clearAppSelection()
      void reloadApps()
    },
    [reloadApps, clearAppSelection]
  )

  const refreshDevices = useCallback(async () => {
    const list = await window.androidlab.adb.listDevices()
    setDevices(list)
    devicesRef.current = list
    const prior = serialRef.current
    let pick: string | null = null
    if (list.length > 0) {
      if (prior && list.some((d) => d.serial === prior)) pick = prior
      else pick = (list.find((d) => d.online) ?? list[0]).serial
    }
    if (pick !== prior) clearAppSelection()
    serialRef.current = pick
    setSerialState(pick)
    void reloadApps()
  }, [reloadApps, clearAppSelection])

  // --- init: adb path + devices + presets --------------------------------
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { path } = await window.androidlab.adb.find()
      if (cancelled) return
      setAdbPath(path)
      setAdbReady(true)
      if (path) await refreshDevices()
      const p = await window.androidlab.presets.load()
      if (!cancelled) setPresets(p)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- stream control ----------------------------------------------------
  const toggleStream = useCallback(async () => {
    const running = await window.androidlab.logcat.running()
    if (running) {
      await window.androidlab.logcat.stop()
    } else {
      const s = serialRef.current
      if (s) {
        await window.androidlab.logcat.start(s, false)
        if (apps.length === 0) void reloadApps()
      }
    }
  }, [apps.length, reloadApps])

  const setPaused = useCallback(
    (p: boolean) => {
      pausedRef.current = p
      setPausedState(p)
      if (!p) flush()
    },
    [flush]
  )

  const clearLog = useCallback(() => {
    store.clear()
    pendingRef.current = []
    droppedRef.current = 0
    setDropped(0)
    setBuffered(0)
  }, [store])

  // --- view controls -----------------------------------------------------
  const bumpFont = useCallback((delta: number) => {
    setFontPt((pt) => Math.max(FONT_MIN, Math.min(FONT_MAX, pt + delta)))
  }, [])
  const setWrap = useCallback((on: boolean) => setWrapState(on), [])

  // --- presets -----------------------------------------------------------
  const presetValues = useCallback((): PresetValues => {
    const f = filterRef.current
    return {
      min_priority: f.level,
      text: f.text,
      text_regex: f.textRegex,
      tag: f.tag,
      tag_regex: f.tagRegex,
      pids: f.pids,
      exclude: f.exclude,
      exclude_regex: f.excludeRegex
    }
  }, [])

  const applyPresetValues = useCallback(
    (v: PresetValues) => {
      const next: FilterFields = {
        level: typeof v.min_priority === 'number' ? v.min_priority : 0,
        text: String(v.text ?? ''),
        textRegex: Boolean(v.text_regex),
        tag: String(v.tag ?? ''),
        tagRegex: Boolean(v.tag_regex),
        pids: String(v.pids ?? ''),
        exclude: String(v.exclude ?? ''),
        excludeRegex: Boolean(v.exclude_regex)
      }
      filterRef.current = next
      setFilter(next)
      if (next.tag || next.pids || next.exclude) setAdvancedOpen(true)
      applyFilter()
    },
    [applyFilter]
  )

  const applyPreset = useCallback(
    (name: string) => {
      setCurrentPreset(name)
      if (name && presets[name]) applyPresetValues(cleanPreset(presets[name] as Record<string, unknown>))
    },
    [presets, applyPresetValues]
  )

  const savePreset = useCallback(
    async (name: string): Promise<boolean> => {
      const next = { ...presets, [name]: presetValues() }
      const ok = await window.androidlab.presets.save(next)
      if (ok) {
        setPresets(next)
        setCurrentPreset(name)
      }
      return ok
    },
    [presets, presetValues]
  )

  const deletePreset = useCallback(
    async (name: string) => {
      if (!name) return
      const next = { ...presets }
      delete next[name]
      await window.androidlab.presets.save(next)
      setPresets(next)
      setCurrentPreset('')
    },
    [presets]
  )

  // --- log file IO -------------------------------------------------------
  const openLogFile = useCallback(async (): Promise<string | null> => {
    const opened = await window.androidlab.logfile.open()
    if (!opened) return null
    await window.androidlab.logcat.stop()
    const lines = opened.content.split(/\r?\n/)
    const entries: LogEntry[] = []
    for (const l of lines) {
      const e = parseLine(l)
      if (e !== null) entries.push(e)
    }
    clearLog()
    store.appendBatch(entries)
    const base = opened.path.split('/').pop() ?? opened.path
    return `Loaded ${entries.length.toLocaleString()} lines from ${base} (${(lines.length - entries.length).toLocaleString()} non-log lines skipped)`
  }, [clearLog, store])

  const exportLog = useCallback(
    async (filtered: boolean): Promise<SaveResult | null> => {
      const entries = filtered ? store.visibleEntries() : store.allEntries()
      if (entries.length === 0) return null
      const text = exportText(entries)
      return await window.androidlab.logfile.export(filtered ? 'filtered' : 'full', text, entries.length)
    },
    [store]
  )

  // --- apk install / force-crash ----------------------------------------
  const install = useCallback(async (paths: string[]): Promise<InstallResult | null> => {
    const s = serialRef.current
    if (!s) return null
    const r = await window.androidlab.apk.install(s, paths)
    if (r.ok) void reloadApps()
    return r
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const forceCrash = useCallback(async (pkg: string, pids: number[]): Promise<string[]> => {
    const s = serialRef.current
    if (!s) return []
    return await window.androidlab.adb.forceCrash(s, pkg, pids)
  }, [])

  return {
    store,
    adbPath,
    adbReady,
    devices,
    serial,
    platform,
    setSerial,
    refreshDevices,
    apps,
    reloadApps,
    appPkg,
    appPids,
    selectApp,
    streaming,
    toggleStream,
    paused,
    setPaused,
    rate,
    dropped,
    buffered,
    clearLog,
    filter,
    setFilterField,
    clearFilters,
    fieldErrors,
    advancedOpen,
    setAdvancedOpen,
    advancedHasHiddenActive,
    wrap,
    setWrap,
    autoscroll,
    setAutoscroll,
    fontPt,
    bumpFont,
    presets,
    currentPreset,
    setCurrentPreset,
    applyPreset,
    savePreset,
    deletePreset,
    openLogFile,
    exportLog,
    install,
    forceCrash,
    liveCrashSeq
  }
}

export type Controller = ReturnType<typeof useAppController>
