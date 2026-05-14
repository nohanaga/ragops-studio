import { describe, expect, it } from 'vitest'

import { buildFacetFilterExpression, type FacetFieldInfo } from './facetFilter'

describe('buildFacetFilterExpression', () => {
  it('builds a simple equality filter for scalar facet values', () => {
    expect(buildFacetFilterExpression('category', { value: 'hotel' })).toBe("category eq 'hotel'")
  })

  it('escapes string literals', () => {
    expect(buildFacetFilterExpression('name', { value: "O'Reilly" })).toBe("name eq 'O''Reilly'")
  })

  it('builds range filters with inclusive from and exclusive to bounds', () => {
    expect(buildFacetFilterExpression('rating', { from: 3, to: 5 })).toBe('rating ge 3 and rating lt 5')
  })

  it('uses any() for primitive collection facet values', () => {
    const fields: FacetFieldInfo[] = [
      { path: 'tags', type: 'Collection(Edm.String)', collectionPath: 'tags', collectionItemPath: '' },
    ]

    expect(buildFacetFilterExpression('tags', { value: 'vip' }, fields)).toBe("tags/any(x: x eq 'vip')")
  })

  it('uses any() for fields under a complex collection facet', () => {
    const fields: FacetFieldInfo[] = [
      { path: 'rooms/type', type: 'Edm.String', collectionPath: 'rooms', collectionItemPath: 'type' },
    ]

    expect(buildFacetFilterExpression('rooms/type', { value: 'suite' }, fields)).toBe(
      "rooms/any(x: x/type eq 'suite')",
    )
  })
})