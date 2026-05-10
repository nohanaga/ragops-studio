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
import type { ClusterResult } from './clustering'
import { callLlmChat, extractJsonFromText, type LlmUsage, type JsonSchemaResponseFormat } from './llmProvider'
import { countTokens, truncateToTokenLimit } from './tokenizer'
import { selectRoleAwareEvidence, type ClusterEvidenceCandidate } from './clusterEvidence'
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
      label: { type: 'string' },
      summary: { type: 'string' },
      keywords: { type: 'array', items: { type: 'string' } },
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
      primaryLabel: { type: 'string' },
      shortSummary: { type: 'string' },
      facets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            summary: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' } },
            supportRatio: { type: 'number' },
            representativeDocIds: { type: 'array', items: { type: 'string' } },
          },
          required: ['label', 'summary', 'keywords', 'supportRatio', 'representativeDocIds'],
          additionalProperties: false,
        },
      },
      inclusionCriteria: { type: 'array', items: { type: 'string' } },
      exclusionCriteria: { type: 'array', items: { type: 'string' } },
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
}

export interface ClusterSignatureQuality {
  specificityScore: number
  genericityScore: number
  splitScore: number
  needsRepair: boolean
  repairReason?: string
}

export type ClusterSummaryMode = 'v1' | 'v2'

/** Per-cluster LLM trace for debugging meta-index generation. */
export interface MetaClusterTrace {
  clusterId: number
  label: string
  systemPrompt: string
  userPrompt: string
  response: string | null
  error: string | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  durationMs: number
  representativeDocIds: string[]
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

    let label = `Cluster ${c}`
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
      label = String(parsed.label || label)
      summary = String(parsed.summary || '')
      keywords = Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : []
    } catch (err) {
      // If LLM fails, use fallback
      if (err instanceof DOMException && err.name === 'AbortError') throw err
      llmFailureCount++
      const errMsg = err instanceof Error ? err.message : String(err)
      llmErrors.push(errMsg)
      traceError = errMsg
      label = `Cluster ${c} (${memberIndices.length} docs)`
      summary = `Contains ${memberIndices.length} documents. Representative: ${docs[topIndices[0]]?.title || 'N/A'}`
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

  for (let clusterId = 0; clusterId < clusters.centroids.length; clusterId++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const memberIndices = collectMemberIndices(clusters, clusterId, docs.length)
    const memberDocIds = memberIndices.map((docIndex) => docs[docIndex].id)
    const evidence = selectRoleAwareEvidence({ clusterId, clusters, docs, maxCount: maxEvidenceDocs })
    const evidenceDocIds = evidence.map((item) => item.docId)
    const evidenceBlocks = buildEvidenceBlocks({ evidence, docs, representativeTexts, tokenBudget: boundedContentTokenBudget })
    const siblingContexts = buildSiblingContexts({ clusterId, clusters, language })
    const evidenceStats = buildEvidenceStats({ memberCount: memberIndices.length, evidenceBlocks })

    const systemPrompt = language === 'ja'
      ? 'あなたは高カーディナリティな検索インデックスのクラスタ分析者です。与えられた role-aware evidence と兄弟クラスタとの差分を使い、クラスタを検索・探索に使える意味署名としてJSONで生成してください。証拠にない概念は追加しないでください。汎用的なラベルを避け、兄弟クラスタと区別できる表現にしてください。'
      : 'You are a cluster analyst for high-cardinality search indexes. Use the role-aware evidence documents and sibling contrasts to generate a search-ready semantic signature as JSON. Do not add concepts unsupported by evidence. Avoid generic labels and make this cluster distinguishable from siblings.'
    const userPrompt = language === 'ja'
      ? buildJapaneseV2Prompt({ evidenceBlocks, siblingContexts, evidenceStats })
      : buildEnglishV2Prompt({ evidenceBlocks, siblingContexts, evidenceStats })

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

    const quality = scoreSignature({ signature })
    const keywords = uniqueStrings([
      ...signature.facets.flatMap((facet) => facet.keywords),
      ...signature.facets.map((facet) => facet.label),
    ]).slice(0, 16)

    traces.push({
      clusterId,
      label: signature.primaryLabel,
      systemPrompt,
      userPrompt,
      response: traceResponse,
      error: traceError,
      promptTokens: tracePromptTokens,
      completionTokens: traceCompletionTokens,
      totalTokens: traceTotalTokens,
      durationMs: Math.round(performance.now() - traceStart),
      representativeDocIds: evidenceDocIds,
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
      signatureJson: JSON.stringify(signature),
      qualityJson: JSON.stringify(quality),
    })
  }

  return { summaries, llmFailureCount, llmErrors, promptTokens, completionTokens, totalTokens, traces }
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
}): string {
  return `以下のクラスタについて、EFLC v2 の ClusterSemanticSignature を生成してください。\n\n` +
    `## クラスタ規模と evidence 分布\n- クラスタ全体の文書数: ${input.evidenceStats.memberCount}\n- evidence 文書数: ${input.evidenceStats.evidenceCount}\n- evidence role 分布: ${Object.entries(input.evidenceStats.roleCounts).map(([role, count]) => `${role}=${count}`).join(', ') || 'N/A'}\n- evidence の distinct title 数: ${input.evidenceStats.distinctTitleCount}\n\n` +
    `## 近接する兄弟クラスタ (混同防止)\n${input.siblingContexts.join('\n') || 'N/A'}\n\n` +
    `## 証拠文書\n${input.evidenceBlocks.map((block, index) => `### Evidence ${index + 1} [${block.role}] ${block.docId}\nTitle: ${block.title}\n${block.text}`).join('\n\n')}\n\n` +
    `## 出力要件\n- primaryLabel は具体的で、兄弟クラスタと区別できる短い日本語にする。\n- primaryLabel / shortSummary / facets は、クラスタ全体の ${input.evidenceStats.memberCount} 件を表す前提で作る。\n- 単一の人物・企業・作品・団体を primaryLabel にしてよいのは、複数 role の evidence で反復し、クラスタ全体を代表すると説明できる場合だけ。\n- evidence の一部だけに出る固有名は facet または representativeDocIds 側に留め、クラスタ全体のラベルにしない。\n- facets は 2〜5 件。証拠文書内で確認できる観点だけに基づく。\n- inclusionCriteria は、このクラスタに含める条件を 2〜5 件。\n- exclusionCriteria は、似ているが除外すべき条件を 2〜5 件。\n- 証拠にない製品名、技術名、カテゴリは追加しない。`
}

function buildEnglishV2Prompt(input: {
  evidenceBlocks: Array<{ role: string; docId: string; title: string; text: string }>
  siblingContexts: string[]
  evidenceStats: { memberCount: number; evidenceCount: number; roleCounts: Record<string, number>; distinctTitleCount: number }
}): string {
  return `Generate an EFLC v2 ClusterSemanticSignature for this cluster.\n\n` +
    `## Cluster Size and Evidence Distribution\n- Total cluster documents: ${input.evidenceStats.memberCount}\n- Evidence documents: ${input.evidenceStats.evidenceCount}\n- Evidence role counts: ${Object.entries(input.evidenceStats.roleCounts).map(([role, count]) => `${role}=${count}`).join(', ') || 'N/A'}\n- Distinct evidence titles: ${input.evidenceStats.distinctTitleCount}\n\n` +
    `## Similar Sibling Clusters\n${input.siblingContexts.join('\n') || 'N/A'}\n\n` +
    `## Evidence Documents\n${input.evidenceBlocks.map((block, index) => `### Evidence ${index + 1} [${block.role}] ${block.docId}\nTitle: ${block.title}\n${block.text}`).join('\n\n')}\n\n` +
    `## Requirements\n- Make primaryLabel concrete and distinguishable from sibling clusters.\n- primaryLabel / shortSummary / facets must describe the full ${input.evidenceStats.memberCount}-document cluster.\n- Use a single person, company, work, or organization as primaryLabel only when it repeats across multiple evidence roles and can be justified as representing the whole cluster.\n- If a proper name appears only in part of the evidence, keep it inside facets or representativeDocIds, not as the whole-cluster label.\n- Produce 2 to 5 facets grounded only in evidence documents.\n- Produce 2 to 5 inclusionCriteria and exclusionCriteria.\n- Do not introduce unsupported product names, technologies, or categories.`
}

function fallbackSignature(input: {
  clusterId: number
  memberCount: number
  evidenceBlocks: Array<{ role: string; docId: string; title: string; text: string }>
  evidenceDocIds: string[]
  language: Language
}): ClusterSemanticSignature {
  const titleTerms = uniqueStrings(input.evidenceBlocks.map((block) => block.title).filter(Boolean)).slice(0, 3)
  const label = titleTerms[0] || `Cluster ${input.clusterId}`
  const summary = input.language === 'ja'
    ? `${input.memberCount} 件の文書を含むクラスタです。代表文書: ${titleTerms.join(' / ') || 'N/A'}。`
    : `Cluster containing ${input.memberCount} documents. Representative documents: ${titleTerms.join(' / ') || 'N/A'}.`
  return {
    primaryLabel: label,
    shortSummary: summary,
    facets: titleTerms.slice(0, 3).map((title) => ({
      label: title,
      summary: title,
      keywords: [title],
      supportRatio: 0,
      representativeDocIds: input.evidenceDocIds.slice(0, 5),
    })),
    inclusionCriteria: titleTerms,
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
    return {
      label: String(facet.label || '').trim(),
      summary: String(facet.summary || '').trim(),
      keywords: Array.isArray(facet.keywords) ? facet.keywords.map(String).filter(Boolean) : [],
      supportRatio: Number(facet.supportRatio ?? 0),
      representativeDocIds: Array.isArray(facet.representativeDocIds) ? facet.representativeDocIds.map(String).filter(Boolean) : [],
    }
  }).filter((facet) => facet.label.length > 0).slice(0, 6)

  return {
    primaryLabel: String(obj.primaryLabel || fallback.primaryLabel).trim() || fallback.primaryLabel,
    shortSummary: String(obj.shortSummary || fallback.shortSummary).trim() || fallback.shortSummary,
    facets: facets.length > 0 ? facets : fallback.facets,
    inclusionCriteria: Array.isArray(obj.inclusionCriteria) ? obj.inclusionCriteria.map(String).filter(Boolean).slice(0, 8) : fallback.inclusionCriteria,
    exclusionCriteria: Array.isArray(obj.exclusionCriteria) ? obj.exclusionCriteria.map(String).filter(Boolean).slice(0, 8) : fallback.exclusionCriteria,
    evidenceDocIds: Array.isArray(obj.evidenceDocIds) ? obj.evidenceDocIds.map(String).filter(Boolean) : fallback.evidenceDocIds,
    splitCandidate: Boolean(obj.splitCandidate ?? fallback.splitCandidate),
  }
}

function scoreSignature(input: { signature: ClusterSemanticSignature }): ClusterSignatureQuality {
  const labelText = `${input.signature.primaryLabel} ${input.signature.shortSummary} ${input.signature.facets.map((facet) => facet.label).join(' ')}`.toLowerCase()
  const genericWords = ['document', 'documents', 'data', 'information', 'content', '文書', '情報', 'データ', '内容']
  const genericMatches = genericWords.filter((word) => labelText.includes(word)).length
  const specificityScore = input.signature.primaryLabel.trim().length > 0 && input.signature.primaryLabel.length <= 60 ? 1 : 0
  const genericityScore = genericMatches / genericWords.length
  const splitScore = Math.min(1, (input.signature.facets.length > 5 ? 0.4 : 0) + (input.signature.splitCandidate ? 0.6 : 0))
  const needsRepair = specificityScore < 0.15 || genericityScore > 0.45 || splitScore > 0.7
  return {
    specificityScore: Number(specificityScore.toFixed(3)),
    genericityScore: Number(genericityScore.toFixed(3)),
    splitScore: Number(splitScore.toFixed(3)),
    needsRepair,
    repairReason: needsRepair ? 'low-specificity-or-high-genericity' : undefined,
  }
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

  const documents = summaries.map((s) => ({
    '@search.action': 'upload',
    id: s.clusterId,
    clusterId: s.clusterId,
    label: truncateUtf8Bytes(s.label, 32_000),
    summary: truncateUtf8Bytes(s.summary, 32_000),
    keywords: s.keywords.map((k) => truncateUtf8Bytes(k, 32_000)),
    documentCount: s.documentCount,
    memberDocIds: s.memberDocIds.slice(0, 1000), // Limit for field size
    centroidVector: s.centroidVector,
    // Azure AI Search rejects single terms > 32766 UTF-8 bytes. Keep a safety margin.
    representativeText: truncateUtf8Bytes(s.representativeText, 32_000),
    summaryVersion: s.summaryVersion ?? 'v1',
    facetLabels: (s.facetLabels ?? []).map((label) => truncateUtf8Bytes(label, 32_000)),
    facetSummaries: (s.facetSummaries ?? []).map((summary) => truncateUtf8Bytes(summary, 32_000)),
    inclusionCriteria: (s.inclusionCriteria ?? []).map((criterion) => truncateUtf8Bytes(criterion, 32_000)),
    exclusionCriteria: (s.exclusionCriteria ?? []).map((criterion) => truncateUtf8Bytes(criterion, 32_000)),
    signatureJson: truncateUtf8Bytes(s.signatureJson ?? '', 32_000),
    qualityJson: truncateUtf8Bytes(s.qualityJson ?? '', 32_000),
    sourceIndex: metaConfig.sourceIndexName,
    vectorField: metaConfig.vectorField,
    createdAt: metaConfig.createdAt,
  }))

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
      select: 'id,clusterId,label,summary,keywords,documentCount,memberDocIds,centroidVector,representativeText,summaryVersion,facetLabels,facetSummaries,inclusionCriteria,exclusionCriteria,signatureJson,qualityJson,sourceIndex,vectorField,createdAt',
    },
    language: input.language,
  })
  if (!result.ok || !result.response) return null

  const resp = result.response as Record<string, JsonValue>
  const docs = resp.value as Array<Record<string, JsonValue>> | undefined
  if (!docs || docs.length === 0) return null

  return docs.map((d) => ({
    clusterId: String(d.clusterId ?? ''),
    label: String(d.label ?? ''),
    summary: String(d.summary ?? ''),
    keywords: Array.isArray(d.keywords) ? d.keywords.map(String) : [],
    documentCount: Number(d.documentCount ?? 0),
    memberDocIds: Array.isArray(d.memberDocIds) ? d.memberDocIds.map(String) : [],
    centroidVector: Array.isArray(d.centroidVector) ? d.centroidVector.map(Number) : [],
    representativeText: String(d.representativeText ?? ''),
    summaryVersion: d.summaryVersion === 'v2' ? 'v2' : 'v1',
    facetLabels: Array.isArray(d.facetLabels) ? d.facetLabels.map(String) : [],
    facetSummaries: Array.isArray(d.facetSummaries) ? d.facetSummaries.map(String) : [],
    inclusionCriteria: Array.isArray(d.inclusionCriteria) ? d.inclusionCriteria.map(String) : [],
    exclusionCriteria: Array.isArray(d.exclusionCriteria) ? d.exclusionCriteria.map(String) : [],
    signatureJson: String(d.signatureJson ?? ''),
    qualityJson: String(d.qualityJson ?? ''),
  }))
}
