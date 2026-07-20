/**
 * About dialog — port of logcat_viewer/about.py (identity, version, feature
 * summary, author credit) with the app icon drawn inline.
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

/** The MobileLabKit app icon (matches build/icon.png), drawn inline as SVG so it
 *  stays crisp at any size and needs no bundled asset. The split mascot: Android
 *  green on the left (antenna), iOS silver on the right (leaf + bite). The bite
 *  is a disc filled with the same background gradient (userSpaceOnUse, so it
 *  lines up pixel-perfect with the tile behind it). */
function Logo() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden>
      <defs>
        <linearGradient id="al-bg" x1="0" y1="100" x2="0" y2="924" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#24272d" />
          <stop offset="1" stopColor="#141519" />
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
      <g transform="translate(-9 0)">
        <line x1="380" y1="310" x2="322" y2="218" stroke="#3DDC84" strokeWidth="28" strokeLinecap="round" />
        <path d="M 512 310 C 462 255 362 258 320 320 C 278 382 285 500 340 580 C 378 635 436 648 512 622 Z" fill="#3DDC84" />
        <circle cx="438" cy="415" r="24" fill="#101215" />
      </g>
      <g transform="translate(9 0)">
        <path d="M 512 310 C 562 255 662 258 704 320 C 746 382 739 500 684 580 C 646 635 588 648 512 622 Z" fill="#E4E7EB" />
        <circle cx="722" cy="516" r="64" fill="url(#al-bg)" />
        <ellipse cx="585" cy="248" rx="44" ry="18" transform="rotate(-32 585 248)" fill="#3DDC84" />
        <circle cx="586" cy="415" r="24" fill="#101215" />
      </g>
      <rect x="352" y="676" width="320" height="34" rx="17" fill="#4C8BF5" />
      <rect x="382" y="738" width="260" height="34" rx="17" fill="#F0B429" />
      <rect x="412" y="800" width="200" height="34" rx="17" fill="#F56565" />
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
        <div className="about-name">MobileLabKit</div>
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
