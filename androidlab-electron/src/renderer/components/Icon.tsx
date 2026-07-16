/**
 * Shared monochrome line-icon set + <Icon> renderer.
 *
 * Same visual language as the screen-mirror control rail: a 24×24 viewBox,
 * `currentColor` stroke at 2.2 with round caps/joins, so every icon button
 * across the app reads as one coherent system. Icons inherit the surrounding
 * button's text color (hover/active/disabled states come from the button, not
 * the icon). `size` defaults to the inline-toolbar scale; the mirror rail passes
 * a larger size.
 */
import type { ReactNode } from 'react'

export const ICON_PATHS = {
  // --- view / mirror rail ---
  fullscreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  contract: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  // Detach into a separate window (two offset window panes).
  popout: (
    <>
      <rect x="3" y="8" width="12" height="12" rx="2" />
      <path d="M9 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2" />
    </>
  ),
  // Re-attach the popout back into the app (arrow into a panel).
  popin: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M15 12H8M11 9l-3 3 3 3" />
    </>
  ),
  film: (
    <>
      <rect x="3" y="7" width="12" height="10" rx="2" />
      <path d="M15 10.5 21 7v10l-6-3.5z" />
    </>
  ),
  bolt: <path d="M13 3 5 13.5h5L9 21l8-11h-5l1-7z" fill="currentColor" stroke="none" />,
  monitor: (
    <>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M9 21h6M12 17v4" />
    </>
  ),
  back: <path d="M14.5 5 6 12l8.5 7z" />,
  home: <circle cx="12" cy="12" r="7" />,
  recents: <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />,
  volUp: (
    <>
      <path d="M4 9.5h3L11 6v12l-4-3.5H4z" />
      <path d="M16 12h4M18 10v4" />
    </>
  ),
  volDown: (
    <>
      <path d="M4 9.5h3L11 6v12l-4-3.5H4z" />
      <path d="M16 12h4" />
    </>
  ),
  power: (
    <>
      <path d="M12 4v7" />
      <path d="M8 6.6a6.5 6.5 0 1 0 8 0" />
    </>
  ),
  camera: (
    <>
      <path d="M4 8.5h3L8.5 6h7L17 8.5h3a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.2" />
    </>
  ),
  record: <circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" />,
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="none" />,
  play: <path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />,
  pause: <path d="M9 5v14M15 5v14" />,
  clipboard: (
    <>
      <rect x="6" y="5" width="12" height="16" rx="2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
    </>
  ),
  keyboard: (
    <>
      <rect x="3" y="7" width="18" height="11" rx="2" />
      <path d="M9 15h6" />
      <path d="M6.5 10.5h.01M10 10.5h.01M13.5 10.5h.01M17 10.5h.01" strokeWidth={2.8} />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6M20 4l-9 9" />
      <path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,

  // --- chrome / actions ---
  refresh: (
    <>
      <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
      <path d="M20.5 4v5.2h-5.2" />
    </>
  ),
  wifi: (
    <>
      <path d="M3 9.5a14 14 0 0 1 18 0" />
      <path d="M6.5 13a9 9 0 0 1 11 0" />
      <path d="M10 16.5a4 4 0 0 1 4 0" />
      <path d="M12 20h.01" strokeWidth={2.8} />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.6h.01" strokeWidth={2.6} />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.8-3.8" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6.5 7l.8 12.2a1 1 0 0 0 1 .8h7.4a1 1 0 0 0 1-.8L18.5 7" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
    </>
  ),
  save: (
    <>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M8 4v5h7" />
      <path d="M8 20v-6h8v6" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  moreVertical: (
    <>
      <circle cx="12" cy="5" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  upload: (
    <>
      <path d="M12 19V6" />
      <path d="M6.5 11.5 12 6l5.5 5.5" />
      <path d="M5 20h14" />
    </>
  ),
  download: (
    <>
      <path d="M12 5v13" />
      <path d="M6.5 12.5 12 18l5.5-5.5" />
      <path d="M5 20h14" />
    </>
  ),
  folder: (
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
  ),
  file: (
    <>
      <path d="M6.5 3.5h7l4 4v13h-11z" />
      <path d="M13 3.5v4.5h4.5" />
    </>
  ),
  chevronLeft: <path d="M14.5 6l-6 6 6 6" />,
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  chevronUp: <path d="M6 14.5l6-6 6 6" />,
  chevronDown: <path d="M6 9.5l6 6 6-6" />,
  filter: <path d="M4 5h16l-6.2 7.4V19l-3.6 1.8v-8.4z" />,
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6v12c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
      <path d="M5 12c0 1.66 3.13 3 7 3s7-1.34 7-3" />
    </>
  ),
  arrowUp: (
    <>
      <path d="M12 19V5.5" />
      <path d="M6 11l6-6 6 6" />
    </>
  ),
  folderPlus: (
    <>
      <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
      <path d="M12 11.5v5M9.5 14h5" />
    </>
  ),
  send: (
    <>
      <path d="M21.5 2.5 10.5 13.5" />
      <path d="M21.5 2.5 14.5 21.5l-4-8.5-8.5-4 19.5-6.5z" />
    </>
  ),
  report: (
    <>
      <path d="M6.5 3.5h7l4 4v13h-11z" />
      <path d="M13 3.5v4.5h4.5" />
      <path d="M8.5 12.5h7M8.5 16h7M8.5 9h3" />
    </>
  ),
  bug: (
    <>
      <path d="M8 9V7a4 4 0 0 1 8 0v2" />
      <rect x="6.5" y="9" width="11" height="10" rx="5.5" />
      <path d="M12 12.5v6M6.5 12.5H3.5M6.8 16.5H4M17.5 12.5h3M17.2 16.5H20" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  alertTriangle: (
    <>
      <path d="M12 4 2.5 20.5h19L12 4z" />
      <path d="M12 10v4" />
      <path d="M12 17.2h.01" strokeWidth={2.6} />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </>
  ),
  moon: <path d="M20 13.5A8 8 0 1 1 10.5 4a6.2 6.2 0 0 0 9.5 9.5z" />,
  phone: (
    <>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10 18.5h4" />
    </>
  ),
  laptop: (
    <>
      <rect x="5" y="5" width="14" height="10" rx="1.5" />
      <path d="M2.5 18.5h19" />
    </>
  )
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof ICON_PATHS

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  )
}
