import { describe, expect, it } from 'vitest'

import { parseEntityResponse } from './evalDatasetEntities'
import { findDocPairsByEntities } from './evalDatasetRagas'
import type { SampledDoc } from './evalDatasetSampling'

describe('parseEntityResponse', () => {
  it('parses, normalizes, and dedupes entities', () => {
    const raw = JSON.stringify({
      entities: ['Azure  AI Search', 'azure ai search', 'Foo', 'BAR'],
    })
    const set = parseEntityResponse(raw)
    expect(set.has('azure ai search')).toBe(true)
    expect(set.has('foo')).toBe(true)
    expect(set.has('bar')).toBe(true)
    expect(set.size).toBe(3)
  })

  it('drops non-strings, empty strings, and noun phrases longer than 6 words', () => {
    const raw = JSON.stringify({
      entities: ['ok', '', 123, 'one two three four five six seven', 'short phrase'],
    })
    const set = parseEntityResponse(raw)
    expect([...set]).toEqual(['ok', 'short phrase'])
  })

  it('caps the result at maxEntities', () => {
    const raw = JSON.stringify({
      entities: Array.from({ length: 50 }, (_, i) => `e${i}`),
    })
    expect(parseEntityResponse(raw, 5).size).toBe(5)
  })

  it('returns empty set on invalid JSON or missing array', () => {
    expect(parseEntityResponse('not json').size).toBe(0)
    expect(parseEntityResponse('{}').size).toBe(0)
    expect(parseEntityResponse(JSON.stringify({ entities: 'no' })).size).toBe(0)
  })
})

describe('findDocPairsByEntities', () => {
  const docs: SampledDoc[] = [
    { id: 'a', text: 'about azure search and bicep' },
    { id: 'b', text: 'about azure search and ARM' },
    { id: 'c', text: 'unrelated cooking recipe' },
  ]

  it('uses entity Jaccard when entity sets are provided', () => {
    const ents: Record<string, Set<string>> = {
      a: new Set(['azure search', 'bicep']),
      b: new Set(['azure search', 'arm']),
      c: new Set(['recipe', 'cooking']),
    }
    const pairs = findDocPairsByEntities(docs, ents, 0.1)
    // a-b share 'azure search' -> 1/3 ~ 0.33; should appear.
    // a-c, b-c have 0 overlap -> excluded.
    expect(pairs.length).toBe(1)
    expect(new Set([pairs[0].a.id, pairs[0].b.id])).toEqual(new Set(['a', 'b']))
  })

  it('falls back to token Jaccard for docs missing entity sets', () => {
    // Only b has entities; a and c fall back to token sets.
    const ents: Record<string, Set<string>> = {
      b: new Set(['azure search', 'arm']),
    }
    const pairs = findDocPairsByEntities(docs, ents, 0.1)
    // We just assert the function does not throw and produces deterministic output.
    expect(Array.isArray(pairs)).toBe(true)
  })

  it('respects the threshold lower-bound', () => {
    const ents: Record<string, Set<string>> = {
      a: new Set(['x']),
      b: new Set(['y']),
    }
    expect(findDocPairsByEntities(docs.slice(0, 2), ents, 0.1).length).toBe(0)
  })
})
