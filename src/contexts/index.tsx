/**
 * Application-wide React Context providers.
 *
 * Manages global state for theme, settings, and modals to reduce prop drilling.
 */

/* eslint-disable react-refresh/only-export-components */

import { createContext, useContext, useState, useMemo, useCallback, type ReactNode, type Dispatch, type SetStateAction } from 'react'
import type { Node, Edge } from '@xyflow/react'
import type { AppSettings, ConnectionProfile, Run } from '../lib/model'
import type { JsonValue } from '../lib/aiSearchRest'
import type { ThemePreference, LabMode, BuilderMode, SearchFormState, AgenticFormState, AnalyzeFormState, LatestResponse, UiLogEntry } from '../types'
import type { Language } from '../lib/translations'
import { getInitialThemePreference, getBrowserLanguage } from '../utils'
import { DEFAULT_SEARCH_FORM } from '../app/defaults'
import { translations } from '../lib/translations'
import { deleteSkillPipeline, getSkillPipeline, listSkillPipelines, upsertSkillPipeline, type PersistedSkillPipelineItem } from '../app/persistedSkillPipeline'
import { v4 as uuidv4 } from 'uuid'

// ============================================================================
// Skill Pipeline Builder State Context
// ============================================================================

type SkillPipelineSkillInput = { name: string; source: string }
type SkillPipelineSkillOutput = { name: string; targetName?: string }

export type SkillPipelineFieldMapping = {
  sourceFieldName: string
  targetFieldName: string
  mappingFunction?: unknown | null
}

export type SkillPipelineOutputFieldMapping = {
  sourceFieldName: string
  targetFieldName: string
  mappingFunction?: unknown | null
}

export type SkillPipelineIndexerDefinition = {
  name?: string
  dataSourceName?: string
  targetIndexName?: string
  skillsetName?: string
  fieldMappings?: SkillPipelineFieldMapping[]
  outputFieldMappings?: SkillPipelineOutputFieldMapping[]
  parameters?: unknown
  [key: string]: unknown
}

export type SkillPipelineSkillDefinition = {
  '@odata.type': string
  name?: string
  description?: string
  context: string
  inputs: SkillPipelineSkillInput[]
  outputs: SkillPipelineSkillOutput[]
  [key: string]: unknown
}

export const SKILL_PIPELINE_DOC_NODE_ID = 'doc'
const SKILL_PIPELINE_LEGACY_DOC_NODE_ID = 'doc-content'

export type SkillPipelineNodeData =
  | {
      kind: 'skill'
      skill: SkillPipelineSkillDefinition
    }
  | {
      kind: 'doc'
      path: string
    }
  | {
      kind: 'projection'
      targetIndexName: string
      sourceContext: string
      parentKeyFieldName?: string
    }
  | {
      kind: 'index'
      targetIndexName: string
      connectedFieldNames?: string[]
    }
  | {
      kind: 'indexer'
      indexerName: string
      targetIndexName: string
      outputFieldMappingCount: number
      fieldMappingCount: number
    }

export type SkillPipelineNode = Node<SkillPipelineNodeData>
export type SkillPipelineEdge = Edge

function computeSkillsetJsonSnapshot(input: {
  skillsetName: string
  skillsetDescription: string
  indexProjections: unknown | null
  knowledgeStore: unknown | null
  nodes: SkillPipelineNode[]
}): string {
  const name = input.skillsetName.trim() || 'skillset1'
  const description = input.skillsetDescription.trim()
  const skillNodes = input.nodes.filter((n) => (n as any)?.data?.kind === 'skill')

  const base: Record<string, unknown> = {
    name,
    skills: skillNodes.map((n) => ((n as any)?.data?.skill ?? {}) as unknown),
  }
  if (description) base.description = description
  if (input.indexProjections) base.indexProjections = input.indexProjections
  if (input.knowledgeStore) base.knowledgeStore = input.knowledgeStore
  return JSON.stringify(base, null, 2)
}

type SkillPipelineStateContextValue = {
  skillsetName: string
  setSkillsetName: Dispatch<SetStateAction<string>>
  skillsetDescription: string
  setSkillsetDescription: Dispatch<SetStateAction<string>>

  indexProjections: unknown | null
  setIndexProjections: Dispatch<SetStateAction<unknown | null>>
  knowledgeStore: unknown | null
  setKnowledgeStore: Dispatch<SetStateAction<unknown | null>>

  indexer: SkillPipelineIndexerDefinition | null
  setIndexer: Dispatch<SetStateAction<SkillPipelineIndexerDefinition | null>>

  currentSavedId: string | null
  baselineSkillsetJson: string
  setBaselineSkillsetJson: Dispatch<SetStateAction<string>>
  saveSkillsetError: string | null
  setSaveSkillsetError: Dispatch<SetStateAction<string | null>>
  savedSkillsets: PersistedSkillPipelineItem[]
  refreshSavedSkillsets: () => void
  newSkillset: () => void
  saveSkillset: (mode: 'save' | 'saveAs', nameOverride?: string) => void
  loadSkillset: (id: string) => void
  deleteSkillset: (id: string) => void

  nodes: SkillPipelineNode[]
  setNodes: Dispatch<SetStateAction<SkillPipelineNode[]>>
  edges: SkillPipelineEdge[]
  setEdges: Dispatch<SetStateAction<SkillPipelineEdge[]>>

  selectedNodeId: string
  setSelectedNodeId: Dispatch<SetStateAction<string>>

  draftSkillJson: string
  setDraftSkillJson: Dispatch<SetStateAction<string>>
  draftError: string | null
  setDraftError: Dispatch<SetStateAction<string | null>>

  draftIndexerJson: string
  setDraftIndexerJson: Dispatch<SetStateAction<string>>
  draftIndexerError: string | null
  setDraftIndexerError: Dispatch<SetStateAction<string | null>>

  draftIndexJson: string
  setDraftIndexJson: Dispatch<SetStateAction<string>>
  draftIndexError: string | null
  setDraftIndexError: Dispatch<SetStateAction<string | null>>

  debugFetchedDocs: JsonValue | null
  setDebugFetchedDocs: Dispatch<SetStateAction<JsonValue | null>>
}

const SkillPipelineStateContext = createContext<SkillPipelineStateContextValue | null>(null)

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
  isSkillPipelineBuilderOpen: boolean
  setIsSkillPipelineBuilderOpen: Dispatch<SetStateAction<boolean>>
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
  const [isSkillPipelineBuilderOpen, setIsSkillPipelineBuilderOpen] = useState(false)
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
      isSkillPipelineBuilderOpen,
      setIsSkillPipelineBuilderOpen,
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
      isSkillPipelineBuilderOpen,
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
// Skill Pipeline Builder State Provider
// ============================================================================

function defaultSkillPipelineSkill(n: number): SkillPipelineSkillDefinition {
  return {
    '@odata.type': '',
    name: `skill${n}`,
    context: '/document',
    inputs: [],
    outputs: [],
  }
}

function defaultSkillPipelineIndexer(skillsetName: string): SkillPipelineIndexerDefinition {
  return {
    name: 'indexer1',
    dataSourceName: 'datasource1',
    targetIndexName: 'index1',
    skillsetName: skillsetName.trim() || 'skillset1',
    fieldMappings: [],
    outputFieldMappings: [],
  }
}

function defaultDocumentNode(): SkillPipelineNode {
  return {
    id: SKILL_PIPELINE_DOC_NODE_ID,
    type: 'doc',
    position: { x: 80, y: 80 },
    data: { kind: 'doc', path: '/document' },
  }
}

function normalizeLoadedNodes(input: SkillPipelineNode[] | undefined): SkillPipelineNode[] {
  const raw = Array.isArray(input) ? input : []

  // Back-compat: older records stored nodes as { data: { skill } } with no kind.
  const normalized = raw.map((n) => {
    const data = (n as any)?.data
    const hasKind = data && typeof data.kind === 'string'
    if (hasKind) return n

    const maybeSkill = data?.skill
    if (maybeSkill && typeof maybeSkill === 'object') {
      return {
        ...(n as any),
        type: (n as any).type ?? 'skill',
        data: { kind: 'skill' as const, skill: maybeSkill as any },
      } as SkillPipelineNode
    }

    return n
  })

  const hasDoc = normalized.some((n) => n.id === SKILL_PIPELINE_DOC_NODE_ID || n.id === SKILL_PIPELINE_LEGACY_DOC_NODE_ID)
  if (!hasDoc) return [defaultDocumentNode(), ...normalized]

  return normalized
}

export function SkillPipelineStateProvider(props: { children: ReactNode }) {
  const [skillsetName, setSkillsetName] = useState('skillset1')
  const [skillsetDescription, setSkillsetDescription] = useState('')

  const [indexProjections, setIndexProjections] = useState<unknown | null>(null)
  const [knowledgeStore, setKnowledgeStore] = useState<unknown | null>(null)

  const [indexer, setIndexer] = useState<SkillPipelineIndexerDefinition | null>(null)

  const [currentSavedId, setCurrentSavedId] = useState<string | null>(null)
  const [baselineSkillsetJson, setBaselineSkillsetJson] = useState<string>(() => {
    const initialNodes: SkillPipelineNode[] = [
      defaultDocumentNode(),
      {
        id: 'n1',
        type: 'skill',
        position: { x: 420, y: 80 },
        data: { kind: 'skill', skill: defaultSkillPipelineSkill(1) },
      },
    ]
    return computeSkillsetJsonSnapshot({
      skillsetName: 'skillset1',
      skillsetDescription: '',
      indexProjections: null,
      knowledgeStore: null,
      nodes: initialNodes,
    })
  })
  const [saveSkillsetError, setSaveSkillsetError] = useState<string | null>(null)
  const [savedSkillsets, setSavedSkillsets] = useState<PersistedSkillPipelineItem[]>(() => listSkillPipelines())

  const [nodes, setNodes] = useState<SkillPipelineNode[]>(() => [
    defaultDocumentNode(),
    {
      id: 'n1',
      type: 'skill',
      position: { x: 420, y: 80 },
      data: { kind: 'skill', skill: defaultSkillPipelineSkill(1) },
    },
  ])
  const [edges, setEdges] = useState<SkillPipelineEdge[]>([])

  const [selectedNodeId, setSelectedNodeId] = useState('n1')
  const [draftSkillJson, setDraftSkillJson] = useState(() => JSON.stringify(defaultSkillPipelineSkill(1), null, 2))
  const [draftError, setDraftError] = useState<string | null>(null)

  const [draftIndexerJson, setDraftIndexerJson] = useState('{}')
  const [draftIndexerError, setDraftIndexerError] = useState<string | null>(null)

  const [draftIndexJson, setDraftIndexJson] = useState('{}')
  const [draftIndexError, setDraftIndexError] = useState<string | null>(null)

  const [debugFetchedDocs, setDebugFetchedDocs] = useState<JsonValue | null>(null)

  const refreshSavedSkillsets = useCallback(() => {
    setSavedSkillsets(listSkillPipelines())
  }, [])

  const newSkillset = useCallback(() => {
    const nextName = 'skillset1'
    const skill1 = defaultSkillPipelineSkill(1)

    setCurrentSavedId(null)
    setSaveSkillsetError(null)
    setSkillsetName(nextName)
    setSkillsetDescription('')
    setIndexProjections(null)
    setKnowledgeStore(null)

    const nextNodes: SkillPipelineNode[] = [
      defaultDocumentNode(),
      {
        id: 'n1',
        type: 'skill',
        position: { x: 420, y: 80 },
        data: { kind: 'skill', skill: skill1 },
      },
    ]

    setNodes(nextNodes)
    setEdges([])

    setBaselineSkillsetJson(
      computeSkillsetJsonSnapshot({
        skillsetName: nextName,
        skillsetDescription: '',
        indexProjections: null,
        knowledgeStore: null,
        nodes: nextNodes,
      }),
    )

    setSelectedNodeId('n1')
    setDraftSkillJson(JSON.stringify(skill1, null, 2))
    setDraftError(null)

    const ix = defaultSkillPipelineIndexer(nextName)
    setIndexer(ix)
    setDraftIndexerJson(JSON.stringify(ix, null, 2))
    setDraftIndexerError(null)

    setDraftIndexJson('{}')
    setDraftIndexError(null)
  }, [setEdges, setNodes, setSkillsetDescription, setSkillsetName])

  const saveSkillset = useCallback(
    (mode: 'save' | 'saveAs', nameOverride?: string) => {
      const id = mode === 'save' && currentSavedId ? currentSavedId : uuidv4()
      const effectiveName = nameOverride ?? skillsetName
      const title = effectiveName.trim() || 'skillset'

      // When a nameOverride is provided, also update the in-memory state.
      if (nameOverride != null && nameOverride !== skillsetName) {
        setSkillsetName(nameOverride)
      }

      try {
        upsertSkillPipeline({
          id,
          title,
          updatedAt: Date.now(),
          state: {
            skillsetName: effectiveName,
            skillsetDescription,
            indexProjections,
            knowledgeStore,
            indexer,
            nodes,
            edges,
          },
        })

        setSaveSkillsetError(null)
        setCurrentSavedId(id)
        setBaselineSkillsetJson(
          computeSkillsetJsonSnapshot({
            skillsetName: effectiveName,
            skillsetDescription,
            indexProjections,
            knowledgeStore,
            nodes,
          }),
        )
        refreshSavedSkillsets()
      } catch (e) {
        setSaveSkillsetError(e instanceof Error ? e.message : String(e))
      }
    },
    [currentSavedId, edges, nodes, refreshSavedSkillsets, skillsetDescription, skillsetName, indexProjections, knowledgeStore, indexer, setSkillsetName],
  )

  const loadSkillset = useCallback(
    (id: string) => {
      const item = getSkillPipeline(id)
      if (!item) return

      const normalizedNodes = normalizeLoadedNodes(item.state.nodes)
      const normalizedEdges = Array.isArray(item.state.edges) ? item.state.edges : []

      setCurrentSavedId(item.id)
      setSaveSkillsetError(null)
      setSkillsetName(item.state.skillsetName || 'skillset1')
      setSkillsetDescription(item.state.skillsetDescription || '')
      setIndexProjections((item.state as any).indexProjections ?? null)
      setKnowledgeStore((item.state as any).knowledgeStore ?? null)
      setIndexer(((item.state as any).indexer as SkillPipelineIndexerDefinition | null) ?? null)
      setNodes(normalizedNodes)
      setEdges(normalizedEdges)

      setBaselineSkillsetJson(
        computeSkillsetJsonSnapshot({
          skillsetName: item.state.skillsetName || 'skillset1',
          skillsetDescription: item.state.skillsetDescription || '',
          indexProjections: (item.state as any).indexProjections ?? null,
          knowledgeStore: (item.state as any).knowledgeStore ?? null,
          nodes: normalizedNodes,
        }),
      )

      const firstSkillNode = normalizedNodes.find((n) => (n as any)?.data?.kind === 'skill')
      const firstId = firstSkillNode?.id ?? ''
      setSelectedNodeId(firstId)
      const firstSkill = (firstSkillNode as any)?.data?.skill ?? defaultSkillPipelineSkill(1)
      setDraftSkillJson(JSON.stringify(firstSkill, null, 2))
      setDraftError(null)

      const ix = ((item.state as any).indexer as SkillPipelineIndexerDefinition | null) ?? null
      setDraftIndexerJson(ix ? JSON.stringify(ix, null, 2) : '{}')
      setDraftIndexerError(null)

      setDraftIndexJson('{}')
      setDraftIndexError(null)
    },
    [setEdges, setNodes, setSkillsetDescription, setSkillsetName],
  )

  const deleteSkillset = useCallback(
    (id: string) => {
      deleteSkillPipeline(id)
      if (currentSavedId === id) setCurrentSavedId(null)
      refreshSavedSkillsets()
    },
    [currentSavedId, refreshSavedSkillsets],
  )

  const value = useMemo<SkillPipelineStateContextValue>(
    () => ({
      skillsetName,
      setSkillsetName,
      skillsetDescription,
      setSkillsetDescription,

      indexProjections,
      setIndexProjections,
      knowledgeStore,
      setKnowledgeStore,

      indexer,
      setIndexer,

      currentSavedId,
      baselineSkillsetJson,
      setBaselineSkillsetJson,
      saveSkillsetError,
      setSaveSkillsetError,
      savedSkillsets,
      refreshSavedSkillsets,
      newSkillset,
      saveSkillset,
      loadSkillset,
      deleteSkillset,

      nodes,
      setNodes,
      edges,
      setEdges,
      selectedNodeId,
      setSelectedNodeId,
      draftSkillJson,
      setDraftSkillJson,
      draftError,
      setDraftError,

      draftIndexerJson,
      setDraftIndexerJson,
      draftIndexerError,
      setDraftIndexerError,

      draftIndexJson,
      setDraftIndexJson,
      draftIndexError,
      setDraftIndexError,

      debugFetchedDocs,
      setDebugFetchedDocs,
    }),
    [
      skillsetName,
      skillsetDescription,
      indexProjections,
      knowledgeStore,
      indexer,
      currentSavedId,
      savedSkillsets,
      refreshSavedSkillsets,
      newSkillset,
      saveSkillset,
      loadSkillset,
      deleteSkillset,
      nodes,
      edges,
      selectedNodeId,
      draftSkillJson,
      draftError,
      draftIndexerJson,
      draftIndexerError,
      draftIndexJson,
      draftIndexError,
      debugFetchedDocs,
    ],
  )

  return <SkillPipelineStateContext.Provider value={value}>{props.children}</SkillPipelineStateContext.Provider>
}

export function useSkillPipelineState() {
  const context = useContext(SkillPipelineStateContext)
  if (!context) {
    throw new Error('useSkillPipelineState must be used within SkillPipelineStateProvider')
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
                <SkillPipelineStateProvider>
                  {props.children}
                </SkillPipelineStateProvider>
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
