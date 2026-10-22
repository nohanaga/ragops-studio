// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as rest from '../lib/aiSearchRest'
import { createExperiment, getRun, listArtifactsByRun } from '../lib/db'
import { DEFAULT_SEARCH_FORM } from '../app/defaults'
import { restoreRunResponse } from '../app/restoreRunResponse'
import { buildActivityGraph, parseActivity, type ActivityItem } from '../lib/agenticActivityGraph'
import { translations } from '../lib/translations'
import type { LatestResponse } from '../types'
import { useApiOperations } from './useApiOperations'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SSE cancellation persistence', () => {
  it.each([false, true])('preserves canceled state across persistence (received activities: %s)', async (receivedActivities) => {
    const experiment = await createExperiment({ name: 'Cancellation persistence' })
    const setLatestResponse = vi.fn<(value: LatestResponse | null) => void>()
    const t = (key: keyof typeof translations.en) => translations.en[key]
    const { result } = renderHook(() => useApiOperations({
      labMode: 'agentic',
      activeProfile: { endpoint: 'https://example.search.windows.net', apiVersion: '2026-08-01-preview', authType: 'apiKey', apiKey: 'test-key' },
      indexName: '', knowledgeBaseName: 'kb', selectedExperimentId: experiment.experimentId,
      requestJson: JSON.stringify({ intents: [{ type: 'semantic', search: 'test' }], retrievalReasoningEffort: { kind: 'minimal' }, outputMode: 'extractiveData', includeActivity: true }),
      runNote: '', searchForm: DEFAULT_SEARCH_FORM,
      agenticForm: { userMessage: 'test', includeActivity: true, outputMode: 'extractiveData', maxRuntimeInSeconds: 60, maxOutputSize: 5000, retrievalReasoningEffort: 'minimal', streamResponse: true, knowledgeSourceParams: [] },
      language: 'en', t, setUiError: vi.fn(), setUiLog: vi.fn(), setLatestResponse,
      setRunResultMap: vi.fn(), setSelectedRunIds: vi.fn(), setCenterTab: vi.fn(), setResultPages: vi.fn(),
      reloadRuns: vi.fn(async () => {}),
    }))
    vi.spyOn(rest, 'agenticRetrieveStream').mockImplementation(async ({ onEvent, signal }) => {
      if (receivedActivities) {
        onEvent?.({ event: 'retrieval.started', data: { requestId: 'stream-request' } })
        onEvent?.({ event: 'activity.started', data: { id: 1, type: 'modelQueryPlanning', startedAt: '2026-10-22T00:00:00Z' } })
        onEvent?.({ event: 'activity.completed', data: { id: 1, type: 'modelQueryPlanning', completedAt: '2026-10-22T00:00:00.100Z' } })
        onEvent?.({ event: 'activity.started', data: { id: 2, type: 'searchIndex', startedAt: '2026-10-22T00:00:00.100Z' } })
      }
      result.current.onCancelExecute()
      expect(signal?.aborted).toBe(true)
      throw new DOMException('Canceled', 'AbortError')
    })
    await act(async () => { await result.current.onExecute() })
    const latest = setLatestResponse.mock.calls.at(-1)?.[0]
    if (!latest?.runId) throw new Error('Canceled response was not produced')
    const saved = await getRun(latest.runId)
    if (!saved) throw new Error('Canceled run was not persisted')
    expect(saved.status).toBe('canceled')
    expect(saved.metrics.httpStatus).toBe(0)
    expect(saved.responseMetadata).toEqual({
      responseFormat: 'sse',
      streamState: {
        eventCount: receivedActivities ? 4 : 0,
        lastEvent: receivedActivities ? 'activity.started' : '',
        runningActivityIds: receivedActivities ? ['2'] : [],
      },
    })
    const artifacts = await listArtifactsByRun(saved.runId)
    const persistedBody = JSON.parse(artifacts.find((artifact) => artifact.type === 'response_json')!.content) as rest.JsonValue
    expect(persistedBody).toEqual(latest.body)
    const restored = restoreRunResponse(saved, latest.requestBody, persistedBody)
    expect(restored.status).toBe(0)
    expect(restored.streamState).toEqual(latest.streamState)
    const graph = buildActivityGraph({
      response: restored, t,
      items: receivedActivities ? [
        parseActivity({ type: 'modelQueryPlanning', id: 1, completedAt: '2026-10-22T00:00:00.100Z' }),
        parseActivity({ type: 'searchIndex', id: 2 }),
      ].filter((item): item is ActivityItem => item !== null) : [],
    })
    expect(graph.nodes.find((node) => node.id === 'result')?.status).toBe('incomplete')
    if (receivedActivities) {
      expect(graph.nodes.find((node) => node.id === 'activity-0')?.status).toBe('completed')
      expect(graph.nodes.find((node) => node.id === 'activity-1')?.status).toBe('incomplete')
    }
  })
})
