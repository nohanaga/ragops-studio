// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createOrUpdateIndex, getIndexDefinition, listIndexes, type RestResult } from '../lib/aiSearchRest'
import type { ConnectionProfile, SearchApiVersion } from '../lib/model'
import { translations } from '../lib/translations'
import { useIndexPublishFlow } from './useIndexPublishFlow'

vi.mock('../lib/aiSearchRest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/aiSearchRest')>()
  return {
    ...actual,
    createOrUpdateIndex: vi.fn(),
    getIndexDefinition: vi.fn(),
    listIndexes: vi.fn(),
  }
})

const mockCreateOrUpdateIndex = vi.mocked(createOrUpdateIndex)
const mockGetIndexDefinition = vi.mocked(getIndexDefinition)
const mockListIndexes = vi.mocked(listIndexes)

const profile: ConnectionProfile = {
  endpoint: 'https://example.search.windows.net',
  apiVersion: '2026-11-01-preview',
  authType: 'apiKey',
  apiKey: 'test-key',
}

const t = (key: keyof typeof translations.ja): string => translations.ja[key]

function ok(response: unknown, status = 200): RestResult {
  return { ok: true, status, requestId: 'req', url: 'https://example.search.windows.net', response: response as never }
}

function notFound(): RestResult {
  return { ok: false, status: 404, requestId: 'req', url: 'https://example.search.windows.net', error: { message: 'Not found' } }
}

const baseline = {
  '@odata.etag': '"etag"',
  name: 'docs',
  fields: [
    { name: 'id', type: 'Edm.String', key: true },
    { name: 'embedding', type: 'Collection(Edm.Single)', dimensions: 8, vectorSearchProfile: 'vp' },
  ],
  vectorSearch: { profiles: [{ name: 'vp', algorithm: 'hnsw' }], algorithms: [{ name: 'hnsw', kind: 'hnsw' }] },
}

const candidate = {
  name: 'docs',
  fields: [
    { name: 'id', type: 'Edm.String', key: true },
    { name: 'embedding', type: 'Collection(Edm.Single)', dimensions: 8, vectorSearchProfile: 'vp', topicGraphProfile: 'topics' },
  ],
  vectorSearch: {
    profiles: [{ name: 'vp', algorithm: 'hnsw' }],
    algorithms: [{ name: 'hnsw', kind: 'hnsw' }],
    topicGraphProfiles: [{ name: 'topics', indexName: 'docs-topics', defaultKind: 'balanced', defaultMinDiversityPoolSize: 1000 }],
  },
}

function renderFlow(apiVersion: SearchApiVersion) {
  return renderHook(() => useIndexPublishFlow({ profile: { ...profile, apiVersion }, apiVersion, language: 'ja', t }))
}

describe('hooks/useIndexPublishFlow 2026-11-01-preview graph features', () => {
  beforeEach(() => {
    mockCreateOrUpdateIndex.mockReset()
    mockGetIndexDefinition.mockReset()
    mockListIndexes.mockReset()
    mockListIndexes.mockResolvedValue(ok({ value: [{ name: 'docs' }, { name: 'docs-topics' }] }))
  })

  it('stops before contacting the service when the API version cannot save the graph schema', async () => {
    const { result } = renderFlow('2026-08-01-preview')

    await act(async () => {
      await result.current.onPublishClick(JSON.stringify(candidate))
    })

    expect(result.current.publishError).toContain('vectorSearch.topicGraphProfiles, fields[].topicGraphProfile')
    expect(result.current.publishError).toContain('2026-11-01-preview')
    expect(result.current.publishError).toContain('2026-08-01-preview')
    expect(result.current.saveDiffOpen).toBe(false)
    expect(mockGetIndexDefinition).not.toHaveBeenCalled()
  })

  it('does not block an index without 2026-11-01-preview properties on an older API version', async () => {
    mockGetIndexDefinition.mockResolvedValue(ok(baseline))
    const { result } = renderFlow('2026-08-01-preview')

    await act(async () => {
      await result.current.onPublishClick(JSON.stringify(baseline))
    })

    expect(result.current.publishError).toBeNull()
    expect(result.current.saveDiffOpen).toBe(true)
  })

  it('shows the graph changes in the diff and saves them with the 2026-11-01-preview API', async () => {
    mockGetIndexDefinition.mockResolvedValue(ok(baseline))
    mockCreateOrUpdateIndex.mockResolvedValue(ok(candidate))
    const { result } = renderFlow('2026-11-01-preview')

    await act(async () => {
      await result.current.onPublishClick(JSON.stringify(candidate))
    })

    expect(result.current.publishError).toBeNull()
    expect(result.current.saveDiffOpen).toBe(true)
    expect(result.current.isNewIndex).toBe(false)
    expect(mockGetIndexDefinition).toHaveBeenCalledWith(expect.objectContaining({ indexName: 'docs', apiVersion: '2026-11-01-preview' }))

    const changes = result.current.semanticDiff?.changes ?? []
    expect(changes.some((change) => change.kind === 'item-changed' && change.skillName === 'embedding')).toBe(true)
    expect(changes.some((change) => change.path.startsWith('vectorSearch') && change.kind === 'added')).toBe(true)
    expect(result.current.semanticDiff?.normalizedAfterJson).toContain('topicGraphProfiles')

    act(() => result.current.setAllowIndexDowntime(true))
    let saved: string | null = null
    await act(async () => {
      saved = await result.current.publishToAzure()
    })

    expect(mockCreateOrUpdateIndex).toHaveBeenCalledTimes(1)
    const request = mockCreateOrUpdateIndex.mock.calls[0][0]
    expect(request).toMatchObject({ indexName: 'docs', apiVersion: '2026-11-01-preview', allowIndexDowntime: true })
    expect(request.body).toEqual(candidate)
    expect(JSON.parse(saved ?? '{}')).toEqual(candidate)
  })

  it('saves a new graph index without the downtime option', async () => {
    const graphIndex = {
      name: 'people-graph',
      fields: [{ name: 'id', type: 'Edm.String', key: true }],
      graphProfile: { kind: 'edgeList', fields: { assertionIdField: 'id' }, provenanceIndexName: 'people-chunks' },
    }
    mockGetIndexDefinition.mockResolvedValue(notFound())
    mockCreateOrUpdateIndex.mockResolvedValue(ok(graphIndex, 201))
    const { result } = renderFlow('2026-11-01-preview')

    await act(async () => {
      await result.current.onPublishClick(JSON.stringify(graphIndex))
    })
    expect(result.current.isNewIndex).toBe(true)

    act(() => result.current.setAllowIndexDowntime(true))
    await act(async () => {
      await result.current.publishToAzure()
    })

    expect(mockCreateOrUpdateIndex.mock.calls[0][0]).toMatchObject({ apiVersion: '2026-11-01-preview', allowIndexDowntime: false })
    expect(mockCreateOrUpdateIndex.mock.calls[0][0].body).toEqual(graphIndex)
  })
})
