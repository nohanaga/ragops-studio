import { describe, expect, it } from 'vitest'

import { normalQuantile, ppiMean } from './ppi'

describe('normalQuantile', () => {
  it('returns standard z-scores at canonical levels', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6)
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963985, 5)
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959963985, 5)
    expect(normalQuantile(0.995)).toBeCloseTo(2.5758293, 4)
  })

  it('returns -Inf / +Inf at the boundaries', () => {
    expect(normalQuantile(0)).toBe(-Infinity)
    expect(normalQuantile(1)).toBe(Infinity)
  })
})

describe('ppiMean', () => {
  it('with a perfect predictor reduces to mean over all examples (rectifier=0)', () => {
    const labeled = [
      { y: 1, f: 1 },
      { y: 0, f: 0 },
      { y: 1, f: 1 },
      { y: 0, f: 0 },
    ]
    const unlabeledPredictions = [1, 1, 0, 0, 1, 1, 0, 0]
    const r = ppiMean({ labeled, unlabeledPredictions })
    expect(r.estimate).toBeCloseTo(0.5, 10)
    expect(r.ciLower).toBeLessThanOrEqual(r.estimate)
    expect(r.ciUpper).toBeGreaterThanOrEqual(r.estimate)
  })

  it('debiases a systematically optimistic predictor', () => {
    // Truth: balanced 50%. Predictor over-predicts 1 with bias +0.25 on labeled.
    const labeled = [
      { y: 1, f: 1 },
      { y: 0, f: 1 },
      { y: 1, f: 1 },
      { y: 0, f: 0 },
    ]
    // labeled: meanY=0.5, meanF=0.75, rectifier=+0.25
    const unlabeledPredictions = [1, 1, 1, 0, 1, 1, 0, 1] // mean 0.75
    const r = ppiMean({ labeled, unlabeledPredictions })
    expect(r.estimate).toBeCloseTo(0.75 - 0.25, 10)
  })

  it('falls back to naive (label-only) mean when there are no unlabeled predictions', () => {
    const r = ppiMean({
      labeled: [
        { y: 1, f: 0.9 },
        { y: 0, f: 0.1 },
        { y: 1, f: 0.8 },
      ],
      unlabeledPredictions: [],
    })
    expect(r.estimate).toBeCloseTo(2 / 3, 10)
    expect(r.naiveEstimate).toBeCloseTo(2 / 3, 10)
    expect(r.nUnlabeled).toBe(0)
  })

  it('falls back to mean of unlabeled predictions when there are no labels', () => {
    const r = ppiMean({
      labeled: [],
      unlabeledPredictions: [1, 0, 1, 1],
    })
    expect(r.estimate).toBeCloseTo(0.75, 10)
    expect(Number.isNaN(r.naiveEstimate)).toBe(true)
  })

  it('returns all NaNs when both samples are empty', () => {
    const r = ppiMean({ labeled: [], unlabeledPredictions: [] })
    expect(Number.isNaN(r.estimate)).toBe(true)
    expect(Number.isNaN(r.standardError)).toBe(true)
  })

  it('produces a tighter CI than the naive (label-only) one when the predictor is informative', () => {
    // Many unlabeled predictions, small labeled subset, predictor close to truth.
    const labeled = [
      { y: 1, f: 1 },
      { y: 0, f: 0 },
      { y: 1, f: 1 },
      { y: 0, f: 0 },
      { y: 1, f: 1 },
      { y: 0, f: 0 },
    ]
    const unlabeledPredictions = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 1 : 0))
    const r = ppiMean({ labeled, unlabeledPredictions })
    expect(r.standardError).toBeLessThan(r.naiveStandardError)
  })

  it('respects custom confidence level', () => {
    const r99 = ppiMean({
      labeled: [
        { y: 1, f: 1 },
        { y: 0, f: 0 },
      ],
      unlabeledPredictions: [1, 0, 1, 0],
      confidenceLevel: 0.99,
    })
    const r95 = ppiMean({
      labeled: [
        { y: 1, f: 1 },
        { y: 0, f: 0 },
      ],
      unlabeledPredictions: [1, 0, 1, 0],
      confidenceLevel: 0.95,
    })
    expect(r99.ciUpper - r99.ciLower).toBeGreaterThanOrEqual(r95.ciUpper - r95.ciLower)
  })
})
