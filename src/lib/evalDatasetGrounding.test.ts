import { describe, expect, it, vi, beforeEach } from 'vitest'

import { checkGrounding, mineHardNegatives } from './evalDatasetGrounding'

vi.mock('./aiSearchRest', () => ({
  searchDocuments: vi.fn(),
}))

import { searchDocuments } from './aiSearchRest'

const mockedSearch = searchDocuments as unknown as ReturnType<typeof vi.fn>

const baseProfile = {
  endpoint: 'https://example.search.windows.net',
  apiVersion: '2024-07-01' as const,
  authType: 'apiKey' as const,
  apiKey: 'xxx',
}

describe('evalDatasetGrounding.checkGrounding', () => {
  beforeEach(() => {
    mockedSearch.mockReset()
  })

  it('returns found=true and 1-based rank when source doc is in top-k', async () => {
    mockedSearch.mockResolvedValueOnce({
      ok: true,
      response: { value: [{ docid: 'other-1' }, { docid: 'target' }, { docid: 'other-2' }] },
    })
    const r = await checkGrounding({
      profile: baseProfile,
      indexName: 'idx',
      apiVersion: '2024-07-01',
      keyField: 'docid',
      query: 'what is X',
      expectedDocId: 'target',
      topK: 10,
    })
    expect(r.found).toBe(true)
    expect(r.rank).toBe(2)
  })

  it('returns found=false and rank=0 when source doc is missing', async () => {
    mockedSearch.mockResolvedValueOnce({
      ok: true,
      response: { value: [{ docid: 'other-1' }, { docid: 'other-2' }] },
    })
    const r = await checkGrounding({
      profile: baseProfile,
      indexName: 'idx',
      apiVersion: '2024-07-01',
      keyField: 'docid',
      query: 'q',
      expectedDocId: 'target',
      topK: 5,
    })
    expect(r.found).toBe(false)
    expect(r.rank).toBe(0)
  })

  it('throws when searchDocuments fails', async () => {
    mockedSearch.mockResolvedValueOnce({ ok: false, error: { message: 'boom' } })
    await expect(
      checkGrounding({
        profile: baseProfile,
        indexName: 'idx',
        apiVersion: '2024-07-01',
        keyField: 'docid',
        query: 'q',
        expectedDocId: 'target',
        topK: 5,
      }),
    ).rejects.toThrow(/boom/)
  })

  it('short-circuits when query or expectedDocId is empty', async () => {
    const r = await checkGrounding({
      profile: baseProfile,
      indexName: 'idx',
      apiVersion: '2024-07-01',
      keyField: 'docid',
      query: '',
      expectedDocId: 'target',
      topK: 5,
    })
    expect(r.found).toBe(false)
    expect(r.rank).toBe(0)
    expect(mockedSearch).not.toHaveBeenCalled()
  })

  it('clamps topK into [1, 50] before calling search', async () => {
    mockedSearch.mockResolvedValueOnce({ ok: true, response: { value: [] } })
    await checkGrounding({
      profile: baseProfile,
      indexName: 'idx',
      apiVersion: '2024-07-01',
      keyField: 'docid',
      query: 'q',
      expectedDocId: 'target',
      topK: 999,
    })
    const callArg = mockedSearch.mock.calls[0][0] as { body: { top: number } }
    expect(callArg.body.top).toBe(50)
  })

  it('forwards abort signal to searchDocuments', async () => {
    mockedSearch.mockResolvedValueOnce({ ok: true, response: { value: [] } })
    const controller = new AbortController()
    await checkGrounding({
      profile: baseProfile,
      indexName: 'idx',
      apiVersion: '2024-07-01',
      keyField: 'docid',
      query: 'q',
      expectedDocId: 'target',
      topK: 5,
      signal: controller.signal,
    })
    const callArg = mockedSearch.mock.calls[0][0] as { signal?: AbortSignal }
    expect(callArg.signal).toBe(controller.signal)
  })
})

describe('evalDatasetGrounding.mineHardNegatives', () => {
  beforeEach(() => {
    mockedSearch.mockReset()
  })

  it('returns ids not in expected and preserves search rank order', async () => {
    mockedSearch.mockResolvedValueOnce({
      ok: true,
      response: {
        value: [
          { docid: 'pos-1' },
          { docid: 'neg-a' },
          { docid: 'neg-b' },
          { docid: 'pos-2' },
          { docid: 'neg-c' },
        ],
      },
    })
    const out = await mineHardNegatives({
      profile: baseProfile,
      indexName: 'idx',
      apiVersion: '2024-07-01',
      keyField: 'docid',
      query: 'q',
      expectedIds: ['pos-1', 'pos-2'],
      topK: 10,
      maxNegatives: 5,
      language: 'ja',
    })
    expect(out).toEqual(['neg-a', 'neg-b', 'neg-c'])
  })

  it('caps at maxNegatives', async () => {
    mockedSearch.mockResolvedValueOnce({
      ok: true,
      response: {
        value: [{ docid: 'n1' }, { docid: 'n2' }, { docid: 'n3' }],
      },
    })
    const out = await mineHardNegatives({
      profile: baseProfile,
      indexName: 'idx',
      apiVersion: '2024-07-01',
      keyField: 'docid',
      query: 'q',
      expectedIds: [],
      topK: 10,
      maxNegatives: 2,
      language: 'ja',
    })
    expect(out).toEqual(['n1', 'n2'])
  })

  it('returns empty array when query is empty', async () => {
    const out = await mineHardNegatives({
      profile: baseProfile,
      indexName: 'idx',
      apiVersion: '2024-07-01',
      keyField: 'docid',
      query: '',
      expectedIds: ['x'],
      topK: 10,
      maxNegatives: 5,
      language: 'ja',
    })
    expect(out).toEqual([])
    expect(mockedSearch).not.toHaveBeenCalled()
  })

  it('forwards abort signal to searchDocuments', async () => {
    mockedSearch.mockResolvedValueOnce({ ok: true, response: { value: [] } })
    const controller = new AbortController()
    await mineHardNegatives({
      profile: baseProfile,
      indexName: 'idx',
      apiVersion: '2024-07-01',
      keyField: 'docid',
      query: 'q',
      expectedIds: [],
      topK: 10,
      maxNegatives: 5,
      language: 'ja',
      signal: controller.signal,
    })
    const callArg = mockedSearch.mock.calls[0][0] as { signal?: AbortSignal }
    expect(callArg.signal).toBe(controller.signal)
  })
})
