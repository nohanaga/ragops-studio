// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { clearLastViewedRunId, loadLastViewedRunId, saveLastViewedRunId } from './persistedLatestRun'
import { LAST_VIEWED_RUN_ID_KEY } from './constants'

describe('app/persistedLatestRun', () => {
  it('returns null when missing/blank', () => {
    localStorage.removeItem(LAST_VIEWED_RUN_ID_KEY)
    expect(loadLastViewedRunId()).toBeNull()

    localStorage.setItem(LAST_VIEWED_RUN_ID_KEY, '   ')
    expect(loadLastViewedRunId()).toBeNull()
  })

  it('saves and loads a runId', () => {
    saveLastViewedRunId('run-123')
    expect(loadLastViewedRunId()).toBe('run-123')
  })

  it('trims stored values', () => {
    saveLastViewedRunId('  run-456  ')
    expect(loadLastViewedRunId()).toBe('run-456')
  })

  it('clears value', () => {
    saveLastViewedRunId('run-789')
    clearLastViewedRunId()
    expect(loadLastViewedRunId()).toBeNull()
  })
})
