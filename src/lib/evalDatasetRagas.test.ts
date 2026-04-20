import { describe, expect, it } from 'vitest'

import {
  DEFAULT_QUERY_DISTRIBUTION,
  applyScenarioMetadata,
  distributionToCounts,
  findDocPairs,
  normaliseDistribution,
  planScenarios,
} from './evalDatasetRagas'
import type { QueryShape } from '../types'

describe('normaliseDistribution', () => {
  it('returns DEFAULT_QUERY_DISTRIBUTION for undefined input', () => {
    expect(normaliseDistribution(undefined)).toEqual(DEFAULT_QUERY_DISTRIBUTION)
  })

  it('returns DEFAULT_QUERY_DISTRIBUTION when all weights are zero', () => {
    const result = normaliseDistribution({
      single_specific: 0,
      single_abstract: 0,
      multi_specific: 0,
      multi_abstract: 0,
    })
    expect(result).toEqual(DEFAULT_QUERY_DISTRIBUTION)
  })

  it('normalises partial values to sum 1', () => {
    const result = normaliseDistribution({ single_specific: 2, multi_abstract: 2 })
    const sum = Object.values(result).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1, 5)
    expect(result.single_specific).toBeCloseTo(0.5, 5)
    expect(result.multi_abstract).toBeCloseTo(0.5, 5)
    expect(result.single_abstract).toBe(0)
    expect(result.multi_specific).toBe(0)
  })
})

describe('distributionToCounts', () => {
  it('produces counts that sum exactly to total', () => {
    const counts = distributionToCounts(DEFAULT_QUERY_DISTRIBUTION, 17)
    const sum = Object.values(counts).reduce((a, b) => a + b, 0)
    expect(sum).toBe(17)
  })

  it('respects largest-remainder rounding for tiny totals', () => {
    const counts = distributionToCounts(
      { single_specific: 0.5, single_abstract: 0.2, multi_specific: 0.2, multi_abstract: 0.1 },
      4,
    )
    const sum = Object.values(counts).reduce((a, b) => a + b, 0)
    expect(sum).toBe(4)
    expect(counts.single_specific).toBeGreaterThanOrEqual(2)
  })

  it('returns all zeros for total=0', () => {
    const counts = distributionToCounts(DEFAULT_QUERY_DISTRIBUTION, 0)
    expect(Object.values(counts).every((v) => v === 0)).toBe(true)
  })
})

describe('findDocPairs', () => {
  it('returns empty array for fewer than 2 docs', () => {
    expect(findDocPairs([{ id: 'a', text: 'foo' }], 0.1)).toEqual([])
  })

  it('returns descending similarity, filters out near-duplicates >= 0.95', () => {
    const docs = [
      { id: 'a', text: 'alpha beta gamma delta' },
      { id: 'b', text: 'alpha beta gamma delta' }, // exact duplicate
      { id: 'c', text: 'alpha beta epsilon zeta' }, // partial overlap
      { id: 'd', text: 'totally different words here' },
    ]
    const pairs = findDocPairs(docs, 0)
    // Duplicate (a,b) filtered, but (a,c) and (b,c) should remain.
    expect(pairs.every((p) => p.similarity < 0.95)).toBe(true)
    // Sorted descending.
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1].similarity).toBeGreaterThanOrEqual(pairs[i].similarity)
    }
  })

  it('respects threshold', () => {
    const docs = [
      { id: 'a', text: 'red green blue' },
      { id: 'b', text: 'red yellow purple' },
      { id: 'c', text: 'completely orthogonal terms here' },
    ]
    const high = findDocPairs(docs, 0.5)
    const low = findDocPairs(docs, 0)
    expect(high.length).toBeLessThanOrEqual(low.length)
  })
})

describe('planScenarios', () => {
  const docs = Array.from({ length: 6 }, (_, i) => ({
    id: `doc-${i}`,
    text: `unique words for document number ${i} alpha beta`,
  }))

  it('produces total slots equal to totalQueries', () => {
    const slots = planScenarios({
      docs,
      totalQueries: 10,
      distribution: DEFAULT_QUERY_DISTRIBUTION,
    })
    expect(slots.length).toBe(10)
  })

  it('honours distribution counts per shape', () => {
    const slots = planScenarios({
      docs,
      totalQueries: 10,
      distribution: { single_specific: 1, single_abstract: 0, multi_specific: 0, multi_abstract: 0 },
    })
    expect(slots.every((s) => s.shape === 'single_specific')).toBe(true)
  })

  it('multi-hop slots contain >= 2 docs (with adjacent fallback when no pairs meet threshold)', () => {
    const slots = planScenarios({
      docs,
      totalQueries: 4,
      distribution: { single_specific: 0, single_abstract: 0, multi_specific: 0.5, multi_abstract: 0.5 },
      multiHopPairingThreshold: 0.99, // forces fallback
    })
    expect(slots.every((s) => s.shape.startsWith('multi_'))).toBe(true)
    expect(slots.every((s) => s.docs.length >= 2)).toBe(true)
  })

  it('returns empty when no docs', () => {
    expect(planScenarios({ docs: [], totalQueries: 5, distribution: DEFAULT_QUERY_DISTRIBUTION })).toEqual([])
  })
})

describe('applyScenarioMetadata', () => {
  it('stamps shape, persona, style, length, expected_ids', () => {
    const slot = {
      shape: 'multi_abstract' as QueryShape,
      persona: 'analyst',
      style: 'formal' as const,
      length: 'long' as const,
      docs: [
        { id: 'a', text: 'x' },
        { id: 'b', text: 'y' },
      ],
    }
    const item = {
      query: 'test',
      expected_ids: [] as string[],
      source_doc_id: 'a',
      generation_model: 'gpt-x',
      language: 'en' as const,
      provenance: 'synthetic' as const,
      generated_at: new Date().toISOString(),
    }
    const result = applyScenarioMetadata(item, slot)
    expect(result.query_shape).toBe('multi_abstract')
    expect(result.persona).toBe('analyst')
    expect(result.style).toBe('formal')
    expect(result.length).toBe('long')
    expect(result.expected_ids).toEqual(['a', 'b'])
  })
})
