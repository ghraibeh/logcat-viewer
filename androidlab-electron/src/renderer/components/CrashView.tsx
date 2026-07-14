/**
 * Crash & ANR viewer — port of crash.py's CrashView, embedded as the Apps ▸
 * Crashes sub-tab. Kind-filter chips + search + "This app" → grouped list ↔ a
 * rendered HTML trace (fold/unfold framework runs, Caused-by chain links,
 * app-frame highlight, obfuscation banner) with best-effort R8/ProGuard retrace
 * from a mapping.txt. Follows the app selected in the Apps list, and re-scans
 * (debounced) when a live crash pings in from the log stream.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildCrashHtml,
  groupCrashes,
  looksObfuscated,
  KIND_COLOR,
  KIND_GLYPH,
  type CrashGroup,
  type CrashItem
} from '@core/crash'
import { Icon } from './Icon'

interface CrashViewProps {
  serial: string | null
  pkg: string | null
  active: boolean
  liveCrashSeq: number
  onStatus: (msg: string) => void
  onFailed: (msg: string) => void
  onSaved: (ok: boolean, message: string, dir: string) => void
}

const base = (p: string): string => p.split(/[\\/]/).pop() ?? p

export function CrashView({ serial, pkg, active, liveCrashSeq, onStatus, onFailed, onSaved }: CrashViewProps) {
  const [items, setItems] = useState<CrashItem[]>([])
  const [scanned, setScanned] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [selectedSig, setSelectedSig] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [fCrash, setFCrash] = useState(true)
  const [fAnr, setFAnr] = useState(true)
  const [fOther, setFOther] = useState(true)
  const [appOnly, setAppOnly] = useState(false)
  const [search, setSearch] = useState('')
  const [retraceOn, setRetraceOn] = useState(false)
  const [mappingLoaded, setMappingLoaded] = useState(false)
  const [mappingLabel, setMappingLabel] = useState('')
  const [html, setHtml] = useState('')

  const scanningRef = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  const pendingScanRef = useRef(false)
  const autoMappingTriedRef = useRef(false)
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const detailRef = useRef<HTMLDivElement>(null)
  const keepScrollRef = useRef<number | null>(null)
  const displayTextRef = useRef('')

  const groups = useMemo(() => groupCrashes(items), [items])

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return groups.filter((g) => {
      const it = g.item
      if (it.kind === 'crash' && !fCrash) return false
      if (it.kind === 'anr' && !fAnr) return false
      if ((it.kind === 'native' || it.kind === 'wtf') && !fOther) return false
      if (appOnly && pkg && it.process.split(':')[0] !== pkg) return false
      if (needle && !`${it.process} ${it.title}`.toLowerCase().includes(needle)) return false
      return true
    })
  }, [groups, fCrash, fAnr, fOther, appOnly, pkg, search])

  const currentGroup: CrashGroup | undefined =
    shown.find((g) => g.sig === selectedSig) ?? (shown.length > 0 ? shown[0] : undefined)

  const scan = useCallback(async () => {
    if (!serial) {
      onFailed('Crashes: no device selected')
      return
    }
    if (scanningRef.current) {
      onStatus('A crash scan is already running…')
      return
    }
    scanningRef.current = true
    setScanning(true)
    const r = await window.androidlab.crash.scan(serial)
    scanningRef.current = false
    setScanning(false)
    if (!r.ok) {
      onFailed(`Crashes: ${r.message}`)
      return
    }
    setItems(r.items)
    setScanned(true)
    onStatus(`Crashes: ${r.message}, ${groupCrashes(r.items).length} unique`)
  }, [serial, onFailed, onStatus])

  const loadMapping = useCallback(
    async (path: string, announce: boolean) => {
      const r = await window.androidlab.crash.loadMapping(path)
      if (!r.ok || r.classCount === 0) {
        setMappingLabel('')
        if (announce) onFailed(`Couldn't read mapping: ${r.error || 'no class mappings found'}`)
        return
      }
      setMappingLoaded(true)
      setRetraceOn(true)
      setMappingLabel(`${base(r.path)} · ${r.classCount.toLocaleString()} classes`)
      if (announce) onStatus(`Mapping loaded: ${r.classCount.toLocaleString()} classes`)
    },
    [onFailed, onStatus]
  )

  // Clear the pending live-rescan timer on unmount.
  useEffect(() => () => {
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
  }, [])

  // Reset on device change.
  useEffect(() => {
    setItems([])
    setScanned(false)
    setSelectedSig(null)
    setHtml('')
  }, [serial])

  // Live-crash ping: debounced rescan when visible, deferred when hidden.
  useEffect(() => {
    if (liveCrashSeq === 0) return
    if (activeRef.current) {
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
      liveTimerRef.current = setTimeout(() => {
        if (!scanningRef.current) void scan()
      }, 1500)
    } else {
      pendingScanRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveCrashSeq])

  // On show: auto-load the remembered mapping once + run a deferred scan.
  useEffect(() => {
    if (!active) return
    if (!autoMappingTriedRef.current) {
      autoMappingTriedRef.current = true
      void (async () => {
        const last = await window.androidlab.crash.lastMappingPath()
        if (last) void loadMapping(last, false)
      })()
    }
    if (pendingScanRef.current) {
      pendingScanRef.current = false
      void scan()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Folds are per-record.
  useEffect(() => {
    setExpanded(new Set())
  }, [currentGroup?.sig])

  // Keep the current selection valid as filters change (else select the first).
  useEffect(() => {
    if (shown.length === 0) {
      if (selectedSig !== null) setSelectedSig(null)
    } else if (!shown.some((g) => g.sig === selectedSig)) {
      setSelectedSig(shown[0].sig)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown])

  // Render the selected record (retrace off the loaded mapping when toggled on).
  useEffect(() => {
    const g = currentGroup
    if (!g) {
      setHtml('')
      displayTextRef.current = ''
      return
    }
    let cancelled = false
    void (async () => {
      const it = g.item
      let text = it.plain || it.text
      const retraced = mappingLoaded && retraceOn
      if (retraced) text = await window.androidlab.crash.retrace(text)
      if (cancelled) return
      displayTextRef.current = text
      setHtml(
        buildCrashHtml(it, {
          text,
          appPkg: pkg,
          expanded,
          count: g.count,
          hintObfuscated: !retraced && looksObfuscated(text),
          retraced
        })
      )
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGroup, retraceOn, mappingLoaded, expanded, pkg])

  // Restore scroll after a fold toggle re-renders the trace.
  useEffect(() => {
    if (keepScrollRef.current !== null && detailRef.current) {
      detailRef.current.scrollTop = keepScrollRef.current
      keepScrollRef.current = null
    }
  }, [html])

  const onDetailClick = useCallback((e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    e.preventDefault()
    const href = a.getAttribute('href') ?? ''
    if (href.startsWith('fold:')) {
      const n = parseInt(href.slice(5), 10)
      if (Number.isNaN(n)) return
      keepScrollRef.current = detailRef.current?.scrollTop ?? 0
      setExpanded((prev) => {
        const s = new Set(prev)
        if (s.has(n)) s.delete(n)
        else s.add(n)
        return s
      })
    } else if (href.startsWith('#')) {
      detailRef.current?.querySelector(`[name="${href.slice(1)}"]`)?.scrollIntoView({ block: 'start' })
    }
  }, [])

  const pickMapping = useCallback(async () => {
    const path = await window.androidlab.crash.chooseMapping()
    if (path) void loadMapping(path, true)
  }, [loadMapping])

  const copyCurrent = useCallback(() => {
    const g = currentGroup
    if (!g) {
      onStatus('Select a crash record first')
      return
    }
    const it = g.item
    const head = `[${it.source}]  ${it.when}  ${it.process}  (${g.count} occurrence(s))`
    void navigator.clipboard.writeText(`${head}\n\n${displayTextRef.current}`)
    onStatus('✓ Trace copied to the clipboard')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGroup, onStatus])

  const saveCurrent = useCallback(async () => {
    const g = currentGroup
    if (!g) {
      onStatus('Select a crash record first')
      return
    }
    const it = g.item
    const head = `[${it.source}]  ${it.when}  ${it.process}  (${g.count} occurrence(s))`
    const stamp = it.when.replace(/:/g, '').replace(/ /g, '-').replace(/\./g, '-')
    const name = `crash-${(it.process || 'unknown').replace(/\//g, '_')}-${stamp}.txt`
    const r = await window.androidlab.crash.save(`${head}\n\n${displayTextRef.current}`, name)
    if (r.message !== 'cancelled') onSaved(r.ok, r.message, r.dir)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGroup, onSaved, onStatus])

  const total = shown.reduce((n, g) => n + g.count, 0)
  const detailBody = html.replace(/^<body[^>]*>/, '').replace(/<\/body>$/, '')

  return (
    <div className="crash-view">
      <div className="crash-bar">
        <div className="crash-row">
          <button disabled={scanning} title="Read the logcat crash buffer + dumpsys dropbox records" onClick={() => void scan()}>
            {scanning ? (
              'Scanning…'
            ) : (
              <>
                <Icon name="refresh" size={15} />
                Scan crashes
              </>
            )}
          </button>
          <button className={`toggle${fCrash ? ' checked' : ''}`} title="Show Java/Kotlin fatal exceptions" onClick={() => setFCrash((v) => !v)}>
            <Icon name="bug" size={14} />
            Crashes
          </button>
          <button className={`toggle${fAnr ? ' checked' : ''}`} title="Show Application-Not-Responding records" onClick={() => setFAnr((v) => !v)}>
            <Icon name="clock" size={14} />
            ANRs
          </button>
          <button className={`toggle${fOther ? ' checked' : ''}`} title="Show native crashes and Log.wtf records" onClick={() => setFOther((v) => !v)}>
            <Icon name="alertTriangle" size={14} />
            Other
          </button>
          <button
            className={`toggle${appOnly ? ' checked' : ''}`}
            disabled={!pkg}
            title={pkg ? `Only records from ${pkg}` : 'Only records from the app selected in the App box'}
            onClick={() => setAppOnly((v) => !v)}
          >
            This app
          </button>
          <input
            className="crash-search"
            type="text"
            placeholder="🔍  Filter crashes  (process or exception)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className="crash-count">{shown.length > 0 ? `${shown.length} unique · ${total} total` : ''}</span>
        </div>
        <div className="crash-row">
          <button title="Load an R8/ProGuard mapping file to de-obfuscate stack traces (remembered across sessions)" onClick={() => void pickMapping()}>
            Load mapping.txt…
          </button>
          <button
            className={`toggle${retraceOn ? ' checked' : ''}`}
            disabled={!mappingLoaded}
            title="Show the selected record de-obfuscated"
            onClick={() => setRetraceOn((v) => !v)}
          >
            Retrace
          </button>
          <span className="crash-mapping">{mappingLabel}</span>
          <span className="grow" />
          <button className="toggle" title="Copy the trace (as displayed) to the clipboard" onClick={copyCurrent}>
            Copy
          </button>
          <button className="toggle" title="Save the selected record (as displayed) to a text file" onClick={() => void saveCurrent()}>
            Save…
          </button>
        </div>
      </div>

      <div className="crash-split">
        <div className="crash-list">
          {shown.map((g) => {
            const it = g.item
            return (
              <div
                key={g.sig}
                className={`crash-item${g.sig === (currentGroup?.sig ?? null) ? ' selected' : ''}`}
                style={{ color: KIND_COLOR[it.kind] ?? KIND_COLOR.crash }}
                title={`${g.count} occurrence(s)\n${it.title}`}
                onClick={() => setSelectedSig(g.sig)}
              >
                <div className="crash-item-head">
                  {KIND_GLYPH[it.kind] ?? '💥'}  {it.process || '(unknown)'}
                  {g.count > 1 ? <span className="crash-x">  ×{g.count}</span> : null}
                </div>
                <div className="crash-item-title">{it.title.slice(0, 110)}</div>
                <div className="crash-item-meta">
                  {it.when}   ·   {it.source}
                </div>
              </div>
            )
          })}
        </div>

        {shown.length > 0 ? (
          <div className="crash-detail" ref={detailRef} onClick={onDetailClick} dangerouslySetInnerHTML={{ __html: detailBody }} />
        ) : (
          <div className="crash-detail crash-empty" ref={detailRef}>
            {groups.length > 0 ? (
              <div className="crash-empty-msg">No records match the current filters.</div>
            ) : scanned ? (
              <div className="crash-empty-msg">No crashes on this device — nothing in the crash buffer or dropbox. 🎉</div>
            ) : (
              <div className="crash-empty-msg">
                Hit <b>⟳ Scan crashes</b> to read the device&apos;s crash buffer and dropbox records.
                <br />
                <br />· Crashes group by exception — the <b>×N</b> badge counts repeats
                <br />· App frames are highlighted; framework runs fold out of the way
                <br />· Load a <b>mapping.txt</b> to retrace obfuscated release builds
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
