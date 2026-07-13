/**
 * About dialog — port of logcat_viewer/about.py (identity, version, feature
 * summary, author credit) with the same self-drawn `>_` logo mark.
 */
const VERSION = '0.1.0'
const TAGLINE = 'Live Android logcat, powerful filtering, and a full device toolkit.'
const AUTHOR = 'Mahmoud Alghraibeh'
const CONTACT = 'M.Ghraibeh@penguinin.com'
const BUILT_WITH = 'Built with Electron · TypeScript · adb'
const COPYRIGHT_YEAR = 2026

const FEATURES: Array<[string, string, string]> = [
  ['#6e7bff', 'Live logs', 'Stream & filter adb logcat by level, tag, PID, regex'],
  ['#31c96e', 'Screen mirror', 'H.264 mirroring, screenshots, and recording'],
  ['#e3a812', 'Device tools', 'Mock GPS, HTTP intercept, SQLite & file explorer'],
  ['#f25a52', 'App manager', 'Permissions, components, app-ops, APK decompile']
]

/** The AndroidLab app icon (matches build/icon.png), drawn inline as SVG so it
 *  stays crisp at any size and needs no bundled asset. */
function Logo() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden>
      <defs>
        <linearGradient id="al-bg" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#262a34" />
          <stop offset="1" stopColor="#12131a" />
        </linearGradient>
        <linearGradient id="al-hl" x1="0" y1="100" x2="0" y2="512" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.1" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <clipPath id="al-clip">
          <rect x="100" y="100" width="824" height="824" rx="184" ry="184" />
        </clipPath>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="184" ry="184" fill="url(#al-bg)" />
      <rect x="100" y="100" width="824" height="824" fill="url(#al-hl)" clipPath="url(#al-clip)" />
      <rect x="362" y="600" width="300" height="34" rx="17" fill="#5a9cff" />
      <rect x="387" y="664" width="250" height="34" rx="17" fill="#f5c451" />
      <rect x="412" y="728" width="200" height="34" rx="17" fill="#ff6b6b" />
      <path d="M302 470 A210 210 0 0 1 722 470 Z" fill="#3DDC84" />
      <g stroke="#3DDC84" strokeWidth="30" strokeLinecap="round">
        <line x1="420" y1="289.4" x2="362" y2="211.4" />
        <line x1="604" y1="289.4" x2="662" y2="211.4" />
      </g>
      <g fill="#12131a">
        <circle cx="434" cy="392" r="22" />
        <circle cx="590" cy="392" r="22" />
      </g>
    </svg>
  )
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="about" onMouseDown={(e) => e.stopPropagation()}>
        <div className="about-logo">
          <Logo />
        </div>
        <div className="about-name">AndroidLab</div>
        <div className="about-version">Version {VERSION}</div>
        <div className="about-tagline">{TAGLINE}</div>
        <div className="about-sep" />
        <div className="about-features">
          {FEATURES.map(([color, title, desc]) => (
            <div className="about-feature" key={title}>
              <span className="dot" style={{ background: color }} />
              <span className="ft">
                <b>{title}</b>
                <span>{desc}</span>
              </span>
            </div>
          ))}
        </div>
        <div className="about-sep" />
        <div className="about-credit">Designed &amp; developed by</div>
        <div className="about-author">{AUTHOR}</div>
        <div className="about-contact">
          <a
            href={`mailto:${CONTACT}`}
            onClick={(e) => {
              e.preventDefault()
              void window.androidlab.system.openPath(`mailto:${CONTACT}`)
            }}
          >
            {CONTACT}
          </a>
        </div>
        <div className="about-meta">
          {BUILT_WITH}
          {'\n'}© {COPYRIGHT_YEAR} {AUTHOR}. All rights reserved.
        </div>
        <button className="about-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}
