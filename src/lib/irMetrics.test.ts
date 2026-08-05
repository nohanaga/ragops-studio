import { describe, expect, it } from 'vitest'

import { ndcgAtK, parseRelevanceGrades, scoreIrObjective } from './irMetrics'

describe('ndcgAtK', () => {
  const relevant = new Set(['high', 'low'])

  it('uses graded relevance when grades are provided', () => {
    const grades = new Map([
      ['high', 3],
      ['low', 1],
    ])

    expect(ndcgAtK(['high', 'low'], relevant, 2, grades)).toBe(1)
    expect(ndcgAtK(['low', 'high'], relevant, 2, grades)).toBeLessThan(1)
  })

  it('falls back to binary relevance when grades are absent', () => {
    expect(ndcgAtK(['high', 'low'], relevant, 2)).toBe(1)
    expect(ndcgAtK(['low', 'high'], relevant, 2)).toBe(1)
  })

  it('does not apply grades to other objectives', () => {
    const grades = new Map([['high', 3]])
    expect(scoreIrObjective('recall@k', ['high'], relevant, 2, grades)).toBe(0.5)
  })
})

describe('parseRelevanceGrades', () => {
  it('accepts finite non-negative numeric grades', () => {
    expect(Array.from(parseRelevanceGrades({ high: 3, low: 1 }) ?? [])).toEqual([
      ['high', 3],
      ['low', 1],
    ])
  })

  it('returns undefined when no valid grades are present', () => {
    expect(parseRelevanceGrades(undefined)).toBeUndefined()
    expect(parseRelevanceGrades({ doc: '3' })).toBeUndefined()
    expect(parseRelevanceGrades({ doc: 3, source: 'generated' })).toBeUndefined()
  })
})