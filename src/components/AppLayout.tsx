import { useMemo, type Dispatch, type ReactElement, type RefObject, type SetStateAction } from 'react'
import type {
  CenterTab,
  KnowledgeSourceInfo,
  PaneSizes,
  ResultView,
} from '../types'
import type { JsonValue } from '../lib/aiSearchRest'
import type { TranslationKey, Language } from '../lib/translations'
import {
  AppHeader,
  BuilderTabPane,
  FilterBuilderModal,
  IndexBuilder,
  IndexInspectorModal,
  JwtDecoderModal,
  KnowledgeBaseBuilder,
  KnowledgeSourceBuilder,
  LeftPane,
  RightJsonViewerPane,
  SkillPipelineBuilder,
  SkillPipelineRightPane,
  SkillCodeEditor,
  SearchParameterAutoTuning,
  EvalDatasetGenerator,
  SearchPipelineVisualizer,
  SynonymMapBuilder,
  TextToVectorModal,
  VectorOptimizerBuilder,
  FeaturePortal,
  FeatureGuideDrawer,
} from './index'
import { extractQueryString } from '../utils'
import { QueryPerformanceTester } from './viewers/QueryPerformanceTester'
import { useTheme, useSettings, useModalState, useUiState, useBuilderState, useExperiment } from '../contexts'
import { useGuide } from '../contexts/GuideContext'

import type { JwtDecoderResult } from './modals/JwtDecoderModal'

type TFunction = (key: TranslationKey) => string

type FormatFunction = (key: TranslationKey, params: Record<string, string | number>) => string

type JwtDecoder = {
  isJwtDecoderOpen: boolean
  setIsJwtDecoderOpen: Dispatch<SetStateAction<boolean>>
  jwtDecoderResult: JwtDecoderResult
  formatJwtEpochSeconds: (value: unknown) => { raw: string; utcIso: string; local: string } | null
  openJwtDecoder: (token: string) => void
}

export function AppLayout(props: {
  // Language utilities (derived from context)
  t: TFunction
  format: FormatFunction
  changeLanguage: (newLang: Language) => Promise<void>

  textToVector: {
    showTextToVectorTool: boolean
    setShowTextToVectorTool: (v: boolean) => void
    textToVectorEndpoint: string
    setTextToVectorEndpoint: (v: string) => void
    textToVectorApiKey: string
    setTextToVectorApiKey: (v: string) => void
    textToVectorAuthMode: 'apiKey' | 'bearer'
    setTextToVectorAuthMode: (v: 'apiKey' | 'bearer') => void
    textToVectorBearerToken: string
    setTextToVectorBearerToken: (v: string) => void
    textToVectorModel: string
    setTextToVectorModel: (v: string) => void
    textToVectorDimensions: number | null
    setTextToVectorDimensions: (v: number | null) => void
    textToVectorInput: string
    setTextToVectorInput: (v: string) => void
    textToVectorLoading: boolean
    onGenerateVector: () => Promise<void>
    textToVectorResult: number[] | null
    onCopyVector: () => Promise<void>
  }

  onPasteVectorToBuilder: () => void

  centerTab: CenterTab
  setCenterTab: Dispatch<SetStateAction<CenterTab>>

  paneSizes: PaneSizes
  dragging: null | { side: 'left' | 'right' | 'vertical'; x0: number; y0: number; s0: PaneSizes }
  setDragging: Dispatch<SetStateAction<null | { side: 'left' | 'right' | 'vertical'; x0: number; y0: number; s0: PaneSizes }>>
  gridTemplateColumns: string

  onCreateExperiment: () => Promise<void>
  onSelectExperiment: (id: string) => void
  onDeleteExperiment: (id: string) => Promise<void>

  activeRunId: string | null
  onRunQueryFilterTextChange: (v: string) => void
  onDeleteSelectedRuns: (ids: string[]) => Promise<void>
  onDeleteRun: (id: string) => Promise<void>
  onToggleRunSelection: (id: string, checked: boolean) => void
  onRestoreRun: (id: string) => Promise<void>
  onExportRuns: (ids: string[]) => Promise<void>
  onImportRunsFromFile: (file: File) => Promise<void>

  effectiveApiVersion: string
  isPreviewApiVersion: boolean

  indexFilterText: string
  setIndexFilterText: Dispatch<SetStateAction<string>>
  filteredIndexNameOptions: string[]
  openIndexInspector: (name?: string) => void
  onOpenIndexBuilderTab: () => void
  indexDropdownToggleRef: RefObject<HTMLButtonElement | null>
  indexDropdownMenuRef: RefObject<HTMLDivElement | null>
  indexFilterInputRef: RefObject<HTMLInputElement | null>
  hideClosestBootstrapDropdown: (fromEl: HTMLElement | null) => void

  knowledgeBaseNamesLoading: boolean
  knowledgeBaseNamesError: string | null
  knowledgeBaseNameOptions: string[]
  availableKnowledgeSources: KnowledgeSourceInfo[]

  isLoadingRequestBuilderSchema: boolean
  requestBuilderIndexFieldNames: string[]
  requestBuilderVectorFieldNames: string[]
  requestBuilderKeyFieldName: string | null

  analyzeDropdownFilters: {
    analyzerFilterText: string
    setAnalyzerFilterText: Dispatch<SetStateAction<string>>
    analyzerFilterInputRef: RefObject<HTMLInputElement | null>
    analyzerDropdownToggleRef: RefObject<HTMLButtonElement | null>
    analyzerDropdownMenuRef: RefObject<HTMLDivElement | null>

    tokenizerFilterText: string
    setTokenizerFilterText: Dispatch<SetStateAction<string>>
    tokenizerFilterInputRef: RefObject<HTMLInputElement | null>
    tokenizerDropdownToggleRef: RefObject<HTMLButtonElement | null>
    tokenizerDropdownMenuRef: RefObject<HTMLDivElement | null>

    normalizerFilterText: string
    setNormalizerFilterText: Dispatch<SetStateAction<string>>
    normalizerFilterInputRef: RefObject<HTMLInputElement | null>
    normalizerDropdownToggleRef: RefObject<HTMLButtonElement | null>
    normalizerDropdownMenuRef: RefObject<HTMLDivElement | null>

    charFilterText: string
    setCharFilterText: Dispatch<SetStateAction<string>>
    charFilterInputRef: RefObject<HTMLInputElement | null>
    charFilterDropdownToggleRef: RefObject<HTMLButtonElement | null>
    charFilterDropdownMenuRef: RefObject<HTMLDivElement | null>

    tokenFilterText: string
    setTokenFilterText: Dispatch<SetStateAction<string>>
    tokenFilterInputRef: RefObject<HTMLInputElement | null>
    tokenFilterDropdownToggleRef: RefObject<HTMLButtonElement | null>
    tokenFilterDropdownMenuRef: RefObject<HTMLDivElement | null>
  }

  csvToList: (csv: string) => string[]
  toggleCsvSelection: (csv: string, value: string, orderedUniverse: readonly string[]) => string

  copyToClipboard: (text: string) => Promise<void>

  isExecuting: boolean
  onExecute: () => Promise<void>
  onExecuteAllModes: () => Promise<void>
  onClearAll: () => void
  buildRequestBuilderActiveSummary: () => string

  // Results / right pane
  activeResultView: ResultView
  jsonViewerRequestData: JsonValue
  jsonViewerResponseData: JsonValue
  jsonViewerFacets: Record<string, unknown[]> | null

  resultViews: ResultView[]
  renderResultView: (view: ResultView) => ReactElement
  closeRunTab: (runId: string) => void

  // Tool tabs state
  qpsTesterRestoreRunId: string | null
  setQpsTesterRestoreRunId: (id: string | null) => void
  autoTuningRestoreRunId: string | null

  // Modals
  jwtDecoder: JwtDecoder
  indexInspector: {
    isIndexInspectorOpen: boolean
    setIsIndexInspectorOpen: Dispatch<SetStateAction<boolean>>
    indexInspectorIndexName: string
    indexInspectorLoading: boolean
    indexInspectorError: string | null
    indexInspectorDefinition: JsonValue | null
    indexInspectorEditedJson: string
    reloadIndexInspector: () => void
  }

  isFilterBuilderOpen: boolean
  setIsFilterBuilderOpen: Dispatch<SetStateAction<boolean>>

  availableIndexNames: string[]
}) {
  // ============================================================================
  // Context Hooks - Get global state from Context
  // ============================================================================
  const { theme, setTheme, language } = useTheme()
  const { settings, activeProfile, patchActiveProfile, patchSettings } = useSettings()
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
    isSkillPipelineBuilderOpen,
    setIsSkillPipelineBuilderOpen,
    isVectorOptimizerOpen,
    setIsVectorOptimizerOpen,
    isSkillEditorOpen,
    setIsSkillEditorOpen,
    setSkillEditorLinkedNodeId,
    isEvalDatasetGeneratorOpen,
    setIsEvalDatasetGeneratorOpen,
  } = useModalState()
  const {
    uiError,
    setUiError,
    uiLog,
    setUiLog,
    jsonViewerMode,
    setJsonViewerMode,
    isRightPaneCollapsed,
    setIsRightPaneCollapsed,
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
    selectedExperimentId,
    runs,
    selectedRunIds,
    runQueryFilterText,
    reloadRuns,
  } = useExperiment()

  // Compute filteredRuns locally from runs and runQueryFilterText
  const filteredRuns = useMemo(() => {
    const q = runQueryFilterText.trim().toLowerCase()
    if (!q) return runs
    return runs.filter((run) => {
      const preview = extractQueryString(run.params)
      const note = run.note?.trim() ?? ''
      return preview.toLowerCase().includes(q) || note.toLowerCase().includes(q)
    })
  }, [runs, runQueryFilterText])

  // ============================================================================
  // Props Destructuring
  // ============================================================================
  const {
    t,
    format,
    changeLanguage,
    textToVector,
    onPasteVectorToBuilder,
    centerTab,
    setCenterTab,
    paneSizes,
    dragging,
    setDragging,
    gridTemplateColumns,
    onCreateExperiment,
    onSelectExperiment,
    onDeleteExperiment,
    activeRunId,
    onRunQueryFilterTextChange,
    onDeleteSelectedRuns,
    onDeleteRun,
    onToggleRunSelection,
    onRestoreRun,
    onExportRuns,
    onImportRunsFromFile,
    effectiveApiVersion,
    isPreviewApiVersion,
    indexFilterText,
    setIndexFilterText,
    filteredIndexNameOptions,
    openIndexInspector,
    onOpenIndexBuilderTab,
    indexDropdownToggleRef,
    indexDropdownMenuRef,
    indexFilterInputRef,
    hideClosestBootstrapDropdown,
    knowledgeBaseNamesLoading,
    knowledgeBaseNamesError,
    knowledgeBaseNameOptions,
    availableKnowledgeSources,
    isLoadingRequestBuilderSchema,
    requestBuilderVectorFieldNames,
    analyzeDropdownFilters,
    csvToList,
    toggleCsvSelection,
    copyToClipboard,
    isExecuting,
    onExecute,
    onExecuteAllModes,
    onClearAll,
    buildRequestBuilderActiveSummary,
    activeResultView,
    jsonViewerRequestData,
    jsonViewerResponseData,
    jsonViewerFacets,
    resultViews,
    renderResultView,
    closeRunTab,
    qpsTesterRestoreRunId,
    setQpsTesterRestoreRunId,
    autoTuningRestoreRunId,
    jwtDecoder,
    indexInspector,
    isFilterBuilderOpen,
    setIsFilterBuilderOpen,
    availableIndexNames,
  } = props

  const {
    analyzerFilterText,
    setAnalyzerFilterText,
    analyzerFilterInputRef,
    analyzerDropdownToggleRef,
    analyzerDropdownMenuRef,
    tokenizerFilterText,
    setTokenizerFilterText,
    tokenizerFilterInputRef,
    tokenizerDropdownToggleRef,
    tokenizerDropdownMenuRef,
    normalizerFilterText,
    setNormalizerFilterText,
    normalizerFilterInputRef,
    normalizerDropdownToggleRef,
    normalizerDropdownMenuRef,
    charFilterText,
    setCharFilterText,
    charFilterInputRef,
    charFilterDropdownToggleRef,
    charFilterDropdownMenuRef,
    tokenFilterText,
    setTokenFilterText,
    tokenFilterInputRef,
    tokenFilterDropdownToggleRef,
    tokenFilterDropdownMenuRef,
  } = analyzeDropdownFilters

  const {
    isIndexInspectorOpen,
    setIsIndexInspectorOpen,
    indexInspectorIndexName,
    indexInspectorLoading,
    indexInspectorError,
    indexInspectorDefinition,
    indexInspectorEditedJson,
    reloadIndexInspector,
  } = indexInspector

  const { launchCompanion } = useGuide()

  const handlePortalAction = (action: string) => {
    switch (action) {
      case 'openQueryMode':
        setLabMode('query')
        setCenterTab('builder')
        break
      case 'openSemanticVectorMode':
        setLabMode('semantic-vector')
        setCenterTab('builder')
        break
      case 'openAgenticMode':
        setLabMode('agentic')
        setCenterTab('builder')
        break
      case 'openAnalyzeMode':
        setLabMode('analyze')
        setCenterTab('builder')
        break
      case 'openIndexBuilder':
        setIsIndexBuilderOpen(true)
        setCenterTab('index-builder')
        break
      case 'openSynonymMapBuilder':
        setIsSynonymMapBuilderOpen(true)
        setCenterTab('synonym-map-builder')
        break
      case 'openKnowledgeSourceBuilder':
        setIsKnowledgeSourceBuilderOpen(true)
        setCenterTab('knowledge-source-builder')
        break
      case 'openKnowledgeBaseBuilder':
        setIsKnowledgeBaseBuilderOpen(true)
        setCenterTab('knowledge-base-builder')
        break
      case 'openSkillPipelineBuilder':
        setIsSkillPipelineBuilderOpen(true)
        setCenterTab('skill-pipeline-builder')
        break
      case 'openSkillEditor':
        setSkillEditorLinkedNodeId(null)
        setIsSkillEditorOpen(true)
        setCenterTab('skill-editor')
        break
      case 'openFilterBuilder':
        setIsFilterBuilderOpen(true)
        break
      case 'openAutoTuning':
        setIsAutoTuningOpen(true)
        setCenterTab('auto-tuning')
        break
      case 'openEvalDatasetGenerator':
        setIsEvalDatasetGeneratorOpen(true)
        setCenterTab('eval-dataset-generator')
        break
      case 'openVectorOptimizer':
        setIsVectorOptimizerOpen(true)
        setCenterTab('vector-optimizer')
        break
      case 'openQpsTester':
        setIsQpsTesterOpen(true)
        setCenterTab('qps-tester')
        break
      case 'openSearchPipelineVisualizer':
        setIsSearchPipelineVisualizerOpen(true)
        setCenterTab('search-pipeline-visualizer')
        break
      case 'openTextToVector':
        textToVector.setShowTextToVectorTool(true)
        break
      case 'openIndexInspector':
        openIndexInspector()
        break
      case 'openJwtDecoder':
        jwtDecoder.setIsJwtDecoderOpen(true)
        break
      case 'openExperimentManagement':
        setCenterTab('builder')
        break
    }
  }

  return (
    <div className="app">
      <AppHeader
        t={(key) => String(t(key) ?? '')}
        language={language}
        onLanguageChange={changeLanguage}
        theme={theme}
        onThemeChange={setTheme}
        onOpenTextToVector={() => textToVector.setShowTextToVectorTool(true)}
        onOpenVectorOptimizer={() => {
          setIsVectorOptimizerOpen(true)
          setCenterTab('vector-optimizer')
        }}
        onOpenSearchParameterAutoTuning={() => {
          setIsAutoTuningOpen(true)
          setCenterTab('auto-tuning')
        }}
        onOpenEvalDatasetGenerator={() => {
          setIsEvalDatasetGeneratorOpen(true)
          setCenterTab('eval-dataset-generator')
        }}
        onOpenQpsTester={() => {
          setIsQpsTesterOpen(true)
          setCenterTab('qps-tester')
        }}
        onOpenTokenAnalyzer={() => {
          setLabMode('analyze')
          setCenterTab('builder')
        }}
        onOpenIndexBuilder={() => {
          setIsIndexBuilderOpen(true)
          setCenterTab('index-builder')
        }}
        onOpenKnowledgeBaseBuilder={() => {
          setIsKnowledgeBaseBuilderOpen(true)
          setCenterTab('knowledge-base-builder')
        }}
        onOpenKnowledgeSourceBuilder={() => {
          setIsKnowledgeSourceBuilderOpen(true)
          setCenterTab('knowledge-source-builder')
        }}
        onOpenSynonymMapBuilder={() => {
          setIsSynonymMapBuilderOpen(true)
          setCenterTab('synonym-map-builder')
        }}
        onOpenSkillPipelineBuilder={() => {
          setIsSkillPipelineBuilderOpen(true)
          setCenterTab('skill-pipeline-builder')
        }}
        onOpenSkillEditor={() => {
          setSkillEditorLinkedNodeId(null)
          setIsSkillEditorOpen(true)
          setCenterTab('skill-editor')
        }}
        onOpenSearchPipelineVisualizer={() => {
          setIsSearchPipelineVisualizerOpen(true)
          setCenterTab('search-pipeline-visualizer')
        }}
      />

      <div className="app__grid" style={{ gridTemplateColumns }}>
        <LeftPane
          t={(key) => String(t(key) ?? '')}
          paneSizes={paneSizes}
          experiments={experiments}
          selectedExperimentId={selectedExperimentId}
          onCreateExperiment={onCreateExperiment}
          onSelectExperiment={onSelectExperiment}
          onDeleteExperiment={onDeleteExperiment}
          isVerticalDragging={dragging?.side === 'vertical'}
          onStartResizeExperiments={(e) => {
            ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
            setDragging({ side: 'vertical', x0: e.clientX, y0: e.clientY, s0: paneSizes })
          }}
          runsCount={runs.length}
          filteredRuns={filteredRuns}
          activeRunId={activeRunId}
          selectedRunIds={selectedRunIds}
          runQueryFilterText={runQueryFilterText}
          onRunQueryFilterTextChange={onRunQueryFilterTextChange}
          onDeleteSelectedRuns={() => onDeleteSelectedRuns(selectedRunIds)}
          onDeleteRun={onDeleteRun}
          onToggleRunSelection={onToggleRunSelection}
          onRestoreRun={onRestoreRun}
          onExportRuns={onExportRuns}
          onImportRunsFromFile={onImportRunsFromFile}
        />

        <div
          className={'splitter splitter--left' + (dragging?.side === 'left' ? ' splitter--active' : '')}
          role="separator"
          aria-orientation="vertical"
          aria-label="resize left pane"
          onPointerDown={(e) => {
            ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
            setDragging({ side: 'left', x0: e.clientX, y0: e.clientY, s0: paneSizes })
          }}
        />

        <main className="pane pane--center">
          <div className="tabs tabs--center">
            <button
              type="button"
              className={'tab ' + (centerTab === 'portal' ? 'tab--active' : '')}
              onClick={() => setCenterTab('portal')}
              title="Feature Portal"
            >
              <span className="tab__label">
                <i className="bi bi-compass icon--mr6"></i>
                {t('portalTab')}
              </span>
            </button>

            <button
              type="button"
              className={'tab ' + (centerTab === 'builder' ? 'tab--active' : '')}
              onClick={() => setCenterTab('builder')}
            >
              {t('requestBuilder')}
            </button>

            {isAutoTuningOpen && (
              <div className="tabWrapper">
                <button
                  type="button"
                  className={'tab ' + (centerTab === 'auto-tuning' ? 'tab--active' : '')}
                  onClick={() => setCenterTab('auto-tuning')}
                >
                  <span className="tab__label">
                    <i className="bi bi-sliders icon--mr6"></i>
                    {t('searchParameterAutoTuning')}
                  </span>
                </button>
                <button
                  type="button"
                  className="tab__closeBtn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsAutoTuningOpen(false)
                    if (centerTab === 'auto-tuning') {
                      setCenterTab('builder')
                    }
                  }}
                  aria-label="Close tab"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}

            {isEvalDatasetGeneratorOpen && (
              <div className="tabWrapper">
                <button
                  type="button"
                  className={'tab ' + (centerTab === 'eval-dataset-generator' ? 'tab--active' : '')}
                  onClick={() => setCenterTab('eval-dataset-generator')}
                >
                  <span className="tab__label">
                    <i className="bi bi-stars icon--mr6"></i>
                    {t('evalDatasetGenerator')}
                  </span>
                </button>
                <button
                  type="button"
                  className="tab__closeBtn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsEvalDatasetGeneratorOpen(false)
                    if (centerTab === 'eval-dataset-generator') {
                      setCenterTab('builder')
                    }
                  }}
                  aria-label="Close tab"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}

            {isQpsTesterOpen && (
              <div className="tabWrapper">
                <button
                  type="button"
                  className={'tab ' + (centerTab === 'qps-tester' ? 'tab--active' : '')}
                  onClick={() => setCenterTab('qps-tester')}
                >
                  <span className="tab__label">
                    <i className="bi bi-speedometer2 icon--mr6"></i>
                    {t('qpsTestTitle')}
                  </span>
                </button>
                <button
                  type="button"
                  className="tab__closeBtn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsQpsTesterOpen(false)
                    setQpsTesterRestoreRunId(null)
                    if (centerTab === 'qps-tester') {
                      setCenterTab('builder')
                    }
                  }}
                  aria-label="Close tab"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}

            {isSearchPipelineVisualizerOpen && (
              <div className="tabWrapper">
                <button
                  type="button"
                  className={'tab ' + (centerTab === 'search-pipeline-visualizer' ? 'tab--active' : '')}
                  onClick={() => setCenterTab('search-pipeline-visualizer')}
                >
                  <span className="tab__label">🧬 {t('searchPipelineVisualizer')}</span>
                </button>
                <button
                  type="button"
                  className="tab__closeBtn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsSearchPipelineVisualizerOpen(false)
                    if (centerTab === 'search-pipeline-visualizer') {
                      setCenterTab('builder')
                    }
                  }}
                  aria-label="Close tab"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}

            {isVectorOptimizerOpen && (
              <div className="tabWrapper">
                <button
                  type="button"
                  className={'tab ' + (centerTab === 'vector-optimizer' ? 'tab--active' : '')}
                  onClick={() => setCenterTab('vector-optimizer')}
                >
                  <span className="tab__label">
                    <i className="bi bi-arrows-angle-contract icon--mr6"></i>
                    {t('vectorOptimizer')}
                  </span>
                </button>
                <button
                  type="button"
                  className="tab__closeBtn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsVectorOptimizerOpen(false)
                    if (centerTab === 'vector-optimizer') {
                      setCenterTab('builder')
                    }
                  }}
                  aria-label="Close tab"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}

            {isKnowledgeSourceBuilderOpen && (
              <div className="tabWrapper">
                <button
                  type="button"
                  className={'tab ' + (centerTab === 'knowledge-source-builder' ? 'tab--active' : '')}
                  onClick={() => setCenterTab('knowledge-source-builder')}
                >
                  <span className="tab__label">📚 Knowledge Source Builder</span>
                </button>
                <button
                  type="button"
                  className="tab__closeBtn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsKnowledgeSourceBuilderOpen(false)
                    if (centerTab === 'knowledge-source-builder') {
                      setCenterTab('builder')
                    }
                  }}
                  aria-label="Close tab"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}

            {isKnowledgeBaseBuilderOpen && (
              <div className="tabWrapper">
                <button
                  type="button"
                  className={'tab ' + (centerTab === 'knowledge-base-builder' ? 'tab--active' : '')}
                  onClick={() => setCenterTab('knowledge-base-builder')}
                >
                  <span className="tab__label">🧠 Knowledge Base Builder</span>
                </button>
                <button
                  type="button"
                  className="tab__closeBtn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsKnowledgeBaseBuilderOpen(false)
                    if (centerTab === 'knowledge-base-builder') {
                      setCenterTab('builder')
                    }
                  }}
                  aria-label="Close tab"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}

            {isSynonymMapBuilderOpen && (
              <div className="tabWrapper">
                <button
                  type="button"
                  className={'tab ' + (centerTab === 'synonym-map-builder' ? 'tab--active' : '')}
                  onClick={() => setCenterTab('synonym-map-builder')}
                >
                  <span className="tab__label">📖 Synonym Map Builder</span>
                </button>
                <button
                  type="button"
                  className="tab__closeBtn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsSynonymMapBuilderOpen(false)
                    if (centerTab === 'synonym-map-builder') {
                      setCenterTab('builder')
                    }
                  }}
                  aria-label="Close tab"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}

            {isIndexBuilderOpen && (
              <div className="tabWrapper">
                <button
                  type="button"
                  className={'tab ' + (centerTab === 'index-builder' ? 'tab--active' : '')}
                  onClick={() => setCenterTab('index-builder')}
                >
                  <span className="tab__label">🔖 Index Builder</span>
                </button>
                <button
                  type="button"
                  className="tab__closeBtn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsIndexBuilderOpen(false)
                    if (centerTab === 'index-builder') {
                      setCenterTab('builder')
                    }
                  }}
                  aria-label="Close tab"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}

            {isSkillPipelineBuilderOpen && (
              <div className="tabWrapper">
                <button
                  type="button"
                  className={'tab ' + (centerTab === 'skill-pipeline-builder' ? 'tab--active' : '')}
                  onClick={() => setCenterTab('skill-pipeline-builder')}
                >
                  <span className="tab__label">🧩 {t('skillPipelineBuilder')}</span>
                </button>
                <button
                  type="button"
                  className="tab__closeBtn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setIsSkillPipelineBuilderOpen(false)
                    if (centerTab === 'skill-pipeline-builder') {
                      setCenterTab('builder')
                    }
                  }}
                  aria-label="Close tab"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}

            {isSkillEditorOpen && (
              <div className="tabWrapper">
                <button
                  type="button"
                  className={'tab ' + (centerTab === 'skill-editor' ? 'tab--active' : '')}
                  onClick={() => setCenterTab('skill-editor')}
                >
                  <span className="tab__label">🐍 {t('sceMenuLabel')}</span>
                </button>
                <button
                  type="button"
                  className="tab__closeBtn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setSkillEditorLinkedNodeId(null)
                    setIsSkillEditorOpen(false)
                    if (centerTab === 'skill-editor') {
                      setCenterTab('builder')
                    }
                  }}
                  aria-label="Close tab"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            )}

            {resultViews.map((view) => {
              const isRunTab = typeof view.id === 'string' && view.id.startsWith('run:')
              const runTypeClass = view.runType ? `tab--${view.runType}` : ''
              return (
                <div key={view.id} className="tabWrapper">
                  <button
                    type="button"
                    className={'tab ' + (centerTab === view.id ? `tab--active ${runTypeClass}` : '')}
                    onClick={() => setCenterTab(view.id)}
                    title={view.runId}
                  >
                    <span className="tab__label">{view.label}</span>
                  </button>
                  {isRunTab && view.runId && (
                    <button
                      type="button"
                      className="tab__closeBtn"
                      onClick={(e) => {
                        e.stopPropagation()
                        closeRunTab(view.runId!)
                      }}
                      aria-label="Close tab"
                      title="Close tab"
                    >
                      ×
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {centerTab === 'portal' && (
            <div className="pane__centerContent">
              <FeaturePortal
                language={language}
                onAction={handlePortalAction}
                onClose={() => setCenterTab('builder')}
              />
            </div>
          )}

          {centerTab === 'builder' && (
            <div className="pane__centerContent">
              <BuilderTabPane
                t={t}
                language={language}
                activeProfile={activeProfile}
                patchActiveProfile={patchActiveProfile}
                openJwtDecoder={jwtDecoder.openJwtDecoder}
                settings={settings}
                patchSettings={patchSettings}
                labMode={labMode}
                setLabMode={setLabMode}
                builderMode={builderMode}
                setBuilderMode={setBuilderMode}
                effectiveApiVersion={effectiveApiVersion}
                isPreviewApiVersion={isPreviewApiVersion}
                indexName={indexName}
                setIndexName={setIndexName}
                indexFilterText={indexFilterText}
                setIndexFilterText={setIndexFilterText}
                filteredIndexNameOptions={filteredIndexNameOptions}
                openIndexInspector={openIndexInspector}
                onOpenIndexBuilderTab={onOpenIndexBuilderTab}
                indexDropdownToggleRef={indexDropdownToggleRef}
                indexDropdownMenuRef={indexDropdownMenuRef}
                indexFilterInputRef={indexFilterInputRef}
                hideClosestBootstrapDropdown={hideClosestBootstrapDropdown}
                knowledgeBaseName={knowledgeBaseName}
                setKnowledgeBaseName={setKnowledgeBaseName}
                knowledgeBaseNamesLoading={knowledgeBaseNamesLoading}
                knowledgeBaseNamesError={knowledgeBaseNamesError}
                knowledgeBaseNameOptions={knowledgeBaseNameOptions}
                availableKnowledgeSources={availableKnowledgeSources}
                searchForm={searchForm}
                setSearchForm={setSearchForm}
                agenticForm={agenticForm}
                setAgenticForm={setAgenticForm}
                analyzeForm={analyzeForm}
                setAnalyzeForm={setAnalyzeForm}
                isLoadingRequestBuilderSchema={isLoadingRequestBuilderSchema}
                requestBuilderVectorFieldNames={requestBuilderVectorFieldNames}
                setIsFilterBuilderOpen={setIsFilterBuilderOpen}
                analyzerFilterText={analyzerFilterText}
                setAnalyzerFilterText={setAnalyzerFilterText}
                analyzerFilterInputRef={analyzerFilterInputRef}
                analyzerDropdownToggleRef={analyzerDropdownToggleRef}
                analyzerDropdownMenuRef={analyzerDropdownMenuRef}
                tokenizerFilterText={tokenizerFilterText}
                setTokenizerFilterText={setTokenizerFilterText}
                tokenizerFilterInputRef={tokenizerFilterInputRef}
                tokenizerDropdownToggleRef={tokenizerDropdownToggleRef}
                tokenizerDropdownMenuRef={tokenizerDropdownMenuRef}
                normalizerFilterText={normalizerFilterText}
                setNormalizerFilterText={setNormalizerFilterText}
                normalizerFilterInputRef={normalizerFilterInputRef}
                normalizerDropdownToggleRef={normalizerDropdownToggleRef}
                normalizerDropdownMenuRef={normalizerDropdownMenuRef}
                charFilterText={charFilterText}
                setCharFilterText={setCharFilterText}
                charFilterInputRef={charFilterInputRef}
                charFilterDropdownToggleRef={charFilterDropdownToggleRef}
                charFilterDropdownMenuRef={charFilterDropdownMenuRef}
                tokenFilterText={tokenFilterText}
                setTokenFilterText={setTokenFilterText}
                tokenFilterInputRef={tokenFilterInputRef}
                tokenFilterDropdownToggleRef={tokenFilterDropdownToggleRef}
                tokenFilterDropdownMenuRef={tokenFilterDropdownMenuRef}
                csvToList={csvToList}
                toggleCsvSelection={toggleCsvSelection}
                requestJson={requestJson}
                setRequestJson={setRequestJson}
                runNote={runNote}
                setRunNote={setRunNote}
                uiError={uiError}
                uiLog={uiLog}
                setUiError={setUiError}
                setUiLog={setUiLog}
                copyToClipboard={copyToClipboard}
                isExecuting={isExecuting}
                onExecute={onExecute}
                onExecuteAllModes={onExecuteAllModes}
                onClearAll={onClearAll}
                buildRequestBuilderActiveSummary={buildRequestBuilderActiveSummary}
              />
            </div>
          )}

          {isVectorOptimizerOpen && (
            <div className="tabPane" hidden={centerTab !== 'vector-optimizer'}>
              <div className="pane__centerContent">
                <VectorOptimizerBuilder
                  t={t}
                  format={format}
                  defaultTextToVectorEndpoint={textToVector.textToVectorEndpoint}
                  defaultTextToVectorApiKey={textToVector.textToVectorApiKey}
                  defaultTextToVectorAuthMode={textToVector.textToVectorAuthMode}
                  defaultTextToVectorBearerToken={textToVector.textToVectorBearerToken}
                />
              </div>
            </div>
          )}

          {isAutoTuningOpen && (
            <div className="tabPane" hidden={centerTab !== 'auto-tuning'}>
              <SearchParameterAutoTuning
                t={t}
                language={language}
                activeProfile={activeProfile}
                indexName={indexName}
                availableIndexNames={availableIndexNames}
                setIndexName={setIndexName}
                apiVersion={effectiveApiVersion}
                isPreviewApiVersion={isPreviewApiVersion}
                indexFieldNames={props.requestBuilderIndexFieldNames}
                vectorFieldNames={requestBuilderVectorFieldNames}
                defaultIdFieldName={props.requestBuilderKeyFieldName}
                searchForm={searchForm}
                setSearchForm={setSearchForm}
                runNote={runNote}
                selectedExperimentId={selectedExperimentId}
                reloadRuns={reloadRuns}
                restoreRunId={autoTuningRestoreRunId}
                onOpenEvalDatasetGenerator={() => {
                  setIsEvalDatasetGeneratorOpen(true)
                  setCenterTab('eval-dataset-generator')
                }}
              />
            </div>
          )}

          {isEvalDatasetGeneratorOpen && (
            <div className="tabPane" hidden={centerTab !== 'eval-dataset-generator'}>
              <EvalDatasetGenerator
                t={t}
                language={language}
                activeProfile={activeProfile}
                apiVersion={effectiveApiVersion}
                indexName={indexName}
                availableIndexNames={availableIndexNames}
                setIndexName={setIndexName}
                indexFieldNames={props.requestBuilderIndexFieldNames}
                defaultIdFieldName={props.requestBuilderKeyFieldName}
                defaultLlmEndpoint={textToVector.textToVectorEndpoint}
                defaultLlmApiKey={textToVector.textToVectorApiKey}
                defaultLlmAuthMode={textToVector.textToVectorAuthMode}
                defaultLlmBearerToken={textToVector.textToVectorBearerToken}
                openIndexInspector={openIndexInspector}
              />
            </div>
          )}

          {isKnowledgeSourceBuilderOpen && (
            <div className="tabPane" hidden={centerTab !== 'knowledge-source-builder'}>
              <KnowledgeSourceBuilder profile={activeProfile} onClose={() => setCenterTab('builder')} language={language} />
            </div>
          )}

          {isKnowledgeBaseBuilderOpen && (
            <div className="tabPane" hidden={centerTab !== 'knowledge-base-builder'}>
              <KnowledgeBaseBuilder profile={activeProfile} onClose={() => setCenterTab('builder')} language={language} />
            </div>
          )}

          {isSynonymMapBuilderOpen && (
            <div className="tabPane" hidden={centerTab !== 'synonym-map-builder'}>
              <SynonymMapBuilder
                profile={activeProfile}
                onClose={() => setCenterTab('builder')}
                language={language}
                theme={theme === 'light' || theme === 'solarized' ? 'light' : 'dark'}
              />
            </div>
          )}

          {isIndexBuilderOpen && (
            <div className="tabPane" hidden={centerTab !== 'index-builder'}>
              <IndexBuilder
                profile={activeProfile}
                apiVersion={effectiveApiVersion}
                activeIndexName={indexName}
                language={language}
                theme={theme}
                onClose={() => setCenterTab('builder')}
                copyToClipboard={copyToClipboard}
              />
            </div>
          )}

          {isSkillPipelineBuilderOpen && (
            <div className="tabPane" hidden={centerTab !== 'skill-pipeline-builder'}>
              <SkillPipelineBuilder
                t={t}
                language={language}
                theme={theme}
                copyToClipboard={copyToClipboard}
                profile={activeProfile}
                apiVersion={effectiveApiVersion}
                onOpenSkillEditor={(nodeId) => {
                  setSkillEditorLinkedNodeId(nodeId)
                  setIsSkillEditorOpen(true)
                  setCenterTab('skill-editor')
                }}
              />
            </div>
          )}

          {isSkillEditorOpen && (
            <div className="tabPane" hidden={centerTab !== 'skill-editor'}>
              <SkillCodeEditor
                language={language}
                theme={theme}
                onReturnToSkillPipelineBuilder={() => {
                  setIsSkillPipelineBuilderOpen(true)
                  setCenterTab('skill-pipeline-builder')
                }}
              />
            </div>
          )}

          {isSearchPipelineVisualizerOpen && (
            <div className="tabPane" hidden={centerTab !== 'search-pipeline-visualizer'}>
              <SearchPipelineVisualizer
                profile={activeProfile}
                apiVersion={effectiveApiVersion}
                indexName={indexName}
                language={language}
                settings={settings}
              />
            </div>
          )}

          {isQpsTesterOpen && (
            <div className="tabPane" hidden={centerTab !== 'qps-tester'}>
              <div className="pane__centerContent">
                <QueryPerformanceTester
                  t={t}
                  language={language}
                  activeProfile={activeProfile}
                  indexName={indexName}
                  searchForm={searchForm}
                  runNote={runNote}
                  selectedExperimentId={selectedExperimentId}
                  reloadRuns={reloadRuns}
                  restoreRunId={qpsTesterRestoreRunId}
                />
              </div>
            </div>
          )}

          {centerTab !== 'portal' &&
            centerTab !== 'builder' &&
            centerTab !== 'qps-tester' &&
            centerTab !== 'auto-tuning' &&
            centerTab !== 'vector-optimizer' &&
            centerTab !== 'knowledge-source-builder' &&
            centerTab !== 'knowledge-base-builder' &&
            centerTab !== 'synonym-map-builder' &&
            centerTab !== 'index-builder' &&
            centerTab !== 'skill-pipeline-builder' &&
            centerTab !== 'skill-editor' &&
            centerTab !== 'search-pipeline-visualizer' &&
            centerTab !== 'eval-dataset-generator' && (
              <div className="pane__centerContent">
                <div className="resultGrid" style={{ gridTemplateColumns: `repeat(${resultViews.length}, minmax(0, 1fr))` }}>
                  {resultViews.map((view) => (
                    <div
                      key={view.id}
                      className={'resultCard' + (centerTab === view.id ? ' resultCard--active' : '')}
                      onClick={() => setCenterTab(view.id)}
                    >
                      {renderResultView(view)}
                    </div>
                  ))}
                </div>
              </div>
            )}
        </main>

        <div
          className={'splitter splitter--right' + (dragging?.side === 'right' ? ' splitter--active' : '')}
          role="separator"
          aria-orientation="vertical"
          aria-label="resize right pane"
          onPointerDown={(e) => {
            if (isRightPaneCollapsed) return
            ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
            setDragging({ side: 'right', x0: e.clientX, y0: e.clientY, s0: paneSizes })
          }}
        >
          {isRightPaneCollapsed && (
            <button
              type="button"
              className="btn btn--icon splitter__toggle"
              aria-label="Show JSON viewer"
              title="Show JSON viewer"
              onClick={(e) => {
                e.stopPropagation()
                setIsRightPaneCollapsed(false)
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M15 5v14l-7-7z" fill="currentColor" />
              </svg>
            </button>
          )}
        </div>

        {!isRightPaneCollapsed && (
          centerTab === 'skill-pipeline-builder' ? (
            <SkillPipelineRightPane
              t={t}
              language={language}
              theme={theme}
              copyToClipboard={copyToClipboard}
              profile={activeProfile}
              apiVersion={effectiveApiVersion}
              onCollapse={() => setIsRightPaneCollapsed(true)}
            />
          ) : (
            <RightJsonViewerPane
              activeResultView={activeResultView}
              jsonViewerMode={jsonViewerMode}
              setJsonViewerMode={setJsonViewerMode}
              jsonViewerRequestData={jsonViewerRequestData}
              jsonViewerResponseData={jsonViewerResponseData}
              jsonViewerFacets={jsonViewerFacets}
              onCollapse={() => setIsRightPaneCollapsed(true)}
              t={t}
            />
          )
        )}
      </div>

      <TextToVectorModal
        open={textToVector.showTextToVectorTool}
        onClose={() => textToVector.setShowTextToVectorTool(false)}
        t={t}
        format={format}
        textToVectorEndpoint={textToVector.textToVectorEndpoint}
        setTextToVectorEndpoint={textToVector.setTextToVectorEndpoint}
        textToVectorApiKey={textToVector.textToVectorApiKey}
        setTextToVectorApiKey={textToVector.setTextToVectorApiKey}
        textToVectorAuthMode={textToVector.textToVectorAuthMode}
        setTextToVectorAuthMode={textToVector.setTextToVectorAuthMode}
        textToVectorBearerToken={textToVector.textToVectorBearerToken}
        setTextToVectorBearerToken={textToVector.setTextToVectorBearerToken}
        textToVectorModel={textToVector.textToVectorModel}
        setTextToVectorModel={textToVector.setTextToVectorModel}
        textToVectorDimensions={textToVector.textToVectorDimensions}
        setTextToVectorDimensions={textToVector.setTextToVectorDimensions}
        textToVectorInput={textToVector.textToVectorInput}
        setTextToVectorInput={textToVector.setTextToVectorInput}
        textToVectorLoading={textToVector.textToVectorLoading}
        onGenerateVector={textToVector.onGenerateVector}
        textToVectorResult={textToVector.textToVectorResult}
        onCopyVector={textToVector.onCopyVector}
        onPasteVectorToBuilder={onPasteVectorToBuilder}
      />

      <JwtDecoderModal
        open={jwtDecoder.isJwtDecoderOpen}
        onClose={() => jwtDecoder.setIsJwtDecoderOpen(false)}
        jwtDecoderResult={jwtDecoder.jwtDecoderResult}
        formatJwtEpochSeconds={jwtDecoder.formatJwtEpochSeconds}
        t={t}
      />

      <IndexInspectorModal
        open={isIndexInspectorOpen}
        onClose={() => setIsIndexInspectorOpen(false)}
        t={t}
        indexInspectorIndexName={indexInspectorIndexName}
        effectiveApiVersion={effectiveApiVersion}
        indexInspectorLoading={indexInspectorLoading}
        indexInspectorError={indexInspectorError}
        indexInspectorDefinition={indexInspectorDefinition}
        indexInspectorEditedJson={indexInspectorEditedJson}
        onReload={reloadIndexInspector}
        theme={theme}
      />

      <FilterBuilderModal
        open={isFilterBuilderOpen}
        onClose={() => setIsFilterBuilderOpen(false)}
        profile={activeProfile}
        apiVersion={effectiveApiVersion}
        indexName={indexName}
        value={searchForm.filter}
        onChange={(next) => setSearchForm((p) => ({ ...p, filter: next }))}
        language={language}
      />

      <FeatureGuideDrawer
        language={language}
        onLaunch={(card) => {
          if (card.action) handlePortalAction(card.action)
          launchCompanion()
        }}
      />
    </div>
  )
}
