/**
 * Shared device toolbar (device row) — port of ui.py's row1: device picker +
 * refresh + Wi-Fi + Install + app picker + reload + Pull + Mirror + About.
 * Stream controls (Start/Pause/Clear) live in the filter bar, exactly as in ui.py.
 */
import type { Controller } from '../state/useAppController'
import { Icon } from './Icon'
import type { ThemeMode } from '../theme'

const PHASE3 = 'Available in a later migration phase'

export function Toolbar({
  c,
  onInstall,
  onAbout,
  onMirror,
  mirrorOpen,
  theme,
  onToggleTheme
}: {
  c: Controller
  onInstall: () => void
  onAbout: () => void
  onMirror: () => void
  mirrorOpen: boolean
  theme: ThemeMode
  onToggleTheme: () => void
}) {
  const noAdb = c.adbReady && !c.adbPath
  const hasDevice = !!c.serial

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
        <button
          title="Install APK(s) to the selected device"
          disabled={!hasDevice}
          onClick={onInstall}
        >
          Install…
        </button>

        <div style={{ width: 6 }} />
        <span className="label">App</span>
        <select
          style={{ flex: 1 }}
          value={c.appPkg ?? ''}
          disabled={!hasDevice}
          onChange={(e) => void c.selectApp(e.target.value || null)}
        >
          <option value="">All apps</option>
          {c.apps.map((a) => (
            <option key={a.pkg} value={a.pkg}>
              {a.clone ? `${a.pkg}   (clone)` : a.pkg}
            </option>
          ))}
        </select>
        <button
          className="toggle"
          title="Reload installed / running apps"
          disabled={!hasDevice}
          onClick={() => void c.reloadApps()}
        >
          <Icon name="refresh" size={16} />
        </button>
        <button title={`Pull the selected app's APK(s) — ${PHASE3}`} disabled>
          Pull
        </button>

        <div style={{ width: 6 }} />
        <button
          className={mirrorOpen ? 'active' : undefined}
          title="Mirror the device's screen"
          disabled={!hasDevice}
          onClick={onMirror}
        >
          Mirror
        </button>
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
