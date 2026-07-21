/**
 * "Get the MobileLabKit Android app" — a compact QR + link shown in the two flows that need
 * the phone app (Receive from an Android app · Cast this Mac). Someone who doesn't have the app
 * yet looks exactly here, so the download lives beside the "open MobileLabKit Mirror" step.
 *
 * The QR is a styled PLACEHOLDER (the recognizable finder squares) until the real store/download
 * URL exists — swap MLK_ANDROID_URL below and drop in a real QR then; the visible link already
 * carries the address so it's usable in the meantime.
 */

/** Placeholder download URL — replace with the real Play Store / APK download link. */
export const MLK_ANDROID_URL = 'mobilelabkit.app/android'

/** A QR "finder" square (the three big corner markers) at module (x,y) on a 25-module grid. */
function Finder({ x, y }: { x: number; y: number }): JSX.Element {
  return (
    <>
      <rect x={x} y={y} width="7" height="7" fill="#111" />
      <rect x={x + 1} y={y + 1} width="5" height="5" fill="#fff" />
      <rect x={x + 2} y={y + 2} width="3" height="3" fill="#111" />
    </>
  )
}

export function AppQr(): JSX.Element {
  // A sparse, static scatter so it reads as a QR without pretending to be scannable.
  const dots = [
    [10, 2], [12, 3], [14, 2], [16, 3], [10, 4], [13, 5],
    [2, 10], [4, 11], [3, 13], [5, 10], [2, 15], [4, 16],
    [10, 10], [12, 11], [11, 13], [13, 14], [10, 15], [14, 16], [12, 17],
    [18, 10], [20, 11], [22, 10], [19, 13], [21, 15], [18, 16], [22, 17],
    [10, 20], [12, 22], [14, 21], [16, 22], [18, 20], [20, 22], [22, 20]
  ]
  return (
    <div className="appqr">
      <div className="appqr-code" aria-hidden="true">
        <svg viewBox="0 0 25 25" width="76" height="76" role="img">
          <rect x="0" y="0" width="25" height="25" fill="#fff" rx="1.5" />
          <Finder x={0} y={0} />
          <Finder x={18} y={0} />
          <Finder x={0} y={18} />
          {dots.map(([x, y]) => (
            <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#111" />
          ))}
        </svg>
      </div>
      <div className="appqr-info">
        <div className="appqr-title">Don’t have the app?</div>
        <div className="appqr-sub">Scan to install MobileLabKit on Android, or open:</div>
        <code className="appqr-url">{MLK_ANDROID_URL}</code>
      </div>
    </div>
  )
}
