/**
 * Meta-Index generation and 2-stage search for the Index Cluster Visualizer.
 *
 * Phase 2: EFLC (Embedding-First Lightweight Clustering)
 *  - Summarize clusters via LLM → generate labels/keywords
 *  - Create meta-index in Azure AI Search
 *  - Upload cluster summary documents with centroid vectors
 *  - 2-stage search: Global (meta-index) → Local (source index)
 */

import type { ConnectionProfile, SearchApiVersion } from './model'
import type { Language } from './translations'
import type { LlmProviderConfig } from './llmProvider'
import type { ClusterResult, HierarchicalClusterResult } from './clustering'
import { callLlmChat, extractJsonFromText, type LlmUsage, type JsonSchemaResponseFormat } from './llmProvider'
import { countTokens, truncateToTokenLimit } from './tokenizer'
import { selectRoleAwareEvidence, type ClusterEvidenceCandidate } from './clusterEvidence'
import { analyzeEmbeddingTopology, type EmbeddingTopologyClusterMetric } from './embeddingTopology'
import { aggregateMicroSignatures, buildHierarchicalSignaturePayload, type MicroSignatureInput } from './clusterSignatureAggregation'
import {
  createOrUpdateIndex,
  searchDocuments,
  getIndexDefinition,
  deleteIndex,
  indexDocuments,
  listIndexes,
  type JsonValue,
  type RestResult,
} from './aiSearchRest'

// ─── Types ──────────────────────────────────────────────────────────────────

/** JSON Schema for cluster label / summary / keywords LLM output. */
const CLUSTER_LABEL_SCHEMA: JsonSchemaResponseFormat = {
  name: 'cluster_label',
  schema: {
    type: 'object',
    properties: {
      label: { type: 'string', maxLength: 80 },
      summary: { type: 'string', maxLength: 320 },
      keywords: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 60 } },
    },
    required: ['label', 'summary', 'keywords'],
    additionalProperties: false,
  },
}

const CLUSTER_SIGNATURE_SCHEMA: JsonSchemaResponseFormat = {
  name: 'cluster_signature',
  schema: {
    type: 'object',
    properties: {
      primaryLabel: { type: 'string', maxLength: 80 },
      shortSummary: { type: 'string', maxLength: 320 },
      facets: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', maxLength: 80 },
            summary: { type: 'string', maxLength: 240 },
            keywords: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 60 } },
            supportRatio: { type: 'number' },
            representativeDocIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['label', 'summary', 'keywords', 'supportRatio', 'representativeDocIds'],
          additionalProperties: false,
        },
      },
      inclusionCriteria: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 180 } },
      exclusionCriteria: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 180 } },
      evidenceDocIds: { type: 'array', items: { type: 'string' } },
      splitCandidate: { type: 'boolean' },
    },
    required: ['primaryLabel', 'shortSummary', 'facets', 'inclusionCriteria', 'exclusionCriteria', 'evidenceDocIds', 'splitCandidate'],
    additionalProperties: false,
  },
}

const TWO_STAGE_OVERVIEW_ANSWER_SCHEMA: JsonSchemaResponseFormat = {
  name: 'two_stage_overview_answer',
  schema: {
    type: 'object',
    properties: {
      answer: { type: 'string', maxLength: 3000 },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
      citations: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 16 } },
      caveats: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 220 } },
    },
    required: ['answer', 'confidence', 'citations', 'caveats'],
    additionalProperties: false,
  },
}

/**
 * Truncate a string to fit within a UTF-8 byte limit.
 *
 * Azure AI Search rejects single terms whose UTF-8 encoding exceeds 32766 bytes.
 * Multibyte text (e.g. Japanese, where each character is 3 bytes in UTF-8) hits
 * this limit much sooner than character-count-based truncation suggests.
 */
function truncateUtf8Bytes(text: string, maxBytes: number): string {
  if (!text) return text
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  // Decode the first `maxBytes` bytes, ignoring any incomplete trailing sequence.
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return decoder.decode(bytes.slice(0, maxBytes))
}

const MAX_CLUSTER_LABEL_CHARS = 80
const MAX_CLUSTER_SUMMARY_CHARS = 320
const MAX_FACET_SUMMARY_CHARS = 240
const MAX_KEYWORD_CHARS = 60
const MAX_CRITERION_CHARS = 180
const MAX_TITLE_LABEL_SOURCE_CHARS = 120

function normalizeInlineText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function compactInlineText(value: unknown, maxChars: number): string {
  const text = normalizeInlineText(value)
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function compactBlockText(value: unknown, maxChars: number): string {
  const text = String(value ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`
}

function compactList(values: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(values)) return []
  return uniqueStrings(values.map((value) => compactInlineText(value, maxChars)).filter(Boolean)).slice(0, maxItems)
}

function compactClusterLabel(value: unknown, fallback: string): string {
  return compactInlineText(value, MAX_CLUSTER_LABEL_CHARS) || fallback
}

function compactClusterSummary(value: unknown, fallback: string): string {
  return compactInlineText(value, MAX_CLUSTER_SUMMARY_CHARS) || fallback
}

function compactEvidenceTitle(value: unknown): string | null {
  const text = normalizeInlineText(value)
  if (!text || text.length > MAX_TITLE_LABEL_SOURCE_CHARS) return null
  return compactInlineText(text, MAX_CLUSTER_LABEL_CHARS)
}

function safeRepresentativeReference(doc?: { id: string; title: string }): string {
  if (!doc) return 'N/A'
  return compactEvidenceTitle(doc.title) ?? doc.id
}

type EvidenceBlock = { role: string; docId: string; title: string; text: string }

function buildV1ContentFilterRetryUserPrompts(input: {
  language: Language
  memberCount: number
  docs: Array<{ id: string; title: string }>
  representativeIndices: number[]
}): string[] {
  const titleRows = input.representativeIndices
    .map((index) => {
      const doc = input.docs[index]
      if (!doc) return null
      const title = compactEvidenceTitle(doc.title)
      return title ? `- ${doc.id}: ${title}` : `- ${doc.id}`
    })
    .filter((row): row is string => Boolean(row))
    .slice(0, 16)
  const idRows = input.representativeIndices
    .map((index) => input.docs[index]?.id)
    .filter((id): id is string => Boolean(id))
    .slice(0, 16)
    .map((id) => `- ${id}`)

  if (input.language === 'ja') {
    const requirements = `制約:\n- label / summary / keywords はクラスタ全体を表すこと。\n- 生の文書本文は content filter 回避のため省略されている。推測しすぎず、与えられた短い title / 文書ID / 文書数だけに基づくこと。\n- 情報が不足している場合は、汎用的で短い label にする。\n\n以下のJSON形式で出力してください:\n{"label": "クラスタを表す短いラベル", "summary": "クラスタの概要", "keywords": ["キーワード1", "キーワード2"]}`
    return [
      `クラスタ全体の文書数: ${input.memberCount}\n代表文書数: ${titleRows.length}\n\nAzure OpenAI の content filter により、生の代表文書本文を省略した再試行です。短い title だけを根拠にクラスタ要約を作成してください。\n\n## 代表文書\n${titleRows.join('\n') || 'N/A'}\n\n${requirements}`,
      `クラスタ全体の文書数: ${input.memberCount}\n代表文書数: ${idRows.length}\n\nAzure OpenAI の content filter により、代表文書の本文と title を省略した再試行です。文書数と代表文書IDだけを根拠に、控えめなクラスタ要約を作成してください。\n\n## 代表文書ID\n${idRows.join('\n') || 'N/A'}\n\n${requirements}`,
    ]
  }

  const requirements = `Constraints:\n- label / summary / keywords must describe the whole cluster.\n- Raw document text is omitted for a content-filter retry. Do not over-infer beyond the short titles / document IDs / document count provided.\n- If evidence is insufficient, use a short generic label.\n\nRespond in this JSON format:\n{"label": "Short cluster label", "summary": "Cluster overview", "keywords": ["keyword1", "keyword2"]}`
  return [
    `Total documents in cluster: ${input.memberCount}\nRepresentative documents: ${titleRows.length}\n\nRetry after Azure OpenAI content filtering. Raw representative document text is omitted. Summarize the cluster using only these short titles.\n\n## Representative documents\n${titleRows.join('\n') || 'N/A'}\n\n${requirements}`,
    `Total documents in cluster: ${input.memberCount}\nRepresentative documents: ${idRows.length}\n\nRetry after Azure OpenAI content filtering. Raw document text and titles are omitted. Create a conservative cluster summary using only document count and representative IDs.\n\n## Representative document IDs\n${idRows.join('\n') || 'N/A'}\n\n${requirements}`,
  ]
}

export interface ClusterSummary {
  clusterId: string
  label: string
  summary: string
  keywords: string[]
  documentCount: number
  memberDocIds: string[]
  centroidVector: number[]
  representativeText: string
  summaryVersion?: 'v1' | 'v2'
  facetLabels?: string[]
  facetSummaries?: string[]
  inclusionCriteria?: string[]
  exclusionCriteria?: string[]
  signatureJson?: string
  qualityJson?: string
  topologyJson?: string
  hierarchyJson?: string
  nodeKind?: RaptorNodeKind
  level?: number
  parentId?: string
  childIds?: string[]
  sourceClusterId?: string
  localClusterId?: string
  retrievalText?: string
  generatedQuestions?: string[]
  retrievalIntents?: string[]
  referenceDocIds?: string[]
  retrievalSignatureJson?: string
}

export interface ClusterFacet {
  label: string
  summary: string
  keywords: string[]
  supportRatio: number
  representativeDocIds: string[]
}

export interface ClusterSemanticSignature {
  primaryLabel: string
  shortSummary: string
  facets: ClusterFacet[]
  inclusionCriteria: string[]
  exclusionCriteria: string[]
  evidenceDocIds: string[]
  splitCandidate: boolean
  topology?: EmbeddingTopologyClusterMetric
  hierarchy?: {
    level: 'flat' | 'micro' | 'macro'
    parentClusterId?: string
    childClusterIds?: string[]
    childCount?: number
    strategy?: string
  }
}

export type RaptorNodeKind =
  | 'root'
  | 'macro'
  | 'micro'
  | 'retrieval-question'
  | 'facet'
  | 'bridge'

export interface ClusterRetrievalSignature {
  taxonomyPath: string[]
  retrievalIntents: string[]
  generatedQuestions: string[]
  positiveQueryExamples: string[]
  negativeQueryExamples: string[]
  facetQueries: Array<{ facet: string; query: string }>
  referenceDocIds: string[]
}

export interface RaptorRetrievalNode {
  id: string
  nodeKind: RaptorNodeKind
  level: number
  clusterId: string
  parentId?: string
  childIds: string[]
  label: string
  summary: string
  keywords: string[]
  retrievalText: string
  generatedQuestions: string[]
  retrievalIntents: string[]
  facetLabels: string[]
  facetSummaries?: string[]
  inclusionCriteria: string[]
  exclusionCriteria: string[]
  memberDocIds: string[]
  referenceDocIds: string[]
  centroidVector?: number[]
  signatureJson?: string
  retrievalSignatureJson?: string
  topologyJson?: string
  hierarchyJson?: string
  sourceClusterId?: string
  localClusterId?: string
}

export interface RaptorTreeDecision {
  hitNodeId: string
  nodeKind: RaptorNodeKind
  action: 'use-node' | 'ascend-parent' | 'descend-children' | 'expand-bridge'
  selectedClusterIds: string[]
  selectedDocIds: string[]
  reason: string
  treePath: string[]
  matchedQuestions: string[]
  matchedFacets: string[]
  retrievalIntents: string[]
}

export type GlobalScoreGateMetric = 'rerankerScore' | 'searchScore'

export interface GlobalScoreGateTrace {
  metric: GlobalScoreGateMetric
  threshold: number
  topScore: number
  acceptedNodeCount: number
  rejectedNodeCount: number
  rejectedNodeIds: string[]
}

export interface ClusterSignatureQuality {
  specificityScore: number
  genericityScore: number
  splitScore: number
  needsRepair: boolean
  repairReason?: string
  topology?: {
    cohesionScore: number
    separationScore: number
    boundaryRatio: number
    outlierRatio: number
    ambiguityScore: number
    topologyLabel: string
    needsSplit: boolean
  }
}

export type ClusterSummaryMode = 'v1' | 'v2'

export type MetaTraceAction = 'created' | 'kept' | 'rejected' | 'modified' | 'enriched'

export type MetaTraceLevel = 'flat' | 'micro' | 'macro'

export type MetaTracePhase =
  | 'member-collection'
  | 'evidence-selection'
  | 'topology-analysis'
  | 'sibling-contrast'
  | 'hierarchical-aggregation'
  | 'llm-signature'
  | 'quality-scoring'
  | 'meta-document'

export interface MetaTraceStepDetail {
  metrics?: Record<string, string | number | boolean>
  docIds?: string[]
  input?: string
  output?: string
  reason?: string
  before?: string
  after?: string
}

export interface MetaTraceStep {
  step: number
  phase: MetaTracePhase
  action: MetaTraceAction
  timestamp: string
  detail?: MetaTraceStepDetail
}

export interface MetaTraceOutput {
  primaryLabel: string
  shortSummary: string
  facetLabels: string[]
  inclusionCriteria: string[]
  exclusionCriteria: string[]
  evidenceDocIds: string[]
  keywords?: string[]
  quality?: ClusterSignatureQuality
  topology?: EmbeddingTopologyClusterMetric
  hierarchy?: {
    level: MetaTraceLevel
    childClusterIds?: string[]
    childCount?: number
    strategy?: string
  }
}

export interface MetaTraceIndexFields {
  sourceIndexName: string
  keyField: string
  vectorField: string
  titleField?: string
  titleFieldSource?: 'user' | 'auto' | 'key'
  contentFields: string[]
  contentFieldSource: 'user' | 'auto' | 'none'
}

/** Per-cluster LLM trace for debugging meta-index generation. */
export interface MetaClusterTrace {
  clusterId: number
  label: string
  summaryMode?: ClusterSummaryMode
  traceLevel?: MetaTraceLevel
  systemPrompt: string
  userPrompt: string
  response: string | null
  error: string | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
  representativeDocIds: string[]
  memberCount?: number
  evidenceStats?: { evidenceCount: number; roleCounts: Record<string, number>; distinctTitleCount: number }
  indexFields?: MetaTraceIndexFields
  pipelineSteps?: MetaTraceStep[]
  output?: MetaTraceOutput
}

export interface MetaIndexConfig {
  sourceIndexName: string
  vectorField: string
  vectorDimensions: number
  clusterCount: number
  algorithm: string
  createdAt: string
}

export type TwoStageOverviewAnswerStatus = 'generated' | 'skipped' | 'error'
export type TwoStageOverviewAnswerConfidence = 'low' | 'medium' | 'high'

export interface TwoStageAnswerSynthesisActivity {
  step: string
  status: 'completed' | 'skipped' | 'failed'
  detail: string
  count?: number
  durationMs?: number
}

export interface TwoStageAnswerReference {
  refId: string
  kind: 'global-node' | 'local-document'
  title: string
  sourceId?: string
  score?: number
  rerankerScore?: number
  snippet?: string
}

export interface TwoStageAnswerSynthesisTrace {
  mode: 'llm-profile'
  profileName?: string
  activity: TwoStageAnswerSynthesisActivity[]
  references: TwoStageAnswerReference[]
  usage?: LlmUsage
}

export interface TwoStageOverviewAnswer {
  status: TwoStageOverviewAnswerStatus
  mode: 'llm-profile'
  text: string
  generatedAt: string
  confidence?: TwoStageOverviewAnswerConfidence
  citations?: string[]
  caveats?: string[]
  usage?: LlmUsage
  error?: string
}

export interface TwoStageSearchResult {
  /** One synthesized answer that combines Global scope and Local evidence. */
  overviewAnswer?: TwoStageOverviewAnswer
  /** Matching clusters from global search */
  clusters: Array<{
    nodeId?: string
    nodeKind?: RaptorNodeKind
    level?: number
    clusterId: string
    label: string
    summary: string
    score: number
    rerankerScore?: number
    documentCount: number
    parentId?: string
    childIds?: string[]
    sourceClusterId?: string
    localClusterId?: string
    generatedQuestions?: string[]
    retrievalIntents?: string[]
    facetLabels?: string[]
    referenceDocIds?: string[]
    treePath?: string[]
    nodeDecision?: RaptorTreeDecision
  }>
  /** Final documents from local search */
  documents: Array<{
    id: string
    score: number
    fields: Record<string, JsonValue>
  }>
  /** Stats */
  stats: {
    globalSearchTimeMs: number
    localSearchTimeMs: number
    totalTimeMs: number
    searchSpaceReduction: number
    totalDocs: number
    filteredDocs: number
    globalNodeCount?: number
    globalRawNodeCount?: number
    globalRejectedNodeCount?: number
    globalScoreGateThreshold?: number
    globalScoreGateMetric?: GlobalScoreGateMetric
    candidateDocCount?: number
    localFilterApplied?: boolean
  }
  trace?: {
    mode: 'raptor-lite' | 'legacy'
    globalRequest: JsonValue
    localRequest?: JsonValue
    retrievalSurfaceFields: string[]
    nodeDecisions: RaptorTreeDecision[]
    candidateDocIds: string[]
    localFilterApplied: boolean
    fallbackReason?: string
    globalScoreGate?: GlobalScoreGateTrace
    answerSynthesis?: TwoStageAnswerSynthesisTrace
  }
}

export interface SummarizeProgress {
  current: number
  total: number
  currentLabel?: string
}

const RAPTOR_META_SEARCH_FIELDS = [
  'label',
  'summary',
  'retrievalText',
  'generatedQuestions',
  'retrievalIntents',
  'facetLabels',
  'facetSummaries',
  'inclusionCriteria',
]

const RAPTOR_META_SELECT = [
  'id',
  'clusterId',
  'nodeKind',
  'level',
  'parentId',
  'childIds',
  'sourceClusterId',
  'localClusterId',
  'label',
  'summary',
  'documentCount',
  'memberDocIds',
  'referenceDocIds',
  'generatedQuestions',
  'retrievalIntents',
  'facetLabels',
  'retrievalSignatureJson',
  'signatureJson',
  'qualityJson',
  'topologyJson',
  'hierarchyJson',
]

const LEGACY_META_SELECT = [
  'clusterId',
  'label',
  'summary',
  'documentCount',
  'memberDocIds',
]

const META_SUMMARY_SELECT = [
  'id',
  'clusterId',
  'nodeKind',
  'level',
  'parentId',
  'childIds',
  'sourceClusterId',
  'localClusterId',
  'label',
  'summary',
  'keywords',
  'documentCount',
  'memberDocIds',
  'centroidVector',
  'representativeText',
  'summaryVersion',
  'facetLabels',
  'facetSummaries',
  'inclusionCriteria',
  'exclusionCriteria',
  'retrievalText',
  'generatedQuestions',
  'retrievalIntents',
  'referenceDocIds',
  'retrievalSignatureJson',
  'signatureJson',
  'qualityJson',
  'topologyJson',
  'hierarchyJson',
  'sourceIndex',
  'vectorField',
  'createdAt',
]

const LEGACY_META_SUMMARY_SELECT = [
  'id',
  'clusterId',
  'label',
  'summary',
  'keywords',
  'documentCount',
  'memberDocIds',
  'centroidVector',
  'representativeText',
  'summaryVersion',
  'facetLabels',
  'facetSummaries',
  'inclusionCriteria',
  'exclusionCriteria',
  'signatureJson',
  'qualityJson',
  'topologyJson',
  'hierarchyJson',
  'sourceIndex',
  'vectorField',
  'createdAt',
]

const GLOBAL_MIN_RERANKER_SCORE = 1.0
const GLOBAL_MIN_SEARCH_SCORE = 0.05
const GLOBAL_RELATIVE_SEARCH_SCORE_FLOOR = 0.35

function asFiniteNumber(value: unknown): number | undefined {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}

function globalDocId(doc: Record<string, JsonValue>): string {
  return String(doc.id ?? doc.clusterId ?? '')
}

function filterGlobalDocsBySearchScore(docs: Array<Record<string, JsonValue>>): {
  acceptedDocs: Array<Record<string, JsonValue>>
  gate?: GlobalScoreGateTrace
} {
  if (docs.length === 0) return { acceptedDocs: docs }

  const rerankerScores = docs
    .map((doc) => asFiniteNumber(doc['@search.rerankerScore']))
    .filter((score): score is number => score !== undefined)
  const hasRerankerScore = rerankerScores.length > 0

  if (hasRerankerScore) {
    const acceptedDocs = docs.filter((doc) => (asFiniteNumber(doc['@search.rerankerScore']) ?? 0) >= GLOBAL_MIN_RERANKER_SCORE)
    const rejectedDocs = docs.filter((doc) => !acceptedDocs.includes(doc))
    return {
      acceptedDocs,
      gate: {
        metric: 'rerankerScore',
        threshold: GLOBAL_MIN_RERANKER_SCORE,
        topScore: Math.max(...rerankerScores),
        acceptedNodeCount: acceptedDocs.length,
        rejectedNodeCount: rejectedDocs.length,
        rejectedNodeIds: rejectedDocs.map(globalDocId).filter(Boolean).slice(0, 20),
      },
    }
  }

  const searchScores = docs.map((doc) => asFiniteNumber(doc['@search.score']) ?? 0)
  const topScore = Math.max(...searchScores)
  const threshold = Math.max(GLOBAL_MIN_SEARCH_SCORE, topScore * GLOBAL_RELATIVE_SEARCH_SCORE_FLOOR)
  const acceptedDocs = docs.filter((doc) => (asFiniteNumber(doc['@search.score']) ?? 0) >= threshold)
  const rejectedDocs = docs.filter((doc) => !acceptedDocs.includes(doc))
  return {
    acceptedDocs,
    gate: {
      metric: 'searchScore',
      threshold,
      topScore,
      acceptedNodeCount: acceptedDocs.length,
      rejectedNodeCount: rejectedDocs.length,
      rejectedNodeIds: rejectedDocs.map(globalDocId).filter(Boolean).slice(0, 20),
    },
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

function uniqueDocIds(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function parseClusterOrdinal(clusterId: string): number | null {
  const match = /^cluster-(\d+)$/.exec(clusterId.trim())
  return match ? Number(match[1]) : null
}

function buildGeneratedQuestions(input: {
  label: string
  summary: string
  facetLabels: string[]
  inclusionCriteria: string[]
  language: Language
}): string[] {
  const label = compactClusterLabel(input.label, input.language === 'ja' ? 'このクラスタ' : 'this cluster')
  const facets = input.facetLabels.slice(0, 3)
  const criteria = input.inclusionCriteria.slice(0, 2)
  const questions = input.language === 'ja'
    ? [
        `${label}について概要を知りたい`,
        `${label}に関係する文書を探したい`,
        ...facets.map((facet) => `${label}の${facet}に関する情報はどこにあるか`),
        ...criteria.map((criterion) => `${criterion}に該当する情報を確認したい`),
      ]
    : [
        `What is the overview of ${label}?`,
        `Find documents related to ${label}.`,
        ...facets.map((facet) => `Where is information about ${facet} in ${label}?`),
        ...criteria.map((criterion) => `Find information that matches ${criterion}.`),
      ]
  return compactList(questions, 6, 180)
}

function buildRetrievalIntents(input: {
  facetLabels: string[]
  exclusionCriteria: string[]
  signatureJson?: string
  topologyJson?: string
}): string[] {
  const intents = ['overview', 'drilldown']
  if (input.facetLabels.length > 0) intents.push('facet')
  if (input.exclusionCriteria.length > 0) intents.push('disambiguation')
  const topologyText = `${input.signatureJson ?? ''} ${input.topologyJson ?? ''}`.toLowerCase()
  if (topologyText.includes('split') || topologyText.includes('mixed') || topologyText.includes('overlapping') || topologyText.includes('diffuse')) {
    intents.push('mixed-cluster')
  }
  return uniqueStrings(intents)
}

function buildClusterRetrievalSignature(input: {
  taxonomyPath: string[]
  label: string
  summary: string
  keywords: string[]
  facetLabels: string[]
  inclusionCriteria: string[]
  exclusionCriteria: string[]
  referenceDocIds: string[]
  signatureJson?: string
  topologyJson?: string
  language: Language
}): ClusterRetrievalSignature {
  const generatedQuestions = buildGeneratedQuestions({
    label: input.label,
    summary: input.summary,
    facetLabels: input.facetLabels,
    inclusionCriteria: input.inclusionCriteria,
    language: input.language,
  })
  const retrievalIntents = buildRetrievalIntents({
    facetLabels: input.facetLabels,
    exclusionCriteria: input.exclusionCriteria,
    signatureJson: input.signatureJson,
    topologyJson: input.topologyJson,
  })
  const facetQueries = input.facetLabels.slice(0, 6).map((facet) => ({
    facet,
    query: input.language === 'ja'
      ? `${input.label} ${facet} 関連文書`
      : `${input.label} ${facet} related documents`,
  }))
  return {
    taxonomyPath: compactList(input.taxonomyPath, 6, MAX_CLUSTER_LABEL_CHARS),
    retrievalIntents,
    generatedQuestions,
    positiveQueryExamples: generatedQuestions.slice(0, 4),
    negativeQueryExamples: compactList(input.exclusionCriteria, 4, MAX_CRITERION_CHARS),
    facetQueries,
    referenceDocIds: uniqueDocIds(input.referenceDocIds).slice(0, 24),
  }
}

function buildRetrievalText(input: {
  label: string
  summary: string
  keywords: string[]
  facetLabels: string[]
  facetSummaries?: string[]
  inclusionCriteria: string[]
  exclusionCriteria: string[]
  generatedQuestions: string[]
  retrievalIntents: string[]
}): string {
  return uniqueStrings([
    input.label,
    input.summary,
    ...input.keywords,
    ...input.facetLabels,
    ...(input.facetSummaries ?? []),
    ...input.inclusionCriteria,
    ...input.exclusionCriteria,
    ...input.generatedQuestions,
    ...input.retrievalIntents,
  ]).join('\n')
}

function buildRetrievalSignatureForSummary(summary: ClusterSummary, language: Language): ClusterRetrievalSignature {
  const semanticSignature = parseSignatureFromSummary(summary)
  const referenceDocIds = uniqueDocIds([
    ...(summary.referenceDocIds ?? []),
    ...semanticSignature.evidenceDocIds,
    ...semanticSignature.facets.flatMap((facet) => facet.representativeDocIds),
    ...summary.memberDocIds.slice(0, 12),
  ])
  return buildClusterRetrievalSignature({
    taxonomyPath: [summary.label || summary.clusterId],
    label: summary.label,
    summary: summary.summary,
    keywords: summary.keywords,
    facetLabels: summary.facetLabels ?? semanticSignature.facets.map((facet) => facet.label),
    inclusionCriteria: summary.inclusionCriteria ?? semanticSignature.inclusionCriteria,
    exclusionCriteria: summary.exclusionCriteria ?? semanticSignature.exclusionCriteria,
    referenceDocIds,
    signatureJson: summary.signatureJson,
    topologyJson: summary.topologyJson,
    language,
  })
}

function buildRaptorNodeDocument(input: {
  node: RaptorRetrievalNode
  metaConfig: MetaIndexConfig
}): Record<string, JsonValue> {
  const node = input.node
  return {
    '@search.action': 'upload',
    id: node.id,
    clusterId: node.clusterId,
    nodeKind: node.nodeKind,
    level: node.level,
    parentId: node.parentId ?? '',
    childIds: node.childIds.slice(0, 200),
    sourceClusterId: node.sourceClusterId ?? node.clusterId,
    localClusterId: node.localClusterId ?? '',
    label: compactClusterLabel(node.label, node.id),
    summary: compactClusterSummary(node.summary, node.label || node.id),
    keywords: compactList(node.keywords, 16, MAX_KEYWORD_CHARS),
    documentCount: node.memberDocIds.length,
    memberDocIds: uniqueDocIds(node.memberDocIds).slice(0, 1000),
    referenceDocIds: uniqueDocIds(node.referenceDocIds).slice(0, 100),
    centroidVector: node.centroidVector ?? [],
    representativeText: truncateUtf8Bytes(node.retrievalText, 32_000),
    retrievalText: truncateUtf8Bytes(node.retrievalText, 32_000),
    generatedQuestions: compactList(node.generatedQuestions, 8, 180),
    retrievalIntents: compactList(node.retrievalIntents, 8, MAX_CLUSTER_LABEL_CHARS),
    summaryVersion: 'v2',
    facetLabels: compactList(node.facetLabels, 8, MAX_CLUSTER_LABEL_CHARS),
    facetSummaries: compactList(node.facetSummaries ?? [], 8, MAX_FACET_SUMMARY_CHARS),
    inclusionCriteria: compactList(node.inclusionCriteria, 8, MAX_CRITERION_CHARS),
    exclusionCriteria: compactList(node.exclusionCriteria, 8, MAX_CRITERION_CHARS),
    signatureJson: truncateUtf8Bytes(node.signatureJson ?? '', 32_000),
    retrievalSignatureJson: truncateUtf8Bytes(node.retrievalSignatureJson ?? '', 32_000),
    qualityJson: '',
    topologyJson: truncateUtf8Bytes(node.topologyJson ?? '', 32_000),
    hierarchyJson: truncateUtf8Bytes(node.hierarchyJson ?? '', 32_000),
    sourceIndex: input.metaConfig.sourceIndexName,
    vectorField: input.metaConfig.vectorField,
    createdAt: input.metaConfig.createdAt,
  }
}

function parseRaptorNodeKind(value: unknown): RaptorNodeKind {
  const text = String(value ?? 'macro')
  if (text === 'root' || text === 'macro' || text === 'micro' || text === 'retrieval-question' || text === 'facet' || text === 'bridge') {
    return text
  }
  return 'macro'
}

function buildTreePathForGlobalDoc(doc: Record<string, JsonValue>): string[] {
  return uniqueStrings([
    String(doc.sourceClusterId ?? doc.clusterId ?? ''),
    String(doc.parentId ?? ''),
    String(doc.id ?? doc.clusterId ?? ''),
  ]).filter(Boolean)
}

function buildRaptorDecisionForGlobalDoc(input: {
  doc: Record<string, JsonValue>
  language?: Language
}): RaptorTreeDecision {
  const doc = input.doc
  const nodeKind = parseRaptorNodeKind(doc.nodeKind)
  const memberDocIds = asStringArray(doc.memberDocIds)
  const referenceDocIds = asStringArray(doc.referenceDocIds)
  const selectedDocIds = uniqueDocIds([...referenceDocIds, ...memberDocIds])
  const sourceClusterId = String(doc.sourceClusterId ?? doc.clusterId ?? '')
  const localClusterId = String(doc.localClusterId ?? '')
  const selectedClusterIds = uniqueStrings([sourceClusterId, localClusterId]).filter(Boolean)
  const language = input.language ?? 'en'

  if (nodeKind === 'retrieval-question') {
    return {
      hitNodeId: String(doc.id ?? doc.clusterId ?? ''),
      nodeKind,
      action: 'ascend-parent',
      selectedClusterIds,
      selectedDocIds,
      reason: language === 'ja'
        ? 'generated question が一致したため、親ノードへ戻して reference docs と候補文書を優先します。'
        : 'Generated question matched; ascend to the parent node and prioritize reference/candidate documents.',
      treePath: buildTreePathForGlobalDoc(doc),
      matchedQuestions: asStringArray(doc.generatedQuestions),
      matchedFacets: asStringArray(doc.facetLabels),
      retrievalIntents: asStringArray(doc.retrievalIntents),
    }
  }

  if (nodeKind === 'facet') {
    return {
      hitNodeId: String(doc.id ?? doc.clusterId ?? ''),
      nodeKind,
      action: 'ascend-parent',
      selectedClusterIds,
      selectedDocIds,
      reason: language === 'ja'
        ? 'facet node が一致したため、該当観点の親クラスタ候補を Local 検索へ渡します。'
        : 'Facet node matched; route the parent cluster candidates for local search.',
      treePath: buildTreePathForGlobalDoc(doc),
      matchedQuestions: asStringArray(doc.generatedQuestions),
      matchedFacets: asStringArray(doc.facetLabels),
      retrievalIntents: asStringArray(doc.retrievalIntents),
    }
  }

  if (nodeKind === 'micro') {
    return {
      hitNodeId: String(doc.id ?? doc.clusterId ?? ''),
      nodeKind,
      action: 'use-node',
      selectedClusterIds,
      selectedDocIds,
      reason: language === 'ja'
        ? 'micro node が直接一致したため、macro 全体ではなく micro member docs に絞ります。'
        : 'Micro node matched directly; narrow local search to micro member documents.',
      treePath: buildTreePathForGlobalDoc(doc),
      matchedQuestions: asStringArray(doc.generatedQuestions),
      matchedFacets: asStringArray(doc.facetLabels),
      retrievalIntents: asStringArray(doc.retrievalIntents),
    }
  }

  if (nodeKind === 'bridge') {
    return {
      hitNodeId: String(doc.id ?? doc.clusterId ?? ''),
      nodeKind,
      action: 'expand-bridge',
      selectedClusterIds,
      selectedDocIds,
      reason: language === 'ja'
        ? 'bridge node が一致したため、境界にある候補文書を広げて検索します。'
        : 'Bridge node matched; expand to boundary candidate documents.',
      treePath: buildTreePathForGlobalDoc(doc),
      matchedQuestions: asStringArray(doc.generatedQuestions),
      matchedFacets: asStringArray(doc.facetLabels),
      retrievalIntents: asStringArray(doc.retrievalIntents),
    }
  }

  return {
    hitNodeId: String(doc.id ?? doc.clusterId ?? ''),
    nodeKind,
    action: asStringArray(doc.childIds).length > 0 ? 'descend-children' : 'use-node',
    selectedClusterIds,
    selectedDocIds,
    reason: language === 'ja'
      ? 'macro node が一致したため、macro member docs を候補化し、必要に応じて child node を確認します。'
      : 'Macro node matched; use macro member documents and inspect child nodes when needed.',
    treePath: buildTreePathForGlobalDoc(doc),
    matchedQuestions: asStringArray(doc.generatedQuestions),
    matchedFacets: asStringArray(doc.facetLabels),
    retrievalIntents: asStringArray(doc.retrievalIntents),
  }
}

// ─── Cluster Summarization ──────────────────────────────────────────────────

/**
 * Generate summaries for each cluster using representative documents.
 */
export async function summarizeClusters(input: {
  clusters: ClusterResult
  docs: Array<{ id: string; title: string; vector: Float32Array }>
  /** Text content for representative docs (fetched separately) */
  representativeTexts: Map<string, string>
  llmConfig: LlmProviderConfig
  language: Language
  traceIndexFields?: MetaTraceIndexFields
  /** Max representative docs per cluster (upper bound). Budget may reduce this. */
  maxRepresentativeCount?: number
  /** Max input tokens for the model. Used to calculate per-doc char budget. */
  maxInputTokens?: number
  signal?: AbortSignal
  onProgress?: (progress: SummarizeProgress) => void
}): Promise<{ summaries: ClusterSummary[]; llmFailureCount: number; llmErrors: string[]; promptTokens: number; completionTokens: number; totalTokens: number; traces: MetaClusterTrace[] }> {
  const {
    clusters,
    docs,
    representativeTexts,
    llmConfig,
    language,
    traceIndexFields,
    maxRepresentativeCount = 500,
    maxInputTokens = 128_000,
    signal,
    onProgress,
  } = input

  // Token budget: reserve 25% for system prompt + output, use 75% for content
  const contentTokenBudget = Math.floor(maxInputTokens * 0.75)

  const k = clusters.centroids.length
  const summaries: ClusterSummary[] = []
  let llmFailureCount = 0
  const llmErrors: string[] = []
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  const traces: MetaClusterTrace[] = []

  for (let c = 0; c < k; c++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    // Gather members of this cluster
    const memberIndices: number[] = []
    for (let i = 0; i < docs.length; i++) {
      if (clusters.labels[i] === c) memberIndices.push(i)
    }

    // Find representative docs (closest to centroid)
    const centroid = clusters.centroids[c]
    const withDist = memberIndices.map((idx) => {
      const v = docs[idx].vector
      let dot = 0, normA = 0, normB = 0
      for (let d = 0; d < v.length; d++) {
        dot += v[d] * centroid[d]
        normA += v[d] * v[d]
        normB += centroid[d] * centroid[d]
      }
      const sim = (Math.sqrt(normA) * Math.sqrt(normB)) === 0
        ? 0
        : dot / (Math.sqrt(normA) * Math.sqrt(normB))
      return { idx, sim }
    })
    withDist.sort((a, b) => b.sim - a.sim)

    // Greedy token-budget fill: start with role-aware evidence to avoid centroid
    // monopoly, then backfill with centroid-proximity order for v1 compatibility.
    const candidateCount = Math.min(withDist.length, maxRepresentativeCount)
    const roleAwareIndices = selectRoleAwareEvidence({
      clusterId: c,
      clusters,
      docs,
      maxCount: Math.min(48, candidateCount),
    }).map((item) => item.index)
    const orderedCandidateIndices: number[] = []
    const seenCandidateIndices = new Set<number>()
    for (const idx of roleAwareIndices) {
      if (seenCandidateIndices.has(idx)) continue
      seenCandidateIndices.add(idx)
      orderedCandidateIndices.push(idx)
    }
    for (const item of withDist.slice(0, candidateCount)) {
      if (seenCandidateIndices.has(item.idx)) continue
      seenCandidateIndices.add(item.idx)
      orderedCandidateIndices.push(item.idx)
    }

    const topIndices: number[] = []
    const repTexts: string[] = []
    let usedTokens = 0
    for (const idx of orderedCandidateIndices) {
      const doc = docs[idx]
      const text = representativeTexts.get(doc.id) || doc.title
      if (!text) continue
      const docTokens = countTokens(text)
      if (usedTokens + docTokens > contentTokenBudget) {
        // If we haven't added any doc yet, add a truncated version of the first
        if (topIndices.length === 0) {
          topIndices.push(idx)
          repTexts.push(truncateToTokenLimit(text, contentTokenBudget))
        }
        break
      }
      topIndices.push(idx)
      repTexts.push(text)
      usedTokens += docTokens
    }

    const memberDocIds = memberIndices.map((idx) => docs[idx].id)
    const repDocIds = topIndices.map((idx) => docs[idx].id)

    // Call LLM for summarization
    const systemPrompt = language === 'ja'
      ? `あなたはドキュメントクラスタの分析者です。代表文書はクラスタ全体のサンプルにすぎません。単一の人物・企業・作品・団体をクラスタ全体の主題にしてよいのは、それが複数の代表文書で明確に反復し、クラスタ全体を代表すると判断できる場合だけです。そうでない場合は、個別名ではなく上位カテゴリ、共通テーマ、文書タイプでラベル化してください。出力は必ずJSON形式で返してください。`
      : `You are a document cluster analyst. Representative documents are only samples of the full cluster. Use a single person, company, work, or organization as the cluster topic only when it clearly repeats across multiple representative documents and represents the whole cluster. Otherwise label the cluster by a broader category, shared theme, or document type. Always respond in JSON format.`

    const userPrompt = language === 'ja'
      ? `クラスタ全体の文書数: ${memberIndices.length}\n代表文書数: ${repTexts.length}\n\n以下はドキュメントクラスタの代表文書です。\n\n${repTexts.map((t, i) => `### 文書${i + 1}\n${t}`).join('\n\n')}\n\n制約:\n- label / summary / keywords はクラスタ全体を表すこと。\n- 代表文書の一部に出るだけの人物名・企業名・作品名を label にしない。\n- 固有名を label に使う場合は、summary でその固有名がクラスタ全体を代表する根拠を説明できる場合に限る。\n- サンプルが多様なら、より広い共通テーマでまとめる。\n\n以下のJSON形式で出力してください:\n{"label": "クラスタを表す短いラベル（10語以内）", "summary": "クラスタの概要（200文字以内）", "keywords": ["キーワード1", "キーワード2", "キーワード3", "キーワード4", "キーワード5"]}`
      : `Total documents in cluster: ${memberIndices.length}\nRepresentative documents: ${repTexts.length}\n\nBelow are representative documents from the cluster.\n\n${repTexts.map((t, i) => `### Document ${i + 1}\n${t}`).join('\n\n')}\n\nConstraints:\n- label / summary / keywords must describe the whole cluster.\n- Do not make a person, company, work, or organization the label when it appears only in part of the samples.\n- Use a proper name as the label only when the summary can justify that it represents the whole cluster.\n- If the samples are diverse, use a broader shared theme.\n\nRespond in the following JSON format:\n{"label": "Short label for this cluster (max 10 words)", "summary": "Cluster overview (max 200 chars)", "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]}`

    const fallbackLabel = language === 'ja' ? `クラスタ ${c}` : `Cluster ${c}`
    const fallbackSummary = language === 'ja'
      ? `${memberIndices.length} 件の文書を含むクラスタです。`
      : `Contains ${memberIndices.length} documents.`
    let label = fallbackLabel
    let summary = ''
    let keywords: string[] = []
    let traceResponse: string | null = null
    let traceError: string | null = null
    let tracePromptTokens = 0
    let traceCompletionTokens = 0
    let traceTotalTokens = 0
    const traceStart = performance.now()

    try {
      const response = await callLlmChat({
        config: llmConfig,
        systemPrompt,
        userPrompt,
        contentFilterRetryUserPrompts: buildV1ContentFilterRetryUserPrompts({
          language,
          memberCount: memberIndices.length,
          docs,
          representativeIndices: topIndices,
        }),
        signal,
        jsonMode: true,
        jsonSchema: CLUSTER_LABEL_SCHEMA,
        onUsage: (usage: LlmUsage) => {
          promptTokens += usage.promptTokens
          completionTokens += usage.completionTokens
          totalTokens += usage.totalTokens
          tracePromptTokens = usage.promptTokens
          traceCompletionTokens = usage.completionTokens
          traceTotalTokens = usage.totalTokens
        },
      })
      traceResponse = response

      const parsed = JSON.parse(extractJsonFromText(response))
      label = compactClusterLabel(parsed.label, fallbackLabel)
      summary = compactClusterSummary(parsed.summary, fallbackSummary)
      keywords = compactList(parsed.keywords, 8, MAX_KEYWORD_CHARS)
    } catch (err) {
      // If LLM fails, use fallback
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      llmFailureCount++
      const errMsg = err instanceof Error ? err.message : String(err)
      llmErrors.push(errMsg)
      traceError = errMsg
      label = compactClusterLabel(
        language === 'ja' ? `クラスタ ${c} (${memberIndices.length} 件)` : `Cluster ${c} (${memberIndices.length} docs)`,
        fallbackLabel,
      )
      const representative = safeRepresentativeReference(docs[topIndices[0]])
      summary = compactClusterSummary(
        language === 'ja'
          ? `${memberIndices.length} 件の文書を含むクラスタです。代表文書: ${representative}。`
          : `Contains ${memberIndices.length} documents. Representative: ${representative}`,
        fallbackSummary,
      )
    }

    const traceDuration = performance.now() - traceStart
    traces.push({
      clusterId: c,
      label,
      systemPrompt,
      userPrompt,
      response: traceResponse,
      error: traceError,
      promptTokens: tracePromptTokens,
      completionTokens: traceCompletionTokens,
      totalTokens: traceTotalTokens,
      durationMs: Math.round(traceDuration),
      representativeDocIds: repDocIds,
      indexFields: traceIndexFields,
    })

    onProgress?.({ current: c + 1, total: k, currentLabel: label })

    // Compute centroid as number[]
    const centroidArr = Array.from(centroid)

    summaries.push({
      clusterId: `cluster-${c}`,
      label,
      summary,
      keywords,
      documentCount: memberIndices.length,
      memberDocIds,
      centroidVector: centroidArr,
      representativeText: truncateToTokenLimit(repTexts.join('\n---\n'), Math.min(contentTokenBudget, 12_500)),
    })
  }

  return { summaries, llmFailureCount, llmErrors, promptTokens, completionTokens, totalTokens, traces }
}

export async function summarizeClustersV2(input: {
  clusters: ClusterResult
  docs: Array<{ id: string; title: string; vector: Float32Array }>
  representativeTexts: Map<string, string>
  llmConfig: LlmProviderConfig
  language: Language
  traceLevel?: 'flat' | 'micro'
  traceIndexFields?: MetaTraceIndexFields
  maxInputTokens?: number
  maxEvidenceDocs?: number
  signal?: AbortSignal
  onProgress?: (progress: SummarizeProgress) => void
}): Promise<{ summaries: ClusterSummary[]; llmFailureCount: number; llmErrors: string[]; promptTokens: number; completionTokens: number; totalTokens: number; traces: MetaClusterTrace[] }> {
  const {
    clusters,
    docs,
    representativeTexts,
    llmConfig,
    language,
    traceLevel = 'flat',
    traceIndexFields,
    maxInputTokens = 128_000,
    maxEvidenceDocs = 24,
    signal,
    onProgress,
  } = input

  const boundedContentTokenBudget = Math.min(18_000, Math.floor(maxInputTokens * 0.25))

  const summaries: ClusterSummary[] = []
  let llmFailureCount = 0
  const llmErrors: string[] = []
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  const traces: MetaClusterTrace[] = []
  const topology = analyzeEmbeddingTopology({
    vectors: docs.map((doc) => doc.vector),
    clusters,
  })

  for (let clusterId = 0; clusterId < clusters.centroids.length; clusterId++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const memberIndices = collectMemberIndices(clusters, clusterId, docs.length)
    const memberDocIds = memberIndices.map((docIndex) => docs[docIndex].id)
    const evidence = selectRoleAwareEvidence({ clusterId, clusters, docs, maxCount: maxEvidenceDocs })
    const evidenceDocIds = evidence.map((item) => item.docId)
    const evidenceBlocks = buildEvidenceBlocks({ evidence, docs, representativeTexts, tokenBudget: boundedContentTokenBudget })
    const siblingContexts = buildSiblingContexts({ clusterId, clusters, language })
    const evidenceStats = buildEvidenceStats({ memberCount: memberIndices.length, evidenceBlocks })
    const topologyMetric = topology.clusterMetrics[clusterId]

    const systemPrompt = language === 'ja'
      ? 'あなたは高カーディナリティな検索インデックスのクラスタ分析者です。与えられた role-aware evidence と兄弟クラスタとの差分を使い、クラスタを検索・探索に使える意味プロファイルとしてJSONで生成してください。証拠にない概念は追加しないでください。汎用的なラベルを避け、兄弟クラスタと区別できる表現にしてください。'
      : 'You are a cluster analyst for high-cardinality search indexes. Use the role-aware evidence documents and sibling contrasts to generate a search-ready semantic signature as JSON. Do not add concepts unsupported by evidence. Avoid generic labels and make this cluster distinguishable from siblings.'
    const userPrompt = language === 'ja'
      ? buildJapaneseV2Prompt({ evidenceBlocks, siblingContexts, evidenceStats, topologyMetric })
      : buildEnglishV2Prompt({ evidenceBlocks, siblingContexts, evidenceStats, topologyMetric })

    let signature = fallbackSignature({ clusterId, memberCount: memberIndices.length, evidenceBlocks, evidenceDocIds, language })
    let traceResponse: string | null = null
    let traceError: string | null = null
    let tracePromptTokens = 0
    let traceCompletionTokens = 0
    let traceTotalTokens = 0
    const traceStart = performance.now()

    try {
      const response = await callLlmChat({
        config: llmConfig,
        systemPrompt,
        userPrompt,
        contentFilterRetryUserPrompts: buildV2ContentFilterRetryUserPrompts({
          language,
          evidenceBlocks,
          siblingContexts,
          evidenceStats,
          topologyMetric,
        }),
        signal,
        jsonMode: true,
        jsonSchema: CLUSTER_SIGNATURE_SCHEMA,
        onUsage: (usage: LlmUsage) => {
          promptTokens += usage.promptTokens
          completionTokens += usage.completionTokens
          totalTokens += usage.totalTokens
          tracePromptTokens = usage.promptTokens
          traceCompletionTokens = usage.completionTokens
          traceTotalTokens = usage.totalTokens
        },
      })
      traceResponse = response
      signature = normalizeSignature(JSON.parse(extractJsonFromText(response)), signature)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      llmFailureCount++
      const errMsg = err instanceof Error ? err.message : String(err)
      llmErrors.push(errMsg)
      traceError = errMsg
    }

    const quality = scoreSignature({ signature, topologyMetric })
    const keywords = uniqueStrings([
      ...signature.facets.flatMap((facet) => facet.keywords),
      ...signature.facets.map((facet) => facet.label),
    ]).slice(0, 16)
    const persistedSignature: ClusterSemanticSignature = {
      ...signature,
      topology: topologyMetric,
      hierarchy: { level: traceLevel },
    }
    const hierarchyTrace = { level: traceLevel }
    const traceDurationMs = Math.round(performance.now() - traceStart)

    traces.push({
      clusterId,
      label: signature.primaryLabel,
      summaryMode: 'v2',
      traceLevel,
      systemPrompt,
      userPrompt,
      response: traceResponse,
      error: traceError,
      promptTokens: tracePromptTokens,
      completionTokens: traceCompletionTokens,
      totalTokens: traceTotalTokens,
      durationMs: traceDurationMs,
      representativeDocIds: evidenceDocIds,
      memberCount: memberIndices.length,
      evidenceStats,
      indexFields: traceIndexFields,
      pipelineSteps: buildV2TraceSteps({
        clusterId,
        traceLevel,
        memberCount: memberIndices.length,
        clusterCount: clusters.centroids.length,
        evidenceStats,
        evidenceDocIds,
        topologyMetric,
        siblingContexts,
        traceError,
        tracePromptTokens,
        traceCompletionTokens,
        traceTotalTokens,
        traceDurationMs,
        tokenBudget: boundedContentTokenBudget,
        signature,
        quality,
        hierarchy: hierarchyTrace,
      }),
      output: buildTraceOutput({ signature, keywords, quality, topologyMetric, hierarchy: hierarchyTrace }),
    })

    onProgress?.({ current: clusterId + 1, total: clusters.centroids.length, currentLabel: signature.primaryLabel })

    summaries.push({
      clusterId: `cluster-${clusterId}`,
      label: signature.primaryLabel,
      summary: signature.shortSummary,
      keywords,
      documentCount: memberIndices.length,
      memberDocIds,
      centroidVector: Array.from(clusters.centroids[clusterId]),
      representativeText: truncateToTokenLimit(evidenceBlocks.map((block) => block.text).join('\n---\n'), Math.min(boundedContentTokenBudget, 12_500)),
      summaryVersion: 'v2',
      facetLabels: signature.facets.map((facet) => facet.label),
      facetSummaries: signature.facets.map((facet) => facet.summary),
      inclusionCriteria: signature.inclusionCriteria,
      exclusionCriteria: signature.exclusionCriteria,
      signatureJson: JSON.stringify(persistedSignature),
      qualityJson: JSON.stringify(quality),
      topologyJson: JSON.stringify(topologyMetric),
      hierarchyJson: JSON.stringify(hierarchyTrace),
    })
  }

  return { summaries, llmFailureCount, llmErrors, promptTokens, completionTokens, totalTokens, traces }
}

export async function summarizeClustersHierarchicalV2(input: {
  clusters: ClusterResult
  hierarchical: HierarchicalClusterResult
  docs: Array<{ id: string; title: string; vector: Float32Array }>
  representativeTexts: Map<string, string>
  llmConfig: LlmProviderConfig
  language: Language
  traceIndexFields?: MetaTraceIndexFields
  maxInputTokens?: number
  maxEvidenceDocs?: number
  signal?: AbortSignal
  onProgress?: (progress: SummarizeProgress) => void
}): Promise<{ summaries: ClusterSummary[]; llmFailureCount: number; llmErrors: string[]; promptTokens: number; completionTokens: number; totalTokens: number; traces: MetaClusterTrace[] }> {
  const {
    clusters,
    hierarchical,
    docs,
    representativeTexts,
    llmConfig,
    language,
    traceIndexFields,
    maxInputTokens = 128_000,
    maxEvidenceDocs = 24,
    signal,
    onProgress,
  } = input
  const microClusters = flattenHierarchicalMicroClusters(hierarchical)
  const totalSteps = microClusters.centroids.length + clusters.centroids.length

  const microResult = await summarizeClustersV2({
    clusters: microClusters,
    docs,
    representativeTexts,
    llmConfig,
    language,
    traceLevel: 'micro',
    traceIndexFields,
    maxInputTokens,
    maxEvidenceDocs,
    signal,
    onProgress: (progress) => onProgress?.({
      current: progress.current,
      total: totalSteps,
      currentLabel: progress.currentLabel,
    }),
  })

  let llmFailureCount = microResult.llmFailureCount
  const llmErrors = [...microResult.llmErrors]
  let promptTokens = microResult.promptTokens
  let completionTokens = microResult.completionTokens
  let totalTokens = microResult.totalTokens
  const microTraces = [...microResult.traces]
  const macroTraces: MetaClusterTrace[] = []
  const boundedContentTokenBudget = Math.min(18_000, Math.floor(maxInputTokens * 0.25))
  const topology = analyzeEmbeddingTopology({
    vectors: docs.map((doc) => doc.vector),
    clusters,
  })
  const summaries: ClusterSummary[] = []

  for (let macroId = 0; macroId < clusters.centroids.length; macroId++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const childMicroIds = collectMicroIdsForMacro(hierarchical, macroId)
    const children: MicroSignatureInput[] = childMicroIds
      .map((microId) => {
        const summary = microResult.summaries[microId]
        if (!summary) return null
        return {
          clusterId: `micro-${microId}`,
          documentCount: summary.documentCount,
          signature: parseSignatureFromSummary(summary),
        }
      })
      .filter((child): child is MicroSignatureInput => Boolean(child))
    const memberIndices = collectMemberIndices(clusters, macroId, docs.length)
    const memberDocIds = memberIndices.map((docIndex) => docs[docIndex].id)
    const topologyMetric = topology.clusterMetrics[macroId]
    const hierarchyPayload = buildHierarchicalSignaturePayload(children)
    const fallback = aggregateMicroSignatures({ macroId, children, language })
    const siblingContexts = buildSiblingContexts({ clusterId: macroId, clusters, language })
    const systemPrompt = language === 'ja'
      ? 'あなたは階層クラスタの意味プロファイルを集約する分析者です。micro cluster の意味プロファイルだけを根拠として、macro cluster の ClusterSemanticSignature を bottom-up に生成してください。新しい根拠文書や証拠にない概念は追加しないでください。兄弟 macro cluster と区別できるようにしてください。'
      : 'You aggregate hierarchical cluster semantic signatures. Generate the macro ClusterSemanticSignature bottom-up from micro cluster signatures only. Do not add unsupported concepts or new evidence documents. Make the macro distinguishable from sibling macro clusters.'
    const userPrompt = buildHierarchicalAggregationPrompt({
      macroId,
      memberCount: memberIndices.length,
      children,
      siblingContexts,
      topologyMetric,
      language,
      tokenBudget: boundedContentTokenBudget,
    })

    let signature = fallback
    let traceResponse: string | null = null
    let traceError: string | null = null
    let tracePromptTokens = 0
    let traceCompletionTokens = 0
    let traceTotalTokens = 0
    const traceStart = performance.now()

    try {
      const response = await callLlmChat({
        config: llmConfig,
        systemPrompt,
        userPrompt,
        contentFilterRetryUserPrompts: buildHierarchicalAggregationContentFilterRetryUserPrompts({
          macroId,
          memberCount: memberIndices.length,
          children,
          siblingContexts,
          topologyMetric,
          language,
          tokenBudget: boundedContentTokenBudget,
        }),
        signal,
        jsonMode: true,
        jsonSchema: CLUSTER_SIGNATURE_SCHEMA,
        onUsage: (usage: LlmUsage) => {
          promptTokens += usage.promptTokens
          completionTokens += usage.completionTokens
          totalTokens += usage.totalTokens
          tracePromptTokens = usage.promptTokens
          traceCompletionTokens = usage.completionTokens
          traceTotalTokens = usage.totalTokens
        },
      })
      traceResponse = response
      signature = normalizeSignature(JSON.parse(extractJsonFromText(response)), fallback)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      llmFailureCount++
      const errMsg = err instanceof Error ? err.message : String(err)
      llmErrors.push(errMsg)
      traceError = errMsg
    }

    const quality = scoreSignature({ signature, topologyMetric })
    const keywords = uniqueStrings([
      ...signature.facets.flatMap((facet) => facet.keywords),
      ...signature.facets.map((facet) => facet.label),
      ...children.map((child) => child.signature.primaryLabel),
    ]).slice(0, 16)
    const persistedSignature: ClusterSemanticSignature = {
      ...signature,
      topology: topologyMetric,
      hierarchy: {
        level: 'macro',
        childClusterIds: hierarchyPayload.childClusterIds,
        childCount: hierarchyPayload.childCount,
        strategy: hierarchyPayload.strategy,
      },
    }
    const hierarchyTrace = {
      level: 'macro' as const,
      childClusterIds: hierarchyPayload.childClusterIds,
      childCount: hierarchyPayload.childCount,
      strategy: hierarchyPayload.strategy,
    }
    const traceDurationMs = Math.round(performance.now() - traceStart)

    macroTraces.push({
      clusterId: macroId,
      label: signature.primaryLabel,
      summaryMode: 'v2',
      traceLevel: 'macro',
      systemPrompt,
      userPrompt,
      response: traceResponse,
      error: traceError,
      promptTokens: tracePromptTokens,
      completionTokens: traceCompletionTokens,
      totalTokens: traceTotalTokens,
      durationMs: traceDurationMs,
      representativeDocIds: signature.evidenceDocIds,
      memberCount: memberIndices.length,
      indexFields: traceIndexFields,
      pipelineSteps: buildHsaTraceSteps({
        macroId,
        memberCount: memberIndices.length,
        macroClusterCount: clusters.centroids.length,
        children,
        hierarchyPayload,
        topologyMetric,
        siblingContexts,
        traceError,
        tracePromptTokens,
        traceCompletionTokens,
        traceTotalTokens,
        traceDurationMs,
        signature,
        quality,
        hierarchy: hierarchyTrace,
      }),
      output: buildTraceOutput({ signature, keywords, quality, topologyMetric, hierarchy: hierarchyTrace }),
    })

    onProgress?.({
      current: microClusters.centroids.length + macroId + 1,
      total: totalSteps,
      currentLabel: signature.primaryLabel,
    })

    summaries.push({
      clusterId: `cluster-${macroId}`,
      label: signature.primaryLabel,
      summary: signature.shortSummary,
      keywords,
      documentCount: memberIndices.length,
      memberDocIds,
      centroidVector: Array.from(clusters.centroids[macroId]),
      representativeText: truncateToTokenLimit(buildMacroRepresentativeText(children), Math.min(boundedContentTokenBudget, 12_500)),
      summaryVersion: 'v2',
      facetLabels: signature.facets.map((facet) => facet.label),
      facetSummaries: signature.facets.map((facet) => facet.summary),
      inclusionCriteria: signature.inclusionCriteria,
      exclusionCriteria: signature.exclusionCriteria,
      signatureJson: JSON.stringify(persistedSignature),
      qualityJson: JSON.stringify(quality),
      topologyJson: JSON.stringify(topologyMetric),
      hierarchyJson: JSON.stringify(hierarchyPayload),
    })
  }

  return { summaries, llmFailureCount, llmErrors, promptTokens, completionTokens, totalTokens, traces: [...macroTraces, ...microTraces] }
}

export function flattenHierarchicalMicroClusters(hierarchical: HierarchicalClusterResult): ClusterResult {
  const centroids: Float32Array[] = []
  const counts: number[] = []
  let inertia = 0
  for (const microResult of hierarchical.microClusters) {
    centroids.push(...microResult.centroids)
    counts.push(...microResult.counts)
    inertia += microResult.inertia
  }
  return {
    labels: hierarchical.microLabels,
    centroids,
    counts,
    inertia,
  }
}

function collectMicroIdsForMacro(hierarchical: HierarchicalClusterResult, macroId: number): number[] {
  const result: number[] = []
  for (let microId = 0; microId < hierarchical.microToMacro.length; microId++) {
    if (hierarchical.microToMacro[microId] === macroId) result.push(microId)
  }
  return result
}

export function buildRaptorRetrievalNodes(input: {
  macroSummaries: ClusterSummary[]
  traces: MetaClusterTrace[]
  hierarchical: HierarchicalClusterResult
  docs: Array<{ id: string; title: string; vector: Float32Array }>
  language: Language
}): RaptorRetrievalNode[] {
  const microClusters = flattenHierarchicalMicroClusters(input.hierarchical)
  const tracesByMicroId = new Map<number, MetaClusterTrace>()
  for (const trace of input.traces) {
    if (trace.traceLevel === 'micro') tracesByMicroId.set(trace.clusterId, trace)
  }

  const nodes: RaptorRetrievalNode[] = []

  for (let macroIndex = 0; macroIndex < input.macroSummaries.length; macroIndex++) {
    const macroSummary = input.macroSummaries[macroIndex]
    const macroId = parseClusterOrdinal(macroSummary.clusterId) ?? macroIndex
    const macroSignature = buildRetrievalSignatureForSummary(macroSummary, input.language)
    const macroRetrievalText = buildRetrievalText({
      label: macroSummary.label,
      summary: macroSummary.summary,
      keywords: macroSummary.keywords,
      facetLabels: macroSummary.facetLabels ?? [],
      facetSummaries: macroSummary.facetSummaries,
      inclusionCriteria: macroSummary.inclusionCriteria ?? [],
      exclusionCriteria: macroSummary.exclusionCriteria ?? [],
      generatedQuestions: macroSignature.generatedQuestions,
      retrievalIntents: macroSignature.retrievalIntents,
    })
    const macroDerivedNodes = buildDerivedRaptorChildNodes({
      parent: {
        id: macroSummary.clusterId,
        nodeKind: 'macro',
        level: 1,
        clusterId: macroSummary.clusterId,
        childIds: [],
        label: macroSummary.label,
        summary: macroSummary.summary,
        keywords: macroSummary.keywords,
        retrievalText: macroRetrievalText,
        generatedQuestions: macroSignature.generatedQuestions,
        retrievalIntents: macroSignature.retrievalIntents,
        facetLabels: macroSummary.facetLabels ?? [],
        facetSummaries: macroSummary.facetSummaries,
        inclusionCriteria: macroSummary.inclusionCriteria ?? [],
        exclusionCriteria: macroSummary.exclusionCriteria ?? [],
        memberDocIds: macroSummary.memberDocIds,
        referenceDocIds: macroSignature.referenceDocIds,
        centroidVector: macroSummary.centroidVector,
        signatureJson: macroSummary.signatureJson,
        retrievalSignatureJson: JSON.stringify(macroSignature),
        topologyJson: macroSummary.topologyJson,
        hierarchyJson: macroSummary.hierarchyJson,
        sourceClusterId: macroSummary.clusterId,
      },
      language: input.language,
    })
    nodes.push(...macroDerivedNodes)

    for (const microId of collectMicroIdsForMacro(input.hierarchical, macroId)) {
      const trace = tracesByMicroId.get(microId)
      const traceOutput = trace?.output
      const memberIndices = collectMemberIndices(microClusters, microId, input.docs.length)
      const memberDocIds = memberIndices.map((docIndex) => input.docs[docIndex]?.id).filter((docId): docId is string => Boolean(docId))
      const referenceDocIds = uniqueDocIds([
        ...(trace?.representativeDocIds ?? []),
        ...(traceOutput?.evidenceDocIds ?? []),
        ...memberDocIds.slice(0, 12),
      ])
      const fallbackLabel = input.language === 'ja'
        ? `${macroSummary.label} / micro ${microId}`
        : `${macroSummary.label} / micro ${microId}`
      const label = compactClusterLabel(traceOutput?.primaryLabel ?? trace?.label, fallbackLabel)
      const summary = compactClusterSummary(traceOutput?.shortSummary ?? trace?.response, label)
      const facetLabels = compactList(traceOutput?.facetLabels ?? [], 8, MAX_CLUSTER_LABEL_CHARS)
      const inclusionCriteria = compactList(traceOutput?.inclusionCriteria ?? [], 8, MAX_CRITERION_CHARS)
      const exclusionCriteria = compactList(traceOutput?.exclusionCriteria ?? [], 8, MAX_CRITERION_CHARS)
      const signature = buildClusterRetrievalSignature({
        taxonomyPath: [macroSummary.label, label],
        label,
        summary,
        keywords: facetLabels,
        facetLabels,
        inclusionCriteria,
        exclusionCriteria,
        referenceDocIds,
        topologyJson: traceOutput?.topology ? JSON.stringify(traceOutput.topology) : undefined,
        language: input.language,
      })
      const retrievalText = buildRetrievalText({
        label,
        summary,
        keywords: facetLabels,
        facetLabels,
        inclusionCriteria,
        exclusionCriteria,
        generatedQuestions: signature.generatedQuestions,
        retrievalIntents: signature.retrievalIntents,
      })
      const microNode: RaptorRetrievalNode = {
        id: `${macroSummary.clusterId}__micro-${microId}`,
        nodeKind: 'micro',
        level: 2,
        clusterId: macroSummary.clusterId,
        parentId: macroSummary.clusterId,
        childIds: [],
        label,
        summary,
        keywords: facetLabels,
        retrievalText,
        generatedQuestions: signature.generatedQuestions,
        retrievalIntents: signature.retrievalIntents,
        facetLabels,
        inclusionCriteria,
        exclusionCriteria,
        memberDocIds,
        referenceDocIds: signature.referenceDocIds,
        centroidVector: Array.from(microClusters.centroids[microId] ?? []),
        signatureJson: traceOutput ? JSON.stringify(traceOutput) : undefined,
        retrievalSignatureJson: JSON.stringify(signature),
        topologyJson: traceOutput?.topology ? JSON.stringify(traceOutput.topology) : undefined,
        hierarchyJson: JSON.stringify({ level: 'micro', parentClusterId: macroSummary.clusterId, childCount: 0 }),
        sourceClusterId: macroSummary.clusterId,
        localClusterId: `micro-${microId}`,
      }
      const derivedNodes = buildDerivedRaptorChildNodes({ parent: microNode, language: input.language })
      microNode.childIds = derivedNodes.map((node) => node.id)
      nodes.push(microNode, ...derivedNodes)
    }
  }

  return nodes
}

function buildDerivedRaptorChildNodes(input: {
  parent: RaptorRetrievalNode
  language: Language
}): RaptorRetrievalNode[] {
  const parent = input.parent
  const questionNodes = parent.generatedQuestions.slice(0, 3).map((question, questionIndex): RaptorRetrievalNode => ({
    id: `${parent.id}__question-${questionIndex}`,
    nodeKind: 'retrieval-question',
    level: parent.level + 1,
    clusterId: parent.clusterId,
    parentId: parent.id,
    childIds: [],
    label: question,
    summary: parent.summary,
    keywords: parent.keywords,
    retrievalText: buildRetrievalText({
      label: question,
      summary: parent.summary,
      keywords: parent.keywords,
      facetLabels: parent.facetLabels,
      facetSummaries: parent.facetSummaries,
      inclusionCriteria: parent.inclusionCriteria,
      exclusionCriteria: parent.exclusionCriteria,
      generatedQuestions: [question],
      retrievalIntents: uniqueStrings(['question-answering', ...parent.retrievalIntents]),
    }),
    generatedQuestions: [question],
    retrievalIntents: uniqueStrings(['question-answering', ...parent.retrievalIntents]),
    facetLabels: parent.facetLabels,
    facetSummaries: parent.facetSummaries,
    inclusionCriteria: parent.inclusionCriteria,
    exclusionCriteria: parent.exclusionCriteria,
    memberDocIds: parent.memberDocIds.slice(0, 500),
    referenceDocIds: parent.referenceDocIds,
    centroidVector: parent.centroidVector,
    signatureJson: parent.signatureJson,
    retrievalSignatureJson: parent.retrievalSignatureJson,
    topologyJson: parent.topologyJson,
    hierarchyJson: parent.hierarchyJson,
    sourceClusterId: parent.sourceClusterId,
    localClusterId: parent.localClusterId,
  }))

  const facetNodes = parent.facetLabels.slice(0, 4).map((facet, facetIndex): RaptorRetrievalNode => {
    const facetSummary = parent.facetSummaries?.[facetIndex] ?? facet
    const facetQuery = input.language === 'ja'
      ? `${parent.label} ${facet} 関連文書`
      : `${parent.label} ${facet} related documents`
    return {
      id: `${parent.id}__facet-${facetIndex}`,
      nodeKind: 'facet',
      level: parent.level + 1,
      clusterId: parent.clusterId,
      parentId: parent.id,
      childIds: [],
      label: facet,
      summary: facetSummary,
      keywords: uniqueStrings([facet, ...parent.keywords]),
      retrievalText: buildRetrievalText({
        label: facet,
        summary: facetSummary,
        keywords: parent.keywords,
        facetLabels: [facet],
        facetSummaries: [facetSummary],
        inclusionCriteria: parent.inclusionCriteria,
        exclusionCriteria: parent.exclusionCriteria,
        generatedQuestions: [facetQuery],
        retrievalIntents: uniqueStrings(['facet', ...parent.retrievalIntents]),
      }),
      generatedQuestions: [facetQuery],
      retrievalIntents: uniqueStrings(['facet', ...parent.retrievalIntents]),
      facetLabels: [facet],
      facetSummaries: [facetSummary],
      inclusionCriteria: parent.inclusionCriteria,
      exclusionCriteria: parent.exclusionCriteria,
      memberDocIds: parent.memberDocIds.slice(0, 500),
      referenceDocIds: parent.referenceDocIds,
      centroidVector: parent.centroidVector,
      signatureJson: parent.signatureJson,
      retrievalSignatureJson: parent.retrievalSignatureJson,
      topologyJson: parent.topologyJson,
      hierarchyJson: parent.hierarchyJson,
      sourceClusterId: parent.sourceClusterId,
      localClusterId: parent.localClusterId,
    }
  })

  return [...questionNodes, ...facetNodes]
}

function parseSignatureFromSummary(summary: ClusterSummary): ClusterSemanticSignature {
  const fallbackLabel = summary.clusterId || 'Cluster'
  const fallback: ClusterSemanticSignature = {
    primaryLabel: compactClusterLabel(summary.label, fallbackLabel),
    shortSummary: compactClusterSummary(summary.summary, fallbackLabel),
    facets: (summary.facetLabels ?? []).map((label, index) => ({
      label: compactClusterLabel(label, fallbackLabel),
      summary: compactInlineText(summary.facetSummaries?.[index] ?? label, MAX_FACET_SUMMARY_CHARS),
      keywords: compactList(summary.keywords, 8, MAX_KEYWORD_CHARS),
      supportRatio: 0,
      representativeDocIds: [],
    })),
    inclusionCriteria: compactList(summary.inclusionCriteria ?? [], 8, MAX_CRITERION_CHARS),
    exclusionCriteria: compactList(summary.exclusionCriteria ?? [], 8, MAX_CRITERION_CHARS),
    evidenceDocIds: [],
    splitCandidate: false,
  }
  if (!summary.signatureJson) return fallback
  try {
    return normalizeSignature(JSON.parse(summary.signatureJson), fallback)
  } catch {
    return fallback
  }
}

function buildHierarchicalAggregationPrompt(input: {
  macroId: number
  memberCount: number
  children: MicroSignatureInput[]
  siblingContexts: string[]
  topologyMetric?: EmbeddingTopologyClusterMetric
  language: Language
  tokenBudget: number
}): string {
  const childPayload = input.children.map((child) => ({
    clusterId: child.clusterId,
    documentCount: child.documentCount,
    primaryLabel: child.signature.primaryLabel,
    shortSummary: child.signature.shortSummary,
    facets: child.signature.facets.slice(0, 5),
    inclusionCriteria: child.signature.inclusionCriteria.slice(0, 6),
    exclusionCriteria: child.signature.exclusionCriteria.slice(0, 6),
    splitCandidate: child.signature.splitCandidate,
  }))
  const childJson = truncateToTokenLimit(JSON.stringify(childPayload, null, 2), input.tokenBudget)

  if (input.language === 'ja') {
    return `macro cluster-${input.macroId} の ClusterSemanticSignature を生成してください。\n\n` +
      `## Macro cluster\n- 文書数: ${input.memberCount}\n- child micro clusters: ${input.children.length}\n\n` +
      `## Embedding Topology Analysis (ETA)\n${formatTopologyMetricForPrompt(input.topologyMetric, 'ja')}\n\n` +
      `## 近接する兄弟 macro cluster\n${input.siblingContexts.join('\n') || 'N/A'}\n\n` +
      `## Child micro signatures\n${childJson}\n\n` +
      `## 集約要件\n- child micro signatures の共通上位概念を primaryLabel にする。\n- child の一部だけに出る固有名を macro 全体の primaryLabel にしない。\n- facets は child micro signature の主要観点を supportRatio 付きで 2〜5 件に統合する。\n- inclusionCriteria / exclusionCriteria は兄弟 macro cluster と区別できる条件にする。\n- ETA が overlapping/diffuse または needsSplit=true の場合は splitCandidate=true を検討し、facets を増やして混合性を説明する。\n- 出力 JSON の evidenceDocIds は child micro signatures に含まれる evidenceDocIds だけから選ぶ。`
  }

  return `Generate a ClusterSemanticSignature for macro cluster-${input.macroId}.\n\n` +
    `## Macro cluster\n- Documents: ${input.memberCount}\n- Child micro clusters: ${input.children.length}\n\n` +
    `## Embedding Topology Analysis (ETA)\n${formatTopologyMetricForPrompt(input.topologyMetric, 'en')}\n\n` +
    `## Similar sibling macro clusters\n${input.siblingContexts.join('\n') || 'N/A'}\n\n` +
    `## Child micro signatures\n${childJson}\n\n` +
    `## Aggregation requirements\n- Use the common higher-level concept across child micro signatures as primaryLabel.\n- Do not promote a proper name that appears in only one child to the whole macro primaryLabel.\n- Merge the main child facets into 2 to 5 macro facets with supportRatio.\n- Make inclusionCriteria / exclusionCriteria distinguish this macro from sibling macro clusters.\n- If ETA is overlapping/diffuse or needsSplit=true, consider splitCandidate=true and explain mixedness with facets.\n- evidenceDocIds must come only from child micro signature evidenceDocIds.`
}

function buildContentFilterSafeMicroChildren(input: {
  children: MicroSignatureInput[]
  language: Language
  includeLabels: boolean
}): MicroSignatureInput[] {
  return input.children.map((child) => {
    const genericSummary = input.language === 'ja'
      ? `${child.documentCount} 件の文書を含む micro cluster です。`
      : `Micro cluster containing ${child.documentCount} documents.`
    const primaryLabel = input.includeLabels
      ? compactClusterLabel(child.signature.primaryLabel, child.clusterId)
      : child.clusterId
    const shortSummary = input.includeLabels
      ? compactClusterSummary(child.signature.shortSummary, genericSummary)
      : genericSummary
    const facets = input.includeLabels
      ? child.signature.facets.slice(0, 5).map((facet) => ({
          label: compactClusterLabel(facet.label, primaryLabel),
          summary: compactInlineText(facet.summary || facet.label, MAX_FACET_SUMMARY_CHARS),
          keywords: compactList(facet.keywords, 8, MAX_KEYWORD_CHARS),
          supportRatio: facet.supportRatio,
          representativeDocIds: facet.representativeDocIds,
        }))
      : []
    return {
      clusterId: child.clusterId,
      documentCount: child.documentCount,
      signature: {
        primaryLabel,
        shortSummary,
        facets,
        inclusionCriteria: input.includeLabels ? compactList(child.signature.inclusionCriteria, 6, MAX_CRITERION_CHARS) : [],
        exclusionCriteria: input.includeLabels ? compactList(child.signature.exclusionCriteria, 6, MAX_CRITERION_CHARS) : [],
        evidenceDocIds: child.signature.evidenceDocIds,
        splitCandidate: child.signature.splitCandidate,
      },
    }
  })
}

function buildHierarchicalAggregationContentFilterRetryUserPrompts(input: {
  macroId: number
  memberCount: number
  children: MicroSignatureInput[]
  siblingContexts: string[]
  topologyMetric?: EmbeddingTopologyClusterMetric
  language: Language
  tokenBudget: number
}): string[] {
  return [
    buildHierarchicalAggregationPrompt({
      ...input,
      children: buildContentFilterSafeMicroChildren({ children: input.children, language: input.language, includeLabels: true }),
    }),
    buildHierarchicalAggregationPrompt({
      ...input,
      children: buildContentFilterSafeMicroChildren({ children: input.children, language: input.language, includeLabels: false }),
    }),
  ]
}

function buildMacroRepresentativeText(children: MicroSignatureInput[]): string {
  return children.map((child) => {
    const facets = child.signature.facets.map((facet) => `${facet.label}: ${facet.summary}`).join('\n')
    return `### ${child.clusterId} (${child.documentCount} docs)\n${child.signature.primaryLabel}\n${child.signature.shortSummary}\n${facets}`
  }).join('\n\n')
}

function collectMemberIndices(clusters: ClusterResult, clusterId: number, docCount: number): number[] {
  const indices: number[] = []
  for (let docIndex = 0; docIndex < docCount; docIndex++) {
    if (clusters.labels[docIndex] === clusterId) indices.push(docIndex)
  }
  return indices
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized || seen.has(normalized.toLowerCase())) continue
    seen.add(normalized.toLowerCase())
    result.push(normalized)
  }
  return result
}

function buildEvidenceBlocks(input: {
  evidence: ClusterEvidenceCandidate[]
  docs: Array<{ id: string; title: string; vector: Float32Array }>
  representativeTexts: Map<string, string>
  tokenBudget: number
}): EvidenceBlock[] {
  const blocks: EvidenceBlock[] = []
  let usedTokens = 0
  for (const item of input.evidence) {
    const doc = input.docs[item.index]
    const rawText = input.representativeTexts.get(doc.id) || doc.title
    const remaining = input.tokenBudget - usedTokens
    if (remaining <= 0) break
    const text = truncateToTokenLimit(rawText, Math.min(remaining, 900))
    const tokens = countTokens(text)
    if (tokens <= 0) continue
    blocks.push({ role: item.role, docId: doc.id, title: doc.title, text })
    usedTokens += tokens
  }
  return blocks
}

function buildContentFilterSafeEvidenceBlocks(input: {
  evidenceBlocks: EvidenceBlock[]
  language: Language
  includeTitles: boolean
}): EvidenceBlock[] {
  const omittedText = input.language === 'ja'
    ? '[本文は content filter 再試行のため省略]'
    : '[Content omitted for content-filter retry]'
  return input.evidenceBlocks.map((block) => {
    const title = input.includeTitles ? (compactEvidenceTitle(block.title) ?? block.docId) : block.docId
    return {
      role: block.role,
      docId: block.docId,
      title,
      text: omittedText,
    }
  })
}

function buildV2ContentFilterRetryUserPrompts(input: {
  language: Language
  evidenceBlocks: EvidenceBlock[]
  siblingContexts: string[]
  evidenceStats: { memberCount: number; evidenceCount: number; roleCounts: Record<string, number>; distinctTitleCount: number }
  topologyMetric?: EmbeddingTopologyClusterMetric
}): string[] {
  const titleOnlyBlocks = buildContentFilterSafeEvidenceBlocks({
    evidenceBlocks: input.evidenceBlocks,
    language: input.language,
    includeTitles: true,
  })
  const idOnlyBlocks = buildContentFilterSafeEvidenceBlocks({
    evidenceBlocks: input.evidenceBlocks,
    language: input.language,
    includeTitles: false,
  })
  const titleOnlyStats = buildEvidenceStats({ memberCount: input.evidenceStats.memberCount, evidenceBlocks: titleOnlyBlocks })
  const idOnlyStats = buildEvidenceStats({ memberCount: input.evidenceStats.memberCount, evidenceBlocks: idOnlyBlocks })

  return input.language === 'ja'
    ? [
        buildJapaneseV2Prompt({
          evidenceBlocks: titleOnlyBlocks,
          siblingContexts: input.siblingContexts,
          evidenceStats: titleOnlyStats,
          topologyMetric: input.topologyMetric,
        }),
        buildJapaneseV2Prompt({
          evidenceBlocks: idOnlyBlocks,
          siblingContexts: input.siblingContexts,
          evidenceStats: idOnlyStats,
          topologyMetric: input.topologyMetric,
        }),
      ]
    : [
        buildEnglishV2Prompt({
          evidenceBlocks: titleOnlyBlocks,
          siblingContexts: input.siblingContexts,
          evidenceStats: titleOnlyStats,
          topologyMetric: input.topologyMetric,
        }),
        buildEnglishV2Prompt({
          evidenceBlocks: idOnlyBlocks,
          siblingContexts: input.siblingContexts,
          evidenceStats: idOnlyStats,
          topologyMetric: input.topologyMetric,
        }),
      ]
}

function buildSiblingContexts(input: {
  clusterId: number
  clusters: ClusterResult
  language: Language
}): string[] {
  const centroid = input.clusters.centroids[input.clusterId]
  return input.clusters.centroids
    .map((candidateCentroid, candidateClusterId) => ({
      candidateClusterId,
      similarity: candidateClusterId === input.clusterId ? -Infinity : cosineForPrompt(centroid, candidateCentroid),
    }))
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 3)
    .map(({ candidateClusterId, similarity }) => {
      return input.language === 'ja'
        ? `cluster-${candidateClusterId}: centroid 類似度 ${similarity.toFixed(3)}, 文書数 ${input.clusters.counts[candidateClusterId] ?? 0}`
        : `cluster-${candidateClusterId}: centroid similarity ${similarity.toFixed(3)}, documents ${input.clusters.counts[candidateClusterId] ?? 0}`
    })
}

function cosineForPrompt(leftVector: ArrayLike<number>, rightVector: ArrayLike<number>): number {
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let dimIndex = 0; dimIndex < leftVector.length; dimIndex++) {
    dot += leftVector[dimIndex] * rightVector[dimIndex]
    leftNorm += leftVector[dimIndex] * leftVector[dimIndex]
    rightNorm += rightVector[dimIndex] * rightVector[dimIndex]
  }
  const denominator = Math.sqrt(leftNorm) * Math.sqrt(rightNorm)
  return denominator === 0 ? 0 : dot / denominator
}

function buildEvidenceStats(input: {
  memberCount: number
  evidenceBlocks: EvidenceBlock[]
}): { memberCount: number; evidenceCount: number; roleCounts: Record<string, number>; distinctTitleCount: number } {
  const roleCounts: Record<string, number> = {}
  const titles = new Set<string>()
  for (const block of input.evidenceBlocks) {
    roleCounts[block.role] = (roleCounts[block.role] ?? 0) + 1
    const title = block.title.trim().toLowerCase()
    if (title) titles.add(title)
  }
  return {
    memberCount: input.memberCount,
    evidenceCount: input.evidenceBlocks.length,
    roleCounts,
    distinctTitleCount: titles.size,
  }
}

function buildJapaneseV2Prompt(input: {
  evidenceBlocks: EvidenceBlock[]
  siblingContexts: string[]
  evidenceStats: { memberCount: number; evidenceCount: number; roleCounts: Record<string, number>; distinctTitleCount: number }
  topologyMetric?: EmbeddingTopologyClusterMetric
}): string {
  return `以下のクラスタについて、EFLC v2 の ClusterSemanticSignature を生成してください。\n\n` +
    `## クラスタ規模と evidence 分布\n- クラスタ全体の文書数: ${input.evidenceStats.memberCount}\n- evidence 文書数: ${input.evidenceStats.evidenceCount}\n- evidence role 分布: ${Object.entries(input.evidenceStats.roleCounts).map(([role, count]) => `${role}=${count}`).join(', ') || 'N/A'}\n- evidence の distinct title 数: ${input.evidenceStats.distinctTitleCount}\n\n` +
    `## Embedding Topology Analysis (ETA)\n${formatTopologyMetricForPrompt(input.topologyMetric, 'ja')}\n\n` +
    `## 近接する兄弟クラスタ (混同防止)\n${input.siblingContexts.join('\n') || 'N/A'}\n\n` +
    `## 証拠文書\n${input.evidenceBlocks.map((block, index) => `### Evidence ${index + 1} [${block.role}] ${block.docId}\nTitle: ${block.title}\n${block.text}`).join('\n\n')}\n\n` +
    `## 出力要件\n- primaryLabel は具体的で、兄弟クラスタと区別できる短い日本語にする。\n- primaryLabel / shortSummary / facets は、クラスタ全体の ${input.evidenceStats.memberCount} 件を表す前提で作る。\n- 単一の人物・企業・作品・団体を primaryLabel にしてよいのは、複数 role の evidence で反復し、クラスタ全体を代表すると説明できる場合だけ。\n- evidence の一部だけに出る固有名は facet または representativeDocIds 側に留め、クラスタ全体のラベルにしない。\n- facets は 2〜5 件。証拠文書内で確認できる観点だけに基づく。\n- inclusionCriteria は、このクラスタに含める条件を 2〜5 件。\n- exclusionCriteria は、似ているが除外すべき条件を 2〜5 件。\n- 証拠にない製品名、技術名、カテゴリは追加しない。`
}

function buildEnglishV2Prompt(input: {
  evidenceBlocks: EvidenceBlock[]
  siblingContexts: string[]
  evidenceStats: { memberCount: number; evidenceCount: number; roleCounts: Record<string, number>; distinctTitleCount: number }
  topologyMetric?: EmbeddingTopologyClusterMetric
}): string {
  return `Generate an EFLC v2 ClusterSemanticSignature for this cluster.\n\n` +
    `## Cluster Size and Evidence Distribution\n- Total cluster documents: ${input.evidenceStats.memberCount}\n- Evidence documents: ${input.evidenceStats.evidenceCount}\n- Evidence role counts: ${Object.entries(input.evidenceStats.roleCounts).map(([role, count]) => `${role}=${count}`).join(', ') || 'N/A'}\n- Distinct evidence titles: ${input.evidenceStats.distinctTitleCount}\n\n` +
    `## Embedding Topology Analysis (ETA)\n${formatTopologyMetricForPrompt(input.topologyMetric, 'en')}\n\n` +
    `## Similar Sibling Clusters\n${input.siblingContexts.join('\n') || 'N/A'}\n\n` +
    `## Evidence Documents\n${input.evidenceBlocks.map((block, index) => `### Evidence ${index + 1} [${block.role}] ${block.docId}\nTitle: ${block.title}\n${block.text}`).join('\n\n')}\n\n` +
    `## Requirements\n- Make primaryLabel concrete and distinguishable from sibling clusters.\n- primaryLabel / shortSummary / facets must describe the full ${input.evidenceStats.memberCount}-document cluster.\n- Use a single person, company, work, or organization as primaryLabel only when it repeats across multiple evidence roles and can be justified as representing the whole cluster.\n- If a proper name appears only in part of the evidence, keep it inside facets or representativeDocIds, not as the whole-cluster label.\n- Produce 2 to 5 facets grounded only in evidence documents.\n- Produce 2 to 5 inclusionCriteria and exclusionCriteria.\n- Do not introduce unsupported product names, technologies, or categories.`
}

function formatTopologyMetricForPrompt(metric: EmbeddingTopologyClusterMetric | undefined, language: Language): string {
  if (!metric) return 'N/A'
  if (language === 'ja') {
    return [
      `- topologyLabel: ${metric.topologyLabel}`,
      `- cohesionScore: ${metric.cohesionScore}`,
      `- separationScore: ${metric.separationScore}`,
      `- boundaryRatio: ${metric.boundaryRatio}`,
      `- outlierRatio: ${metric.outlierRatio}`,
      `- ambiguityScore: ${metric.ambiguityScore}`,
      `- nearestCluster: ${metric.nearestClusterId === undefined ? 'N/A' : `cluster-${metric.nearestClusterId} (${metric.nearestClusterSimilarity?.toFixed(3) ?? 'N/A'})`}`,
      `- needsSplit: ${metric.needsSplit}`,
      '- topologyLabel が overlapping/diffuse、または needsSplit=true の場合は、単一ラベルに無理に圧縮せず facets と splitCandidate に反映する。',
    ].join('\n')
  }
  return [
    `- topologyLabel: ${metric.topologyLabel}`,
    `- cohesionScore: ${metric.cohesionScore}`,
    `- separationScore: ${metric.separationScore}`,
    `- boundaryRatio: ${metric.boundaryRatio}`,
    `- outlierRatio: ${metric.outlierRatio}`,
    `- ambiguityScore: ${metric.ambiguityScore}`,
    `- nearestCluster: ${metric.nearestClusterId === undefined ? 'N/A' : `cluster-${metric.nearestClusterId} (${metric.nearestClusterSimilarity?.toFixed(3) ?? 'N/A'})`}`,
    `- needsSplit: ${metric.needsSplit}`,
    '- If topologyLabel is overlapping/diffuse or needsSplit=true, do not over-compress; reflect it in facets and splitCandidate.',
  ].join('\n')
}

function fallbackSignature(input: {
  clusterId: number
  memberCount: number
  evidenceBlocks: EvidenceBlock[]
  evidenceDocIds: string[]
  language: Language
}): ClusterSemanticSignature {
  const titleTerms = uniqueStrings(input.evidenceBlocks
    .map((block) => compactEvidenceTitle(block.title))
    .filter((title): title is string => Boolean(title)))
    .slice(0, 3)
  const fallbackLabel = input.language === 'ja' ? `クラスタ ${input.clusterId}` : `Cluster ${input.clusterId}`
  const label = compactClusterLabel(titleTerms[0], fallbackLabel)
  const representativeLabel = titleTerms.join(' / ') || 'N/A'
  const summary = input.language === 'ja'
    ? compactClusterSummary(`${input.memberCount} 件の文書を含むクラスタです。代表文書: ${representativeLabel}。`, `${input.memberCount} 件の文書を含むクラスタです。`)
    : compactClusterSummary(`Cluster containing ${input.memberCount} documents. Representative documents: ${representativeLabel}.`, `Cluster containing ${input.memberCount} documents.`)
  return {
    primaryLabel: label,
    shortSummary: summary,
    facets: titleTerms.slice(0, 3).map((title) => ({
      label: compactClusterLabel(title, fallbackLabel),
      summary: compactInlineText(title, MAX_FACET_SUMMARY_CHARS),
      keywords: compactList([title], 1, MAX_KEYWORD_CHARS),
      supportRatio: 0,
      representativeDocIds: input.evidenceDocIds.slice(0, 5),
    })),
    inclusionCriteria: titleTerms.map((title) => compactInlineText(title, MAX_CRITERION_CHARS)).filter(Boolean),
    exclusionCriteria: [],
    evidenceDocIds: input.evidenceDocIds,
    splitCandidate: false,
  }
}

function normalizeSignature(value: unknown, fallback: ClusterSemanticSignature): ClusterSemanticSignature {
  const obj = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const facetsValue = Array.isArray(obj.facets) ? obj.facets : []
  const facets = facetsValue.map((facetValue) => {
    const facet = facetValue && typeof facetValue === 'object' ? facetValue as Record<string, unknown> : {}
    const facetLabel = compactInlineText(facet.label, MAX_CLUSTER_LABEL_CHARS)
    if (!facetLabel) return null
    return {
      label: facetLabel,
      summary: compactInlineText(facet.summary || facetLabel, MAX_FACET_SUMMARY_CHARS),
      keywords: compactList(facet.keywords, 8, MAX_KEYWORD_CHARS),
      supportRatio: Number(facet.supportRatio ?? 0),
      representativeDocIds: Array.isArray(facet.representativeDocIds) ? facet.representativeDocIds.map(String).filter(Boolean) : [],
    }
  }).filter((facet): facet is ClusterFacet => Boolean(facet)).slice(0, 6)

  return {
    primaryLabel: compactClusterLabel(obj.primaryLabel || fallback.primaryLabel, fallback.primaryLabel),
    shortSummary: compactClusterSummary(obj.shortSummary || fallback.shortSummary, fallback.shortSummary),
    facets: facets.length > 0 ? facets : fallback.facets,
    inclusionCriteria: Array.isArray(obj.inclusionCriteria) ? compactList(obj.inclusionCriteria, 8, MAX_CRITERION_CHARS) : fallback.inclusionCriteria,
    exclusionCriteria: Array.isArray(obj.exclusionCriteria) ? compactList(obj.exclusionCriteria, 8, MAX_CRITERION_CHARS) : fallback.exclusionCriteria,
    evidenceDocIds: Array.isArray(obj.evidenceDocIds) ? obj.evidenceDocIds.map(String).filter(Boolean) : fallback.evidenceDocIds,
    splitCandidate: Boolean(obj.splitCandidate ?? fallback.splitCandidate),
  }
}

function scoreSignature(input: { signature: ClusterSemanticSignature; topologyMetric?: EmbeddingTopologyClusterMetric }): ClusterSignatureQuality {
  const labelText = `${input.signature.primaryLabel} ${input.signature.shortSummary} ${input.signature.facets.map((facet) => facet.label).join(' ')}`.toLowerCase()
  const genericWords = ['document', 'documents', 'data', 'information', 'content', '文書', '情報', 'データ', '内容']
  const genericMatches = genericWords.filter((word) => labelText.includes(word)).length
  const specificityScore = input.signature.primaryLabel.trim().length > 0 && input.signature.primaryLabel.length <= 60 ? 1 : 0
  const genericityScore = genericMatches / genericWords.length
  const topologySplitBoost = input.topologyMetric?.needsSplit ? 0.35 : 0
  const topologyAmbiguityBoost = Math.min(0.25, (input.topologyMetric?.ambiguityScore ?? 0) * 0.25)
  const splitScore = Math.min(1, (input.signature.facets.length > 5 ? 0.4 : 0) + (input.signature.splitCandidate ? 0.6 : 0) + topologySplitBoost + topologyAmbiguityBoost)
  const needsRepair = specificityScore < 0.15 || genericityScore > 0.45 || splitScore > 0.78
  return {
    specificityScore: Number(specificityScore.toFixed(3)),
    genericityScore: Number(genericityScore.toFixed(3)),
    splitScore: Number(splitScore.toFixed(3)),
    needsRepair,
    repairReason: needsRepair ? 'low-specificity-or-high-genericity' : undefined,
    topology: input.topologyMetric
      ? {
          cohesionScore: input.topologyMetric.cohesionScore,
          separationScore: input.topologyMetric.separationScore,
          boundaryRatio: input.topologyMetric.boundaryRatio,
          outlierRatio: input.topologyMetric.outlierRatio,
          ambiguityScore: input.topologyMetric.ambiguityScore,
          topologyLabel: input.topologyMetric.topologyLabel,
          needsSplit: input.topologyMetric.needsSplit,
        }
      : undefined,
  }
}

function buildV2TraceSteps(input: {
  clusterId: number
  traceLevel: 'flat' | 'micro'
  memberCount: number
  clusterCount: number
  evidenceStats: { memberCount: number; evidenceCount: number; roleCounts: Record<string, number>; distinctTitleCount: number }
  evidenceDocIds: string[]
  topologyMetric?: EmbeddingTopologyClusterMetric
  siblingContexts: string[]
  traceError: string | null
  tracePromptTokens: number
  traceCompletionTokens: number
  traceTotalTokens: number
  traceDurationMs: number
  tokenBudget: number
  signature: ClusterSemanticSignature
  quality: ClusterSignatureQuality
  hierarchy: MetaTraceOutput['hierarchy']
}): MetaTraceStep[] {
  const steps: MetaTraceStep[] = []
  pushTraceStep(steps, 'member-collection', 'created', {
    metrics: {
      mode: input.traceLevel === 'micro' ? 'eflc-v2-micro' : 'eflc-v2-flat',
      clusterId: `cluster-${input.clusterId}`,
      memberDocuments: input.memberCount,
      totalClusters: input.clusterCount,
    },
  })
  pushTraceStep(steps, 'evidence-selection', 'created', {
    metrics: {
      strategy: 'role-aware-evidence',
      evidenceDocuments: input.evidenceStats.evidenceCount,
      distinctEvidenceTitles: input.evidenceStats.distinctTitleCount,
      roleDistribution: formatRoleCounts(input.evidenceStats.roleCounts),
      tokenBudget: input.tokenBudget,
    },
    docIds: input.evidenceDocIds,
  })
  pushTraceStep(steps, 'topology-analysis', input.topologyMetric?.needsSplit ? 'modified' : 'enriched', {
    metrics: buildTopologyTraceMetrics(input.topologyMetric),
    reason: input.topologyMetric?.needsSplit ? 'topology-suggests-split-or-mixed-signature' : undefined,
  })
  pushTraceStep(steps, 'sibling-contrast', 'enriched', {
    metrics: { siblingContextCount: input.siblingContexts.length },
    output: input.siblingContexts.join('\n') || 'N/A',
  })
  pushTraceStep(steps, 'llm-signature', input.traceError ? 'rejected' : 'created', {
    metrics: {
      promptTokens: input.tracePromptTokens,
      completionTokens: input.traceCompletionTokens,
      totalTokens: input.traceTotalTokens,
      durationMs: input.traceDurationMs,
    },
    reason: input.traceError ?? undefined,
    output: formatSignatureTraceOutput(input.signature),
  })
  pushTraceStep(steps, 'quality-scoring', input.quality.needsRepair ? 'modified' : 'kept', {
    metrics: buildQualityTraceMetrics(input.quality),
    reason: input.quality.repairReason,
  })
  pushTraceStep(steps, 'meta-document', 'enriched', {
    metrics: {
      summaryVersion: 'v2',
      hierarchyLevel: input.hierarchy?.level ?? input.traceLevel,
      facetCount: input.signature.facets.length,
      inclusionCriteria: input.signature.inclusionCriteria.length,
      exclusionCriteria: input.signature.exclusionCriteria.length,
      evidenceDocIds: input.signature.evidenceDocIds.length,
    },
    output: 'label, summary, keywords, signatureJson, qualityJson, topologyJson, hierarchyJson',
  })
  return steps
}

function buildHsaTraceSteps(input: {
  macroId: number
  memberCount: number
  macroClusterCount: number
  children: MicroSignatureInput[]
  hierarchyPayload: { childClusterIds: string[]; childDocumentCounts: number[]; childCount: number; strategy: string }
  topologyMetric?: EmbeddingTopologyClusterMetric
  siblingContexts: string[]
  traceError: string | null
  tracePromptTokens: number
  traceCompletionTokens: number
  traceTotalTokens: number
  traceDurationMs: number
  signature: ClusterSemanticSignature
  quality: ClusterSignatureQuality
  hierarchy: MetaTraceOutput['hierarchy']
}): MetaTraceStep[] {
  const steps: MetaTraceStep[] = []
  pushTraceStep(steps, 'member-collection', 'created', {
    metrics: {
      mode: 'eflc-v2-hierarchical-macro',
      clusterId: `cluster-${input.macroId}`,
      memberDocuments: input.memberCount,
      totalClusters: input.macroClusterCount,
    },
  })
  pushTraceStep(steps, 'hierarchical-aggregation', 'created', {
    metrics: {
      strategy: input.hierarchyPayload.strategy,
      childMicroClusters: input.hierarchyPayload.childCount,
      childDocumentCounts: input.hierarchyPayload.childDocumentCounts.join(', '),
    },
    input: input.children
      .map((child) => `${child.clusterId}: ${child.signature.primaryLabel} (${child.documentCount} docs)`)
      .join('\n'),
    docIds: input.hierarchyPayload.childClusterIds,
    output: formatSignatureTraceOutput(input.signature),
  })
  pushTraceStep(steps, 'topology-analysis', input.topologyMetric?.needsSplit ? 'modified' : 'enriched', {
    metrics: buildTopologyTraceMetrics(input.topologyMetric),
    reason: input.topologyMetric?.needsSplit ? 'topology-suggests-split-or-mixed-signature' : undefined,
  })
  pushTraceStep(steps, 'sibling-contrast', 'enriched', {
    metrics: { siblingContextCount: input.siblingContexts.length },
    output: input.siblingContexts.join('\n') || 'N/A',
  })
  pushTraceStep(steps, 'llm-signature', input.traceError ? 'rejected' : 'created', {
    metrics: {
      promptTokens: input.tracePromptTokens,
      completionTokens: input.traceCompletionTokens,
      totalTokens: input.traceTotalTokens,
      durationMs: input.traceDurationMs,
    },
    reason: input.traceError ?? undefined,
    output: formatSignatureTraceOutput(input.signature),
  })
  pushTraceStep(steps, 'quality-scoring', input.quality.needsRepair ? 'modified' : 'kept', {
    metrics: buildQualityTraceMetrics(input.quality),
    reason: input.quality.repairReason,
  })
  pushTraceStep(steps, 'meta-document', 'enriched', {
    metrics: {
      summaryVersion: 'v2',
      hierarchyLevel: input.hierarchy?.level ?? 'macro',
      childMicroClusters: input.hierarchy?.childCount ?? input.hierarchyPayload.childCount,
      facetCount: input.signature.facets.length,
      inclusionCriteria: input.signature.inclusionCriteria.length,
      exclusionCriteria: input.signature.exclusionCriteria.length,
      evidenceDocIds: input.signature.evidenceDocIds.length,
    },
    output: 'label, summary, keywords, signatureJson, qualityJson, topologyJson, hierarchyJson',
  })
  return steps
}

function pushTraceStep(
  steps: MetaTraceStep[],
  phase: MetaTracePhase,
  action: MetaTraceAction,
  detail?: MetaTraceStepDetail,
): void {
  steps.push({
    step: steps.length + 1,
    phase,
    action,
    timestamp: new Date().toISOString(),
    detail,
  })
}

function buildTraceOutput(input: {
  signature: ClusterSemanticSignature
  keywords?: string[]
  quality?: ClusterSignatureQuality
  topologyMetric?: EmbeddingTopologyClusterMetric
  hierarchy?: MetaTraceOutput['hierarchy']
}): MetaTraceOutput {
  return {
    primaryLabel: input.signature.primaryLabel,
    shortSummary: input.signature.shortSummary,
    facetLabels: input.signature.facets.map((facet) => facet.label),
    inclusionCriteria: input.signature.inclusionCriteria,
    exclusionCriteria: input.signature.exclusionCriteria,
    evidenceDocIds: input.signature.evidenceDocIds,
    keywords: input.keywords,
    quality: input.quality,
    topology: input.topologyMetric,
    hierarchy: input.hierarchy,
  }
}

function buildTopologyTraceMetrics(metric: EmbeddingTopologyClusterMetric | undefined): Record<string, string | number | boolean> {
  if (!metric) return { topology: 'N/A' }
  return {
    topologyLabel: metric.topologyLabel,
    documentCount: metric.documentCount,
    cohesionScore: metric.cohesionScore,
    separationScore: metric.separationScore,
    boundaryRatio: metric.boundaryRatio,
    outlierRatio: metric.outlierRatio,
    ambiguityScore: metric.ambiguityScore,
    nearestClusterId: metric.nearestClusterId === undefined ? 'N/A' : `cluster-${metric.nearestClusterId}`,
    nearestClusterSimilarity: metric.nearestClusterSimilarity ?? 'N/A',
    internalNeighborRatio: metric.internalNeighborRatio ?? 'N/A',
    crossClusterNeighborRatio: metric.crossClusterNeighborRatio ?? 'N/A',
    needsSplit: metric.needsSplit,
  }
}

function buildQualityTraceMetrics(quality: ClusterSignatureQuality): Record<string, string | number | boolean> {
  return {
    specificityScore: quality.specificityScore,
    genericityScore: quality.genericityScore,
    splitScore: quality.splitScore,
    needsRepair: quality.needsRepair,
    repairReason: quality.repairReason ?? 'N/A',
  }
}

function formatSignatureTraceOutput(signature: ClusterSemanticSignature): string {
  const facets = signature.facets.map((facet) => facet.label).join(', ') || 'N/A'
  return [
    `primaryLabel: ${signature.primaryLabel}`,
    `shortSummary: ${signature.shortSummary}`,
    `facets: ${facets}`,
    `splitCandidate: ${signature.splitCandidate}`,
  ].join('\n')
}

function formatRoleCounts(roleCounts: Record<string, number>): string {
  return Object.entries(roleCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([role, count]) => `${role}=${count}`)
    .join(', ') || 'N/A'
}

// ─── Meta-Index Creation ────────────────────────────────────────────────────

/** Build the meta-index schema definition. */
export function buildMetaIndexSchema(
  metaIndexName: string,
  vectorDimensions: number,
): JsonValue {
  return {
    name: metaIndexName,
    fields: [
      { name: 'id', type: 'Edm.String', key: true, filterable: true },
      { name: 'clusterId', type: 'Edm.String', filterable: true, searchable: false },
      { name: 'nodeKind', type: 'Edm.String', filterable: true, searchable: false },
      { name: 'level', type: 'Edm.Int32', filterable: true, sortable: true },
      { name: 'parentId', type: 'Edm.String', filterable: true, searchable: false },
      {
        name: 'childIds',
        type: 'Collection(Edm.String)',
        searchable: false,
        filterable: true,
      },
      { name: 'sourceClusterId', type: 'Edm.String', filterable: true, searchable: false },
      { name: 'localClusterId', type: 'Edm.String', filterable: true, searchable: false },
      { name: 'label', type: 'Edm.String', searchable: true, filterable: false },
      { name: 'summary', type: 'Edm.String', searchable: true, filterable: false },
      {
        name: 'keywords',
        type: 'Collection(Edm.String)',
        searchable: true,
        filterable: true,
      },
      { name: 'documentCount', type: 'Edm.Int32', sortable: true, filterable: true },
      {
        name: 'memberDocIds',
        type: 'Collection(Edm.String)',
        searchable: false,
        filterable: true,
      },
      {
        name: 'centroidVector',
        type: 'Collection(Edm.Single)',
        searchable: true,
        retrievable: true,
        stored: true,
        dimensions: vectorDimensions,
        vectorSearchProfile: 'eflc-vector-profile',
      },
      { name: 'representativeText', type: 'Edm.String', searchable: true },
      { name: 'retrievalText', type: 'Edm.String', searchable: true },
      {
        name: 'generatedQuestions',
        type: 'Collection(Edm.String)',
        searchable: true,
        filterable: false,
      },
      {
        name: 'retrievalIntents',
        type: 'Collection(Edm.String)',
        searchable: true,
        filterable: true,
      },
      {
        name: 'referenceDocIds',
        type: 'Collection(Edm.String)',
        searchable: false,
        filterable: true,
      },
      { name: 'summaryVersion', type: 'Edm.String', filterable: true, searchable: false },
      {
        name: 'facetLabels',
        type: 'Collection(Edm.String)',
        searchable: true,
        filterable: true,
      },
      {
        name: 'facetSummaries',
        type: 'Collection(Edm.String)',
        searchable: true,
        filterable: false,
      },
      {
        name: 'inclusionCriteria',
        type: 'Collection(Edm.String)',
        searchable: true,
        filterable: false,
      },
      {
        name: 'exclusionCriteria',
        type: 'Collection(Edm.String)',
        searchable: true,
        filterable: false,
      },
      { name: 'signatureJson', type: 'Edm.String', searchable: false, retrievable: true },
      { name: 'retrievalSignatureJson', type: 'Edm.String', searchable: false, retrievable: true },
      { name: 'qualityJson', type: 'Edm.String', searchable: false, retrievable: true },
      { name: 'topologyJson', type: 'Edm.String', searchable: false, retrievable: true },
      { name: 'hierarchyJson', type: 'Edm.String', searchable: false, retrievable: true },
      { name: 'sourceIndex', type: 'Edm.String', filterable: true, searchable: false },
      { name: 'vectorField', type: 'Edm.String', filterable: true, searchable: false },
      { name: 'createdAt', type: 'Edm.DateTimeOffset', filterable: true, sortable: true },
    ],
    vectorSearch: {
      algorithms: [
        {
          name: 'eflc-hnsw',
          kind: 'hnsw',
          hnswParameters: {
            m: 4,
            efConstruction: 200,
            efSearch: 200,
            metric: 'cosine',
          },
        },
      ],
      profiles: [
        {
          name: 'eflc-vector-profile',
          algorithm: 'eflc-hnsw',
        },
      ],
    },
    semantic: {
      configurations: [
        {
          name: 'eflc-semantic',
          prioritizedFields: {
            titleField: { fieldName: 'label' },
            prioritizedContentFields: [
              { fieldName: 'summary' },
              { fieldName: 'retrievalText' },
              { fieldName: 'facetSummaries' },
              { fieldName: 'inclusionCriteria' },
              { fieldName: 'exclusionCriteria' },
              { fieldName: 'representativeText' },
            ],
            prioritizedKeywordsFields: [
              { fieldName: 'keywords' },
              { fieldName: 'facetLabels' },
              { fieldName: 'generatedQuestions' },
              { fieldName: 'retrievalIntents' },
            ],
          },
        },
      ],
    },
  }
}

/** Generate the meta-index name for a given source index. */
export function generateMetaIndexName(sourceIndexName: string): string {
  return `${sourceIndexName}-meta`
}

/**
 * Find existing meta-index for a source index.
 * Checks for `{sourceIndex}-meta`.
 * Also checks legacy format `{sourceIndex}-meta-*` (random suffix) for backward compatibility.
 * Returns the first match, or null if none found.
 */
export async function findMetaIndexName(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  sourceIndexName: string
  language?: Language
}): Promise<string | null> {
  const { profile, apiVersion, sourceIndexName, language } = input
  const exactName = `${sourceIndexName}-meta`

  const result = await listIndexes({ profile, apiVersion, language })
  if (!result.ok || !result.response) return null

  const resp = result.response as Record<string, JsonValue>
  const indexes = resp.value as Array<Record<string, JsonValue>> | undefined
  if (!indexes) return null

  const names = indexes.map((idx) => String(idx.name ?? ''))
  // Prefer exact name, fall back to legacy format with random suffix
  if (names.includes(exactName)) return exactName
  const legacyPrefix = `${sourceIndexName}-meta-`
  const legacy = names.find((n) => n.startsWith(legacyPrefix))
  if (legacy) return legacy
  return null
}

/** Create or update the meta-index in Azure AI Search. */
export async function createMetaIndex(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  metaIndexName: string
  vectorDimensions: number
  language?: Language
}): Promise<RestResult> {
  const schema = buildMetaIndexSchema(input.metaIndexName, input.vectorDimensions)

  return createOrUpdateIndex({
    profile: input.profile,
    indexName: input.metaIndexName,
    apiVersion: input.apiVersion,
    body: schema,
    language: input.language,
  })
}

/** Delete the meta-index. */
export async function deleteMetaIndex(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  metaIndexName: string
  language?: Language
}): Promise<RestResult> {
  return deleteIndex({
    profile: input.profile,
    indexName: input.metaIndexName,
    apiVersion: input.apiVersion,
    language: input.language,
  })
}

// ─── Document Upload to Meta-Index ──────────────────────────────────────────

/** Fetch all existing document keys (id field) from the meta-index. */
export async function fetchExistingMetaDocIds(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  metaIndexName: string
  language?: Language
}): Promise<string[]> {
  const result = await searchDocuments({
    profile: input.profile,
    indexName: input.metaIndexName,
    apiVersion: input.apiVersion,
    body: { search: '*', select: 'id', top: 1000 },
    language: input.language,
  })
  if (!result.ok || !result.response) return []
  const resp = result.response as Record<string, JsonValue>
  const docs = resp.value as Array<Record<string, JsonValue>> | undefined
  if (!docs) return []
  return docs.map((d) => String(d.id ?? '')).filter((s) => s.length > 0)
}

/** Delete documents from the meta-index by their key (id) values. */
export async function deleteMetaDocuments(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  metaIndexName: string
  ids: string[]
  language?: Language
}): Promise<RestResult | null> {
  if (input.ids.length === 0) return null
  const documents = input.ids.map((id) => ({ '@search.action': 'delete', id }))
  return indexDocuments({
    profile: input.profile,
    indexName: input.metaIndexName,
    apiVersion: input.apiVersion,
    body: { value: documents },
    language: input.language,
  })
}

/**
 * Upload cluster summaries as documents to the meta-index.
 *
 * Uses `upload` action (not `mergeOrUpload`) to ensure complete replacement of
 * any existing document with the same key. Per-document failures are detected
 * from the response body and reported as an error.
 */
export async function uploadMetaDocuments(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  metaIndexName: string
  summaries: ClusterSummary[]
  raptorNodes?: RaptorRetrievalNode[]
  metaConfig: MetaIndexConfig
  language?: Language
}): Promise<RestResult> {
  const { profile, apiVersion, metaIndexName, summaries, raptorNodes = [], metaConfig, language = 'en' } = input
  const childIdsByParent = new Map<string, string[]>()
  for (const node of raptorNodes) {
    if (!node.parentId) continue
    const childIds = childIdsByParent.get(node.parentId) ?? []
    childIds.push(node.id)
    childIdsByParent.set(node.parentId, childIds)
  }

  const documents: Array<Record<string, JsonValue>> = summaries.map((s) => {
    const fallbackLabel = s.clusterId || 'Cluster'
    const retrievalSignature = s.retrievalSignatureJson
      ? null
      : buildRetrievalSignatureForSummary(s, language)
    const generatedQuestions = s.generatedQuestions ?? retrievalSignature?.generatedQuestions ?? []
    const retrievalIntents = s.retrievalIntents ?? retrievalSignature?.retrievalIntents ?? []
    const referenceDocIds = s.referenceDocIds ?? retrievalSignature?.referenceDocIds ?? []
    const retrievalText = s.retrievalText ?? buildRetrievalText({
      label: s.label,
      summary: s.summary,
      keywords: s.keywords,
      facetLabels: s.facetLabels ?? [],
      facetSummaries: s.facetSummaries,
      inclusionCriteria: s.inclusionCriteria ?? [],
      exclusionCriteria: s.exclusionCriteria ?? [],
      generatedQuestions,
      retrievalIntents,
    })
    return {
      '@search.action': 'upload',
      id: s.clusterId,
      clusterId: s.clusterId,
      nodeKind: s.nodeKind ?? 'macro',
      level: s.level ?? 1,
      parentId: s.parentId ?? '',
      childIds: s.childIds ?? childIdsByParent.get(s.clusterId) ?? [],
      sourceClusterId: s.sourceClusterId ?? s.clusterId,
      localClusterId: s.localClusterId ?? '',
      label: compactClusterLabel(s.label, fallbackLabel),
      summary: compactClusterSummary(s.summary, fallbackLabel),
      keywords: compactList(s.keywords, 16, MAX_KEYWORD_CHARS),
      documentCount: s.documentCount,
      memberDocIds: s.memberDocIds.slice(0, 1000), // Limit for field size
      referenceDocIds: uniqueDocIds(referenceDocIds).slice(0, 100),
      centroidVector: s.centroidVector,
      // Azure AI Search rejects single terms > 32766 UTF-8 bytes. Keep a safety margin.
      representativeText: truncateUtf8Bytes(s.representativeText, 32_000),
      retrievalText: truncateUtf8Bytes(retrievalText, 32_000),
      generatedQuestions: compactList(generatedQuestions, 8, 180),
      retrievalIntents: compactList(retrievalIntents, 8, MAX_CLUSTER_LABEL_CHARS),
      summaryVersion: s.summaryVersion ?? 'v1',
      facetLabels: compactList(s.facetLabels ?? [], 8, MAX_CLUSTER_LABEL_CHARS),
      facetSummaries: compactList(s.facetSummaries ?? [], 8, MAX_FACET_SUMMARY_CHARS),
      inclusionCriteria: compactList(s.inclusionCriteria ?? [], 8, MAX_CRITERION_CHARS),
      exclusionCriteria: compactList(s.exclusionCriteria ?? [], 8, MAX_CRITERION_CHARS),
      signatureJson: truncateUtf8Bytes(s.signatureJson ?? '', 32_000),
      retrievalSignatureJson: truncateUtf8Bytes(s.retrievalSignatureJson ?? JSON.stringify(retrievalSignature ?? {}), 32_000),
      qualityJson: truncateUtf8Bytes(s.qualityJson ?? '', 32_000),
      topologyJson: truncateUtf8Bytes(s.topologyJson ?? '', 32_000),
      hierarchyJson: truncateUtf8Bytes(s.hierarchyJson ?? '', 32_000),
      sourceIndex: metaConfig.sourceIndexName,
      vectorField: metaConfig.vectorField,
      createdAt: metaConfig.createdAt,
    }
  })
  documents.push(...raptorNodes.map((node) => buildRaptorNodeDocument({ node, metaConfig })))

  const result = await indexDocuments({
    profile,
    indexName: metaIndexName,
    apiVersion,
    body: { value: documents },
    language: input.language,
  })

  // Azure AI Search returns HTTP 200/207 even when individual documents fail.
  // Inspect the response body and surface per-document failures.
  if (result.ok && result.response) {
    const resp = result.response as Record<string, JsonValue>
    const value = resp.value as Array<Record<string, JsonValue>> | undefined
    if (value) {
      const failed = value.filter((v) => v.status !== true)
      if (failed.length > 0) {
        const sample = failed.slice(0, 3).map((f) =>
          `${String(f.key ?? '?')}: ${String(f.errorMessage ?? f.statusCode ?? 'unknown')}`,
        ).join('; ')
        return {
          ok: false,
          status: result.status,
          requestId: result.requestId,
          clientRequestId: result.clientRequestId,
          url: result.url,
          error: {
            message: `${failed.length}/${value.length} documents failed to index. Examples: ${sample}`,
            response: result.response,
          },
        }
      }
    }
  }

  return result
}

// ─── 2-Stage Search ─────────────────────────────────────────────────────────

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function overviewAnswerMessage(language: Language | undefined, ja: string, en: string): string {
  return language === 'ja' ? ja : en
}

function twoStageDocTitleFromFields(id: string, fields: Record<string, JsonValue>): string {
  const titleFields = ['title', 'name', 'chunkTitle', 'metadata_storage_name', 'source', 'filepath', 'fileName']
  for (const fieldName of titleFields) {
    const value = fields[fieldName]
    if (typeof value === 'string' && value.trim()) return compactInlineText(value, 160)
  }
  return id || '(no id)'
}

function isLikelyVectorValue(fieldName: string, value: JsonValue): boolean {
  if (!Array.isArray(value)) return false
  const lowerName = fieldName.toLowerCase()
  if (!lowerName.includes('vector') && !lowerName.includes('embedding')) return false
  return value.length > 16 && value.every((item) => typeof item === 'number')
}

function overviewFieldValueSnippet(value: JsonValue, maxChars: number): string {
  if (typeof value === 'string') return compactInlineText(value, maxChars)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const stringItems = value
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .slice(0, 8)
    if (stringItems.length > 0) return compactInlineText(stringItems.join(', '), maxChars)
  }
  if (value && typeof value === 'object') return compactInlineText(JSON.stringify(value), maxChars)
  return ''
}

function buildOverviewLocalSnippet(fields: Record<string, JsonValue>): string {
  const preferredFields = [
    'content',
    'text',
    'chunk',
    'chunkContent',
    'description',
    'summary',
    'body',
    'pageContent',
    'markdown',
    'title',
    'name',
  ]
  const fieldNames = new Set<string>()
  for (const fieldName of preferredFields) {
    if (fieldName in fields) fieldNames.add(fieldName)
  }
  for (const [fieldName, value] of Object.entries(fields)) {
    if (fieldName.startsWith('@') || fieldNames.has(fieldName) || isLikelyVectorValue(fieldName, value)) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') fieldNames.add(fieldName)
    if (fieldNames.size >= 8) break
  }

  const snippets: string[] = []
  for (const fieldName of fieldNames) {
    const value = fields[fieldName]
    if (value === undefined || isLikelyVectorValue(fieldName, value)) continue
    const snippet = overviewFieldValueSnippet(value, 520)
    if (snippet) snippets.push(`${fieldName}: ${snippet}`)
    if (snippets.length >= 5) break
  }
  return truncateToTokenLimit(snippets.join('\n'), 420)
}

function buildOverviewAnswerReferences(result: TwoStageSearchResult): TwoStageAnswerReference[] {
  const references: TwoStageAnswerReference[] = []
  result.clusters.slice(0, 5).forEach((cluster, clusterIndex) => {
    references.push({
      refId: `G${clusterIndex + 1}`,
      kind: 'global-node',
      title: compactInlineText(cluster.label || cluster.clusterId || `Global ${clusterIndex + 1}`, 160),
      sourceId: cluster.nodeId || cluster.clusterId,
      score: cluster.score,
      rerankerScore: cluster.rerankerScore,
      snippet: compactInlineText(cluster.summary, 520),
    })
  })
  result.documents.slice(0, 8).forEach((document, documentIndex) => {
    references.push({
      refId: `L${documentIndex + 1}`,
      kind: 'local-document',
      title: twoStageDocTitleFromFields(document.id, document.fields),
      sourceId: document.id,
      score: document.score,
      snippet: buildOverviewLocalSnippet(document.fields),
    })
  })
  return references
}

function buildOverviewAnswerContext(input: {
  query: string
  result: TwoStageSearchResult
  references: TwoStageAnswerReference[]
  maxInputTokens?: number
}): string {
  const maxInputTokens = input.maxInputTokens ?? 128_000
  const contextTokenBudget = Math.max(2_000, Math.min(12_000, Math.floor(maxInputTokens * 0.45)))
  const payload = {
    query: input.query,
    searchMode: input.result.trace?.mode ?? 'unknown',
    scoreGate: input.result.trace?.globalScoreGate ?? null,
    stats: input.result.stats,
    references: input.references,
  }
  return truncateToTokenLimit(JSON.stringify(payload, null, 2), contextTokenBudget)
}

function buildOverviewAnswerSystemPrompt(language: Language | undefined): string {
  if (language === 'ja') {
    return [
      'あなたは Azure AI Search の Global→Local 2段階検索結果を統合する RAG 回答合成者です。',
      'Global node は検索範囲と意図の説明に使い、事実主張は Local document を主根拠にしてください。',
      '根拠が不足している場合は不足を明示し、推測で埋めないでください。',
      '回答本文では参照 ID を [L1]、[L2]、[G1] の形式で必要箇所に付けてください。',
      '必ず JSON オブジェクトだけを返してください。',
    ].join('\n')
  }
  return [
    'You synthesize one final RAG answer from Azure AI Search Global→Local two-stage results.',
    'Use Global nodes to explain retrieval scope and intent. Ground factual claims primarily in Local documents.',
    'If evidence is insufficient, say so explicitly instead of guessing.',
    'Cite references inline as [L1], [L2], [G1] where relevant.',
    'Return only a JSON object.',
  ].join('\n')
}

function buildOverviewAnswerUserPrompt(input: {
  query: string
  contextJson: string
  language?: Language
}): string {
  const instruction = input.language === 'ja'
    ? '次の検索結果から、ユーザーに見せる Overview Answer を1つ生成してください。Local document が事実根拠、Global node は検索スコープ説明です。'
    : 'Generate one user-facing Overview Answer from the following search result. Local documents are factual evidence; Global nodes explain retrieval scope.'
  return [
    instruction,
    '',
    `Query: ${input.query}`,
    '',
    'Evidence JSON:',
    input.contextJson,
    '',
    'JSON shape: { "answer": string, "confidence": "low" | "medium" | "high", "citations": string[], "caveats": string[] }',
  ].join('\n')
}

function parseOverviewAnswerContent(content: string): {
  text: string
  confidence: TwoStageOverviewAnswerConfidence
  citations: string[]
  caveats: string[]
} {
  try {
    const parsed = JSON.parse(extractJsonFromText(content)) as Record<string, unknown>
    const confidence = parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
      ? parsed.confidence
      : 'medium'
    return {
      text: compactBlockText(parsed.answer, 5000) || content.trim(),
      confidence,
      citations: Array.isArray(parsed.citations)
        ? parsed.citations.map((item) => compactInlineText(item, 16)).filter(Boolean).slice(0, 12)
        : [],
      caveats: Array.isArray(parsed.caveats)
        ? parsed.caveats.map((item) => compactInlineText(item, 220)).filter(Boolean).slice(0, 4)
        : [],
    }
  } catch {
    return { text: content.trim(), confidence: 'medium', citations: [], caveats: [] }
  }
}

export async function synthesizeTwoStageOverviewAnswer(input: {
  llmConfig: LlmProviderConfig
  llmProfileName?: string
  query: string
  result: TwoStageSearchResult
  language?: Language
  maxInputTokens?: number
  signal?: AbortSignal
}): Promise<{ overviewAnswer: TwoStageOverviewAnswer; trace: TwoStageAnswerSynthesisTrace }> {
  const references = buildOverviewAnswerReferences(input.result)
  const activity: TwoStageAnswerSynthesisActivity[] = [
    {
      step: 'global-scope',
      status: input.result.clusters.length > 0 ? 'completed' : 'skipped',
      detail: overviewAnswerMessage(input.language, 'Global node から検索スコープを抽出', 'Extracted retrieval scope from Global nodes'),
      count: input.result.clusters.length,
    },
    {
      step: 'local-evidence',
      status: input.result.documents.length > 0 ? 'completed' : 'skipped',
      detail: overviewAnswerMessage(input.language, 'Local document を回答根拠として整形', 'Prepared Local documents as answer evidence'),
      count: input.result.documents.length,
    },
  ]
  const generatedAt = new Date().toISOString()

  if (input.result.documents.length === 0) {
    activity.push({
      step: 'answer-synthesis',
      status: 'skipped',
      detail: overviewAnswerMessage(input.language, 'Local 根拠がないため回答合成をスキップ', 'Skipped synthesis because no Local evidence was available'),
    })
    return {
      overviewAnswer: {
        status: 'skipped',
        mode: 'llm-profile',
        text: overviewAnswerMessage(
          input.language,
          'Local 検索で根拠文書が見つからなかったため、Overview Answer は生成しませんでした。Global ノードと score gate を確認してください。',
          'Overview Answer was not generated because Local search returned no evidence documents. Check Global nodes and the score gate.',
        ),
        generatedAt,
        confidence: 'low',
      },
      trace: {
        mode: 'llm-profile',
        profileName: input.llmProfileName,
        activity,
        references,
      },
    }
  }

  const synthesisStart = nowMs()
  let usage: LlmUsage | undefined
  try {
    const contextJson = buildOverviewAnswerContext({
      query: input.query,
      result: input.result,
      references,
      maxInputTokens: input.maxInputTokens,
    })
    const content = await callLlmChat({
      config: input.llmConfig,
      systemPrompt: buildOverviewAnswerSystemPrompt(input.language),
      userPrompt: buildOverviewAnswerUserPrompt({ query: input.query, contextJson, language: input.language }),
      signal: input.signal,
      jsonMode: true,
      jsonSchema: TWO_STAGE_OVERVIEW_ANSWER_SCHEMA,
      maxTokens: 1400,
      onUsage: (nextUsage) => { usage = nextUsage },
    })
    const parsed = parseOverviewAnswerContent(content)
    activity.push({
      step: 'answer-synthesis',
      status: 'completed',
      detail: overviewAnswerMessage(input.language, '既存 LLM プロファイルで最終回答を合成', 'Synthesized final answer with the selected LLM profile'),
      durationMs: Math.round(nowMs() - synthesisStart),
    })
    return {
      overviewAnswer: {
        status: 'generated',
        mode: 'llm-profile',
        text: parsed.text,
        generatedAt,
        confidence: parsed.confidence,
        citations: parsed.citations,
        caveats: parsed.caveats,
        usage,
      },
      trace: {
        mode: 'llm-profile',
        profileName: input.llmProfileName,
        activity,
        references,
        usage,
      },
    }
  } catch (error) {
    if (input.signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    activity.push({
      step: 'answer-synthesis',
      status: 'failed',
      detail: compactInlineText(message, 500),
      durationMs: Math.round(nowMs() - synthesisStart),
    })
    return {
      overviewAnswer: {
        status: 'error',
        mode: 'llm-profile',
        text: '',
        generatedAt,
        confidence: 'low',
        error: message,
      },
      trace: {
        mode: 'llm-profile',
        profileName: input.llmProfileName,
        activity,
        references,
      },
    }
  }
}

/**
 * Execute a 2-stage Global→Local search.
 *
 * Step 1: Search meta-index to find relevant clusters
 * Step 2: Search source index filtered to member documents
 */
export async function twoStageSearch(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  sourceIndexName: string
  metaIndexName: string
  query: string
  topClusters?: number
  topDocs?: number
  language?: Language
  signal?: AbortSignal
}): Promise<TwoStageSearchResult> {
  const {
    profile,
    apiVersion,
    sourceIndexName,
    metaIndexName,
    query,
    topClusters = 3,
    topDocs = 10,
    language,
    signal,
  } = input

  const t0 = performance.now()

  // Step 1: Global search on meta-index
  const raptorTopNodes = Math.min(50, Math.max(topClusters, topClusters * 6))
  const raptorGlobalBody: JsonValue = {
    search: query,
    queryType: 'semantic',
    semanticConfiguration: 'eflc-semantic',
    searchFields: RAPTOR_META_SEARCH_FIELDS.join(','),
    filter: "search.in(nodeKind, 'macro,micro,retrieval-question,facet,bridge', ',')",
    top: raptorTopNodes,
    select: RAPTOR_META_SELECT.join(','),
    count: true,
  }
  const legacyGlobalBody: JsonValue = {
    search: query,
    queryType: 'semantic',
    semanticConfiguration: 'eflc-semantic',
    top: topClusters,
    select: LEGACY_META_SELECT.join(','),
    count: true,
  }

  let globalBody = raptorGlobalBody
  let globalMode: 'raptor-lite' | 'legacy' = 'raptor-lite'
  let fallbackReason: string | undefined
  let globalResult = await searchDocuments({
    profile,
    indexName: metaIndexName,
    apiVersion,
    body: raptorGlobalBody,
    language,
    signal,
  })

  if (!globalResult.ok) {
    fallbackReason = globalResult.error?.message || 'RAPTOR-lite global search failed'
    const legacyResult = await searchDocuments({
      profile,
      indexName: metaIndexName,
      apiVersion,
      body: legacyGlobalBody,
      language,
      signal,
    })
    if (legacyResult.ok) {
      globalBody = legacyGlobalBody
      globalMode = 'legacy'
      globalResult = legacyResult
    }
  }

  const t1 = performance.now()

  if (!globalResult.ok) {
    throw new Error(
      `Global search failed: ${globalResult.error?.message || 'Unknown error'}`
    )
  }
  if (!globalResult.response) {
    throw new Error('Global search failed: No response')
  }

  const globalResp = globalResult.response as Record<string, JsonValue>
  const rawGlobalDocs = (globalResp.value as Array<Record<string, JsonValue>>) || []
  const totalDocs = (globalResp['@odata.count'] as number) || 0
  const globalScoreGate = filterGlobalDocsBySearchScore(rawGlobalDocs)
  const globalDocs = globalScoreGate.acceptedDocs
  const nodeDecisions = globalDocs.map((doc) => buildRaptorDecisionForGlobalDoc({ doc, language }))

  const clusters = globalDocs.map((doc, docIndex) => {
    const nodeDecision = nodeDecisions[docIndex]
    return {
      nodeId: String(doc.id ?? doc.clusterId ?? ''),
      nodeKind: parseRaptorNodeKind(doc.nodeKind),
      level: Number(doc.level ?? 1),
      clusterId: String(doc.clusterId ?? ''),
      label: String(doc.label ?? ''),
      summary: String(doc.summary ?? ''),
      score: Number(doc['@search.score'] ?? 0),
      rerankerScore: asFiniteNumber(doc['@search.rerankerScore']),
      documentCount: Number(doc.documentCount ?? 0),
      parentId: String(doc.parentId ?? '') || undefined,
      childIds: asStringArray(doc.childIds),
      sourceClusterId: String(doc.sourceClusterId ?? '') || undefined,
      localClusterId: String(doc.localClusterId ?? '') || undefined,
      generatedQuestions: asStringArray(doc.generatedQuestions),
      retrievalIntents: asStringArray(doc.retrievalIntents),
      facetLabels: asStringArray(doc.facetLabels),
      referenceDocIds: asStringArray(doc.referenceDocIds),
      treePath: nodeDecision.treePath,
      nodeDecision,
    }
  })

  // Collect all member doc IDs from matched clusters
  const allMemberIds: string[] = []
  for (const decision of nodeDecisions) {
    allMemberIds.push(...decision.selectedDocIds)
  }
  const candidateDocIds = uniqueDocIds(allMemberIds)

  // Step 2: Local search on source index, filtered to cluster members
  let documents: TwoStageSearchResult['documents'] = []
  let localRequest: JsonValue | undefined
  let localFilterApplied = false

  if (candidateDocIds.length > 0) {
    // Build filter using search.in for efficiency (max ~65K chars in filter)
    const idBatch = candidateDocIds.slice(0, 500) // Limit to avoid filter size issues
    const filterValue = idBatch.map((id) => id.replace(/'/g, "''" )).join(',')

    // Need to know the key field name
    const defResult = await getIndexDefinition({
      profile,
      indexName: sourceIndexName,
      apiVersion,
      language,
    })
    let keyFieldName = 'id'
    if (defResult.ok && defResult.response) {
      const defResp = defResult.response as Record<string, JsonValue>
      const fields = defResp.fields as Array<Record<string, JsonValue>> | undefined
      const keyField = fields?.find((f) => f.key === true)
      if (keyField) keyFieldName = String(keyField.name)
    }

    const localBody: JsonValue = {
      search: query,
      filter: `search.in(${keyFieldName}, '${filterValue}', ',')`,
      top: topDocs,
      count: true,
    }
    localRequest = localBody
    localFilterApplied = true

    const localResult = await searchDocuments({
      profile,
      indexName: sourceIndexName,
      apiVersion,
      body: localBody,
      language,
      signal,
    })

    if (!localResult.ok) {
      // Retry without filter if filter-based search fails (e.g. key field incompatibility)
      const retryBody: JsonValue = {
        search: query,
        top: topDocs,
        count: true,
      }
      localRequest = retryBody
      localFilterApplied = false
      const retryResult = await searchDocuments({
        profile,
        indexName: sourceIndexName,
        apiVersion,
        body: retryBody,
        language,
        signal,
      })
      if (retryResult.ok && retryResult.response) {
        const retryResp = retryResult.response as Record<string, JsonValue>
        const retryDocs = (retryResp.value as Array<Record<string, JsonValue>>) || []
        documents = retryDocs.map((doc) => {
          const { '@search.score': score, ...fields } = doc
          return {
            id: String(fields[keyFieldName] ?? ''),
            score: Number(score ?? 0),
            fields: fields as Record<string, JsonValue>,
          }
        })
      }
    } else if (localResult.response) {
      const localResp = localResult.response as Record<string, JsonValue>
      const localDocs = (localResp.value as Array<Record<string, JsonValue>>) || []
      documents = localDocs.map((doc) => {
        const { '@search.score': score, ...fields } = doc
        return {
          id: String(fields[keyFieldName] ?? ''),
          score: Number(score ?? 0),
          fields: fields as Record<string, JsonValue>,
        }
      })
    }
  }

  const t2 = performance.now()

  return {
    clusters,
    documents,
    stats: {
      globalSearchTimeMs: Math.round(t1 - t0),
      localSearchTimeMs: Math.round(t2 - t1),
      totalTimeMs: Math.round(t2 - t0),
      searchSpaceReduction: totalDocs > 0
        ? Number(((1 - candidateDocIds.length / Math.max(totalDocs, candidateDocIds.length)) * 100).toFixed(1))
        : 0,
      totalDocs,
      filteredDocs: candidateDocIds.length,
      globalNodeCount: globalDocs.length,
      globalRawNodeCount: rawGlobalDocs.length,
      globalRejectedNodeCount: globalScoreGate.gate?.rejectedNodeCount ?? 0,
      globalScoreGateThreshold: globalScoreGate.gate?.threshold,
      globalScoreGateMetric: globalScoreGate.gate?.metric,
      candidateDocCount: candidateDocIds.length,
      localFilterApplied,
    },
    trace: {
      mode: globalMode,
      globalRequest: globalBody,
      localRequest,
      retrievalSurfaceFields: globalMode === 'raptor-lite' ? RAPTOR_META_SEARCH_FIELDS : ['label', 'summary', 'keywords'],
      nodeDecisions,
      candidateDocIds: candidateDocIds.slice(0, 500),
      localFilterApplied,
      fallbackReason,
      globalScoreGate: globalScoreGate.gate,
    },
  }
}

// ─── Fetch Representative Texts ─────────────────────────────────────────────

/**
 * Fetch text content for representative documents from each cluster.
 * Uses the first searchable string field.
 */
export async function fetchRepresentativeTexts(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  indexName: string
  docIds: string[]
  textFields: string[]
  keyField: string
  language?: Language
  signal?: AbortSignal
}): Promise<Map<string, string>> {
  const { profile, apiVersion, indexName, docIds, textFields, keyField, language, signal } = input
  const texts = new Map<string, string>()

  // Fetch in batches of 50
  const batchSize = 50
  const selectFields = [keyField, ...textFields].join(',')
  for (let i = 0; i < docIds.length; i += batchSize) {
    if (signal?.aborted) break
    const batch = docIds.slice(i, i + batchSize)
    const filterValue = batch.map((id) => id.replace(/'/g, "''")).join(',')

    const result = await searchDocuments({
      profile,
      indexName,
      apiVersion,
      body: {
        search: '*',
        filter: `search.in(${keyField}, '${filterValue}', ',')`,
        select: selectFields,
        top: batchSize,
      },
      language,
      signal,
    })

    if (result.ok && result.response) {
      const resp = result.response as Record<string, JsonValue>
      const values = (resp.value as Array<Record<string, JsonValue>>) || []
      for (const doc of values) {
        const id = String(doc[keyField] ?? '')
        // Concatenate all text fields
        const parts = textFields
          .map((f) => String(doc[f] ?? ''))
          .filter((t) => t.length > 0)
        const text = parts.join('\n')
        if (id && text) texts.set(id, text)
      }
    }
  }

  return texts
}

/**
 * Check if a meta-index exists for the given source index.
 * Returns the meta-index name if found, null otherwise.
 */
export async function checkMetaIndexExists(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  sourceIndexName: string
  language?: Language
}): Promise<string | null> {
  return findMetaIndexName({
    profile: input.profile,
    apiVersion: input.apiVersion,
    sourceIndexName: input.sourceIndexName,
    language: input.language,
  })
}

/**
 * Fetch existing cluster summaries from a meta-index.
 *
 * Returns null if the meta-index does not exist or has no documents.
 */
export async function fetchExistingSummaries(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  metaIndexName: string
  language?: Language
}): Promise<ClusterSummary[] | null> {
  let result = await searchDocuments({
    profile: input.profile,
    indexName: input.metaIndexName,
    apiVersion: input.apiVersion,
    body: {
      search: '*',
      top: 1000,
      orderby: 'documentCount desc',
      select: META_SUMMARY_SELECT.join(','),
    },
    language: input.language,
  })
  if (!result.ok) {
    result = await searchDocuments({
      profile: input.profile,
      indexName: input.metaIndexName,
      apiVersion: input.apiVersion,
      body: {
        search: '*',
        top: 1000,
        orderby: 'documentCount desc',
        select: LEGACY_META_SUMMARY_SELECT.join(','),
      },
      language: input.language,
    })
  }
  if (!result.ok || !result.response) return null

  const resp = result.response as Record<string, JsonValue>
  const docs = (resp.value as Array<Record<string, JsonValue>> | undefined)
    ?.filter((doc) => {
      const nodeKind = String(doc.nodeKind ?? 'macro')
      return nodeKind === 'macro' || nodeKind === ''
    })
  if (!docs || docs.length === 0) return null

  return docs.map((d) => {
    const clusterId = String(d.clusterId ?? '')
    const fallbackLabel = clusterId || 'Cluster'
    return {
      clusterId,
      label: compactClusterLabel(d.label, fallbackLabel),
      summary: compactClusterSummary(d.summary, fallbackLabel),
      keywords: compactList(d.keywords, 16, MAX_KEYWORD_CHARS),
      documentCount: Number(d.documentCount ?? 0),
      memberDocIds: Array.isArray(d.memberDocIds) ? d.memberDocIds.map(String) : [],
      centroidVector: Array.isArray(d.centroidVector) ? d.centroidVector.map(Number) : [],
      representativeText: String(d.representativeText ?? ''),
      summaryVersion: d.summaryVersion === 'v2' ? 'v2' : 'v1',
      facetLabels: compactList(d.facetLabels, 8, MAX_CLUSTER_LABEL_CHARS),
      facetSummaries: compactList(d.facetSummaries, 8, MAX_FACET_SUMMARY_CHARS),
      inclusionCriteria: compactList(d.inclusionCriteria, 8, MAX_CRITERION_CHARS),
      exclusionCriteria: compactList(d.exclusionCriteria, 8, MAX_CRITERION_CHARS),
      signatureJson: String(d.signatureJson ?? ''),
      qualityJson: String(d.qualityJson ?? ''),
      topologyJson: String(d.topologyJson ?? ''),
      hierarchyJson: String(d.hierarchyJson ?? ''),
      nodeKind: parseRaptorNodeKind(d.nodeKind),
      level: Number(d.level ?? 1),
      parentId: String(d.parentId ?? '') || undefined,
      childIds: asStringArray(d.childIds),
      sourceClusterId: String(d.sourceClusterId ?? '') || undefined,
      localClusterId: String(d.localClusterId ?? '') || undefined,
      retrievalText: String(d.retrievalText ?? ''),
      generatedQuestions: compactList(d.generatedQuestions, 8, 180),
      retrievalIntents: compactList(d.retrievalIntents, 8, MAX_CLUSTER_LABEL_CHARS),
      referenceDocIds: asStringArray(d.referenceDocIds),
      retrievalSignatureJson: String(d.retrievalSignatureJson ?? ''),
    }
  })
}

export async function fetchExistingRaptorNodes(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  metaIndexName: string
  language?: Language
}): Promise<RaptorRetrievalNode[]> {
  const result = await searchDocuments({
    profile: input.profile,
    indexName: input.metaIndexName,
    apiVersion: input.apiVersion,
    body: {
      search: '*',
      filter: "search.in(nodeKind, 'root,micro,retrieval-question,facet,bridge', ',')",
      top: 1000,
      orderby: 'level asc, documentCount desc',
      select: META_SUMMARY_SELECT.join(','),
    },
    language: input.language,
  })
  if (!result.ok || !result.response) return []

  const resp = result.response as Record<string, JsonValue>
  const docs = resp.value as Array<Record<string, JsonValue>> | undefined
  if (!docs || docs.length === 0) return []

  return docs.map((doc) => {
    const id = String(doc.id ?? doc.clusterId ?? '')
    const clusterId = String(doc.clusterId ?? '')
    const fallbackLabel = id || clusterId || 'RAPTOR node'
    return {
      id,
      nodeKind: parseRaptorNodeKind(doc.nodeKind),
      level: Number(doc.level ?? 2),
      clusterId,
      parentId: String(doc.parentId ?? '') || undefined,
      childIds: asStringArray(doc.childIds),
      label: compactClusterLabel(doc.label, fallbackLabel),
      summary: compactClusterSummary(doc.summary, fallbackLabel),
      keywords: compactList(doc.keywords, 16, MAX_KEYWORD_CHARS),
      retrievalText: String(doc.retrievalText ?? doc.representativeText ?? ''),
      generatedQuestions: compactList(doc.generatedQuestions, 8, 180),
      retrievalIntents: compactList(doc.retrievalIntents, 8, MAX_CLUSTER_LABEL_CHARS),
      facetLabels: compactList(doc.facetLabels, 8, MAX_CLUSTER_LABEL_CHARS),
      facetSummaries: compactList(doc.facetSummaries, 8, MAX_FACET_SUMMARY_CHARS),
      inclusionCriteria: compactList(doc.inclusionCriteria, 8, MAX_CRITERION_CHARS),
      exclusionCriteria: compactList(doc.exclusionCriteria, 8, MAX_CRITERION_CHARS),
      memberDocIds: asStringArray(doc.memberDocIds),
      referenceDocIds: asStringArray(doc.referenceDocIds),
      centroidVector: Array.isArray(doc.centroidVector) ? doc.centroidVector.map(Number) : undefined,
      signatureJson: String(doc.signatureJson ?? ''),
      retrievalSignatureJson: String(doc.retrievalSignatureJson ?? ''),
      topologyJson: String(doc.topologyJson ?? ''),
      hierarchyJson: String(doc.hierarchyJson ?? ''),
      sourceClusterId: String(doc.sourceClusterId ?? clusterId) || undefined,
      localClusterId: String(doc.localClusterId ?? '') || undefined,
    }
  })
}
