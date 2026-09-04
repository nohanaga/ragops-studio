// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { http, HttpResponse } from 'msw'

import { server } from '../test/mswServer'
import { translations } from '../lib/translations'
import { shouldUseAgenticStreaming, useApiOperations } from './useApiOperations'

describe('hooks/useApiOperations', () => {
  it('uses SSE only when the effective API version supports it', () => {
    expect(shouldUseAgenticStreaming('2026-08-01-preview', true)).toBe(true)
    expect(shouldUseAgenticStreaming('2026-05-01-preview', true)).toBe(false)
    expect(shouldUseAgenticStreaming('2026-04-01', true)).toBe(false)
    expect(shouldUseAgenticStreaming('2025-11-01-preview', true)).toBe(false)
    expect(shouldUseAgenticStreaming('2026-08-01-preview', false)).toBe(false)
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
