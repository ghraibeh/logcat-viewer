/**
 * Device Info — the visual "About this device" dashboard, the first tab when a
 * device is selected. One shared presentational <Dashboard> (gradient hero +
 * storage/battery rings + colorful spec tiles + a copy-on-click details grid)
 * drives BOTH platforms: each platform builds a plain DashboardVM from its own
 * source (Android via one batched `adb shell` probe — window.androidlab.adb.
 * deviceInfo; iOS via the no-tunnel go-ios lockdown payloads —
 * window.androidlab.ios.deviceInfo) and hands it to the same renderer. No
 * parallel UI: only the data mapping differs per platform.
 */
import { useCallback, useEffect, useState } from 'react'
import type { AndroidDeviceInfo } from '@core/deviceinfo'
import { fmtGB as fmtGBAndroid } from '@core/deviceinfo'
import type { IosDeviceInfo } from '@core/iosdeviceinfo'
import { fmtGB } from '@core/iosdeviceinfo'
import type { IosNetworkInfo } from '@core/goios'
import type { Controller } from '../state/useAppController'
import { Icon, type IconName } from './Icon'

// ---- shared view model -----------------------------------------------------
type PillKind = 'os' | 'ok' | 'chip'
interface Pill {
  text: string
  kind?: PillKind
}
interface RingVM {
  pct: number
  color: string
  value: string
  valueSub: string
  caption: string
}
interface TileVM {
  key: string
  icon: IconName
  label: string
  value: string
  sub?: string
  tint: string
  onClick?: () => void
  title?: string
}
interface DashboardVM {
  name: string
  model: string
  pills: Pill[]
  rings: RingVM[]
  tiles: TileVM[]
  details: Array<[string, string]>
}

// ---- shared primitives -----------------------------------------------------
// A conic-gradient progress ring with a value in the hole.
function Ring({ pct, color, value, valueSub, caption }: RingVM) {
  const p = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div className="dinfo-ringcard">
      <div className="dinfo-ring" style={{ background: `conic-gradient(${color} ${p * 3.6}deg, var(--dinfo-track) 0)` }}>
        <div className="dinfo-ring-hole">
          <div className="dinfo-ring-val">{value}</div>
          <div className="dinfo-ring-sub">{valueSub}</div>
        </div>
      </div>
      <div className="dinfo-ring-cap">{caption}</div>
    </div>
  )
}

function Tile({ icon, label, value, sub, tint, onClick, title }: Omit<TileVM, 'key'>) {
  const clickable = !!onClick
  return (
    <div
      className={`dinfo-tile${clickable ? ' dinfo-tile-btn' : ''}`}
      style={{ ['--tint' as string]: tint } as React.CSSProperties}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      title={title}
      onClick={onClick}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick?.()
              }
            }
          : undefined
      }
    >
      <div className="dinfo-tile-ic">
        <Icon name={icon} size={20} />
      </div>
      <div className="dinfo-tile-body">
        <div className="dinfo-tile-label">{label}</div>
        <div className="dinfo-tile-value" title={value}>
          {value}
        </div>
        {sub ? <div className="dinfo-tile-sub">{sub}</div> : null}
      </div>
    </div>
  )
}

function pillClass(kind?: PillKind): string {
  return `dinfo-pill${kind ? ` dinfo-pill-${kind}` : ''}`
}

export function batteryColor(pct: number | null): string {
  if (pct === null) return '#22c55e'
  if (pct >= 80) return '#22c55e'
  if (pct >= 50) return '#f59e0b'
  return '#ef4444'
}

/** Shared click-to-copy state (details grid + copyable tiles). */
function useCopyKey(): { copiedKey: string | null; copy: (key: string, value: string) => void } {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copy = useCallback((key: string, value: string) => {
    void navigator.clipboard.writeText(value).catch(() => {})
    setCopiedKey(key)
    window.setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1400)
  }, [])
  return { copiedKey, copy }
}

function CenterMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="dinfo dinfo-center">
      <div className="dinfo-empty">{children}</div>
    </div>
  )
}

// ---- shared presentational dashboard ---------------------------------------
function Dashboard({
  vm,
  photo,
  onRefresh,
  copiedKey,
  copyDetail
}: {
  vm: DashboardVM
  photo?: string | null
  onRefresh: () => void
  copiedKey: string | null
  copyDetail: (key: string, value: string) => void
}) {
  return (
    <div className="dinfo">
      <div className="dinfo-scroll">
        {/* Hero */}
        <div className="dinfo-hero">
          {photo ? (
            <img className="dinfo-photo" src={photo} alt={vm.model} draggable={false} />
          ) : (
            <div className="dinfo-phone" aria-hidden>
              <div className="dinfo-phone-screen" />
              <div className="dinfo-phone-island" />
            </div>
          )}
          <div className="dinfo-hero-text">
            <div className="dinfo-name">{vm.name}</div>
            <div className="dinfo-model">{vm.model}</div>
            <div className="dinfo-pills">
              {vm.pills.map((p, i) => (
                <span className={pillClass(p.kind)} key={`${p.text}-${i}`}>
                  {p.text}
                </span>
              ))}
            </div>
          </div>
          <button className="dinfo-refresh" title="Refresh" onClick={onRefresh}>
            <Icon name="refresh" size={16} />
          </button>
        </div>

        {/* Rings */}
        {vm.rings.length > 0 ? (
          <div className="dinfo-rings">
            {vm.rings.map((r, i) => (
              <Ring key={i} {...r} />
            ))}
          </div>
        ) : null}

        {/* Spec tiles */}
        {vm.tiles.length > 0 ? (
          <div className="dinfo-grid">
            {vm.tiles.map(({ key, ...t }) => (
              <Tile key={key} {...t} />
            ))}
          </div>
        ) : null}

        {/* Details */}
        {vm.details.length > 0 ? (
          <div className="dinfo-details">
            <div className="dinfo-details-head">Device details</div>
            <div className="dinfo-details-grid">
              {vm.details.map(([k, v]) => (
                <div
                  className={`dinfo-detail${copiedKey === k ? ' is-copied' : ''}`}
                  key={k}
                  role="button"
                  tabIndex={0}
                  title="Click to copy"
                  onClick={() => copyDetail(k, v)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      copyDetail(k, v)
                    }
                  }}
                >
                  <span className="dinfo-detail-k">{k}</span>
                  <span className="dinfo-detail-v">
                    {copiedKey === k ? (
                      <span className="dinfo-copied">✓ Copied</span>
                    ) : (
                      <span className="dinfo-detail-txt" title={v}>
                        {v}
                      </span>
                    )}
                    <Icon name="copy" size={13} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ---- iOS panel -------------------------------------------------------------
function IosPanel({ serial }: { serial: string }) {
  const [info, setInfo] = useState<IosDeviceInfo | null>(null)
  const [photo, setPhoto] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { copiedKey, copy } = useCopyKey()
  // The Wi-Fi IP is sniffed separately (slower) so it fills in progressively.
  const [ip, setIp] = useState<IosNetworkInfo | null>(null)
  const [ipLoading, setIpLoading] = useState(false)

  const loadIp = useCallback(async () => {
    setIpLoading(true)
    try {
      setIp(await window.androidlab.ios.deviceIp(serial))
    } catch {
      setIp({ ipv4: '', ipv6: '', mac: '' })
    } finally {
      setIpLoading(false)
    }
  }, [serial])

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    setPhoto(null)
    setIp(null)
    try {
      const d = await window.androidlab.ios.deviceInfo(serial)
      setInfo(d)
      if (!d) setErr('Could not read device info')
      // Progressive enhancement: fetch a real render (cached) and swap it in
      // when ready; the CSS phone shows until/unless it arrives.
      if (d?.productType) {
        void window.androidlab.ios
          .deviceImage(d.productType)
          .then((uri) => setPhoto(uri))
          .catch(() => setPhoto(null))
      }
      // Kick off the (slower) Wi-Fi IP sniff in parallel — it fills its tile in
      // when ready rather than holding up the dashboard.
      if (d) void loadIp()
    } catch {
      setErr('Could not read device info')
    } finally {
      setLoading(false)
    }
  }, [serial, loadIp])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !info) {
    return (
      <div className="dinfo dinfo-center">
        <div className="dinfo-spinner" />
        <div className="dinfo-empty">Reading device…</div>
      </div>
    )
  }
  if (!info) {
    return (
      <div className="dinfo dinfo-center">
        <div className="dinfo-empty">{err ?? 'No device info'}</div>
        <button className="toggle" onClick={() => void load()}>
          <Icon name="refresh" size={15} /> Retry
        </button>
      </div>
    )
  }

  const st = info.storage
  const usedBytes = st ? Math.max(0, st.totalBytes - st.freeBytes) : 0
  const usedPct = st && st.totalBytes ? (usedBytes / st.totalBytes) * 100 : 0
  const storageColor = usedPct >= 92 ? '#ef4444' : usedPct >= 80 ? '#f59e0b' : '#4f8cff'
  const bat = info.battery
  const healthPct = bat ? (bat.healthPct ?? bat.level) : null

  const ipv4 = ip?.ipv4 ?? ''
  const ipCopied = copiedKey === 'Wi-Fi IP'
  const ipValue = ipCopied ? '✓ Copied' : ipv4 || (ipLoading ? 'Detecting…' : 'Not detected')
  const ipSub = ipv4
    ? 'Wi-Fi · tap to copy'
    : ipLoading
      ? 'Sniffing device traffic…'
      : 'Wi-Fi off or idle · tap to retry'

  const rings: RingVM[] = []
  if (st) {
    rings.push({
      pct: usedPct,
      color: storageColor,
      value: fmtGB(usedBytes),
      valueSub: `of ${fmtGB(st.totalBytes)}`,
      caption: `Storage · ${fmtGB(st.freeBytes)} free`
    })
  }
  if (bat) {
    rings.push({
      pct: healthPct ?? 0,
      color: batteryColor(bat.healthPct),
      value: `${healthPct ?? bat.level}%`,
      valueSub: bat.healthPct !== null ? 'health' : 'charge',
      caption:
        `Battery · ${bat.level}% now` +
        (bat.charging ? ' ⚡' : '') +
        (bat.cycleCount !== null ? ` · ${bat.cycleCount} cycles` : '')
    })
  }

  const tiles: TileVM[] = [
    {
      key: 'ip',
      icon: 'wifi',
      label: 'IP Address',
      value: ipValue,
      sub: ipSub,
      tint: ipv4 ? '#0ea5e9' : '#94a3b8',
      onClick: () => {
        if (ipLoading) return
        if (ipv4) copy('Wi-Fi IP', ipv4)
        else void loadIp()
      },
      title: ipv4
        ? `Wi-Fi IP ${ipv4}${ip?.ipv6 ? ` · IPv6 ${ip.ipv6}` : ''} — click to copy`
        : 'Detect the device’s Wi-Fi IP address'
    }
  ]
  if (info.chip) tiles.push({ key: 'chip', icon: 'chip', label: 'Chip', value: info.chip, sub: info.cpuArch, tint: '#8b5cf6' })
  if (info.ram) tiles.push({ key: 'ram', icon: 'memory', label: 'Memory', value: info.ram, tint: '#06b6d4' })
  if (info.display) tiles.push({ key: 'display', icon: 'monitor', label: 'Display', value: info.display, tint: '#ec4899' })
  if (bat) {
    tiles.push({
      key: 'battery',
      icon: 'battery',
      label: 'Battery',
      value: bat.healthPct !== null ? `${bat.healthPct}% health` : `${bat.level}%`,
      sub:
        (bat.cycleCount !== null ? `${bat.cycleCount} cycles` : '') +
        (bat.tempC !== null ? `  ·  ${bat.tempC}°C` : ''),
      tint: batteryColor(bat.healthPct)
    })
  }
  if (info.telephony) {
    tiles.push({
      key: 'cellular',
      icon: 'signal',
      label: 'Cellular',
      value: info.simStatus ? `SIM ${info.simStatus}` : 'Cellular',
      sub: info.baseband ? `Baseband ${info.baseband}` : undefined,
      tint: '#10b981'
    })
  }
  if (info.regionInfo) tiles.push({ key: 'region', icon: 'globe', label: 'Region', value: info.regionInfo, tint: '#f59e0b' })
  if (info.timeZone) {
    tiles.push({
      key: 'tz',
      icon: 'clock',
      label: 'Time Zone',
      value: info.timeZone,
      sub: info.uses24h ? '24-hour clock' : '12-hour clock',
      tint: '#3b82f6'
    })
  }
  tiles.push({
    key: 'security',
    icon: 'shield',
    label: 'Security',
    value: info.passwordProtected ? 'Passcode set' : 'No passcode',
    sub: info.activated ? 'Activated' : 'Not activated',
    tint: info.passwordProtected ? '#22c55e' : '#94a3b8'
  })

  const pills: Pill[] = [{ text: `${info.osName} ${info.osVersion}`, kind: 'os' }]
  if (info.buildVersion) pills.push({ text: info.buildVersion })
  if (info.activated) pills.push({ text: '● Activated', kind: 'ok' })
  if (info.modelNumber) pills.push({ text: info.modelNumber })
  if (info.chip) pills.push({ text: info.chip, kind: 'chip' })

  const vm: DashboardVM = { name: info.name, model: info.marketingName, pills, rings, tiles, details: info.details }
  return <Dashboard vm={vm} photo={photo} onRefresh={() => void load()} copiedKey={copiedKey} copyDetail={copy} />
}

// ---- Android panel ---------------------------------------------------------
function AndroidPanel({ serial }: { serial: string }) {
  const [info, setInfo] = useState<AndroidDeviceInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { copiedKey, copy } = useCopyKey()

  const load = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      const d = await window.androidlab.adb.deviceInfo(serial)
      setInfo(d)
      if (!d) setErr('Could not read device info')
    } catch {
      setErr('Could not read device info')
    } finally {
      setLoading(false)
    }
  }, [serial])

  useEffect(() => {
    void load()
  }, [load])

  if (loading && !info) {
    return (
      <div className="dinfo dinfo-center">
        <div className="dinfo-spinner" />
        <div className="dinfo-empty">Reading device…</div>
      </div>
    )
  }
  if (!info) {
    return (
      <div className="dinfo dinfo-center">
        <div className="dinfo-empty">{err ?? 'No device info'}</div>
        <button className="toggle" onClick={() => void load()}>
          <Icon name="refresh" size={15} /> Retry
        </button>
      </div>
    )
  }

  const st = info.storage
  const usedBytes = st ? Math.max(0, st.totalBytes - st.freeBytes) : 0
  const usedPct = st && st.totalBytes ? (usedBytes / st.totalBytes) * 100 : 0
  const storageColor = usedPct >= 92 ? '#ef4444' : usedPct >= 80 ? '#f59e0b' : '#4f8cff'
  const bat = info.battery

  const rings: RingVM[] = []
  if (st) {
    rings.push({
      pct: usedPct,
      color: storageColor,
      value: fmtGBAndroid(usedBytes),
      valueSub: `of ${fmtGBAndroid(st.totalBytes)}`,
      caption: `Storage · ${fmtGBAndroid(st.freeBytes)} free`
    })
  }
  if (bat) {
    rings.push({
      pct: bat.level,
      color: batteryColor(bat.level),
      value: `${bat.level}%`,
      valueSub: bat.charging ? 'charging' : 'charge',
      caption:
        `Battery · ${bat.status || 'Battery'}` +
        (bat.charging ? ' ⚡' : '') +
        (bat.tempC !== null ? ` · ${bat.tempC}°C` : '')
    })
  }

  const ip = info.ip
  const tiles: TileVM[] = [
    {
      key: 'ip',
      icon: 'wifi',
      label: 'IP Address',
      value: copiedKey === 'IP' ? '✓ Copied' : ip || 'Not on Wi-Fi',
      sub: ip ? 'Wi-Fi · tap to copy' : 'Wi-Fi off or wired',
      tint: ip ? '#0ea5e9' : '#94a3b8',
      onClick: ip ? () => copy('IP', ip) : undefined,
      title: ip ? `Wi-Fi IP ${ip} — click to copy` : undefined
    }
  ]
  if (info.chip) tiles.push({ key: 'chip', icon: 'chip', label: 'Chip', value: info.chip, sub: info.abi, tint: '#8b5cf6' })
  if (info.ram) tiles.push({ key: 'ram', icon: 'memory', label: 'Memory', value: info.ram, sub: 'RAM', tint: '#06b6d4' })
  if (info.display) tiles.push({ key: 'display', icon: 'monitor', label: 'Display', value: info.resolution, sub: info.density, tint: '#ec4899' })
  if (bat) {
    tiles.push({
      key: 'battery',
      icon: 'battery',
      label: 'Battery',
      value: `${bat.level}%`,
      sub: [bat.status, bat.technology].filter(Boolean).join(' · ') || undefined,
      tint: batteryColor(bat.level)
    })
  }
  tiles.push({
    key: 'os',
    icon: 'info',
    label: 'Operating system',
    value: info.androidName || 'Android',
    sub: info.sdk ? `API ${info.sdk}` : undefined,
    tint: '#22c55e'
  })
  if (info.telephony) {
    tiles.push({
      key: 'cellular',
      icon: 'signal',
      label: 'Cellular',
      value: info.carrier || info.simState || 'Cellular',
      sub: info.radio ? `Baseband ${info.radio}` : undefined,
      tint: '#10b981'
    })
  }
  if (info.securityPatch || info.encryption) {
    tiles.push({
      key: 'security',
      icon: 'shield',
      label: 'Security',
      value: info.securityPatch ? `Patch ${info.securityPatch}` : info.encryption,
      sub: info.encryption ? `${info.encryption} storage` : undefined,
      tint: /^encrypted$/i.test(info.encryption) ? '#22c55e' : '#94a3b8'
    })
  }
  if (info.uptime) tiles.push({ key: 'uptime', icon: 'clock', label: 'Uptime', value: info.uptime, tint: '#3b82f6' })

  const pills: Pill[] = []
  if (info.androidName) pills.push({ text: info.androidName, kind: 'os' })
  if (info.sdk) pills.push({ text: `API ${info.sdk}` })
  if (info.buildType && info.buildType !== 'user') pills.push({ text: `● ${info.buildType}`, kind: 'ok' })
  if (info.buildId) pills.push({ text: info.buildId })
  if (info.chip) pills.push({ text: info.chip, kind: 'chip' })

  const vm: DashboardVM = {
    name: info.name,
    model: [info.manufacturer, info.model].filter(Boolean).join(' ') || info.model,
    pills,
    rings,
    tiles,
    details: info.details
  }
  return <Dashboard vm={vm} onRefresh={() => void load()} copiedKey={copiedKey} copyDetail={copy} />
}

// ---- dispatcher ------------------------------------------------------------
export function DeviceInfoView({ c }: { c: Controller }) {
  if (!c.serial) return <CenterMessage>Select a device to see its details.</CenterMessage>
  // key on serial so switching device fully remounts the panel (fresh fetch,
  // no stale info flashing from the previous device).
  return c.platform === 'ios' ? (
    <IosPanel key={c.serial} serial={c.serial} />
  ) : (
    <AndroidPanel key={c.serial} serial={c.serial} />
  )
}
