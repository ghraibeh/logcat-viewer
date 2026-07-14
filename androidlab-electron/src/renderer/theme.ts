/**
 * Theme engine for canvas / JS-side drawing.
 *
 * The CSS custom properties in styles/theme.css are the single source of truth
 * for color; this module mirrors the ones needed for canvas drawing (graphs,
 * meters, overlays) into a live `PALETTE` object that is re-read from the DOM on
 * every theme switch. Dark is the default (matches the CSS `:root` defaults) so
 * first paint is correct before any refresh runs.
 */
import { setLogTheme } from '@core/colors'

export type ThemeMode = 'dark' | 'light'

const THEME_KEY = 'androidlab:theme'
/** Fired on window after a theme switch so canvases can repaint (see Canvas.tsx). */
export const THEME_EVENT = 'androidlab:themechange'

/** Palette constants for canvas drawing — refreshed from CSS on theme change. */
export const PALETTE = {
  BG: '#16171c',
  SURFACE: '#1c1e24',
  SURFACE_2: '#252831',
  SURFACE_3: '#2f3340',
  BORDER: '#272a34',
  BORDER_2: '#3a3f4d',
  TEXT: '#e9ebf3',
  TEXT_DIM: '#7e8595',
  ACCENT: '#6e7bff',
  ACCENT_H: '#8b96ff',
  GREEN: '#31c96e',
  GREEN_H: '#43dd80',
  RED: '#f25a52',
  AMBER: '#e3a812'
}

/** PALETTE key -> the CSS custom property that backs it. */
const VAR_OF: Record<keyof typeof PALETTE, string> = {
  BG: '--bg',
  SURFACE: '--surface',
  SURFACE_2: '--surface-2',
  SURFACE_3: '--surface-3',
  BORDER: '--border',
  BORDER_2: '--border-2',
  TEXT: '--text',
  TEXT_DIM: '--text-dim',
  ACCENT: '--accent',
  ACCENT_H: '--accent-h',
  GREEN: '--green',
  GREEN_H: '--green-h',
  RED: '--red',
  AMBER: '--amber'
}

/** Re-read PALETTE from whatever CSS custom properties are currently in effect. */
export function refreshPalette(): void {
  const cs = getComputedStyle(document.documentElement)
  for (const key of Object.keys(VAR_OF) as Array<keyof typeof PALETTE>) {
    const v = cs.getPropertyValue(VAR_OF[key]).trim()
    if (v) PALETTE[key] = v
  }
}

function systemTheme(): ThemeMode {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'
}

/** Persisted choice, else the OS preference on first run. */
export function getStoredTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* localStorage unavailable */
  }
  return systemTheme()
}

/** Apply a theme everywhere: <html> attribute, persistence, palette, log colors. */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode
  try {
    localStorage.setItem(THEME_KEY, mode)
  } catch {
    /* ignore */
  }
  refreshPalette()
  setLogTheme(mode)
  window.dispatchEvent(new Event(THEME_EVENT))
}

/** First-run init — call before rendering so the first paint matches the theme. */
export function initTheme(): ThemeMode {
  const mode = getStoredTheme()
  document.documentElement.dataset.theme = mode
  refreshPalette()
  setLogTheme(mode)
  return mode
}
