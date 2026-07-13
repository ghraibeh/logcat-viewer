/**
 * App Manager — port of appmgr.py's AppManagerView. Full-width view (its own
 * searchable app list, not the shared AppPickerPanel): a filterable installed-app
 * list with lazily-loaded real APK icons, header actions (Launch / Force-stop /
 * Clear cache / Clear data / Enable-Disable / Uninstall / Extract APK / App info /
 * Decompile via right-click), and Info / Permissions / Components / App Ops /
 * Signature / Running / Prefs / Crashes sub-tabs. Two-way synced with the shared
 * App picker: clicking an app drives c.selectApp; an external pick selects here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Controller } from '../state/useAppController'
import { PALETTE } from '../theme'
import { AppIcon } from './AppIcon'
import { PrefsView } from './PrefsView'
import { CrashView } from './CrashView'
import { ConfirmDialog, type MessageBoxSpec } from './dialogs'
import {
  APPOP_MODES,
  INFO_ROWS,
  appInfoArgs,
  appopsSetArgs,
  clearArgs,
  componentArgs,
  disableArgs,
  enableArgs,
  forceStopArgs,
  grantArgs,
  launchArgs,
  revokeArgs,
  uninstallArgs,
  type AppDetail,
  type AppInfo,
  type Component
} from '@core/appmgr'

type SubTab = 'info' | 'perms' | 'components' | 'ops' | 'sig' | 'running' | 'prefs' | 'crashes'
type Category = 'All' | 'User' | 'System' | 'Disabled'

interface MenuItem {
  label?: string
  sep?: boolean
  disabled?: boolean
  run?: () => void
}
interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}
interface ConfirmState {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => void
}

export interface AppManagerViewProps {
  c: Controller
  onStatus: (msg: string) => void
  onFailed: (msg: string) => void
  onMessage: (spec: MessageBoxSpec) => void
}

// --- lazily-loaded APK icon (per-visible-row, bounded pool) -------------------
function AppRow({
  app,
  selected,
  disabledLook,
  icon,
  register,
  onPick,
  onContext
}: {
  app: AppInfo
  selected: boolean
  disabledLook: boolean
  icon: string | null | undefined
  register: (el: HTMLElement | null, pkg: string, apkPath: string) => () => void
  onPick: () => void
  onContext: (e: React.MouseEvent) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => register(ref.current, app.package, app.apkPath), [register, app.package, app.apkPath])
  const badges: string[] = []
  if (app.system) badges.push('system')
  if (!app.enabled) badges.push('disabled')
  return (
    <div
      ref={ref}
      className={`am-item${selected ? ' selected' : ''}${disabledLook ? ' dim' : ''}`}
      title={app.package + (badges.length ? `  (${badges.join(', ')})` : '')}
      onClick={onPick}
      onContextMenu={onContext}
    >
      {icon ? <img className="am-item-icon" src={icon} alt="" width={30} height={30} /> : <AppIcon pkg={app.package} size={30} />}
      <span className="am-item-name">{app.package}</span>
    </div>
  )
}

export function AppManagerView({ c, onStatus, onFailed, onMessage }: AppManagerViewProps) {
  const [apps, setApps] = useState<AppInfo[]>([])
  const [countLabel, setCountLabel] = useState('')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState<Category>('All')
  const [detail, setDetail] = useState<AppDetail | null>(null)
  const [detailMsg, setDetailMsg] = useState('Select an app')
  const [detailNonce, setDetailNonce] = useState(0)
  const [subtab, setSubtab] = useState<SubTab>('info')
  const [crashSubBadge, setCrashSubBadge] = useState(false)
  const [icons, setIcons] = useState<Record<string, string | null>>({})
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  const [appopFor, setAppopFor] = useState<AppInfo | null>(null)

  const serial = c.serial
  const serialRef = useRef(serial)
  serialRef.current = serial
  const detailSeq = useRef(0)
  const actionBusy = useRef(false)
  const cacheBusy = useRef(false)
  const extractBusy = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)

  const current = useMemo(() => apps.find((a) => a.package === c.appPkg) ?? null, [apps, c.appPkg])

  // --- icons: bounded (3-wide) lazy pool over the visible rows ----------------
  const observerRef = useRef<IntersectionObserver | null>(null)
  const rowMeta = useRef(new Map<Element, { pkg: string; apkPath: string }>())
  const iconSeen = useRef(new Set<string>())
  const iconQueue = useRef<Array<{ pkg: string; apkPath: string }>>([])
  const iconInflight = useRef(0)
  const iconsDisabled = useRef(false)

  const pump = useCallback(() => {
    const s = serialRef.current
    if (!s || iconsDisabled.current) return
    while (iconInflight.current < 3 && iconQueue.current.length > 0) {
      const { pkg, apkPath } = iconQueue.current.shift() as { pkg: string; apkPath: string }
      iconInflight.current += 1
      void window.androidlab.appmgr.icon(s, pkg, apkPath).then((res) => {
        iconInflight.current -= 1
        if (res.unavailable) {
          iconsDisabled.current = true
          iconQueue.current = []
          return
        }
        setIcons((prev) => ({ ...prev, [pkg]: res.dataUrl }))
        pump()
      })
    }
  }, [])

  const requestIcon = useCallback(
    (pkg: string, apkPath: string) => {
      if (iconsDisabled.current || !apkPath || iconSeen.current.has(pkg)) return
      iconSeen.current.add(pkg)
      iconQueue.current.push({ pkg, apkPath })
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
            const meta = rowMeta.current.get(e.target)
            if (meta) requestIcon(meta.pkg, meta.apkPath)
          }
        },
        { rootMargin: '150px' }
      )
    }
    return observerRef.current
  }, [requestIcon])

  const registerRow = useCallback(
    (el: HTMLElement | null, pkg: string, apkPath: string): (() => void) => {
      if (!el) return () => {}
      const io = getObserver()
      rowMeta.current.set(el, { pkg, apkPath })
      io.observe(el)
      return () => {
        io.unobserve(el)
        rowMeta.current.delete(el)
      }
    },
    [getObserver]
  )

  useEffect(() => () => observerRef.current?.disconnect(), [])

  // --- list load (mount + on device change) -----------------------------------
  const reload = useCallback(async () => {
    const s = serialRef.current
    if (!s) {
      setApps([])
      setCountLabel('No device selected')
      return
    }
    setCountLabel('Loading apps…')
    onStatus('Listing installed apps…')
    const r = await window.androidlab.appmgr.list(s)
    if (s !== serialRef.current) return
    if (!r.ok) {
      setCountLabel('')
      onFailed(r.error || 'Could not list apps')
      return
    }
    setApps(r.apps)
    onStatus(`${r.apps.length} apps installed`)
  }, [onStatus, onFailed])

  useEffect(() => {
    // device changed: icon state is per-device.
    setIcons({})
    iconSeen.current.clear()
    iconQueue.current = []
    iconInflight.current = 0
    iconsDisabled.current = false
    setApps([])
    setDetail(null)
    if (serial) void reload()
    else setCountLabel('No device selected')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial])

  // --- detail load (follows the selected app) ---------------------------------
  useEffect(() => {
    if (!current || !serial) {
      setDetail(null)
      setDetailMsg(serial ? 'Select an app' : 'No device selected')
      return
    }
    requestIcon(current.package, current.apkPath) // prioritise the selected app's icon
    const seq = ++detailSeq.current
    setDetail(null)
    setDetailMsg('Loading…')
    void window.androidlab.appmgr.detail(serial, current.package, current.apkPath).then((r) => {
      if (seq !== detailSeq.current) return
      if (!r.ok || !r.detail) {
        setDetailMsg(r.error || 'Could not read details')
        return
      }
      setDetail(r.detail)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.package, serial, detailNonce])

  const reloadDetail = useCallback(() => setDetailNonce((n) => n + 1), [])

  // Keep the list scrolled to the externally-selected app.
  useEffect(() => {
    if (!c.appPkg) return
    listRef.current?.querySelector('.am-item.selected')?.scrollIntoView({ block: 'nearest' })
  }, [c.appPkg, apps])

  // Live-crash: badge the Crashes sub-tab unless it's already open.
  useEffect(() => {
    if (c.liveCrashSeq === 0) return
    if (subtab !== 'crashes') setCrashSubBadge(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.liveCrashSeq])

  const selectSubtab = useCallback((id: SubTab) => {
    setSubtab(id)
    if (id === 'crashes') setCrashSubBadge(false)
  }, [])

  // --- filtered list ----------------------------------------------------------
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return apps.filter((a) => {
      if (category === 'User' && a.system) return false
      if (category === 'System' && !a.system) return false
      if (category === 'Disabled' && a.enabled) return false
      if (needle && !a.package.toLowerCase().includes(needle)) return false
      return true
    })
  }, [apps, search, category])

  useEffect(() => {
    setCountLabel(`${shown.length} of ${apps.length} apps`)
  }, [shown.length, apps.length])

  // --- actions ----------------------------------------------------------------
  const runAction = useCallback(
    async (argv: string[], okMsg: string, onDone?: () => void) => {
      if (!serialRef.current) return
      if (actionBusy.current) {
        onStatus('Another action is still running…')
        return
      }
      actionBusy.current = true
      onStatus(okMsg + '…')
      const r = await window.androidlab.appmgr.action(serialRef.current, argv, okMsg)
      actionBusy.current = false
      if (r.ok) {
        onStatus(r.message)
        onDone?.()
      } else {
        onFailed(r.message)
      }
    },
    [onStatus, onFailed]
  )

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text)
      onStatus(`Copied ${text}`)
    },
    [onStatus]
  )

  const launch = (): void => {
    if (current && serial) void runAction(launchArgs(serial, current.package), `Launched ${current.package}`)
  }
  const forceStop = (): void => {
    if (current && serial) void runAction(forceStopArgs(serial, current.package), `Force-stopped ${current.package}`)
  }
  const clearData = (): void => {
    if (!current || !serial) return
    const pkg = current.package
    setConfirm({
      title: 'Clear app data?',
      body: `This wipes all data for ${pkg} on the device. This cannot be undone.`,
      confirmLabel: 'Clear',
      onConfirm: () => {
        setConfirm(null)
        void runAction(clearArgs(serial, pkg), `Cleared data for ${pkg}`, reloadDetail)
      }
    })
  }
  const clearCache = async (): Promise<void> => {
    if (!current || !serial) return
    if (cacheBusy.current) {
      onStatus('A cache clear is already running…')
      return
    }
    cacheBusy.current = true
    onStatus(`Clearing cache for ${current.package}…`)
    const r = await window.androidlab.appmgr.clearCache(serial, current.package)
    cacheBusy.current = false
    if (r.ok) {
      onStatus(r.message)
      reloadDetail()
    } else {
      onFailed(r.message)
    }
  }
  const toggleEnabled = (): void => {
    if (!current || !serial) return
    const pkg = current.package
    if (current.enabled) void runAction(disableArgs(serial, pkg), `Disabled ${pkg}`, reload)
    else void runAction(enableArgs(serial, pkg), `Enabled ${pkg}`, reload)
  }
  const uninstall = (): void => {
    if (!current || !serial) return
    const pkg = current.package
    setConfirm({
      title: 'Uninstall app?',
      body: `Uninstall ${pkg} from the device?`,
      confirmLabel: 'Uninstall',
      onConfirm: () => {
        setConfirm(null)
        void runAction(uninstallArgs(serial, pkg), `Uninstalled ${pkg}`, reload)
      }
    })
  }
  const extractApk = async (app: AppInfo): Promise<void> => {
    if (!serial) return
    if (extractBusy.current) {
      onStatus('An APK extraction is already running…')
      return
    }
    extractBusy.current = true
    onStatus(`Extracting APK for ${app.package}…`)
    const r = await window.androidlab.appmgr.extractApk(serial, app.package)
    extractBusy.current = false
    if (r.ok) onMessage({ title: 'APK extracted', body: `✓  ${r.message}`, dir: r.dir })
    else onFailed(r.message)
  }
  const openAppInfo = (): void => {
    if (current && serial) void runAction(appInfoArgs(serial, current.package), `Opened settings for ${current.package}`)
  }
  const setAppop = (op: string, mode: string): void => {
    if (current && serial) void runAction(appopsSetArgs(serial, current.package, op, mode), `Set ${op} = ${mode}`, reloadDetail)
  }
  const bulkPerms = (grant: boolean): void => {
    if (!current || !detail || !serial) return
    const pkg = current.package
    const perms = detail.permissions.filter((p) => p.runtime).map((p) => p.name)
    if (perms.length === 0) {
      onStatus('No runtime permissions to change')
      return
    }
    const verb = grant ? 'Grant' : 'Revoke'
    const prep = grant ? 'to' : 'from'
    setConfirm({
      title: `${verb} all permissions?`,
      body: `${verb} all ${perms.length} runtime permission(s) ${prep} ${pkg}?`,
      confirmLabel: verb,
      onConfirm: () => {
        setConfirm(null)
        onStatus(`${verb}ing ${perms.length} permission(s)…`)
        void window.androidlab.appmgr.bulkPerms(serial, pkg, perms, grant).then((r) => {
          ;(r.ok ? onStatus : onFailed)(r.message)
          reloadDetail()
        })
      }
    })
  }

  // --- context menus ----------------------------------------------------------
  const openMenu = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  const appListMenu = (e: React.MouseEvent, app: AppInfo): void =>
    openMenu(e, [
      {
        label: 'Decompile to Java (jadx)…',
        // TODO(decompile-cluster): wire to the Decompile service once ported
        run: () => onStatus('Decompiler is ported in a later cluster')
      },
      { label: 'Extract APK', run: () => void extractApk(app) },
      { sep: true },
      { label: 'Copy package name', run: () => copy(app.package) }
    ])
  const permMenu = (e: React.MouseEvent, perm: string): void => {
    if (!current || !serial) return
    const pkg = current.package
    openMenu(e, [
      { label: 'Grant', run: () => void runAction(grantArgs(serial, pkg, perm), `Granted ${perm}`, reloadDetail) },
      { label: 'Revoke', run: () => void runAction(revokeArgs(serial, pkg, perm), `Revoked ${perm}`, reloadDetail) },
      { sep: true },
      { label: 'Copy name', run: () => copy(perm) }
    ])
  }
  const compMenu = (e: React.MouseEvent, comp: string): void => {
    if (!current || !serial) return
    const pkg = current.package
    const act = (state: string, label: string): MenuItem => ({
      label,
      run: () => void runAction(componentArgs(serial, pkg, comp, state), `${label}d ${comp}`, reloadDetail)
    })
    openMenu(e, [
      act('enable', 'Enable'),
      act('disable', 'Disable'),
      { label: 'Reset to default', run: () => void runAction(componentArgs(serial, pkg, comp, 'default'), `Defaultd ${comp}`, reloadDetail) },
      { sep: true },
      { label: 'Copy name', run: () => copy(comp) }
    ])
  }
  const opsMenu = (e: React.MouseEvent, op: string): void => {
    const items: MenuItem[] = APPOP_MODES.map((mode) => ({ label: `Set ${op} → ${mode}`, run: () => setAppop(op, mode) }))
    items.push({ sep: true }, { label: 'Set an app op…', run: () => setAppopFor(current) })
    openMenu(e, items)
  }

  // --- sub-tab labels ---------------------------------------------------------
  const compTotal = detail
    ? detail.activities.length + detail.services.length + detail.receivers.length + detail.providers.length
    : 0
  const subtabs: Array<[SubTab, string]> = [
    ['info', 'Info'],
    ['perms', detail ? `Permissions (${detail.permissions.length})` : 'Permissions'],
    ['components', detail ? `Components (${compTotal})` : 'Components'],
    ['ops', detail ? `App Ops (${detail.appops.length})` : 'App Ops'],
    ['sig', 'Signature'],
    ['running', detail && detail.running.length ? `Running (${detail.running.length})` : 'Running'],
    ['prefs', 'Prefs'],
    ['crashes', `Crashes${crashSubBadge ? ' ●' : ''}`]
  ]

  const headerIcon = current ? icons[current.package] : undefined
  const subtitle = current
    ? `UID ${current.uid || '—'} · v${current.versionCode || '—'} · ` +
      [current.system ? 'system app' : 'user app', current.enabled ? '' : 'disabled'].filter(Boolean).join(' · ')
    : ''

  const nRuntime = detail ? detail.permissions.filter((p) => p.runtime).length : 0

  return (
    <div className="am-view">
      <div className="am-split">
        {/* Left: filter bar + app list. */}
        <div className="am-left">
          <div className="am-bar">
            <input
              className="am-search"
              type="text"
              placeholder="Filter apps…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select value={category} onChange={(e) => setCategory(e.target.value as Category)}>
              <option>All</option>
              <option>User</option>
              <option>System</option>
              <option>Disabled</option>
            </select>
            <button className="toggle" title="Reload the installed-app list" onClick={() => void reload()}>
              ⟳
            </button>
          </div>
          <div className="am-list" ref={listRef}>
            {shown.map((a) => (
              <AppRow
                key={a.package}
                app={a}
                selected={a.package === c.appPkg}
                disabledLook={!a.enabled}
                icon={icons[a.package]}
                register={registerRow}
                onPick={() => void c.selectApp(a.package)}
                onContext={(e) => appListMenu(e, a)}
              />
            ))}
          </div>
          <div className="am-count">{countLabel}</div>
        </div>

        {/* Right: header + detail sub-tabs. */}
        <div className="am-right">
          <div className="am-header">
            <div className="am-titlerow">
              {current ? (
                headerIcon ? (
                  <img className="am-header-icon" src={headerIcon} alt="" width={40} height={40} />
                ) : (
                  <AppIcon pkg={current.package} size={40} />
                )
              ) : null}
              <div className="am-titlebox">
                <div className="am-title">{current ? current.package : 'Select an app'}</div>
                <div className="am-subtitle">{subtitle}</div>
              </div>
            </div>
            <div className="am-actions">
              <button className="toggle" disabled={!current} onClick={launch}>
                Launch
              </button>
              <button className="toggle" disabled={!current} onClick={forceStop}>
                Force-stop
              </button>
              <button className="toggle" disabled={!current} onClick={() => void clearCache()}>
                Clear cache
              </button>
              <button className="toggle" disabled={!current} onClick={clearData}>
                Clear data
              </button>
              <button className="toggle" disabled={!current} onClick={toggleEnabled}>
                {current && !current.enabled ? 'Enable' : 'Disable'}
              </button>
              <button className="toggle" disabled={!current} onClick={uninstall}>
                Uninstall
              </button>
              <button className="toggle" disabled={!current} onClick={() => current && void extractApk(current)}>
                Extract APK
              </button>
              <button className="toggle" disabled={!current} onClick={openAppInfo}>
                App Info
              </button>
            </div>
          </div>

          <div className="am-tabs">
            {subtabs.map(([id, label]) => (
              <button key={id} className={`tab${subtab === id ? ' selected' : ''}`} onClick={() => selectSubtab(id)}>
                {label}
              </button>
            ))}
          </div>

          <div className="am-panels">
            {subtab === 'info' ? (
              <div className="am-scroll">
                <table className="am-info">
                  <tbody>
                    {detail ? (
                      <>
                        {INFO_ROWS.map(([label, key]) => (
                          <tr key={key}>
                            <td className="k">{label}</td>
                            <td className="v">{key === 'package' ? detail.package : detail.general[key] || '—'}</td>
                          </tr>
                        ))}
                        <tr>
                          <td className="k">Enabled</td>
                          <td className="v">{current && current.enabled ? 'yes' : 'no'}</td>
                        </tr>
                      </>
                    ) : (
                      <tr>
                        <td className="k" />
                        <td className="v">{detailMsg}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ) : null}

            {subtab === 'perms' ? (
              <div className="am-tabwrap">
                <div className="am-subbar">
                  <button className="toggle" disabled={nRuntime === 0} title="Grant every runtime permission this app requests" onClick={() => bulkPerms(true)}>
                    Grant all
                  </button>
                  <button className="toggle" disabled={nRuntime === 0} title="Revoke every runtime permission from this app" onClick={() => bulkPerms(false)}>
                    Revoke all
                  </button>
                  <span className="grow" />
                  <span className="am-hint">Runtime permissions only</span>
                </div>
                <div className="am-scroll">
                  <table className="am-table">
                    <thead>
                      <tr>
                        <th>Permission</th>
                        <th>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(detail?.permissions ?? []).map((p) => {
                        const [state, col] =
                          p.granted === true
                            ? ['granted', PALETTE.GREEN]
                            : p.granted === false
                              ? ['denied', PALETTE.RED]
                              : ['requested', PALETTE.TEXT_DIM]
                        return (
                          <tr key={p.name} onContextMenu={(e) => permMenu(e, p.name)}>
                            <td style={{ color: p.runtime ? undefined : PALETTE.TEXT_DIM }}>{p.name}</td>
                            <td style={{ color: col }}>{state}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {subtab === 'components' ? (
              <div className="am-scroll">
                {detail
                  ? (
                      [
                        ['Activities', detail.activities],
                        ['Services', detail.services],
                        ['Receivers', detail.receivers],
                        ['Providers', detail.providers]
                      ] as Array<[string, Component[]]>
                    ).map(([label, comps]) => (
                      <div className="am-compgroup" key={label}>
                        <div className="am-comphead">
                          {label} ({comps.length})
                        </div>
                        {comps.map((cmp) => (
                          <div
                            key={cmp.name}
                            className="am-comprow"
                            onContextMenu={(e) => compMenu(e, cmp.name)}
                            style={{ color: cmp.enabled ? undefined : PALETTE.TEXT_DIM }}
                          >
                            <span className="c-name">{cmp.name}</span>
                            <span className="c-state" style={{ color: cmp.enabled ? PALETTE.GREEN : PALETTE.TEXT_DIM }}>
                              {cmp.enabled ? 'enabled' : 'disabled'}
                            </span>
                          </div>
                        ))}
                      </div>
                    ))
                  : null}
              </div>
            ) : null}

            {subtab === 'ops' ? (
              <div className="am-scroll">
                <table className="am-table">
                  <thead>
                    <tr>
                      <th>App op</th>
                      <th>Mode</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail?.appops ?? []).map((o) => {
                      const col: Record<string, string> = {
                        allow: PALETTE.GREEN,
                        foreground: PALETTE.ACCENT,
                        deny: PALETTE.RED,
                        ignore: PALETTE.AMBER
                      }
                      return (
                        <tr key={o.op} onContextMenu={(e) => opsMenu(e, o.op)}>
                          <td>{o.op}</td>
                          <td style={{ color: col[o.mode] ?? PALETTE.TEXT }}>{o.mode}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}

            {subtab === 'sig' ? (
              <div className="am-scroll am-sig">
                {detail && detail.signatures.length > 0 ? (
                  detail.signatures.map((s, i) => <div key={i}>{s}</div>)
                ) : (
                  <div className="am-hint">
                    No signing summary in dumpsys. Extract the APK and inspect it with{' '}
                    <code>apksigner verify --print-certs</code> for the full certificate.
                  </div>
                )}
              </div>
            ) : null}

            {subtab === 'running' ? (
              <div className="am-scroll">
                <table className="am-table">
                  <thead>
                    <tr>
                      <th>Service</th>
                      <th>Process</th>
                      <th>PID</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail?.running ?? []).map((svc, i) => {
                      const state = [svc.foreground ? 'foreground' : '', svc.started ? 'started' : 'bound'].filter(Boolean).join(', ')
                      return (
                        <tr key={`${svc.component}|${i}`}>
                          <td>{svc.component}</td>
                          <td>{svc.process}</td>
                          <td>{svc.pid ?? '—'}</td>
                          <td style={{ color: svc.foreground ? PALETTE.GREEN : undefined }}>{state}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div className="am-embed" style={{ display: subtab === 'prefs' ? 'flex' : 'none' }}>
              <PrefsView serial={serial} pkg={current?.package ?? null} active={subtab === 'prefs'} onStatus={onStatus} onFailed={onFailed} />
            </div>
            <div className="am-embed" style={{ display: subtab === 'crashes' ? 'flex' : 'none' }}>
              <CrashView
                serial={serial}
                pkg={current?.package ?? null}
                active={subtab === 'crashes'}
                liveCrashSeq={c.liveCrashSeq}
                onStatus={onStatus}
                onFailed={onFailed}
                onSaved={(ok, message, dir) =>
                  ok ? onMessage({ title: 'Crash record saved', body: `✓  ${message}`, dir }) : onFailed(message)
                }
              />
            </div>
          </div>
        </div>
      </div>

      {menu ? (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 999 }}
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          />
          <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.items.map((it, i) =>
              it.sep ? (
                <div className="sep" key={i} />
              ) : (
                <div
                  key={i}
                  className={`item${it.disabled ? ' disabled' : ''}`}
                  onClick={() => {
                    if (!it.disabled) it.run?.()
                    setMenu(null)
                  }}
                >
                  {it.label}
                </div>
              )
            )}
          </div>
        </>
      ) : null}

      {confirm ? (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.confirmLabel}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      ) : null}

      {appopFor ? (
        <AppOpDialog
          onCancel={() => setAppopFor(null)}
          onSubmit={(op, mode) => {
            setAppopFor(null)
            setAppop(op, mode)
          }}
        />
      ) : null}
    </div>
  )
}

// --- "Set an app op…" dialog (op name + mode) --------------------------------
function AppOpDialog({ onSubmit, onCancel }: { onSubmit: (op: string, mode: string) => void; onCancel: () => void }) {
  const [op, setOp] = useState('')
  const [mode, setMode] = useState<string>(APPOP_MODES[0])
  return (
    <div className="scrim" onMouseDown={onCancel}>
      <div className="msgbox" onMouseDown={(e) => e.stopPropagation()}>
        <div className="title">Set an app op</div>
        <div className="body" style={{ overflow: 'visible' }}>
          <div style={{ marginBottom: 8 }}>App op name (e.g. COARSE_LOCATION):</div>
          <input type="text" value={op} style={{ width: '100%' }} onChange={(e) => setOp(e.target.value)} autoFocus />
          <div style={{ margin: '10px 0 8px' }}>Mode:</div>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {APPOP_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div className="buttons">
          <button onClick={onCancel}>Cancel</button>
          <button className="start" disabled={!op.trim()} onClick={() => onSubmit(op.trim(), mode)}>
            Set
          </button>
        </div>
      </div>
    </div>
  )
}
