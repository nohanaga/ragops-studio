// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useTopicChartColors } from './useTopicChartColors'

describe('useTopicChartColors', () => {
  afterEach(() => {
    cleanup()
    document.documentElement.removeAttribute('style')
  })

  it('reads the theme variables of the app and follows a theme change', async () => {
    document.documentElement.style.setProperty('--fg', '#111111')
    document.documentElement.style.setProperty('--panel', '#fafafa')
    const { result } = renderHook(() => useTopicChartColors('light'))

    expect(result.current).toMatchObject({ foreground: '#111111', panel: '#fafafa' })

    await act(async () => {
      document.documentElement.style.setProperty('--fg', '#eeeeee')
      document.documentElement.style.setProperty('--panel', '#101010')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(result.current).toMatchObject({ foreground: '#eeeeee', panel: '#101010' })
  })

  it('falls back to readable colors when a variable is missing and keeps the same object when nothing changed', async () => {
    const { result, rerender } = renderHook(() => useTopicChartColors('dark'))
    const first = result.current
    expect(first.foreground).not.toBe('')
    expect(first.accent).not.toBe('')

    rerender()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    expect(result.current).toBe(first)
  })
})
