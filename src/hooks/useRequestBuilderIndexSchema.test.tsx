// @vitest-environment jsdom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getIndexDefinition, type RestResult } from '../lib/aiSearchRest'
import type { ConnectionProfile } from '../lib/model'
import { useRequestBuilderIndexSchema } from './useRequestBuilderIndexSchema'

vi.mock('../lib/aiSearchRest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/aiSearchRest')>()
  return {
    ...actual,
    getIndexDefinition: vi.fn(),
  }
})

const mockGetIndexDefinition = vi.mocked(getIndexDefinition)

const activeProfile: ConnectionProfile = {
  endpoint: 'https://example.search.windows.net',
  apiVersion: '2025-09-01',
  authType: 'apiKey',
  apiKey: 'test-key',
}

describe('hooks/useRequestBuilderIndexSchema', () => {
  beforeEach(() => {
    mockGetIndexDefinition.mockReset()
  })

  it('suggests only searchable text fields for searchFields', async () => {
    const response: RestResult = {
      ok: true,
      status: 200,
      requestId: 'req-1',
      url: 'https://example.search.windows.net/indexes/myindex',
      response: {
        fields: [
          { name: 'id', type: 'Edm.String', key: true, searchable: false },
          { name: 'title', type: 'Edm.String', searchable: true },
          { name: 'category', type: 'Edm.String', searchable: false },
          { name: 'legacyText', type: 'Edm.String' },
          { name: 'tags', type: 'Collection(Edm.String)', searchable: true },
          { name: 'embedding', type: 'Collection(Edm.Single)', searchable: true },
        ],
      },
    }
    mockGetIndexDefinition.mockResolvedValue(response)

    const { result } = renderHook(() =>
      useRequestBuilderIndexSchema({
        activeProfile,
        indexName: 'myindex',
        apiVersion: '2025-09-01',
        language: 'ja',
      }),
    )

    await waitFor(() => {
      expect(result.current.requestBuilderSearchableFieldNames).toEqual(['title', 'tags'])
    })
  })
})