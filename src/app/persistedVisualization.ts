/**
 * Persistence layer for Index Cluster Visualizer data (cluster scatter, graph, summaries).
 *
 * For small datasets, data is stored in localStorage.
 * For large datasets (> 5MB estimated), the user should use file export/import instead.
 *
 * File format: `.ragvis.json` containing serialized visualization state.
 */

import type { VisualizationData, ScannedDoc } from '../hooks/useIndexVisualization'
import type { ClusterResult, HierarchicalClusterResult } from '../lib/clustering'
import type { PcaResult } from '../lib/dimensionReduction'
import type { ClusterGraphData } from '../lib/clusterGraph'
import type { ClusterSummary, ClusterSummaryMode, MetaClusterTrace } from '../lib/metaIndex'

// ─── Serializable Types ─────────────────────────────────────────────────────

/** Portable representation of visualization state for save/load. */
export interface VisualizationSnapshot {
  version: 1
  kind?: 'ragops.visualization'
  createdAt: string
  /** Source index name. */
  indexName: string
  /** Vector field used. */
  vectorField: string
  /** Settings at generation time. */
  settings: {
    k: number
    microK: number
    maxDocs: number
    enableHierarchical: boolean
    enableGraph: boolean
    graphEdgeThreshold: number
    reductionMethod: string
    enableAdaptiveSampling: boolean
  }
  /** Docs (id + title only — vectors excluded for size). */
  docs: Array<{ id: string; title: string }>
  /** Cluster labels (array of cluster indices per doc). */
  labels: number[]
  /** Centroid vectors (array of number arrays). */
  centroids: number[][]
  /** Cluster counts. */
  counts: number[]
  /** Inertia. */
  inertia: number
  /** PCA 2D coordinates. */
  coords: [number, number][]
  /** PCA explained variance. */
  explainedVariance: [number, number]
  /** Hierarchical clustering (optional). */
  hierarchical?: {
    macroLabels: number[]
    microLabels: number[]
    microToMacro: number[]
    totalMicroClusters: number
    microClusters?: Array<{
      labels: number[]
      centroids: number[][]
      counts: number[]
      inertia: number
    }>
  }
  /** Cluster graph (optional). */
  graph?: ClusterGraphData
  /** Legacy optional field. New `.ragvis.json` exports do not include LLM summaries. */
  clusterSummaries?: ClusterSummary[]
}

export interface MetaIndexSnapshot {
  version: 1
  kind: 'ragops.meta-index-cache'
  createdAt: string
  indexName: string
  vectorField: string
  summaryMode: ClusterSummaryMode
  metaIndexName?: string | null
  metaTokenUsage?: { prompt: number; completion: number; total: number }
  clusterSummaries: ClusterSummary[]
  metaTraces?: MetaClusterTrace[]
  visualization?: VisualizationSnapshot
}

// ─── localStorage Persistence ───────────────────────────────────────────────

const STORAGE_KEY = 'ragops.visualization.v1'

export interface PersistedVisualizationItem {
  id: string
  title: string
  updatedAt: number
  indexName: string
  docCount: number
  clusterCount: number
  /** Snapshot payload (stored inline). */
  snapshot: VisualizationSnapshot
}

interface PersistedRoot {
  items: PersistedVisualizationItem[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function readRoot(): PersistedRoot {
  if (typeof localStorage === 'undefined') return { items: [] }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { items: [] }
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed) || !Array.isArray(parsed.items)) return { items: [] }
    return parsed as unknown as PersistedRoot
  } catch {
    return { items: [] }
  }
}

function writeRoot(root: PersistedRoot) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(root))
  } catch {
    // Quota exceeded or private mode — caller should use file export
  }
}

export function listVisualizations(): PersistedVisualizationItem[] {
  return [...readRoot().items].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function upsertVisualization(item: PersistedVisualizationItem) {
  const root = readRoot()
  const idx = root.items.findIndex((x) => x.id === item.id)
  const next = { ...item, updatedAt: Date.now() }
  if (idx >= 0) root.items[idx] = next
  else root.items.unshift(next)
  writeRoot(root)
}

export function deleteVisualization(id: string) {
  const root = readRoot()
  root.items = root.items.filter((x) => x.id !== id)
  writeRoot(root)
}

export function getVisualization(id: string): PersistedVisualizationItem | null {
  return readRoot().items.find((x) => x.id === id) ?? null
}

// ─── Snapshot Serialization ─────────────────────────────────────────────────

/** Build a VisualizationSnapshot from current runtime data. */
export function buildSnapshot(params: {
  indexName: string
  vectorField: string
  settings: VisualizationSnapshot['settings']
  data: VisualizationData
  clusterSummaries?: ClusterSummary[] | null
}): VisualizationSnapshot {
  const { indexName, vectorField, settings, data, clusterSummaries } = params

  const snapshot: VisualizationSnapshot = {
    version: 1,
    kind: 'ragops.visualization',
    createdAt: new Date().toISOString(),
    indexName,
    vectorField,
    settings,
    docs: data.docs.map((d) => ({ id: d.id, title: d.title })),
    labels: Array.from(data.cluster.labels),
    centroids: data.cluster.centroids.map((c) => Array.from(c)),
    counts: data.cluster.counts,
    inertia: data.cluster.inertia,
    coords: data.pca.coords,
    explainedVariance: data.pca.explainedVariance,
  }

  if (data.hierarchical) {
    snapshot.hierarchical = {
      macroLabels: Array.from(data.hierarchical.macroLabels),
      microLabels: Array.from(data.hierarchical.microLabels),
      microToMacro: Array.from(data.hierarchical.microToMacro),
      totalMicroClusters: data.hierarchical.totalMicroClusters,
      microClusters: data.hierarchical.microClusters.map((micro) => ({
        labels: Array.from(micro.labels),
        centroids: micro.centroids.map((centroid) => Array.from(centroid)),
        counts: micro.counts,
        inertia: micro.inertia,
      })),
    }
  }

  if (data.graph) {
    snapshot.graph = data.graph
  }

  if (clusterSummaries && clusterSummaries.length > 0) {
    snapshot.clusterSummaries = clusterSummaries
  }

  return snapshot
}

/** Restore runtime VisualizationData from a snapshot. */
export function restoreFromSnapshot(snapshot: VisualizationSnapshot): {
  data: VisualizationData
  clusterSummaries: ClusterSummary[] | null
} {
  const docs: ScannedDoc[] = snapshot.docs.map((d) => ({
    id: d.id,
    title: d.title,
    vector: new Float32Array(0), // Vectors not stored — only needed for re-clustering
  }))

  const cluster: ClusterResult = {
    labels: new Uint16Array(snapshot.labels),
    centroids: snapshot.centroids.map((c) => new Float32Array(c)),
    counts: snapshot.counts,
    inertia: snapshot.inertia,
  }

  const pca: PcaResult = {
    coords: snapshot.coords,
    explainedVariance: snapshot.explainedVariance,
  }

  let hierarchical: HierarchicalClusterResult | undefined
  if (snapshot.hierarchical) {
    const h = snapshot.hierarchical
    hierarchical = {
      macroLabels: new Uint16Array(h.macroLabels),
      microLabels: new Uint16Array(h.microLabels),
      macro: cluster,
      microClusters: h.microClusters?.map((micro) => ({
        labels: new Uint16Array(micro.labels),
        centroids: micro.centroids.map((centroid) => new Float32Array(centroid)),
        counts: micro.counts,
        inertia: micro.inertia,
      })) ?? [],
      microToMacro: new Uint16Array(h.microToMacro),
      totalMicroClusters: h.totalMicroClusters,
    }
  }

  const data: VisualizationData = {
    docs,
    cluster,
    pca,
    hierarchical,
    graph: snapshot.graph,
  }

  return {
    data,
    clusterSummaries: snapshot.clusterSummaries ?? null,
  }
}

// ─── File Export / Import ────────────────────────────────────────────────────

/** Estimate the JSON size of a snapshot in bytes. */
export function estimateSnapshotSize(snapshot: VisualizationSnapshot): number {
  // Rough estimate based on doc count and centroid dimensions
  const docOverhead = snapshot.docs.length * 80 // avg id+title
  const coordOverhead = snapshot.coords.length * 20 // [x,y] as text
  const labelOverhead = snapshot.labels.length * 4
  const centroidOverhead = snapshot.centroids.reduce((acc, c) => acc + c.length * 8, 0)
  const microCentroidOverhead = snapshot.hierarchical?.microClusters?.reduce(
    (acc, micro) => acc + micro.centroids.reduce((sum, centroid) => sum + centroid.length * 8, 0),
    0,
  ) ?? 0
  return docOverhead + coordOverhead + labelOverhead + centroidOverhead + microCentroidOverhead + 2000 // metadata
}

/** Size threshold above which localStorage persistence is risky (5 MB). */
export const LARGE_DATA_THRESHOLD = 5 * 1024 * 1024

/** Export a snapshot to a downloadable .ragvis.json file. */
export function exportSnapshotToFile(snapshot: VisualizationSnapshot, filename?: string) {
  const json = JSON.stringify(snapshot, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? `${snapshot.indexName}-${new Date().toISOString().slice(0, 10)}.ragvis.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/** Import a snapshot from a File object. Returns null if parsing fails. */
export async function importSnapshotFromFile(file: File): Promise<VisualizationSnapshot | null> {
  try {
    const text = await file.text()
    const parsed = JSON.parse(text)
    if (!isRecord(parsed)) return null
    if (parsed.version !== 1) return null
    if ('kind' in parsed && parsed.kind !== 'ragops.visualization') return null
    if (!Array.isArray(parsed.docs) || !Array.isArray(parsed.labels) || !Array.isArray(parsed.coords)) return null
    return parsed as unknown as VisualizationSnapshot
  } catch {
    return null
  }
}

export function buildMetaIndexSnapshot(params: {
  indexName: string
  vectorField: string
  summaryMode: ClusterSummaryMode
  metaIndexName?: string | null
  metaTokenUsage?: { prompt: number; completion: number; total: number }
  clusterSummaries: ClusterSummary[]
  metaTraces?: MetaClusterTrace[]
  visualization?: VisualizationSnapshot
}): MetaIndexSnapshot {
  return {
    version: 1,
    kind: 'ragops.meta-index-cache',
    createdAt: new Date().toISOString(),
    indexName: params.indexName,
    vectorField: params.vectorField,
    summaryMode: params.summaryMode,
    metaIndexName: params.metaIndexName ?? null,
    metaTokenUsage: params.metaTokenUsage,
    clusterSummaries: params.clusterSummaries,
    metaTraces: params.metaTraces,
    visualization: params.visualization,
  }
}

export function exportMetaIndexSnapshotToFile(snapshot: MetaIndexSnapshot, filename?: string) {
  const json = JSON.stringify(snapshot, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? `${snapshot.indexName}-meta-cache-${new Date().toISOString().slice(0, 10)}.ragmeta.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export async function importMetaIndexSnapshotFromFile(file: File): Promise<MetaIndexSnapshot | null> {
  try {
    const text = await file.text()
    const parsed = JSON.parse(text)
    if (!isRecord(parsed)) return null
    if (parsed.version !== 1 || parsed.kind !== 'ragops.meta-index-cache') return null
    if (!Array.isArray(parsed.clusterSummaries)) return null
    return parsed as unknown as MetaIndexSnapshot
  } catch {
    return null
  }
}
