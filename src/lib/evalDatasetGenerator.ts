/**
 * Core LLM-driven query generation for the Eval Dataset Generator (EDAG, Phase 1 MVP).
 *
 * - Calls Azure OpenAI Chat Completions in JSON mode.
 * - Truncates excerpts to a safe character budget (LLM context guard).
 * - Parses the strict `{ queries: [...] }` response shape.
 * - Provides a simple Jaccard-based dedup utility (surface dedup only in MVP).
 */

import type { GeneratedQAItem, EvalQueryType } from '../types'
import type { SampledDoc } from './evalDatasetSampling'
import type { BuildPromptParams, ExpectedQueryObject } from './evalDatasetPrompts'
import { buildSystemPrompt, buildUserPrompt } from './evalDatasetPrompts'
import type { LlmAuth } from './llmAuth'
import { callLlmChat, extractJsonFromText, type LlmProviderType, type JsonSchemaResponseFormat } from './llmProvider'

/** Hard cap for the per-doc excerpt fed to the LLM (chars, not tokens). */
const MAX_CHUNK_CHARS = 4000

const KNOWN_QUERY_TYPES: EvalQueryType[] = ['factoid', 'how-to', 'comparative', 'yes-no']

// ─── JSON Schemas for Structured Output ─────────────────────────────────────

/** Schema for `{ queries: [{ query, query_type }] }` — multi-query generation. */
const QUERIES_SCHEMA: JsonSchemaResponseFormat = {
  name: 'generated_queries',
  schema: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            query_type: { type: 'string' },
          },
          required: ['query', 'query_type'],
          additionalProperties: false,
        },
      },
    },
    required: ['queries'],
    additionalProperties: false,
  },
}

/** Schema for `{ query: "..." }` — single query (scenario / harden). */
const SINGLE_QUERY_SCHEMA: JsonSchemaResponseFormat = {
  name: 'single_query',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

/** Schema for `{ cot_answer: "..." }` — RAFT chain-of-thought answer. */
const COT_ANSWER_SCHEMA: JsonSchemaResponseFormat = {
  name: 'cot_answer',
  schema: {
    type: 'object',
    properties: {
      cot_answer: { type: 'string' },
    },
    required: ['cot_answer'],
    additionalProperties: false,
  },
}

/** Schema for `{ hypothesis: "..." }` — HyDE hypothetical document. */
const HYPOTHESIS_SCHEMA: JsonSchemaResponseFormat = {
  name: 'hypothesis',
  schema: {
    type: 'object',
    properties: {
      hypothesis: { type: 'string' },
    },
    required: ['hypothesis'],
    additionalProperties: false,
  },
}

export interface CallAoaiParams {
  endpoint: string
  auth: LlmAuth
  deployment: string
  apiVersion: string
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
  /** When false, omit `response_format: json_object`. Defaults to true. */
  jsonMode?: boolean
  /** When supplied, use structured output with JSON Schema. */
  jsonSchema?: JsonSchemaResponseFormat
  /** LLM provider type. Defaults to 'azure-openai' for backward compat. */
  provider?: LlmProviderType
}

export interface AoaiChatResponse {
  choices?: Array<{ message?: { content?: string } }>
}

/**
 * Call LLM Chat Completions (multi-provider).
 *
 * Delegates to the unified `callLlmChat()` from `llmProvider.ts`.
 * Retained as a stable entry-point for existing callers.
 */
export async function callAzureOpenAIChat(params: CallAoaiParams): Promise<string> {
  const { endpoint, auth, deployment, apiVersion, systemPrompt, userPrompt, signal, jsonMode = true, jsonSchema, provider = 'azure-openai' } = params
  return callLlmChat({
    config: { provider, endpoint, auth, model: deployment, apiVersion },
    systemPrompt,
    userPrompt,
    signal,
    jsonMode,
    jsonSchema,
  })
}

/**
 * Strict parser for the `{ queries: [...] }` shape produced by the LLM.
 * Drops malformed entries silently (they do not abort the pipeline).
 *
 * When `allowedTypes` is provided, items whose `query_type` is not in the
 * allowed set are coerced to the first allowed type (so the user-selected
 * filter is respected even when the model ignores it).
 * When omitted, unknown types silently fall back to `factoid` for backward
 * compatibility.
 */
export function parseGeneratedQueries(
  rawJson: string,
  allowedTypes?: EvalQueryType[],
): ExpectedQueryObject[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonFromText(rawJson))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const queries = (parsed as Record<string, unknown>)['queries']
  if (!Array.isArray(queries)) return []

  const allowList: EvalQueryType[] = allowedTypes && allowedTypes.length > 0 ? allowedTypes : KNOWN_QUERY_TYPES
  const allowSet = new Set<string>(allowList)
  const fallbackType: EvalQueryType =
    allowedTypes && allowedTypes.length > 0 ? allowedTypes[0] : 'factoid'

  const out: ExpectedQueryObject[] = []
  for (const raw of queries) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    const q = obj['query']
    const t = obj['query_type']
    if (typeof q !== 'string') continue
    const trimmed = q.trim()
    if (!trimmed) continue
    const queryType: EvalQueryType =
      typeof t === 'string' && allowSet.has(t) ? (t as EvalQueryType) : fallbackType
    out.push({ query: trimmed, query_type: queryType })
  }
  return out
}

export interface GenerateForDocParams {
  doc: SampledDoc
  prompt: Omit<BuildPromptParams, 'docId' | 'chunkText'>
  llm: Omit<CallAoaiParams, 'systemPrompt' | 'userPrompt' | 'signal'>
  signal?: AbortSignal
  /** Phase 2.0: provenance metadata propagated to every generated item. */
  provenance?: {
    indexName?: string
    runId?: string
    generatedAt?: string
  }
}

/**
 * Generate query items for a single sampled document.
 * The expected_ids is set to `[doc.id]` since the excerpt itself is the source.
 */
export async function generateForDoc(params: GenerateForDocParams): Promise<GeneratedQAItem[]> {
  const { doc, prompt, llm, signal, provenance } = params
  const chunkText = doc.text.length > MAX_CHUNK_CHARS ? doc.text.slice(0, MAX_CHUNK_CHARS) : doc.text

  const systemPrompt = buildSystemPrompt(prompt.language, prompt.domainDescription)
  const userPrompt = buildUserPrompt({
    ...prompt,
    docId: doc.id,
    chunkText,
  })

  const raw = await callAzureOpenAIChat({ ...llm, systemPrompt, userPrompt, signal, jsonSchema: QUERIES_SCHEMA })
  const parsed = parseGeneratedQueries(raw, prompt.queryTypes)
  const generatedAt = provenance?.generatedAt ?? new Date().toISOString()
  return parsed.map((q) => ({
    query: q.query,
    expected_ids: [doc.id],
    query_type: q.query_type,
    source_doc_id: doc.id,
    generation_model: llm.deployment,
    language: prompt.language,
    // Phase 2.0 provenance.
    provenance: 'synthetic',
    generated_at: generatedAt,
    generated_against_index: provenance?.indexName,
    generation_run_id: provenance?.runId,
  }))
}

/* ------------------------------------------------------------------ */
/* Ragas-style scenario generation (Phase 3)                          */
/* ------------------------------------------------------------------ */

import type { ScenarioSlot } from './evalDatasetRagas'
import { applyScenarioMetadata } from './evalDatasetRagas'
import {
  buildScenarioSystemPrompt,
  buildScenarioUserPrompt,
} from './evalDatasetPrompts'
import type { EvalLanguage } from '../types'

export interface GenerateForScenarioParams {
  slot: ScenarioSlot
  language: EvalLanguage
  domainDescription?: string
  /** Phase 4: optional RAGEval-style schema. */
  domainSchema?: import('../types').DomainSchema
  llm: Omit<CallAoaiParams, 'systemPrompt' | 'userPrompt' | 'signal'>
  signal?: AbortSignal
  provenance?: {
    indexName?: string
    runId?: string
    generatedAt?: string
  }
}

/** Lightweight parser for the single-query Ragas response shape. */
export function parseScenarioQuery(rawJson: string): { query: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonFromText(rawJson))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  // Accept both `{ query: ... }` and `{ queries: [{ query: ... }] }`.
  const direct = obj['query']
  if (typeof direct === 'string' && direct.trim()) return { query: direct.trim() }
  const queries = obj['queries']
  if (Array.isArray(queries) && queries.length > 0) {
    const first = queries[0] as Record<string, unknown> | null
    const q = first && typeof first === 'object' ? first['query'] : null
    if (typeof q === 'string' && q.trim()) return { query: q.trim() }
  }
  return null
}

/**
 * Generate one query for a Ragas scenario slot.
 * Truncates each excerpt to keep the combined prompt within budget.
 */
export async function generateForScenario(
  params: GenerateForScenarioParams,
): Promise<GeneratedQAItem | null> {
  const { slot, language, domainDescription, domainSchema, llm, signal, provenance } = params
  if (slot.docs.length === 0) return null

  // Per-excerpt budget: split the chunk-char cap across excerpts so multi-hop
  // doesn't blow up context length.
  const perDocBudget = Math.max(
    300,
    Math.floor(MAX_CHUNK_CHARS / Math.max(1, slot.docs.length)),
  )
  const trimmed = slot.docs.map((d) => ({
    id: d.id,
    text: d.text.length > perDocBudget ? d.text.slice(0, perDocBudget) : d.text,
  }))

  const systemPrompt = buildScenarioSystemPrompt(language, domainDescription)
  const userPrompt = buildScenarioUserPrompt({
    language,
    docs: trimmed,
    shape: slot.shape,
    persona: slot.persona,
    style: slot.style,
    length: slot.length,
    domainDescription,
    domainSchema,
  })

  const raw = await callAzureOpenAIChat({ ...llm, systemPrompt, userPrompt, signal, jsonSchema: SINGLE_QUERY_SCHEMA })
  const parsed = parseScenarioQuery(raw)
  if (!parsed) return null

  const generatedAt = provenance?.generatedAt ?? new Date().toISOString()
  const base: GeneratedQAItem = {
    query: parsed.query,
    expected_ids: slot.docs.map((d) => d.id),
    source_doc_id: slot.docs[0].id,
    generation_model: llm.deployment,
    language,
    provenance: 'synthetic',
    generated_at: generatedAt,
    generated_against_index: provenance?.indexName,
    generation_run_id: provenance?.runId,
  }
  return applyScenarioMetadata(base, slot)
}

/* ------------------------------------------------------------------ */
/* Dedup (surface / Jaccard)                                          */
/* ------------------------------------------------------------------ */

function tokenize(text: string): Set<string> {
  // Simple whitespace + Unicode punctuation split. Adequate for surface dedup.
  const tokens = text
    .toLowerCase()
    .normalize('NFKC')
    .split(/[\s\p{P}\p{S}]+/u)
    .filter((t) => t.length > 0)
  return new Set(tokens)
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Drop items whose query is too similar (by token Jaccard) to a previously kept item.
 * Order is preserved; the first occurrence wins.
 */
export function dedupBySurface(items: GeneratedQAItem[], threshold: number): GeneratedQAItem[] {
  const t = Math.max(0, Math.min(1, threshold))
  const kept: GeneratedQAItem[] = []
  const keptTokens: Set<string>[] = []
  for (const item of items) {
    const tokens = tokenize(item.query)
    let dup = false
    for (const prev of keptTokens) {
      if (jaccard(tokens, prev) >= t) {
        dup = true
        break
      }
    }
    if (!dup) {
      kept.push(item)
      keptTokens.push(tokens)
    }
  }
  return kept
}

/* ------------------------------------------------------------------ */
/* JSONL export                                                       */
/* ------------------------------------------------------------------ */

/**
 * Convert items to AutoTuning-compatible JSONL.
 * Rejected items are excluded by default.
 *
 * Phase 2.0: provenance metadata (`provenance`, `generated_at`,
 * `generated_against_index`, `generation_run_id`) is also emitted so
 * downstream consumers can recognize synthetic data.
 */
export function toJsonl(items: GeneratedQAItem[]): string {
  return items
    .filter((i) => !i.rejected)
    .map((i) => {
      const out: Record<string, unknown> = {
        query: i.query,
        expected_ids: i.expected_ids,
      }
      if (i.query_type) out['query_type'] = i.query_type
      if (i.language) out['language'] = i.language
      if (i.category) out['category'] = i.category
      if (i.source_doc_id) out['source_doc_id'] = i.source_doc_id
      if (i.generation_model) out['generation_model'] = i.generation_model
      if (i.provenance) out['provenance'] = i.provenance
      if (i.generated_at) out['generated_at'] = i.generated_at
      if (i.generated_against_index) out['generated_against_index'] = i.generated_against_index
      if (i.generation_run_id) out['generation_run_id'] = i.generation_run_id
      if (typeof i.grounding_rank === 'number') out['grounding_rank'] = i.grounding_rank
      if (typeof i.grounding_top_k === 'number') out['grounding_top_k'] = i.grounding_top_k
      if (i.query_shape) out['query_shape'] = i.query_shape
      if (i.persona) out['persona'] = i.persona
      if (i.style) out['style'] = i.style
      if (i.length) out['length'] = i.length
      if (i.difficulty) out['difficulty'] = i.difficulty
      if (i.hard_negative_ids && i.hard_negative_ids.length > 0)
        out['hard_negative_ids'] = i.hard_negative_ids
      if (i.relevance_grades && Object.keys(i.relevance_grades).length > 0)
        out['relevance_grades'] = i.relevance_grades
      if (i.style_evolution_kind) out['style_evolution_kind'] = i.style_evolution_kind
      if (i.trace && i.trace.length > 0) out['trace'] = i.trace
      if (i.hyde_hypothesis) out['hyde_hypothesis'] = i.hyde_hypothesis
      if (i.hyde_model) out['hyde_model'] = i.hyde_model
      if (i.hyde_generated_at) out['hyde_generated_at'] = i.hyde_generated_at
      return JSON.stringify(out)
    })
    .join('\n')
}

/* ------------------------------------------------------------------ */
/* Phase 6: NDCG/XDCG-compatible relevance grades                     */
/* ------------------------------------------------------------------ */

/**
 * Compute graded relevance per doc id for `item` using the default policy:
 *
 *   - First entry of `expected_ids` (the "primary" anchor) → 3
 *   - Remaining `expected_ids` (multi-hop secondary docs) → 2
 *   - `hard_negative_ids` → 0
 *
 * Returns `undefined` when there is nothing to grade so callers can avoid
 * polluting the JSONL with empty objects.
 */
export function computeRelevanceGrades(
  item: GeneratedQAItem,
): Record<string, number> | undefined {
  const grades: Record<string, number> = {}
  const exp = item.expected_ids ?? []
  if (exp.length > 0) {
    // Primary anchor = the source/first expected id.
    const primary = item.source_doc_id && exp.includes(item.source_doc_id)
      ? item.source_doc_id
      : exp[0]
    grades[primary] = 3
    for (const id of exp) {
      if (!(id in grades)) grades[id] = 2
    }
  }
  for (const id of item.hard_negative_ids ?? []) {
    if (!(id in grades)) grades[id] = 0
  }
  return Object.keys(grades).length > 0 ? grades : undefined
}

/* ------------------------------------------------------------------ */
/* Phase 4: Evol-Instruct (easy → hard) rewrite                       */
/* ------------------------------------------------------------------ */

import {
  buildHardenSystemPrompt,
  buildHardenUserPrompt,
} from './evalDatasetPrompts'

export interface HardenQueryParams {
  language: EvalLanguage
  query: string
  contextText: string
  llm: Omit<CallAoaiParams, 'systemPrompt' | 'userPrompt' | 'signal'>
  signal?: AbortSignal
}

/**
 * Parse a `{ "query": "..." }` response. Trims and rejects empties.
 * Exported so tests can assert behaviour without hitting the network.
 */
export function parseHardenedQuery(rawJson: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonFromText(rawJson))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const q = (parsed as Record<string, unknown>)['query']
  if (typeof q !== 'string') return null
  const trimmed = q.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Rewrite a query into a HARDER variant via a second LLM pass (Evol-Instruct).
 * Returns `null` on parse error so the caller can keep the original query.
 */
export async function hardenQuery(params: HardenQueryParams): Promise<string | null> {
  const { language, query, contextText, llm, signal } = params
  const ctx =
    contextText.length > MAX_CHUNK_CHARS
      ? contextText.slice(0, MAX_CHUNK_CHARS)
      : contextText
  const systemPrompt = buildHardenSystemPrompt(language)
  const userPrompt = buildHardenUserPrompt({ language, query, contextText: ctx })
  const raw = await callAzureOpenAIChat({ ...llm, systemPrompt, userPrompt, signal, jsonSchema: SINGLE_QUERY_SCHEMA })
  return parseHardenedQuery(raw)
}

/* ------------------------------------------------------------------ */
/* RAFT: Chain-of-Thought answer generation                            */
/* ------------------------------------------------------------------ */

import {
  buildRaftAnswerSystemPrompt,
  buildRaftAnswerUserPrompt,
} from './evalDatasetPrompts'

export interface GenerateRaftAnswerParams {
  language: EvalLanguage
  question: string
  oracleDoc: { id: string; text: string }
  distractorDocs: Array<{ id: string; text: string }>
  llm: Omit<CallAoaiParams, 'systemPrompt' | 'userPrompt' | 'signal'>
  signal?: AbortSignal
}

/**
 * Parse the `{ "cot_answer": "..." }` response from the RAFT answer LLM.
 * Exported for unit testing.
 */
export function parseRaftAnswer(rawJson: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonFromText(rawJson))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const a = (parsed as Record<string, unknown>)['cot_answer']
  if (typeof a !== 'string') return null
  const trimmed = a.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Generate a Chain-of-Thought answer for a RAFT training item.
 * The oracle doc is shuffled among distractors inside the prompt builder
 * so the model learns to identify the relevant document.
 *
 * Returns `null` on parse error (caller keeps item without CoT answer).
 */
export async function generateRaftAnswer(
  params: GenerateRaftAnswerParams,
): Promise<string | null> {
  const { language, question, oracleDoc, distractorDocs, llm, signal } = params

  // Truncate excerpts to fit within budget
  const perDocBudget = Math.max(
    300,
    Math.floor(MAX_CHUNK_CHARS / Math.max(1, 1 + distractorDocs.length)),
  )
  const truncOracle = {
    id: oracleDoc.id,
    text: oracleDoc.text.length > perDocBudget ? oracleDoc.text.slice(0, perDocBudget) : oracleDoc.text,
  }
  const truncDistractors = distractorDocs.map((d) => ({
    id: d.id,
    text: d.text.length > perDocBudget ? d.text.slice(0, perDocBudget) : d.text,
  }))

  const systemPrompt = buildRaftAnswerSystemPrompt(language)
  const userPrompt = buildRaftAnswerUserPrompt({
    language,
    question,
    oracleDoc: truncOracle,
    distractorDocs: truncDistractors,
  })

  const raw = await callAzureOpenAIChat({ ...llm, systemPrompt, userPrompt, signal, jsonSchema: COT_ANSWER_SCHEMA })
  return parseRaftAnswer(raw)
}

/**
 * Convert items to RAFT-format JSONL (for fine-tuning).
 * Only non-rejected items that have `raft_cot_answer` are included.
 *
 * RAFT JSONL schema per line:
 * ```json
 * {
 *   "question": "...",
 *   "context": [{ "doc_id": "...", "text": "...", "oracle": true/false }, ...],
 *   "cot_answer": "##Reason: ... ##Answer: ...",
 *   "expected_ids": ["..."],
 *   "provenance": "synthetic",
 *   ...metadata
 * }
 * ```
 */
export function toRaftJsonl(items: GeneratedQAItem[]): string {
  return items
    .filter((i) => !i.rejected && i.raft_cot_answer)
    .map((i) => {
      const out: Record<string, unknown> = {
        question: i.query,
        context: (i.raft_context ?? []).map((c) => ({
          doc_id: c.doc_id,
          text: c.text,
          oracle: c.oracle,
        })),
        cot_answer: i.raft_cot_answer,
        expected_ids: i.expected_ids,
      }
      if (i.query_type) out['query_type'] = i.query_type
      if (i.language) out['language'] = i.language
      if (i.source_doc_id) out['source_doc_id'] = i.source_doc_id
      if (i.generation_model) out['generation_model'] = i.generation_model
      if (i.provenance) out['provenance'] = i.provenance
      if (i.generated_at) out['generated_at'] = i.generated_at
      if (i.generated_against_index) out['generated_against_index'] = i.generated_against_index
      if (i.generation_run_id) out['generation_run_id'] = i.generation_run_id
      if (i.difficulty) out['difficulty'] = i.difficulty
      return JSON.stringify(out)
    })
    .join('\n')
}

/* ------------------------------------------------------------------ */
/* HyDE: Hypothetical Document Embeddings generation                   */
/* ------------------------------------------------------------------ */

import {
  buildHydeSystemPrompt,
  buildHydeUserPrompt,
} from './evalDatasetPrompts'

export interface GenerateHydeHypothesisParams {
  language: EvalLanguage
  query: string
  llm: Omit<CallAoaiParams, 'systemPrompt' | 'userPrompt' | 'signal'>
  signal?: AbortSignal
}

/**
 * Parse the `{ "hypothesis": "..." }` response from the HyDE LLM.
 * Exported for unit testing.
 */
export function parseHydeHypothesis(rawJson: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJsonFromText(rawJson))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const h = (parsed as Record<string, unknown>)['hypothesis']
  if (typeof h !== 'string') return null
  const trimmed = h.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Generate a hypothetical document passage (HyDE) for a given query.
 * The hypothesis is used as vector search input instead of the raw query,
 * enabling embedding-space alignment with actual document passages.
 *
 * Returns `null` on parse error (caller keeps item without hypothesis).
 */
export async function generateHydeHypothesis(
  params: GenerateHydeHypothesisParams,
): Promise<string | null> {
  const { language, query, llm, signal } = params
  const systemPrompt = buildHydeSystemPrompt(language)
  const userPrompt = buildHydeUserPrompt({ language, query })
  const raw = await callAzureOpenAIChat({ ...llm, systemPrompt, userPrompt, signal, jsonSchema: HYPOTHESIS_SCHEMA })
  return parseHydeHypothesis(raw)
}
