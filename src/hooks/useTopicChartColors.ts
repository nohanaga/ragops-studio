import { useEffect, useState } from 'react'
import type { TopicChartColors } from '../lib/topicCharts'
import type { ThemePreference } from '../types'

const FALLBACK: TopicChartColors = { foreground: '#e6edf3', muted: '#9fb0c0', panel: '#0f1620', border: '#243040', accent: '#5aa9ff' }

export function readTopicChartColors(): TopicChartColors {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    foreground: read('--fg', FALLBACK.foreground),
    muted: read('--muted', FALLBACK.muted),
    panel: read('--panel', FALLBACK.panel),
    border: read('--border', FALLBACK.border),
    accent: read('--accent', FALLBACK.accent),
    fontFamily: getComputedStyle(document.body).fontFamily || undefined,
  }
}

const sameColors = (left: TopicChartColors, right: TopicChartColors) =>
  left.foreground === right.foreground && left.muted === right.muted && left.panel === right.panel && left.border === right.border
  && left.accent === right.accent && left.fontFamily === right.fontFamily

/**
 * The theme colors that the charts need, read from the CSS variables of the app. ECharts paints on a canvas, so it
 * cannot use the variables directly and has to be given new colors when the theme or the system color scheme changes.
 */
export function useTopicChartColors(theme: ThemePreference): TopicChartColors {
  const [colors, setColors] = useState(readTopicChartColors)

  useEffect(() => {
    const refresh = () => setColors((current) => {
      const next = readTopicChartColors()
      return sameColors(current, next) ? current : next
    })
    const observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    const colorScheme = window.matchMedia?.('(prefers-color-scheme: dark)')
    colorScheme?.addEventListener('change', refresh)
    // The theme attribute may be applied after this component rendered with the new preference.
    const timer = window.setTimeout(refresh, 0)
    return () => {
      observer.disconnect()
      colorScheme?.removeEventListener('change', refresh)
      window.clearTimeout(timer)
    }
  }, [theme])

  return colors
}
