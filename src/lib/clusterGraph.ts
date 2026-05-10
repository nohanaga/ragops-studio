/**
 * Cluster Graph — Phase 4: Graph Structure
 *
 * Builds an inter-cluster relationship graph from centroid similarities
 * and provides force-directed layout for visualisation.
 */

import { cosineSimilarity, type ClusterResult, type HierarchicalClusterResult } from './clustering'

// ─── Types ──────────────────────────────────────────────────────────────────

export type EdgeConfidence = 'high' | 'medium' | 'low'

export type EdgeReasonKind = 'centroid' | 'bridge-documents' | 'shared-facet' | 'shared-keyword' | 'signature-overlap'

export interface EdgeReason {
  kind: EdgeReasonKind
  score: number
  detail: string
}

export interface EdgeScoreBreakdown {
  centroidSimilarity: number
  bridgeSupport: number
  signatureOverlap: number
  confidenceScore: number
}

export interface ClusterEdgeSummaryInput {
  label?: string
  summary?: string
  keywords?: string[]
  facetLabels?: string[]
  facetSummaries?: string[]
  inclusionCriteria?: string[]
  exclusionCriteria?: string[]
  signatureJson?: string
}

export interface ClusterEdge {
  /** Source cluster index. */
  source: number
  /** Target cluster index. */
  target: number
  /** Cosine similarity between the two centroids (0–1). */
  similarity: number
  /** Explainability confidence. Low means centroid-near candidate only. */
  confidence?: EdgeConfidence
  /** Whether the edge is explained by additional evidence or only a proximity candidate. */
  relationKind?: 'explained' | 'candidate'
  /** Structured reasons shown in the graph UI. */
  reasons?: EdgeReason[]
  /** Shared facet labels when semantic signatures are available. */
  sharedFacets?: string[]
  /** Shared keywords when summaries/signatures are available. */
  sharedKeywords?: string[]
  /** Bridge document indices supporting this edge. */
  bridgeDocIndices?: number[]
  /** Deterministic score components. */
  scoreBreakdown?: EdgeScoreBreakdown
}

export interface BridgeNode {
  /** Index in the original docs array. */
  docIndex: number
  /** The document's assigned cluster. */
  ownCluster: number
  /** The nearest *other* cluster. */
  nearestCluster: number
  /** Cosine similarity to the nearest other cluster centroid. */
  similarityToNearest: number
}

export interface GraphNode {
  /** Cluster index. */
  id: number
  /** Number of documents in this cluster. */
  count: number
  /** 2D layout position (computed by force-directed layout). */
  x: number
  y: number
}

export interface ClusterGraphData {
  nodes: GraphNode[]
  edges: ClusterEdge[]
  bridges: BridgeNode[]
}

interface BuildEdgeEvidenceOptions {
  bridges?: BridgeNode[]
  summaries?: ClusterEdgeSummaryInput[]
}

// ─── Edge Building ──────────────────────────────────────────────────────────

/**
 * Build edges between clusters whose centroid cosine similarity exceeds a threshold.
 *
 * @param centroids  Array of centroid vectors from ClusterResult.
 * @param threshold  Minimum cosine similarity to create an edge (default 0.5).
 * @param maxEdgesPerNode  Maximum edges per node to keep the graph readable (default 5).
 */
export function buildClusterEdges(
  centroids: Float32Array[],
  threshold = 0.5,
  maxEdgesPerNode = 5,
  evidence: BuildEdgeEvidenceOptions = {},
): ClusterEdge[] {
  const k = centroids.length
  if (k <= 1) return []

  // Compute all pairwise similarities
  const allEdges: ClusterEdge[] = []
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const sim = cosineSimilarity(centroids[i], centroids[j])
      if (sim >= threshold) {
        allEdges.push(buildExplainableEdge({ source: i, target: j, similarity: sim, evidence }))
      }
    }
  }

  // Sort by similarity descending
  allEdges.sort((a, b) => {
    const confidenceDiff = (b.scoreBreakdown?.confidenceScore ?? b.similarity) - (a.scoreBreakdown?.confidenceScore ?? a.similarity)
    return confidenceDiff !== 0 ? confidenceDiff : b.similarity - a.similarity
  })

  // Limit edges per node for readability
  const edgeCounts = new Uint16Array(k)
  const filtered: ClusterEdge[] = []
  for (const edge of allEdges) {
    if (edgeCounts[edge.source] < maxEdgesPerNode && edgeCounts[edge.target] < maxEdgesPerNode) {
      filtered.push(edge)
      edgeCounts[edge.source]++
      edgeCounts[edge.target]++
    }
  }

  return filtered
}

function buildExplainableEdge(input: {
  source: number
  target: number
  similarity: number
  evidence: BuildEdgeEvidenceOptions
}): ClusterEdge {
  const { source, target, similarity, evidence } = input
  const pairBridgeDocs = bridgeDocIndicesForPair(evidence.bridges ?? [], source, target)
  const sharedFacets = sharedTerms(extractFacetTerms(evidence.summaries?.[source]), extractFacetTerms(evidence.summaries?.[target])).slice(0, 6)
  const sharedKeywords = sharedTerms(extractKeywordTerms(evidence.summaries?.[source]), extractKeywordTerms(evidence.summaries?.[target])).slice(0, 8)
  const bridgeSupport = Math.min(1, pairBridgeDocs.length / 3)
  const signatureOverlap = Math.min(1, sharedFacets.length * 0.35 + sharedKeywords.length * 0.12)
  const reasons: EdgeReason[] = [{ kind: 'centroid', score: similarity, detail: similarity.toFixed(3) }]

  if (pairBridgeDocs.length > 0) {
    reasons.push({ kind: 'bridge-documents', score: bridgeSupport, detail: String(pairBridgeDocs.length) })
  }
  if (sharedFacets.length > 0) {
    reasons.push({ kind: 'shared-facet', score: Math.min(1, sharedFacets.length / 3), detail: sharedFacets.join(', ') })
  }
  if (sharedKeywords.length > 0) {
    reasons.push({ kind: 'shared-keyword', score: Math.min(1, sharedKeywords.length / 5), detail: sharedKeywords.join(', ') })
  }
  if (signatureOverlap > 0) {
    reasons.push({ kind: 'signature-overlap', score: signatureOverlap, detail: signatureOverlap.toFixed(2) })
  }

  const hasBridgeEvidence = bridgeSupport > 0
  const hasSignatureEvidence = signatureOverlap > 0
  const confidenceScore = Math.min(1, similarity * 0.35 + bridgeSupport * 0.35 + signatureOverlap * 0.3)
  const confidence: EdgeConfidence = hasBridgeEvidence && hasSignatureEvidence
    ? 'high'
    : hasBridgeEvidence || hasSignatureEvidence
      ? 'medium'
      : 'low'

  return {
    source,
    target,
    similarity,
    confidence,
    relationKind: confidence === 'low' ? 'candidate' : 'explained',
    reasons,
    sharedFacets,
    sharedKeywords,
    bridgeDocIndices: pairBridgeDocs.slice(0, 8),
    scoreBreakdown: {
      centroidSimilarity: similarity,
      bridgeSupport,
      signatureOverlap,
      confidenceScore,
    },
  }
}

function bridgeDocIndicesForPair(bridges: BridgeNode[], source: number, target: number): number[] {
  return bridges
    .filter((bridge) => {
      const left = Math.min(bridge.ownCluster, bridge.nearestCluster)
      const right = Math.max(bridge.ownCluster, bridge.nearestCluster)
      return left === Math.min(source, target) && right === Math.max(source, target)
    })
    .sort((left, right) => right.similarityToNearest - left.similarityToNearest)
    .map((bridge) => bridge.docIndex)
}

function extractFacetTerms(summary?: ClusterEdgeSummaryInput): string[] {
  if (!summary) return []
  const terms = [...(summary.facetLabels ?? [])]
  if (summary.signatureJson) {
    try {
      const parsed = JSON.parse(summary.signatureJson) as { facets?: Array<{ label?: unknown }> }
      for (const facet of parsed.facets ?? []) {
        if (typeof facet.label === 'string') terms.push(facet.label)
      }
    } catch {
      // Ignore malformed old signature payloads.
    }
  }
  return uniqueNormalizedTerms(terms)
}

function extractKeywordTerms(summary?: ClusterEdgeSummaryInput): string[] {
  if (!summary) return []
  const terms = [
    ...(summary.keywords ?? []),
    ...(summary.inclusionCriteria ?? []),
  ]
  if (summary.signatureJson) {
    try {
      const parsed = JSON.parse(summary.signatureJson) as { facets?: Array<{ keywords?: unknown }> }
      for (const facet of parsed.facets ?? []) {
        if (Array.isArray(facet.keywords)) {
          for (const keyword of facet.keywords) {
            if (typeof keyword === 'string') terms.push(keyword)
          }
        }
      }
    } catch {
      // Ignore malformed old signature payloads.
    }
  }
  return uniqueNormalizedTerms(terms)
}

function sharedTerms(left: string[], right: string[]): string[] {
  const rightMap = new Map(right.map((term) => [normalizeTerm(term), term]))
  const result: string[] = []
  const seen = new Set<string>()
  for (const term of left) {
    const key = normalizeTerm(term)
    const rightTerm = rightMap.get(key)
    if (!key || !rightTerm || seen.has(key)) continue
    seen.add(key)
    result.push(term.length <= rightTerm.length ? term : rightTerm)
  }
  return result
}

function uniqueNormalizedTerms(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    const key = normalizeTerm(trimmed)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

function normalizeTerm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

// ─── Bridge Node Detection ──────────────────────────────────────────────────

/**
 * Find bridge documents — those that sit between two clusters.
 * A bridge node has high similarity to a cluster centroid other than its own.
 *
 * @param vectors     All document vectors.
 * @param labels      Cluster assignment per document.
 * @param centroids   Cluster centroids.
 * @param topN        Maximum number of bridge nodes to return (default 20).
 * @param minSimilarity  Minimum similarity to the nearest *other* centroid (default 0.6).
 */
export function findBridgeNodes(
  vectors: Float32Array[],
  labels: Uint16Array,
  centroids: Float32Array[],
  topN = 20,
  minSimilarity = 0.6,
): BridgeNode[] {
  const n = vectors.length
  const k = centroids.length
  if (k <= 1 || n === 0) return []

  const candidates: BridgeNode[] = []

  // Sample for large datasets to keep computation manageable
  const sampleSize = Math.min(n, 5000)
  const step = n / sampleSize

  for (let s = 0; s < sampleSize; s++) {
    const i = Math.min(Math.floor(s * step), n - 1)
    const ownCluster = labels[i]

    // Find nearest other centroid
    let bestSim = -1
    let bestCluster = -1
    for (let c = 0; c < k; c++) {
      if (c === ownCluster) continue
      const sim = cosineSimilarity(vectors[i], centroids[c])
      if (sim > bestSim) {
        bestSim = sim
        bestCluster = c
      }
    }

    if (bestCluster >= 0 && bestSim >= minSimilarity) {
      candidates.push({
        docIndex: i,
        ownCluster,
        nearestCluster: bestCluster,
        similarityToNearest: bestSim,
      })
    }
  }

  // Return top N by similarity
  candidates.sort((a, b) => b.similarityToNearest - a.similarityToNearest)
  return candidates.slice(0, topN)
}

// ─── Force-Directed Layout ─────────────────────────────────────────────────

/**
 * Compute a 2D force-directed layout for cluster nodes.
 *
 * Uses a simple spring-electric force model:
 * - All nodes repel each other (Coulomb-like repulsion).
 * - Connected nodes attract each other (spring force proportional to similarity).
 *
 * @param counts    Number of docs per cluster.
 * @param edges     Cluster edges with similarities.
 * @param iterations  Number of simulation iterations (default 200).
 * @param seed      PRNG seed for initial placement (default 42).
 */
export function forceDirectedLayout(
  counts: number[],
  edges: ClusterEdge[],
  iterations = 200,
  seed = 42,
): GraphNode[] {
  const k = counts.length
  if (k === 0) return []
  if (k === 1) return [{ id: 0, count: counts[0], x: 0, y: 0 }]

  // Seeded PRNG (mulberry32)
  let s = seed | 0
  const rng = () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  // Initialise random positions in [-1, 1]
  const x = new Float64Array(k)
  const y = new Float64Array(k)
  for (let i = 0; i < k; i++) {
    x[i] = (rng() - 0.5) * 2
    y[i] = (rng() - 0.5) * 2
  }

  // Build adjacency for fast edge lookup
  const adjMap = new Map<number, { target: number; similarity: number }[]>()
  for (const edge of edges) {
    if (!adjMap.has(edge.source)) adjMap.set(edge.source, [])
    if (!adjMap.has(edge.target)) adjMap.set(edge.target, [])
    adjMap.get(edge.source)!.push({ target: edge.target, similarity: edge.similarity })
    adjMap.get(edge.target)!.push({ target: edge.source, similarity: edge.similarity })
  }

  // Force simulation parameters
  const repulsionStrength = 1.0
  const attractionStrength = 2.0
  const damping = 0.9
  let temperature = 0.5

  const vx = new Float64Array(k)
  const vy = new Float64Array(k)

  for (let iter = 0; iter < iterations; iter++) {
    // Reset forces
    const fx = new Float64Array(k)
    const fy = new Float64Array(k)

    // Repulsion (all pairs)
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        let dx = x[i] - x[j]
        let dy = y[i] - y[j]
        let dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < 0.001) {
          dx = (rng() - 0.5) * 0.01
          dy = (rng() - 0.5) * 0.01
          dist = Math.sqrt(dx * dx + dy * dy)
        }
        const force = repulsionStrength / (dist * dist)
        const fdx = (dx / dist) * force
        const fdy = (dy / dist) * force
        fx[i] += fdx
        fy[i] += fdy
        fx[j] -= fdx
        fy[j] -= fdy
      }
    }

    // Attraction (edges only)
    for (const edge of edges) {
      const { source: si, target: ti, similarity } = edge
      const dx = x[ti] - x[si]
      const dy = y[ti] - y[si]
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < 0.001) continue
      // Stronger attraction for more similar clusters
      const force = attractionStrength * similarity * dist
      const fdx = (dx / dist) * force
      const fdy = (dy / dist) * force
      fx[si] += fdx
      fy[si] += fdy
      fx[ti] -= fdx
      fy[ti] -= fdy
    }

    // Apply forces with temperature cooling
    for (let i = 0; i < k; i++) {
      vx[i] = (vx[i] + fx[i]) * damping
      vy[i] = (vy[i] + fy[i]) * damping
      // Clamp velocity
      const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i])
      if (speed > temperature) {
        vx[i] = (vx[i] / speed) * temperature
        vy[i] = (vy[i] / speed) * temperature
      }
      x[i] += vx[i]
      y[i] += vy[i]
    }

    temperature *= 0.995 // Cool down
  }

  // Build result nodes
  return counts.map((count, id) => ({ id, count, x: x[id], y: y[id] }))
}

// ─── Full Graph Builder ─────────────────────────────────────────────────────

/**
 * Build the full cluster graph from clustering results.
 *
 * @param vectors    All document vectors.
 * @param cluster    Flat clustering result (used for centroids/labels/counts).
 * @param hierarchical  Optional hierarchical result (uses macro centroids if present).
 * @param edgeThreshold  Cosine similarity threshold for edges (default 0.5).
 */
export function buildClusterGraph(
  vectors: Float32Array[],
  cluster: ClusterResult,
  hierarchical?: HierarchicalClusterResult,
  edgeThreshold = 0.5,
): ClusterGraphData {
  // Use macro centroids when hierarchical mode is active
  const centroids = hierarchical ? hierarchical.macro.centroids : cluster.centroids
  const labels = hierarchical ? hierarchical.macroLabels : cluster.labels
  const counts = hierarchical ? hierarchical.macro.counts : cluster.counts

  const bridges = findBridgeNodes(vectors, labels, centroids)
  const edges = buildClusterEdges(centroids, edgeThreshold, 5, { bridges })
  const nodes = forceDirectedLayout(counts, edges)

  return { nodes, edges, bridges }
}

/**
 * Rebuild a lightweight ClusterGraphData from meta-index summaries.
 *
 * Uses centroid vectors stored in ClusterSummary to compute edges.
 * Bridge nodes cannot be reconstructed (requires full document vectors).
 */
export function rebuildClusterGraphFromMeta(
  summaries: Array<{ centroidVector: number[]; documentCount: number } & ClusterEdgeSummaryInput>,
  edgeThreshold = 0.5,
): ClusterGraphData {
  const centroids = summaries.map((s) =>
    new Float32Array(s.centroidVector),
  )
  const counts = Array.from(summaries.map((s) => s.documentCount))

  const edges = buildClusterEdges(centroids, edgeThreshold, 5, { summaries })
  const nodes = forceDirectedLayout(counts, edges)

  return { nodes, edges, bridges: [] }
}
