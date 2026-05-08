/**
 * Lightweight K-Means clustering for in-browser use.
 *
 * Operates on flat Float32Arrays for memory efficiency.
 */

export type ClusterResult = {
  /** Cluster assignment for each vector (0-based). */
  labels: Uint16Array
  /** Centroid vectors, shape [k × dim]. */
  centroids: Float32Array[]
  /** Number of vectors in each cluster. */
  counts: number[]
  /** Inertia (sum of squared distances to assigned centroid). */
  inertia: number
}

/** Cosine similarity between two same-length arrays. */
export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/** Squared Euclidean distance. */
function sqDist(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    s += d * d
  }
  return s
}

/**
 * Seeded pseudo-random number generator (mulberry32).
 * Produces deterministic results for a given seed.
 */
function seededRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Pick k initial centroids using K-Means++ initialisation. */
function kMeansPPInit(vectors: Float32Array[], k: number, rng: () => number): Float32Array[] {
  const n = vectors.length
  const centroids: Float32Array[] = []
  // 1st centroid: random
  const idx0 = Math.floor(rng() * n)
  centroids.push(new Float32Array(vectors[idx0]))

  const dists = new Float64Array(n).fill(Number.MAX_VALUE)
  for (let c = 1; c < k; c++) {
    const prev = centroids[c - 1]
    let total = 0
    for (let i = 0; i < n; i++) {
      const d = sqDist(vectors[i], prev)
      if (d < dists[i]) dists[i] = d
      total += dists[i]
    }
    // Weighted random
    let r = rng() * total
    let chosen = 0
    for (let i = 0; i < n; i++) {
      r -= dists[i]
      if (r <= 0) {
        chosen = i
        break
      }
    }
    centroids.push(new Float32Array(vectors[chosen]))
  }
  return centroids
}

/**
 * K-Means clustering.
 *
 * @param vectors  Array of equal-length Float32Array embedding vectors.
 * @param k        Number of clusters.
 * @param maxIter  Maximum iterations (default 50).
 * @param seed     Random seed for reproducibility (default 42).
 */
export function kMeans(vectors: Float32Array[], k: number, maxIter = 50, seed = 42): ClusterResult {
  const n = vectors.length
  if (n === 0) {
    return { labels: new Uint16Array(0), centroids: [], counts: [], inertia: 0 }
  }
  const dim = vectors[0].length
  const clampedK = Math.min(k, n)

  const rng = seededRng(seed)
  let centroids = kMeansPPInit(vectors, clampedK, rng)
  const labels = new Uint16Array(n)
  let counts = new Array<number>(clampedK).fill(0)
  let inertia = 0

  for (let iter = 0; iter < maxIter; iter++) {
    // Assignment
    let changed = 0
    inertia = 0
    counts.fill(0)
    for (let i = 0; i < n; i++) {
      let bestC = 0
      let bestD = sqDist(vectors[i], centroids[0])
      for (let c = 1; c < clampedK; c++) {
        const d = sqDist(vectors[i], centroids[c])
        if (d < bestD) {
          bestD = d
          bestC = c
        }
      }
      if (labels[i] !== bestC) changed++
      labels[i] = bestC
      counts[bestC]++
      inertia += bestD
    }

    if (changed === 0 && iter > 0) break

    // Update centroids
    const newCentroids = Array.from({ length: clampedK }, () => new Float32Array(dim))
    for (let i = 0; i < n; i++) {
      const c = labels[i]
      const vec = vectors[i]
      const cent = newCentroids[c]
      for (let d = 0; d < dim; d++) cent[d] += vec[d]
    }
    for (let c = 0; c < clampedK; c++) {
      if (counts[c] > 0) {
        for (let d = 0; d < dim; d++) newCentroids[c][d] /= counts[c]
      }
    }
    centroids = newCentroids
  }

  return { labels, centroids, counts, inertia }
}

/**
 * Compute silhouette score for determining quality of clustering.
 * Returns a value in [-1, 1]; higher is better.
 * Uses a subset of vectors for performance when n is large.
 */
export function silhouetteScore(vectors: Float32Array[], labels: Uint16Array, sampleSize = 500): number {
  const n = vectors.length
  if (n <= 1) return 0

  // Sample indices for large datasets
  const indices: number[] = []
  if (n <= sampleSize) {
    for (let i = 0; i < n; i++) indices.push(i)
  } else {
    const step = n / sampleSize
    for (let s = 0; s < sampleSize; s++) {
      indices.push(Math.min(Math.floor(s * step), n - 1))
    }
  }

  const k = new Set(labels).size
  if (k <= 1) return 0

  let totalSil = 0
  for (const i of indices) {
    const ci = labels[i]
    // Mean intra-cluster distance
    let aSum = 0
    let aCount = 0
    // Mean nearest-cluster distance
    const bSums = new Float64Array(k)
    const bCounts = new Uint32Array(k)

    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const d = sqDist(vectors[i], vectors[j])
      const cj = labels[j]
      if (cj === ci) {
        aSum += d
        aCount++
      } else {
        bSums[cj] += d
        bCounts[cj]++
      }
    }
    const a = aCount > 0 ? aSum / aCount : 0
    let b = Number.MAX_VALUE
    for (let c = 0; c < k; c++) {
      if (c === ci || bCounts[c] === 0) continue
      b = Math.min(b, bSums[c] / bCounts[c])
    }
    if (b === Number.MAX_VALUE) b = 0
    const s = Math.max(a, b) === 0 ? 0 : (b - a) / Math.max(a, b)
    totalSil += s
  }

  return totalSil / indices.length
}

/**
 * Find the elbow point in an inertia curve.
 * Returns the best k value from the candidates.
 */
export function findElbowK(inertias: { k: number; inertia: number }[]): number {
  if (inertias.length <= 1) return inertias[0]?.k ?? 2
  if (inertias.length === 2) return inertias[0].k

  // Line from first to last point
  const x1 = inertias[0].k
  const y1 = inertias[0].inertia
  const x2 = inertias[inertias.length - 1].k
  const y2 = inertias[inertias.length - 1].inertia

  const dx = x2 - x1
  const dy = y2 - y1
  const lineLen = Math.sqrt(dx * dx + dy * dy)

  let bestDist = -1
  let bestK = inertias[0].k
  for (const pt of inertias) {
    // Distance from point to line
    const dist = Math.abs(dy * pt.k - dx * pt.inertia + x2 * y1 - y2 * x1) / lineLen
    if (dist > bestDist) {
      bestDist = dist
      bestK = pt.k
    }
  }
  return bestK
}

// ─── Hierarchical (2-Level) Clustering ──────────────────────────────────────

export interface HierarchicalClusterResult {
  /** Macro cluster assignment for each vector (0-based). */
  macroLabels: Uint16Array
  /** Micro cluster assignment for each vector (globally unique, 0-based). */
  microLabels: Uint16Array
  /** Macro-level clustering result. */
  macro: ClusterResult
  /** Per-macro breakdown of micro clusters. microClusters[macroId] = ClusterResult for that macro's members. */
  microClusters: ClusterResult[]
  /** Global micro cluster id → macro cluster id mapping. */
  microToMacro: Uint16Array
  /** Total number of micro clusters across all macros. */
  totalMicroClusters: number
}

/**
 * Two-level hierarchical clustering: Macro → Micro.
 *
 * 1. Run K-Means on all vectors with `macroK` clusters (high-level grouping).
 * 2. For each macro cluster, run K-Means again with `microK` sub-clusters.
 *
 * @param vectors  Array of equal-length Float32Array embedding vectors.
 * @param macroK   Number of macro clusters (top level).
 * @param microK   Number of micro clusters per macro (sub-clusters).
 * @param maxIter  Maximum K-Means iterations per level.
 * @param seed     Random seed for reproducibility.
 */
export function hierarchicalKMeans(
  vectors: Float32Array[],
  macroK: number,
  microK: number,
  maxIter = 50,
  seed = 42,
): HierarchicalClusterResult {
  const n = vectors.length

  // Level 1: Macro clustering
  const macro = kMeans(vectors, macroK, maxIter, seed)

  // Level 2: Micro clustering within each macro
  const microClusters: ClusterResult[] = []
  const microLabels = new Uint16Array(n)
  const microToMacroArr: number[] = []
  let globalMicroId = 0

  for (let m = 0; m < macro.centroids.length; m++) {
    // Gather indices belonging to this macro cluster
    const memberIndices: number[] = []
    for (let i = 0; i < n; i++) {
      if (macro.labels[i] === m) memberIndices.push(i)
    }

    if (memberIndices.length === 0) {
      // Empty macro cluster - add empty micro result
      microClusters.push({ labels: new Uint16Array(0), centroids: [], counts: [], inertia: 0 })
      continue
    }

    const memberVecs = memberIndices.map((i) => vectors[i])
    const effectiveMicroK = Math.min(microK, memberVecs.length)

    // Use a different seed per macro to get variety, but still deterministic
    const microSeed = seed + m * 97 + 1
    const microResult = kMeans(memberVecs, effectiveMicroK, maxIter, microSeed)
    microClusters.push(microResult)

    // Map local micro labels to global IDs
    for (let localIdx = 0; localIdx < memberIndices.length; localIdx++) {
      const globalIdx = memberIndices[localIdx]
      const localMicroLabel = microResult.labels[localIdx]
      microLabels[globalIdx] = globalMicroId + localMicroLabel
    }

    // Record micro→macro mapping
    for (let mc = 0; mc < microResult.centroids.length; mc++) {
      microToMacroArr.push(m)
    }
    globalMicroId += microResult.centroids.length
  }

  const microToMacro = new Uint16Array(microToMacroArr)

  return {
    macroLabels: macro.labels,
    microLabels,
    macro,
    microClusters,
    microToMacro,
    totalMicroClusters: globalMicroId,
  }
}
