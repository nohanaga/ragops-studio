/**
 * Document sampling for the Eval Dataset Generator (EDAG, Phase 1 MVP).
 *
 * Pulls documents from an Azure AI Search index using `searchDocuments`
 * (search="*"), keeping only the configured key + content fields.
 *
 * Phase 0 (Adaptive Sampling): detects index structure (chunked vs independent)
 * via `getIndexDefinition()` heuristics + facet queries, then selects the best
 * sampling strategy automatically.
 */

import { searchDocuments, getIndexDefinition } from './aiSearchRest'
import type { JsonValue } from './aiSearchRest'
import type { ConnectionProfile, SearchApiVersion } from './model'
import type { Language } from './translations'
import type { IndexStructureInfo, IndexStructureType } from '../types/evalDataset'

export interface SampledDoc {
  id: string
  text: string
  /** Parent/source document identifier (set when index is chunked). */
  parentId?: string
  /** IDs of sibling chunks from the same source (for sibling-aware grounding). */
  siblingIds?: string[]
}

export interface SampleDocsParams {
  profile: ConnectionProfile
  indexName: string
  apiVersion: SearchApiVersion
  keyField: string
  contentFields: string[]
  sampleSize: number
  language?: Language
  signal?: AbortSignal
}

function pickString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field]
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').join('\n')
  if (v == null) return ''
  return String(v)
}

/**
 * Fetch up to `sampleSize` documents and project them into `{ id, text }` pairs.
 *
 * NOTE: This is a simple "first-page" sampler for the MVP. Future work may add
 * stratified sampling (by length, category, etc.) — see design doc §6.1 [2].
 */
export async function sampleDocsFromIndex(params: SampleDocsParams): Promise<SampledDoc[]> {
  const { profile, indexName, apiVersion, keyField, contentFields, sampleSize, language, signal } = params

  if (!keyField.trim()) {
    throw new Error('keyField is required')
  }
  if (contentFields.length === 0) {
    throw new Error('contentFields must contain at least one field')
  }
  if (signal?.aborted) {
    throw new Error('aborted')
  }

  const select = [keyField, ...contentFields].join(',')
  const top = Math.max(1, Math.min(1000, Math.floor(sampleSize)))

  const body: JsonValue = {
    search: '*',
    top,
    select,
    queryType: 'simple',
  }

  const result = await searchDocuments({ profile, indexName, apiVersion, body, language, signal })
  if (!result.ok) {
    throw new Error(result.error?.message ?? 'searchDocuments failed')
  }

  const response = result.response as Record<string, unknown> | null
  const value = response && Array.isArray(response['value']) ? (response['value'] as unknown[]) : []

  const docs: SampledDoc[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const id = pickString(obj, keyField).trim()
    if (!id) continue
    const textParts = contentFields.map((f) => pickString(obj, f).trim()).filter((s) => s.length > 0)
    const text = textParts.join('\n\n')
    if (!text) continue
    docs.push({ id, text })
  }
  return docs
}

/* ------------------------------------------------------------------ */
/* Phase 0: Index Structure Detection                                  */
/* ------------------------------------------------------------------ */

/**
 * Well-known field names that typically act as a parent/source key
 * in chunked Azure AI Search indexes. Ordered by likelihood.
 */
const PARENT_FIELD_HEURISTICS: string[] = [
  'parent_id',
  'parent_key',
  'parentId',
  'parentKey',
  'metadata_storage_path',
  'metadata_storage_name',
  'source_url',
  'source_uri',
  'sourceUrl',
  'source',
  'title',
  'document_title',
  'file_name',
  'fileName',
]

export interface DetectIndexStructureParams {
  profile: ConnectionProfile
  indexName: string
  apiVersion: SearchApiVersion
  keyField: string
  /** If the user explicitly chose a parent field, skip heuristic detection. */
  parentFieldOverride?: string
  language?: Language
  signal?: AbortSignal
}

/**
 * Detect whether an Azure AI Search index is chunked (parent-child) or independent.
 *
 * Strategy:
 *  1. GET index definition → scan field names against heuristic list.
 *  2. For the best candidate parent field, issue a facet query:
 *       `search: '*', top: 0, count: true, facets: ["<field>,count:0"]`
 *     A filterable/facetable string field with distinctValues << docCount
 *     strongly indicates a chunked index (many rows share the same source).
 *  3. If no candidate matches, report `independent`.
 *
 * Cost: 1 GET (schema) + at most 1 POST (facet probe). Zero LLM calls.
 */
export async function detectIndexStructure(
  params: DetectIndexStructureParams,
): Promise<IndexStructureInfo> {
  const { profile, indexName, apiVersion, keyField, parentFieldOverride, language, signal } = params

  if (signal?.aborted) throw new Error('aborted')

  // ---- Step 1: Get index schema ----
  const defResult = await getIndexDefinition({ profile, indexName, apiVersion, language })
  if (!defResult.ok) {
    return { type: 'unknown', documentCount: 0, reason: 'Failed to retrieve index definition' }
  }
  const schema = defResult.response as Record<string, unknown> | null
  const fields = schema && Array.isArray(schema['fields']) ? (schema['fields'] as unknown[]) : []

  // Build a set of field names and a map of field metadata.
  interface FieldMeta { name: string; type: string; filterable: boolean; facetable: boolean }
  const fieldMap = new Map<string, FieldMeta>()
  for (const f of fields) {
    if (!f || typeof f !== 'object') continue
    const rec = f as Record<string, unknown>
    const name = typeof rec['name'] === 'string' ? rec['name'] : ''
    const type = typeof rec['type'] === 'string' ? rec['type'] : ''
    if (!name) continue
    fieldMap.set(name.toLowerCase(), {
      name,
      type,
      filterable: rec['filterable'] === true,
      facetable: rec['facetable'] === true,
    })
  }

  // ---- Step 2: Find candidate parent field ----
  let candidateField: FieldMeta | undefined

  if (parentFieldOverride?.trim()) {
    // User override
    const meta = fieldMap.get(parentFieldOverride.trim().toLowerCase())
    if (meta) candidateField = meta
  }

  if (!candidateField) {
    // Heuristic scan: first matching field name in our priority list
    for (const heur of PARENT_FIELD_HEURISTICS) {
      const meta = fieldMap.get(heur.toLowerCase())
      if (meta && meta.name !== keyField && isStringLike(meta.type)) {
        candidateField = meta
        break
      }
    }
  }

  if (!candidateField) {
    // No parent field candidate → independent
    // Still get doc count for sampling
    const countResult = await getDocumentCount({ profile, indexName, apiVersion, language, signal })
    return {
      type: 'independent',
      documentCount: countResult,
      reason: 'No parent/source field detected in index schema',
    }
  }

  // ---- Step 3: Facet probe to confirm chunked structure ----
  if (signal?.aborted) throw new Error('aborted')

  const facetField = candidateField.name
  // Use facets to count distinct parent values. top:0 avoids fetching documents.
  const facetBody: JsonValue = {
    search: '*',
    top: 0,
    count: true,
    facets: [`${facetField},count:0`],
    queryType: 'simple',
  }

  const facetResult = await searchDocuments({ profile, indexName, apiVersion, body: facetBody, language, signal })
  if (!facetResult.ok) {
    const countResult = await getDocumentCount({ profile, indexName, apiVersion, language, signal })
    return {
      type: 'unknown',
      parentField: facetField,
      documentCount: countResult,
      reason: `Facet query failed for field "${facetField}"`,
    }
  }

  const facetResponse = facetResult.response as Record<string, unknown> | null
  const docCount = typeof facetResponse?.['@odata.count'] === 'number'
    ? (facetResponse['@odata.count'] as number)
    : 0
  const facets = facetResponse?.['@search.facets'] as Record<string, unknown> | undefined
  const facetBuckets = facets && Array.isArray(facets[facetField]) ? (facets[facetField] as unknown[]) : []
  const parentCount = facetBuckets.length

  // Decision: if there are fewer distinct parents than docs, it's chunked
  if (parentCount > 0 && parentCount < docCount) {
    const ratio = docCount / parentCount
    return {
      type: 'chunked',
      parentField: facetField,
      parentCount,
      documentCount: docCount,
      reason: `Detected ${parentCount} distinct sources across ${docCount} documents (avg ${ratio.toFixed(1)} chunks/source) via field "${facetField}"`,
    }
  }

  // parentCount == docCount or 0 → independent
  return {
    type: parentCount === 0 ? 'unknown' : 'independent',
    parentField: facetField,
    parentCount: parentCount || undefined,
    documentCount: docCount,
    reason: parentCount === 0
      ? `Field "${facetField}" returned no facet values`
      : `Field "${facetField}" has ${parentCount} distinct values ≈ ${docCount} docs → independent`,
  }
}

/** Check if an Azure AI Search field type is string-like (supports facets). */
function isStringLike(type: string): boolean {
  const t = type.toLowerCase()
  return t === 'edm.string' || t === 'collection(edm.string)'
}

/** Quick total document count via search * top:0 count:true. */
async function getDocumentCount(params: {
  profile: ConnectionProfile
  indexName: string
  apiVersion: SearchApiVersion
  language?: Language
  signal?: AbortSignal
}): Promise<number> {
  const body: JsonValue = { search: '*', top: 0, count: true, queryType: 'simple' }
  const r = await searchDocuments({
    profile: params.profile,
    indexName: params.indexName,
    apiVersion: params.apiVersion,
    body,
    language: params.language,
    signal: params.signal,
  })
  if (!r.ok) return 0
  const resp = r.response as Record<string, unknown> | null
  return typeof resp?.['@odata.count'] === 'number' ? (resp['@odata.count'] as number) : 0
}

/* ------------------------------------------------------------------ */
/* Phase 0: Adaptive Sampling                                          */
/* ------------------------------------------------------------------ */

export interface AdaptiveSampleParams extends SampleDocsParams {
  indexStructure: IndexStructureInfo
}

/**
 * Adaptive document sampler that branches on detected index structure.
 *
 * - **Chunked**: Uses facet query to discover distinct source values, then
 *   randomly selects N sources and retrieves one representative chunk per source.
 *   This ensures diversity across source documents rather than flooding the
 *   sample with chunks from the same source.
 *
 * - **Independent**: Uses `count: true` to get total doc count, then samples
 *   at distributed skip offsets with random jitter. $skip is capped at 100,000
 *   per Azure AI Search limits. Falls back to first-page if total <= sampleSize.
 *
 * - **Unknown**: Falls back to the simple first-page sampler.
 */
export async function sampleDocsAdaptive(params: AdaptiveSampleParams): Promise<SampledDoc[]> {
  const { indexStructure, ...baseParams } = params

  switch (indexStructure.type) {
    case 'chunked':
      return sampleFromChunkedIndex(baseParams, indexStructure)
    case 'independent':
      return sampleFromIndependentIndex(baseParams, indexStructure)
    default:
      return sampleDocsFromIndex(baseParams)
  }
}

/**
 * Chunked index sampling: facet → random source selection → one chunk per source.
 *
 * 1. Facet query on parentField with count:500 to get up to 500 source values.
 * 2. Randomly pick `sampleSize` sources from the facet buckets.
 * 3. For each selected source, fetch 1 chunk (the longest one, to get the
 *    most informative content) via `filter: parentField eq 'value'`.
 * 4. Attach `parentId` and `siblingIds` to each SampledDoc.
 */
async function sampleFromChunkedIndex(
  params: SampleDocsParams,
  structure: IndexStructureInfo,
): Promise<SampledDoc[]> {
  const { profile, indexName, apiVersion, keyField, contentFields, sampleSize, language, signal } = params
  const parentField = structure.parentField!
  const select = [keyField, parentField, ...contentFields].join(',')

  // 1. Facet query: get source values with document counts
  const facetBody: JsonValue = {
    search: '*',
    top: 0,
    count: true,
    facets: [`${parentField},count:500`],
    queryType: 'simple',
  }

  const facetResult = await searchDocuments({ profile, indexName, apiVersion, body: facetBody, language, signal })
  if (!facetResult.ok) {
    // Fallback to simple sampling
    return sampleDocsFromIndex(params)
  }

  const facetResponse = facetResult.response as Record<string, unknown> | null
  const facets = facetResponse?.['@search.facets'] as Record<string, unknown> | undefined
  const buckets = facets && Array.isArray(facets[parentField]) ? (facets[parentField] as unknown[]) : []

  if (buckets.length === 0) {
    return sampleDocsFromIndex(params)
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
    return sampleDocsFromIndex(params)
  }

  // 2. Randomly select sources
  const shuffled = shuffleArray(sourceValues)
  const selectedSources = shuffled.slice(0, Math.min(sampleSize, shuffled.length))

  // 3. Fetch one representative chunk per source (parallel with concurrency limit)
  const docs: SampledDoc[] = []
  const CHUNK_CONCURRENCY = 5

  let cursor = 0
  const worker = async () => {
    while (cursor < selectedSources.length) {
      if (signal?.aborted) return
      const idx = cursor++
      if (idx >= selectedSources.length) return
      const sourceVal = selectedSources[idx]

      // Fetch all chunks for this source to find the longest and collect sibling IDs
      const filterExpr = `${parentField} eq '${escapeODataString(sourceVal)}'`
      const body: JsonValue = {
        search: '*',
        filter: filterExpr,
        top: 50, // reasonable cap for chunks per source
        select,
        queryType: 'simple',
      }

      try {
        const result = await searchDocuments({ profile, indexName, apiVersion, body, language, signal })
        if (!result.ok) continue
        const response = result.response as Record<string, unknown> | null
        const value = response && Array.isArray(response['value']) ? (response['value'] as unknown[]) : []
        if (value.length === 0) continue

        // Parse all chunks
        const chunks: { id: string; text: string; parentId: string }[] = []
        for (const raw of value) {
          if (!raw || typeof raw !== 'object') continue
          const obj = raw as Record<string, unknown>
          const id = pickString(obj, keyField).trim()
          if (!id) continue
          const textParts = contentFields.map((f) => pickString(obj, f).trim()).filter((s) => s.length > 0)
          const text = textParts.join('\n\n')
          if (!text) continue
          chunks.push({ id, text, parentId: sourceVal })
        }

        if (chunks.length === 0) continue

        // Pick the longest chunk as representative
        chunks.sort((a, b) => b.text.length - a.text.length)
        const best = chunks[0]
        const siblingIds = chunks.map((c) => c.id).filter((sid) => sid !== best.id)

        docs.push({
          id: best.id,
          text: best.text,
          parentId: best.parentId,
          siblingIds: siblingIds.length > 0 ? siblingIds : undefined,
        })
      } catch {
        // Skip this source on error
      }
    }
  }

  const workers: Promise<void>[] = []
  const w = Math.min(CHUNK_CONCURRENCY, selectedSources.length)
  for (let i = 0; i < w; i++) workers.push(worker())
  await Promise.all(workers)

  return docs
}

/**
 * Independent index sampling: distributed skip with random jitter.
 *
 * Uses $skip to spread samples across the index rather than always taking the
 * first N documents. $skip is capped at 100,000 per Azure AI Search limits.
 */
async function sampleFromIndependentIndex(
  params: SampleDocsParams,
  structure: IndexStructureInfo,
): Promise<SampledDoc[]> {
  const { profile, indexName, apiVersion, keyField, contentFields, sampleSize, language, signal } = params
  const total = structure.documentCount
  const select = [keyField, ...contentFields].join(',')
  const wanted = Math.max(1, Math.min(1000, Math.floor(sampleSize)))

  // If total docs <= sample size, just fetch all (simple approach)
  if (total <= wanted || total === 0) {
    return sampleDocsFromIndex(params)
  }

  // Calculate skip offsets, spreading evenly with random jitter
  // $skip max is 100,000
  const maxSkip = Math.min(total, 100_000)
  const stride = Math.floor(maxSkip / wanted)

  if (stride <= 1) {
    // Not enough room to spread; fall back to simple
    return sampleDocsFromIndex(params)
  }

  const docs: SampledDoc[] = []
  const SKIP_CONCURRENCY = 5
  const offsets: number[] = []
  for (let i = 0; i < wanted; i++) {
    const base = i * stride
    const jitter = Math.floor(Math.random() * Math.min(stride, 10))
    offsets.push(Math.min(base + jitter, maxSkip - 1))
  }

  let cursor = 0
  const worker = async () => {
    while (cursor < offsets.length) {
      if (signal?.aborted) return
      const idx = cursor++
      if (idx >= offsets.length) return
      const skip = offsets[idx]

      const body: JsonValue = {
        search: '*',
        top: 1,
        skip,
        select,
        queryType: 'simple',
      }

      try {
        const result = await searchDocuments({ profile, indexName, apiVersion, body, language, signal })
        if (!result.ok) continue
        const response = result.response as Record<string, unknown> | null
        const value = response && Array.isArray(response['value']) ? (response['value'] as unknown[]) : []
        if (value.length === 0) continue

        const raw = value[0]
        if (!raw || typeof raw !== 'object') continue
        const obj = raw as Record<string, unknown>
        const id = pickString(obj, keyField).trim()
        if (!id) continue
        // Deduplicate: skip if already sampled
        if (docs.some((d) => d.id === id)) continue
        const textParts = contentFields.map((f) => pickString(obj, f).trim()).filter((s) => s.length > 0)
        const text = textParts.join('\n\n')
        if (!text) continue
        docs.push({ id, text })
      } catch {
        // Skip this offset on error
      }
    }
  }

  const workers: Promise<void>[] = []
  const w = Math.min(SKIP_CONCURRENCY, offsets.length)
  for (let i = 0; i < w; i++) workers.push(worker())
  await Promise.all(workers)

  return docs
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

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
