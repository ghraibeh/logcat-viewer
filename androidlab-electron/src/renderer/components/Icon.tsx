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
  // Stream settings (gear).
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3.5v2.2M12 18.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
    </>
  ),
  // AirPlay / Wi-Fi mirror path toggle (screen with an upward triangle).
  airplay: (
    <>
      <path d="M5 17H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-1" />
      <path d="M12 14l4 5H8z" fill="currentColor" stroke="none" />
    </>
  ),
  // Mirror-audio playback on the host (speaker with sound waves / crossed out).
  sound: (
    <>
      <path d="M4 9.5h3L11 6v12l-4-3.5H4z" />
      <path d="M15 9.5a3.6 3.6 0 0 1 0 5" />
      <path d="M17.5 7a7.2 7.2 0 0 1 0 10" />
    </>
  ),
  muted: (
    <>
      <path d="M4 9.5h3L11 6v12l-4-3.5H4z" />
      <path d="M15.5 9.5 20.5 14.5M20.5 9.5 15.5 14.5" />
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
  // Touch / tap-to-inject (a pointing hand).
  touch: (
    <>
      <path d="M9 11.5V6a1.7 1.7 0 0 1 3.4 0v5" />
      <path d="M12.4 11V9.2a1.6 1.6 0 0 1 3.2 0V11.5" />
      <path d="M15.6 11.5v-.6a1.5 1.5 0 0 1 3 0V15a5 5 0 0 1-5 5h-1.3a4 4 0 0 1-3-1.35l-2.5-2.85a1.6 1.6 0 0 1 2.4-2.1l1.3 1.3" />
    </>
  ),
  // Rotate the mirror view 90° (portrait <-> landscape): a circular arrow.
  rotate: (
    <>
      <path d="M12 5a7 7 0 1 0 7 7" />
      <path d="M12 2 8.5 5 12 8" />
    </>
  ),

  // --- chrome / actions ---
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.4v3.2M12 18.4v3.2M4.6 4.6l2.3 2.3M17.1 17.1l2.3 2.3M2.4 12h3.2M18.4 12h3.2M4.6 19.4l2.3-2.3M17.1 6.9l2.3-2.3" />
    </>
  ),
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
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  list: (
    <>
      <path d="M8.5 6h11.5" />
      <path d="M8.5 12h11.5" />
      <path d="M8.5 18h11.5" />
      <path d="M4 6h.01" />
      <path d="M4 12h.01" />
      <path d="M4 18h.01" />
    </>
  ),
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
  ),

  // --- device info ---
  chip: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" />
      <path d="M9 6.5V3.5M15 6.5V3.5M9 20.5v-3M15 20.5v-3M6.5 9h-3M6.5 15h-3M20.5 9h-3M20.5 15h-3" />
    </>
  ),
  memory: (
    <>
      <rect x="3" y="8" width="18" height="9" rx="1.5" />
      <path d="M6.5 8V5M10 8V5M14 8V5M17.5 8V5M8 17v2.5M16 17v2.5" />
    </>
  ),
  battery: (
    <>
      <rect x="3" y="8" width="16" height="9" rx="2.5" />
      <path d="M21.5 11.5v2" />
      <rect x="5" y="10" width="8" height="5" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  signal: <path d="M4 20v-2.5M9 20v-6M14 20v-9.5M19 20V5" />,
  // USB connector: a shaft down the middle with the classic circle (base),
  // triangle and square branch tips — reads as "wired / USB".
  usb: (
    <>
      <path d="M12 21V4" />
      <path d="m9 7 3-3 3 3" />
      <circle cx="12" cy="21" r="0.8" fill="currentColor" />
      <path d="M12 15l4-2.5V10" />
      <rect x="14.6" y="7.6" width="2.8" height="2.8" rx="0.5" />
      <path d="M12 12l-4-2.5" />
      <circle cx="7.6" cy="9" r="1.4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.8 2.6 2.8 15.4 0 18M12 3c-2.8 2.6-2.8 15.4 0 18" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 2.8v5.7c0 4.4-3 7.4-7 8.7-4-1.3-7-4.3-7-8.7V5.8z" />
      <path d="M9 12l2 2 4-4.2" />
    </>
  ),
  // --- platform logos (filled silhouettes) ---
  // Apple logo (bitten apple + leaf).
  apple: (
    <>
      <path
        d="M17.05 12.536c-.026-2.634 2.15-3.898 2.25-3.958-1.226-1.792-3.132-2.038-3.81-2.066-1.622-.164-3.165.955-3.987.955-.82 0-2.087-.931-3.434-.906-1.766.026-3.395 1.027-4.305 2.608-1.836 3.183-.47 7.894 1.318 10.478.874 1.264 1.915 2.683 3.28 2.633 1.316-.052 1.813-.852 3.403-.852 1.59 0 2.037.852 3.43.826 1.415-.023 2.313-1.29 3.18-2.558.999-1.466 1.41-2.884 1.435-2.957-.032-.014-2.752-1.057-2.78-4.19"
        fill="currentColor"
        stroke="none"
      />
      <path
        d="M14.47 4.77c.726-.88 1.216-2.104 1.082-3.322-1.046.042-2.313.697-3.063 1.576-.673.78-1.262 2.025-1.104 3.22 1.167.09 2.36-.593 3.085-1.474"
        fill="currentColor"
        stroke="none"
      />
    </>
  ),
  // Android robot (head + shoulders with two antennae and eyes).
  android: (
    <path
      d="M17.523 15.341c-.551 0-.999-.449-.999-1 0-.551.448-.999.999-.999.551 0 .999.448.999.999 0 .551-.448 1-.999 1m-11.046 0c-.551 0-.999-.449-.999-1 0-.551.448-.999.999-.999.551 0 .999.448.999.999 0 .551-.448 1-.999 1m11.405-6.02l1.997-3.459a.416.416 0 00-.152-.568.416.416 0 00-.568.152l-2.022 3.503C15.59 8.244 13.853 7.851 12 7.851s-3.59.393-5.137 1.073L4.841 5.421a.416.416 0 00-.568-.152.416.416 0 00-.152.568l1.997 3.459C2.689 11.187.343 14.659 0 18.761h24c-.343-4.102-2.689-7.574-6.118-9.44"
      fill="currentColor"
      stroke="none"
    />
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
