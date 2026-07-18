/**
 * Custom device dropdown. Unlike a native <select>, it groups by device and, when
 * a device is reachable over more than one transport (USB + Wi-Fi), shows a
 * sub-entry per transport with a marker icon so the user can pick which one to
 * use. Single-transport devices collapse to one clickable row.
 */
import { useEffect, useRef, useState } from 'react'
import type { Device, Transport } from '@shared/types'
import { Icon } from './Icon'

const TRANSPORT_LABEL: Record<Transport, string> = { usb: 'USB', wifi: 'Wi-Fi' }
const TRANSPORT_ICON: Record<Transport, 'usb' | 'wifi'> = { usb: 'usb', wifi: 'wifi' }

function TransportTag({ t }: { t: Transport }) {
  return (
    <span className={`dp-tag dp-tag-${t}`}>
      <Icon name={TRANSPORT_ICON[t]} size={12} />
      {TRANSPORT_LABEL[t]}
    </span>
  )
}

export function DevicePicker({
  devices,
  serial,
  connection,
  onPick,
  noAdb
}: {
  devices: Device[]
  serial: string | null
  connection: Transport
  onPick: (serial: string, transport: Transport) => void
  noAdb: boolean
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = devices.find((d) => d.serial === serial) ?? null

  const pick = (s: string, t: Transport): void => {
    onPick(s, t)
    setOpen(false)
  }

  if (noAdb) {
    return (
      <div className="dp" ref={rootRef}>
        <button className="dp-trigger" disabled>
          adb not found — set $ADB or add to PATH
        </button>
      </div>
    )
  }

  return (
    <div className="dp" ref={rootRef}>
      <button
        className="dp-trigger"
        disabled={devices.length === 0}
        onClick={() => setOpen((v) => !v)}
        title={selected ? selected.label : undefined}
      >
        {selected ? (
          <>
            <TransportTag t={connection} />
            <span className="dp-trigger-label">{selected.label}</span>
          </>
        ) : (
          <span className="dp-trigger-label dp-dim">no devices — is one connected?</span>
        )}
        <Icon name="chevronDown" size={14} />
      </button>

      {open && devices.length > 0 ? (
        <div className="dp-menu" role="listbox">
          {devices.map((d) => {
            const transports = d.transports.length ? d.transports : (['usb'] as Transport[])
            const multi = transports.length > 1
            return (
              <div key={d.serial} className="dp-group">
                {multi ? <div className="dp-devlabel">{d.label}</div> : null}
                {transports.map((t) => {
                  const active = d.serial === serial && t === connection
                  return (
                    <button
                      key={t}
                      className={`dp-row${multi ? ' dp-row-sub' : ''}${active ? ' dp-row-active' : ''}`}
                      onClick={() => pick(d.serial, t)}
                    >
                      <TransportTag t={t} />
                      <span className="dp-row-label">{multi ? TRANSPORT_LABEL[t] : d.label}</span>
                      {active ? <Icon name="check" size={14} /> : null}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
