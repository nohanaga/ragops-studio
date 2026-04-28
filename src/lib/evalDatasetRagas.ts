/**
 * Ragas-style scenario sampling for the Eval Dataset Generator (Phase 3).
 *
 * Ragas (vibrantlabsai/ragas) generates a test set by drawing scenarios
 * from a (Single-hop / Multi-hop) × (Specific / Abstract) grid, optionally
 * crossed with Persona × Style × Length. We approximate that here without
 * requiring a full knowledge graph:
 *
 *   - 4-quadrant `QueryShape` distribution is supplied by the user.
 *   - Multi-hop "pairs" are obtained via surface (token Jaccard) similarity
 *     between sampled docs, which is cheap, deterministic, and reasonable
 *     for short technical chunks. A real KG can replace this in v0.5.
 *   - Persona / Style / Length are simply cycled through user-supplied lists.
 */

import type {
  EvalLength,
  EvalStyle,
  GeneratedQAItem,
  QueryShape,
} from '../types'
import type { SampledDoc } from './evalDatasetSampling'

/** Ordered enumeration so distribution input is always projected the same way. */
export const QUERY_SHAPES: QueryShape[] = [
  'single_specific',
  'single_abstract',
  'multi_specific',
  'multi_abstract',
]

/** Default distribution mirrors Ragas' default mix for RAG eval. */
export const DEFAULT_QUERY_DISTRIBUTION: Record<QueryShape, number> = {
  single_specific: 0.5,
  single_abstract: 0.2,
  multi_specific: 0.2,
  multi_abstract: 0.1,
}

export interface ScenarioSlot {
  shape: QueryShape
  persona?: string
  style?: EvalStyle
  length?: EvalLength
  /** Document(s) the LLM should ground the query in. */
  docs: SampledDoc[]
}

export interface PlanScenarioParams {
  docs: SampledDoc[]
  totalQueries: number
  distribution?: Partial<Record<QueryShape, number>>
  personas?: string[]
  styles?: EvalStyle[]
  lengths?: EvalLength[]
  multiHopPairingThreshold?: number
  /**
   * Phase 6 (Entity-KG): optional map of `doc_id` -> normalized entity set.
   * When provided, multi-hop pairing uses entity-Jaccard instead of token
   * Jaccard, giving a closer approximation to a true KG. If extraction was
   * skipped or failed for some docs, those docs fall back to token Jaccard.
   */
  entitySetsById?: Record<string, Set<string>>
}

/* -------------------------------------------------------------------- */
/* Distribution helpers                                                 */
/* -------------------------------------------------------------------- */

/**
 * Project an arbitrary partial distribution onto a normalised vector
 * over `QUERY_SHAPES`. Missing/<=0 keys are dropped; if everything is
 * zero, the default Ragas distribution is used.
 */
export function normaliseDistribution(
  d: Partial<Record<QueryShape, number>> | undefined,
): Record<QueryShape, number> {
  const raw: Record<QueryShape, number> = {
    single_specific: 0,
    single_abstract: 0,
    multi_specific: 0,
    multi_abstract: 0,
  }
  let sum = 0
  for (const k of QUERY_SHAPES) {
    const v = d?.[k]
    if (typeof v === 'number' && v > 0) {
      raw[k] = v
      sum += v
    }
  }
  if (sum <= 0) return { ...DEFAULT_QUERY_DISTRIBUTION }
  for (const k of QUERY_SHAPES) raw[k] = raw[k] / sum
  return raw
}

/**
 * Convert a normalised distribution into an integer count vector that
 * sums exactly to `totalQueries`. Uses the largest-remainder method so
 * tiny weights don't get rounded entirely to zero when `totalQueries`
 * is small.
 */
export function distributionToCounts(
  distribution: Record<QueryShape, number>,
  totalQueries: number,
): Record<QueryShape, number> {
  const total = Math.max(0, Math.floor(totalQueries))
  const provisional = QUERY_SHAPES.map((s) => ({
    shape: s,
    exact: distribution[s] * total,
  }))
  const floors = provisional.map((p) => ({
    shape: p.shape,
    floor: Math.floor(p.exact),
    rem: p.exact - Math.floor(p.exact),
  }))
  let assigned = floors.reduce((acc, p) => acc + p.floor, 0)
  // Assign remainder by largest-remainder.
  floors.sort((a, b) => b.rem - a.rem)
  let i = 0
  while (assigned < total && floors.length > 0) {
    floors[i % floors.length].floor += 1
    assigned += 1
    i += 1
  }
  const out: Record<QueryShape, number> = {
    single_specific: 0,
    single_abstract: 0,
    multi_specific: 0,
    multi_abstract: 0,
  }
  for (const f of floors) out[f.shape] = f.floor
  return out
}

/* -------------------------------------------------------------------- */
/* Multi-hop pairing                                                    */
/* -------------------------------------------------------------------- */

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize('NFKC')
      .split(/[\s\p{P}\p{S}]+/u)
      .filter((t) => t.length >= 2),
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

export interface DocPair {
  a: SampledDoc
  b: SampledDoc
  similarity: number
}

/**
 * Check whether two docs share the same parent/source (for chunked indexes).
 * If neither doc has a parentId, they are considered from different sources.
 */
function isSameSource(a: SampledDoc, b: SampledDoc): boolean {
  if (!a.parentId || !b.parentId) return false
  return a.parentId === b.parentId
}

/**
 * Find candidate doc pairs whose surface (token Jaccard) similarity is
 * above `threshold`. Returns pairs sorted by descending similarity.
 *
 * For multi-hop generation we want pairs that share *some* vocabulary
 * (so the LLM has a hope of formulating a question that requires both)
 * but are not literally duplicates.
 *
 * When docs carry `parentId` (chunked index), pairs from the same source
 * are automatically excluded to prevent fake cross-document questions.
 */
export function findDocPairs(docs: SampledDoc[], threshold: number): DocPair[] {
  const t = Math.max(0, Math.min(1, threshold))
  const tokSets = docs.map((d) => tokens(d.text))
  const pairs: DocPair[] = []
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      // Skip same-source pairs for chunked indexes
      if (isSameSource(docs[i], docs[j])) continue
      const sim = jaccard(tokSets[i], tokSets[j])
      if (sim >= t && sim < 0.95) {
        pairs.push({ a: docs[i], b: docs[j], similarity: sim })
      }
    }
  }
  pairs.sort((a, b) => b.similarity - a.similarity)
  return pairs
}

/**
 * Phase 6 (Entity-KG variant): pair docs whose **entity sets** overlap.
 *
 * `entitySetsById` should map a doc id to a normalized set of entities
 * (lowercased, NFKC-normalized). When a doc id is missing or its entity
 * set is empty, that doc transparently falls back to its token-Jaccard
 * representation, so the function degrades gracefully when extraction
 * partially fails. Returns pairs sorted by descending similarity.
 */
export function findDocPairsByEntities(
  docs: SampledDoc[],
  entitySetsById: Record<string, Set<string>>,
  threshold: number,
): DocPair[] {
  const t = Math.max(0, Math.min(1, threshold))
  const sets = docs.map((d) => {
    const e = entitySetsById[d.id]
    if (e && e.size > 0) return e
    return tokens(d.text)
  })
  const pairs: DocPair[] = []
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      // Skip same-source pairs for chunked indexes
      if (isSameSource(docs[i], docs[j])) continue
      const sim = jaccard(sets[i], sets[j])
      if (sim >= t && sim < 0.95) {
        pairs.push({ a: docs[i], b: docs[j], similarity: sim })
      }
    }
  }
  pairs.sort((a, b) => b.similarity - a.similarity)
  return pairs
}

/* -------------------------------------------------------------------- */
/* Scenario planning                                                    */
/* -------------------------------------------------------------------- */

/** Cycle through `xs` with index `i`, returning undefined for empty arrays. */
function pick<T>(xs: T[] | undefined, i: number): T | undefined {
  if (!xs || xs.length === 0) return undefined
  return xs[i % xs.length]
}

/**
 * Build a list of generation slots that, taken together, realise the
 * requested distribution over the 4 quadrants. Each slot carries the
 * docs the LLM should consult plus optional persona/style/length.
 *
 * Single-hop slots cycle through `docs` in order.
 * Multi-hop slots use pre-computed similar pairs; if no pair meets the
 * threshold, the slot falls back to a random adjacent pair so the user
 * still gets *some* multi-hop output.
 */
export function planScenarios(params: PlanScenarioParams): ScenarioSlot[] {
  const {
    docs,
    totalQueries,
    distribution,
    personas,
    styles,
    lengths,
    multiHopPairingThreshold = 0.1,
    entitySetsById,
  } = params

  if (docs.length === 0 || totalQueries <= 0) return []

  const norm = normaliseDistribution(distribution)
  const counts = distributionToCounts(norm, totalQueries)

  const slots: ScenarioSlot[] = []
  let cursor = 0

  // Single-hop slots
  for (const shape of ['single_specific', 'single_abstract'] as QueryShape[]) {
    for (let k = 0; k < counts[shape]; k++) {
      const doc = docs[cursor % docs.length]
      cursor++
      slots.push({
        shape,
        persona: pick(personas, slots.length),
        style: pick(styles, slots.length),
        length: pick(lengths, slots.length),
        docs: [doc],
      })
    }
  }

  // Multi-hop slots
  const multiCount = counts['multi_specific'] + counts['multi_abstract']
  if (multiCount > 0) {
    const pairs =
      entitySetsById && Object.keys(entitySetsById).length > 0
        ? findDocPairsByEntities(docs, entitySetsById, multiHopPairingThreshold)
        : findDocPairs(docs, multiHopPairingThreshold)
    let pairCursor = 0
    const nextPair = (): SampledDoc[] => {
      if (pairs.length > 0) {
        const p = pairs[pairCursor % pairs.length]
        pairCursor++
        return [p.a, p.b]
      }
      // Fallback: pick two distinct adjacent docs.
      if (docs.length < 2) return [docs[0]]
      const a = docs[pairCursor % docs.length]
      const b = docs[(pairCursor + 1) % docs.length]
      pairCursor++
      return a.id === b.id ? [a] : [a, b]
    }
    for (const shape of ['multi_specific', 'multi_abstract'] as QueryShape[]) {
      for (let k = 0; k < counts[shape]; k++) {
        slots.push({
          shape,
          persona: pick(personas, slots.length),
          style: pick(styles, slots.length),
          length: pick(lengths, slots.length),
          docs: nextPair(),
        })
      }
    }
  }

  return slots
}

/**
 * Stamp a generated item with scenario metadata. Convenience helper used
 * by the hook to attach Ragas fields after the LLM call.
 */
export function applyScenarioMetadata(
  item: GeneratedQAItem,
  slot: ScenarioSlot,
): GeneratedQAItem {
  return {
    ...item,
    expected_ids: slot.docs.map((d) => d.id),
    query_shape: slot.shape,
    persona: slot.persona,
    style: slot.style,
    length: slot.length,
  }
}
