/**
 * Adaptive vector sampling for the Index Cluster Visualizer.
 *
 * Provides intelligent sampling strategies for vector retrieval
 * based on detected index structure (chunked vs independent).
 *
 * Reuses detectIndexStructure() from evalDatasetSampling for structure detection.
 */

import { searchDocuments, type JsonValue } from './aiSearchRest'
import type { ConnectionProfile, SearchApiVersion } from './model'
import type { Language } from './translations'
import type { IndexStructureInfo } from '../types/evalDataset'

export { detectIndexStructure, type DetectIndexStructureParams } from './evalDatasetSampling'

export interface VectorSampleDoc {
  id: string
  title: string
  vector: Float32Array
}

export interface ScanVectorsParams {
  profile: ConnectionProfile
  indexName: string
  apiVersion: SearchApiVersion
  keyField: string
  vectorField: string
  titleField: string
  maxDocs: number
  language?: Language
  signal?: AbortSignal
  onProgress?: (scanned: number, total: number) => void
}

export interface AdaptiveVectorScanParams extends ScanVectorsParams {
  indexStructure: IndexStructureInfo
}

/**
 * Simple parallel scan.
 * Sends concurrent batch requests using $skip+$top paging.
 */
export async function scanVectorsSimple(params: ScanVectorsParams): Promise<VectorSampleDoc[]> {
  const { profile, indexName, apiVersion, keyField, vectorField, titleField, maxDocs, language, signal, onProgress } = params
  const batchSize = 100
  const limit = Math.min(maxDocs, 10000)
  const CONCURRENCY = 6

  const selectFields = [keyField, vectorField]
  if (titleField && titleField !== keyField) selectFields.push(titleField)
  const select = selectFields.join(',')

  // Pre-compute all offsets we might need ($skip max = 100,000)
  const maxSkip = 100_000
  const offsets: number[] = []
  for (let skip = 0; skip < Math.min(limit, maxSkip); skip += batchSize) {
    offsets.push(skip)
  }

  const allDocs: VectorSampleDoc[] = []
  let cursor = 0
  let earlyStop = false

  const worker = async () => {
    while (!earlyStop) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const idx = cursor++
      if (idx >= offsets.length) return

      const body: Record<string, JsonValue> = {
        search: '*',
        top: Math.min(batchSize, limit - offsets[idx]),
        skip: offsets[idx],
        select,
        count: false,
      }

      const result = await searchDocuments({ profile, indexName, apiVersion, body, language, signal })
      if (!result.ok || !result.response) { earlyStop = true; return }

      const resp = result.response as Record<string, JsonValue>
      const values = resp.value as Array<Record<string, JsonValue>> | undefined
      if (!values || values.length === 0) { earlyStop = true; return }

      for (const doc of values) {
        const parsed = parseVectorDoc(doc, keyField, vectorField, titleField)
        if (parsed) allDocs.push(parsed)
      }
      onProgress?.(allDocs.length, limit)

      // If this batch returned fewer results than requested, we've hit the end
      if (values.length < batchSize) earlyStop = true
      if (allDocs.length >= limit) earlyStop = true
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(CONCURRENCY, offsets.length); i++) workers.push(worker())
  await Promise.all(workers)

  // Trim to limit (concurrent workers may overshoot slightly)
  return allDocs.slice(0, limit)
}

/**
 * Adaptive vector sampling that branches on detected index structure.
 *
 * - **Chunked**: Samples from diverse source documents using facets.
 * - **Independent**: Uses distributed $skip to spread samples across the index.
 * - **Unknown**: Falls back to simple sequential scan.
 */
export async function scanVectorsAdaptive(params: AdaptiveVectorScanParams): Promise<VectorSampleDoc[]> {
  const { indexStructure, ...baseParams } = params

  switch (indexStructure.type) {
    case 'chunked':
      return scanVectorsFromChunkedIndex(baseParams, indexStructure)
    case 'independent':
      return scanVectorsDistributed(baseParams, indexStructure)
    default:
      return scanVectorsSimple(baseParams)
  }
}

// ─── Chunked Index Strategy ─────────────────────────────────────────────────

/**
 * Chunked index vector sampling:
 * 1. Facet query on parentField to discover source documents.
 * 2. Randomly select sources.
 * 3. For each source, fetch up to N chunks with vectors.
 *
 * This ensures diversity across source documents rather than over-representing
 * a single source's chunks in the scatter plot.
 */
async function scanVectorsFromChunkedIndex(
  params: ScanVectorsParams,
  structure: IndexStructureInfo,
): Promise<VectorSampleDoc[]> {
  const { profile, indexName, apiVersion, keyField, vectorField, titleField, maxDocs, language, signal, onProgress } = params
  const parentField = structure.parentField!
  const limit = Math.min(maxDocs, 10000)

  // 1. Facet query to get source values
  const facetBody: JsonValue = {
    search: '*',
    top: 0,
    count: true,
    facets: [`${parentField},count:500`],
    queryType: 'simple',
  }

  const facetResult = await searchDocuments({ profile, indexName, apiVersion, body: facetBody, language, signal })
  if (!facetResult.ok) {
    return scanVectorsSimple(params)
  }

  const facetResponse = facetResult.response as Record<string, unknown> | null
  const facets = facetResponse?.['@search.facets'] as Record<string, unknown> | undefined
  const buckets = facets && Array.isArray(facets[parentField]) ? (facets[parentField] as unknown[]) : []

  if (buckets.length === 0) {
    return scanVectorsSimple(params)
  }

  // Extract source values
  const sourceValues: string[] = []
  for (const b of buckets) {
    if (!b || typeof b !== 'object') continue
    const rec = b as Record<string, unknown>
    const v = rec['value']
    if (typeof v === 'string' && v.trim()) sourceValues.push(v)
    else if (typeof v === 'number') sourceValues.push(String(v))
  }

  if (sourceValues.length === 0) {
    return scanVectorsSimple(params)
  }

  // 2. Calculate how many chunks per source
  // Target: maxDocs vectors spread across sources
  const totalSources = sourceValues.length
  const chunksPerSource = Math.max(1, Math.ceil(limit / totalSources))
  const maxSources = Math.min(totalSources, Math.ceil(limit / chunksPerSource))

  // Shuffle and select sources
  const shuffled = shuffleArray(sourceValues)
  const selectedSources = shuffled.slice(0, maxSources)

  // 3. Fetch vectors from each source (parallel with concurrency limit)
  const allDocs: VectorSampleDoc[] = []
  const CONCURRENCY = 5
  const selectFields = [keyField, vectorField]
  if (titleField && titleField !== keyField) selectFields.push(titleField)
  const select = selectFields.join(',')

  let cursor = 0
  const worker = async () => {
    while (cursor < selectedSources.length && allDocs.length < limit) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const idx = cursor++
      if (idx >= selectedSources.length) return
      const sourceVal = selectedSources[idx]

      const filterExpr = `${parentField} eq '${escapeODataString(sourceVal)}'`
      const body: JsonValue = {
        search: '*',
        filter: filterExpr,
        top: chunksPerSource,
        select,
        queryType: 'simple',
      }

      try {
        const result = await searchDocuments({ profile, indexName, apiVersion, body, language, signal })
        if (!result.ok) continue
        const response = result.response as Record<string, unknown> | null
        const value = response && Array.isArray(response['value']) ? (response['value'] as unknown[]) : []

        for (const raw of value) {
          if (allDocs.length >= limit) break
          const doc = raw as Record<string, JsonValue>
          const parsed = parseVectorDoc(doc, keyField, vectorField, titleField)
          if (parsed) allDocs.push(parsed)
        }
        onProgress?.(allDocs.length, limit)
      } catch {
        // Skip this source on error
      }
    }
  }

  const workers: Promise<void>[] = []
  const w = Math.min(CONCURRENCY, selectedSources.length)
  for (let i = 0; i < w; i++) workers.push(worker())
  await Promise.all(workers)

  return allDocs
}

// ─── Independent Index Strategy ─────────────────────────────────────────────

/**
 * Independent index vector sampling: distributed $skip with batch fetching.
 *
 * Spreads sample points across the entire index using calculated skip offsets.
 * This prevents over-sampling from the beginning of the index.
 */
async function scanVectorsDistributed(
  params: ScanVectorsParams,
  structure: IndexStructureInfo,
): Promise<VectorSampleDoc[]> {
  const { profile, indexName, apiVersion, keyField, vectorField, titleField, maxDocs, language, signal, onProgress } = params
  const total = structure.documentCount
  const limit = Math.min(maxDocs, 10000)

  // If total docs <= maxDocs, just do simple sequential scan
  if (total <= limit || total === 0) {
    return scanVectorsSimple(params)
  }

  // $skip max is 100,000 in Azure AI Search
  const maxSkip = Math.min(total, 100_000)
  const batchSize = 50 // Fetch in small batches at each offset
  const numOffsets = Math.ceil(limit / batchSize)
  const stride = Math.floor(maxSkip / numOffsets)

  if (stride <= 1) {
    return scanVectorsSimple(params)
  }

  const selectFields = [keyField, vectorField]
  if (titleField && titleField !== keyField) selectFields.push(titleField)
  const select = selectFields.join(',')

  // Pre-compute all offsets
  const offsets: number[] = []
  for (let i = 0; i < numOffsets; i++) offsets.push(i * stride)

  const allDocs: VectorSampleDoc[] = []
  const seenIds = new Set<string>()
  const CONCURRENCY = 6
  let cursor = 0

  const worker = async () => {
    while (allDocs.length < limit) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const idx = cursor++
      if (idx >= offsets.length) return

      const body: Record<string, JsonValue> = {
        search: '*',
        top: batchSize,
        skip: offsets[idx],
        select,
        queryType: 'simple',
      }

      const result = await searchDocuments({ profile, indexName, apiVersion, body, language, signal })
      if (!result.ok || !result.response) continue

      const resp = result.response as Record<string, JsonValue>
      const values = resp.value as Array<Record<string, JsonValue>> | undefined
      if (!values || values.length === 0) continue

      for (const doc of values) {
        if (allDocs.length >= limit) break
        const parsed = parseVectorDoc(doc, keyField, vectorField, titleField)
        if (parsed && !seenIds.has(parsed.id)) {
          seenIds.add(parsed.id)
          allDocs.push(parsed)
        }
      }
      onProgress?.(allDocs.length, limit)
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(CONCURRENCY, offsets.length); i++) workers.push(worker())
  await Promise.all(workers)

  return allDocs.slice(0, limit)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Parse a search result document into a VectorSampleDoc. */
function parseVectorDoc(
  doc: Record<string, JsonValue>,
  keyField: string,
  vectorField: string,
  titleField: string,
): VectorSampleDoc | null {
  const id = String(doc[keyField] ?? '')
  if (!id) return null

  const title = titleField ? String(doc[titleField] ?? id) : id

  // Extract vector - handle nested field paths (e.g. "field/subfield")
  let vectorRaw: JsonValue = null
  const parts = vectorField.split('/')
  let current: JsonValue = doc as JsonValue
  for (const part of parts) {
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, JsonValue>)[part]
    } else {
      current = null
      break
    }
  }
  vectorRaw = current

  if (!Array.isArray(vectorRaw)) return null

  const vec = new Float32Array(vectorRaw.length)
  for (let i = 0; i < vectorRaw.length; i++) {
    vec[i] = Number(vectorRaw[i]) || 0
  }

  return { id, title, vector: vec }
}

/** Fisher-Yates shuffle (returns a new array). */
function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Escape a string value for use in OData $filter expressions. */
function escapeODataString(s: string): string {
  return s.replace(/'/g, "''")
}
