/**
 * localStorage helpers.
 *
 * Holds user preferences (theme, pane sizes, etc.) with conservative error handling.
 */

import type { ThemePreference, PaneSizes } from '../types'

export function getInitialThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem('theme')
    if (raw === 'system' || raw === 'dark' || raw === 'light' || 
        raw === 'midnight' || raw === 'forest' || raw === 'solarized') return raw
  } catch {
    // ignore
  }
  return 'system'
}

export function applyThemePreference(pref: ThemePreference) {
  const html = document.documentElement
  if (pref === 'system') {
    html.removeAttribute('data-theme')
    return
  }
  html.setAttribute('data-theme', pref)
}

export function getInitialPaneSizes(): PaneSizes {
  try {
    const raw = localStorage.getItem('paneSizes')
    if (!raw) return { leftPx: 320, rightPx: 420, experimentsHeightPx: 250 }
    const parsed = JSON.parse(raw) as Partial<PaneSizes>
    const leftPx = typeof parsed.leftPx === 'number' ? parsed.leftPx : 320
    const rightPx = typeof parsed.rightPx === 'number' ? parsed.rightPx : 420
    const experimentsHeightPx = typeof parsed.experimentsHeightPx === 'number' ? parsed.experimentsHeightPx : 250
    return {
      leftPx: Math.round(leftPx),
      rightPx: Math.round(rightPx),
      experimentsHeightPx: Math.round(experimentsHeightPx),
    }
  } catch {
    return { leftPx: 320, rightPx: 420, experimentsHeightPx: 250 }
  }
}
