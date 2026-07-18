/**
 * iOS Apps tab (go-ios backend). Shown in place of AppManagerView when the
 * selected device is an iPhone/iPad. It surfaces only what go-ios can do over
 * plain usbmux/lockdown — list apps, install a signed .ipa, uninstall — and
 * deliberately omits the Android-only capabilities (force-stop, clear data,
 * permission/component/app-op editing) that have no iOS equivalent.
 *
 * The Info panel reuses the App Manager's `am-*` layout so the two platforms
 * feel like one tool, and adds an iOS-native "declared privacy usage" section
 * (the app's NS*UsageDescription Info.plist strings) in place of Android's
 * runtime permissions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Controller } from '../state/useAppController'
import type { MessageBoxSpec } from './dialogs'
import { IOS_INFO_ROWS, type IosAppInfo } from '@core/goios'
import { AppIcon } from './AppIcon'
import { Icon } from './Icon'
import { CrashView } from './CrashView'
import { PrefsView } from './PrefsView'
import { FilesView } from './FilesView'
import { DatabaseView } from './DatabaseView'

type FilterKind = 'user' | 'system' | 'all'

interface Props {
  c: Controller
  onStatus: (message: string) => void
  onMessage: (spec: MessageBoxSpec) => void
}

type ViewMode = 'list' | 'grid'

// Session-lived icon cache keyed by `${serial}::${bundleId}`, shared across every
// mount of this view. It survives tab switches / remounts and the main process
// also caches icons on disk, so an icon is fetched from the device at most once
// and never re-loaded on a manual refresh. Only a device unplug/replug (which
// changes serial keys) or an app relaunch clears it.
const ICON_CACHE = new Map<string, string | null>()
const iconKey = (serial: string, bundleId: string): string => `${serial}::${bundleId}`

/** One app entry, rendered as a list row or a grid tile. Either way it registers
 *  itself with the parent's lazy-icon pool so its real home-screen icon is
 *  fetched only once it scrolls into view. */
function IosAppRow({
  app,
  selected,
  icon,
  mode,
  register,
  onPick
}: {
  app: IosAppInfo
  selected: boolean
  icon: string | null | undefined
  mode: ViewMode
  register: (el: HTMLElement | null, bundleId: string) => () => void
  onPick: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => register(ref.current, app.bundleId), [register, app.bundleId])
  const size = mode === 'grid' ? 52 : 30
  const iconEl = icon ? (
    <img className="am-item-icon" src={icon} alt="" width={size} height={size} />
  ) : (
    <AppIcon pkg={app.bundleId} size={size} />
  )
  if (mode === 'grid') {
    return (
      <div
        ref={ref}
        className={`am-tile${selected ? ' selected' : ''}`}
        onClick={onPick}
        title={app.bundleId}
      >
        {iconEl}
        <span className="am-tile-name">{app.name}</span>
      </div>
    )
  }
  return (
    <div
      ref={ref}
      className={`am-item${selected ? ' selected' : ''}`}
      onClick={onPick}
      title={app.bundleId}
    >
      {iconEl}
      <span className="am-item-name">{app.name}</span>
    </div>
  )
}

export function IosAppsView({ c, onStatus, onMessage }: Props) {
  const serial = c.serial
  const [apps, setApps] = useState<IosAppInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<FilterKind>('user')
  const [view, setView] = useState<ViewMode>('grid')
  // Selection is the shared app pick (c.appPkg) so the Databases tab + sub-tabs
  // all follow one selection, like Android's AppManagerView.
  const selected = c.appPkg
  const [sub, setSub] = useState<'info' | 'files' | 'databases' | 'crashes' | 'prefs'>('info')
  const [busy, setBusy] = useState(false)
  const [confirmApp, setConfirmApp] = useState<IosAppInfo | null>(null)
  // Developer tier (userspace tunnel — no sudo): launch / force-quit / ps.
  const [tunnel, setTunnel] = useState(false)
  const [tunnelBusy, setTunnelBusy] = useState(false)
  const [runningCount, setRunningCount] = useState<number | null>(null)

  // --- real home-screen icons: bounded (3-wide) lazy pool over visible rows.
  // Each icon is a separate go-ios/springboardservices round-trip, so we fetch
  // only rows scrolled into view and cap concurrency (mirrors AppManagerView).
  const [icons, setIcons] = useState<Record<string, string | null>>({})
  const serialRef = useRef(serial)
  serialRef.current = serial
  const observerRef = useRef<IntersectionObserver | null>(null)
  const rowMeta = useRef(new Map<Element, string>())
  const iconSeen = useRef(new Set<string>())
  const iconQueue = useRef<string[]>([])
  const iconInflight = useRef(0)

  const pump = useCallback(() => {
    const s = serialRef.current
    if (!s) return
    while (iconInflight.current < 3 && iconQueue.current.length > 0) {
      const bundleId = iconQueue.current.shift() as string
      iconInflight.current += 1
      void window.androidlab.ios.appIcon(s, bundleId).then((res) => {
        iconInflight.current -= 1
        ICON_CACHE.set(iconKey(s, bundleId), res.dataUrl)
        setIcons((prev) => ({ ...prev, [bundleId]: res.dataUrl }))
        pump()
      })
    }
  }, [])

  const requestIcon = useCallback(
    (bundleId: string) => {
      const s = serialRef.current
      if (!s || !bundleId || iconSeen.current.has(bundleId)) return
      iconSeen.current.add(bundleId)
      // Serve from the session cache with no IPC when we already have it.
      const cached = ICON_CACHE.get(iconKey(s, bundleId))
      if (cached !== undefined) {
        if (cached) setIcons((prev) => ({ ...prev, [bundleId]: cached }))
        return
      }
      iconQueue.current.push(bundleId)
      pump()
    },
    [pump]
  )

  const getObserver = useCallback((): IntersectionObserver => {
    if (!observerRef.current) {
      observerRef.current = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue
            const bid = rowMeta.current.get(e.target)
            if (bid) requestIcon(bid)
          }
        },
        { rootMargin: '150px' }
      )
    }
    return observerRef.current
  }, [requestIcon])

  const registerRow = useCallback(
    (el: HTMLElement | null, bundleId: string): (() => void) => {
      if (!el) return () => {}
      const io = getObserver()
      rowMeta.current.set(el, bundleId)
      io.observe(el)
      return () => {
        io.unobserve(el)
        rowMeta.current.delete(el)
      }
    },
    [getObserver]
  )

  const reload = useCallback(async () => {
    if (!serial) {
      setApps([])
      setError('')
      return
    }
    setLoading(true)
    setError('')
    const r = await window.androidlab.ios.listApps(serial)
    setApps(r.ok ? r.apps : [])
    setError(r.ok ? '' : r.error || 'Could not list apps')
    setLoading(false)
  }, [serial])

  // Seed icon state from the session cache when the device changes (or on mount)
  // and reset the per-mount request bookkeeping. Cached icons paint instantly
  // with no device round-trip; only rows we've never fetched load on scroll. A
  // manual refresh no longer wipes icons — they persist from the cache.
  useEffect(() => {
    const seed: Record<string, string | null> = {}
    const seen = new Set<string>()
    const prefix = `${serial}::`
    for (const [k, v] of ICON_CACHE) {
      if (!k.startsWith(prefix)) continue
      const bundleId = k.slice(prefix.length)
      seen.add(bundleId)
      if (v) seed[bundleId] = v
    }
    setIcons(seed)
    iconSeen.current = seen
    iconQueue.current = []
    iconInflight.current = 0
  }, [serial])

  // Reload the app list on device change.
  useEffect(() => {
    void reload()
  }, [reload])

  // Reflect developer-tunnel state when the device changes (no auto-start —
  // launch/force-quit start it on demand; Enable pre-warms it).
  useEffect(() => {
    setRunningCount(null)
    if (!serial) {
      setTunnel(false)
      return
    }
    let alive = true
    void window.androidlab.ios.tunnelStatus(serial).then((s) => {
      if (alive) setTunnel(s.ready)
    })
    return () => {
      alive = false
    }
  }, [serial])

  // Refresh the running-app count (also confirms the tunnel is up).
  const refreshRunning = useCallback(async () => {
    if (!serial) return
    const r = await window.androidlab.ios.processes(serial, true)
    if (r.ok) {
      setTunnel(true)
      setRunningCount(r.processes.length)
    } else {
      setRunningCount(null)
    }
  }, [serial])

  const enableTunnel = useCallback(async () => {
    if (!serial) return
    setTunnelBusy(true)
    onStatus('Starting developer tunnel…')
    const r = await window.androidlab.ios.tunnelStart(serial)
    setTunnelBusy(false)
    setTunnel(r.ok)
    if (r.ok) {
      onStatus('Developer tunnel active')
      void refreshRunning()
    } else {
      onMessage({ title: 'Developer tunnel', body: r.message })
    }
  }, [serial, onStatus, onMessage, refreshRunning])

  const disableTunnel = useCallback(() => {
    void window.androidlab.ios.tunnelStop()
    setTunnel(false)
    setRunningCount(null)
  }, [])

  const counts = useMemo(() => {
    let user = 0
    for (const a of apps) if (a.type === 'User') user += 1
    return { user, system: apps.length - user, all: apps.length }
  }, [apps])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return apps.filter((a) => {
      if (kind === 'user' && a.type !== 'User') return false
      if (kind === 'system' && a.type === 'User') return false
      if (!q) return true
      return a.name.toLowerCase().includes(q) || a.bundleId.toLowerCase().includes(q)
    })
  }, [apps, kind, search])

  const current = useMemo(() => filtered.find((a) => a.bundleId === selected) ?? null, [filtered, selected])

  // Prioritise the selected app's icon (the header shows it larger).
  useEffect(() => {
    if (current) requestIcon(current.bundleId)
  }, [current, requestIcon])

  const launchApp = useCallback(async () => {
    if (!serial || !current) return
    setBusy(true)
    if (!tunnel) onStatus('Starting developer tunnel…')
    const r = await window.androidlab.ios.launch(serial, current.bundleId)
    setBusy(false)
    if (r.ok) {
      onStatus(r.message)
      void refreshRunning()
    } else {
      onMessage({ title: 'Launch failed', body: r.message })
    }
  }, [serial, current, tunnel, onStatus, onMessage, refreshRunning])

  const killApp = useCallback(async () => {
    if (!serial || !current) return
    setBusy(true)
    if (!tunnel) onStatus('Starting developer tunnel…')
    const r = await window.androidlab.ios.kill(serial, current.bundleId)
    setBusy(false)
    if (r.ok) {
      onStatus(r.message)
      void refreshRunning()
    } else {
      onMessage({ title: 'Force-quit failed', body: r.message })
    }
  }, [serial, current, tunnel, onStatus, onMessage, refreshRunning])

  const installIpa = useCallback(async () => {
    if (!serial) return
    const path = await window.androidlab.ios.chooseIpa()
    if (!path) return
    setBusy(true)
    onStatus('Installing .ipa…')
    const r = await window.androidlab.ios.install(serial, path)
    setBusy(false)
    onMessage({ title: r.ok ? 'App installed' : 'Install failed', body: (r.ok ? '✓  ' : '') + r.message })
    if (r.ok) void reload()
  }, [serial, reload, onStatus, onMessage])

  const doUninstall = useCallback(
    async (app: IosAppInfo) => {
      if (!serial) return
      setConfirmApp(null)
      setBusy(true)
      onStatus(`Uninstalling ${app.name}…`)
      const r = await window.androidlab.ios.uninstall(serial, app.bundleId)
      setBusy(false)
      onMessage({ title: r.ok ? 'App uninstalled' : 'Uninstall failed', body: (r.ok ? '✓  ' : '') + r.message })
      if (r.ok) {
        void c.selectApp(null)
        void reload()
      }
    },
    [serial, reload, onStatus, onMessage]
  )

  const countLabel = loading ? 'Loading…' : error ? error : `${filtered.length} of ${apps.length} apps`
  const canUninstall = !!current && current.type === 'User' && !busy

  return (
    <div className="am-view">
      <div className="am-split">
        <div className="am-left">
          <div className="am-bar am-toolbar">
            <select value={kind} onChange={(e) => setKind(e.target.value as FilterKind)}>
              <option value="user">User ({counts.user})</option>
              <option value="system">System ({counts.system})</option>
              <option value="all">All ({counts.all})</option>
            </select>
            <span className="am-bar-tools">
              <button
                className={`toggle${view === 'list' ? ' active' : ''}`}
                title="List view"
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                <Icon name="list" size={16} />
              </button>
              <button
                className={`toggle${view === 'grid' ? ' active' : ''}`}
                title="Grid view"
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
              >
                <Icon name="grid" size={16} />
              </button>
              <button className="toggle" title="Reload the installed-app list" onClick={() => void reload()}>
                <Icon name="refresh" size={16} />
              </button>
            </span>
          </div>
          <div className="am-searchrow">
            <input
              className="am-search"
              type="text"
              placeholder="Filter apps…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {loading ? <div className="app-panel-busy" /> : null}
          <div className={view === 'grid' ? 'am-grid' : 'am-list'}>
            {filtered.map((a) => (
              <IosAppRow
                key={a.bundleId}
                app={a}
                selected={a.bundleId === selected}
                icon={icons[a.bundleId]}
                mode={view}
                register={registerRow}
                onPick={() => void c.selectApp(a.bundleId)}
              />
            ))}
          </div>
          <div className="am-count">{countLabel}</div>
        </div>

        <div className="am-right">
          <div className="am-header">
            <div className="am-titlerow">
              {current && icons[current.bundleId] ? (
                <img className="am-header-icon" src={icons[current.bundleId] as string} alt="" width={40} height={40} />
              ) : (
                <AppIcon pkg={current ? current.bundleId : '?'} size={40} />
              )}
              <div className="am-titlebox">
                <div className="am-title">{current ? current.name : 'Select an app'}</div>
                <div className="am-subtitle">
                  {current
                    ? `${current.bundleId}${current.version ? `  ·  v${current.version}` : ''}`
                    : 'iOS device — go-ios backend'}
                </div>
              </div>
            </div>
            <div className="am-actions">
              <button
                className="toggle"
                disabled={!current || busy}
                title="Launch this app on the device (starts the developer tunnel if needed)"
                onClick={() => void launchApp()}
              >
                Launch
              </button>
              <button
                className="toggle"
                disabled={!current || busy}
                title="Force-quit this app on the device"
                onClick={() => void killApp()}
              >
                Force-quit
              </button>
              <button className="toggle" disabled={busy || !serial} onClick={() => void installIpa()}>
                Install .ipa…
              </button>
              <button
                className="toggle"
                disabled={!canUninstall}
                title={current && current.type !== 'User' ? 'Only user-installed apps can be uninstalled' : 'Uninstall this app'}
                onClick={() => current && setConfirmApp(current)}
              >
                Uninstall
              </button>
            </div>
          </div>

          <div className="ios-tunnel-bar">
            <span className={`ios-dot${tunnel ? ' on' : ''}`} />
            <span className="ios-tunnel-label">
              {tunnel
                ? `Developer tunnel active${runningCount != null ? ` · ${runningCount} apps running` : ''}`
                : 'Developer tunnel off — launch & process control need it (no admin required)'}
            </span>
            {tunnel ? (
              <button className="toggle" onClick={disableTunnel} title="Stop the developer tunnel">
                Disable
              </button>
            ) : (
              <button
                className="toggle"
                disabled={tunnelBusy || !serial}
                onClick={() => void enableTunnel()}
                title="Start the iOS-17+ userspace tunnel (no sudo)"
              >
                {tunnelBusy ? 'Starting…' : 'Enable'}
              </button>
            )}
          </div>

          <div className="am-tabs">
            <button className={`tab${sub === 'info' ? ' selected' : ''}`} onClick={() => setSub('info')}>
              Info
            </button>
            <button className={`tab${sub === 'files' ? ' selected' : ''}`} onClick={() => setSub('files')}>
              Files
            </button>
            <button className={`tab${sub === 'databases' ? ' selected' : ''}`} onClick={() => setSub('databases')}>
              Databases
            </button>
            <button className={`tab${sub === 'crashes' ? ' selected' : ''}`} onClick={() => setSub('crashes')}>
              Crashes
            </button>
            <button className={`tab${sub === 'prefs' ? ' selected' : ''}`} onClick={() => setSub('prefs')}>
              Prefs
            </button>
          </div>
          <div className="am-panels">
            {sub === 'info' ? (
              <div className="am-scroll">
              {current ? (
                <>
                  <table className="am-info">
                    <tbody>
                      {IOS_INFO_ROWS.map(([label, key]) => {
                        const raw = current[key]
                        const text = typeof raw === 'string' ? raw : ''
                        return (
                          <tr key={label}>
                            <td className="k">{label}</td>
                            <td className="v">{text || '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>

                  <div className="ios-section">Declared privacy usage</div>
                  {current.usage.length === 0 ? (
                    <div className="ios-empty">This app declares no privacy-sensitive usage strings.</div>
                  ) : (
                    <div className="ios-usage">
                      {current.usage.map(([label, desc]) => (
                        <div key={label} className="ios-usage-row" title={desc}>
                          <span className="ios-usage-cap">{label}</span>
                          <span className="ios-usage-desc">{desc || '—'}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="ios-note">
                    Launch and force-quit run over the iOS-17+ developer tunnel (started on demand, no
                    admin needed). Clear data and permission/component/app-op editing have no iOS
                    equivalent and are intentionally hidden.
                  </div>
                </>
              ) : (
                <div className="ios-empty">Pick an app on the left to see its details.</div>
              )}
              </div>
            ) : sub === 'files' ? (
              current ? (
                // Reuse the Android File Explorer — on iOS it browses the selected
                // app's sandbox container ('/'-rooted) via go-ios house-arrest/AFC.
                <div className="am-embed" style={{ display: 'flex' }}>
                  <FilesView c={c} />
                </div>
              ) : (
                <div className="am-scroll">
                  <div className="ios-empty">Pick an app on the left to browse its container.</div>
                </div>
              )
            ) : sub === 'databases' ? (
              // Reuse the Android Database Inspector — on iOS it lists the selected
              // app's SQLite files inside its container (via go-ios) and browses them.
              <div className="am-embed" style={{ display: 'flex' }}>
                <DatabaseView c={c} />
              </div>
            ) : sub === 'crashes' ? (
              <div className="am-embed" style={{ display: 'flex' }}>
                <CrashView
                  serial={serial}
                  pkg={current?.bundleId ?? null}
                  active={sub === 'crashes'}
                  liveCrashSeq={c.liveCrashSeq}
                  onStatus={onStatus}
                  onFailed={(m) => onMessage({ title: 'Crashes', body: m })}
                  onSaved={(ok, message, dir) =>
                    ok
                      ? onMessage({ title: 'Crash record saved', body: `✓  ${message}`, dir })
                      : onMessage({ title: 'Crashes', body: message })
                  }
                />
              </div>
            ) : (
              <div className="am-embed" style={{ display: 'flex' }}>
                <PrefsView
                  serial={serial}
                  pkg={current?.bundleId ?? null}
                  active={sub === 'prefs'}
                  onStatus={onStatus}
                  onFailed={(m) => onMessage({ title: 'Preferences', body: m })}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {confirmApp ? (
        <div className="ios-confirm-backdrop" onMouseDown={() => setConfirmApp(null)}>
          <div className="ios-confirm" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ios-confirm-title">Uninstall {confirmApp.name}?</div>
            <div className="ios-confirm-body">
              {confirmApp.bundleId}
              <br />
              This removes the app and its data from the device.
            </div>
            <div className="ios-confirm-actions">
              <button className="toggle" onClick={() => setConfirmApp(null)}>
                Cancel
              </button>
              <button className="toggle danger" onClick={() => void doUninstall(confirmApp)}>
                Uninstall
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
