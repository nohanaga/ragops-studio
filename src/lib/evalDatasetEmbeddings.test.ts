import { describe, expect, it } from 'vitest'

import { cosine, findSemanticDuplicates } from './evalDatasetEmbeddings'

describe('evalDatasetEmbeddings.cosine', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0)
  })

  it('returns 0 for empty or zero-norm vectors', () => {
    expect(cosine([], [1, 2, 3])).toBe(0)
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0)
  })

  it('handles mismatched lengths by truncating to the min length', () => {
    const v = cosine([1, 1, 0, 0, 0], [1, 1])
    expect(v).toBeCloseTo(1)
  })
})

describe('evalDatasetEmbeddings.findSemanticDuplicates', () => {
  it('drops later items above threshold', () => {
    const vectors = [
      [1, 0, 0],
      [1, 0, 0], // duplicate of #0
      [0, 1, 0],
    ]
    const dropped = findSemanticDuplicates(vectors, 0.95)
    expect(dropped.has(0)).toBe(false)
    expect(dropped.has(1)).toBe(true)
    expect(dropped.has(2)).toBe(false)
  })

  it('keeps everything when below threshold', () => {
    const vectors = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]
    const dropped = findSemanticDuplicates(vectors, 0.5)
    expect(dropped.size).toBe(0)
  })

  it('clamps threshold into [0, 1]', () => {
    const vectors = [
      [1, 0],
      [1, 0],
    ]
    // threshold > 1 clamps to 1; identical vectors still match exactly
    const dropped = findSemanticDuplicates(vectors, 5)
    expect(dropped.has(1)).toBe(true)
  })

  it('returns empty set for empty input', () => {
    expect(findSemanticDuplicates([], 0.92).size).toBe(0)
  })
})
