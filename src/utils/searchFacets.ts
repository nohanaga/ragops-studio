/**
 * Facet extraction utilities.
 *
 * Normalizes `@search.facets` responses into a predictable shape for UI rendering.
 */

import type { JsonValue } from '../lib/aiSearchRest'

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function extractSearchFacets(body: JsonValue): Record<string, unknown[]> | null {
  if (!isRecord(body)) return null
  const facets = (body as Record<string, unknown>)['@search.facets']
  if (!isRecord(facets)) return null

  const out: Record<string, unknown[]> = {}
  for (const [k, v] of Object.entries(facets)) {
    out[k] = Array.isArray(v) ? v : []
  }
  return out
}
