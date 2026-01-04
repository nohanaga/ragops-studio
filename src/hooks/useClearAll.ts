import type { Dispatch, SetStateAction } from 'react'
import type { AgenticFormState, AnalyzeFormState, CenterTab, LatestResponse, SearchFormState } from '../types'
import type { AppSettings, Run } from '../lib/model'
import { translations, type Language, type TranslationKey } from '../lib/translations'
import { clearLastViewedRunId } from '../app/persistedLatestRun'

function clearPersistedLatestRunId(selectedExperimentId: string | null) {
  if (!selectedExperimentId) return
  try {
    const key = `tabs:${selectedExperimentId}`
    const raw = localStorage.getItem(key)
    if (!raw) return
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = parsed as any
    if ('latestRunId' in obj) {
      delete obj.latestRunId
      localStorage.setItem(key, JSON.stringify(obj))
    }
  } catch {
    // ignore
  }
}

type TFunction = (key: TranslationKey) => string

export function useClearAll(params: {
  t: TFunction
  language: Language
  selectedExperimentId: string | null
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>
  setSearchForm: Dispatch<SetStateAction<SearchFormState>>
  setAgenticForm: Dispatch<SetStateAction<AgenticFormState>>
  setAnalyzeForm: Dispatch<SetStateAction<AnalyzeFormState>>
  setRequestJson: Dispatch<SetStateAction<string>>
  setLatestResponse: Dispatch<SetStateAction<LatestResponse | null>>
  setRunResultMap: Dispatch<SetStateAction<Record<string, { run: Run; response: LatestResponse | null }>>>
  setResultPages: Dispatch<SetStateAction<Record<string, number>>>
  setCenterTab: Dispatch<SetStateAction<CenterTab>>
}) {
  const {
    t,
    language,
    selectedExperimentId,
    patchSettings,
    setSearchForm,
    setAgenticForm,
    setAnalyzeForm,
    setRequestJson,
    setLatestResponse,
    setRunResultMap,
    setResultPages,
    setCenterTab,
  } = params

  /** Clears builder inputs and transient UI state. */
  function onClearAll() {
    if (!confirm(t('confirmClear'))) {
      return
    }

    // Reset search form to initial state
    setSearchForm({
      search: '',
      queryType: 'simple',
      top: 10,
      skip: 0,
      count: true,
      select: '',
      filter: '',
      orderby: '',
      searchMode: '',
      searchFields: '',
      facets: '',
      highlight: '',
      highlightPreTag: '',
      highlightPostTag: '',
      scoringProfile: '',
      scoringParameters: '',
      queryRewrites: '',
      debug: '',
      semanticQuery: '',
      minimumCoverage: '',
      scoringStatistics: '',
      sessionId: '',
      speller: '',
      semanticErrorHandling: '',
      semanticMaxWaitInMilliseconds: '',
      semanticFields: '',
      vectorFilterMode: '',
      hybridMaxTextRecallSize: '',
      hybridCountAndFacetMode: '',
      semanticConfiguration: 'default',
      queryLanguage: 'ja-jp',
      captions: 'extractive',
      answers: 'extractive|count-3',
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

    // Reset agentic form to initial state
    setAgenticForm({
      userMessage: translations[language]['sampleQuery'],
      includeActivity: true,
      outputMode: 'answerSynthesis',
      maxRuntimeInSeconds: 60,
      maxOutputSize: 100000,
      retrievalReasoningEffort: 'low',
      knowledgeSourceParams: [],
    })

    // Reset analyze form to initial state
    setAnalyzeForm({
      text: '',
      analyzerName: '',
      tokenizerName: '',
      normalizerName: '',
      charFilters: '',
      tokenFilters: '',
    })

    // Clear request JSON
    setRequestJson('')

    // Clear results and response
    setLatestResponse(null)
    setRunResultMap({})

    // Also clear the persisted latest result pointer.
    clearPersistedLatestRunId(selectedExperimentId)
    clearLastViewedRunId()

    // Clear pagination
    setResultPages({ latest: 1 })

    // Reset display field settings to defaults
    void patchSettings({
      displayTitleFields: 'title,name,id,key,documentId,chunkId,path,url,metadata_storage_name',
      displayTextFields: 'text,content,description,chunk',
    })

    // Switch to builder tab
    setCenterTab('builder')
  }

  return { onClearAll }
}
