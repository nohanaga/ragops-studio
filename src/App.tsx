/**
 * Main application component.
 *
 * This file is intentionally large because it stitches together:
 * - State (settings, experiments, runs, builders)
 * - Persistence (IndexedDB + localStorage)
 * - REST execution wiring (useApiOperations)
 *
 * Most domain logic lives in `src/lib/*` and `src/utils/*`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import Dropdown from 'bootstrap/js/dist/dropdown'
import {
  listIndexes,
  getIndexDefinition,
  resolveSearchApiVersion,
} from './lib/aiSearchRest'
import { translations, type Language } from './lib/translations'
import type {
  CenterTab,
  ResultView,
  PaneSizes,
} from './types'
import {
  getInitialPaneSizes,
} from './utils'
import { LAST_SELECTED_EXPERIMENT_ID_KEY, PORTAL_DISMISSED_KEY } from './app/constants'
import { buildRequestBuilderActiveSummary as buildRequestBuilderActiveSummaryFn } from './app/requestSummary'
import { useApiOperations } from './hooks/useApiOperations'
import { useJwtDecoderModal } from './hooks/useJwtDecoderModal'
import { useRunRestore } from './hooks/useRunRestore'
import { useTextToVectorTool } from './hooks/useTextToVectorTool'
import { useSharedLlmConfig } from './hooks/useSharedLlmConfig'
import { useRequestBuilderIndexSchema } from './hooks/useRequestBuilderIndexSchema'
import { useExperimentRunActions } from './hooks/useExperimentRunActions'
import { useClearAll } from './hooks/useClearAll'
import { useSelectedRunsArtifacts } from './hooks/useSelectedRunsArtifacts'
import { useAppBootstrap } from './hooks/useAppBootstrap'
import { useThemePersistence } from './hooks/useThemePersistence'
import { usePersistedTabsState } from './hooks/usePersistedTabsState'
import { useLatestResponseRestore } from './hooks/useLatestResponseRestore'
import { usePersistedBuilderState } from './hooks/usePersistedBuilderState'
import { usePaneResize } from './hooks/usePaneResize'
import { useRequestJsonSync } from './hooks/useRequestJsonSync'
import { useExperimentTabRestore } from './hooks/useExperimentTabRestore'
import { useCenterTabSync } from './hooks/useCenterTabSync'
import { useKnowledgeBaseData } from './hooks/useKnowledgeBaseData'
import { useAnalyzeDropdownFilters } from './hooks/useAnalyzeDropdownFilters'
import { useIndexDropdownState } from './hooks/useIndexDropdownState'
import { useIndexInspectorState } from './hooks/useIndexInspectorState'
import { useRunTabActions } from './hooks/useRunTabActions'
import { useResultViewRenderer } from './hooks/useResultViewRenderer'
import { useRightPaneDerivations } from './hooks/useRightPaneDerivations'
import { AppLayout } from './components/AppLayout'
import { useTheme, useSettings, useModalState, useUiState, useBuilderState, useExperiment } from './contexts'

function App() {
  /**
   * Root application component.
   *
   * Wires together persisted settings/experiments/runs, request builders,
   * REST execution, and the multi-pane UI.
   */

  // ============================================================================
  // Context Hooks - Replaces local useState for global state
  // ============================================================================
  const { theme, language, setLanguage } = useTheme()
  const { settings, setSettings, activeProfile, patchSettings } = useSettings()
  const {
    isQpsTesterOpen,
    setIsQpsTesterOpen,
    isAutoTuningOpen,
    setIsAutoTuningOpen,
    isSearchPipelineVisualizerOpen,
    setIsSearchPipelineVisualizerOpen,
    isKnowledgeSourceBuilderOpen,
    setIsKnowledgeSourceBuilderOpen,
    isKnowledgeBaseBuilderOpen,
    setIsKnowledgeBaseBuilderOpen,
    isSynonymMapBuilderOpen,
    setIsSynonymMapBuilderOpen,
    isIndexBuilderOpen,
    setIsIndexBuilderOpen,
    isIndexingPipelineBuilderOpen,
    setIsIndexingPipelineBuilderOpen,
    isSkillPipelineBuilderOpen,
    setIsSkillPipelineBuilderOpen,
    isVectorOptimizerOpen,
    setIsVectorOptimizerOpen,
    isFilterBuilderOpen,
    setIsFilterBuilderOpen,
    isSkillEditorOpen,
    setIsSkillEditorOpen,
    isEvalDatasetGeneratorOpen,
    setIsEvalDatasetGeneratorOpen,
    isIndexVisualizerOpen,
    setIsIndexVisualizerOpen,
  } = useModalState()
  const {
    setUiError,
    setUiLog,
    latestResponse,
    setLatestResponse,
    resultPages,
    setResultPages,
    runResultMap,
    setRunResultMap,
    isRightPaneCollapsed,
  } = useUiState()
  const {
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
    autocompleteForm,
    setAutocompleteForm,
    suggestForm,
    setSuggestForm,
    requestJson,
    setRequestJson,
    runNote,
    setRunNote,
    indexName,
    setIndexName,
    knowledgeBaseName,
    setKnowledgeBaseName,
  } = useBuilderState()
  const {
    experiments,
    setExperiments,
    selectedExperimentId,
    setSelectedExperimentId,
    runs,
    setRuns,
    selectedRunIds,
    setSelectedRunIds,
    selectedRun,
    setSelectedRun,
    setRunQueryFilterText,
    reloadExperiments,
    reloadRuns,
  } = useExperiment()

  // ============================================================================
  // Local State - App-specific state not shared globally
  // ============================================================================
  const [bootError, setBootError] = useState<string | null>(null)

  const [paneSizes, setPaneSizes] = useState<PaneSizes>(() => getInitialPaneSizes())
  const [dragging, setDragging] = useState<null | { side: 'left' | 'right' | 'vertical'; x0: number; y0: number; s0: PaneSizes }>(null)

  const [centerTab, setCenterTab] = useState<CenterTab>(() => {
    try {
      return localStorage.getItem(PORTAL_DISMISSED_KEY) === '1' ? 'builder' : 'portal'
    } catch {
      return 'builder'
    }
  })
  const [qpsTesterRestoreRunId, setQpsTesterRestoreRunId] = useState<string | null>(null)
  const [autoTuningRestoreRunId, setAutoTuningRestoreRunId] = useState<string | null>(null)
  const [compareMode, setCompareMode] = useState(false)

  const [availableIndexNames, setAvailableIndexNames] = useState<string[]>([])
  const [isIndexNamesLoading, setIsIndexNamesLoading] = useState(false)
  const [indexNamesReloadToken, setIndexNamesReloadToken] = useState(0)
  const reloadIndexNames = useCallback(() => setIndexNamesReloadToken((value) => value + 1), [])
  const selectedIndexNameRef = useRef(indexName)

  useEffect(() => {
    selectedIndexNameRef.current = indexName
  }, [indexName])

  const analyzeDropdownFilters = useAnalyzeDropdownFilters()

  const {
    analyzerDropdownToggleRef,
    analyzerDropdownMenuRef,
    analyzerFilterInputRef,
    setAnalyzerFilterText,

    tokenizerDropdownToggleRef,
    tokenizerDropdownMenuRef,
    tokenizerFilterInputRef,
    setTokenizerFilterText,

    normalizerDropdownToggleRef,
    normalizerDropdownMenuRef,
    normalizerFilterInputRef,
    setNormalizerFilterText,

    charFilterDropdownToggleRef,
    charFilterDropdownMenuRef,
    charFilterInputRef,
    setCharFilterText,

    tokenFilterDropdownToggleRef,
    tokenFilterDropdownMenuRef,
    tokenFilterInputRef,
    setTokenFilterText,
  } = analyzeDropdownFilters

  const effectiveApiVersion = activeProfile
    ? labMode === 'agentic'
      ? resolveSearchApiVersion(activeProfile.apiVersion, '2025-11-01-preview')
      : activeProfile.apiVersion
    : ''
  const isPreviewApiVersion = effectiveApiVersion.includes('preview')

  const {
    knowledgeBaseNamesLoading,
    knowledgeBaseNamesError,
    knowledgeBaseNameOptions,
    availableKnowledgeSources,
  } = useKnowledgeBaseData({
    labMode,
    activeProfile,
    knowledgeBaseName,
    language,
    setAgenticForm,
  })

  const {
    isLoadingRequestBuilderSchema,
    requestBuilderFacetFieldInfos,
    requestBuilderKeyFieldName,
    requestBuilderIndexFieldNames,
    requestBuilderSearchableFieldNames,
    requestBuilderVectorFieldNames,
    requestBuilderSuggesterNames,
  } = useRequestBuilderIndexSchema({
    activeProfile,
    indexName,
    apiVersion: effectiveApiVersion,
    language,
  })

  useEffect(() => {
    if (labMode !== 'semantic-vector' || !searchForm.vectorEnabled) return
    if (requestBuilderVectorFieldNames.length === 0) return

    const current = searchForm.vectorFields.trim()
    if (current.includes(',')) return

    const next = (!current || !requestBuilderVectorFieldNames.includes(current)) ? requestBuilderVectorFieldNames[0] : null
    if (!next || next === current) return
    setSearchForm((p) => ({ ...p, vectorFields: next }))
  }, [labMode, searchForm.vectorEnabled, searchForm.vectorFields, requestBuilderVectorFieldNames, setSearchForm])

  const indexInspector = useIndexInspectorState()

  const {
    isIndexInspectorOpen,
    indexInspectorIndexName,
    indexInspectorReloadToken,
    setIsIndexInspectorOpen,
    setIndexInspectorIndexName,
    setIndexInspectorLoading,
    setIndexInspectorError,
    setIndexInspectorDefinition,
    setIndexInspectorEditedJson,
    setIndexInspectorReloadToken,
  } = indexInspector

  const jwtDecoder = useJwtDecoderModal(language)

  // IndexName dropdown refs and state
  const {
    indexDropdownToggleRef,
    indexDropdownMenuRef,
    indexFilterInputRef,
    indexFilterText,
    setIndexFilterText,
  } = useIndexDropdownState()

  // Load index list for indexName suggestions and index-aware tools.
  useEffect(() => {
    if (!activeProfile) {
      setAvailableIndexNames([])
      setIsIndexNamesLoading(false)
      return
    }
    if (!effectiveApiVersion.trim()) {
      setAvailableIndexNames([])
      setIsIndexNamesLoading(false)
      return
    }

    let cancelled = false
    setIsIndexNamesLoading(true)
    ;(async () => {
      try {
        const res = await listIndexes({ profile: activeProfile, apiVersion: effectiveApiVersion, language })
        if (cancelled) return
        if (!res.ok) {
          setAvailableIndexNames([])
          return
        }
        const json = res.response
        const value =
          json && typeof json === 'object' && Array.isArray((json as { value?: unknown }).value)
            ? ((json as { value: Array<{ name?: unknown }> }).value ?? [])
            : []
        const names = value
          .map((x) => (typeof x?.name === 'string' ? x.name : ''))
          .filter((s) => s.trim().length > 0)
          .map((s) => s.trim())

        // Keep stable order for UI.
        const uniq = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b))
        setAvailableIndexNames(uniq)
        const selectedIndexName = selectedIndexNameRef.current.trim()
        if (selectedIndexName && !uniq.includes(selectedIndexName)) {
          setIndexName('')
        }
      } catch {
        if (cancelled) return
        setAvailableIndexNames([])
      } finally {
        if (!cancelled) setIsIndexNamesLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeProfile, effectiveApiVersion, indexNamesReloadToken, language, setIndexName])

  // Focus filter input when indexName dropdown opens
  useEffect(() => {
    const toggle = indexDropdownToggleRef.current
    if (!toggle) return
    const handleShown = () => {
      setTimeout(() => {
        indexFilterInputRef.current?.focus()
        indexFilterInputRef.current?.select()
      }, 100)
    }
    toggle.addEventListener('shown.bs.dropdown', handleShown)
    return () => toggle.removeEventListener('shown.bs.dropdown', handleShown)
  }, [indexDropdownToggleRef, indexFilterInputRef])

  // Filtered indexName options for dropdown
  const filteredIndexNameOptions = useMemo(() => {
    if (!indexFilterText.trim()) return availableIndexNames
    const lower = indexFilterText.toLowerCase()
    return availableIndexNames.filter((name) => name.toLowerCase().includes(lower))
  }, [availableIndexNames, indexFilterText])

  // Knowledge base list/source loading moved to useKnowledgeBaseData

  /**
   * Translation helper bound to the current language.
   *
   * Kept as a stable callback to avoid unnecessary re-renders.
   */
  const t = useCallback((key: keyof typeof translations.ja) => {
    return translations[language][key]
  }, [language])

  /**
   * Simple string formatter for translated text.
   *
   * Replaces `{name}` placeholders with provided values (string/number).
   */
  const format = (key: keyof typeof translations.ja, params: Record<string, string | number>): string => {
    let text: string = String(t(key) ?? '')
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
    return text
  }

  const sharedLlm = useSharedLlmConfig()
  const textToVector = useTextToVectorTool({ t, sharedLlm })

  const buildRequestBuilderActiveSummary = useCallback((): string => {
    return buildRequestBuilderActiveSummaryFn({
      t,
      labMode,
      indexName,
      searchForm,
      isPreviewApiVersion,
    })
  }, [t, labMode, indexName, searchForm, isPreviewApiVersion])

  /** Parses a comma-separated list string into trimmed tokens. */
  const csvToList = (csv: string): string[] => {
    return csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  /**
   * Toggles a single value inside a CSV string.
   *
   * Uses `orderedUniverse` to keep output ordering stable and predictable.
   */
  const toggleCsvSelection = (csv: string, value: string, orderedUniverse: readonly string[]): string => {
    const selected = new Set(csvToList(csv))
    if (selected.has(value)) {
      selected.delete(value)
    } else {
      selected.add(value)
    }
    return orderedUniverse.filter((v) => selected.has(v)).join(',')
  }

  /**
   * Imperatively closes the closest Bootstrap dropdown.
   *
   * Used after selecting from searchable dropdowns to avoid leaving them open.
   */
  const hideClosestBootstrapDropdown = (fromEl: HTMLElement | null) => {
    if (!fromEl) return
    const dropdownRoot = fromEl.closest('.dropdown')
    if (!dropdownRoot) return
    const toggle = dropdownRoot.querySelector('[data-bs-toggle="dropdown"]') as HTMLElement | null
    if (!toggle) return
    Dropdown.getOrCreateInstance(toggle).hide()
  }

  /** Opens the Index Inspector modal, defaulting to the current indexName. */
  const openIndexInspector = (name?: string) => {
    const target = (name ?? indexName).trim()
    setIndexInspectorIndexName(target)
    setIsIndexInspectorOpen(true)
  }

  /** Triggers a reload of the Index Inspector by bumping a token. */
  const reloadIndexInspector = () => {
    setIndexInspectorReloadToken((v) => v + 1)
  }

  useEffect(() => {
    if (!isIndexInspectorOpen) return

    const idx = indexInspectorIndexName.trim()
    if (!idx) {
      setIndexInspectorError(t('indexInspectorIndexNameUnset'))
      setIndexInspectorDefinition(null)
      return
    }
    if (!activeProfile) {
      setIndexInspectorError(t('indexInspectorProfileUnset'))
      setIndexInspectorDefinition(null)
      return
    }
    if (!effectiveApiVersion.trim()) {
      setIndexInspectorError(t('indexInspectorApiVersionUnset'))
      setIndexInspectorDefinition(null)
      return
    }

    let cancelled = false
    setIndexInspectorLoading(true)
    setIndexInspectorError(null)

    ;(async () => {
      try {
        const res = await getIndexDefinition({
          profile: activeProfile,
          indexName: idx,
          apiVersion: effectiveApiVersion,
          language,
        })
        if (cancelled) return
        if (!res.ok) {
          setIndexInspectorDefinition(res.error.response ?? null)
          setIndexInspectorEditedJson(JSON.stringify(res.error.response ?? {}, null, 2))
          setIndexInspectorError(res.error.message)
          return
        }
        setIndexInspectorDefinition(res.response)
        setIndexInspectorEditedJson(JSON.stringify(res.response ?? {}, null, 2))
      } catch (e) {
        if (cancelled) return
        setIndexInspectorDefinition(null)
        setIndexInspectorError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setIndexInspectorLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    isIndexInspectorOpen,
    indexInspectorIndexName,
    indexInspectorReloadToken,
    setIndexInspectorDefinition,
    setIndexInspectorEditedJson,
    setIndexInspectorError,
    setIndexInspectorLoading,
    activeProfile,
    effectiveApiVersion,
    language,
    t,
  ])

  useEffect(() => {
    const toggle = analyzerDropdownToggleRef.current
    if (!toggle) return

    const onShown: EventListener = () => {
      // Reset filter so the currently-selected item is visible and can be highlighted.
      setAnalyzerFilterText('')
      window.setTimeout(() => {
        analyzerFilterInputRef.current?.focus()
        const menu = analyzerDropdownMenuRef.current
        const active = menu?.querySelector('.dropdown-item.active') as HTMLElement | null
        active?.scrollIntoView({ block: 'nearest' })
      }, 0)
    }

    toggle.addEventListener('shown.bs.dropdown', onShown)
    return () => {
      toggle.removeEventListener('shown.bs.dropdown', onShown)
    }
  }, [analyzerDropdownToggleRef, analyzerDropdownMenuRef, analyzerFilterInputRef, setAnalyzerFilterText])

  useEffect(() => {
    const toggle = tokenizerDropdownToggleRef.current
    if (!toggle) return

    const onShown: EventListener = () => {
      setTokenizerFilterText('')
      window.setTimeout(() => {
        tokenizerFilterInputRef.current?.focus()
        const menu = tokenizerDropdownMenuRef.current
        const active = menu?.querySelector('.dropdown-item.active') as HTMLElement | null
        active?.scrollIntoView({ block: 'nearest' })
      }, 0)
    }

    toggle.addEventListener('shown.bs.dropdown', onShown)
    return () => {
      toggle.removeEventListener('shown.bs.dropdown', onShown)
    }
  }, [tokenizerDropdownToggleRef, tokenizerDropdownMenuRef, tokenizerFilterInputRef, setTokenizerFilterText])

  useEffect(() => {
    const toggle = normalizerDropdownToggleRef.current
    if (!toggle) return

    const onShown: EventListener = () => {
      setNormalizerFilterText('')
      window.setTimeout(() => {
        normalizerFilterInputRef.current?.focus()
        const menu = normalizerDropdownMenuRef.current
        const active = menu?.querySelector('.dropdown-item.active') as HTMLElement | null
        active?.scrollIntoView({ block: 'nearest' })
      }, 0)
    }

    toggle.addEventListener('shown.bs.dropdown', onShown)
    return () => {
      toggle.removeEventListener('shown.bs.dropdown', onShown)
    }
  }, [normalizerDropdownToggleRef, normalizerDropdownMenuRef, normalizerFilterInputRef, setNormalizerFilterText])

  useEffect(() => {
    const toggle = charFilterDropdownToggleRef.current
    if (!toggle) return

    const onShown: EventListener = () => {
      setCharFilterText('')
      window.setTimeout(() => {
        charFilterInputRef.current?.focus()
        const menu = charFilterDropdownMenuRef.current
        const active = menu?.querySelector('.dropdown-item.active') as HTMLElement | null
        active?.scrollIntoView({ block: 'nearest' })
      }, 0)
    }

    toggle.addEventListener('shown.bs.dropdown', onShown)
    return () => {
      toggle.removeEventListener('shown.bs.dropdown', onShown)
    }
  }, [charFilterDropdownToggleRef, charFilterDropdownMenuRef, charFilterInputRef, setCharFilterText])

  useEffect(() => {
    const toggle = tokenFilterDropdownToggleRef.current
    if (!toggle) return

    const onShown: EventListener = () => {
      setTokenFilterText('')
      window.setTimeout(() => {
        tokenFilterInputRef.current?.focus()
        const menu = tokenFilterDropdownMenuRef.current
        const active = menu?.querySelector('.dropdown-item.active') as HTMLElement | null
        active?.scrollIntoView({ block: 'nearest' })
      }, 0)
    }

    toggle.addEventListener('shown.bs.dropdown', onShown)
    return () => {
      toggle.removeEventListener('shown.bs.dropdown', onShown)
    }
  }, [tokenFilterDropdownToggleRef, tokenFilterDropdownMenuRef, tokenFilterInputRef, setTokenFilterText])

  const resultViews = useMemo<ResultView[]>(() => {
    const views: ResultView[] = [
      {
        id: 'latest',
        label: `${t('results')} (latest)`,
        response: latestResponse,
        runType: latestResponse?.runType ?? null,
        runId: latestResponse?.runId,
        indexName: latestResponse && latestResponse.runType !== 'agentic_retrieve' ? indexName.trim() : undefined,
        apiVersion: latestResponse && latestResponse.runType !== 'agentic_retrieve' ? activeProfile?.apiVersion : undefined,
      },
    ]

    for (const runId of selectedRunIds) {
      const entry = runResultMap[runId]
      const label = `Run ${runId.slice(0, 8)}`
      views.push({
        id: `run:${runId}`,
        label,
        response: entry?.response ?? null,
        runType: entry?.response?.runType ?? entry?.run?.runType ?? null,
        runId,
        indexName: entry?.run?.context.indexName,
        apiVersion: entry?.run?.context.apiVersion,
      })
    }

    return views
  }, [activeProfile?.apiVersion, indexName, latestResponse, runResultMap, selectedRunIds, t])

  const activeRunId = useMemo<string | null>(() => {
    if (centerTab === 'latest') return latestResponse?.runId ?? null
    if (typeof centerTab === 'string' && centerTab.startsWith('run:')) return centerTab.slice(4)
    return null
  }, [centerTab, latestResponse])

  const { isExecuting, onExecute, onExecuteAllModes } = useApiOperations({
    labMode,
    activeProfile,
    indexName,
    knowledgeBaseName,
    selectedExperimentId,
    requestJson,
    searchForm,
    runNote,
    language,
    t,
    setUiError,
    setUiLog,
    setLatestResponse,
    setRunResultMap,
    setSelectedRunIds,
    setCenterTab,
    setResultPages,
    reloadRuns,
  })

  /** Updates UI language and persists it into settings (when available). */
  async function changeLanguage(newLang: Language) {
    setLanguage(newLang)
    if (settings) {
      await patchSettings({ language: newLang })
    }
  }

  /** Best-effort clipboard copy; ignores failures (e.g., permissions). */
  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // ignore
    }
  }

  useAppBootstrap({
    setBootError,
    setSettings,
    setExperiments,
    setSelectedExperimentId,
    setLanguage,
  })

  useEffect(() => {
    if (!selectedExperimentId) return
    try {
      localStorage.setItem(LAST_SELECTED_EXPERIMENT_ID_KEY, selectedExperimentId)
    } catch {
      // ignore
    }
  }, [selectedExperimentId])

  useThemePersistence(theme)

  usePersistedBuilderState({
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
    autocompleteForm,
    setAutocompleteForm,
    suggestForm,
    setSuggestForm,
    requestJson,
    setRequestJson,
    runNote,
    setRunNote,
    indexName,
    setIndexName,
    knowledgeBaseName,
    setKnowledgeBaseName,
  })

  usePersistedTabsState({
    selectedExperimentId,
    selectedRunIds,
    centerTab,
    latestRunId: latestResponse?.runId ?? null,
    isQpsTesterOpen,
    isAutoTuningOpen,
    isSearchPipelineVisualizerOpen,
    isKnowledgeSourceBuilderOpen,
    isKnowledgeBaseBuilderOpen,
    isSynonymMapBuilderOpen,
    isIndexBuilderOpen,
    isIndexingPipelineBuilderOpen,
    isSkillPipelineBuilderOpen,
    isVectorOptimizerOpen,
    isSkillEditorOpen,
    isEvalDatasetGeneratorOpen,
    isIndexVisualizerOpen,
  })

  useLatestResponseRestore({
    selectedExperimentId,
    centerTab,
    latestResponse,
    setLatestResponse,
    setResultPages,
  })

  usePaneResize({ paneSizes, setPaneSizes, dragging, setDragging })

  useRequestJsonSync({
    builderMode,
    labMode,
    searchForm,
    agenticForm,
    analyzeForm,
    autocompleteForm,
    suggestForm,
    language,
    isPreviewApiVersion,
    requestJson,
    setRequestJson,
    setUiError,
  })

  useExperimentTabRestore({
    selectedExperimentId,
    centerTab,
    reloadRuns,
    setSelectedRun,
    setSelectedRunIds,
    setCenterTab,
    setIsQpsTesterOpen,
    setIsAutoTuningOpen,
    setIsSearchPipelineVisualizerOpen,
    setIsKnowledgeSourceBuilderOpen,
    setIsKnowledgeBaseBuilderOpen,
    setIsSynonymMapBuilderOpen,
    setIsIndexBuilderOpen,
    setIsIndexingPipelineBuilderOpen,
    setIsSkillPipelineBuilderOpen,
    setIsVectorOptimizerOpen,
    setIsSkillEditorOpen,
    setIsEvalDatasetGeneratorOpen,
    setIsIndexVisualizerOpen,
  })

  useSelectedRunsArtifacts({
    selectedRunIds,
    setSelectedRun,
    setIndexName,
    setKnowledgeBaseName,
    setRequestJson,
    setRunResultMap,
    setResultPages,
  })

  useCenterTabSync({
    centerTab,
    selectedRunIds,
    latestResponse,
    setCenterTab,
    setIsQpsTesterOpen,
    setIsAutoTuningOpen,
    setIsSearchPipelineVisualizerOpen,
    setIsKnowledgeSourceBuilderOpen,
    setIsKnowledgeBaseBuilderOpen,
    setIsSynonymMapBuilderOpen,
    setIsIndexBuilderOpen,
    setIsIndexingPipelineBuilderOpen,
    setIsSkillPipelineBuilderOpen,
    setIsVectorOptimizerOpen,
    setIsEvalDatasetGeneratorOpen,
    setIsIndexVisualizerOpen,
  })

  const { renderResultView } = useResultViewRenderer({
    t,
    language,
    settings,
    activeProfile,
    indexName,
    apiVersion: activeProfile?.apiVersion ?? '',
    requestBuilderKeyFieldName,
    resultPages,
    setResultPages,
    compareMode,
    setCompareMode,
    latestResponse,
    setLatestResponse,
    setRunResultMap,
  })

  /** Pastes the generated vector into the classic request builder's vector field. */
  function onPasteVectorToBuilder() {
    if (!textToVector.textToVectorResult) return
    const vectorString = textToVector.textToVectorResult.join(', ')
    setSearchForm((p) => ({
      ...p,
      vector: vectorString,
    }))
  }

  const {
    onCreateExperiment,
    onDeleteExperiment,
    onDeleteRun,
    onDeleteSelectedRuns,
    onExportRuns,
    onImportRunsFromFile,
  } = useExperimentRunActions({
    t,
    selectedExperimentId,
    experiments,
    runs,
    selectedRun,
    setSelectedRun,
    setSelectedRunIds,
    setRuns,
    reloadExperiments,
    reloadRuns,
  })

  const { onRestoreRun } = useRunRestore({
    t,
    format,
    setLabMode,
    setBuilderMode,
    setKnowledgeBaseName,
    setAgenticForm,
    setIndexName,
    setAnalyzeForm,
    setAutocompleteForm,
    setSuggestForm,
    setSearchForm,
    setRunNote,
    setQpsTesterRestoreRunId,
    setIsQpsTesterOpen,
    setAutoTuningRestoreRunId,
    setIsAutoTuningOpen,
    setCenterTab,
    setLatestResponse,
    setRunResultMap,
    setResultPages,
  })

  const { onClearAll } = useClearAll({
    t,
    language,
    selectedExperimentId,
    patchSettings,
    setSearchForm,
    setAgenticForm,
    setAnalyzeForm,
    setAutocompleteForm,
    setSuggestForm,
    setRequestJson,
    setRunNote,
    setLatestResponse,
    setRunResultMap,
    setResultPages,
    setCenterTab,
  })

  const { toggleRunSelection, closeRunTab } = useRunTabActions({
    setSelectedRunIds,
    setCenterTab,
  })

  const {
    activeResultView,
    gridTemplateColumns,
    jsonViewerRequestData,
    jsonViewerResponseData,
    jsonViewerFacets,
  } = useRightPaneDerivations({
    centerTab,
    resultViews,
    paneSizes,
    isRightPaneCollapsed,
    requestJson,
  })

  if (bootError) {
    return (
      <div className="app app--error">
        <h1>{t('bootErrorTitle')}</h1>
        <pre className="mono">{bootError}</pre>
      </div>
    )
  }

  return (
    <AppLayout
      t={t}
      format={format}
      changeLanguage={changeLanguage}
      textToVector={textToVector}
      sharedLlm={sharedLlm}
      onPasteVectorToBuilder={onPasteVectorToBuilder}
      centerTab={centerTab}
      setCenterTab={setCenterTab}
      paneSizes={paneSizes}
      dragging={dragging}
      setDragging={setDragging}
      gridTemplateColumns={gridTemplateColumns}
      onCreateExperiment={onCreateExperiment}
      onSelectExperiment={(id) => setSelectedExperimentId(id)}
      onDeleteExperiment={onDeleteExperiment}
      activeRunId={activeRunId}
      onRunQueryFilterTextChange={setRunQueryFilterText}
      onDeleteSelectedRuns={onDeleteSelectedRuns}
      onDeleteRun={onDeleteRun}
      onToggleRunSelection={toggleRunSelection}
      onRestoreRun={onRestoreRun}
      onExportRuns={onExportRuns}
      onImportRunsFromFile={onImportRunsFromFile}
      effectiveApiVersion={effectiveApiVersion}
      isPreviewApiVersion={isPreviewApiVersion}
      indexFilterText={indexFilterText}
      setIndexFilterText={setIndexFilterText}
      filteredIndexNameOptions={filteredIndexNameOptions}
      isIndexNamesLoading={isIndexNamesLoading}
      onReloadIndexNames={reloadIndexNames}
      openIndexInspector={openIndexInspector}
      onOpenIndexBuilderTab={(targetIndexName) => {
        const nextIndexName = targetIndexName?.trim()
        if (nextIndexName) setIndexName(nextIndexName)
        setIsIndexBuilderOpen(true)
        setCenterTab('index-builder')
      }}
      indexDropdownToggleRef={indexDropdownToggleRef}
      indexDropdownMenuRef={indexDropdownMenuRef}
      indexFilterInputRef={indexFilterInputRef}
      hideClosestBootstrapDropdown={hideClosestBootstrapDropdown}
      knowledgeBaseNamesLoading={knowledgeBaseNamesLoading}
      knowledgeBaseNamesError={knowledgeBaseNamesError}
      knowledgeBaseNameOptions={knowledgeBaseNameOptions}
      availableKnowledgeSources={availableKnowledgeSources}
      isLoadingRequestBuilderSchema={isLoadingRequestBuilderSchema}
      requestBuilderFacetFieldInfos={requestBuilderFacetFieldInfos}
      requestBuilderIndexFieldNames={requestBuilderIndexFieldNames}
      requestBuilderSearchableFieldNames={requestBuilderSearchableFieldNames}
      requestBuilderVectorFieldNames={requestBuilderVectorFieldNames}
      requestBuilderSuggesterNames={requestBuilderSuggesterNames}
      requestBuilderKeyFieldName={requestBuilderKeyFieldName}
      setIsFilterBuilderOpen={setIsFilterBuilderOpen}
      analyzeDropdownFilters={analyzeDropdownFilters}
      csvToList={csvToList}
      toggleCsvSelection={toggleCsvSelection}
      copyToClipboard={copyToClipboard}
      isExecuting={isExecuting}
      onExecute={onExecute}
      onExecuteAllModes={onExecuteAllModes}
      onClearAll={onClearAll}
      buildRequestBuilderActiveSummary={buildRequestBuilderActiveSummary}
      activeResultView={activeResultView}
      jsonViewerRequestData={jsonViewerRequestData}
      jsonViewerResponseData={jsonViewerResponseData}
      jsonViewerFacets={jsonViewerFacets}
      resultViews={resultViews}
      renderResultView={renderResultView}
      closeRunTab={closeRunTab}
      qpsTesterRestoreRunId={qpsTesterRestoreRunId}
      setQpsTesterRestoreRunId={setQpsTesterRestoreRunId}
      autoTuningRestoreRunId={autoTuningRestoreRunId}
      jwtDecoder={jwtDecoder}
      indexInspector={{
        isIndexInspectorOpen: indexInspector.isIndexInspectorOpen,
        setIsIndexInspectorOpen: indexInspector.setIsIndexInspectorOpen,
        indexInspectorIndexName: indexInspector.indexInspectorIndexName,
        indexInspectorLoading: indexInspector.indexInspectorLoading,
        indexInspectorError: indexInspector.indexInspectorError,
        indexInspectorDefinition: indexInspector.indexInspectorDefinition,
        indexInspectorEditedJson: indexInspector.indexInspectorEditedJson,
        reloadIndexInspector,
      }}
      isFilterBuilderOpen={isFilterBuilderOpen}
      availableIndexNames={availableIndexNames}
    />
  )
}

export default App
