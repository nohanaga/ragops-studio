/**
 * Web Worker for heavy Index Cluster Visualizer computation.
 *
 * Runs k-means clustering, hierarchical clustering, and dimensionality
 * reduction off the main thread to keep the UI responsive.
 */

import { kMeans, hierarchicalKMeans, type ClusterResult, type HierarchicalClusterResult } from './clustering'
import { reduce2D, type PcaResult, type ReductionMethod } from './dimensionReduction'
import { buildClusterGraph, type ClusterGraphData } from './clusterGraph'

// ─── Message Types ──────────────────────────────────────────────────────────

export interface WorkerRequest {
  /** Raw vector data as flat Float32Array + metadata to reconstruct. */
  vectorData: Float32Array
  vectorCount: number
  vectorDim: number
  k: number
  reductionMethod: ReductionMethod
  enableHierarchical: boolean
  microK: number
  /** Phase 4: Build cluster relationship graph. */
  enableGraph: boolean
  /** Cosine similarity threshold for cluster edges (default 0.5). */
  graphEdgeThreshold: number
}

export interface WorkerResponse {
  type: 'result'
  cluster: ClusterResult
  pca: PcaResult
  hierarchical?: HierarchicalClusterResult
  graph?: ClusterGraphData
}

export interface WorkerPhaseUpdate {
  type: 'phase'
  phase: 'clustering' | 'projecting' | 'graphing'
}

export type WorkerMessage = WorkerResponse | WorkerPhaseUpdate

// ─── Worker Entry Point ─────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { vectorData, vectorCount, vectorDim, k, reductionMethod, enableHierarchical, microK, enableGraph, graphEdgeThreshold } = e.data

  // Reconstruct Float32Array[] from flat buffer
  const vectors: Float32Array[] = new Array(vectorCount)
  for (let i = 0; i < vectorCount; i++) {
    vectors[i] = new Float32Array(vectorData.buffer, i * vectorDim * 4, vectorDim)
  }

  // Clustering
  const msg1: WorkerPhaseUpdate = { type: 'phase', phase: 'clustering' }
  self.postMessage(msg1)

  const clampedK = Math.min(k, vectors.length)
  const cluster = kMeans(vectors, clampedK)

  let hierarchical: HierarchicalClusterResult | undefined
  if (enableHierarchical && vectors.length > clampedK) {
    const clampedMicroK = Math.min(microK, Math.floor(vectors.length / clampedK))
    if (clampedMicroK >= 2) {
      hierarchical = hierarchicalKMeans(vectors, clampedK, clampedMicroK)
    }
  }

  // Phase 4: Graph structure
  let graph: ClusterGraphData | undefined
  if (enableGraph) {
    const msg3: WorkerPhaseUpdate = { type: 'phase', phase: 'graphing' }
    self.postMessage(msg3)
    graph = buildClusterGraph(vectors, cluster, hierarchical, graphEdgeThreshold)
  }

  // Dimensionality reduction
  const msg2: WorkerPhaseUpdate = { type: 'phase', phase: 'projecting' }
  self.postMessage(msg2)

  const pca = reduce2D(vectors, reductionMethod)

  // Send results back
  const result: WorkerResponse = { type: 'result', cluster, pca, hierarchical, graph }
  self.postMessage(result)
}
