// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { applyThemePreference, getInitialPaneSizes, getInitialThemePreference } from './localStorage'

describe('utils/localStorage', () => {
  it('getInitialThemePreference returns system on missing/invalid values', () => {
    localStorage.removeItem('theme')
    expect(getInitialThemePreference()).toBe('system')

    localStorage.setItem('theme', 'invalid')
    expect(getInitialThemePreference()).toBe('system')
  })

  it('getInitialThemePreference returns stored value when valid', () => {
    localStorage.setItem('theme', 'dark')
    expect(getInitialThemePreference()).toBe('dark')
  })

  it('applyThemePreference sets/removes data-theme', () => {
    applyThemePreference('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

    applyThemePreference('system')
    expect(document.documentElement.getAttribute('data-theme')).toBeNull()
  })

  it('getInitialPaneSizes returns defaults and rounds numeric values', () => {
    localStorage.removeItem('paneSizes')
    expect(getInitialPaneSizes()).toEqual({ leftPx: 320, rightPx: 420, experimentsHeightPx: 250 })

    localStorage.setItem('paneSizes', JSON.stringify({ leftPx: 100.4, rightPx: 200.6, experimentsHeightPx: 300.1 }))
    expect(getInitialPaneSizes()).toEqual({ leftPx: 100, rightPx: 201, experimentsHeightPx: 300 })
  })
})
