/**
 * Device Controls — port of controls.py's ControlsView: settings-style cards of
 * toggle switches + segmented pills + sliders that read every control in one
 * round-trip and apply setters as adb argv sequences (re-reading after each).
 * The standby-bucket + app-locale rows follow the shared App picker.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import * as C from '@core/controls'
import type { ControlsState } from '@core/controls'
import type { Controller } from '../state/useAppController'
import { ConfirmDialog } from './dialogs'
import { Icon } from './Icon'

type Argvs = string[][]

function Switch({
  on,
  disabled,
  title,
  onToggle
}: {
  on: boolean
  disabled?: boolean
  title?: string
  onToggle: (next: boolean) => void
}) {
  return (
    <button
      className={`switch${on ? ' on' : ''}`}
      disabled={disabled}
      title={title}
      aria-pressed={on}
      onClick={() => onToggle(!on)}
    />
  )
}

function Segments<T extends string | number>({
  items,
  value,
  disabled,
  onPick
}: {
  items: Array<[string, T]>
  value: T | null | undefined
  disabled?: boolean
  onPick: (data: T, label: string) => void
}) {
  return (
    <div className="seg-wrap">
      {items.map(([label, data]) => (
        <button
          key={String(data)}
          className={`seg${data === value ? ' checked' : ''}`}
          disabled={disabled}
          onClick={() => onPick(data, label)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function Row({
  title,
  desc,
  first,
  children
}: {
  title: string
  desc?: string
  first?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`ctrl-row${first ? ' first' : ''}`}>
      <div className="text">
        <div className="t">{title}</div>
        {desc ? <div className="d">{desc}</div> : null}
      </div>
      {children}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ctrl-card">
      <div className="ctrl-cap">{title}</div>
      {children}
    </div>
  )
}

function nearestFont(fs: number): number {
  return C.FONT_SCALES.reduce((best, it) => (Math.abs(it[1] - fs) < Math.abs(best - fs) ? it[1] : best), 1.0)
}

export function ControlsView({ c, onViewSecondary }: { c: Controller; onViewSecondary: () => void }) {
  const [st, setSt] = useState<ControlsState | null>(null)
  const [status, setStatus] = useState('')
  const [bright, setBright] = useState(128)
  const [batt, setBatt] = useState(100)
  const [densityText, setDensityText] = useState('')
  const [localeText, setLocaleText] = useState('')
  const [proxyText, setProxyText] = useState('')
  const [confirm, setConfirm] = useState<{ title: string; body: string; button: string; onConfirm: () => void } | null>(null)
  const pkg = c.appPkg
  const busyRef = useRef(false)

  const read = useCallback(async () => {
    if (!c.serial) {
      setSt(null)
      return
    }
    const r = await window.androidlab.controls.read(c.serial, pkg)
    if (!r.ok || !r.state) {
      setStatus(`✗ ${r.message}`)
      return
    }
    setSt(r.state)
    setBright(r.state.brightness)
    if (r.state.batteryLevel !== null) setBatt(r.state.batteryLevel)
    if (r.state.density) setDensityText(String(r.state.density))
    setProxyText(r.state.proxy)
    if (pkg && r.state.appLocales !== undefined) setLocaleText(r.state.appLocales)
  }, [c.serial, pkg])

  useEffect(() => {
    void read()
  }, [read])

  const apply = useCallback(
    async (argvs: Argvs, label: string) => {
      if (!c.serial) {
        setStatus('✗ no device selected')
        return
      }
      if (busyRef.current) return
      busyRef.current = true
      setStatus(`… ${label}`)
      const r = await window.androidlab.controls.apply(c.serial, argvs, label)
      busyRef.current = false
      setStatus(r.ok ? `✓ ${label}` : `✗ ${r.message}`)
      await read()
    },
    [c.serial, read]
  )

  // Reboot / power-off run the same apply IPC, but we skip the state re-read —
  // the device drops off adb while it reboots or powers down.
  const runPower = useCallback(
    async (argvs: Argvs, label: string) => {
      if (!c.serial) {
        setStatus('✗ no device selected')
        return
      }
      setStatus(`… ${label}`)
      const r = await window.androidlab.controls.apply(c.serial, argvs, label)
      setStatus(r.ok ? `✓ ${label} — device disconnecting…` : `✗ ${r.message}`)
    },
    [c.serial]
  )

  // "👁 View": ensure a secondary display exists (create a 720p one if off),
  // then hand off to the mirror to open on it. Port of controls.py._view_secondary.
  const viewSecondary = useCallback(async () => {
    if (!c.serial) {
      setStatus('✗ no device selected')
      return
    }
    if (!st?.overlay) {
      await apply(C.setOverlayDisplay(C.OVERLAYS[2][1]), 'Secondary display 720p') // 720p
    }
    onViewSecondary()
  }, [c.serial, st?.overlay, apply, onViewSecondary])

  const askPower = (a: C.PowerAction): void => {
    setConfirm({
      title: `${a.title}?`,
      body: a.danger
        ? 'Power the device off? You will need physical access to turn it back on.'
        : `${a.desc}. This drops the adb connection until the device finishes booting.`,
      button: a.button,
      onConfirm: () => {
        setConfirm(null)
        void runPower(a.argvs, a.title)
      }
    })
  }

  const askReset = (a: C.ResetAction): void => {
    setConfirm({
      title: a.confirmTitle,
      body: a.confirmBody,
      button: a.confirmButton,
      onConfirm: () => {
        setConfirm(null)
        // Factory reset reboots/wipes → skip the re-read (runPower); the rest
        // keep the device online, so apply() re-reads state afterwards.
        if (a.disconnects) void runPower(a.argvs, a.title)
        else void apply(a.argvs, a.title)
      }
    })
  }

  const enableWireless = useCallback(async () => {
    if (!c.serial) {
      setStatus('✗ no device selected')
      return
    }
    if (busyRef.current) return
    busyRef.current = true
    setStatus('… enabling wireless debugging')
    const r = await window.androidlab.wireless.enable(c.serial)
    busyRef.current = false
    setStatus(r.ok ? `✓ wireless adb — ${r.message}` : `✗ ${r.message}`)
  }, [c.serial])

  const chips: Array<[string, string]> = []
  if (st?.batteryLevel !== null && st?.batteryLevel !== undefined) {
    chips.push(
      st.batteryPowered
        ? [`🔋 ${st.batteryLevel}%`, '']
        : [`🔋 ${st.batteryLevel}% · unplugged`, 'warn']
    )
  }
  if (st?.dozeIdle) chips.push(['😴 dozing', 'warn'])
  if (st?.airplane) chips.push(['✈ airplane', 'warn'])
  if (st?.batterySaver) chips.push(['⚡ saver', 'warn'])
  if (st?.proxy) chips.push([`🌐 proxy · ${st.proxy}`, 'warn'])
  const bucket = C.bucketName(st?.bucket)
  if (pkg && st?.bucket) chips.push([`bucket · ${bucket || st.bucket}`, 'accent'])

  const disabled = !c.serial

  return (
    <div className="ctrl-view">
      <div className="ctrl-head">
        <span className="ctrl-heading">Device Controls</span>
        <div className="ctrl-chips">
          {status ? <span className="ctrl-status">{status}</span> : null}
          {chips.map(([text, tone], i) => (
            <span key={i} className={`ctrl-chip${tone ? ' ' + tone : ''}`}>
              {text}
            </span>
          ))}
          <button disabled={disabled} title="Re-read every toggle's state" onClick={() => void read()}>
            <Icon name="refresh" size={15} />
            Refresh
          </button>
        </div>
      </div>

      <div className="ctrl-scroll">
        <div className="ctrl-cols">
          {/* Left column */}
          <div className="ctrl-col">
            <Card title="DISPLAY">
              <Row title="Dark mode" desc="Force the system night mode" first>
                <Switch on={!!st?.night} disabled={disabled} onToggle={(v) => apply(C.setNight(v), `Dark mode ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Font scale" desc="System-wide text size">
                <Segments items={C.FONT_SCALES} value={st ? nearestFont(st.fontScale) : null} disabled={disabled}
                  onPick={(d, l) => apply(C.setFontScale(d), `Font scale ${l}`)} />
              </Row>
              <Row title="Density" desc="Override the display density (dpi)">
                <input className="line-edit ctrl-input" type="text" value={densityText} disabled={disabled}
                  onChange={(e) => setDensityText(e.target.value)} />
                <button className="toggle" disabled={disabled} onClick={() => {
                  const t = densityText.trim()
                  if (/^\d+$/.test(t)) void apply(C.setDensity(parseInt(t, 10)), `Density ${t} dpi`)
                  else setStatus('✗ density must be a number')
                }}>Set</button>
                <button className="toggle" disabled={disabled} onClick={() => apply(C.setDensity(null), 'Density reset')}>Reset</button>
              </Row>
              <Row title="Brightness" desc="Drag and release to apply (0–255)">
                <input className="ctrl-range" type="range" min={1} max={255} value={bright} disabled={disabled}
                  onChange={(e) => setBright(Number(e.target.value))}
                  onMouseUp={() => apply(C.setBrightness(bright), `Brightness ${bright}`)} />
                <span className="ctrl-chip">{bright}</span>
              </Row>
              <Row title="Auto brightness" desc="Adaptive brightness on/off">
                <Switch on={!!st?.brightAuto} disabled={disabled} onToggle={(v) => apply(C.setAutoBrightness(v), `Auto brightness ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Screen timeout" desc="Idle time before the screen sleeps">
                <Segments items={C.TIMEOUTS} value={st?.timeoutMs} disabled={disabled}
                  onPick={(d, l) => apply(C.setScreenTimeout(d), `Screen timeout ${l}`)} />
              </Row>
              <Row title="Rotation" desc="Auto-rotate or lock an orientation">
                <Segments items={C.ROTATIONS} value={st?.rotation} disabled={disabled}
                  onPick={(d, l) => apply(C.setRotation(d), `Rotation ${l}`)} />
              </Row>
            </Card>

            <Card title="CONNECTIVITY">
              <Row title="Wi-Fi" desc="Toggle the Wi-Fi radio" first>
                <Switch on={!!st?.wifi} disabled={disabled} title="careful: kills a wireless-adb link" onToggle={(v) => apply(C.setWifi(v), `Wi-Fi ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Mobile data" desc="Toggle cellular data">
                <Switch on={!!st?.data} disabled={disabled} onToggle={(v) => apply(C.setMobileData(v), `Mobile data ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Airplane mode" desc="All radios off — test offline behavior">
                <Switch on={!!st?.airplane} disabled={disabled} title="careful: kills a wireless-adb link" onToggle={(v) => apply(C.setAirplane(v), `Airplane ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Bluetooth" desc="Toggle the Bluetooth radio">
                <Switch on={!!st?.bluetooth} disabled={disabled} onToggle={(v) => apply(C.setBluetooth(v), `Bluetooth ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Location" desc="Toggle location services">
                <Switch on={!!st?.location} disabled={disabled} onToggle={(v) => apply(C.setLocation(v), `Location ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Data saver" desc="Restrict background data — test app behavior">
                <Switch on={!!st?.dataSaver} disabled={disabled} onToggle={(v) => apply(C.setDataSaver(v), `Data saver ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="HTTP proxy" desc="Route all apps through host:port (e.g. Charles/Burp)">
                <input className="line-edit ctrl-input wide" type="text" value={proxyText} disabled={disabled}
                  placeholder="192.168.1.5:8888"
                  onChange={(e) => setProxyText(e.target.value)} />
                <button className="toggle" disabled={disabled} onClick={() => {
                  const t = proxyText.trim()
                  if (C.isValidProxy(t)) void apply(C.setProxy(t), `Proxy → ${t}`)
                  else setStatus('✗ proxy must be host:port')
                }}>Set</button>
                <button className="toggle" disabled={disabled} onClick={() => { setProxyText(''); void apply(C.clearProxy(), 'Proxy reset') }}>Reset</button>
              </Row>
              <Row title="Wireless debugging" desc="Switch this USB device to Wi-Fi adb (tcpip 5555 + connect)">
                <button className="toggle" disabled={disabled}
                  title="Connect over USB first, then unplug once connected"
                  onClick={() => void enableWireless()}>Enable</button>
              </Row>
            </Card>

            <Card title="POWER & BACKGROUND">
              <Row title="Mock battery" desc="Fake a level — the device acts unplugged" first>
                <input className="ctrl-range" type="range" min={1} max={100} value={batt} disabled={disabled}
                  onChange={(e) => setBatt(Number(e.target.value))} />
                <span className="ctrl-chip">{batt}%</span>
                <button className="toggle" disabled={disabled} onClick={() => apply(C.setBatteryLevel(batt), `Battery mocked to ${batt}%`)}>Apply</button>
                <button className="toggle" disabled={disabled} onClick={() => apply(C.resetBattery(), 'Battery reset')}>Reset</button>
              </Row>
              <Row title="Battery saver" desc="Low-power mode (takes effect unplugged)">
                <Switch on={!!st?.batterySaver} disabled={disabled} onToggle={(v) => apply(C.setBatterySaver(v), `Battery saver ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Force Doze" desc="Deep idle now (unplugs the battery first)">
                <Switch on={!!st?.dozeIdle} disabled={disabled} onToggle={(v) => apply(C.setDoze(v), `Doze ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Standby bucket" desc="Background budget for the picked app">
                <Segments items={C.BUCKETS.map((b) => [b.replace('_', ' '), b]) as Array<[string, string]>}
                  value={pkg ? bucket : null} disabled={disabled || !pkg}
                  onPick={(d, l) => pkg && apply(C.setStandbyBucket(pkg, d), `${pkg} → ${l} bucket`)} />
              </Row>
              <div className="ctrl-note">{pkg ? `App: ${pkg}` : 'Pick an app in the App box to set its bucket'}</div>
            </Card>
          </div>

          {/* Right column */}
          <div className="ctrl-col">
            <Card title="DEBUG OVERLAYS">
              <Row title="Layout bounds" desc="Outline every view's clip bounds" first>
                <Switch on={!!st?.layout} disabled={disabled} onToggle={(v) => apply(C.setLayoutBounds(v), `Layout bounds ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Show taps" desc="Visual feedback where touches land">
                <Switch on={!!st?.showTouches} disabled={disabled} onToggle={(v) => apply(C.setShowTouches(v), `Show taps ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Pointer location" desc="Crosshair trace + coordinate bar">
                <Switch on={!!st?.pointer} disabled={disabled} onToggle={(v) => apply(C.setPointerLocation(v), `Pointer location ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="GPU profile bars" desc="On-screen frame-time bars per window">
                <Switch on={!!st?.hwui} disabled={disabled} onToggle={(v) => apply(C.setHwuiProfile(v), `GPU bars ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="GPU overdraw" desc="Tint areas drawn more than once">
                <Switch on={!!st?.overdraw} disabled={disabled} onToggle={(v) => apply(C.setOverdraw(v), `Overdraw ${v ? 'on' : 'off'}`)} />
              </Row>
            </Card>

            <Card title="SIMULATION">
              <Row title="Force RTL" desc="Mirror every layout right-to-left" first>
                <Switch on={!!st?.rtl} disabled={disabled} onToggle={(v) => apply(C.setForceRtl(v), `Force RTL ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Color space" desc="Simulate color blindness (daltonizer)">
                <Segments items={C.DALTONIZER} value={st?.dalt} disabled={disabled}
                  onPick={(d, l) => apply(C.setColorSpace(d), `Color space ${l}`)} />
              </Row>
              <Row title="Secondary display" desc="Simulate an extra display (overlay window)">
                <Segments items={C.OVERLAYS} value={st?.overlay} disabled={disabled}
                  onPick={(d, l) => apply(C.setOverlayDisplay(d), `Secondary display ${l}`)} />
                <button
                  className="toggle"
                  disabled={disabled}
                  title="Mirror the secondary display (creates a 720p one first if it's off)"
                  onClick={() => void viewSecondary()}
                >
                  <Icon name="eye" size={15} />
                  View
                </button>
              </Row>
              <Row title="App locale" desc="Per-app language (Android 13+)">
                <input className="line-edit ctrl-input" type="text" value={localeText} disabled={disabled || !pkg}
                  placeholder="en, fr, ar…" onChange={(e) => setLocaleText(e.target.value)} />
                <button className="toggle" disabled={disabled || !pkg} onClick={() => pkg && apply(C.setAppLocale(pkg, localeText.trim()), `${pkg} locale → ${localeText.trim() || 'system default'}`)}>Set</button>
                <button className="toggle" disabled={disabled || !pkg} onClick={() => pkg && apply(C.setAppLocale(pkg, ''), `${pkg} locale → system default`)}>Reset</button>
              </Row>
              <div className="ctrl-note">{pkg ? `App: ${pkg}` : 'Pick an app in the App box to set its locale'}</div>
            </Card>

            <Card title="BEHAVIOR">
              <Row title="Animations off" desc="Window, transition + animator scales to 0" first>
                <Switch on={!!st?.animOff} disabled={disabled} onToggle={(v) => apply(C.setAnimations(v), `Animations ${v ? 'off' : 'on'}`)} />
              </Row>
              <Row title="Don't keep activities" desc="Destroy every activity once left">
                <Switch on={!!st?.finish} disabled={disabled} onToggle={(v) => apply(C.setFinishActivities(v), `Don't keep activities ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Stay awake" desc="Screen never sleeps while charging">
                <Switch on={!!st?.stay} disabled={disabled} onToggle={(v) => apply(C.setStayAwake(v), `Stay awake ${v ? 'on' : 'off'}`)} />
              </Row>
              <Row title="Background ANRs" desc="Show ANR dialogs for background apps">
                <Switch on={!!st?.anr} disabled={disabled} onToggle={(v) => apply(C.setShowAnrs(v), `Background ANRs ${v ? 'on' : 'off'}`)} />
              </Row>
            </Card>

            <Card title="SYSTEM">
              {C.POWER_ACTIONS.map((a, i) => (
                <Row key={a.key} title={a.title} desc={a.desc} first={i === 0}>
                  <button
                    className={`toggle${a.danger ? ' danger' : ''}`}
                    disabled={disabled}
                    onClick={() => askPower(a)}
                  >
                    {a.button}
                  </button>
                </Row>
              ))}
              <div className="ctrl-note">
                Reboots drop the adb link — the device reappears once it finishes booting. Fastboot
                flashing needs the separate <code>fastboot</code> tool and isn&apos;t available here.
              </div>
            </Card>

            <Card title="RESET">
              {C.RESET_ACTIONS.map((a, i) => (
                <Row key={a.key} title={a.title} desc={a.desc} first={i === 0}>
                  <button
                    className={`toggle${a.key === 'factory' ? ' danger' : ''}`}
                    disabled={disabled}
                    onClick={() => askReset(a)}
                  >
                    {a.key === 'factory' ? 'Erase' : 'Reset'}
                  </button>
                </Row>
              ))}
              <div className="ctrl-note">
                Direct adb resets. Factory reset needs the <code>MASTER_CLEAR</code> permission
                (emulator / rooted only) — it fails with a permission error on locked production
                builds.
              </div>
            </Card>
          </div>
        </div>
      </div>

      {confirm ? (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.button}
          onConfirm={confirm.onConfirm}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
    </div>
  )
}
