import { cosineSimilarity, type ClusterResult } from './clustering'

export type EvidenceRole = 'prototype' | 'diverse' | 'boundary' | 'outlier'

export interface ClusterEvidenceCandidate {
  docId: string
  index: number
  role: EvidenceRole
  centroidSimilarity: number
  nearestSiblingClusterId?: number
  nearestSiblingSimilarity?: number
  diversityScore?: number
}

export interface VectorDocRef {
  id: string
  title: string
  vector: Float32Array
}

function memberIndicesForCluster(labels: Uint16Array, clusterId: number): number[] {
  const indices: number[] = []
  for (let docIndex = 0; docIndex < labels.length; docIndex++) {
    if (labels[docIndex] === clusterId) indices.push(docIndex)
  }
  return indices
}

function nearestSibling(input: {
  clusterId: number
  clusters: ClusterResult
  vector: Float32Array
}): { clusterId: number; similarity: number } | null {
  const { clusterId, clusters, vector } = input
  let selectedClusterId = -1
  let selectedSimilarity = -Infinity
  for (let candidateClusterId = 0; candidateClusterId < clusters.centroids.length; candidateClusterId++) {
    if (candidateClusterId === clusterId) continue
    const similarity = cosineSimilarity(vector, clusters.centroids[candidateClusterId])
    if (similarity > selectedSimilarity) {
      selectedSimilarity = similarity
      selectedClusterId = candidateClusterId
    }
  }
  return selectedClusterId >= 0 ? { clusterId: selectedClusterId, similarity: selectedSimilarity } : null
}

function pushUnique(
  selected: ClusterEvidenceCandidate[],
  seen: Set<number>,
  candidate: ClusterEvidenceCandidate,
): void {
  if (seen.has(candidate.index)) return
  seen.add(candidate.index)
  selected.push(candidate)
}

export function selectRoleAwareEvidence(input: {
  clusterId: number
  clusters: ClusterResult
  docs: VectorDocRef[]
  maxCount?: number
  mmrLambda?: number
}): ClusterEvidenceCandidate[] {
  const { clusterId, clusters, docs, maxCount = 24, mmrLambda = 0.55 } = input
  const memberIndices = memberIndicesForCluster(clusters.labels, clusterId)
  if (memberIndices.length === 0) return []

  const centroid = clusters.centroids[clusterId]
  const candidates = memberIndices.map((docIndex) => {
    const doc = docs[docIndex]
    const centroidSimilarity = cosineSimilarity(doc.vector, centroid)
    const sibling = nearestSibling({ clusterId, clusters, vector: doc.vector })
    return {
      docId: doc.id,
      index: docIndex,
      role: 'prototype' as EvidenceRole,
      centroidSimilarity,
      nearestSiblingClusterId: sibling?.clusterId,
      nearestSiblingSimilarity: sibling?.similarity,
    }
  })

  const selected: ClusterEvidenceCandidate[] = []
  const seen = new Set<number>()
  const prototypeCount = Math.max(1, Math.ceil(maxCount * 0.25))
  const diverseCount = Math.max(1, Math.ceil(maxCount * 0.35))
  const boundaryCount = Math.max(1, Math.ceil(maxCount * 0.25))
  const outlierCount = Math.max(1, maxCount - prototypeCount - diverseCount - boundaryCount)

  for (const candidate of [...candidates].sort((left, right) => right.centroidSimilarity - left.centroidSimilarity).slice(0, prototypeCount)) {
    pushUnique(selected, seen, { ...candidate, role: 'prototype' })
  }

  const diversePool = [...candidates].sort((left, right) => right.centroidSimilarity - left.centroidSimilarity)
  for (let iteration = 0; iteration < diverseCount && selected.length < maxCount; iteration++) {
    let bestCandidate: ClusterEvidenceCandidate | null = null
    let bestScore = -Infinity
    for (const candidate of diversePool) {
      if (seen.has(candidate.index)) continue
      let maxSelectedSimilarity = 0
      for (const existing of selected) {
        const similarity = cosineSimilarity(docs[candidate.index].vector, docs[existing.index].vector)
        if (similarity > maxSelectedSimilarity) maxSelectedSimilarity = similarity
      }
      const diversityScore = mmrLambda * candidate.centroidSimilarity - (1 - mmrLambda) * maxSelectedSimilarity
      if (diversityScore > bestScore) {
        bestScore = diversityScore
        bestCandidate = { ...candidate, role: 'diverse', diversityScore }
      }
    }
    if (!bestCandidate) break
    pushUnique(selected, seen, bestCandidate)
  }

  for (const candidate of [...candidates]
    .filter((item) => item.nearestSiblingSimilarity !== undefined)
    .sort((left, right) => (right.nearestSiblingSimilarity ?? 0) - (left.nearestSiblingSimilarity ?? 0))
    .slice(0, boundaryCount * 2)) {
    if (selected.length >= maxCount) break
    pushUnique(selected, seen, { ...candidate, role: 'boundary' })
  }

  for (const candidate of [...candidates].sort((left, right) => left.centroidSimilarity - right.centroidSimilarity).slice(0, outlierCount * 2)) {
    if (selected.length >= maxCount) break
    pushUnique(selected, seen, { ...candidate, role: 'outlier' })
  }

  for (const candidate of [...candidates].sort((left, right) => right.centroidSimilarity - left.centroidSimilarity)) {
    if (selected.length >= maxCount) break
    pushUnique(selected, seen, candidate)
  }

  return selected.slice(0, maxCount)
}

export function selectCentroidEvidence(input: {
  clusterId: number
  clusters: ClusterResult
  docs: VectorDocRef[]
  maxCount: number
}): ClusterEvidenceCandidate[] {
  const { clusterId, clusters, docs, maxCount } = input
  const memberIndices = memberIndicesForCluster(clusters.labels, clusterId)
  const centroid = clusters.centroids[clusterId]
  return memberIndices
    .map((docIndex) => ({
      docId: docs[docIndex].id,
      index: docIndex,
      role: 'prototype' as EvidenceRole,
      centroidSimilarity: cosineSimilarity(docs[docIndex].vector, centroid),
    }))
    .sort((left, right) => right.centroidSimilarity - left.centroidSimilarity)
    .slice(0, maxCount)
}
