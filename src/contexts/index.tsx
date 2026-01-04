/**
 * Application-wide React Context providers.
 *
 * Manages global state for theme, settings, and modals to reduce prop drilling.
 */

/* eslint-disable react-refresh/only-export-components */

import { createContext, useContext, useState, useMemo, useCallback, type ReactNode, type Dispatch, type SetStateAction } from 'react'
import type { AppSettings, ConnectionProfile, Run } from '../lib/model'
import type { ThemePreference, LabMode, BuilderMode, SearchFormState, AgenticFormState, AnalyzeFormState, LatestResponse, UiLogEntry } from '../types'
import type { Language } from '../lib/translations'
import { getInitialThemePreference, getBrowserLanguage } from '../utils'
import { DEFAULT_SEARCH_FORM } from '../app/defaults'
import { translations } from '../lib/translations'

// ============================================================================
// Theme Context
// ============================================================================

type ThemeContextValue = {
  theme: ThemePreference
  setTheme: Dispatch<SetStateAction<ThemePreference>>
  language: Language
  setLanguage: Dispatch<SetStateAction<Language>>
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider(props: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemePreference>(() => getInitialThemePreference())
  const [language, setLanguage] = useState<Language>(() => getBrowserLanguage())

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, language, setLanguage }),
    [theme, language]
  )

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return context
}

// ============================================================================
// Settings Context
// ============================================================================

type SettingsContextValue = {
  settings: AppSettings | null
  setSettings: Dispatch<SetStateAction<AppSettings | null>>
  activeProfile: ConnectionProfile | null
  patchActiveProfile: (patch: Partial<ConnectionProfile>) => Promise<void>
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider(props: { children: ReactNode }) {
  const [settings, setSettings] = useState<AppSettings | null>(null)

  const activeProfile = useMemo<ConnectionProfile | null>(() => {
    if (!settings) return null
    return settings.profiles[settings.activeProfileId] ?? null
  }, [settings])

  const patchActiveProfile = useCallback(
    async (patch: Partial<ConnectionProfile>) => {
      if (!settings || !activeProfile) return

      const updated: ConnectionProfile = { ...activeProfile, ...patch }
      const updatedProfiles = { ...settings.profiles, [settings.activeProfileId]: updated }

      const updatedSettings: AppSettings = {
        ...settings,
        profiles: updatedProfiles,
      }

      setSettings(updatedSettings)

      // Persist to IndexedDB
      const { updateSettings } = await import('../lib/db')
      await updateSettings(updatedSettings)
    },
    [settings, activeProfile]
  )

  const patchSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      if (!settings) return

      const updatedSettings: AppSettings = { ...settings, ...patch }
      setSettings(updatedSettings)

      // Persist to IndexedDB
      const { updateSettings } = await import('../lib/db')
      await updateSettings(updatedSettings)
    },
    [settings]
  )

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, setSettings, activeProfile, patchActiveProfile, patchSettings }),
    [settings, activeProfile, patchActiveProfile, patchSettings]
  )

  return <SettingsContext.Provider value={value}>{props.children}</SettingsContext.Provider>
}

export function useSettings() {
  const context = useContext(SettingsContext)
  if (!context) {
    throw new Error('useSettings must be used within SettingsProvider')
  }
  return context
}

// ============================================================================
// Modal State Context
// ============================================================================

type ModalStateContextValue = {
  isQpsTesterOpen: boolean
  setIsQpsTesterOpen: Dispatch<SetStateAction<boolean>>
  isAutoTuningOpen: boolean
  setIsAutoTuningOpen: Dispatch<SetStateAction<boolean>>
  isSearchPipelineVisualizerOpen: boolean
  setIsSearchPipelineVisualizerOpen: Dispatch<SetStateAction<boolean>>
  isKnowledgeSourceBuilderOpen: boolean
  setIsKnowledgeSourceBuilderOpen: Dispatch<SetStateAction<boolean>>
  isKnowledgeBaseBuilderOpen: boolean
  setIsKnowledgeBaseBuilderOpen: Dispatch<SetStateAction<boolean>>
  isSynonymMapBuilderOpen: boolean
  setIsSynonymMapBuilderOpen: Dispatch<SetStateAction<boolean>>
  isIndexBuilderOpen: boolean
  setIsIndexBuilderOpen: Dispatch<SetStateAction<boolean>>
  isVectorOptimizerOpen: boolean
  setIsVectorOptimizerOpen: Dispatch<SetStateAction<boolean>>
  isFilterBuilderOpen: boolean
  setIsFilterBuilderOpen: Dispatch<SetStateAction<boolean>>
}

const ModalStateContext = createContext<ModalStateContextValue | null>(null)

export function ModalStateProvider(props: { children: ReactNode }) {
  const [isQpsTesterOpen, setIsQpsTesterOpen] = useState(false)
  const [isAutoTuningOpen, setIsAutoTuningOpen] = useState(false)
  const [isSearchPipelineVisualizerOpen, setIsSearchPipelineVisualizerOpen] = useState(false)
  const [isKnowledgeSourceBuilderOpen, setIsKnowledgeSourceBuilderOpen] = useState(false)
  const [isKnowledgeBaseBuilderOpen, setIsKnowledgeBaseBuilderOpen] = useState(false)
  const [isSynonymMapBuilderOpen, setIsSynonymMapBuilderOpen] = useState(false)
  const [isIndexBuilderOpen, setIsIndexBuilderOpen] = useState(false)
  const [isVectorOptimizerOpen, setIsVectorOptimizerOpen] = useState(false)
  const [isFilterBuilderOpen, setIsFilterBuilderOpen] = useState(false)

  const value = useMemo<ModalStateContextValue>(
    () => ({
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
      isVectorOptimizerOpen,
      setIsVectorOptimizerOpen,
      isFilterBuilderOpen,
      setIsFilterBuilderOpen,
    }),
    [
      isQpsTesterOpen,
      isAutoTuningOpen,
      isSearchPipelineVisualizerOpen,
      isKnowledgeSourceBuilderOpen,
      isKnowledgeBaseBuilderOpen,
      isSynonymMapBuilderOpen,
      isIndexBuilderOpen,
      isVectorOptimizerOpen,
      isFilterBuilderOpen,
    ]
  )

  return <ModalStateContext.Provider value={value}>{props.children}</ModalStateContext.Provider>
}

export function useModalState() {
  const context = useContext(ModalStateContext)
  if (!context) {
    throw new Error('useModalState must be used within ModalStateProvider')
  }
  return context
}

// ============================================================================
// Builder State Context
// ============================================================================

type BuilderStateContextValue = {
  labMode: LabMode
  setLabMode: Dispatch<SetStateAction<LabMode>>
  builderMode: BuilderMode
  setBuilderMode: Dispatch<SetStateAction<BuilderMode>>
  searchForm: SearchFormState
  setSearchForm: Dispatch<SetStateAction<SearchFormState>>
  agenticForm: AgenticFormState
  setAgenticForm: Dispatch<SetStateAction<AgenticFormState>>
  analyzeForm: AnalyzeFormState
  setAnalyzeForm: Dispatch<SetStateAction<AnalyzeFormState>>
  requestJson: string
  setRequestJson: Dispatch<SetStateAction<string>>
  indexName: string
  setIndexName: Dispatch<SetStateAction<string>>
  knowledgeBaseName: string
  setKnowledgeBaseName: Dispatch<SetStateAction<string>>
}

const BuilderStateContext = createContext<BuilderStateContextValue | null>(null)

export function BuilderStateProvider(props: { children: ReactNode; language: Language }) {
  const [labMode, setLabMode] = useState<LabMode>('query')
  const [builderMode, setBuilderMode] = useState<BuilderMode>('form')
  const [searchForm, setSearchForm] = useState<SearchFormState>(() => ({ ...DEFAULT_SEARCH_FORM }))
  const [agenticForm, setAgenticForm] = useState<AgenticFormState>({
    userMessage: translations[props.language]['sampleQuery'],
    includeActivity: true,
    outputMode: 'answerSynthesis',
    maxRuntimeInSeconds: 60,
    maxOutputSize: 100000,
    retrievalReasoningEffort: 'low',
    knowledgeSourceParams: [],
  })
  const [analyzeForm, setAnalyzeForm] = useState<AnalyzeFormState>({
    text: '',
    analyzerName: '',
    tokenizerName: '',
    normalizerName: '',
    charFilters: '',
    tokenFilters: '',
  })
  const [requestJson, setRequestJson] = useState('')
  const [indexName, setIndexName] = useState('')
  const [knowledgeBaseName, setKnowledgeBaseName] = useState('')

  const value = useMemo<BuilderStateContextValue>(
    () => ({
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
    }),
    [labMode, builderMode, searchForm, agenticForm, analyzeForm, requestJson, indexName, knowledgeBaseName]
  )

  return <BuilderStateContext.Provider value={value}>{props.children}</BuilderStateContext.Provider>
}

export function useBuilderState() {
  const context = useContext(BuilderStateContext)
  if (!context) {
    throw new Error('useBuilderState must be used within BuilderStateProvider')
  }
  return context
}

// ============================================================================
// UI State Context
// ============================================================================

type UiStateContextValue = {
  uiError: string | null
  setUiError: Dispatch<SetStateAction<string | null>>
  uiLog: UiLogEntry | null
  setUiLog: Dispatch<SetStateAction<UiLogEntry | null>>
  latestResponse: LatestResponse | null
  setLatestResponse: Dispatch<SetStateAction<LatestResponse | null>>
  resultPages: Record<string, number>
  setResultPages: Dispatch<SetStateAction<Record<string, number>>>
  runResultMap: Record<string, { run: Run; response: LatestResponse | null }>
  setRunResultMap: Dispatch<SetStateAction<Record<string, { run: Run; response: LatestResponse | null }>>>
  jsonViewerMode: 'request' | 'response' | 'facets'
  setJsonViewerMode: Dispatch<SetStateAction<'request' | 'response' | 'facets'>>
  isRightPaneCollapsed: boolean
  setIsRightPaneCollapsed: Dispatch<SetStateAction<boolean>>
}

const UiStateContext = createContext<UiStateContextValue | null>(null)

export function UiStateProvider(props: { children: ReactNode }) {
  const [uiError, setUiError] = useState<string | null>(null)
  const [uiLog, setUiLog] = useState<UiLogEntry | null>(null)
  const [latestResponse, setLatestResponse] = useState<LatestResponse | null>(null)
  const [resultPages, setResultPages] = useState<Record<string, number>>({ latest: 1 })
  const [runResultMap, setRunResultMap] = useState<Record<string, { run: Run; response: LatestResponse | null }>>({})
  const [jsonViewerMode, setJsonViewerMode] = useState<'request' | 'response' | 'facets'>('response')
  const [isRightPaneCollapsed, setIsRightPaneCollapsed] = useState(false)

  const value = useMemo<UiStateContextValue>(
    () => ({
      uiError,
      setUiError,
      uiLog,
      setUiLog,
      latestResponse,
      setLatestResponse,
      resultPages,
      setResultPages,
      runResultMap,
      setRunResultMap,
      jsonViewerMode,
      setJsonViewerMode,
      isRightPaneCollapsed,
      setIsRightPaneCollapsed,
    }),
    [uiError, uiLog, latestResponse, resultPages, runResultMap, jsonViewerMode, isRightPaneCollapsed]
  )

  return <UiStateContext.Provider value={value}>{props.children}</UiStateContext.Provider>
}

export function useUiState() {
  const context = useContext(UiStateContext)
  if (!context) {
    throw new Error('useUiState must be used within UiStateProvider')
  }
  return context
}

// ============================================================================
// Experiment Context
// ============================================================================

type ExperimentContextValue = {
  experiments: import('../lib/model').Experiment[]
  setExperiments: Dispatch<SetStateAction<import('../lib/model').Experiment[]>>
  selectedExperimentId: string | null
  setSelectedExperimentId: Dispatch<SetStateAction<string | null>>
  runs: Run[]
  setRuns: Dispatch<SetStateAction<Run[]>>
  selectedRunIds: string[]
  setSelectedRunIds: Dispatch<SetStateAction<string[]>>
  selectedRun: Run | null
  setSelectedRun: Dispatch<SetStateAction<Run | null>>
  runQueryFilterText: string
  setRunQueryFilterText: Dispatch<SetStateAction<string>>
  reloadExperiments: (nextSelectedId?: string) => Promise<void>
  reloadRuns: (experimentId: string | null) => Promise<void>
}

const ExperimentContext = createContext<ExperimentContextValue | null>(null)

export function ExperimentProvider(props: { children: ReactNode }) {
  const [experiments, setExperiments] = useState<import('../lib/model').Experiment[]>([])
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null)
  const [runs, setRuns] = useState<Run[]>([])
  const [selectedRunIds, setSelectedRunIds] = useState<string[]>([])
  const [selectedRun, setSelectedRun] = useState<Run | null>(null)
  const [runQueryFilterText, setRunQueryFilterText] = useState('')

  const reloadExperiments = useCallback(
    async (nextSelectedId?: string) => {
      const { listExperiments } = await import('../lib/db')
      const list = await listExperiments()
      setExperiments(list)
      const selected =
        nextSelectedId ??
        selectedExperimentId ??
        (list.length > 0 ? list[0].experimentId : null)
      setSelectedExperimentId(selected)
    },
    [selectedExperimentId]
  )

  const reloadRuns = useCallback(async (experimentId: string | null) => {
    if (!experimentId) {
      setRuns([])
      return
    }
    const { listRunsByExperiment } = await import('../lib/db')
    const list = await listRunsByExperiment(experimentId, { limit: 200 })
    setRuns(list)
  }, [])

  const value = useMemo<ExperimentContextValue>(
    () => ({
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
      runQueryFilterText,
      setRunQueryFilterText,
      reloadExperiments,
      reloadRuns,
    }),
    [
      experiments,
      selectedExperimentId,
      runs,
      selectedRunIds,
      selectedRun,
      runQueryFilterText,
      reloadExperiments,
      reloadRuns,
    ]
  )

  return <ExperimentContext.Provider value={value}>{props.children}</ExperimentContext.Provider>
}

export function useExperiment() {
  const context = useContext(ExperimentContext)
  if (!context) {
    throw new Error('useExperiment must be used within ExperimentProvider')
  }
  return context
}

// ============================================================================
// AppProvider - Combines all providers
// ============================================================================

export function AppProvider(props: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <SettingsProvider>
        <ModalStateProvider>
          <UiStateProvider>
            <ExperimentProvider>
              <BuilderStateProviderWrapper>
                {props.children}
              </BuilderStateProviderWrapper>
            </ExperimentProvider>
          </UiStateProvider>
        </ModalStateProvider>
      </SettingsProvider>
    </ThemeProvider>
  )
}

// Wrapper to access language from ThemeContext
function BuilderStateProviderWrapper(props: { children: ReactNode }) {
  const { language } = useTheme()
  return <BuilderStateProvider language={language}>{props.children}</BuilderStateProvider>
}
