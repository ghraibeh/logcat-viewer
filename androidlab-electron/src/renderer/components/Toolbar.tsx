/**
 * Shared device toolbar (device row): device picker + refresh + Mirror + AirPlay
 * + theme + About. The picker is a custom dropdown (DevicePicker) that lists each
 * device's transports (USB / Wi-Fi) as pickable sub-entries. App selection lives
 * in the left-hand AppPickerPanel. Stream controls live in the filter bar, as in ui.py.
 */
import type { Controller } from '../state/useAppController'
import { Icon } from './Icon'
import { DevicePicker } from './DevicePicker'
import type { ThemeMode } from '../theme'

export function Toolbar({
  c,
  onAbout,
  onMirror,
  onAirplayReceiver,
  onMlkReceiver,
  onIosInput,
  mirrorOpen,
  airplayReceiverOn,
  mlkReceiverOn,
  theme,
  onToggleTheme
}: {
  c: Controller
  onAbout: () => void
  onMirror: () => void
  /** Toggle the standalone AirPlay receiver (works with no device connected). */
  onAirplayReceiver: () => void
  /** Toggle the Android→Mac mirror receiver (our _mlkmirror._tcp service). */
  onMlkReceiver: () => void
  onIosInput: () => void
  mirrorOpen: boolean
  airplayReceiverOn: boolean
  mlkReceiverOn: boolean
  theme: ThemeMode
  onToggleTheme: () => void
}) {
  const noAdb = c.adbReady && !c.adbPath
  const hasDevice = !!c.serial
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
          className={mirrorOpen && !airplayReceiverOn && !mlkReceiverOn ? 'active' : undefined}
          title="Mirror the device's screen"
          disabled={!hasDevice}
          onClick={onMirror}
        >
          Mirror
        </button>
        <button
          className={`toggle${airplayReceiverOn ? ' active' : ''}`}
          title="AirPlay receiver — advertise “MobileLabKit” so any iPhone on the network can mirror to it (no cable needed)"
          onClick={onAirplayReceiver}
        >
          <Icon name="airplay" size={16} />
        </button>
        <button
          className={`toggle${mlkReceiverOn ? ' active' : ''}`}
          title="Receive an Android screen — advertise this Mac so the MobileLabKit Mirror Android app can cast to it over Wi-Fi"
          onClick={onMlkReceiver}
        >
          <Icon name="receiveScreen" size={16} />
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
