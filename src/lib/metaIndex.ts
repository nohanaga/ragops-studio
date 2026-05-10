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

export interface TwoStageSearchResult {
  /** Matching clusters from global search */
  clusters: Array<{
    clusterId: string
    label: string
    summary: string
    score: number
    documentCount: number
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
  }
}

export interface SummarizeProgress {
  current: number
  total: number
  currentLabel?: string
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
      ? 'あなたは高カーディナリティな検索インデックスのクラスタ分析者です。与えられた role-aware evidence と兄弟クラスタとの差分を使い、クラスタを検索・探索に使える意味署名としてJSONで生成してください。証拠にない概念は追加しないでください。汎用的なラベルを避け、兄弟クラスタと区別できる表現にしてください。'
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
      ? 'あなたは階層クラスタの意味署名を集約する分析者です。micro cluster の署名だけを根拠として、macro cluster の ClusterSemanticSignature を bottom-up に生成してください。新しい根拠文書や証拠にない概念は追加しないでください。兄弟 macro cluster と区別できるようにしてください。'
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
}): Array<{ role: string; docId: string; title: string; text: string }> {
  const blocks: Array<{ role: string; docId: string; title: string; text: string }> = []
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
  evidenceBlocks: Array<{ role: string; docId: string; title: string; text: string }>
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
  evidenceBlocks: Array<{ role: string; docId: string; title: string; text: string }>
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
  evidenceBlocks: Array<{ role: string; docId: string; title: string; text: string }>
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
  evidenceBlocks: Array<{ role: string; docId: string; title: string; text: string }>
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
              { fieldName: 'facetSummaries' },
              { fieldName: 'inclusionCriteria' },
              { fieldName: 'exclusionCriteria' },
              { fieldName: 'representativeText' },
            ],
            prioritizedKeywordsFields: [{ fieldName: 'keywords' }, { fieldName: 'facetLabels' }],
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
  metaConfig: MetaIndexConfig
  language?: Language
}): Promise<RestResult> {
  const { profile, apiVersion, metaIndexName, summaries, metaConfig } = input

  const documents = summaries.map((s) => {
    const fallbackLabel = s.clusterId || 'Cluster'
    return {
      '@search.action': 'upload',
      id: s.clusterId,
      clusterId: s.clusterId,
      label: compactClusterLabel(s.label, fallbackLabel),
      summary: compactClusterSummary(s.summary, fallbackLabel),
      keywords: compactList(s.keywords, 16, MAX_KEYWORD_CHARS),
      documentCount: s.documentCount,
      memberDocIds: s.memberDocIds.slice(0, 1000), // Limit for field size
      centroidVector: s.centroidVector,
      // Azure AI Search rejects single terms > 32766 UTF-8 bytes. Keep a safety margin.
      representativeText: truncateUtf8Bytes(s.representativeText, 32_000),
      summaryVersion: s.summaryVersion ?? 'v1',
      facetLabels: compactList(s.facetLabels ?? [], 8, MAX_CLUSTER_LABEL_CHARS),
      facetSummaries: compactList(s.facetSummaries ?? [], 8, MAX_FACET_SUMMARY_CHARS),
      inclusionCriteria: compactList(s.inclusionCriteria ?? [], 8, MAX_CRITERION_CHARS),
      exclusionCriteria: compactList(s.exclusionCriteria ?? [], 8, MAX_CRITERION_CHARS),
      signatureJson: truncateUtf8Bytes(s.signatureJson ?? '', 32_000),
      qualityJson: truncateUtf8Bytes(s.qualityJson ?? '', 32_000),
      topologyJson: truncateUtf8Bytes(s.topologyJson ?? '', 32_000),
      hierarchyJson: truncateUtf8Bytes(s.hierarchyJson ?? '', 32_000),
      sourceIndex: metaConfig.sourceIndexName,
      vectorField: metaConfig.vectorField,
      createdAt: metaConfig.createdAt,
    }
  })

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
  const globalBody: JsonValue = {
    search: query,
    queryType: 'semantic',
    semanticConfiguration: 'eflc-semantic',
    top: topClusters,
    select: 'clusterId,label,summary,documentCount,memberDocIds',
    count: true,
  }

  const globalResult = await searchDocuments({
    profile,
    indexName: metaIndexName,
    apiVersion,
    body: globalBody,
    language,
    signal,
  })

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
  const globalDocs = (globalResp.value as Array<Record<string, JsonValue>>) || []
  const totalDocs = (globalResp['@odata.count'] as number) || 0

  const clusters = globalDocs.map((doc) => ({
    clusterId: String(doc.clusterId ?? ''),
    label: String(doc.label ?? ''),
    summary: String(doc.summary ?? ''),
    score: Number(doc['@search.score'] ?? 0),
    documentCount: Number(doc.documentCount ?? 0),
  }))

  // Collect all member doc IDs from matched clusters
  const allMemberIds: string[] = []
  for (const doc of globalDocs) {
    const ids = doc.memberDocIds as string[] | undefined
    if (ids) allMemberIds.push(...ids)
  }

  // Step 2: Local search on source index, filtered to cluster members
  let documents: TwoStageSearchResult['documents'] = []

  if (allMemberIds.length > 0) {
    // Build filter using search.in for efficiency (max ~65K chars in filter)
    const idBatch = allMemberIds.slice(0, 500) // Limit to avoid filter size issues
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
        ? Number(((1 - allMemberIds.length / totalDocs) * 100).toFixed(1))
        : 0,
      totalDocs,
      filteredDocs: allMemberIds.length,
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
  const result = await searchDocuments({
    profile: input.profile,
    indexName: input.metaIndexName,
    apiVersion: input.apiVersion,
    body: {
      search: '*',
      top: 100,
      orderby: 'documentCount desc',
      select: 'id,clusterId,label,summary,keywords,documentCount,memberDocIds,centroidVector,representativeText,summaryVersion,facetLabels,facetSummaries,inclusionCriteria,exclusionCriteria,signatureJson,qualityJson,topologyJson,hierarchyJson,sourceIndex,vectorField,createdAt',
    },
    language: input.language,
  })
  if (!result.ok || !result.response) return null

  const resp = result.response as Record<string, JsonValue>
  const docs = resp.value as Array<Record<string, JsonValue>> | undefined
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
    }
  })
}
