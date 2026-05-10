/**
 * Hook for meta-index generation and 2-stage search.
 *
 * Orchestrates: cluster summarization → meta-index creation → document upload → 2-stage search.
 */

import { useState, useCallback, useRef } from 'react'
import type { ConnectionProfile, SearchApiVersion } from '../lib/model'
import type { Language } from '../lib/translations'
import type { ClusterResult } from '../lib/clustering'
import type { ScannedDoc } from './useIndexVisualization'
import type { ResolvedLlmProfile } from './useSharedLlmConfig'
import {
  summarizeClusters,
  summarizeClustersV2,
  createMetaIndex,
  uploadMetaDocuments,
  deleteMetaIndex,
  twoStageSearch,
  fetchRepresentativeTexts,
  checkMetaIndexExists,
  fetchExistingSummaries,
  fetchExistingMetaDocIds,
  deleteMetaDocuments,
  generateMetaIndexName,
  type ClusterSummary,
  type ClusterSummaryMode,
  type TwoStageSearchResult,
  type SummarizeProgress,
  type MetaIndexConfig,
  type MetaClusterTrace,
} from '../lib/metaIndex'
import { getIndexDefinition, type JsonValue } from '../lib/aiSearchRest'
import { resolveMaxInputTokens } from '../lib/llmProvider'
import { selectCentroidEvidence, selectRoleAwareEvidence } from '../lib/clusterEvidence'

export type MetaIndexPhase =
  | 'idle'
  | 'fetching-texts'
  | 'summarizing'
  | 'creating-index'
  | 'uploading'
  | 'done'
  | 'error'

export type SearchPhase = 'idle' | 'searching' | 'done' | 'error'

export function useMetaIndex(input: {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
  language: Language
  llmConfig: ResolvedLlmProfile
}) {
  const { profile, apiVersion, language, llmConfig } = input

  // Meta-index generation state
  const [metaPhase, setMetaPhase] = useState<MetaIndexPhase>('idle')
  const [metaError, setMetaError] = useState<string | null>(null)
  const [metaWarning, setMetaWarning] = useState<string | null>(null)
  const [summarizeProgress, setSummarizeProgress] = useState<SummarizeProgress>({ current: 0, total: 0 })
  const [clusterSummaries, setClusterSummaries] = useState<ClusterSummary[] | null>(null)
  const [metaIndexExists, setMetaIndexExists] = useState<boolean | null>(null)
  const [metaIndexName, setMetaIndexName] = useState<string | null>(null)
  const [metaTokenUsage, setMetaTokenUsage] = useState<{ prompt: number; completion: number; total: number }>({ prompt: 0, completion: 0, total: 0 })
  const [metaTraces, setMetaTraces] = useState<MetaClusterTrace[]>([])

  // 2-stage search state
  const [searchQuery, setSearchQuery] = useState('')
  const [topClusters, setTopClusters] = useState(3)
  const [topDocs, setTopDocs] = useState(10)
  const [searchPhase, setSearchPhase] = useState<SearchPhase>('idle')
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchResult, setSearchResult] = useState<TwoStageSearchResult | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  /** Check if meta-index already exists. If it does, automatically load existing summaries. */
  const checkExists = useCallback(async (sourceIndexName: string) => {
    if (!profile || !sourceIndexName) {
      setMetaIndexExists(null)
      setMetaIndexName(null)
      setClusterSummaries(null)
      setMetaPhase('idle')
      return
    }

    // Reset previous state
    setClusterSummaries(null)
    setMetaTraces([])
    setMetaError(null)
    setMetaWarning(null)
    setMetaPhase('idle')

    const foundName = await checkMetaIndexExists({
      profile,
      apiVersion,
      sourceIndexName,
      language,
    })
    setMetaIndexExists(!!foundName)
    setMetaIndexName(foundName)

    // If meta-index exists, automatically load cluster summaries
    if (foundName) {
      setMetaPhase('fetching-texts')
      try {
        const summaries = await fetchExistingSummaries({
          profile,
          apiVersion,
          metaIndexName: foundName,
          language,
        })
        if (summaries && summaries.length > 0) {
          setClusterSummaries(summaries)
          setMetaPhase('done')
        } else {
          setMetaPhase('idle')
        }
      } catch {
        setMetaPhase('idle')
      }
    }
  }, [profile, apiVersion, language])

  /** Explicitly load existing meta-index (with loading state feedback). */
  const loadExisting = useCallback(async (sourceIndexName: string) => {
    if (!profile || !sourceIndexName) return

    setMetaError(null)
    setMetaWarning(null)
    setMetaPhase('fetching-texts')

    try {
      const foundName = await checkMetaIndexExists({
        profile,
        apiVersion,
        sourceIndexName,
        language,
      })
      if (!foundName) {
        setMetaError(language === 'ja'
          ? 'メタインデックスが見つかりません'
          : 'Meta-index not found')
        setMetaPhase('error')
        return
      }
      setMetaIndexExists(true)
      setMetaIndexName(foundName)

      const summaries = await fetchExistingSummaries({
        profile,
        apiVersion,
        metaIndexName: foundName,
        language,
      })
      if (summaries && summaries.length > 0) {
        setClusterSummaries(summaries)
        setMetaPhase('done')
      } else {
        setMetaError(language === 'ja'
          ? 'メタインデックスにドキュメントが含まれていません'
          : 'Meta-index contains no documents')
        setMetaPhase('error')
      }
    } catch (err) {
      setMetaError(err instanceof Error ? err.message : String(err))
      setMetaPhase('error')
    }
  }, [profile, apiVersion, language])

  /**
   * Generate meta-index: summarize clusters + create index + upload documents.
   */
  const generateMetaIndex = useCallback(async (
    sourceIndexName: string,
    vectorField: string,
    vectorDimensions: number,
    docs: ScannedDoc[],
    clusters: ClusterResult,
    contentFields?: string[],
    summaryMode: ClusterSummaryMode = 'v1',
  ) => {
    if (!profile) return

    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl

    setMetaError(null)
    setMetaWarning(null)
    setMetaPhase('fetching-texts')
    setSummarizeProgress({ current: 0, total: clusters.centroids.length })

    try {
      // 1. Find key field and text field from schema
      const defResult = await getIndexDefinition({
        profile,
        indexName: sourceIndexName,
        apiVersion,
        language,
      })
      if (ctrl.signal.aborted) return
      if (!defResult.ok || !defResult.response) {
        throw new Error('Failed to get index definition')
      }
      const defResp = defResult.response as Record<string, JsonValue>
      const defFields = defResp.fields as Array<Record<string, JsonValue>> | undefined
      const keyField = defFields?.find((f) => f.key === true)
      const keyFieldName = keyField ? String(keyField.name) : 'id'

      // Find searchable text fields for representative content
      const resolvedTextFields: string[] = contentFields && contentFields.length > 0
        ? contentFields
        : (() => {
            const textField = defFields?.find(
              (f) =>
                f.type === 'Edm.String' &&
                f.searchable !== false &&
                !f.key &&
                String(f.name) !== vectorField
            )
            return textField ? [String(textField.name)] : []
          })()

      // 2. Fetch representative texts. v1 fetches centroid-top plus role-aware
      // spread samples; v2 fetches bounded role-aware evidence.
      const effectiveMaxTokens = resolveMaxInputTokens(llmConfig.deployment, llmConfig.maxInputTokens)
      const repPerCluster = Math.min(500, Math.max(10, Math.floor(effectiveMaxTokens * 0.75 / 30)))
      const repDocIds: string[] = []
      const k = clusters.centroids.length
      for (let c = 0; c < k; c++) {
        if (summaryMode === 'v2') {
          const evidence = selectRoleAwareEvidence({ clusterId: c, clusters, docs, maxCount: Math.min(32, repPerCluster) })
          repDocIds.push(...evidence.map((item) => item.docId))
        } else {
          const centroidEvidence = selectCentroidEvidence({ clusterId: c, clusters, docs, maxCount: repPerCluster })
          const spreadEvidence = selectRoleAwareEvidence({ clusterId: c, clusters, docs, maxCount: Math.min(48, repPerCluster) })
          repDocIds.push(...centroidEvidence.map((item) => item.docId), ...spreadEvidence.map((item) => item.docId))
        }
      }
      let representativeTexts = new Map<string, string>()
      if (resolvedTextFields.length > 0) {
        representativeTexts = await fetchRepresentativeTexts({
          profile,
          apiVersion,
          indexName: sourceIndexName,
          docIds: [...new Set(repDocIds)],
          textFields: resolvedTextFields,
          keyField: keyFieldName,
          language,
          signal: ctrl.signal,
        })
      }
      if (ctrl.signal.aborted) return

      // 3. Summarize clusters with LLM
      setMetaPhase('summarizing')
      const llm = llmConfig.buildLlmProviderConfig()
      const summarizeResult = summaryMode === 'v2'
        ? await summarizeClustersV2({
            clusters,
            docs,
            representativeTexts,
            llmConfig: llm,
            language,
            maxInputTokens: effectiveMaxTokens,
            signal: ctrl.signal,
            onProgress: setSummarizeProgress,
          })
        : await summarizeClusters({
            clusters,
            docs,
            representativeTexts,
            llmConfig: llm,
            language,
            maxInputTokens: effectiveMaxTokens,
            signal: ctrl.signal,
            onProgress: setSummarizeProgress,
          })
      if (ctrl.signal.aborted) return
      const summaries = summarizeResult.summaries
      setClusterSummaries(summaries)
      setMetaTokenUsage({
        prompt: summarizeResult.promptTokens,
        completion: summarizeResult.completionTokens,
        total: summarizeResult.totalTokens,
      })
      setMetaTraces(summarizeResult.traces)

      // Track LLM failures as warnings
      if (summarizeResult.llmFailureCount > 0) {
        const warnMsg = summarizeResult.llmFailureCount === k
          ? (language === 'ja'
            ? `⚠️ 全 ${k} クラスタの LLM 呼び出しが失敗しました。フォールバックラベルを使用しています。\n${summarizeResult.llmErrors.join('\n')}`
            : `⚠️ All ${k} LLM calls failed. Using fallback labels.\n${summarizeResult.llmErrors.join('\n')}`)
          : (language === 'ja'
            ? `⚠️ ${summarizeResult.llmFailureCount}/${k} クラスタの LLM 呼び出しが失敗しました。\n${summarizeResult.llmErrors.join('\n')}`
            : `⚠️ ${summarizeResult.llmFailureCount}/${k} LLM calls failed.\n${summarizeResult.llmErrors.join('\n')}`)
        setMetaWarning(warnMsg)
      }

      // 4. Create or update meta-index (PUT — idempotent, updates schema if needed)
      setMetaPhase('creating-index')
      const newMetaName = generateMetaIndexName(sourceIndexName)

      const createResult = await createMetaIndex({
        profile,
        apiVersion,
        metaIndexName: newMetaName,
        vectorDimensions,
        language,
      })
      if (!createResult.ok) {
        throw new Error(`Failed to create meta-index: ${createResult.error?.message || 'Unknown'}`)
      }
      if (ctrl.signal.aborted) return

      // 4b. Remove stale documents whose cluster IDs are no longer present
      // (e.g. previous run had k=5, now k=3 — delete cluster-3, cluster-4).
      // This is done in-place to avoid the timing/eventual-consistency issues
      // that occur when deleting and immediately recreating an index.
      const newIds = new Set(summaries.map((s) => s.clusterId))
      try {
        const existingIds = await fetchExistingMetaDocIds({
          profile,
          apiVersion,
          metaIndexName: newMetaName,
          language,
        })
        const staleIds = existingIds.filter((id) => !newIds.has(id))
        if (staleIds.length > 0) {
          await deleteMetaDocuments({
            profile,
            apiVersion,
            metaIndexName: newMetaName,
            ids: staleIds,
            language,
          })
        }
      } catch {
        // Stale-doc cleanup is best-effort; do not fail the whole operation.
      }
      if (ctrl.signal.aborted) return

      // 5. Upload documents
      setMetaPhase('uploading')
      const metaConfig: MetaIndexConfig = {
        sourceIndexName,
        vectorField,
        vectorDimensions,
        clusterCount: k,
        algorithm: summaryMode === 'v2' ? 'eflc-v2-kmeans' : 'eflc-v1-kmeans',
        createdAt: new Date().toISOString(),
      }
      const uploadResult = await uploadMetaDocuments({
        profile,
        apiVersion,
        metaIndexName: newMetaName,
        summaries,
        metaConfig,
        language,
      })
      if (!uploadResult.ok) {
        throw new Error(`Failed to upload documents: ${uploadResult.error?.message || 'Unknown'}`)
      }

      setMetaPhase('done')
      setMetaIndexExists(true)
      setMetaIndexName(newMetaName)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setMetaError(err instanceof Error ? err.message : String(err))
      setMetaPhase('error')
    }
  }, [profile, apiVersion, language, llmConfig])

  /** Delete existing meta-index. */
  const deleteMeta = useCallback(async (sourceIndexName: string) => {
    if (!profile || !sourceIndexName || !metaIndexName) return
    const result = await deleteMetaIndex({ profile, apiVersion, metaIndexName, language })
    if (result.ok) {
      setMetaIndexExists(false)
      setMetaIndexName(null)
      setClusterSummaries(null)
      setSearchResult(null)
    } else {
      setMetaError(`Delete failed: ${result.error?.message || 'Unknown'}`)
    }
  }, [profile, apiVersion, language, metaIndexName])

  /** Execute 2-stage search. */
  const executeSearch = useCallback(async (sourceIndexName: string) => {
    if (!profile || !sourceIndexName || !searchQuery.trim() || !metaIndexName) return

    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl

    setSearchError(null)
    setSearchResult(null)
    setSearchPhase('searching')

    try {
      const result = await twoStageSearch({
        profile,
        apiVersion,
        sourceIndexName,
        metaIndexName,
        query: searchQuery.trim(),
        topClusters,
        topDocs,
        language,
        signal: ctrl.signal,
      })
      if (ctrl.signal.aborted) return
      setSearchResult(result)
      setSearchPhase('done')
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      setSearchError(err instanceof Error ? err.message : String(err))
      setSearchPhase('error')
    }
  }, [profile, apiVersion, language, searchQuery, topClusters, topDocs, metaIndexName])

  /** Cancel ongoing operation. */
  const cancel = useCallback(() => {
    abortRef.current?.abort()
    setMetaPhase('idle')
    setSearchPhase('idle')
  }, [])

  /** Restore cluster summaries from a loaded snapshot. */
  const restoreSummaries = useCallback((summaries: ClusterSummary[]) => {
    setClusterSummaries(summaries)
    setMetaPhase('done')
  }, [])

  /** Clear all meta-index and search state. */
  const clearAll = useCallback(() => {
    abortRef.current?.abort()
    setMetaPhase('idle')
    setMetaError(null)
    setMetaWarning(null)
    setClusterSummaries(null)
    setMetaTokenUsage({ prompt: 0, completion: 0, total: 0 })
    setMetaTraces([])
    setSummarizeProgress({ current: 0, total: 0 })
    setSearchPhase('idle')
    setSearchError(null)
    setSearchResult(null)
    setSearchQuery('')
  }, [])

  return {
    // Meta-index generation
    metaPhase,
    metaError,
    metaWarning,
    summarizeProgress,
    clusterSummaries,
    metaIndexExists,
    metaTokenUsage,
    metaTraces,
    checkExists,
    generateMetaIndex,
    loadExisting,
    deleteMeta,
    // 2-stage search
    searchQuery, setSearchQuery,
    topClusters, setTopClusters,
    topDocs, setTopDocs,
    searchPhase,
    searchError,
    searchResult,
    executeSearch,
    // Utilities
    cancel,
    metaIndexName,
    restoreSummaries,
    clearAll,
  }
}
