/**
 * Shared device toolbar (device row): device picker + refresh + one Screen-mirroring
 * button + theme + About. The single mirroring button opens the intent-first chooser
 * (ScreenChooser) which routes to adb mirror / AirPlay / the MobileLabKit protocol —
 * no more four separate mechanism toggles. App selection lives in the left AppPickerPanel.
 */
import type { Controller } from '../state/useAppController'
import { Icon } from './Icon'
import { DevicePicker } from './DevicePicker'
import type { ThemeMode } from '../theme'

export function Toolbar({
  c,
  onAbout,
  onMirrorHub,
  onIosInput,
  mirrorHubOpen,
  theme,
  onToggleTheme
}: {
  c: Controller
  onAbout: () => void
  /** Open/close the Screen-mirroring hub (the chooser that routes to every path). */
  onMirrorHub: () => void
  onIosInput: () => void
  mirrorHubOpen: boolean
  theme: ThemeMode
  onToggleTheme: () => void
}) {
  const noAdb = c.adbReady && !c.adbPath
  const isIos = c.platform === 'ios'

  return (
    <div className="toolbar">
      <div className="row toolbar-pad-left">
        <span className="label">Device</span>
        <DevicePicker
          devices={c.devices}
          serial={c.serial}
          connection={c.connection}
          onPick={(serial, transport) => c.selectDevice(serial, transport)}
          noAdb={noAdb}
        />
        <button className="toggle" title="Refresh device list" onClick={() => void c.refreshDevices()}>
          <Icon name="refresh" size={16} />
        </button>
        <div style={{ flex: 1 }} />
        <button
          className={mirrorHubOpen ? 'active' : undefined}
          title="Screen mirroring — mirror a device here, or cast this Mac to a phone"
          onClick={onMirrorHub}
        >
          <Icon name="monitor" size={15} />
          <span style={{ marginLeft: 6 }}>Screen mirroring</span>
        </button>
        {isIos ? (
          <button className="toggle" title="iOS touch input — signing settings" onClick={onIosInput}>
            <Icon name="gear" size={16} />
          </button>
        ) : null}
        <button
          className="toggle"
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={onToggleTheme}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
        <button className="toggle" title="About MobileLabKit" onClick={onAbout}>
          <Icon name="info" size={16} />
        </button>
      </div>
    </div>
  )
}
