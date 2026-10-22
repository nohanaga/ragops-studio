// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { http, HttpResponse } from 'msw'

import { server } from '../test/mswServer'
import { translations } from '../lib/translations'
import { shouldUseAgenticStreaming, useApiOperations } from './useApiOperations'
import { DEFAULT_SEARCH_FORM } from '../app/defaults'
import type { LatestResponse } from '../types'

describe('hooks/useApiOperations', () => {
  it('uses SSE only when the effective API version supports it', () => {
    expect(shouldUseAgenticStreaming('2026-08-01-preview', true)).toBe(true)
    expect(shouldUseAgenticStreaming('2026-05-01-preview', true)).toBe(false)
    expect(shouldUseAgenticStreaming('2026-04-01', true)).toBe(false)
    expect(shouldUseAgenticStreaming('2025-11-01-preview', true)).toBe(false)
    expect(shouldUseAgenticStreaming('2026-08-01-preview', false)).toBe(false)
  })

  it.each(['json', 'json-error', 'sse', 'sse-error'] as const)('retains %s delivery metadata and terminal state for the graph', async (mode) => {
    const streaming = mode.startsWith('sse')
    const failed = mode.endsWith('error')
    const activity = { type: 'searchIndex', id: 1, knowledgeSourceName: 'products', startedAt: '2026-10-22T00:00:00.000Z' }
    const completedActivity = { ...activity, completedAt: '2026-10-22T00:00:00.100Z', elapsedMs: 25 }
    const payload = { response: [], references: [], activity: [completedActivity] }
    const error = { error: { code: 'source-failure', message: 'source failed' } }
    const handler = () => {
      if (!streaming) return HttpResponse.json(failed ? error : payload, { status: failed ? 502 : 200 })
      const events = [
        `event: activity.started\ndata: ${JSON.stringify(activity)}\n\n`,
        ...(failed ? [`event: error\ndata: ${JSON.stringify(error)}\n\n`] : [
          `event: activity.completed\ndata: ${JSON.stringify(completedActivity)}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ statusCode: 200, response: payload })}\n\n`,
        ]),
      ].join('')
      return new HttpResponse(events, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    server.use(
      http.post('/api-proxy/knowledgebases/kb/retrieve', handler),
      http.post('https://example.search.windows.net/knowledgebases/kb/retrieve', handler),
    )
    const { ensureSeedData, listExperiments } = await import('../lib/db')
    await ensureSeedData()
    const experiments = await listExperiments()
    const setLatestResponse = vi.fn<(value: LatestResponse | null) => void>()
    const { result } = renderHook(() => useApiOperations({
      labMode: 'agentic',
      activeProfile: { endpoint: 'https://example.search.windows.net', apiVersion: '2026-08-01-preview', authType: 'apiKey', apiKey: 'test-key' },
      indexName: '', knowledgeBaseName: 'kb', selectedExperimentId: experiments[0].experimentId,
      requestJson: JSON.stringify({ intents: [{ type: 'semantic', search: 'test' }], retrievalReasoningEffort: { kind: 'minimal' }, outputMode: 'extractiveData', includeActivity: true }),
      runNote: '',
      searchForm: DEFAULT_SEARCH_FORM,
      agenticForm: { userMessage: 'test', includeActivity: true, outputMode: 'extractiveData', maxRuntimeInSeconds: 60, maxOutputSize: 5000, retrievalReasoningEffort: 'minimal', streamResponse: streaming, knowledgeSourceParams: [] },
      language: 'en', t: (key) => translations.en[key],
      setUiError: vi.fn(), setUiLog: vi.fn(), setLatestResponse,
      setRunResultMap: vi.fn(), setSelectedRunIds: vi.fn(), setCenterTab: vi.fn(), setResultPages: vi.fn(),
      reloadRuns: vi.fn(async () => {}),
    }))
    await act(async () => { await result.current.onExecute() })
    const latest = setLatestResponse.mock.calls.at(-1)?.[0]
    expect(latest?.responseFormat).toBe(streaming ? 'sse' : 'json')
    expect(latest?.status).toBe(failed ? streaming ? 500 : 502 : 200)
    if (streaming) {
      expect(latest?.streamState?.lastEvent).toBe(failed ? 'error' : 'response.completed')
      expect(latest?.streamState?.runningActivityIds).toEqual(failed ? ['1'] : [])
    } else {
      expect(latest?.streamState).toBeUndefined()
    }
    if (failed) expect(latest?.body).toMatchObject({ error: expect.any(Object) })
    else expect(latest?.body).toMatchObject({ activity: [{ startedAt: activity.startedAt, completedAt: completedActivity.completedAt }] })
  })

  it('onExecute succeeds and sets LatestResponse (searchDocuments)', async () => {
    server.use(
      // In vitest, `import.meta.env.DEV` is typically true, so the REST client
      // routes Azure endpoints through `/api-proxy`.
      http.post('/api-proxy/indexes/myindex/docs/search', async () => {
        return HttpResponse.json(
          {
            '@odata.count': 1,
            value: [{ '@search.score': 1.23, id: 'doc1' }],
          },
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'request-id': 'req-123',
              'elapsed-time': '12.3',
            },
          },
        )
      }),
      http.post('https://example.search.windows.net/indexes/myindex/docs/search', async () => {
        return HttpResponse.json(
          {
            '@odata.count': 1,
            value: [{ '@search.score': 1.23, id: 'doc1' }],
          },
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'request-id': 'req-123',
              'elapsed-time': '12.3',
            },
          },
        )
      }),
    )

    const { ensureSeedData, getRun, listExperiments, listRunsByExperiment } = await import('../lib/db')
    await ensureSeedData()
    const exps = await listExperiments()
    expect(exps.length).toBeGreaterThan(0)

    const setUiError = vi.fn()
    const setUiLog = vi.fn()
    const setLatestResponse = vi.fn()
    const setRunResultMap = vi.fn()
    const setSelectedRunIds = vi.fn()
    const setCenterTab = vi.fn()
    const setResultPages = vi.fn()
    const reloadRuns = vi.fn(async () => {})

    const t = (key: keyof typeof translations.ja) => translations.ja[key]

    const { result } = renderHook(() =>
      useApiOperations({
        labMode: 'query',
        activeProfile: {
          endpoint: 'https://example.search.windows.net',
          apiVersion: '2025-09-01',
          authType: 'apiKey',
          apiKey: 'test-key',
        },
        indexName: 'myindex',
        knowledgeBaseName: '',
        selectedExperimentId: exps[0].experimentId,
        requestJson: JSON.stringify({ search: 'hi', queryType: 'simple', top: 3, skip: 0, count: true }),
        runNote: 'saved note',
        agenticForm: {
          userMessage: '',
          includeActivity: true,
          outputMode: 'answerSynthesis',
          maxRuntimeInSeconds: 60,
          maxOutputSize: 5000,
          retrievalReasoningEffort: 'low',
          streamResponse: false,
          knowledgeSourceParams: [],
        },
        // Not used in json mode path, but required by signature.
        searchForm: {
          search: '',
          queryType: 'simple',
          top: 10,
          skip: 0,
          count: false,
          select: '',
          filter: '',
          orderby: '',
          searchMode: '',
          searchFields: '',
          facets: '',
          highlight: '',
          scoringProfile: '',
          scoringParameters: '',
          queryRewrites: '',
          debug: '',
          semanticQuery: '',
          highlightPreTag: '',
          highlightPostTag: '',
          minimumCoverage: '',
          scoringStatistics: '',
          sessionId: '',
          speller: '',
          semanticErrorHandling: '',
          semanticMaxWaitInMilliseconds: '',
          semanticFields: '',
          vectorFilterMode: '',
          hybridMaxTextRecallSize: '',
          hybridCountAndFacetMode: '',
          semanticConfiguration: '',
          queryLanguage: '',
          captions: '',
          answers: '',
          vectorEnabled: false,
          vectorQueries: [],
          vectorKind: 'text',
          vectorText: '',
          vectorQueryRewrites: '',
          vector: '',
          vectorImageUrl: '',
          vectorBase64Image: '',
          vectorFields: '',
          vectorK: 3,
          vectorExhaustive: false,
          vectorWeight: 1.0,
          vectorThresholdKind: '',
          vectorThresholdValue: 0,
          vectorOversampling: '',
          vectorPerDocumentVectorLimit: '',
          vectorFilterOverride: '',
        },
        language: 'ja',
        t,
        setUiError,
        setUiLog,
        setLatestResponse,
        setRunResultMap,
        setSelectedRunIds,
        setCenterTab,
        setResultPages,
        reloadRuns,
      }),
    )

    await act(async () => {
      await result.current.onExecute()
    })

    expect(setUiError).not.toHaveBeenCalledWith('ネットワークエラー (fetch)')
    // First call clears the previous response, second call sets the successful payload.
    expect(setLatestResponse).toHaveBeenCalledWith(null)
    const latest = setLatestResponse.mock.calls.at(-1)?.[0] as { status: number; requestId: string; url: string }
    expect(latest.status).toBe(200)
    expect(latest.requestId).toBe('req-123')
    expect(latest.url).toContain('/indexes/myindex/docs/search')

    const runs = await listRunsByExperiment(exps[0].experimentId)
    expect(runs.length).toBeGreaterThan(0)
    const storedRun = await getRun(runs[0].runId)
    expect(storedRun?.note).toBe('saved note')
  })
})
