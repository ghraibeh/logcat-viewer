/**
 * Shared device toolbar (device row): device picker + refresh + Wi-Fi + Mirror
 * + theme + About. App selection lives in the left-hand AppPickerPanel now.
 * Stream controls (Start/Pause/Clear) live in the filter bar, exactly as in ui.py.
 */
import type { Controller } from '../state/useAppController'
import { Icon } from './Icon'
import type { ThemeMode } from '../theme'

const PHASE3 = 'Available in a later migration phase'

export function Toolbar({
  c,
  onAbout,
  onMirror,
  onIosInput,
  mirrorOpen,
  theme,
  onToggleTheme
}: {
  c: Controller
  onAbout: () => void
  onMirror: () => void
  onIosInput: () => void
  mirrorOpen: boolean
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
        {noAdb ? (
          <select disabled style={{ flex: 1 }}>
            <option>adb not found — set $ADB or add to PATH</option>
          </select>
        ) : (
          <select
            style={{ flex: 1 }}
            value={c.serial ?? ''}
            onChange={(e) => c.setSerial(e.target.value || null)}
          >
            {c.devices.length === 0 ? (
              <option value="">no devices — is one connected?</option>
            ) : (
              c.devices.map((d) => (
                <option key={d.serial} value={d.serial}>
                  {d.label}
                </option>
              ))
            )}
          </select>
        )}
        <button className="toggle" title="Refresh device list" onClick={() => void c.refreshDevices()}>
          <Icon name="refresh" size={16} />
        </button>
        <button className="toggle" title={`Connect over Wi-Fi — ${PHASE3}`} disabled>
          <Icon name="wifi" size={16} />
        </button>
        <div style={{ flex: 1 }} />
        <button
          className={mirrorOpen ? 'active' : undefined}
          title="Mirror the device's screen"
          disabled={!hasDevice}
          onClick={onMirror}
        >
          Mirror
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
        <button className="toggle" title="About AndroidLabKit" onClick={onAbout}>
          <Icon name="info" size={16} />
        </button>
      </div>
    </div>
  )
}
