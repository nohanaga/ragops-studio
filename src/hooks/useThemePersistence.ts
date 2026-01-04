import { useEffect } from 'react'
import { applyThemePreference } from '../utils'
import type { ThemePreference } from '../types'

export function useThemePersistence(theme: ThemePreference) {
  useEffect(() => {
    applyThemePreference(theme)
    try {
      localStorage.setItem('theme', theme)
    } catch {
      // ignore
    }
  }, [theme])
}
