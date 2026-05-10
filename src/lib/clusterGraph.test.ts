import { describe, expect, it } from 'vitest'

import { buildClusterEdges, type BridgeNode } from './clusterGraph'

function vector(values: number[]): Float32Array {
  return new Float32Array(values)
}

describe('buildClusterEdges explainability', () => {
  it('marks centroid-only edges as low-confidence proximity candidates', () => {
    const edges = buildClusterEdges([
      vector([1, 0]),
      vector([0.9, 0.1]),
    ], 0.5)

    expect(edges).toHaveLength(1)
    expect(edges[0].relationKind).toBe('candidate')
    expect(edges[0].confidence).toBe('low')
    expect(edges[0].reasons?.map((reason) => reason.kind)).toEqual(['centroid'])
  })

  it('uses bridge documents as edge evidence', () => {
    const bridges: BridgeNode[] = [
      { docIndex: 10, ownCluster: 0, nearestCluster: 1, similarityToNearest: 0.81 },
      { docIndex: 11, ownCluster: 1, nearestCluster: 0, similarityToNearest: 0.79 },
    ]
    const edges = buildClusterEdges([
      vector([1, 0]),
      vector([0.9, 0.1]),
    ], 0.5, 5, { bridges })

    expect(edges).toHaveLength(1)
    expect(edges[0].relationKind).toBe('explained')
    expect(edges[0].confidence).toBe('medium')
    expect(edges[0].bridgeDocIndices).toEqual([10, 11])
    expect(edges[0].reasons?.some((reason) => reason.kind === 'bridge-documents')).toBe(true)
  })

  it('uses shared semantic signature fields as edge evidence', () => {
    const edges = buildClusterEdges([
      vector([1, 0]),
      vector([0.9, 0.1]),
    ], 0.5, 5, {
      summaries: [
        { keywords: ['Azure Search', 'index'], facetLabels: ['Vector Search'] },
        { keywords: ['Azure Search', 'query'], facetLabels: ['Vector Search'] },
      ],
    })

    expect(edges).toHaveLength(1)
    expect(edges[0].relationKind).toBe('explained')
    expect(edges[0].confidence).toBe('medium')
    expect(edges[0].sharedFacets).toEqual(['Vector Search'])
    expect(edges[0].sharedKeywords).toEqual(['Azure Search'])
    expect(edges[0].reasons?.some((reason) => reason.kind === 'shared-facet')).toBe(true)
  })
})
