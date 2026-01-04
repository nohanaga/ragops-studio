import { useEffect, useLayoutEffect, useRef } from 'react'
import type { AgenticFormState, AnalyzeFormState, BuilderMode, LabMode, SearchFormState } from '../types'

type PersistedBuilderState = {
  labMode?: LabMode
  builderMode?: BuilderMode
  searchForm?: SearchFormState
  agenticForm?: AgenticFormState
  analyzeForm?: AnalyzeFormState
  requestJson?: string
  indexName?: string
  knowledgeBaseName?: string
}

function storageKey(experimentId: string) {
  return `builder:${experimentId}`
}

function isBuilderMode(v: unknown): v is BuilderMode {
  return v === 'form' || v === 'json'
}

function isLabMode(v: unknown): v is LabMode {
  return (
    v === 'query' ||
    v === 'semantic-vector' ||
    v === 'analyze' ||
    v === 'agentic'
  )
}

export function loadPersistedBuilderState(experimentId: string): PersistedBuilderState | null {
  try {
    const raw = localStorage.getItem(storageKey(experimentId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedBuilderState
    if (!parsed || typeof parsed !== 'object') return null

    const next: PersistedBuilderState = {}

    if (isLabMode(parsed.labMode)) next.labMode = parsed.labMode
    if (isBuilderMode(parsed.builderMode)) next.builderMode = parsed.builderMode

    if (typeof parsed.requestJson === 'string') next.requestJson = parsed.requestJson
    if (typeof parsed.indexName === 'string') next.indexName = parsed.indexName
    if (typeof parsed.knowledgeBaseName === 'string') next.knowledgeBaseName = parsed.knowledgeBaseName

    if (parsed.searchForm && typeof parsed.searchForm === 'object') next.searchForm = parsed.searchForm
    if (parsed.agenticForm && typeof parsed.agenticForm === 'object') next.agenticForm = parsed.agenticForm
    if (parsed.analyzeForm && typeof parsed.analyzeForm === 'object') next.analyzeForm = parsed.analyzeForm

    return next
  } catch {
    return null
  }
}

export function usePersistedBuilderState(params: {
  selectedExperimentId: string | null

  labMode: LabMode
  setLabMode: (v: LabMode) => void

  builderMode: BuilderMode
  setBuilderMode: (v: BuilderMode) => void

  searchForm: SearchFormState
  setSearchForm: (v: SearchFormState) => void

  agenticForm: AgenticFormState
  setAgenticForm: (v: AgenticFormState) => void

  analyzeForm: AnalyzeFormState
  setAnalyzeForm: (v: AnalyzeFormState) => void

  requestJson: string
  setRequestJson: (v: string) => void

  indexName: string
  setIndexName: (v: string) => void

  knowledgeBaseName: string
  setKnowledgeBaseName: (v: string) => void
}) {
  const {
    selectedExperimentId,
    labMode,
    setLabMode,
    builderMode,
    setBuilderMode,
    searchForm,
    setSearchForm,
    agenticForm,
    setAgenticForm,
    analyzeForm,
    setAnalyzeForm,
    requestJson,
    setRequestJson,
    indexName,
    setIndexName,
    knowledgeBaseName,
    setKnowledgeBaseName,
  } = params

  /**
   * Tracks whether the restoration logic has completed for the current experiment.
   * When switching experiments, restoration happens in the first useEffect, and this
   * flag ensures the second useEffect doesn't immediately overwrite the restored state.
   */
  const hasRestoredRef = useRef(false)

  // Experiment selection should not implicitly overwrite the current builder UI.
  // We only apply persisted builder state on initial boot (when there was no
  // previously selected experiment).
  const lastExperimentIdRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (!selectedExperimentId) {
      lastExperimentIdRef.current = null
      return
    }

    const previousExperimentId = lastExperimentIdRef.current
    lastExperimentIdRef.current = selectedExperimentId

    const shouldApplyPersistedBuilderState = previousExperimentId === null

    // Mark restoration as not yet complete
    hasRestoredRef.current = false

    if (!shouldApplyPersistedBuilderState) {
      // Do not change the builder UI when switching experiments.
      // Allow future saves under the newly selected experiment.
      hasRestoredRef.current = true
      return
    }

    const restored = loadPersistedBuilderState(selectedExperimentId)
    if (!restored) {
      // No persisted state: allow future saves.
      hasRestoredRef.current = true
      return
    }

    if (restored.labMode) setLabMode(restored.labMode)
    if (restored.builderMode) setBuilderMode(restored.builderMode)

    if (typeof restored.indexName === 'string') setIndexName(restored.indexName)
    if (typeof restored.knowledgeBaseName === 'string') setKnowledgeBaseName(restored.knowledgeBaseName)

    if (restored.searchForm) setSearchForm(restored.searchForm)
    if (restored.agenticForm) setAgenticForm(restored.agenticForm)
    if (restored.analyzeForm) setAnalyzeForm(restored.analyzeForm)

    if (typeof restored.requestJson === 'string') setRequestJson(restored.requestJson)

    // Mark restoration as complete
    hasRestoredRef.current = true
  }, [
    selectedExperimentId,
    setAgenticForm,
    setAnalyzeForm,
    setBuilderMode,
    setIndexName,
    setKnowledgeBaseName,
    setLabMode,
    setRequestJson,
    setSearchForm,
  ])

  useEffect(() => {
    if (!selectedExperimentId) return
    // Skip saving until restoration completes
    if (!hasRestoredRef.current) return

    const payload: PersistedBuilderState = {
      labMode,
      builderMode,
      searchForm,
      agenticForm,
      analyzeForm,
      requestJson,
      indexName,
      knowledgeBaseName,
    }

    try {
      localStorage.setItem(storageKey(selectedExperimentId), JSON.stringify(payload))
    } catch {
      // ignore
    }
  }, [
    selectedExperimentId,
    labMode,
    builderMode,
    searchForm,
    agenticForm,
    analyzeForm,
    requestJson,
    indexName,
    knowledgeBaseName,
  ])
}
