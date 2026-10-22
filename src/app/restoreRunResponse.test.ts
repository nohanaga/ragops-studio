import { describe, expect, it } from 'vitest'
import { restoreRunResponse } from './restoreRunResponse'
import { buildActivityGraph, parseActivity, type ActivityItem } from '../lib/agenticActivityGraph'
import type { Run } from '../lib/model'
import type { JsonValue } from '../lib/aiSearchRest'
import { translations } from '../lib/translations'

const request: JsonValue = { intents: [{ type: 'semantic', search: 'test' }] }
const activity: JsonValue[] = [
  { id: 1, type: 'modelQueryPlanning', startedAt: '2026-10-22T00:00:00Z', completedAt: '2026-10-22T00:00:00.100Z' },
  { id: 2, type: 'searchIndex', startedAt: '2026-10-22T00:00:00.100Z', knowledgeSourceName: 'products' },
]
const body: JsonValue = { activity, response: [], references: [] }
const items = activity.map(parseActivity).filter((item): item is ActivityItem => item !== null)
const t = (key: keyof typeof translations.en) => translations.en[key]

function run(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run', experimentId: 'experiment', runType: 'agentic_retrieve', status: 'canceled',
    startedAt: '2026-10-22T00:00:00Z', endedAt: '2026-10-22T00:00:00.200Z',
    context: { endpoint: 'https://example.search.windows.net', apiVersion: '2026-08-01-preview', authType: 'apiKey' },
    params: request, artifactIds: [],
    metrics: { httpStatus: 0, serviceRequestId: 'request-id' },
    responseMetadata: {
      responseFormat: 'sse',
      streamState: { eventCount: 3, lastEvent: 'activity.started', runningActivityIds: ['2'] },
    },
    ...overrides,
  }
}

describe('restoreRunResponse', () => {
  it('restores terminal stream metadata and keeps only the unfinished activity incomplete', () => {
    const saved = run()
    const restored = restoreRunResponse(saved, request, body)
    expect(restored).toMatchObject({
      status: 0, runStatus: 'canceled', responseFormat: 'sse',
      streamState: saved.responseMetadata?.streamState,
    })
    expect(restored.body).toBe(body)
    expect(restored.requestBody).toBe(request)
    const graph = buildActivityGraph({ items, response: restored, streaming: false, t })
    expect(graph.nodes.find((node) => node.id === 'activity-0')?.status).toBe('completed')
    expect(graph.nodes.find((node) => node.id === 'activity-1')?.status).toBe('incomplete')
    expect(graph.nodes.find((node) => node.id === 'result')?.status).toBe('incomplete')
    expect(graph.nodes.find((node) => node.id === 'delivery')?.status).toBe('incomplete')
  })

  it('honors canceled status even if an old record contains HTTP 200', () => {
    const restored = restoreRunResponse(run({ metrics: { httpStatus: 200 }, responseMetadata: undefined }), request, body)
    expect(restored.status).toBe(0)
    expect(restored.runStatus).toBe('canceled')
    expect(restored.responseFormat).toBeUndefined()
    expect(restored.streamState).toBeUndefined()
    const graph = buildActivityGraph({ items, response: restored, t })
    expect(graph.nodes.find((node) => node.id === 'activity-0')?.status).toBe('completed')
    expect(graph.nodes.find((node) => node.id === 'activity-1')?.status).toBe('incomplete')
    expect(graph.nodes.find((node) => node.id === 'result')?.status).toBe('incomplete')
  })

  it('does not default a legacy canceled run without httpStatus to HTTP 200', () => {
    const restored = restoreRunResponse(run({ metrics: {}, responseMetadata: undefined }), request, body)
    expect(restored.status).toBe(0)
    expect(restored.responseFormat).toBeUndefined()
  })

  it('does not mutate the stored running activity ids when the restored view is changed', () => {
    const saved = run()
    const restored = restoreRunResponse(saved, request, body)
    restored.streamState?.runningActivityIds.push('another')
    expect(saved.responseMetadata?.streamState?.runningActivityIds).toEqual(['2'])
  })

  it.each([200, 206])('preserves successful SSE status %i and its completion event', (httpStatus) => {
    const restored = restoreRunResponse(run({
      status: 'success', metrics: { httpStatus },
      responseMetadata: { responseFormat: 'sse', streamState: { eventCount: 5, lastEvent: 'response.completed', runningActivityIds: [] } },
    }), request, body)
    expect(restored.status).toBe(httpStatus)
    const graph = buildActivityGraph({ items, response: restored, t })
    expect(graph.nodes.find((node) => node.id === 'result')?.status).toBe(httpStatus === 206 ? 'warning' : 'completed')
  })

  it('retains failure metadata without changing errors to successful completion', () => {
    const restored = restoreRunResponse(run({
      status: 'error', metrics: { httpStatus: 500 },
      responseMetadata: { responseFormat: 'sse', streamState: { eventCount: 4, lastEvent: 'error', runningActivityIds: ['2'] } },
    }), request, { activity, response: [], references: [], error: { message: 'failed' } })
    expect(restored.streamState?.lastEvent).toBe('error')
    const graph = buildActivityGraph({ items, response: restored, t })
    expect(graph.nodes.find((node) => node.id === 'result')?.status).toBe('error')
  })

  it('preserves JSON and legacy successful responses without inventing streaming metadata', () => {
    for (const responseMetadata of [{ responseFormat: 'json' as const }, undefined]) {
      const restored = restoreRunResponse(run({ status: 'success', metrics: {}, responseMetadata }), request, body)
      expect(restored.status).toBe(200)
      expect(restored.streamState).toBeUndefined()
      expect(restored.responseFormat).toBe(responseMetadata?.responseFormat)
    }
  })

  it('does not infer completion from elapsedMs when a legacy canceled activity has no completion timestamp', () => {
    const legacyItems = [{ type: 'searchIndex', id: 2, raw: {}, elapsedMs: 100 }]
    const restored = restoreRunResponse(run({ responseMetadata: undefined }), request, body)
    const graph = buildActivityGraph({ items: legacyItems, response: restored, t })
    expect(graph.nodes.find((node) => node.id === 'activity-0')?.status).toBe('incomplete')
  })
})
