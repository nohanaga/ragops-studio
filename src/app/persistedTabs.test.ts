// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { loadPersistedTabs, normalizeCenterTab } from './persistedTabs'

describe('app/persistedTabs', () => {
  it('normalizeCenterTab keeps builder/latest', () => {
    expect(normalizeCenterTab('builder', [])).toBe('builder')
    expect(normalizeCenterTab('latest', [])).toBe('latest')
  })

  it('normalizeCenterTab keeps tool tabs active', () => {
    expect(normalizeCenterTab('index-builder', [])).toBe('index-builder')
    expect(normalizeCenterTab('synonym-map-builder', [])).toBe('synonym-map-builder')
    expect(normalizeCenterTab('knowledge-base-builder', [])).toBe('knowledge-base-builder')
    expect(normalizeCenterTab('qps-tester', [])).toBe('qps-tester')
  })

  it('normalizeCenterTab validates run tabs against selected ids', () => {
    expect(normalizeCenterTab('run:a', ['a'])).toBe('run:a')
    expect(normalizeCenterTab('run:missing', ['a'])).toBe('run:a')
    expect(normalizeCenterTab('run:missing', [])).toBe('builder')
  })

  it('loadPersistedTabs restores stored tool centerTab', () => {
    localStorage.setItem(
      'tabs:exp1',
      JSON.stringify({
        selectedRunIds: [],
        centerTab: 'index-builder',
        isIndexBuilderOpen: true,
      }),
    )

    const restored = loadPersistedTabs('exp1')
    expect(restored).not.toBeNull()
    expect(restored!.centerTab).toBe('index-builder')
  })
})
