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

export interface ClusterSummary {
  clusterId: string
  label: string
  summary: string
  keywords: string[]
  documentCount: number
  memberDocIds: string[]
  centroidVector: number[]
  representativeText: string
}

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

    // Greedy token-budget fill: iterate docs in centroid-proximity order,
    // add each doc's full text until the token budget is exhausted.
    const candidateCount = Math.min(withDist.length, maxRepresentativeCount)
    const topIndices: number[] = []
    const repTexts: string[] = []
    let usedTokens = 0
    for (let i = 0; i < candidateCount; i++) {
      const idx = withDist[i].idx
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
      ? `あなたはドキュメントクラスタの分析者です。代表的な文書群から、クラスタ全体を簡潔に表すラベル、要約、キーワードを生成してください。出力は必ずJSON形式で返してください。`
      : `You are a document cluster analyst. Generate a concise label, summary, and keywords that represent the entire cluster based on representative documents. Always respond in JSON format.`

    const userPrompt = language === 'ja'
      ? `以下はドキュメントクラスタの代表的な${repTexts.length}件の文書です。\n\n${repTexts.map((t, i) => `### 文書${i + 1}\n${t}`).join('\n\n')}\n\n以下のJSON形式で出力してください:\n{"label": "クラスタを表す短いラベル（10語以内）", "summary": "クラスタの概要（200文字以内）", "keywords": ["キーワード1", "キーワード2", "キーワード3", "キーワード4", "キーワード5"]}`
      : `Below are ${repTexts.length} representative documents from a cluster.\n\n${repTexts.map((t, i) => `### Document ${i + 1}\n${t}`).join('\n\n')}\n\nRespond in the following JSON format:\n{"label": "Short label for this cluster (max 10 words)", "summary": "Cluster overview (max 200 chars)", "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"]}`

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
        dimensions: vectorDimensions,
        vectorSearchProfile: 'eflc-vector-profile',
      },
      { name: 'representativeText', type: 'Edm.String', searchable: true },
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
              { fieldName: 'representativeText' },
            ],
            prioritizedKeywordsFields: [{ fieldName: 'keywords' }],
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

/** Upload cluster summaries as documents to the meta-index. */
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
    '@search.action': 'mergeOrUpload',
    id: s.clusterId,
    clusterId: s.clusterId,
    label: s.label,
    summary: s.summary,
    keywords: s.keywords,
    documentCount: s.documentCount,
    memberDocIds: s.memberDocIds.slice(0, 1000), // Limit for field size
    centroidVector: s.centroidVector,
    representativeText: s.representativeText,
    sourceIndex: metaConfig.sourceIndexName,
    vectorField: metaConfig.vectorField,
    createdAt: metaConfig.createdAt,
  }))

  return indexDocuments({
    profile,
    indexName: metaIndexName,
    apiVersion,
    body: { value: documents },
    language: input.language,
  })
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
  }))
}
