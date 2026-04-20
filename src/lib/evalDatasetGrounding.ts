/**
 * Round-trip consistency filter for the Eval Dataset Generator (Phase 2.1).
 *
 * Background (Promptagator, Dai et al., ICLR 2023):
 *   A generated query is only useful for evaluation if running it through
 *   the *actual* search index returns the source document among the top-k.
 *   Items that fail this check would inflate apparent retrieval quality
 *   ("self-fulfilling" evaluation), so we mark them as `rejected: true`
 *   with `rejection_reason: 'grounding'` and exclude them from JSONL export.
 *
 * The check uses a simple keyword search (queryType=simple, search=<query>)
 * to keep behaviour stable across the user's index settings. Results are
 * mapped back to the source document ID via the user-supplied `keyField`.
 */

import { searchDocuments } from './aiSearchRest'
import type { JsonValue } from './aiSearchRest'
import type { ConnectionProfile, SearchApiVersion } from './model'
import type { Language } from './translations'

export interface GroundingCheckParams {
  profile: ConnectionProfile
  indexName: string
  apiVersion: SearchApiVersion
  keyField: string
  query: string
  expectedDocId: string
  topK: number
  language?: Language
  signal?: AbortSignal
}

export interface GroundingCheckResult {
  /** 1-based rank of the source doc in the result page. 0 = not found within top-k. */
  rank: number
  /** Whether the source doc was retrieved within top-k. */
  found: boolean
}

/** Pull a string-coerced value out of a flat object regardless of underlying type. */
function pickIdString(obj: Record<string, unknown>, field: string): string {
  const v = obj[field]
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

/**
 * Run a single round-trip consistency check.
 *
 * Returns `{ rank, found }`. Errors propagate so the caller can surface them.
 */
export async function checkGrounding(params: GroundingCheckParams): Promise<GroundingCheckResult> {
  const { profile, indexName, apiVersion, keyField, query, expectedDocId, topK, language, signal } =
    params

  if (signal?.aborted) throw new Error('aborted')
  if (!query.trim()) return { rank: 0, found: false }
  if (!expectedDocId.trim()) return { rank: 0, found: false }

  const k = Math.max(1, Math.min(50, Math.floor(topK)))
  const body: JsonValue = {
    search: query,
    top: k,
    select: keyField,
    queryType: 'simple',
  }

  const result = await searchDocuments({ profile, indexName, apiVersion, body, language, signal })
  if (!result.ok) {
    throw new Error(result.error?.message ?? 'searchDocuments failed')
  }

  const response = result.response as Record<string, unknown> | null
  const value = response && Array.isArray(response['value']) ? (response['value'] as unknown[]) : []

  for (let i = 0; i < value.length; i++) {
    const raw = value[i]
    if (!raw || typeof raw !== 'object') continue
    const id = pickIdString(raw as Record<string, unknown>, keyField).trim()
    if (id === expectedDocId.trim()) {
      return { rank: i + 1, found: true }
    }
  }
  return { rank: 0, found: false }
}

/* ------------------------------------------------------------------ */
/* Phase 4: Hard Negative mining                                      */
/* ------------------------------------------------------------------ */

export interface MineHardNegativesParams {
  profile: ConnectionProfile
  indexName: string
  apiVersion: SearchApiVersion
  keyField: string
  query: string
  /** Doc IDs that ARE the correct answer; will be excluded from the result. */
  expectedIds: string[]
  /** Top-k retrieved from the index. Larger = more candidate negatives. */
  topK: number
  /** Maximum number of hard negatives to return (after filtering expected). */
  maxNegatives: number
  language: Language
  signal?: AbortSignal
}

/**
 * Run a top-k search for `query` and return doc ids that appear in results
 * but are NOT in `expectedIds` ("hard negatives" in the DPR sense). Results
 * preserve search order (closest first) and are capped at `maxNegatives`.
 */
export async function mineHardNegatives(
  params: MineHardNegativesParams,
): Promise<string[]> {
  const {
    profile,
    indexName,
    apiVersion,
    keyField,
    query,
    expectedIds,
    topK,
    maxNegatives,
    language,
    signal,
  } = params

  if (signal?.aborted) throw new Error('aborted')
  if (!query.trim()) return []

  const k = Math.max(1, Math.min(50, Math.floor(topK)))
  const cap = Math.max(0, Math.floor(maxNegatives))
  if (cap === 0) return []

  const expectedSet = new Set(expectedIds.map((s) => s.trim()).filter(Boolean))

  const body: JsonValue = {
    search: query,
    top: k,
    select: keyField,
    queryType: 'simple',
  }
  const result = await searchDocuments({ profile, indexName, apiVersion, body, language, signal })
  if (!result.ok) {
    throw new Error(result.error?.message ?? 'searchDocuments failed')
  }
  const response = result.response as Record<string, unknown> | null
  const value = response && Array.isArray(response['value']) ? (response['value'] as unknown[]) : []

  const out: string[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const id = pickIdString(raw as Record<string, unknown>, keyField).trim()
    if (!id) continue
    if (expectedSet.has(id)) continue
    if (out.includes(id)) continue
    out.push(id)
    if (out.length >= cap) break
  }
  return out
}
