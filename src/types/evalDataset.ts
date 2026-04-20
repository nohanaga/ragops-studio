/**
 * Types for the Eval Dataset Generator (EDAG, Phase 1 MVP).
 *
 * The output JSONL is intentionally compatible with `samples/autotuning-dataset-*.jsonl`
 * so that generated datasets can be fed straight into Search Parameter AutoTuning.
 */

import type { LlmAuth } from '../lib/llmAuth'

export type EvalLanguage = 'ja' | 'en'
export type EvalQueryType = 'factoid' | 'how-to' | 'comparative' | 'yes-no'

/**
 * Ragas-style scenario taxonomy (4 quadrants).
 *
 *                       Specific (fact lookup)        Abstract (synthesis/compare)
 *                     ┌────────────────────────┬────────────────────────────────┐
 *   Single-Hop        │ single_specific         │ single_abstract                │
 *   (one doc)         │ "What is X?"            │ "How did X evolve?"            │
 *                     ├────────────────────────┼────────────────────────────────┤
 *   Multi-Hop         │ multi_specific          │ multi_abstract                 │
 *   (cross documents) │ "Difference of A vs B?" │ "Summarize evolution of A,B,C" │
 *                     └────────────────────────┴────────────────────────────────┘
 */
export type QueryShape =
  | 'single_specific'
  | 'single_abstract'
  | 'multi_specific'
  | 'multi_abstract'

export type EvalStyle = 'web_search' | 'chat' | 'formal' | 'informal'
export type EvalLength = 'short' | 'medium' | 'long'

/**
 * Phase 4: Evol-Instruct difficulty label.
 *  - `easy`   : original single-pass generation.
 *  - `hard`   : LLM-rewritten harder variant (paraphrase / negation / aggregation).
 */
export type EvalDifficulty = 'easy' | 'hard'

/**
 * Phase 4: lightweight RAGEval-style domain schema input.
 * All fields are free-form strings so the user can type whatever fits the
 * domain; the schema is injected verbatim into the system prompt.
 */
export interface DomainSchema {
  entities?: string
  relations?: string
  constraints?: string
}

/**
 * Provenance marker for synthetic datasets. Phase 2.0.
 *
 * Always set to `'synthetic'` for items produced by EDAG so downstream consumers
 * can distinguish auto-generated from human-curated rows.
 */
export type EvalProvenance = 'synthetic'

/** Reason an item was soft-rejected by a quality filter. */
export type EvalRejectionReason = 'grounding' | 'semantic-dup' | 'surface-dup'

/**
 * One generated query/answer item.
 * Maps to a single JSONL line in the AutoTuning-compatible export.
 */
export interface GeneratedQAItem {
  query: string
  expected_ids: string[]
  category?: string
  query_type?: EvalQueryType
  source_doc_id?: string
  generation_model?: string
  language?: EvalLanguage
  // Soft-rejected items kept for transparency (not exported by default).
  rejected?: boolean
  rejection_reason?: EvalRejectionReason
  // Phase 2.0 provenance metadata.
  provenance?: EvalProvenance
  generated_at?: string // ISO-8601 timestamp
  generated_against_index?: string
  generation_run_id?: string
  // Phase 2.1 grounding (round-trip consistency).
  grounding_rank?: number // 1-based rank of the source doc in the search results; 0 if not found.
  grounding_top_k?: number // top-k used for the consistency check.
  // Phase 3 (Ragas-style) scenario metadata.
  query_shape?: QueryShape
  persona?: string
  style?: EvalStyle
  length?: EvalLength
  // Phase 4: Difficulty / Hard Negative / Schema (RAGEval).
  /** Difficulty label after Evol-Instruct rewrite. `easy` is the original generation. */
  difficulty?: EvalDifficulty
  /** Top-k IDs that are NOT in `expected_ids` (hard negatives mined from search). */
  hard_negative_ids?: string[]
  /**
   * Phase 6: NDCG/XDCG-compatible per-id relevance grades.
   * Map of `doc_id` -> graded relevance (0=not relevant, 1=marginal,
   * 2=related, 3=highly relevant). Default policy when grading is enabled:
   *   - `expected_ids` -> 3
   *   - secondary multi-hop docs (when shape is multi_*) -> 2
   *   - `hard_negative_ids` -> 0
   * Foundry / TREC-style evaluators consume this directly.
   */
  relevance_grades?: Record<string, number>
}

/**
 * Configuration captured from the UI prior to running generation.
 */
export interface EvalDatasetGenerationConfig {
  // Source (Azure AI Search index)
  indexName: string
  keyField: string
  contentFields: string[]
  sampleSize: number
  queriesPerDoc: number

  // Generation
  language: EvalLanguage
  queryTypes: EvalQueryType[]
  domainDescription?: string

  // LLM (Azure OpenAI Chat Completions)
  llmEndpoint: string
  llmAuth: LlmAuth
  llmDeployment: string
  llmApiVersion: string

  // Phase 2.1: Round-trip consistency filter (Promptagator).
  enableGroundingCheck: boolean
  groundingTopK: number

  // Phase 2.2: Semantic dedup via Azure OpenAI embeddings.
  enableSemanticDedup: boolean
  embeddingDeployment?: string
  semanticDedupThreshold: number // cosine similarity in [0, 1]

  // Phase 3 (Ragas-style scenario generation, opt-in).
  enableRagasMode: boolean
  /** Distribution over the 4 query shapes. Values normalised to sum to 1 at runtime. */
  queryDistribution?: Partial<Record<QueryShape, number>>
  personas?: string[]
  styles?: EvalStyle[]
  lengths?: EvalLength[]
  /** Surface-Jaccard threshold for pairing docs in multi-hop generation. */
  multiHopPairingThreshold?: number

  // Phase 4: Difficulty / Hard Negative / Schema (RAGEval).
  /** Run a second LLM pass to rewrite each kept query into a harder variant. */
  enableDifficultyEvolution?: boolean
  /** For each kept query, search top-k and store non-expected ids as `hard_negative_ids`. */
  enableHardNegativeMining?: boolean
  /** Top-k for hard negative mining. Defaults to 10. */
  hardNegativeTopK?: number
  /** Free-form domain schema (entities / relations / constraints) injected into prompts. */
  domainSchema?: DomainSchema

  // Phase 6 (NDCG/XDCG-compatible relevance_grades + KG entity extraction).
  /**
   * Emit per-id graded relevance (`relevance_grades`) on each item using the
   * default policy described on {@link GeneratedQAItem.relevance_grades}.
   */
  enableRelevanceGrades?: boolean
  /**
   * Use LLM-extracted entities (instead of token Jaccard) to find multi-hop
   * doc pairs in Ragas mode. Activates a small extra LLM pass per sampled
   * document. Falls back to Jaccard if extraction fails.
   */
  enableEntityKG?: boolean
}
