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
import { useCallback, useEffect, useMemo, useState } from 'react'
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

export function IosAppsView({ c, onStatus, onMessage }: Props) {
  const serial = c.serial
  const [apps, setApps] = useState<IosAppInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<FilterKind>('user')
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

  // Reload on device change.
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
          <div className="am-bar">
            <input
              className="am-search"
              type="text"
              placeholder="Filter apps…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select value={kind} onChange={(e) => setKind(e.target.value as FilterKind)}>
              <option value="user">User ({counts.user})</option>
              <option value="system">System ({counts.system})</option>
              <option value="all">All ({counts.all})</option>
            </select>
            <button className="toggle" title="Reload the installed-app list" onClick={() => void reload()}>
              <Icon name="refresh" size={16} />
            </button>
          </div>
          <div className="am-list">
            {filtered.map((a) => (
              <div
                key={a.bundleId}
                className={`am-item${a.bundleId === selected ? ' selected' : ''}`}
                onClick={() => void c.selectApp(a.bundleId)}
                title={a.bundleId}
              >
                <AppIcon pkg={a.bundleId} size={30} />
                <span className="am-item-name">{a.name}</span>
              </div>
            ))}
          </div>
          <div className="am-count">{countLabel}</div>
        </div>

        <div className="am-right">
          <div className="am-header">
            <div className="am-titlerow">
              <AppIcon pkg={current ? current.bundleId : '?'} size={40} />
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
