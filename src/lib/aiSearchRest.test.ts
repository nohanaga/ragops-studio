// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'

import { server } from '../test/mswServer'
import {
  agenticRetrieve,
  analyzeIndex,
  createOrUpdateIndex,
  createOrUpdateKnowledgeBase,
  createOrUpdateKnowledgeSource,
  createOrUpdateSynonymMap,
  deleteIndex,
  deleteKnowledgeBase,
  deleteKnowledgeSource,
  deleteSynonymMap,
  getIndexDefinition,
  getIndexStatistics,
  getKnowledgeBase,
  getKnowledgeSource,
  getSynonymMap,
  listIndexes,
  listKnowledgeBases,
  listKnowledgeSources,
  listSynonymMaps,
  searchDocuments,
} from './aiSearchRest'

function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return v as Record<string, unknown>
}

describe('lib/aiSearchRest', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Failed to fetch'))

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
      http.get('/api-proxy/indexes', async () => {
        return HttpResponse.json(
          { value: [{ name: 'index1' }] },
          { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req-list' } },
        )
      }),
      http.get('https://example.search.windows.net/indexes', async () => {
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
        const body = (await request.json()) as unknown
        expect(asRecord(body).name).toBe('myindex')
        return HttpResponse.json(
          { name: 'myindex' },
          { status: 201, headers: { 'content-type': 'application/json', 'request-id': 'req-idx-put' } },
        )
      }),
      http.put('https://example.search.windows.net/indexes/myindex', async ({ request }) => {
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

      http.post('/api-proxy/knowledgebases/kb1/retrieve', async () => {
        return HttpResponse.json(
          { error: { message: 'forbidden' } },
          { status: 403, headers: { 'content-type': 'application/json', 'request-id': 'req-agt-403' } },
        )
      }),
      http.post('https://example.search.windows.net/knowledgebases/kb1/retrieve', async () => {
        return HttpResponse.json(
          { error: { message: 'forbidden' } },
          { status: 403, headers: { 'content-type': 'application/json', 'request-id': 'req-agt-403' } },
        )
      }),
    )

    const profile = {
      endpoint: 'https://example.search.windows.net',
      apiVersion: '2025-09-01' as const,
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
})
