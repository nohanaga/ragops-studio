import { describe, expect, it } from 'vitest'

import type { ClusterResult } from './clustering'
import { analyzeEmbeddingTopology } from './embeddingTopology'

function vector(values: number[]): Float32Array {
  return new Float32Array(values)
}

describe('analyzeEmbeddingTopology', () => {
  it('builds a deterministic k-NN topology and cluster metrics', () => {
    const vectors = [
      vector([1, 0]),
      vector([0.98, 0.05]),
      vector([0.95, 0.08]),
      vector([0, 1]),
      vector([0.05, 0.98]),
      vector([0.08, 0.95]),
    ]
    const clusters: ClusterResult = {
      labels: new Uint16Array([0, 0, 0, 1, 1, 1]),
      centroids: [vector([0.98, 0.04]), vector([0.04, 0.98])],
      counts: [3, 3],
      inertia: 0,
    }

    const topology = analyzeEmbeddingTopology({ vectors, clusters, knnK: 2 })

    expect(topology.sampleSize).toBe(6)
    expect(topology.edges.length).toBeGreaterThan(0)
    expect(topology.communityCount).toBeGreaterThan(0)
    expect(topology.clusterMetrics).toHaveLength(2)
    expect(topology.clusterMetrics[0].topologyLabel).toBe('compact')
    expect(topology.clusterMetrics[0].nearestClusterId).toBe(1)
    expect(topology.clusterMetrics[0].boundaryRatio).toBe(0)
  })
})
