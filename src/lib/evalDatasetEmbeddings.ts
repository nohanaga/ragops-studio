/**
 * Azure OpenAI embeddings + cosine-based semantic dedup
 * for the Eval Dataset Generator (Phase 2.2).
 *
 * Surface (Jaccard) dedup is too lenient for paraphrases — semantic dedup
 * collapses near-duplicate queries that differ only in wording, keeping
 * the evaluation set diverse.
 */

import type { LlmAuth } from './llmAuth'
import { buildLlmAuthHeaders } from './llmAuth'

export interface EmbedParams {
  endpoint: string
  auth: LlmAuth
  deployment: string
  apiVersion: string
  inputs: string[]
  signal?: AbortSignal
}

interface AoaiEmbeddingsResponse {
  data?: Array<{ embedding?: number[]; index?: number }>
}

const EMBED_BATCH_SIZE = 16

/**
 * Compute embeddings for an array of strings in batches.
 * Returns vectors in the same order as `inputs`.
 */
export async function embedTexts(params: EmbedParams): Promise<number[][]> {
  const { endpoint, auth, deployment, apiVersion, inputs, signal } = params
  if (!endpoint.trim()) throw new Error('Embedding endpoint is required')
  if (!deployment.trim()) throw new Error('Embedding deployment is required')
  if (!apiVersion.trim()) throw new Error('Embedding apiVersion is required')

  if (inputs.length === 0) return []

  const base = endpoint.replace(/\/+$/, '')
  const url = `${base}/openai/deployments/${encodeURIComponent(deployment)}/embeddings?api-version=${encodeURIComponent(apiVersion)}`

  const out: number[][] = new Array(inputs.length)
  for (let start = 0; start < inputs.length; start += EMBED_BATCH_SIZE) {
    if (signal?.aborted) throw new Error('aborted')
    const batch = inputs.slice(start, start + EMBED_BATCH_SIZE)
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildLlmAuthHeaders(auth),
      },
      signal,
      body: JSON.stringify({ input: batch }),
    })
    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      throw new Error(`Azure OpenAI embeddings failed (${res.status}): ${errorText.slice(0, 300)}`)
    }
    const data = (await res.json()) as AoaiEmbeddingsResponse
    const arr = Array.isArray(data?.data) ? data.data : []
    for (let i = 0; i < batch.length; i++) {
      const e = arr.find((x) => x?.index === i) ?? arr[i]
      const v = Array.isArray(e?.embedding) ? (e!.embedding as number[]) : []
      out[start + i] = v
    }
  }
  return out
}

/** Cosine similarity. Returns 0 when either vector is empty or zero-norm. */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Greedy semantic dedup: keep the first occurrence; mark later items whose
 * cosine similarity with any kept vector is >= threshold as duplicates.
 *
 * Returns the indices of items that should be dropped (or marked as rejected).
 */
export function findSemanticDuplicates(vectors: number[][], threshold: number): Set<number> {
  const t = Math.max(0, Math.min(1, threshold))
  const dropped = new Set<number>()
  const keptIdx: number[] = []
  for (let i = 0; i < vectors.length; i++) {
    const v = vectors[i]
    let dup = false
    for (const k of keptIdx) {
      if (cosine(v, vectors[k]) >= t) {
        dup = true
        break
      }
    }
    if (dup) dropped.add(i)
    else keptIdx.push(i)
  }
  return dropped
}
