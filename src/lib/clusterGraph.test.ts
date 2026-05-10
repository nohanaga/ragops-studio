import { describe, expect, it } from 'vitest'

import { buildClusterEdges, buildHierarchicalClusterGraph, getMicroClusterIdsForMacro, type BridgeNode } from './clusterGraph'
import type { HierarchicalClusterResult } from './clustering'

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

describe('buildHierarchicalClusterGraph', () => {
  it('builds a micro graph with globally unique micro ids for document drilldown', () => {
    const vectors = [
      vector([1, 0]),
      vector([0.9, 0.1]),
      vector([0, 1]),
      vector([0.1, 0.9]),
    ]
    const hierarchical: HierarchicalClusterResult = {
      macroLabels: new Uint16Array([0, 0, 1, 1]),
      microLabels: new Uint16Array([0, 1, 2, 3]),
      macro: {
        labels: new Uint16Array([0, 0, 1, 1]),
        centroids: [vector([0.95, 0.05]), vector([0.05, 0.95])],
        counts: [2, 2],
        inertia: 0,
      },
      microClusters: [
        {
          labels: new Uint16Array([0, 1]),
          centroids: [vector([1, 0]), vector([0.9, 0.1])],
          counts: [1, 1],
          inertia: 0,
        },
        {
          labels: new Uint16Array([0, 1]),
          centroids: [vector([0, 1]), vector([0.1, 0.9])],
          counts: [1, 1],
          inertia: 0,
        },
      ],
      microToMacro: new Uint16Array([0, 0, 1, 1]),
      totalMicroClusters: 4,
    }

    const graph = buildHierarchicalClusterGraph(vectors, hierarchical, 1, 0.5)

    expect(getMicroClusterIdsForMacro(hierarchical, 1)).toEqual([2, 3])
    expect(graph.graphLevel).toBe('micro')
    expect(graph.parentId).toBe(1)
    expect(graph.nodes.map((node) => node.id)).toEqual([2, 3])
    expect(graph.nodes.every((node) => node.nodeKind === 'micro' && node.parentId === 1)).toBe(true)
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0].source).toBe(2)
    expect(graph.edges[0].target).toBe(3)
  })
})
