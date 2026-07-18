/**
 * Empty state shown in the work area when no device is connected. Replaces the tab
 * content (and the tab bar is hidden) so the app doesn't present a wall of device
 * tools with nothing to drive. Offers two ways forward: connect a device, or — for
 * an iPhone — start the standalone AirPlay receiver right here (no cable needed).
 */
import type { Controller } from '../state/useAppController'
import { Icon } from './Icon'

export function NoDeviceView({
  c,
  airplayOn,
  onAirplay
}: {
  c: Controller
  /** Whether the standalone AirPlay receiver is currently on. */
  airplayOn: boolean
  /** Toggle the AirPlay receiver (same handler as the top-bar button). */
  onAirplay: () => void
}) {
  return (
    <div className="no-device">
      <div className="no-device-card">
        <div className="no-device-badge">
          <Icon name="monitor" size={40} />
        </div>
        <div className="no-device-title">No device connected</div>
        <div className="no-device-sub">
          Connect an Android or iOS device over USB — or Wi-Fi — to use logcat, the file
          explorer, app manager, screen mirror, and the rest of the tools.
        </div>
        <button className="no-device-refresh" onClick={() => void c.refreshDevices()}>
          <Icon name="refresh" size={16} />
          Refresh devices
        </button>

        <div className="no-device-or">
          <span>or mirror an iPhone wirelessly</span>
        </div>

        <button
          className={`no-device-airplay${airplayOn ? ' on' : ''}`}
          onClick={onAirplay}
        >
          <Icon name="airplay" size={22} />
          {airplayOn ? 'Stop AirPlay receiver' : 'Mirror an iPhone over AirPlay'}
        </button>
        <div className="no-device-hint">
          {airplayOn
            ? 'On your iPhone, open Control Center ▸ Screen Mirroring and pick “AndroidLab”. Its screen appears in the mirror panel.'
            : 'No cable needed — any iPhone on this network can mirror to AndroidLab.'}
        </div>
      </div>
    </div>
  )
}
