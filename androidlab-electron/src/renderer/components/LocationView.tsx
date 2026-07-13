/**
 * Location (mock GPS) — port of mocklocation.py's MockLocationView. A MapLibre
 * map (in an isolated <webview> guest with its own CSP) + coordinate controls to
 * pick and toggle a device-wide mock GPS location.
 *
 * The map guest is created when this view first mounts (the tab is conditionally
 * rendered, so that IS "lazy on first show", mirroring Qt's showEvent). Its load
 * failing is non-fatal — the coordinate controls work regardless (offline smoke
 * asserts the chrome mounts, not that tiles render).
 *
 * Bridge (faithful analogue of the Qt document.title bridge):
 *   guest -> host: page-title-updated carrying "MOCKLOC:lat,lng|seq" (picks) or
 *                  "MAPLOADED:ok|err" (map ready) — parsed by @core/mocklocation.
 *   host  -> guest: webview.executeJavaScript("setLocation(lat,lng,recenter)").
 *
 * Cleanup: mock GPS is device-wide, so it is NOT stopped on tab-switch/unmount
 * (it lives on the device); it IS stopped when the selected device changes (here)
 * and on app close (the main service's shutdown(), wired in main/ipc.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as M from '@core/mocklocation'
import type { WebviewElement } from '../webview'
import type { Controller } from '../state/useAppController'

export function LocationView({ c }: { c: Controller }) {
  const serial = c.serial

  const [latText, setLatText] = useState('')
  const [lngText, setLngText] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('Pick a location, then Enable Mock')
  const [presetSel, setPresetSel] = useState('')
  const [markMissing, setMarkMissing] = useState(false)

  // Mutable model used inside the once-registered webview listeners / timers.
  const latRef = useRef<number | null>(null)
  const lngRef = useRef<number | null>(null)
  const enabledRef = useRef(false)
  const serialRef = useRef<string | null>(serial)
  const mapLoadedRef = useRef(false)
  const readySerialsRef = useRef<Set<string>>(new Set())
  const sendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const missTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const webviewRef = useRef<WebviewElement | null>(null)

  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  const setStatusMsg = useCallback((text: string) => setStatus(text), [])

  // --- host -> guest -------------------------------------------------------
  const jsSetMarker = useCallback((lat: number, lng: number, recenter: boolean) => {
    const wv = webviewRef.current
    if (!wv || !mapLoadedRef.current) return
    void wv.executeJavaScript(`setLocation(${lat},${lng},${recenter ? 'true' : 'false'})`).catch(() => {
      /* guest not ready / navigating — non-fatal */
    })
  }, [])

  // --- coordinate plumbing -------------------------------------------------
  const storeCoords = useCallback((lat: number, lng: number, updateFields: boolean) => {
    latRef.current = lat
    lngRef.current = lng
    if (updateFields) {
      setLatText(M.fmtCoord(lat))
      setLngText(M.fmtCoord(lng))
    }
  }, [])

  const reflectMocking = useCallback(() => {
    if (latRef.current !== null && lngRef.current !== null) {
      setStatusMsg(`Mocking ${latRef.current.toFixed(5)}, ${lngRef.current.toFixed(5)}`)
    }
  }, [setStatusMsg])

  const sendSet = useCallback(() => {
    const s = serialRef.current
    if (!s || latRef.current === null || lngRef.current === null) return
    void window.androidlab.mockloc.set(s, latRef.current, lngRef.current, 5).then((r) => {
      if (!r.ok) setStatusMsg(`✗ ${r.message}`)
    })
    reflectMocking()
  }, [reflectMocking, setStatusMsg])

  // --- title bridge (guest -> host) ----------------------------------------
  // Keep the live handler in a ref so the once-registered listener never goes
  // stale (it reads current state via the refs above + the latest callbacks).
  const onTitle = useCallback(
    (title: string) => {
      const loaded = M.mapLoadedStatus(title)
      if (loaded !== null) {
        mapLoadedRef.current = loaded
        if (!loaded) {
          setStatusMsg('Map failed to load (needs internet for tiles)')
          return
        }
        // A coord chosen before the map finished loading — place it now.
        if (latRef.current !== null && lngRef.current !== null) {
          jsSetMarker(latRef.current, lngRef.current, true)
        }
        return
      }
      const pick = M.parseTitle(title)
      if (!pick) return
      storeCoords(pick.lat, pick.lng, true)
      if (enabledRef.current) {
        if (sendTimerRef.current) clearTimeout(sendTimerRef.current)
        sendTimerRef.current = setTimeout(sendSet, 250) // debounce live drags
        reflectMocking()
      }
    },
    [jsSetMarker, reflectMocking, sendSet, setStatusMsg, storeCoords]
  )
  const onTitleRef = useRef(onTitle)
  useEffect(() => {
    onTitleRef.current = onTitle
  }, [onTitle])

  // --- webview lifecycle (created on first mount = lazy first show) ---------
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const titleListener = (e: Event): void => {
      const t = (e as unknown as { title?: string }).title
      if (typeof t === 'string') onTitleRef.current(t)
    }
    const failListener = (): void => {
      setStatusMsg('Map failed to load (needs internet for tiles)')
    }
    wv.addEventListener('page-title-updated', titleListener)
    wv.addEventListener('did-fail-load', failListener)
    // Resolve map.html relative to the loaded renderer document — this yields
    // `${ELECTRON_RENDERER_URL}/map.html` in dev and `…/out/renderer/map.html`
    // (file://) in the packaged build, both without touching the main process.
    try {
      wv.src = new URL('map.html', window.location.href).toString()
    } catch {
      /* non-fatal */
    }
    return () => {
      wv.removeEventListener('page-title-updated', titleListener)
      wv.removeEventListener('did-fail-load', failListener)
      if (sendTimerRef.current) clearTimeout(sendTimerRef.current)
      if (missTimerRef.current) clearTimeout(missTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- set_serial (mirror MockLocationView.set_serial) ---------------------
  useEffect(() => {
    const prev = serialRef.current
    if (serial === prev) return
    // Stop mocking the OLD device before retargeting.
    if (enabledRef.current && prev) {
      void window.androidlab.mockloc.stop(prev)
      enabledRef.current = false
      setEnabled(false)
    }
    serialRef.current = serial
    setStatusMsg(serial ? 'Pick a location, then Enable Mock' : 'No device selected')
  }, [serial, setStatusMsg])

  // --- coordinate acquisition ----------------------------------------------
  /** True if we have a coordinate to mock — an existing pick, else the typed
   *  Lat/Lng (so typing + Enable works without pressing Go first). */
  const ensureCoords = useCallback((): boolean => {
    if (latRef.current !== null && lngRef.current !== null) return true
    const lat = M.parseCoordField(latText)
    const lng = M.parseCoordField(lngText)
    if (lat === null || lng === null || !M.validCoord(lat, lng)) return false
    storeCoords(lat, lng, false)
    jsSetMarker(lat, lng, true)
    return true
  }, [latText, lngText, jsSetMarker, storeCoords])

  const flashMissing = useCallback(() => {
    setMarkMissing(true)
    if (missTimerRef.current) clearTimeout(missTimerRef.current)
    missTimerRef.current = setTimeout(() => setMarkMissing(false), 1500)
  }, [])

  // --- enable / disable ----------------------------------------------------
  const startMock = useCallback(() => {
    enabledRef.current = true
    setEnabled(true)
    sendSet()
    reflectMocking()
  }, [sendSet, reflectMocking])

  const beginEnable = useCallback(async () => {
    const s = serialRef.current
    if (!s) return
    if (readySerialsRef.current.has(s)) {
      startMock()
      return
    }
    setBusy(true)
    setStatusMsg('Installing helper…')
    const r = await window.androidlab.mockloc.setup(s)
    setBusy(false)
    if (r.ok) {
      readySerialsRef.current.add(s)
      startMock()
    } else {
      setStatusMsg(`✗ ${r.message}`)
    }
  }, [startMock, setStatusMsg])

  const doDisable = useCallback(() => {
    const was = enabledRef.current
    enabledRef.current = false
    setEnabled(false)
    const s = serialRef.current
    if (was && s) void window.androidlab.mockloc.stop(s)
    // The helper removes the override and reacquires a real fix, so the device
    // snaps back to its real location (given any GPS/network signal).
    setStatusMsg('Mock off — restoring real location…')
  }, [setStatusMsg])

  const onToggle = useCallback(() => {
    if (enabledRef.current) {
      doDisable()
      return
    }
    if (!ensureCoords()) {
      setStatusMsg('Enter a Lat/Lng or click the map first')
      flashMissing()
      return
    }
    if (!serialRef.current) {
      setStatusMsg('No device selected')
      return
    }
    void beginEnable()
  }, [doDisable, ensureCoords, beginEnable, flashMissing, setStatusMsg])

  // --- Go / presets / Enter ------------------------------------------------
  const applyFields = useCallback(() => {
    const lat = M.parseCoordField(latText)
    const lng = M.parseCoordField(lngText)
    if (lat === null || lng === null) {
      setStatusMsg('Enter a valid latitude and longitude')
      return
    }
    if (!M.validCoord(lat, lng)) {
      setStatusMsg('Latitude ±90, longitude ±180')
      return
    }
    storeCoords(lat, lng, false)
    jsSetMarker(lat, lng, true)
    if (enabledRef.current) sendSet()
    else setStatusMsg(`Selected ${lat.toFixed(5)}, ${lng.toFixed(5)}`)
  }, [latText, lngText, jsSetMarker, sendSet, storeCoords, setStatusMsg])

  const onPreset = useCallback(
    (name: string) => {
      const p = M.PRESETS.find((x) => x.name === name)
      setPresetSel('')
      if (!p) return
      storeCoords(p.lat, p.lng, true)
      jsSetMarker(p.lat, p.lng, true)
      if (enabledRef.current) sendSet()
    },
    [jsSetMarker, sendSet, storeCoords]
  )

  const noDevice = !serial
  const latEmpty = markMissing && latText.trim() === ''
  const lngEmpty = markMissing && lngText.trim() === ''

  return (
    <div className="loc-view">
      <div className="loc-map">
        <webview ref={webviewRef} className="loc-webview" partition="persist:mockloc-map" />
        {!mapLoadedRef.current ? <div className="loc-map-msg">Opening map…</div> : null}
      </div>

      <div className="loc-bar">
        <button
          className={`start${enabled ? ' running' : ''}`}
          disabled={busy}
          title="Install the helper (if needed) and start mocking the chosen location"
          onClick={onToggle}
        >
          {enabled ? 'Disable Mock' : busy ? 'Installing…' : 'Enable Mock'}
        </button>
        <span className="loc-gap" />

        <label className="loc-label">Lat</label>
        <input
          className={`line-edit loc-input${latEmpty ? ' error' : ''}`}
          value={latText}
          placeholder="37.7749"
          onChange={(e) => setLatText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyFields()
          }}
        />
        <label className="loc-label">Lng</label>
        <input
          className={`line-edit loc-input${lngEmpty ? ' error' : ''}`}
          value={lngText}
          placeholder="-122.4194"
          onChange={(e) => setLngText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyFields()
          }}
        />
        <button className="toggle" title="Move the pin to the typed coordinate" onClick={applyFields}>
          Go
        </button>
        <span className="loc-gap" />

        <select
          className="loc-preset"
          value={presetSel}
          onChange={(e) => onPreset(e.target.value)}
          title="Jump to a preset location"
        >
          <option value="">Presets…</option>
          {M.PRESETS.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>

        <span className="loc-stretch" />
        <span className={`loc-status${noDevice ? ' dim' : ''}`}>{status}</span>
      </div>
    </div>
  )
}
