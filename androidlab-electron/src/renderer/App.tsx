/**
 * MainWindow shell — the QMainWindow of ui.py rebuilt in React: device toolbar,
 * tab bar, the Logs tab (app panel | filter bar + log table + detail pane),
 * status bar, and the About / message / prompt / context-menu surfaces. Phase 2
 * implements the Logs tab in full; the remaining tabs are migrated in Phase 3.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Toolbar } from './components/Toolbar'
import { TabBar, type TabDef } from './components/TabBar'
import { FilterBar } from './components/FilterBar'
import { AppPickerPanel } from './components/AppPickerPanel'
import { LogWorkArea } from './components/LogWorkArea'
import { MonitorView } from './components/MonitorView'
import { DeviceInfoView } from './components/DeviceInfoView'
import { LeakReportModal } from './components/LeakReportModal'
import { IosInputSettingsModal } from './components/IosInputSettingsModal'
import { InspectorView } from './components/InspectorView'
import { ControlsView } from './components/ControlsView'
import { LocationView } from './components/LocationView'
import { ToolboxView } from './components/ToolboxView'
import { ShellView } from './components/ShellView'
import { DatabaseView } from './components/DatabaseView'
import { FilesView } from './components/FilesView'
import { AppManagerView } from './components/AppManagerView'
import { IosAppsView } from './components/IosAppsView'
import { NetworkView } from './components/NetworkView'
import { tabSupported } from '@shared/capabilities'
import { MirrorDock } from './components/MirrorDock'
import { IosMirrorDock } from './components/IosMirrorDock'
import { NoDeviceView } from './components/NoDeviceView'
import { StatusBar } from './components/StatusBar'
import { AboutDialog } from './components/AboutDialog'
import { MessageBox, PromptDialog, Toast, type MessageBoxSpec } from './components/dialogs'
import { useAppController } from './state/useAppController'
import { useTheme } from './state/useTheme'

const TABS: TabDef[] = [
  { id: 'deviceinfo', label: 'Device Info' },
  { id: 'logs', label: 'Logs' },
  { id: 'location', label: 'Location' },
  { id: 'network', label: 'Network HTTP' },
  { id: 'databases', label: 'Databases' },
  { id: 'files', label: 'Files' },
  { id: 'apps', label: 'Apps' },
  { id: 'monitor', label: 'Monitor' },
  { id: 'inspector', label: 'Inspector' },
  { id: 'controls', label: 'Controls' },
  { id: 'toolbox', label: 'Toolbox' },
  { id: 'shell', label: 'Shell' }
]

interface ContextMenuState {
  x: number
  y: number
  row: number
}

export default function App() {
  const c = useAppController()
  const { theme, toggleTheme } = useTheme()

  const [tab, setTab] = useState('logs')
  const [selectedRows, setSelectedRows] = useState<ReadonlySet<number>>(new Set())
  const [detailText, setDetailText] = useState('')
  const [anchor, setAnchor] = useState<number | null>(null)
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)
  const [about, setAbout] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  const [msgBox, setMsgBox] = useState<MessageBoxSpec | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [panelWidth, setPanelWidth] = useState(240)
  const [appsBadge, setAppsBadge] = useState(false)
  // Mirror lives in one of three states: closed, docked (in-app right dock), or
  // popped (a separate OS window, Android Studio-style). Closing the popout
  // window re-docks it (mirrorMode → 'docked').
  const [mirrorMode, setMirrorMode] = useState<'closed' | 'docked' | 'popped'>('closed')
  const mirrorModeRef = useRef(mirrorMode)
  mirrorModeRef.current = mirrorMode
  // Standalone AirPlay receiver: when on, the docked mirror is the receiver (any phone
  // on the network can mirror to "AndroidLab"), independent of the selected device.
  const [airplayReceiver, setAirplayReceiver] = useState(false)
  const airplayReceiverRef = useRef(airplayReceiver)
  airplayReceiverRef.current = airplayReceiver
  const [mirrorWidth, setMirrorWidth] = useState(360)
  const [secondaryReq, setSecondaryReq] = useState(0)
  const [leakReq, setLeakReq] = useState<{ serial: string; pkg: string } | null>(null)
  const [iosInputOpen, setIosInputOpen] = useState(false)

  const searchRef = useRef<HTMLInputElement>(null)
  const selectionRef = useRef<ReadonlySet<number>>(selectedRows)
  selectionRef.current = selectedRows
  // Drag-select state: the anchor row and whether the mouse is currently
  // dragging a range. Kept in refs so the row handlers stay stable and read the
  // live values mid-drag without re-subscribing.
  const anchorRef = useRef<number | null>(anchor)
  anchorRef.current = anchor
  const draggingRef = useRef(false)

  const showToast = useCallback((message: string) => {
    setToast(message)
  }, [])
  useEffect(() => {
    if (toast === null) return
    const id = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(id)
  }, [toast])

  // Outer "Apps ●" badge: set on a live crash when the Apps tab isn't showing,
  // cleared on switching to it (mirrors ui.py _flag_live_crash + the reset).
  useEffect(() => {
    if (c.liveCrashSeq === 0) return
    if (tab !== 'apps') setAppsBadge(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.liveCrashSeq])
  useEffect(() => {
    if (tab === 'apps') setAppsBadge(false)
  }, [tab])

  // Hide tabs the selected device's platform can't do (iOS has no adb `shell`,
  // so most tabs are Android-only). If the current tab becomes unsupported —
  // e.g. switching to an iPhone while on Logs — fall back to the first supported.
  useEffect(() => {
    if (!tabSupported(tab, c.platform)) {
      const first = TABS.find((t) => tabSupported(t.id, c.platform))
      if (first) setTab(first.id)
    }
  }, [c.platform, tab])

  // Selection resets when the filtered view is rebuilt (filter/app change),
  // mirroring beginResetModel clearing the QTableView selection.
  useEffect(() => {
    setSelectedRows(new Set())
    setAnchor(null)
    setDetailText('')
  }, [c.filter, c.appPkg])

  // --- selection ---------------------------------------------------------
  const setDetailForRow = useCallback(
    (row: number) => {
      const e = c.store.entryAt(row)
      setDetailText(e ? e.raw : '')
    },
    [c.store]
  )

  const selectRange = useCallback((a: number, b: number) => {
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const next = new Set<number>()
    for (let i = lo; i <= hi; i++) next.add(i)
    setSelectedRows(next)
  }, [])

  const onRowMouseDown = useCallback(
    (row: number, ev: React.MouseEvent) => {
      if (ev.button === 2) {
        if (!selectionRef.current.has(row)) {
          setSelectedRows(new Set([row]))
          setAnchor(row)
          anchorRef.current = row
          setDetailForRow(row)
        }
        return
      }
      if (ev.button !== 0) return
      if (ev.shiftKey && anchorRef.current !== null) {
        selectRange(anchorRef.current, row)
      } else if (ev.metaKey || ev.ctrlKey) {
        const next = new Set(selectionRef.current)
        if (next.has(row)) next.delete(row)
        else next.add(row)
        setSelectedRows(next)
        setAnchor(row)
        anchorRef.current = row
      } else {
        // Plain press: select this row and arm a drag so moving over adjacent
        // rows extends the range (ended by the window mouseup listener).
        ev.preventDefault()
        setSelectedRows(new Set([row]))
        setAnchor(row)
        anchorRef.current = row
        draggingRef.current = true
      }
      setDetailForRow(row)
    },
    [selectRange, setDetailForRow]
  )

  const onRowMouseEnter = useCallback(
    (row: number) => {
      if (!draggingRef.current || anchorRef.current === null) return
      selectRange(anchorRef.current, row)
      setDetailForRow(row)
    },
    [selectRange, setDetailForRow]
  )

  // End any drag-select on mouse release anywhere in the window.
  useEffect(() => {
    const end = () => {
      draggingRef.current = false
    }
    window.addEventListener('mouseup', end)
    return () => window.removeEventListener('mouseup', end)
  }, [])

  const onRowContextMenu = useCallback((row: number, ev: React.MouseEvent) => {
    ev.preventDefault()
    setCtxMenu({ x: ev.clientX, y: ev.clientY, row })
  }, [])

  const copySelection = useCallback(() => {
    const rows = [...selectionRef.current].sort((a, b) => a - b)
    if (rows.length === 0) return
    const out = rows
      .map((r) => {
        const e = c.store.entryAt(r)
        return e ? e.raw || `${e.time} ${e.pid} ${e.tid} ${e.level} ${e.tag}: ${e.msg}` : ''
      })
      .join('\n')
    void navigator.clipboard.writeText(out)
    showToast(`Copied ${rows.length} line${rows.length !== 1 ? 's' : ''}`)
  }, [c.store, showToast])

  // Route Cmd+C / Edit▸Copy through the DOM copy event when rows are selected
  // and focus isn't in a text field (mirrors LogTable.copy_selection).
  useEffect(() => {
    const handler = (ev: ClipboardEvent) => {
      const ae = document.activeElement
      const inField = ae instanceof HTMLInputElement || ae instanceof HTMLTextAreaElement
      if (inField || selectionRef.current.size === 0) return
      const rows = [...selectionRef.current].sort((a, b) => a - b)
      const out = rows
        .map((r) => {
          const e = c.store.entryAt(r)
          return e ? e.raw || `${e.time} ${e.pid} ${e.tid} ${e.level} ${e.tag}: ${e.msg}` : ''
        })
        .join('\n')
      ev.clipboardData?.setData('text/plain', out)
      ev.preventDefault()
    }
    document.addEventListener('copy', handler)
    return () => document.removeEventListener('copy', handler)
  }, [c.store])

  // --- force-crash (context menu) ----------------------------------------
  const doForceCrash = useCallback(
    async (pkg: string, pids: number[]) => {
      const notes = await c.forceCrash(pkg, pids)
      const who = pkg || (pids.length ? `pid ${Math.min(...pids)}` : 'app')
      showToast(
        notes.length
          ? `Force-crashed ${who}: ${notes.join(', ')}`
          : `Force-crash ${who}: nothing ran (needs root for clones, or not running)`
      )
    },
    [c, showToast]
  )

  // --- file IO / install -------------------------------------------------
  const doOpenLog = useCallback(async () => {
    const msg = await c.openLogFile()
    if (msg) showToast(msg)
  }, [c, showToast])

  const doExport = useCallback(
    async (filtered: boolean) => {
      const r = await c.exportLog(filtered)
      if (r === null) {
        showToast('Nothing to export')
        return
      }
      if (r.ok) setMsgBox({ title: 'Log exported', body: `✓  ${r.message}`, dir: r.dir })
      else if (r.message !== 'cancelled') showToast(`✗ ${r.message}`)
    },
    [c, showToast]
  )

  const doSavePreset = useCallback(() => setPromptOpen(true), [])

  // --- native menu actions ----------------------------------------------
  useEffect(() => {
    return window.androidlab.menu.onAction((action) => {
      switch (action) {
        case 'open-log':
          void doOpenLog()
          break
        case 'export-filtered':
          void doExport(true)
          break
        case 'export-entire':
          void doExport(false)
          break
        case 'about':
          setAbout(true)
          break
        case 'clear-log':
          c.clearLog()
          break
        case 'find':
          setTab('logs')
          searchRef.current?.focus()
          break
      }
    })
  }, [doOpenLog, doExport, c])

  // --- font zoom shortcuts (Cmd+= / Cmd++ / Cmd+-) -----------------------
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.metaKey || ev.ctrlKey)) return
      if (ev.key === '=' || ev.key === '+') {
        c.bumpFont(+1)
        ev.preventDefault()
      } else if (ev.key === '-') {
        c.bumpFont(-1)
        ev.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [c])

  // --- app-panel splitter drag ------------------------------------------
  const onSplitterDown = useCallback((ev: React.MouseEvent) => {
    ev.preventDefault()
    const startX = ev.clientX
    const startW = panelWidthRef.current
    const move = (e: MouseEvent) => {
      const w = Math.max(150, Math.min(500, startW + (e.clientX - startX)))
      setPanelWidth(w)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])
  const panelWidthRef = useRef(panelWidth)
  panelWidthRef.current = panelWidth

  // --- mirror dock splitter drag (left edge; drag left grows the dock) ----
  const mirrorWidthRef = useRef(mirrorWidth)
  mirrorWidthRef.current = mirrorWidth
  const onMirrorSplitterDown = useCallback((ev: React.MouseEvent) => {
    ev.preventDefault()
    const startX = ev.clientX
    const startW = mirrorWidthRef.current
    const move = (e: MouseEvent) => {
      const w = Math.max(240, Math.min(900, startW - (e.clientX - startX)))
      setMirrorWidth(w)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  // --- mirror open / dock / pop-out -------------------------------------
  // Toolbar button: closed → docked; anything open → fully closed (also closes
  // the popout window, no re-dock).
  const toggleMirror = useCallback(() => {
    // If the receiver is currently occupying the dock, switch it to the device mirror
    // (keep it open) rather than closing.
    if (airplayReceiverRef.current) {
      setAirplayReceiver(false)
      setMirrorMode('docked')
      return
    }
    if (mirrorModeRef.current === 'closed') {
      setMirrorMode('docked')
    } else {
      if (mirrorModeRef.current === 'popped') void window.androidlab.mirror.closePopout(false)
      setMirrorMode('closed')
    }
  }, [])

  // Top-bar AirPlay button: toggle the standalone receiver. Opening shows the docked
  // receiver (waiting for a phone to pick "AndroidLab"); closing tears it down.
  const toggleAirplayReceiver = useCallback(() => {
    if (airplayReceiverRef.current) {
      setAirplayReceiver(false)
      setMirrorMode('closed')
    } else {
      // Taking over the dock from a device mirror popout: close that window first.
      if (mirrorModeRef.current === 'popped') void window.androidlab.mirror.closePopout(false)
      setAirplayReceiver(true)
      setMirrorMode('docked')
    }
  }, [])

  // Detach the docked mirror into its own OS window (Android Studio-style).
  const popOutMirror = useCallback(() => {
    void window.androidlab.mirror.openPopout({ serial: c.serial, platform: c.platform, connection: c.connection })
    setMirrorMode('popped')
  }, [c.serial, c.platform, c.connection])

  // The popout window was closed (native X or its dock-back button) → re-dock.
  useEffect(() => window.androidlab.mirror.onPopoutClosed(() => setMirrorMode('docked')), [])

  // A genuine close must stop the feed at once. The dock's own unmount defers teardown
  // briefly (so a dock<->popout hand-off can cancel it), but closing never goes through
  // a hand-off — so tear the capture down immediately here for both platforms.
  useEffect(() => {
    if (mirrorMode === 'closed') {
      void window.androidlab.iosMirror.stop(true)
      void window.androidlab.mirror.stop(true)
    }
  }, [mirrorMode])

  // Keep the popout tracking the currently-selected device.
  useEffect(() => {
    if (mirrorMode === 'popped') {
      void window.androidlab.mirror.updatePopout({ serial: c.serial, platform: c.platform, connection: c.connection })
    }
  }, [mirrorMode, c.serial, c.platform, c.connection])

  // Context-menu target computation (mirrors _show_table_menu).
  const ctxTarget = (() => {
    if (!ctxMenu) return null
    const pkg = c.appPkg ?? ''
    const pids = c.appPids ? [...c.appPids] : []
    const rowEntry = c.store.entryAt(ctxMenu.row)
    const rowPid = rowEntry?.pid ?? 0
    if (pkg) {
      return {
        label: `Force-crash  ${pkg}${pids.length ? `  (${pids.length} pid)` : '  (not running)'}`,
        run: () => void doForceCrash(pkg, pids)
      }
    }
    if (rowPid) {
      return { label: `Force-crash  pid ${rowPid}`, run: () => void doForceCrash('', [rowPid]) }
    }
    return null
  })()

  return (
    <div className="app">
      <Toolbar
        c={c}
        onAbout={() => setAbout(true)}
        onMirror={toggleMirror}
        onAirplayReceiver={toggleAirplayReceiver}
        onIosInput={() => setIosInputOpen(true)}
        mirrorOpen={mirrorMode !== 'closed'}
        airplayReceiverOn={airplayReceiver}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
      {c.devices.length > 0 ? (
        <TabBar
          tabs={TABS.filter((t) => tabSupported(t.id, c.platform)).map((t) =>
            t.id === 'apps' ? { ...t, badge: appsBadge } : t
          )}
          current={tab}
          onSelect={setTab}
        />
      ) : null}

      <div className="main-row">
      <div className="main-content">
      {c.devices.length === 0 ? (
        <NoDeviceView c={c} airplayOn={airplayReceiver} onAirplay={toggleAirplayReceiver} />
      ) : tab === 'deviceinfo' ? (
        <DeviceInfoView c={c} />
      ) : tab === 'logs' ? (
        <div className="logs-tab">
          {/* iOS syslog is device-wide and can't be filtered by app (no
              bundle→PID like adb), so the app-picker filter is Android-only. */}
          {c.platform !== 'ios' ? (
            <>
              <AppPickerPanel c={c} width={panelWidth} />
              <div className="splitter" onMouseDown={onSplitterDown} />
            </>
          ) : null}
          <div className="logs-right">
            <FilterBar c={c} searchRef={searchRef} onSavePreset={doSavePreset} />
            <LogWorkArea
              c={c}
              selectedRows={selectedRows}
              onRowMouseDown={onRowMouseDown}
              onRowMouseEnter={onRowMouseEnter}
              onRowContextMenu={onRowContextMenu}
              onOpenLog={() => void doOpenLog()}
            />
            <div className="detail">{detailText}</div>
          </div>
        </div>
      ) : tab === 'monitor' ? (
        <div className="logs-tab">
          {c.platform !== 'ios' ? (
            <>
              <AppPickerPanel c={c} width={panelWidth} />
              <div className="splitter" onMouseDown={onSplitterDown} />
            </>
          ) : null}
          <MonitorView c={c} onDetectLeaks={(serial, pkg) => setLeakReq({ serial, pkg })} />
        </div>
      ) : tab === 'databases' ? (
        <div className="logs-tab">
          <AppPickerPanel c={c} width={panelWidth} />
          <div className="splitter" onMouseDown={onSplitterDown} />
          <DatabaseView c={c} />
        </div>
      ) : tab === 'files' ? (
        <div className="logs-tab">
          <AppPickerPanel c={c} width={panelWidth} />
          <div className="splitter" onMouseDown={onSplitterDown} />
          <FilesView c={c} />
        </div>
      ) : tab === 'apps' ? (
        c.platform === 'ios' ? (
          <IosAppsView c={c} onStatus={showToast} onMessage={setMsgBox} />
        ) : (
          <AppManagerView
            c={c}
            onStatus={showToast}
            onFailed={(m) => setMsgBox({ title: 'App Manager', body: m })}
            onMessage={setMsgBox}
          />
        )
      ) : tab === 'inspector' ? (
        <InspectorView c={c} />
      ) : tab === 'controls' ? (
        <ControlsView
          c={c}
          onViewSecondary={() => {
            // The secondary-display view lives in the in-app dock; re-dock first
            // if the mirror is currently popped out into its own window.
            if (mirrorModeRef.current === 'popped') void window.androidlab.mirror.closePopout(false)
            setMirrorMode('docked')
            setSecondaryReq((n) => n + 1)
          }}
        />
      ) : tab === 'location' ? (
        <LocationView c={c} />
      ) : tab === 'toolbox' ? (
        <ToolboxView c={c} />
      ) : tab === 'shell' ? (
        <ShellView c={c} />
      ) : tab === 'network' ? (
        <NetworkView c={c} />
      ) : (
        <div className="tab-placeholder">
          <div className="big">{TABS.find((t) => t.id === tab)?.label}</div>
          <div>This tool is migrated in Phase 3 of the AndroidLab → Electron port.</div>
        </div>
      )}
      </div>
      {mirrorMode === 'docked' ? (
        <>
          <div className="mirror-splitter" onMouseDown={onMirrorSplitterDown} />
          <div className="mirror-dock-holder" style={{ width: mirrorWidth, display: 'flex' }}>
            {airplayReceiver ? (
              <IosMirrorDock
                receiver
                serial={null}
                onClose={() => {
                  setAirplayReceiver(false)
                  setMirrorMode('closed')
                }}
                onCaptured={(r) =>
                  r.ok
                    ? setMsgBox({ title: 'Capture saved', body: `✓  ${r.message}`, dir: r.dir })
                    : r.message !== 'cancelled'
                      ? showToast(`✗ ${r.message}`)
                      : undefined
                }
              />
            ) : c.platform === 'ios' ? (
              <IosMirrorDock
                serial={c.serial}
                connection={c.connection}
                onClose={() => setMirrorMode('closed')}
                onPopout={popOutMirror}
                onCaptured={(r) =>
                  r.ok
                    ? setMsgBox({ title: 'Capture saved', body: `✓  ${r.message}`, dir: r.dir })
                    : r.message !== 'cancelled'
                      ? showToast(`✗ ${r.message}`)
                      : undefined
                }
              />
            ) : (
              <MirrorDock
                serial={c.serial}
                install={c.install}
                secondaryReq={secondaryReq}
                onClose={() => setMirrorMode('closed')}
                onPopout={popOutMirror}
                onCaptured={(r) =>
                  r.ok
                    ? setMsgBox({ title: 'Capture saved', body: `✓  ${r.message}`, dir: r.dir })
                    : r.message !== 'cancelled'
                      ? showToast(`✗ ${r.message}`)
                      : undefined
                }
              />
            )}
          </div>
        </>
      ) : null}
      </div>

      <StatusBar c={c} />

      {ctxMenu ? (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 999 }}
            onMouseDown={() => setCtxMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setCtxMenu(null)
            }}
          />
          <div className="context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <div
              className={`item${selectedRows.size === 0 ? ' disabled' : ''}`}
              onClick={() => {
                if (selectedRows.size > 0) copySelection()
                setCtxMenu(null)
              }}
            >
              {selectedRows.size > 0
                ? `Copy ${selectedRows.size} line${selectedRows.size !== 1 ? 's' : ''}`
                : 'Copy'}
            </div>
            <div
              className="item"
              onClick={() => {
                c.clearLog()
                setCtxMenu(null)
              }}
            >
              Clear log
            </div>
            <div className="sep" />
            <div
              className={`item${ctxTarget ? '' : ' disabled'}`}
              onClick={() => {
                if (ctxTarget) ctxTarget.run()
                setCtxMenu(null)
              }}
            >
              {ctxTarget ? ctxTarget.label : 'Force-crash app'}
            </div>
          </div>
        </>
      ) : null}

      {leakReq ? (
        <LeakReportModal
          serial={leakReq.serial}
          pkg={leakReq.pkg}
          onClose={() => setLeakReq(null)}
          onSaved={(r) =>
            r.ok
              ? setMsgBox({ title: 'Leak report saved', body: `✓  ${r.message}`, dir: r.dir })
              : showToast(`✗ ${r.message}`)
          }
        />
      ) : null}

      {iosInputOpen ? (
        <IosInputSettingsModal serial={c.serial} isIos={c.platform === 'ios'} onClose={() => setIosInputOpen(false)} />
      ) : null}


      {about ? <AboutDialog onClose={() => setAbout(false)} /> : null}
      {msgBox ? <MessageBox spec={msgBox} onClose={() => setMsgBox(null)} /> : null}
      {promptOpen ? (
        <PromptDialog
          title="Save filter preset"
          label="Preset name:"
          initial={c.currentPreset}
          onCancel={() => setPromptOpen(false)}
          onSubmit={(name) => {
            setPromptOpen(false)
            void c.savePreset(name).then((ok) =>
              showToast(ok ? `✓ Preset saved: ${name}` : "✗ Couldn't write the presets file")
            )
          }}
        />
      ) : null}
      {toast ? <Toast message={toast} /> : null}
    </div>
  )
}
