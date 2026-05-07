/**
 * LLM embeddings + cosine-based semantic dedup
 * for the Eval Dataset Generator (Phase 2.2).
 *
 * Surface (Jaccard) dedup is too lenient for paraphrases — semantic dedup
 * collapses near-duplicate queries that differ only in wording, keeping
 * the evaluation set diverse.
 */

import type { LlmAuth } from './llmAuth'
import { callLlmEmbeddings, type LlmProviderType } from './llmProvider'

export interface EmbedParams {
  endpoint: string
  auth: LlmAuth
  deployment: string
  apiVersion: string
  inputs: string[]
  signal?: AbortSignal
  /** LLM provider type. Defaults to 'azure-openai' for backward compat. */
  provider?: LlmProviderType
}

/**
 * Compute embeddings for an array of strings in batches.
 * Returns vectors in the same order as `inputs`.
 */
export async function embedTexts(params: EmbedParams): Promise<number[][]> {
  const { endpoint, auth, deployment, apiVersion, inputs, signal, provider = 'azure-openai' } = params
  return callLlmEmbeddings({
    config: { provider, endpoint, auth, model: deployment, apiVersion },
    inputs,
    signal,
  })
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
