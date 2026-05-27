import { describe, expect, it } from 'vitest'

import { buildMetaIndexSnapshot, buildSnapshot, restoreFromSnapshot } from './persistedVisualization'
import type { VisualizationData } from '../hooks/useIndexVisualization'
import type { ClusterSummary } from '../lib/metaIndex'

function vector(values: number[]): Float32Array {
  return new Float32Array(values)
}

describe('persisted visualization snapshots', () => {
  it('preserves hierarchical micro cluster centroids for graph drilldown restore', () => {
    const data: VisualizationData = {
      docs: [
        { id: 'a', title: 'A', vector: vector([1, 0]) },
        { id: 'b', title: 'B', vector: vector([0.9, 0.1]) },
      ],
      cluster: {
        labels: new Uint16Array([0, 0]),
        centroids: [vector([0.95, 0.05])],
        counts: [2],
        inertia: 0,
      },
      pca: {
        coords: [[0, 0], [1, 0]],
        explainedVariance: [1, 0],
      },
      hierarchical: {
        macroLabels: new Uint16Array([0, 0]),
        microLabels: new Uint16Array([0, 1]),
        macro: {
          labels: new Uint16Array([0, 0]),
          centroids: [vector([0.95, 0.05])],
          counts: [2],
          inertia: 0,
        },
        microClusters: [
          {
            labels: new Uint16Array([0, 1]),
            centroids: [vector([1, 0]), vector([0.9, 0.1])],
            counts: [1, 1],
            inertia: 0,
          },
        ],
        microToMacro: new Uint16Array([0, 0]),
        totalMicroClusters: 2,
      },
    }

    const snapshot = buildSnapshot({
      indexName: 'idx',
      vectorField: 'embedding',
      settings: {
        k: 1,
        microK: 2,
        maxDocs: 100,
        enableHierarchical: true,
        enableGraph: true,
        graphEdgeThreshold: 0.5,
        reductionMethod: 'pca',
        enableAdaptiveSampling: false,
      },
      data,
    })
    const restored = restoreFromSnapshot(snapshot)

    expect(snapshot.kind).toBe('ragops.visualization')
    expect(snapshot.hierarchical?.microClusters?.[0].centroids).toHaveLength(2)
    const restoredCentroids = restored.data.hierarchical?.microClusters[0].centroids ?? []
    expect(restoredCentroids).toHaveLength(2)
    expect(restoredCentroids[0][0]).toBeCloseTo(1)
    expect(restoredCentroids[1][0]).toBeCloseTo(0.9)
  })

  it('builds a meta-index cache snapshot with summaries and traces', () => {
    const summaries: ClusterSummary[] = [{
      clusterId: 'cluster-0',
      label: 'Macro 0',
      summary: 'Summary',
      keywords: ['k'],
      documentCount: 2,
      memberDocIds: ['a', 'b'],
      centroidVector: [1, 0],
      representativeText: '',
      summaryVersion: 'v2',
    }]

    const snapshot = buildMetaIndexSnapshot({
      indexName: 'idx',
      vectorField: 'embedding',
      summaryMode: 'v2',
      metaIndexName: 'idx-meta',
      metaTokenUsage: { prompt: 10, completion: 5, total: 15 },
      clusterSummaries: summaries,
      metaTraces: [{
        clusterId: 0,
        label: 'Micro 0',
        summaryMode: 'v2',
        traceLevel: 'micro',
        systemPrompt: '',
        userPrompt: '',
        response: null,
        error: null,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        durationMs: 1,
        representativeDocIds: ['a'],
        output: {
          primaryLabel: 'Micro 0',
          shortSummary: 'Micro summary',
          facetLabels: ['facet'],
          inclusionCriteria: [],
          exclusionCriteria: [],
          evidenceDocIds: ['a'],
        },
      }],
    })

    expect(snapshot.kind).toBe('ragops.meta-index-cache')
    expect(snapshot.clusterSummaries).toHaveLength(1)
    expect(snapshot.metaTraces?.[0].traceLevel).toBe('micro')
    expect(snapshot.metaTokenUsage?.total).toBe(15)
  })
})
