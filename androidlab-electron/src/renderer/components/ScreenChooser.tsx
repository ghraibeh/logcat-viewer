/**
 * Screen-mirroring hub — one intent-first chooser that replaces the old four toolbar toggles
 * (adb mirror / AirPlay / MobileLabKit receiver / cast). The user picks by what they want to do
 * (see a device here · show this Mac) and by device; the app owns which mechanism runs. Each
 * requirement/trade-off is taught inline via a badge, so nobody needs to know "adb" or "AirPlay".
 * Lives in the shared right-side dock; picking a row hands off to that path's own dock.
 */
import type { Platform } from '@shared/types'
import { Icon, type IconName } from './Icon'
import { Marquee } from './Marquee'

export type MirrorPick = 'device' | 'mlkReceiver' | 'airplay' | 'mlkCast'

function Row({
  dir,
  icon,
  name,
  sub,
  badges,
  recommended,
  disabled,
  onClick
}: {
  dir: 'in' | 'out'
  icon: IconName
  name: string
  sub: string
  badges: { text: string; kind?: 'req' | 'good' | 'info' }[]
  recommended?: boolean
  disabled?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button className={`hub-row dir-${dir}`} disabled={disabled} onClick={onClick}>
      <span className="hub-ic">
        <Icon name={icon} size={20} />
      </span>
      <span className="hub-meta">
        <span className="hub-name">
          {name}
          {recommended ? <span className="hub-rec">Recommended</span> : null}
        </span>
        <Marquee text={sub} className="hub-sub" />
        <span className="hub-badges">
          {badges.map((b) => (
            <span key={b.text} className={`hub-badge${b.kind ? ` ${b.kind}` : ''}`}>
              {b.text}
            </span>
          ))}
        </span>
      </span>
      <span className="hub-chev">
        <Icon name="chevronRight" size={16} />
      </span>
    </button>
  )
}

export function ScreenChooser({
  hasDevice,
  deviceName,
  platform,
  onPick,
  onClose
}: {
  hasDevice: boolean
  deviceName: string
  platform: Platform
  onPick: (kind: MirrorPick) => void
  onClose: () => void
}): JSX.Element {
  const isIos = platform === 'ios'
  return (
    <div className="mlk-mirror-dock">
      <div className="mlk-mirror-rail">
        <span className="mlk-mirror-title">
          <Icon name="monitor" size={14} /> Screen mirroring
        </span>
        <span className="mlk-mirror-spacer" />
        <button className="toggle" title="Close" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      <div className="mlk-mirror-body">
        <div className="hub">
          <div className="hub-label">See a device here</div>
          <div className="hub-rows">
            <Row
              dir="in"
              icon={isIos ? 'apple' : 'android'}
              name={hasDevice ? (isIos ? 'Mirror this device' : 'Mirror & control') : 'Mirror a connected device'}
              sub={
                hasDevice
                  ? isIos
                    ? deviceName
                    : `${deviceName} — tap, type, install, record`
                  : 'Connect an Android over USB (or wireless adb)'
              }
              badges={
                isIos
                  ? [{ text: 'USB' }, { text: 'View-only' }]
                  : [{ text: 'USB debugging', kind: 'req' }, { text: 'Interactive', kind: 'good' }, { text: 'Low latency' }]
              }
              recommended={hasDevice}
              disabled={!hasDevice}
              onClick={() => onPick('device')}
            />
            <Row
              dir="in"
              icon="receiveScreen"
              name="Receive from an Android app"
              sub="Any phone — no debugging needed"
              badges={[{ text: 'MobileLabKit app', kind: 'info' }, { text: 'View-only' }, { text: 'Wi-Fi' }]}
              onClick={() => onPick('mlkReceiver')}
            />
            <Row
              dir="in"
              icon="airplay"
              name="AirPlay from iPhone / iPad"
              sub="Nothing to install — Control Center ▸ Screen Mirroring"
              badges={[{ text: 'No setup', kind: 'good' }, { text: 'View-only' }]}
              onClick={() => onPick('airplay')}
            />
          </div>

          <div className="hub-label">Show this Mac</div>
          <div className="hub-rows">
            <Row
              dir="out"
              icon="laptop"
              name="Cast this Mac to a phone"
              sub="Your screen on an Android device"
              badges={[{ text: 'MobileLabKit app', kind: 'info' }, { text: '1080p · 1440p · Max' }]}
              onClick={() => onPick('mlkCast')}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
