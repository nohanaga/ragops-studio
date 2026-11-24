import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getKnowledgeBase,
  getKnowledgeSource,
  listIndexes,
  listKnowledgeBases,
  listKnowledgeSources,
  type RestResult,
} from './aiSearchRest'
import { MAX_DETAIL_REQUESTS, loadDependencySnapshot } from './indexDependencyLoader'
import type { ConnectionProfile } from './model'

vi.mock('./aiSearchRest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiSearchRest')>()
  return {
    ...actual,
    getKnowledgeBase: vi.fn(),
    getKnowledgeSource: vi.fn(),
    listIndexes: vi.fn(),
    listKnowledgeBases: vi.fn(),
    listKnowledgeSources: vi.fn(),
  }
})

const profile: ConnectionProfile = { endpoint: 'https://example.search.windows.net', apiVersion: '2026-11-01-preview', authType: 'apiKey', apiKey: 'key' }
const load = () => loadDependencySnapshot({ profile, apiVersion: '2026-11-01-preview', language: 'ja' })

function ok(response: unknown): RestResult {
  return { ok: true, status: 200, requestId: 'req', url: 'https://example.search.windows.net', response: response as never }
}

function failed(message: string, status = 400): RestResult {
  return { ok: false, status, requestId: 'req', url: 'https://example.search.windows.net', error: { message } }
}

describe('lib/indexDependencyLoader', () => {
  beforeEach(() => {
    vi.mocked(getKnowledgeBase).mockReset()
    vi.mocked(getKnowledgeSource).mockReset()
    vi.mocked(listIndexes).mockReset()
    vi.mocked(listKnowledgeBases).mockReset()
    vi.mocked(listKnowledgeSources).mockReset()
  })

  it('uses the list responses as they are when they already contain the definitions', async () => {
    vi.mocked(listIndexes).mockResolvedValue(ok({ value: [{ name: 'docs' }] }))
    vi.mocked(listKnowledgeSources).mockResolvedValue(ok({ value: [{ name: 'ks', kind: 'searchIndex', searchIndexParameters: { searchIndexName: 'docs' } }] }))
    vi.mocked(listKnowledgeBases).mockResolvedValue(ok({ value: [{ name: 'kb', knowledgeSources: [{ name: 'ks' }] }] }))

    const result = await load()

    expect(result.errors).toEqual([])
    expect(result.snapshot.indexes).toEqual([{ name: 'docs' }])
    expect(result.snapshot.knowledgeBases).toEqual([{ name: 'kb', knowledgeSources: [{ name: 'ks' }] }])
    expect(getKnowledgeSource).not.toHaveBeenCalled()
    expect(getKnowledgeBase).not.toHaveBeenCalled()
  })

  it('reads the definitions one by one when the lists return only names', async () => {
    vi.mocked(listIndexes).mockResolvedValue(ok({ value: [] }))
    vi.mocked(listKnowledgeSources).mockResolvedValue(ok({ value: [{ name: 'ks', kind: 'searchIndex' }] }))
    vi.mocked(listKnowledgeBases).mockResolvedValue(ok({ value: [{ name: 'kb' }] }))
    vi.mocked(getKnowledgeSource).mockResolvedValue(ok({ name: 'ks', kind: 'searchIndex', searchIndexParameters: { searchIndexName: 'docs' } }))
    vi.mocked(getKnowledgeBase).mockResolvedValue(ok({ name: 'kb', knowledgeSources: [{ name: 'ks' }] }))

    const result = await load()

    expect(getKnowledgeSource).toHaveBeenCalledWith(expect.objectContaining({ knowledgeSourceName: 'ks' }))
    expect(getKnowledgeBase).toHaveBeenCalledWith(expect.objectContaining({ knowledgeBaseName: 'kb' }))
    expect(result.snapshot.knowledgeSources[0]).toMatchObject({ searchIndexParameters: { searchIndexName: 'docs' } })
    expect(result.snapshot.knowledgeBases[0]).toMatchObject({ knowledgeSources: [{ name: 'ks' }] })
  })

  it('keeps what could be read when one resource fails or throws', async () => {
    vi.mocked(listIndexes).mockResolvedValue(ok({ value: [{ name: 'docs' }] }))
    vi.mocked(listKnowledgeSources).mockRejectedValue(new Error('endpoint is not set'))
    vi.mocked(listKnowledgeBases).mockResolvedValue(failed('Forbidden', 403))

    const result = await load()

    expect(result.snapshot).toEqual({ indexes: [{ name: 'docs' }], knowledgeSources: [], knowledgeBases: [] })
    expect(result.errors).toEqual([
      { resource: 'knowledgeSources', message: 'endpoint is not set' },
      { resource: 'knowledgeBases', message: 'Forbidden' },
    ])
  })

  it('keeps the list item and reports the error when a definition cannot be read', async () => {
    vi.mocked(listIndexes).mockResolvedValue(ok({ value: [] }))
    vi.mocked(listKnowledgeSources).mockResolvedValue(ok({ value: [{ name: 'ks', kind: 'searchIndex' }] }))
    vi.mocked(listKnowledgeBases).mockResolvedValue(ok({ value: [] }))
    vi.mocked(getKnowledgeSource).mockResolvedValue(failed('Not found', 404))

    const result = await load()

    expect(result.snapshot.knowledgeSources).toEqual([{ name: 'ks', kind: 'searchIndex' }])
    expect(result.errors).toEqual([{ resource: 'knowledgeSources', message: 'Not found' }])
  })

  it('caps the number of detail requests and reports the definitions that were skipped', async () => {
    const names = Array.from({ length: MAX_DETAIL_REQUESTS + 5 }, (_value, position) => ({ name: `ks-${position}`, kind: 'searchIndex' }))
    vi.mocked(listIndexes).mockResolvedValue(ok({ value: [] }))
    vi.mocked(listKnowledgeSources).mockResolvedValue(ok({ value: names }))
    vi.mocked(listKnowledgeBases).mockResolvedValue(ok({ value: [{ name: 'kb' }] }))
    vi.mocked(getKnowledgeSource).mockImplementation(async (input) => ok({ name: input.knowledgeSourceName, kind: 'searchIndex', searchIndexParameters: {} }))

    const result = await load()

    expect(getKnowledgeSource).toHaveBeenCalledTimes(MAX_DETAIL_REQUESTS)
    expect(getKnowledgeBase).not.toHaveBeenCalled()
    expect(result.skippedDetails).toBe(6)
  })
})
