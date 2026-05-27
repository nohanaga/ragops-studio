import { cosineSimilarity, type ClusterResult } from './clustering'

export type EmbeddingTopologyLabel = 'small' | 'compact' | 'mixed' | 'overlapping' | 'diffuse'

export interface KnnGraphEdge {
  source: number
  target: number
  similarity: number
}

export interface EmbeddingTopologyClusterMetric {
  clusterId: number
  documentCount: number
  cohesionScore: number
  separationScore: number
  boundaryRatio: number
  outlierRatio: number
  ambiguityScore: number
  nearestClusterId?: number
  nearestClusterSimilarity?: number
  internalNeighborRatio?: number
  crossClusterNeighborRatio?: number
  topologyLabel: EmbeddingTopologyLabel
  needsSplit: boolean
}

export interface EmbeddingTopologyAnalysis {
  knnK: number
  sampleSize: number
  edges: KnnGraphEdge[]
  communityLabels: Uint16Array
  communityCount: number
  graphDensity: number
  averageNeighborSimilarity: number
  clusterMetrics: EmbeddingTopologyClusterMetric[]
}

interface LocalKnnEdge {
  sourceLocal: number
  targetLocal: number
  sourceGlobal: number
  targetGlobal: number
  similarity: number
}

export function analyzeEmbeddingTopology(input: {
  vectors: Float32Array[]
  clusters?: ClusterResult
  knnK?: number
  maxKnnDocs?: number
  communityIterations?: number
}): EmbeddingTopologyAnalysis {
  const { vectors, clusters, knnK = 10, maxKnnDocs = 1500, communityIterations = 12 } = input
  const sampleIndices = selectEvenSampleIndices(vectors.length, maxKnnDocs)
  const localEdges = buildLocalKnnGraph(vectors, sampleIndices, knnK)
  const communityLabels = detectWeightedLabelCommunities(sampleIndices.length, localEdges, communityIterations)
  const maxEdges = sampleIndices.length > 1 ? (sampleIndices.length * (sampleIndices.length - 1)) / 2 : 1
  const averageNeighborSimilarity = localEdges.length > 0
    ? localEdges.reduce((sum, edge) => sum + edge.similarity, 0) / localEdges.length
    : 0
  const clusterMetrics = clusters
    ? computeEmbeddingTopologyClusterMetrics({ vectors, clusters, knnEdges: localEdges })
    : []

  return {
    knnK,
    sampleSize: sampleIndices.length,
    edges: localEdges.map((edge) => ({
      source: edge.sourceGlobal,
      target: edge.targetGlobal,
      similarity: roundMetric(edge.similarity),
    })),
    communityLabels,
    communityCount: new Set(Array.from(communityLabels)).size,
    graphDensity: roundMetric(localEdges.length / maxEdges),
    averageNeighborSimilarity: roundMetric(averageNeighborSimilarity),
    clusterMetrics,
  }
}

export function computeEmbeddingTopologyClusterMetrics(input: {
  vectors: Float32Array[]
  clusters: ClusterResult
  knnEdges?: Array<Pick<LocalKnnEdge, 'sourceGlobal' | 'targetGlobal' | 'similarity'> | KnnGraphEdge>
}): EmbeddingTopologyClusterMetric[] {
  const { vectors, clusters, knnEdges = [] } = input
  const clusterCount = clusters.centroids.length
  const memberIndices = Array.from({ length: clusterCount }, () => [] as number[])

  for (let docIndex = 0; docIndex < clusters.labels.length; docIndex++) {
    const clusterId = clusters.labels[docIndex]
    if (clusterId < clusterCount) memberIndices[clusterId].push(docIndex)
  }

  const neighborStats = Array.from({ length: clusterCount }, () => ({ internal: 0, cross: 0 }))
  for (const edge of knnEdges) {
    const source = 'sourceGlobal' in edge ? edge.sourceGlobal : edge.source
    const target = 'targetGlobal' in edge ? edge.targetGlobal : edge.target
    const sourceCluster = clusters.labels[source]
    const targetCluster = clusters.labels[target]
    if (sourceCluster === undefined || targetCluster === undefined) continue
    if (sourceCluster === targetCluster) {
      neighborStats[sourceCluster].internal += 2
    } else {
      neighborStats[sourceCluster].cross += 1
      neighborStats[targetCluster].cross += 1
    }
  }

  return memberIndices.map((indices, clusterId) => {
    const centroid = clusters.centroids[clusterId]
    const nearestCluster = nearestCentroid({ clusterId, clusters })
    if (indices.length === 0 || !centroid) {
      return {
        clusterId,
        documentCount: 0,
        cohesionScore: 0,
        separationScore: 0,
        boundaryRatio: 0,
        outlierRatio: 0,
        ambiguityScore: 0,
        nearestClusterId: nearestCluster?.clusterId,
        nearestClusterSimilarity: nearestCluster ? roundMetric(nearestCluster.similarity) : undefined,
        topologyLabel: 'small',
        needsSplit: false,
      }
    }

    const ownSimilarities: number[] = []
    const margins: number[] = []
    let boundaryCount = 0

    for (const docIndex of indices) {
      const vector = vectors[docIndex]
      const ownSimilarity = cosineSimilarity(vector, centroid)
      const sibling = nearestSiblingForVector({ clusterId, clusters, vector })
      const siblingSimilarity = sibling?.similarity ?? -1
      const margin = ownSimilarity - siblingSimilarity
      ownSimilarities.push(ownSimilarity)
      margins.push(margin)
      if (sibling && (margin <= 0.06 || (siblingSimilarity >= 0.78 && margin <= 0.15))) {
        boundaryCount++
      }
    }

    const meanOwnSimilarity = mean(ownSimilarities)
    const ownStdDev = stdDev(ownSimilarities, meanOwnSimilarity)
    const outlierThreshold = meanOwnSimilarity - ownStdDev
    const outlierCount = ownSimilarities.filter((similarity) => similarity < outlierThreshold).length
    const meanMargin = mean(margins)
    const stats = neighborStats[clusterId]
    const neighborTotal = stats.internal + stats.cross
    const internalNeighborRatio = neighborTotal > 0 ? stats.internal / neighborTotal : undefined
    const crossClusterNeighborRatio = neighborTotal > 0 ? stats.cross / neighborTotal : undefined

    const cohesionScore = normalizeCosine(meanOwnSimilarity)
    const separationScore = clamp01((meanMargin + 0.25) / 1.25)
    const boundaryRatio = boundaryCount / indices.length
    const outlierRatio = outlierCount / indices.length
    const ambiguityScore = clamp01(
      boundaryRatio * 0.5
        + (1 - separationScore) * 0.3
        + outlierRatio * 0.15
        + (crossClusterNeighborRatio ?? 0) * 0.25,
    )
    const topologyLabel = classifyTopology({
      documentCount: indices.length,
      cohesionScore,
      separationScore,
      boundaryRatio,
      outlierRatio,
      crossClusterNeighborRatio,
    })
    const needsSplit = topologyLabel === 'overlapping'
      || topologyLabel === 'diffuse'
      || ambiguityScore >= 0.52
      || ((crossClusterNeighborRatio ?? 0) >= 0.5 && indices.length >= 10)

    return {
      clusterId,
      documentCount: indices.length,
      cohesionScore: roundMetric(cohesionScore),
      separationScore: roundMetric(separationScore),
      boundaryRatio: roundMetric(boundaryRatio),
      outlierRatio: roundMetric(outlierRatio),
      ambiguityScore: roundMetric(ambiguityScore),
      nearestClusterId: nearestCluster?.clusterId,
      nearestClusterSimilarity: nearestCluster ? roundMetric(nearestCluster.similarity) : undefined,
      internalNeighborRatio: internalNeighborRatio === undefined ? undefined : roundMetric(internalNeighborRatio),
      crossClusterNeighborRatio: crossClusterNeighborRatio === undefined ? undefined : roundMetric(crossClusterNeighborRatio),
      topologyLabel,
      needsSplit,
    }
  })
}

function selectEvenSampleIndices(total: number, maxCount: number): number[] {
  if (total <= 0) return []
  const sampleCount = Math.min(total, Math.max(1, maxCount))
  if (sampleCount === total) return Array.from({ length: total }, (_, index) => index)
  const step = total / sampleCount
  const indices: number[] = []
  const seen = new Set<number>()
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
    const index = Math.min(Math.floor(sampleIndex * step), total - 1)
    if (seen.has(index)) continue
    seen.add(index)
    indices.push(index)
  }
  return indices
}

function buildLocalKnnGraph(vectors: Float32Array[], sampleIndices: number[], knnK: number): LocalKnnEdge[] {
  if (sampleIndices.length <= 1) return []
  const k = Math.max(1, Math.min(knnK, sampleIndices.length - 1))
  const pairWeights = new Map<string, LocalKnnEdge>()

  for (let sourceLocal = 0; sourceLocal < sampleIndices.length; sourceLocal++) {
    const sourceGlobal = sampleIndices[sourceLocal]
    const candidates: Array<{ targetLocal: number; targetGlobal: number; similarity: number }> = []
    for (let targetLocal = 0; targetLocal < sampleIndices.length; targetLocal++) {
      if (targetLocal === sourceLocal) continue
      const targetGlobal = sampleIndices[targetLocal]
      candidates.push({
        targetLocal,
        targetGlobal,
        similarity: cosineSimilarity(vectors[sourceGlobal], vectors[targetGlobal]),
      })
    }
    candidates.sort((left, right) => right.similarity - left.similarity)
    for (const candidate of candidates.slice(0, k)) {
      const leftLocal = Math.min(sourceLocal, candidate.targetLocal)
      const rightLocal = Math.max(sourceLocal, candidate.targetLocal)
      const key = `${leftLocal}:${rightLocal}`
      const existing = pairWeights.get(key)
      if (!existing || candidate.similarity > existing.similarity) {
        pairWeights.set(key, {
          sourceLocal: leftLocal,
          targetLocal: rightLocal,
          sourceGlobal: sampleIndices[leftLocal],
          targetGlobal: sampleIndices[rightLocal],
          similarity: candidate.similarity,
        })
      }
    }
  }

  return Array.from(pairWeights.values()).sort((left, right) => right.similarity - left.similarity)
}

function detectWeightedLabelCommunities(nodeCount: number, edges: LocalKnnEdge[], iterations: number): Uint16Array {
  const adjacency = Array.from({ length: nodeCount }, () => [] as Array<{ node: number; weight: number }>)
  for (const edge of edges) {
    adjacency[edge.sourceLocal].push({ node: edge.targetLocal, weight: Math.max(0, edge.similarity) })
    adjacency[edge.targetLocal].push({ node: edge.sourceLocal, weight: Math.max(0, edge.similarity) })
  }

  const labels = new Uint32Array(nodeCount)
  for (let node = 0; node < nodeCount; node++) labels[node] = node

  for (let iteration = 0; iteration < iterations; iteration++) {
    let changed = false
    for (let node = 0; node < nodeCount; node++) {
      if (adjacency[node].length === 0) continue
      const weightsByLabel = new Map<number, number>()
      for (const neighbor of adjacency[node]) {
        const label = labels[neighbor.node]
        weightsByLabel.set(label, (weightsByLabel.get(label) ?? 0) + neighbor.weight)
      }
      let bestLabel = labels[node]
      let bestWeight = weightsByLabel.get(bestLabel) ?? 0
      for (const [label, weight] of weightsByLabel) {
        if (weight > bestWeight || (weight === bestWeight && label < bestLabel)) {
          bestLabel = label
          bestWeight = weight
        }
      }
      if (bestLabel !== labels[node]) {
        labels[node] = bestLabel
        changed = true
      }
    }
    if (!changed) break
  }

  const compactIds = new Map<number, number>()
  const compact = new Uint16Array(nodeCount)
  for (let node = 0; node < nodeCount; node++) {
    const label = labels[node]
    let compactId = compactIds.get(label)
    if (compactId === undefined) {
      compactId = compactIds.size
      compactIds.set(label, compactId)
    }
    compact[node] = compactId
  }
  return compact
}

function nearestCentroid(input: { clusterId: number; clusters: ClusterResult }): { clusterId: number; similarity: number } | null {
  const centroid = input.clusters.centroids[input.clusterId]
  if (!centroid) return null
  let bestClusterId = -1
  let bestSimilarity = -Infinity
  for (let candidateClusterId = 0; candidateClusterId < input.clusters.centroids.length; candidateClusterId++) {
    if (candidateClusterId === input.clusterId) continue
    const similarity = cosineSimilarity(centroid, input.clusters.centroids[candidateClusterId])
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity
      bestClusterId = candidateClusterId
    }
  }
  return bestClusterId >= 0 ? { clusterId: bestClusterId, similarity: bestSimilarity } : null
}

function nearestSiblingForVector(input: {
  clusterId: number
  clusters: ClusterResult
  vector: Float32Array
}): { clusterId: number; similarity: number } | null {
  let bestClusterId = -1
  let bestSimilarity = -Infinity
  for (let candidateClusterId = 0; candidateClusterId < input.clusters.centroids.length; candidateClusterId++) {
    if (candidateClusterId === input.clusterId) continue
    const similarity = cosineSimilarity(input.vector, input.clusters.centroids[candidateClusterId])
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity
      bestClusterId = candidateClusterId
    }
  }
  return bestClusterId >= 0 ? { clusterId: bestClusterId, similarity: bestSimilarity } : null
}

function classifyTopology(input: {
  documentCount: number
  cohesionScore: number
  separationScore: number
  boundaryRatio: number
  outlierRatio: number
  crossClusterNeighborRatio?: number
}): EmbeddingTopologyLabel {
  if (input.documentCount < 3) return 'small'
  if (input.boundaryRatio >= 0.35 || input.separationScore <= 0.2 || (input.crossClusterNeighborRatio ?? 0) >= 0.45) return 'overlapping'
  if (input.cohesionScore < 0.45 || input.outlierRatio >= 0.25) return 'diffuse'
  if (input.cohesionScore >= 0.75 && input.separationScore >= 0.35 && input.boundaryRatio <= 0.15) return 'compact'
  return 'mixed'
}

function normalizeCosine(value: number): number {
  return clamp01((value + 1) / 2)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stdDev(values: number[], avg: number): number {
  if (values.length <= 1) return 0
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function roundMetric(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(4))
}
