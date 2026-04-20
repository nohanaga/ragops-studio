/**
 * Document sampling for the Eval Dataset Generator (EDAG, Phase 1 MVP).
 *
 * Pulls documents from an Azure AI Search index using `searchDocuments`
 * (search="*"), keeping only the configured key + content fields.
 */

import { searchDocuments } from './aiSearchRest'
import type { JsonValue } from './aiSearchRest'
import type { ConnectionProfile, SearchApiVersion } from './model'
import type { Language } from './translations'

export interface SampledDoc {
  id: string
  text: string
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

  const result = await searchDocuments({ profile, indexName, apiVersion, body, language })
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
