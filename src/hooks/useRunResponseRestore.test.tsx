// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { Dispatch, SetStateAction } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addArtifact, createExperiment, createRun } from '../lib/db'
import type { Run } from '../lib/model'
import type { LatestResponse } from '../types'
import type { JsonValue } from '../lib/aiSearchRest'
import { translations } from '../lib/translations'
import { saveLastViewedRunId } from '../app/persistedLatestRun'
import { buildActivityGraph, parseActivity, type ActivityItem } from '../lib/agenticActivityGraph'
import { useLatestResponseRestore } from './useLatestResponseRestore'
import { useSelectedRunsArtifacts } from './useSelectedRunsArtifacts'
import { useRunRestore } from './useRunRestore'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const activity: JsonValue[] = [
  { id: 1, type: 'modelQueryPlanning', completedAt: '2026-10-22T00:00:00.100Z' },
  { id: 2, type: 'searchIndex', startedAt: '2026-10-22T00:00:00.100Z' },
]
const body = { activity, response: [], references: [] }
const t = (key: keyof typeof translations.en) => translations.en[key]

async function saveCanceledRun(legacy: boolean) {
  const experiment = await createExperiment({ name: 'Canceled run restoration' })
  const request = { messages: [{ role: 'user', content: [{ type: 'text', text: 'test' }] }] }
  const run = await createRun({
    experimentId: experiment.experimentId, runType: 'agentic_retrieve', status: 'canceled',
    startedAt: '2026-10-22T00:00:00Z', endedAt: '2026-10-22T00:00:00.200Z',
    context: { endpoint: 'https://example.search.windows.net', apiVersion: '2026-08-01-preview', authType: 'apiKey' },
    params: request, metrics: legacy ? {} : { httpStatus: 0 },
    responseMetadata: legacy ? undefined : {
      responseFormat: 'sse',
      streamState: { eventCount: 3, lastEvent: 'activity.started', runningActivityIds: ['2'] },
    },
  })
  await addArtifact({ runId: run.runId, type: 'request_json', content: JSON.stringify(request) })
  await addArtifact({ runId: run.runId, type: 'response_json', content: JSON.stringify(body) })
  return { experiment, run }
}

function assertIncomplete(response: LatestResponse | null | undefined) {
  expect(response?.status).toBe(0)
  expect(response?.runStatus).toBe('canceled')
  const graph = buildActivityGraph({
    items: activity.map(parseActivity).filter((item): item is ActivityItem => item !== null),
    response: response ?? undefined, t,
  })
  expect(graph.nodes.find((node) => node.id === 'result')?.status).toBe('incomplete')
  expect(graph.nodes.find((node) => node.id === 'activity-0')?.status).toBe('completed')
  expect(graph.nodes.find((node) => node.id === 'activity-1')?.status).toBe('incomplete')
}

describe.each([false, true])('canceled response restoration (legacy: %s)', (legacy) => {
  it('restores a selected run without converting it to a successful response', async () => {
    const { run } = await saveCanceledRun(legacy)
    const restored: { value: LatestResponse | null } = { value: null }
    const setRunResultMap = vi.fn<Dispatch<SetStateAction<Record<string, { run: Run; response: LatestResponse | null }>>>>((next) => {
      const map = typeof next === 'function' ? next({}) : next
      restored.value = map[run.runId]?.response ?? null
    })
    renderHook(() => useSelectedRunsArtifacts({
      selectedRunIds: [run.runId],
      setSelectedRun: vi.fn(), setIndexName: vi.fn(), setKnowledgeBaseName: vi.fn(), setRequestJson: vi.fn(),
      setRunResultMap, setResultPages: vi.fn(),
    }))
    await waitFor(() => expect(setRunResultMap).toHaveBeenCalled())
    assertIncomplete(restored.value)
    expect(restored.value?.streamState).toEqual(run.responseMetadata?.streamState)
  })

  it('restores the latest result after refresh with cancellation state intact', async () => {
    const { experiment, run } = await saveCanceledRun(legacy)
    saveLastViewedRunId(run.runId)
    const restored: { value: LatestResponse | null } = { value: null }
    const setLatestResponse = vi.fn<Dispatch<SetStateAction<LatestResponse | null>>>((next) => {
      restored.value = typeof next === 'function' ? next(restored.value) : next
    })
    renderHook(() => useLatestResponseRestore({
      selectedExperimentId: experiment.experimentId, centerTab: 'latest', latestResponse: null,
      setLatestResponse, setResultPages: vi.fn(),
    }))
    await waitFor(() => expect(setLatestResponse).toHaveBeenCalled())
    assertIncomplete(restored.value)
    expect(restored.value?.streamState).toEqual(run.responseMetadata?.streamState)
  })

  it('preserves cancellation on explicit restore', async () => {
    const { run } = await saveCanceledRun(legacy)
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const restored: { value: LatestResponse | null } = { value: null }
    const setLatestResponse = vi.fn<Dispatch<SetStateAction<LatestResponse | null>>>((next) => {
      restored.value = typeof next === 'function' ? next(restored.value) : next
    })
    const { result } = renderHook(() => useRunRestore({
      t, format: (key) => t(key),
      setLabMode: vi.fn(), setBuilderMode: vi.fn(), setKnowledgeBaseName: vi.fn(), setAgenticForm: vi.fn(),
      setIndexName: vi.fn(), setAnalyzeForm: vi.fn(), setAutocompleteForm: vi.fn(), setSuggestForm: vi.fn(),
      setSearchForm: vi.fn(), setRunNote: vi.fn(), setQpsTesterRestoreRunId: vi.fn(), setIsQpsTesterOpen: vi.fn(),
      setAutoTuningRestoreRunId: vi.fn(), setIsAutoTuningOpen: vi.fn(), setCenterTab: vi.fn(),
      setLatestResponse, setRunResultMap: vi.fn(), setResultPages: vi.fn(),
    }))
    await act(async () => { await result.current.onRestoreRun(run.runId) })
    assertIncomplete(restored.value)
    expect(restored.value?.streamState).toEqual(run.responseMetadata?.streamState)
  })
})
