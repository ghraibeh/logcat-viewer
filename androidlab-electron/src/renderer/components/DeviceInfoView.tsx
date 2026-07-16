/**
 * Device Info — the visual "About this device" dashboard for iOS (the first tab
 * when an iPhone is selected). Aggregated go-ios lockdown/disk/battery data
 * (window.androidlab.ios.deviceInfo) rendered as a gradient hero + storage /
 * battery-health rings (conic-gradient) + colorful spec tiles + a details grid.
 * Reads only classic-tier data, so no tunnel is needed.
 */
import { useCallback, useEffect, useState } from 'react'
import type { IosDeviceInfo } from '@core/iosdeviceinfo'
import { fmtGB } from '@core/iosdeviceinfo'
import type { Controller } from '../state/useAppController'
import { Icon, type IconName } from './Icon'

// A conic-gradient progress ring with a value in the hole.
function Ring({
  pct,
  color,
  value,
  valueSub,
  caption
}: {
  pct: number
  color: string
  value: string
  valueSub: string
  caption: string
}) {
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

function Tile({
  icon,
  label,
  value,
  sub,
  tint
}: {
  icon: IconName
  label: string
  value: string
  sub?: string
  tint: string
}) {
  return (
    <div className="dinfo-tile" style={{ ['--tint' as string]: tint } as React.CSSProperties}>
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

function batteryColor(pct: number | null): string {
  if (pct === null) return '#22c55e'
  if (pct >= 80) return '#22c55e'
  if (pct >= 50) return '#f59e0b'
  return '#ef4444'
}

export function DeviceInfoView({ c }: { c: Controller }) {
  const serial = c.serial
  const [info, setInfo] = useState<IosDeviceInfo | null>(null)
  const [photo, setPhoto] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const copyDetail = useCallback((key: string, value: string) => {
    void navigator.clipboard.writeText(value).catch(() => {})
    setCopiedKey(key)
    window.setTimeout(() => setCopiedKey((cur) => (cur === key ? null : cur)), 1400)
  }, [])

  const load = useCallback(async () => {
    if (!serial) {
      setInfo(null)
      setPhoto(null)
      return
    }
    setLoading(true)
    setErr(null)
    setPhoto(null)
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
    } catch {
      setErr('Could not read device info')
    } finally {
      setLoading(false)
    }
  }, [serial])

  useEffect(() => {
    void load()
  }, [load])

  if (!serial) {
    return (
      <div className="dinfo dinfo-center">
        <div className="dinfo-empty">Select a device to see its details.</div>
      </div>
    )
  }
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

  return (
    <div className="dinfo">
      <div className="dinfo-scroll">
        {/* Hero */}
        <div className="dinfo-hero">
          {photo ? (
            <img className="dinfo-photo" src={photo} alt={info.marketingName} draggable={false} />
          ) : (
            <div className="dinfo-phone" aria-hidden>
              <div className="dinfo-phone-screen" />
              <div className="dinfo-phone-island" />
            </div>
          )}
          <div className="dinfo-hero-text">
            <div className="dinfo-name">{info.name}</div>
            <div className="dinfo-model">{info.marketingName}</div>
            <div className="dinfo-pills">
              <span className="dinfo-pill dinfo-pill-os">
                {info.osName} {info.osVersion}
              </span>
              {info.buildVersion ? <span className="dinfo-pill">{info.buildVersion}</span> : null}
              {info.activated ? <span className="dinfo-pill dinfo-pill-ok">● Activated</span> : null}
              {info.modelNumber ? <span className="dinfo-pill">{info.modelNumber}</span> : null}
              {info.chip ? <span className="dinfo-pill dinfo-pill-chip">{info.chip}</span> : null}
            </div>
          </div>
          <button className="dinfo-refresh" title="Refresh" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
          </button>
        </div>

        {/* Rings */}
        <div className="dinfo-rings">
          {st ? (
            <Ring
              pct={usedPct}
              color={storageColor}
              value={fmtGB(usedBytes)}
              valueSub={`of ${fmtGB(st.totalBytes)}`}
              caption={`Storage · ${fmtGB(st.freeBytes)} free`}
            />
          ) : null}
          {bat ? (
            <Ring
              pct={healthPct ?? 0}
              color={batteryColor(bat.healthPct)}
              value={`${healthPct ?? bat.level}%`}
              valueSub={bat.healthPct !== null ? 'health' : 'charge'}
              caption={
                `Battery · ${bat.level}% now` +
                (bat.charging ? ' ⚡' : '') +
                (bat.cycleCount !== null ? ` · ${bat.cycleCount} cycles` : '')
              }
            />
          ) : null}
        </div>

        {/* Spec tiles */}
        <div className="dinfo-grid">
          {info.chip ? (
            <Tile icon="chip" label="Chip" value={info.chip} sub={info.cpuArch} tint="#8b5cf6" />
          ) : null}
          {info.ram ? <Tile icon="memory" label="Memory" value={info.ram} tint="#06b6d4" /> : null}
          {info.display ? <Tile icon="monitor" label="Display" value={info.display} tint="#ec4899" /> : null}
          {bat ? (
            <Tile
              icon="battery"
              label="Battery"
              value={bat.healthPct !== null ? `${bat.healthPct}% health` : `${bat.level}%`}
              sub={
                (bat.cycleCount !== null ? `${bat.cycleCount} cycles` : '') +
                (bat.tempC !== null ? `  ·  ${bat.tempC}°C` : '')
              }
              tint={batteryColor(bat.healthPct)}
            />
          ) : null}
          {info.telephony ? (
            <Tile
              icon="signal"
              label="Cellular"
              value={info.simStatus ? `SIM ${info.simStatus}` : 'Cellular'}
              sub={info.baseband ? `Baseband ${info.baseband}` : undefined}
              tint="#10b981"
            />
          ) : null}
          {info.regionInfo ? (
            <Tile icon="globe" label="Region" value={info.regionInfo} tint="#f59e0b" />
          ) : null}
          {info.timeZone ? (
            <Tile
              icon="clock"
              label="Time Zone"
              value={info.timeZone}
              sub={info.uses24h ? '24-hour clock' : '12-hour clock'}
              tint="#3b82f6"
            />
          ) : null}
          <Tile
            icon="shield"
            label="Security"
            value={info.passwordProtected ? 'Passcode set' : 'No passcode'}
            sub={info.activated ? 'Activated' : 'Not activated'}
            tint={info.passwordProtected ? '#22c55e' : '#94a3b8'}
          />
        </div>

        {/* Details */}
        {info.details.length > 0 ? (
          <div className="dinfo-details">
            <div className="dinfo-details-head">Device details</div>
            <div className="dinfo-details-grid">
              {info.details.map(([k, v]) => (
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
