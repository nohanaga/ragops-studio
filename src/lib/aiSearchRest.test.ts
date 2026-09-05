// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'

import { server } from '../test/mswServer'
import {
  agenticRetrieve,
  agenticRetrieveStream,
  autocompleteDocuments,
  analyzeIndex,
  createOrUpdateAlias,
  createOrUpdateIndex,
  createOrUpdateKnowledgeBase,
  createOrUpdateKnowledgeSource,
  createOrUpdateSynonymMap,
  deleteIndex,
  deleteAlias,
  deleteKnowledgeBase,
  deleteKnowledgeSource,
  deleteSynonymMap,
  getIndexDefinition,
  getIndexStatistics,
  getAliasDefinition,
  getCitationDocument,
  getKnowledgeBase,
  getKnowledgeSource,
  getSynonymMap,
  listIndexes,
  listAliases,
  listKnowledgeBases,
  listKnowledgeSources,
  listSynonymMaps,
  parseAgenticSseEvent,
  resetIndexer,
  resolveSearchApiVersion,
  searchDocuments,
  suggestDocuments,
} from './aiSearchRest'

function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return v as Record<string, unknown>
}

describe('lib/aiSearchRest', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps newer configured API versions and raises older versions to the feature minimum', () => {
    expect(resolveSearchApiVersion('2026-05-01-preview', '2025-11-01-preview')).toBe('2026-05-01-preview')
    expect(resolveSearchApiVersion('2026-04-01', '2025-11-01-preview')).toBe('2026-04-01')
    expect(resolveSearchApiVersion('2025-09-01', '2025-11-01-preview')).toBe('2025-11-01-preview')
  })

  it('uses the minimum supported API version for agentic knowledge resources', async () => {
    const observedApiVersions: string[] = []
    const observeVersion = (request: Request) => {
      observedApiVersions.push(new URL(request.url).searchParams.get('api-version') ?? '')
    }
    server.use(
      http.post('*/knowledgebases/kb-minimum/retrieve', ({ request }) => {
        observeVersion(request)
        return HttpResponse.json({ response: [], activity: [], references: [] })
      }),
      http.put('*/knowledgebases/kb-minimum', ({ request }) => {
        observeVersion(request)
        return HttpResponse.json({ name: 'kb-minimum' }, { status: 201 })
      }),
      http.put('*/knowledgesources/ks-minimum', ({ request }) => {
        observeVersion(request)
        return HttpResponse.json({ name: 'ks-minimum', kind: 'searchIndex' }, { status: 201 })
      }),
    )
    const profile = {
      endpoint: 'https://example.search.windows.net',
      apiVersion: '2025-09-01' as const,
      authType: 'apiKey' as const,
      apiKey: 'k',
    }

    const retrieve = await agenticRetrieve({
      profile,
      knowledgeBaseName: 'kb-minimum',
      body: { intents: [{ type: 'semantic', search: 'hello' }] },
    })
    const knowledgeBase = await createOrUpdateKnowledgeBase({
      profile,
      knowledgeBaseName: 'kb-minimum',
      body: { name: 'kb-minimum' },
    })
    const knowledgeSource = await createOrUpdateKnowledgeSource({
      profile,
      knowledgeSourceName: 'ks-minimum',
      body: { name: 'ks-minimum', kind: 'searchIndex' },
    })

    expect(retrieve.ok).toBe(true)
    expect(knowledgeBase.ok).toBe(true)
    expect(knowledgeSource.ok).toBe(true)
    expect(observedApiVersions).toEqual([
      '2025-11-01-preview',
      '2025-11-01-preview',
      '2025-11-01-preview',
    ])
  })

  it('parses named SSE events and ignores heartbeat comments', () => {
    expect(parseAgenticSseEvent(': heartbeat')).toBeNull()
    expect(parseAgenticSseEvent('event: references.completed\r\ndata: [{"id":"0"}]')).toEqual({
      event: 'references.completed',
      data: [{ id: '0' }],
    })
    expect(parseAgenticSseEvent('event: response.completed\ndata: {invalid-json}')).toBeNull()
  })

  it('streams agentic events and returns the response.completed payload', async () => {
    const observedEvents: string[] = []
    server.use(
      http.post('*/knowledgebases/kb-stream/retrieve', async ({ request }) => {
        expect(request.headers.get('accept')).toBe('text/event-stream')
        expect(new URL(request.url).searchParams.get('api-version')).toBe('2026-08-01-preview')
        return new HttpResponse([
          'event: retrieval.started\n',
          'data: {"requestId":"stream-request"}\n\n',
          ': heartbeat\n\n',
          'event: activity.started\n',
          'data: {"id":1,"type":"searchIndex"}\n\n',
          'event: activity.completed\n',
          'data: {"id":1,"type":"searchIndex","count":2}\n\n',
          'event: response.completed\n',
          'data: {"statusCode":206,"response":{"response":[],"activity":[],"references":[]}}\n\n',
        ].join(''), {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'request-id': 'req-stream' },
        })
      }),
    )

    const result = await agenticRetrieveStream({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2026-08-01-preview',
        authType: 'apiKey',
        apiKey: 'k',
      },
      knowledgeBaseName: 'kb-stream',
      body: { messages: [] },
      onEvent: (item) => observedEvents.push(item.event),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe(206)
    expect(result.requestId).toBe('req-stream')
    expect(observedEvents).toEqual([
      'retrieval.started',
      'activity.started',
      'activity.completed',
      'response.completed',
    ])
  })

  it('rejects an agentic SSE stream that ends without a terminal event', async () => {
    server.use(
      http.post('*/knowledgebases/kb-incomplete/retrieve', () => new HttpResponse(
        'event: retrieval.started\ndata: {"requestId":"stream-request"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )),
    )

    const result = await agenticRetrieveStream({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2026-08-01-preview',
        authType: 'apiKey',
        apiKey: 'k',
      },
      knowledgeBaseName: 'kb-incomplete',
      body: { messages: [] },
      language: 'en',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(0)
    expect(result.error.message).toContain('terminal event')
  })

  it('does not send credentials to a citation URL on another origin', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await getCitationDocument({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2026-08-01-preview',
        authType: 'apiKey',
        apiKey: 'secret-key',
      },
      citationUrl: 'https://attacker.example/documents/1',
      language: 'en',
    })

    expect(result.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('follows a same-origin citation URL with existing authorization headers', async () => {
    server.use(
      http.get('*/indexes/products/docs/sku-1', ({ request }) => {
        expect(request.headers.get('api-key')).toBe('k')
        expect(request.headers.get('x-ms-query-source-authorization')).toBe('user-token')
        expect(new URL(request.url).searchParams.get('$select')).toBe('title,content')
        return HttpResponse.json(
          { id: 'sku-1', title: 'Product' },
          { headers: { 'request-id': 'req-citation' } },
        )
      }),
    )

    const citationUrl = 'https://example.search.windows.net/indexes/products/docs/sku-1?$select=title%2Ccontent&api-version=2026-08-01-preview'
    const result = await getCitationDocument({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2026-08-01-preview',
        authType: 'apiKey',
        apiKey: 'k',
        querySourceAuthorization: 'user-token',
      },
      citationUrl,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.url).toBe(citationUrl)
    expect(result.requestId).toBe('req-citation')
    expect(result.response).toEqual({ id: 'sku-1', title: 'Product' })
  })

  it('routes Azure endpoints via /api-proxy in DEV and sets proxy headers', async () => {
    const observed: { target?: string; apiKey?: string; idempotent?: string; apiVersion?: string } = {}

    server.use(
      http.post('/api-proxy/indexes/myindex/docs/search', async ({ request }) => {
        const url = new URL(request.url)
        observed.apiVersion = url.searchParams.get('api-version') ?? undefined
        observed.target = request.headers.get('x-ais-proxy-target') ?? undefined
        observed.apiKey = request.headers.get('api-key') ?? undefined
        observed.idempotent = request.headers.get('x-ais-idempotent') ?? undefined

        return HttpResponse.json(
          { value: [] },
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'request-id': 'req-xyz',
              'elapsed-time': '9.5',
            },
          },
        )
      }),
      // Fallback (in case the environment does not route via the dev proxy)
      http.post('https://example.search.windows.net/indexes/myindex/docs/search', async ({ request }) => {
        const url = new URL(request.url)
        observed.apiVersion = url.searchParams.get('api-version') ?? undefined
        observed.target = request.headers.get('x-ais-proxy-target') ?? undefined
        observed.apiKey = request.headers.get('api-key') ?? undefined
        observed.idempotent = request.headers.get('x-ais-idempotent') ?? undefined

        return HttpResponse.json(
          { value: [] },
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'request-id': 'req-xyz',
              'elapsed-time': '9.5',
            },
          },
        )
      }),
    )

    const result = await searchDocuments({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2025-09-01',
        authType: 'apiKey',
        apiKey: 'k',
      },
      indexName: 'myindex',
      apiVersion: '2025-09-01',
      body: { search: 'hi' },
      language: 'ja',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.requestId).toBe('req-xyz')
    expect(result.elapsedTimeMs).toBeCloseTo(9.5)

    expect(observed.apiVersion).toBe('2025-09-01')
    expect(observed.apiKey).toBe('k')
    // When routed via dev proxy, these should be present.
    if (observed.target) {
      expect(observed.target).toBe('https://example.search.windows.net')
      expect(observed.idempotent).toBe('true')
    }
  })

  it('normalizes error shape and message from service JSON', async () => {
    server.use(
      http.post('/api-proxy/indexes/myindex/docs/search', async () => {
        return HttpResponse.json(
          { error: { message: 'bad request' } },
          { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req-400' } },
        )
      }),
      http.post('https://example.search.windows.net/indexes/myindex/docs/search', async () => {
        return HttpResponse.json(
          { error: { message: 'bad request' } },
          { status: 400, headers: { 'content-type': 'application/json', 'request-id': 'req-400' } },
        )
      }),
    )

    const result = await searchDocuments({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2025-09-01',
        authType: 'apiKey',
        apiKey: 'k',
      },
      indexName: 'myindex',
      apiVersion: '2025-09-01',
      body: { search: 'hi' },
      language: 'ja',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.status).toBe(400)
    expect(result.requestId).toBe('req-400')
    expect(result.error.message).toBe('HTTP 400: bad request')
    expect(asRecord(result.error.response).error).toBeTruthy()
  })

  it('returns HTTP 429 with a normalized message (rate limited)', async () => {
    server.use(
      http.post('/api-proxy/indexes/myindex/docs/search', async () => {
        return HttpResponse.json(
          { error: { message: 'Too many requests' } },
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'request-id': 'req-429',
              'retry-after': '5',
            },
          },
        )
      }),
      http.post('https://example.search.windows.net/indexes/myindex/docs/search', async () => {
        return HttpResponse.json(
          { error: { message: 'Too many requests' } },
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'request-id': 'req-429',
              'retry-after': '5',
            },
          },
        )
      }),
    )

    const result = await searchDocuments({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2025-09-01',
        authType: 'apiKey',
        apiKey: 'k',
      },
      indexName: 'myindex',
      apiVersion: '2025-09-01',
      body: { search: 'hi' },
      language: 'ja',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.status).toBe(429)
    expect(result.requestId).toBe('req-429')
    expect(result.error.message).toBe('HTTP 429: Too many requests')
  })

  it('treats invalid JSON responses as text and surfaces them in message', async () => {
    server.use(
      http.post('/api-proxy/indexes/myindex/docs/search', async () => {
        return new HttpResponse('not json', {
          status: 500,
          headers: {
            'content-type': 'application/json',
            'request-id': 'req-badjson',
          },
        })
      }),
      http.post('https://example.search.windows.net/indexes/myindex/docs/search', async () => {
        return new HttpResponse('not json', {
          status: 500,
          headers: {
            'content-type': 'application/json',
            'request-id': 'req-badjson',
          },
        })
      }),
    )

    const result = await searchDocuments({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2025-09-01',
        authType: 'apiKey',
        apiKey: 'k',
      },
      indexName: 'myindex',
      apiVersion: '2025-09-01',
      body: { search: 'hi' },
      language: 'ja',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.status).toBe(500)
    expect(result.requestId).toBe('req-badjson')
    expect(result.error.response).toBeUndefined()
    expect(result.error.responseText).toBe('not json')
    expect(result.error.message).toBe('HTTP 500: not json')
  })

  it('returns status=0 with a localized network error message when fetch throws', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    const result = await searchDocuments({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2025-09-01',
        authType: 'apiKey',
        apiKey: 'k',
      },
      indexName: 'myindex',
      apiVersion: '2025-09-01',
      body: { search: 'hi' },
      language: 'ja',
    })

    expect(spy).toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.status).toBe(0)
    expect(result.error.message).toContain('ネットワークエラー')
  })

  it('covers list/get/stats/analyze endpoints (happy path)', async () => {
    server.use(
      http.get('/api-proxy/indexes', async ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('api-version')).toBe('2025-09-01')
        expect(url.searchParams.has('$top')).toBe(false)
        expect(url.searchParams.has('$skip')).toBe(false)
        expect(url.searchParams.has('$count')).toBe(false)
        return HttpResponse.json(
          { value: [{ name: 'index1' }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-list' } },
        )
      }),
      http.get('https://example.search.windows.net/indexes', async ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('api-version')).toBe('2025-09-01')
        expect(url.searchParams.has('$top')).toBe(false)
        expect(url.searchParams.has('$skip')).toBe(false)
        expect(url.searchParams.has('$count')).toBe(false)
        return HttpResponse.json(
          { value: [{ name: 'index1' }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-list' } },
        )
      }),

      http.get('/api-proxy/indexes/myindex', async () => {
        return HttpResponse.json(
          { name: 'myindex' },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-def' } },
        )
      }),
      http.get('https://example.search.windows.net/indexes/myindex', async () => {
        return HttpResponse.json(
          { name: 'myindex' },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-def' } },
        )
      }),

      http.get('/api-proxy/indexes/myindex/stats', async () => {
        return HttpResponse.json({ documentCount: 1 }, { status: 200, headers: { 'content-type': 'application/json' } })
      }),
      http.get('https://example.search.windows.net/indexes/myindex/stats', async () => {
        return HttpResponse.json({ documentCount: 1 }, { status: 200, headers: { 'content-type': 'application/json' } })
      }),

      http.post('/api-proxy/indexes/myindex/analyze', async () => {
        return HttpResponse.json(
          { tokens: [{ token: 'hello', startOffset: 0, endOffset: 5, position: 0 }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-analyze' } },
        )
      }),
      http.post('https://example.search.windows.net/indexes/myindex/analyze', async () => {
        return HttpResponse.json(
          { tokens: [{ token: 'hello', startOffset: 0, endOffset: 5, position: 0 }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-analyze' } },
        )
      }),

      http.post('/api-proxy/indexes/myindex/docs/autocomplete', async ({ request }) => {
        const body = asRecord(await request.json())
        expect(body.search).toBe('lap')
        expect(body.suggesterName).toBe('sg')
        return HttpResponse.json(
          { value: [{ text: 'laptop' }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-autocomplete' } },
        )
      }),
      http.post('https://example.search.windows.net/indexes/myindex/docs/autocomplete', async ({ request }) => {
        const body = asRecord(await request.json())
        expect(body.search).toBe('lap')
        expect(body.suggesterName).toBe('sg')
        return HttpResponse.json(
          { value: [{ text: 'laptop' }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-autocomplete' } },
        )
      }),

      http.post('/api-proxy/indexes/myindex/docs/suggest', async ({ request }) => {
        const body = asRecord(await request.json())
        expect(body.search).toBe('lap')
        expect(body.suggesterName).toBe('sg')
        return HttpResponse.json(
          { value: [{ text: 'Laptop', document: { id: '1' } }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-suggest' } },
        )
      }),
      http.post('https://example.search.windows.net/indexes/myindex/docs/suggest', async ({ request }) => {
        const body = asRecord(await request.json())
        expect(body.search).toBe('lap')
        expect(body.suggesterName).toBe('sg')
        return HttpResponse.json(
          { value: [{ text: 'Laptop', document: { id: '1' } }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-suggest' } },
        )
      }),
    )

    const profile = {
      endpoint: 'https://example.search.windows.net',
      apiVersion: '2025-09-01' as const,
      authType: 'apiKey' as const,
      apiKey: 'k',
    }

    const list = await listIndexes({ profile, apiVersion: '2025-09-01', language: 'ja' })
    expect(list.ok).toBe(true)
    if (list.ok) {
      expect(asRecord(list.response).value).toBeTruthy()
      expect(list.requestId).toBe('req-list')
    }

    const def = await getIndexDefinition({ profile, indexName: 'myindex', apiVersion: '2025-09-01', language: 'ja' })
    expect(def.ok).toBe(true)
    if (def.ok) {
      expect(asRecord(def.response).name).toBe('myindex')
      expect(def.requestId).toBe('req-def')
    }

    const stats = await getIndexStatistics({ profile, indexName: 'myindex', apiVersion: '2025-09-01', language: 'ja' })
    expect(stats.ok).toBe(true)

    const analyzed = await analyzeIndex({
      profile,
      indexName: 'myindex',
      apiVersion: '2025-09-01',
      body: { text: 'hello', analyzer: 'standard.lucene' },
      language: 'ja',
    })
    expect(analyzed.ok).toBe(true)
    if (analyzed.ok) expect(analyzed.requestId).toBe('req-analyze')

    const autocomplete = await autocompleteDocuments({
      profile,
      indexName: 'myindex',
      apiVersion: '2025-09-01',
      body: { search: 'lap', suggesterName: 'sg' },
      language: 'ja',
    })
    expect(autocomplete.ok).toBe(true)
    if (autocomplete.ok) expect(autocomplete.requestId).toBe('req-autocomplete')

    const suggest = await suggestDocuments({
      profile,
      indexName: 'myindex',
      apiVersion: '2025-09-01',
      body: { search: 'lap', suggesterName: 'sg' },
      language: 'ja',
    })
    expect(suggest.ok).toBe(true)
    if (suggest.ok) expect(suggest.requestId).toBe('req-suggest')
  })

  it('retries with the paged preview API after the Serverless-specific 400 response', async () => {
    const observedRequests: Array<{ apiVersion: string; skip: string }> = []
    const handlePage = async ({ request }: { request: Request }) => {
      const url = new URL(request.url)
      const apiVersion = url.searchParams.get('api-version') ?? ''
      const skip = url.searchParams.get('$skip') ?? ''
      observedRequests.push({ apiVersion, skip })

      if (apiVersion === '2025-09-01') {
        return HttpResponse.json(
          { error: { message: 'Serverless services cannot enumerate resources without paging. Use a more recent API version that supports search/pageSize pagination.' } },
          { status: 400 },
        )
      }

      if (skip === '0') {
        return HttpResponse.json({
          '@odata.count': 1001,
          value: Array.from({ length: 1000 }, (_, index) => ({ name: `index-${index}` })),
        })
      }

      return HttpResponse.json({
        '@odata.count': 1001,
        value: [{ name: 'index-1000' }],
      })
    }

    server.use(
      http.get('/api-proxy/indexes', handlePage),
      http.get('https://example.search.windows.net/indexes', handlePage),
    )

    const result = await listIndexes({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2025-09-01',
        authType: 'apiKey',
        apiKey: 'k',
      },
      apiVersion: '2025-09-01',
      language: 'ja',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const values = asRecord(result.response).value
    expect(Array.isArray(values)).toBe(true)
    expect(values).toHaveLength(1001)
    expect(observedRequests).toEqual([
      { apiVersion: '2025-09-01', skip: '' },
      { apiVersion: '2026-05-01-preview', skip: '0' },
      { apiVersion: '2026-05-01-preview', skip: '1000' },
    ])
  })

  it('follows opaque cursor links for 2026-08-01-preview index lists', async () => {
    const observedUrls: string[] = []
    server.use(
      http.get('/api-proxy/indexes', async ({ request }) => {
        const url = new URL(request.url)
        observedUrls.push(`${url.pathname}${url.search}`)
        if (!url.searchParams.has('$skiptoken')) {
          return HttpResponse.json({
            value: [{ name: 'index-1' }],
            '@odata.nextLink': 'https://example.search.windows.net/indexes?api-version=2026-08-01-preview&$skiptoken=opaque%2Bcursor',
          })
        }
        return HttpResponse.json({ value: [{ name: 'index-2' }] })
      }),
    )

    const result = await listIndexes({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2026-08-01-preview',
        authType: 'apiKey',
        apiKey: 'k',
      },
      apiVersion: '2026-08-01-preview',
      language: 'ja',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(asRecord(result.response).value).toEqual([{ name: 'index-1' }, { name: 'index-2' }])
    expect(observedUrls).toEqual([
      '/api-proxy/indexes?api-version=2026-08-01-preview&pageSize=1000',
      '/api-proxy/indexes?api-version=2026-08-01-preview&$skiptoken=opaque%2Bcursor',
    ])
  })

  it('uses cursor list parameters without duplicating the dev proxy for knowledge resources', async () => {
    const observedUrls: string[] = []
    server.use(
      http.get('/api-proxy/knowledgebases', ({ request }) => {
        const url = new URL(request.url)
        observedUrls.push(`${url.pathname}${url.search}`)
        return HttpResponse.json({ value: [{ name: 'kb1' }] })
      }),
      http.get('/api-proxy/knowledgesources', ({ request }) => {
        const url = new URL(request.url)
        observedUrls.push(`${url.pathname}${url.search}`)
        return HttpResponse.json({ value: [{ name: 'ks-web', kind: 'web' }] })
      }),
    )
    const profile = {
      endpoint: 'https://example.search.windows.net',
      apiVersion: '2026-08-01-preview' as const,
      authType: 'apiKey' as const,
      apiKey: 'k',
    }

    const knowledgeBases = await listKnowledgeBases({ profile, language: 'ja' })
    const knowledgeSources = await listKnowledgeSources({ profile, language: 'ja' })

    expect(knowledgeBases.ok).toBe(true)
    expect(knowledgeSources.ok).toBe(true)
    expect(observedUrls).toEqual([
      '/api-proxy/knowledgebases?api-version=2026-08-01-preview&pageSize=1000',
      '/api-proxy/knowledgesources?api-version=2026-08-01-preview&pageSize=1000',
    ])
  })

  it('rejects cross-origin cursor links before forwarding credentials', async () => {
    server.use(
      http.get('/api-proxy/indexes', () => HttpResponse.json({
        value: [{ name: 'index-1' }],
        '@odata.nextLink': 'https://untrusted.example/indexes?$skiptoken=cursor',
      })),
    )

    const result = await listIndexes({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2026-08-01-preview',
        authType: 'apiKey',
        apiKey: 'k',
      },
      apiVersion: '2026-08-01-preview',
      language: 'ja',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.message).toContain('cross-origin')
  })

  it('does not retry a non-Serverless 400 response with a newer API version', async () => {
    const observedApiVersions: string[] = []
    const handleError = async ({ request }: { request: Request }) => {
      const url = new URL(request.url)
      observedApiVersions.push(url.searchParams.get('api-version') ?? '')
      return HttpResponse.json({ error: { message: 'Invalid request' } }, { status: 400 })
    }

    server.use(
      http.get('/api-proxy/indexes', handleError),
      http.get('https://example.search.windows.net/indexes', handleError),
    )

    const result = await listIndexes({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2025-09-01',
        authType: 'apiKey',
        apiKey: 'k',
      },
      apiVersion: '2025-09-01',
      language: 'ja',
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.error.message).toBe('HTTP 400: Invalid request')
    expect(observedApiVersions).toEqual(['2025-09-01'])
  })

  it('covers Knowledge Base CRUD (list/get/put/delete)', async () => {
    server.use(
      http.get('/api-proxy/knowledgebases', async ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('$select')).toBe('name')
        return HttpResponse.json(
          { value: [{ name: 'kb1' }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-kb-list' } },
        )
      }),
      http.get('https://example.search.windows.net/knowledgebases', async ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('$select')).toBe('name')
        return HttpResponse.json(
          { value: [{ name: 'kb1' }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-kb-list' } },
        )
      }),

      http.get('/api-proxy/knowledgebases/kb1', async () => {
        return HttpResponse.json(
          { name: 'kb1', description: 'desc' },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-kb-get' } },
        )
      }),
      http.get('https://example.search.windows.net/knowledgebases/kb1', async () => {
        return HttpResponse.json(
          { name: 'kb1', description: 'desc' },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-kb-get' } },
        )
      }),

      http.put('/api-proxy/knowledgebases/kb1', async ({ request }) => {
        const body = (await request.json()) as unknown
        expect(asRecord(body).name).toBe('kb1')
        return HttpResponse.json(
          { name: 'kb1', kind: 'knowledgeBase' },
          { status: 201, headers: { 'content-type': 'application/json', 'request-id': 'req-kb-put' } },
        )
      }),
      http.put('https://example.search.windows.net/knowledgebases/kb1', async ({ request }) => {
        const body = (await request.json()) as unknown
        expect(asRecord(body).name).toBe('kb1')
        return HttpResponse.json(
          { name: 'kb1', kind: 'knowledgeBase' },
          { status: 201, headers: { 'content-type': 'application/json', 'request-id': 'req-kb-put' } },
        )
      }),

      http.delete('/api-proxy/knowledgebases/kb1', async () => {
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-kb-del' } })
      }),
      http.delete('https://example.search.windows.net/knowledgebases/kb1', async () => {
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-kb-del' } })
      }),
    )

    const profile = {
      endpoint: 'https://example.search.windows.net',
      apiVersion: '2025-09-01' as const,
      authType: 'apiKey' as const,
      apiKey: 'k',
    }

    const list = await listKnowledgeBases({ profile, language: 'ja' })
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.requestId).toBe('req-kb-list')

    const got = await getKnowledgeBase({ profile, knowledgeBaseName: 'kb1', language: 'ja' })
    expect(got.ok).toBe(true)
    if (got.ok) {
      expect(got.requestId).toBe('req-kb-get')
      expect(asRecord(got.response).name).toBe('kb1')
    }

    const upsert = await createOrUpdateKnowledgeBase({
      profile,
      knowledgeBaseName: 'kb1',
      body: { name: 'kb1' },
      language: 'ja',
    })
    expect(upsert.ok).toBe(true)
    if (upsert.ok) expect(upsert.requestId).toBe('req-kb-put')

    const del = await deleteKnowledgeBase({ profile, knowledgeBaseName: 'kb1', language: 'ja' })
    expect(del.ok).toBe(true)
    if (del.ok) expect(del.requestId).toBe('req-kb-del')
  })

  it('covers Knowledge Source CRUD (list/get/put/delete)', async () => {
    server.use(
      http.get('/api-proxy/knowledgesources', async ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('$select')).toBe('name,kind')
        return HttpResponse.json(
          { value: [{ name: 'ks1', kind: 'searchIndex' }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-ks-list' } },
        )
      }),
      http.get('https://example.search.windows.net/knowledgesources', async ({ request }) => {
        const url = new URL(request.url)
        expect(url.searchParams.get('$select')).toBe('name,kind')
        return HttpResponse.json(
          { value: [{ name: 'ks1', kind: 'searchIndex' }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-ks-list' } },
        )
      }),

      http.get('/api-proxy/knowledgesources/ks1', async () => {
        return HttpResponse.json(
          { name: 'ks1', kind: 'searchIndex' },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-ks-get' } },
        )
      }),
      http.get('https://example.search.windows.net/knowledgesources/ks1', async () => {
        return HttpResponse.json(
          { name: 'ks1', kind: 'searchIndex' },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-ks-get' } },
        )
      }),

      http.put('/api-proxy/knowledgesources/ks1', async ({ request }) => {
        const body = (await request.json()) as unknown
        expect(asRecord(body).name).toBe('ks1')
        return HttpResponse.json(
          { name: 'ks1', kind: 'searchIndex' },
          { status: 201, headers: { 'content-type': 'application/json', 'request-id': 'req-ks-put' } },
        )
      }),
      http.put('https://example.search.windows.net/knowledgesources/ks1', async ({ request }) => {
        const body = (await request.json()) as unknown
        expect(asRecord(body).name).toBe('ks1')
        return HttpResponse.json(
          { name: 'ks1', kind: 'searchIndex' },
          { status: 201, headers: { 'content-type': 'application/json', 'request-id': 'req-ks-put' } },
        )
      }),

      http.delete('/api-proxy/knowledgesources/ks1', async () => {
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-ks-del' } })
      }),
      http.delete('https://example.search.windows.net/knowledgesources/ks1', async () => {
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-ks-del' } })
      }),
    )

    const profile = {
      endpoint: 'https://example.search.windows.net',
      apiVersion: '2025-09-01' as const,
      authType: 'apiKey' as const,
      apiKey: 'k',
    }

    const list = await listKnowledgeSources({ profile, language: 'ja' })
    expect(list.ok).toBe(true)
    if (list.ok) expect(list.requestId).toBeTruthy()

    const got = await getKnowledgeSource({ profile, knowledgeSourceName: 'ks1', language: 'ja' })
    expect(got.ok).toBe(true)

    const upsert = await createOrUpdateKnowledgeSource({
      profile,
      knowledgeSourceName: 'ks1',
      body: { name: 'ks1', kind: 'searchIndex' },
      language: 'ja',
    })
    expect(upsert.ok).toBe(true)

    const del = await deleteKnowledgeSource({ profile, knowledgeSourceName: 'ks1', language: 'ja' })
    expect(del.ok).toBe(true)
  })

  it('covers SynonymMap CRUD (list/get/put/delete)', async () => {
    server.use(
      http.get('/api-proxy/synonymmaps', async () => {
        return HttpResponse.json(
          { value: [{ name: 'sm1' }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-sm-list' } },
        )
      }),
      http.get('https://example.search.windows.net/synonymmaps', async () => {
        return HttpResponse.json(
          { value: [{ name: 'sm1' }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-sm-list' } },
        )
      }),

      http.get('/api-proxy/synonymmaps/sm1', async () => {
        return HttpResponse.json(
          { name: 'sm1', synonyms: 'a,b' },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-sm-get' } },
        )
      }),
      http.get('https://example.search.windows.net/synonymmaps/sm1', async () => {
        return HttpResponse.json(
          { name: 'sm1', synonyms: 'a,b' },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-sm-get' } },
        )
      }),

      http.put('/api-proxy/synonymmaps/sm1', async ({ request }) => {
        const body = (await request.json()) as unknown
        expect(asRecord(body).synonyms).toBe('a,b')
        return HttpResponse.json(
          { name: 'sm1', synonyms: 'a,b' },
          { status: 201, headers: { 'content-type': 'application/json', 'request-id': 'req-sm-put' } },
        )
      }),
      http.put('https://example.search.windows.net/synonymmaps/sm1', async ({ request }) => {
        const body = (await request.json()) as unknown
        expect(asRecord(body).synonyms).toBe('a,b')
        return HttpResponse.json(
          { name: 'sm1', synonyms: 'a,b' },
          { status: 201, headers: { 'content-type': 'application/json', 'request-id': 'req-sm-put' } },
        )
      }),

      http.delete('/api-proxy/synonymmaps/sm1', async () => {
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-sm-del' } })
      }),
      http.delete('https://example.search.windows.net/synonymmaps/sm1', async () => {
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-sm-del' } })
      }),
    )

    const profile = {
      endpoint: 'https://example.search.windows.net',
      apiVersion: '2025-09-01' as const,
      authType: 'apiKey' as const,
      apiKey: 'k',
    }

    const list = await listSynonymMaps({ profile, language: 'ja' })
    expect(list.ok).toBe(true)

    const get = await getSynonymMap({ profile, synonymMapName: 'sm1', language: 'ja' })
    expect(get.ok).toBe(true)

    const put = await createOrUpdateSynonymMap({
      profile,
      synonymMapName: 'sm1',
      body: { name: 'sm1', synonyms: 'a,b' },
      language: 'ja',
    })
    expect(put.ok).toBe(true)

    const del = await deleteSynonymMap({ profile, synonymMapName: 'sm1', language: 'ja' })
    expect(del.ok).toBe(true)
  })

  it('covers Index PUT/DELETE and agenticRetrieve error handling', async () => {
    server.use(
      http.put('/api-proxy/indexes/myindex', async ({ request }) => {
        expect(new URL(request.url).searchParams.get('allowIndexDowntime')).toBeNull()
        const body = (await request.json()) as unknown
        expect(asRecord(body).name).toBe('myindex')
        return HttpResponse.json(
          { name: 'myindex' },
          { status: 201, headers: { 'content-type': 'application/json', 'request-id': 'req-idx-put' } },
        )
      }),
      http.put('https://example.search.windows.net/indexes/myindex', async ({ request }) => {
        expect(new URL(request.url).searchParams.get('allowIndexDowntime')).toBeNull()
        const body = (await request.json()) as unknown
        expect(asRecord(body).name).toBe('myindex')
        return HttpResponse.json(
          { name: 'myindex' },
          { status: 201, headers: { 'content-type': 'application/json', 'request-id': 'req-idx-put' } },
        )
      }),

      http.delete('/api-proxy/indexes/myindex', async () => {
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-idx-del' } })
      }),
      http.delete('https://example.search.windows.net/indexes/myindex', async () => {
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-idx-del' } })
      }),

      http.post('/api-proxy/knowledgebases/kb1/retrieve', async ({ request }) => {
        expect(new URL(request.url).searchParams.get('api-version')).toBe('2026-05-01-preview')
        return HttpResponse.json(
          { error: { message: 'forbidden' } },
          { status: 403, headers: { 'content-type': 'application/json', 'request-id': 'req-agt-403' } },
        )
      }),
      http.post('https://example.search.windows.net/knowledgebases/kb1/retrieve', async ({ request }) => {
        expect(new URL(request.url).searchParams.get('api-version')).toBe('2026-05-01-preview')
        return HttpResponse.json(
          { error: { message: 'forbidden' } },
          { status: 403, headers: { 'content-type': 'application/json', 'request-id': 'req-agt-403' } },
        )
      }),
    )

    const profile = {
      endpoint: 'https://example.search.windows.net',
      apiVersion: '2026-05-01-preview' as const,
      authType: 'apiKey' as const,
      apiKey: 'k',
    }

    const put = await createOrUpdateIndex({
      profile,
      indexName: 'myindex',
      apiVersion: '2025-09-01',
      body: { name: 'myindex' },
      language: 'ja',
    })
    expect(put.ok).toBe(true)
    if (put.ok) expect(put.requestId).toBe('req-idx-put')

    const del = await deleteIndex({ profile, indexName: 'myindex', apiVersion: '2025-09-01', language: 'ja' })
    expect(del.ok).toBe(true)
    if (del.ok) expect(del.requestId).toBe('req-idx-del')

    const agt = await agenticRetrieve({
      profile,
      knowledgeBaseName: 'kb1',
      body: { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
      language: 'ja',
    })
    expect(agt.ok).toBe(false)
    if (agt.ok) return
    expect(agt.status).toBe(403)
    // agenticRetrieve intentionally does not run extractErrorMessage.
    expect(agt.error.message).toBe('HTTP 403')
  })

  it('adds allowIndexDowntime only when index downtime is explicitly allowed', async () => {
    const handler = http.put('*/indexes/myindex', async ({ request }) => {
      expect(new URL(request.url).searchParams.get('allowIndexDowntime')).toBe('true')
      return HttpResponse.json(
        { name: 'myindex' },
        { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-idx-downtime' } },
      )
    })
    server.use(handler)

    const result = await createOrUpdateIndex({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2025-09-01',
        authType: 'apiKey',
        apiKey: 'k',
      },
      indexName: 'myindex',
      apiVersion: '2025-09-01',
      body: { name: 'myindex' },
      allowIndexDowntime: true,
      language: 'ja',
    })

    expect(result.ok).toBe(true)
    expect(result.url).toContain('allowIndexDowntime=true')
  })

  it('posts indexer reset with api-version and request id', async () => {
    const observed: { apiVersion?: string; apiKey?: string; clientRequestId?: string; target?: string } = {}
    server.use(
      http.post('/api-proxy/indexers/myindexer/reset', async ({ request }) => {
        const url = new URL(request.url)
        observed.apiVersion = url.searchParams.get('api-version') ?? undefined
        observed.apiKey = request.headers.get('api-key') ?? undefined
        observed.clientRequestId = request.headers.get('x-ms-client-request-id') ?? undefined
        observed.target = request.headers.get('x-ais-proxy-target') ?? undefined
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-reset' } })
      }),
      http.post('https://example.search.windows.net/indexers/myindexer/reset', async ({ request }) => {
        const url = new URL(request.url)
        observed.apiVersion = url.searchParams.get('api-version') ?? undefined
        observed.apiKey = request.headers.get('api-key') ?? undefined
        observed.clientRequestId = request.headers.get('x-ms-client-request-id') ?? undefined
        observed.target = request.headers.get('x-ais-proxy-target') ?? undefined
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-reset' } })
      }),
    )

    const result = await resetIndexer({
      profile: {
        endpoint: 'https://example.search.windows.net',
        apiVersion: '2025-09-01',
        authType: 'apiKey',
        apiKey: 'k',
      },
      indexerName: 'myindexer',
      apiVersion: '2025-09-01',
      language: 'ja',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe(204)
    expect(result.requestId).toBe('req-reset')
    expect(result.response).toBeNull()
    expect(observed.apiVersion).toBe('2025-09-01')
    expect(observed.apiKey).toBe('k')
    expect(observed.clientRequestId).toBeTruthy()
    if (observed.target) expect(observed.target).toBe('https://example.search.windows.net')
  })

  it('covers alias list/get/put/delete operations', async () => {
    server.use(
      http.get('/api-proxy/aliases', async () => {
        return HttpResponse.json(
          { value: [{ name: 'live', indexes: ['myindex'] }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-alias-list' } },
        )
      }),
      http.get('https://example.search.windows.net/aliases', async () => {
        return HttpResponse.json(
          { value: [{ name: 'live', indexes: ['myindex'] }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-alias-list' } },
        )
      }),
      http.get('/api-proxy/aliases/live', async () => {
        return HttpResponse.json(
          { name: 'live', indexes: ['myindex'] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-alias-get' } },
        )
      }),
      http.get('https://example.search.windows.net/aliases/live', async () => {
        return HttpResponse.json(
          { name: 'live', indexes: ['myindex'] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-alias-get' } },
        )
      }),
      http.put('/api-proxy/aliases/live', async ({ request }) => {
        const body = asRecord(await request.json())
        expect(body.name).toBe('live')
        expect(body.indexes).toEqual(['myindex-v2'])
        return HttpResponse.json(
          { name: 'live', indexes: ['myindex-v2'] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-alias-put' } },
        )
      }),
      http.put('https://example.search.windows.net/aliases/live', async ({ request }) => {
        const body = asRecord(await request.json())
        expect(body.name).toBe('live')
        expect(body.indexes).toEqual(['myindex-v2'])
        return HttpResponse.json(
          { name: 'live', indexes: ['myindex-v2'] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-alias-put' } },
        )
      }),
      http.delete('/api-proxy/aliases/live', async () => {
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-alias-del' } })
      }),
      http.delete('https://example.search.windows.net/aliases/live', async () => {
        return new HttpResponse(null, { status: 204, headers: { 'request-id': 'req-alias-del' } })
      }),
    )

    const profile = {
      endpoint: 'https://example.search.windows.net',
      apiVersion: '2025-09-01' as const,
      authType: 'apiKey' as const,
      apiKey: 'k',
    }

    const list = await listAliases({ profile, apiVersion: '2025-09-01', language: 'ja' })
    expect(list.ok).toBe(true)
    if (list.ok) {
      expect(asRecord(list.response).value).toBeTruthy()
      expect(list.requestId).toBe('req-alias-list')
    }

    const get = await getAliasDefinition({ profile, aliasName: 'live', apiVersion: '2025-09-01', language: 'ja' })
    expect(get.ok).toBe(true)
    if (get.ok) {
      expect(asRecord(get.response).name).toBe('live')
      expect(get.requestId).toBe('req-alias-get')
    }

    const put = await createOrUpdateAlias({
      profile,
      aliasName: 'live',
      apiVersion: '2025-09-01',
      body: { name: 'live', indexes: ['myindex-v2'] },
      language: 'ja',
    })
    expect(put.ok).toBe(true)
    if (put.ok) expect(put.requestId).toBe('req-alias-put')

    const del = await deleteAlias({ profile, aliasName: 'live', apiVersion: '2025-09-01', language: 'ja' })
    expect(del.ok).toBe(true)
    if (del.ok) expect(del.requestId).toBe('req-alias-del')
  })
})
