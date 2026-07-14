/**
 * Dark/light theme state for the app. The heavy lifting (DOM attribute,
 * persistence, canvas palette + log-color refresh) lives in ../theme; this hook
 * just holds the current mode as React state so the UI re-renders (toggle icon,
 * inline PALETTE reads) when it flips. main.tsx has already applied the stored
 * theme before first paint, so the initializer only mirrors it.
 */
import { useCallback, useState } from 'react'
import { applyTheme, getStoredTheme, type ThemeMode } from '../theme'

export interface ThemeControl {
  theme: ThemeMode
  toggleTheme: () => void
}

export function useTheme(): ThemeControl {
  const [theme, setTheme] = useState<ThemeMode>(() => getStoredTheme())

  const toggleTheme = useCallback(() => {
    setTheme((cur) => {
      const next: ThemeMode = cur === 'dark' ? 'light' : 'dark'
      applyTheme(next)
      return next
    })
  }, [])

  return { theme, toggleTheme }
}
