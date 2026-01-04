import { describe, expect, it } from 'vitest'

import { extractSearchFacets } from './searchFacets'

describe('utils/searchFacets', () => {
  it('returns null for non-record bodies', () => {
    expect(extractSearchFacets(null)).toBeNull()
    expect(extractSearchFacets([])).toBeNull()
  })

  it('extracts facet arrays and normalizes non-arrays to empty arrays', () => {
    const facets = extractSearchFacets({
      '@search.facets': {
        category: [{ value: 'a', count: 1 }],
        author: 'not-an-array',
      },
    })

    expect(facets).toEqual({
      category: [{ value: 'a', count: 1 }],
      author: [],
    })
  })
})
