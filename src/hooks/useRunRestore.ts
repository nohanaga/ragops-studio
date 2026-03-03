import type { Dispatch, SetStateAction } from 'react'
import { getRun, listArtifactsByRun } from '../lib/db'
import type { JsonValue } from '../lib/aiSearchRest'
import type { Run } from '../lib/model'
import type { AgenticFormState, AnalyzeFormState, CenterTab, LabMode, LatestResponse, SearchFormState } from '../types'
import { isJsonObject, type JsonObject } from '../app/json'
import type { TranslationKey } from '../lib/translations'

type TFunction = (key: TranslationKey) => string

type FormatFunction = (key: TranslationKey, params: Record<string, string | number>) => string

export function useRunRestore(params: {
  t: TFunction
  format: FormatFunction
  setLabMode: Dispatch<SetStateAction<LabMode>>
  setBuilderMode: Dispatch<SetStateAction<'form' | 'json'>>
  setKnowledgeBaseName: Dispatch<SetStateAction<string>>
  setAgenticForm: Dispatch<SetStateAction<AgenticFormState>>
  setIndexName: Dispatch<SetStateAction<string>>
  setAnalyzeForm: Dispatch<SetStateAction<AnalyzeFormState>>
  setSearchForm: Dispatch<SetStateAction<SearchFormState>>
  setQpsTesterRestoreRunId: Dispatch<SetStateAction<string | null>>
  setIsQpsTesterOpen: Dispatch<SetStateAction<boolean>>
  setAutoTuningRestoreRunId: Dispatch<SetStateAction<string | null>>
  setIsAutoTuningOpen: Dispatch<SetStateAction<boolean>>
  setCenterTab: Dispatch<SetStateAction<CenterTab>>
  setLatestResponse: Dispatch<SetStateAction<LatestResponse | null>>
  setRunResultMap: Dispatch<SetStateAction<Record<string, { run: Run; response: LatestResponse | null }>>>
  setResultPages: Dispatch<SetStateAction<Record<string, number>>>
}) {
  const {
    t,
    format,
    setLabMode,
    setBuilderMode,
    setKnowledgeBaseName,
    setAgenticForm,
    setIndexName,
    setAnalyzeForm,
    setSearchForm,
    setQpsTesterRestoreRunId,
    setIsQpsTesterOpen,
    setAutoTuningRestoreRunId,
    setIsAutoTuningOpen,
    setCenterTab,
    setLatestResponse,
    setRunResultMap,
    setResultPages,
  } = params

  /**
   * Restores a run into the UI.
   *
   * Loads persisted request/response artifacts and updates the current builder
   * mode and relevant tool tabs (e.g., QPS tester / auto-tuning) when applicable.
   */
  async function onRestoreRun(runId: string) {
    const ok = window.confirm(t('confirmRestore'))
    if (!ok) return

    try {
      const run = await getRun(runId)
      if (!run) {
        alert(format('runNotFound', { runId }))
        return
      }

      const artifacts = await listArtifactsByRun(runId)

      // Find request and response artifacts (response may be missing)
      const requestArtifact = artifacts.find((a) => a.type === 'request_json')
      const responseArtifact = artifacts.find((a) => a.type === 'response_json')

      if (!requestArtifact) {
        alert(t('noArtifacts'))
        return
      }

      let requestBody: JsonValue
      let responseBody: JsonValue | null = null
      try {
        requestBody = JSON.parse(requestArtifact.content) as JsonValue
      } catch {
        requestBody = {}
      }
      if (responseArtifact) {
        try {
          responseBody = JSON.parse(responseArtifact.content) as JsonValue
        } catch {
          responseBody = {}
        }
      }

      const requestObj: JsonObject = isJsonObject(requestBody) ? requestBody : {}
      const getString = (k: string, fallback = ''): string =>
        typeof requestObj[k] === 'string' ? requestObj[k] : fallback
      const getNumber = (k: string, fallback: number): number =>
        typeof requestObj[k] === 'number' ? requestObj[k] : fallback
      const getBoolean = (k: string, fallback: boolean): boolean =>
        typeof requestObj[k] === 'boolean' ? requestObj[k] : fallback

      // Restore lab mode based on run type
      if (run.runType === 'agentic_retrieve') {
        setLabMode('agentic')
        setBuilderMode('form')

        // Restore knowledge base name
        if (run.context.knowledgeBaseName) {
          setKnowledgeBaseName(run.context.knowledgeBaseName)
        }

        // Restore agentic form from request body
        const messages = Array.isArray(requestObj.messages) ? requestObj.messages : null
        const firstMsg =
          messages && messages.length > 0 && isJsonObject(messages[0]) ? messages[0] : null
        const contents = firstMsg && Array.isArray(firstMsg.content) ? firstMsg.content : null
        const firstContent =
          contents && contents.length > 0 && isJsonObject(contents[0]) ? contents[0] : null
        const userMessage =
          firstContent && firstContent.type === 'text' && typeof firstContent.text === 'string'
            ? firstContent.text
            : ''

        if (userMessage) {
          const includeActivity = getBoolean('includeActivity', true)
          const outputMode = getString('outputMode', 'answerSynthesis')
          const maxRuntimeInSeconds = getNumber('maxRuntimeInSeconds', 60)
          const maxOutputSize = getNumber('maxOutputSize', 100000)
          const retrievalReasoningEffortRaw = requestObj.retrievalReasoningEffort
          const retrievalReasoningEffortObj = isJsonObject(retrievalReasoningEffortRaw)
            ? retrievalReasoningEffortRaw
            : null
          const retrievalReasoningEffort =
            typeof retrievalReasoningEffortObj?.kind === 'string'
              ? retrievalReasoningEffortObj.kind
              : 'low'

          const knowledgeSourceParamsRaw =
            Array.isArray(requestObj.knowledgeSourceParams) ? requestObj.knowledgeSourceParams : []
          const knowledgeSourceParams = knowledgeSourceParamsRaw
            .filter((ks): ks is JsonObject => isJsonObject(ks))
            .map((ks) => ({
              knowledgeSourceName: typeof ks.knowledgeSourceName === 'string' ? ks.knowledgeSourceName : '',
              kind: typeof ks.kind === 'string' ? ks.kind : '',
              includeReferences: typeof ks.includeReferences === 'boolean' ? ks.includeReferences : true,
              includeReferenceSourceData:
                typeof ks.includeReferenceSourceData === 'boolean' ? ks.includeReferenceSourceData : true,
              alwaysQuerySource: typeof ks.alwaysQuerySource === 'boolean' ? ks.alwaysQuerySource : false,
            }))
            .filter((ks) => ks.knowledgeSourceName.trim().length > 0)

          setAgenticForm({
            userMessage,
            includeActivity,
            outputMode,
            maxRuntimeInSeconds,
            maxOutputSize,
            retrievalReasoningEffort:
              retrievalReasoningEffort === 'low' ||
              retrievalReasoningEffort === 'medium' ||
              retrievalReasoningEffort === 'minimal'
                ? retrievalReasoningEffort
                : 'low',
            knowledgeSourceParams,
          })
        }
      } else if (run.runType === 'analyze') {
        setLabMode('analyze')
        setBuilderMode('form')

        // Restore index name
        if (run.context.indexName) {
          setIndexName(run.context.indexName)
        }

        // Restore analyze form from request body
        setAnalyzeForm({
          text: getString('text', ''),
          analyzerName: getString('analyzer', ''),
          tokenizerName: getString('tokenizer', ''),
          normalizerName: getString('normalizer', ''),
          charFilters: Array.isArray(requestObj.charFilters)
            ? requestObj.charFilters.filter((x): x is string => typeof x === 'string').join(',')
            : typeof requestObj.charFilters === 'string'
              ? requestObj.charFilters
              : '',
          tokenFilters: Array.isArray(requestObj.tokenFilters)
            ? requestObj.tokenFilters.filter((x): x is string => typeof x === 'string').join(',')
            : typeof requestObj.tokenFilters === 'string'
              ? requestObj.tokenFilters
              : '',
        })
      } else if (
        run.runType === 'vector' ||
        run.runType === 'hybrid' ||
        run.runType === 'semantic' ||
        run.runType === 'semantic_hybrid' ||
        run.runType === 'qps_test' ||
        run.runType === 'auto_tuning'
      ) {
        setLabMode('semantic-vector')
        setBuilderMode('form')

        // Restore index name
        if (run.context.indexName) {
          setIndexName(run.context.indexName)
        }

        // Extract vector query parameters if present
        const vectorQueriesBody = Array.isArray(requestObj.vectorQueries) ? requestObj.vectorQueries : []
        const vectorQuery = vectorQueriesBody.find((q): q is JsonObject => isJsonObject(q)) ?? null
        const vectorQueriesDrafts = vectorQueriesBody
          .filter((q): q is JsonObject => isJsonObject(q))
          .map((q) => {
            const kind = q.kind
            const vectorKind: SearchFormState['vectorKind'] =
              kind === 'text' || kind === 'vector' || kind === 'imageUrl' || kind === 'imageBinary'
                ? kind
                : 'text'

            const threshold = isJsonObject(q.threshold) ? q.threshold : null
            const thresholdKind = threshold?.kind
            const vectorThresholdKind =
              thresholdKind === 'vectorSimilarity' || thresholdKind === 'searchScore' ? thresholdKind : ''
            const vectorThresholdValue = typeof threshold?.value === 'number' ? threshold.value : 0

            const vectorArray = Array.isArray(q.vector) ? q.vector : null
            const vector = vectorArray
              ? vectorArray
                  .map((x) => (typeof x === 'number' ? String(x) : ''))
                  .filter((s) => s.length > 0)
                  .join(', ')
              : ''

            return {
              vectorKind,
              vectorText: typeof q.text === 'string' ? q.text : '',
              vectorQueryRewrites: typeof q.queryRewrites === 'string' ? q.queryRewrites : '',
              vector,
              vectorImageUrl: typeof q.url === 'string' ? q.url : '',
              vectorBase64Image: typeof q.base64Image === 'string' ? q.base64Image : '',
              vectorFields: typeof q.fields === 'string' ? q.fields : '',
              vectorK: typeof q.k === 'number' ? q.k : 10,
              vectorExhaustive: typeof q.exhaustive === 'boolean' ? q.exhaustive : false,
              vectorWeight: typeof q.weight === 'number' ? q.weight : 1.0,
              vectorThresholdKind,
              vectorThresholdValue,
              vectorOversampling: typeof q.oversampling === 'number' ? q.oversampling : '',
              vectorPerDocumentVectorLimit:
                typeof q.perDocumentVectorLimit === 'number' ? q.perDocumentVectorLimit : '',
              vectorFilterOverride: typeof q.filterOverride === 'string' ? q.filterOverride : '',
            }
          }) satisfies SearchFormState['vectorQueries']

        // Reset to default values and restore search form with all parameters including vector queries
        const queryTypeRaw = getString('queryType', 'simple')
        const queryType =
          queryTypeRaw === 'simple' || queryTypeRaw === 'full' || queryTypeRaw === 'semantic'
            ? queryTypeRaw
            : 'simple'

        const facets = Array.isArray(requestObj.facets)
          ? requestObj.facets.filter((x): x is string => typeof x === 'string').join(',')
          : typeof requestObj.facets === 'string'
            ? requestObj.facets
            : ''
        const scoringParameters = Array.isArray(requestObj.scoringParameters)
          ? requestObj.scoringParameters.filter((x): x is string => typeof x === 'string').join(',')
          : typeof requestObj.scoringParameters === 'string'
            ? requestObj.scoringParameters
            : ''
        const semanticFields = Array.isArray(requestObj.semanticFields)
          ? requestObj.semanticFields.filter((x): x is string => typeof x === 'string').join(',')
          : typeof requestObj.semanticFields === 'string'
            ? requestObj.semanticFields
            : ''

        const scoringStatistics =
          requestObj.scoringStatistics === 'local' || requestObj.scoringStatistics === 'global'
            ? requestObj.scoringStatistics
            : ''
        const speller = requestObj.speller === 'none' || requestObj.speller === 'lexicon' ? requestObj.speller : ''
        const semanticErrorHandling =
          requestObj.semanticErrorHandling === 'partial' || requestObj.semanticErrorHandling === 'fail'
            ? requestObj.semanticErrorHandling
            : ''
        const vectorFilterMode =
          requestObj.vectorFilterMode === 'preFilter' ||
          requestObj.vectorFilterMode === 'postFilter' ||
          requestObj.vectorFilterMode === 'strictPostFilter'
            ? requestObj.vectorFilterMode
            : ''

        const hybridSearch = isJsonObject(requestObj.hybridSearch) ? requestObj.hybridSearch : null
        const hybridMaxTextRecallSize =
          typeof hybridSearch?.maxTextRecallSize === 'number' ? hybridSearch.maxTextRecallSize : ''
        const hybridCountAndFacetMode =
          hybridSearch?.countAndFacetMode === 'countAllResults' ||
          hybridSearch?.countAndFacetMode === 'countRetrievableResults'
            ? hybridSearch.countAndFacetMode
            : ''

        const vqKind = vectorQuery?.kind
        const vectorKind: SearchFormState['vectorKind'] =
          vqKind === 'text' || vqKind === 'vector' || vqKind === 'imageUrl' || vqKind === 'imageBinary'
            ? vqKind
            : 'text'
        const vqThreshold = vectorQuery && isJsonObject(vectorQuery.threshold) ? vectorQuery.threshold : null
        const vqThresholdKind = vqThreshold?.kind
        const vectorThresholdKind =
          vqThresholdKind === 'vectorSimilarity' || vqThresholdKind === 'searchScore' ? vqThresholdKind : ''
        const vectorThresholdValue = typeof vqThreshold?.value === 'number' ? vqThreshold.value : 0
        const vectorVector = Array.isArray(vectorQuery?.vector)
          ? vectorQuery.vector
              .map((x) => (typeof x === 'number' ? String(x) : ''))
              .filter((s) => s.length > 0)
              .join(', ')
          : ''

        setSearchForm({
          search: getString('search', ''),
          queryType,
          top: getNumber('top', 10),
          skip: getNumber('skip', 0),
          count: getBoolean('count', true),
          select: getString('select', ''),
          filter: getString('filter', ''),
          orderby: getString('orderby', ''),
          searchMode: getString('searchMode', ''),
          searchFields: getString('searchFields', ''),
          facets,
          highlight: getString('highlight', ''),
          highlightPreTag: typeof requestObj.highlightPreTag === 'string' ? requestObj.highlightPreTag : '',
          highlightPostTag: typeof requestObj.highlightPostTag === 'string' ? requestObj.highlightPostTag : '',
          scoringProfile: getString('scoringProfile', ''),
          scoringParameters,
          queryRewrites: typeof requestObj.queryRewrites === 'string' ? requestObj.queryRewrites : '',
          debug: typeof requestObj.debug === 'string' ? requestObj.debug : '',
          semanticQuery: typeof requestObj.semanticQuery === 'string' ? requestObj.semanticQuery : '',
          minimumCoverage: typeof requestObj.minimumCoverage === 'number' ? requestObj.minimumCoverage : '',
          scoringStatistics,
          sessionId: typeof requestObj.sessionId === 'string' ? requestObj.sessionId : '',
          speller,
          semanticErrorHandling,
          semanticMaxWaitInMilliseconds:
            typeof requestObj.semanticMaxWaitInMilliseconds === 'number'
              ? requestObj.semanticMaxWaitInMilliseconds
              : '',
          semanticFields,
          vectorFilterMode,
          hybridMaxTextRecallSize,
          hybridCountAndFacetMode,
          // Semantic parameters
          semanticConfiguration: getString('semanticConfiguration', 'default'),
          queryLanguage: getString('queryLanguage', 'ja-jp'),
          captions: getString('captions', 'extractive'),
          answers: getString('answers', 'extractive|count-3'),
          // Vector parameters
          vectorEnabled: !!vectorQuery,
          vectorQueries: vectorQueriesDrafts,
          vectorKind,
          vectorText: typeof vectorQuery?.text === 'string' ? vectorQuery.text : '',
          vectorQueryRewrites:
            typeof vectorQuery?.queryRewrites === 'string' ? vectorQuery.queryRewrites : '',
          vector: vectorVector,
          vectorImageUrl: typeof vectorQuery?.url === 'string' ? vectorQuery.url : '',
          vectorBase64Image: typeof vectorQuery?.base64Image === 'string' ? vectorQuery.base64Image : '',
          vectorFields: typeof vectorQuery?.fields === 'string' ? vectorQuery.fields : 'ada_v3_large',
          vectorK: typeof vectorQuery?.k === 'number' ? vectorQuery.k : 10,
          vectorExhaustive: typeof vectorQuery?.exhaustive === 'boolean' ? vectorQuery.exhaustive : false,
          vectorWeight: typeof vectorQuery?.weight === 'number' ? vectorQuery.weight : 1.0,
          vectorThresholdKind,
          vectorThresholdValue,
          vectorOversampling: typeof vectorQuery?.oversampling === 'number' ? vectorQuery.oversampling : '',
          vectorPerDocumentVectorLimit:
            typeof vectorQuery?.perDocumentVectorLimit === 'number'
              ? vectorQuery.perDocumentVectorLimit
              : '',
          vectorFilterOverride:
            typeof vectorQuery?.filterOverride === 'string' ? vectorQuery.filterOverride : '',
        })
      } else {
        setLabMode('query')
        setBuilderMode('form')

        // Restore index name
        if (run.context.indexName) {
          setIndexName(run.context.indexName)
        }

        const queryTypeRaw = getString('queryType', 'simple')
        const queryType: SearchFormState['queryType'] =
          queryTypeRaw === 'simple' || queryTypeRaw === 'full' || queryTypeRaw === 'semantic'
            ? queryTypeRaw
            : 'simple'

        const facets = Array.isArray(requestObj.facets)
          ? requestObj.facets.filter((x): x is string => typeof x === 'string').join(',')
          : typeof requestObj.facets === 'string'
            ? requestObj.facets
            : ''
        const scoringParameters = Array.isArray(requestObj.scoringParameters)
          ? requestObj.scoringParameters.filter((x): x is string => typeof x === 'string').join(',')
          : typeof requestObj.scoringParameters === 'string'
            ? requestObj.scoringParameters
            : ''
        const semanticFields = Array.isArray(requestObj.semanticFields)
          ? requestObj.semanticFields.filter((x): x is string => typeof x === 'string').join(',')
          : typeof requestObj.semanticFields === 'string'
            ? requestObj.semanticFields
            : ''

        const scoringStatistics =
          requestObj.scoringStatistics === 'local' || requestObj.scoringStatistics === 'global'
            ? requestObj.scoringStatistics
            : ''
        const speller = requestObj.speller === 'none' || requestObj.speller === 'lexicon' ? requestObj.speller : ''
        const semanticErrorHandling =
          requestObj.semanticErrorHandling === 'partial' || requestObj.semanticErrorHandling === 'fail'
            ? requestObj.semanticErrorHandling
            : ''
        const vectorFilterMode =
          requestObj.vectorFilterMode === 'preFilter' ||
          requestObj.vectorFilterMode === 'postFilter' ||
          requestObj.vectorFilterMode === 'strictPostFilter'
            ? requestObj.vectorFilterMode
            : ''

        const hybridSearch = isJsonObject(requestObj.hybridSearch) ? requestObj.hybridSearch : null
        const hybridMaxTextRecallSize =
          typeof hybridSearch?.maxTextRecallSize === 'number' ? hybridSearch.maxTextRecallSize : ''
        const hybridCountAndFacetMode =
          hybridSearch?.countAndFacetMode === 'countAllResults' ||
          hybridSearch?.countAndFacetMode === 'countRetrievableResults'
            ? hybridSearch.countAndFacetMode
            : ''

        // Reset to default values and restore search form with all parameters
        setSearchForm({
          search: getString('search', ''),
          queryType,
          top: getNumber('top', 10),
          skip: getNumber('skip', 0),
          count: getBoolean('count', true),
          select: getString('select', ''),
          filter: getString('filter', ''),
          orderby: getString('orderby', ''),
          searchMode: getString('searchMode', ''),
          searchFields: getString('searchFields', ''),
          facets,
          highlight: getString('highlight', ''),
          highlightPreTag: typeof requestObj.highlightPreTag === 'string' ? requestObj.highlightPreTag : '',
          highlightPostTag: typeof requestObj.highlightPostTag === 'string' ? requestObj.highlightPostTag : '',
          scoringProfile: getString('scoringProfile', ''),
          scoringParameters,
          queryRewrites: typeof requestObj.queryRewrites === 'string' ? requestObj.queryRewrites : '',
          debug: typeof requestObj.debug === 'string' ? requestObj.debug : '',
          semanticQuery: typeof requestObj.semanticQuery === 'string' ? requestObj.semanticQuery : '',
          minimumCoverage: typeof requestObj.minimumCoverage === 'number' ? requestObj.minimumCoverage : '',
          scoringStatistics,
          sessionId: typeof requestObj.sessionId === 'string' ? requestObj.sessionId : '',
          speller,
          semanticErrorHandling,
          semanticMaxWaitInMilliseconds:
            typeof requestObj.semanticMaxWaitInMilliseconds === 'number'
              ? requestObj.semanticMaxWaitInMilliseconds
              : '',
          semanticFields,
          vectorFilterMode,
          hybridMaxTextRecallSize,
          hybridCountAndFacetMode,
          semanticConfiguration: getString('semanticConfiguration', 'default'),
          queryLanguage: getString('queryLanguage', 'ja-jp'),
          captions: getString('captions', 'extractive'),
          answers: getString('answers', 'extractive|count-3'),
          vectorEnabled: false,
          vectorQueries: [],
          vectorKind: 'text',
          vectorText: '',
          vectorQueryRewrites: '',
          vector: '',
          vectorImageUrl: '',
          vectorBase64Image: '',
          vectorFields: '',
          vectorK: 10,
          vectorExhaustive: false,
          vectorWeight: 1.0,
          vectorThresholdKind: '',
          vectorThresholdValue: 0,
          vectorOversampling: '',
          vectorPerDocumentVectorLimit: '',
          vectorFilterOverride: '',
        })
      }

      // For qps_test, restore the Request Builder state above, then open QPS Tester and load results from this run.
      if (run.runType === 'qps_test') {
        setQpsTesterRestoreRunId(runId)
        setIsQpsTesterOpen(true)
        setCenterTab('qps-tester')
        return
      }

      // For auto_tuning, restore the Request Builder state above, then open AutoTuning and load results from this run.
      if (run.runType === 'auto_tuning') {
        setAutoTuningRestoreRunId(runId)
        setIsAutoTuningOpen(true)
        setCenterTab('auto-tuning')
        return
      }

      // Restore latest response
      const restoredResponse: LatestResponse = {
        at: run.startedAt,
        runId: run.runId,
        requestId: run.metrics.serviceRequestId ?? '',
        clientRequestId: run.metrics.clientRequestId,
        url: '', // URL is not stored in run
        status: run.metrics.httpStatus ?? 200,
        body: responseBody ?? {},
        requestBody: requestBody,
        runType: run.runType,
        latencyMs: run.metrics.latencyMs,
        elapsedTimeMs: run.metrics.elapsedTimeMs,
      }

      // Set response and result map FIRST, then switch tab
      // This ensures latestResponse is set before centerTab changes to 'latest'
      // preventing useCenterTabSync from resetting the tab
      setLatestResponse(restoredResponse)
      setRunResultMap((prev) => ({
        ...prev,
        [runId]: { run, response: restoredResponse },
      }))
      setResultPages((prev) => ({ ...prev, latest: 1 }))

      // Switch to latest tab after response is set
      setCenterTab('latest')
    } catch (e) {
      console.error('Failed to restore run:', e)
      alert(t('restoreFailed') + ': ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  return { onRestoreRun }
}
