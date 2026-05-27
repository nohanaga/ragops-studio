/**
 * Types for the Eval Dataset Generator (EDAG, Phase 1 MVP).
 *
 * The output JSONL is intentionally compatible with `samples/autotuning-dataset-*.jsonl`
 * so that generated datasets can be fed straight into Search Parameter AutoTuning.
 */

import type { LlmAuth } from '../lib/llmAuth'
import type { LlmProviderType } from '../lib/llmProvider'

export type EvalLanguage = 'ja' | 'en'
export type EvalQueryType = 'factoid' | 'how-to' | 'comparative' | 'yes-no'

/* ------------------------------------------------------------------ */
/* Index Structure Detection (Phase 0)                                */
/* ------------------------------------------------------------------ */

/**
 * Detected index structure type.
 * - `chunked`:     Documents are chunks of larger source documents (parent-child).
 * - `independent`: Each document is a standalone unit (no parent relationship).
 * - `unknown`:     Could not determine automatically; falls back to simple sampling.
 */
export type IndexStructureType = 'chunked' | 'independent' | 'unknown'

/**
 * Result of automatic index structure detection.
 * Returned by `detectIndexStructure()` and used to drive adaptive sampling.
 */
export interface IndexStructureInfo {
  type: IndexStructureType
  /** Field name used to group chunks by source (only set for `chunked`). */
  parentField?: string
  /** Number of distinct parent/source values (only set for `chunked`). */
  parentCount?: number
  /** Total document count in the index. */
  documentCount: number
  /** Human-readable detection reason for the UI tooltip. */
  reason: string
}

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
 * Phase 7 (Style Evolution / SNS mode): surface-form degradation types
 * that make clean LLM queries resemble real user traffic.
 */
export type StyleEvolutionKind =
  | 'keyword'       // strip particles/connectives → noun-list style
  | 'colloquial'    // casual / spoken form (e.g. "〜って何")
  | 'typo'          // random char substitution / deletion
  | 'abbreviated'   // drop subject / object for contextual brevity
  | 'code_switch'   // mix ja/en in one query

/**
 * Phase 7: Query Transformation Trace event.
 * Records how each query was modified (or rejected) at every pipeline step.
 */
export interface TraceEvent {
  /** Pipeline step number (1-based, aligns with the 9-step flow). */
  step: number
  /** Pipeline phase identifier. */
  phase: 'generation' | 'surface-dedup' | 'grounding' | 'semantic-dedup' | 'difficulty' | 'style-evolution' | 'hardneg' | 'relevance'
  /** What happened to the query at this step. */
  action: 'created' | 'kept' | 'rejected' | 'modified' | 'enriched'
  /** ISO 8601 timestamp. */
  timestamp: string
  detail?: {
    /** Query text before modification (for 'modified' actions). */
    before?: string
    /** Query text after modification. */
    after?: string
    /** Machine-readable rejection / action reason. */
    reason?: string
    /** Numeric score (Jaccard, cosine, grounding rank, etc.). */
    score?: number
    /** Style evolution kind applied (for style-evolution phase). */
    styleKind?: StyleEvolutionKind
  }
}

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

/* ------------------------------------------------------------------ */
/* RAFT (Retrieval Augmented Fine-Tuning)                              */
/* ------------------------------------------------------------------ */

/**
 * A single document in the RAFT training context array.
 * Exactly one document in the array is the oracle (ground-truth source);
 * the rest are distractors selected via similarity search.
 */
export interface RaftContextDoc {
  doc_id: string
  text: string
  oracle: boolean
}

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
  * Legacy/TREC-style consumers can use this map directly. Azure AI Foundry's
  * Document Retrieval Evaluator uses `retrieval_ground_truth` instead.
   */
  relevance_grades?: Record<string, number>
  /**
  * Azure AI Foundry Document Retrieval Evaluator ground truth.
  * Each entry matches the required `{ document_id, query_relevance_label }`
  * shape for the `retrieval_ground_truth` data mapping.
  */
  retrieval_ground_truth?: RetrievalGroundTruthItem[]
  // Phase 7: Style Evolution (SNS mode) — which degradation was applied.
  style_evolution_kind?: StyleEvolutionKind
  // Phase 7: Query Transformation Trace — full lifecycle of this item.
  trace?: TraceEvent[]

  // RAFT (Retrieval Augmented Fine-Tuning) fields.
  /** Chain-of-Thought answer citing the oracle document. */
  raft_cot_answer?: string
  /** Context array of oracle + distractor documents for RAFT training. */
  raft_context?: RaftContextDoc[]

  // HyDE (Hypothetical Document Embeddings) fields.
  /** LLM-generated hypothetical answer passage used as vector search input. */
  hyde_hypothesis?: string
  /** Model deployment used to generate the hypothesis. */
  hyde_model?: string
  /** ISO-8601 timestamp when the hypothesis was generated. */
  hyde_generated_at?: string
}

export interface RetrievalGroundTruthItem {
  document_id: string
  query_relevance_label: number
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

  // Phase 0: Adaptive Sampling (Index Structure Detection).
  /** Enable auto-detection of index structure + adaptive sampling strategy. */
  enableAdaptiveSampling?: boolean
  /**
   * Parent/source field name for chunked indexes. When set, overrides auto-detection.
   * Examples: `parent_id`, `metadata_storage_path`, `title`.
   */
  parentField?: string

  // Generation
  language: EvalLanguage
  queryTypes: EvalQueryType[]
  domainDescription?: string

  // LLM (Chat Completions — multi-provider)
  llmProvider: LlmProviderType
  llmEndpoint: string
  llmAuth: LlmAuth
  llmDeployment: string
  llmApiVersion: string

  // Phase 2.1: Round-trip consistency filter (Promptagator).
  enableGroundingCheck: boolean
  groundingTopK: number

  // Phase 2.2: Semantic dedup via embeddings.
  enableSemanticDedup: boolean
  embeddingProvider?: LlmProviderType
  embeddingEndpoint?: string
  embeddingAuth?: LlmAuth
  embeddingDeployment?: string
  embeddingApiVersion?: string
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

  // Phase 7a: Judge LLM (separate deployment on the same endpoint).
  /** When set, grounding / difficulty / hard-neg / style-evolution steps use this deployment instead of the generation LLM. */
  judgeLlmDeployment?: string

  // Phase 7b: Style Evolution (SNS mode).
  /** Enable surface-form degradation of clean LLM queries to mimic real user traffic. */
  enableStyleEvolution?: boolean
  /** Which degradation kinds to apply. When empty, all 5 are uniformly sampled. */
  styleEvolutionKinds?: StyleEvolutionKind[]

  // Phase 7c: Query Transformation Trace.
  /** Record trace events on each item through every pipeline step. */
  enableTrace?: boolean

  // RAFT (Retrieval Augmented Fine-Tuning).
  /** Enable RAFT dataset generation: generate CoT answers with oracle + distractor context. */
  enableRaftMode?: boolean
  /** Number of distractor documents to include per item. Defaults to 4. */
  raftDistractorCount?: number

  // HyDE (Hypothetical Document Embeddings).
  /** Generate a hypothetical answer passage per query for vector search evaluation. */
  enableHydeMode?: boolean
}
