/**
 * Eval Dataset Generator (EDAG, Phase 1 MVP).
 *
 * Samples documents from an Azure AI Search index, generates evaluation queries
 * per document via Azure OpenAI, and exports JSONL compatible with
 * Search Parameter AutoTuning.
 */

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'

import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import { toJsonl, toRaftJsonl } from '../../lib/evalDatasetGenerator'
import { buildAadCliCommand, type LlmAuthMode } from '../../lib/llmAuth'
import { useEvalDatasetGeneration } from '../../hooks/useEvalDatasetGeneration'
import {
  deleteEvalDataset,
  getEvalDataset,
  listEvalDatasets,
  newEvalDatasetId,
  upsertEvalDataset,
  type PersistedEvalDatasetItem,
} from '../../app/persistedEvalDatasets'
import {
  loadEvalDatasetForm,
  saveEvalDatasetForm,
} from '../../app/persistedEvalDatasetForm'
import { useModalState } from '../../contexts'
import { EdgResultsTable } from './EdgResultsTable'
import { EdgPipelineFlow } from './EdgPipelineFlow'
import { TipsBlock } from './TipsBlock'
import type {
  DomainSchema,
  EvalDatasetGenerationConfig,
  EvalLanguage,
  EvalQueryType,
} from '../../types'

type TranslationKey = keyof typeof translations.ja

const QUERY_TYPE_OPTIONS: EvalQueryType[] = ['factoid', 'how-to', 'comparative', 'yes-no']

const DEFAULT_LLM_API_VERSION = '2024-10-21'
const DEFAULT_LLM_DEPLOYMENT = 'gpt-5.4-mini'
const DEFAULT_EMBEDDING_DEPLOYMENT = 'text-embedding-3-large'
const DEFAULT_GROUNDING_TOP_K = 10
const DEFAULT_SEMANTIC_THRESHOLD = 0.92

export interface EvalDatasetGeneratorProps {
  t: (key: TranslationKey) => string
  language: Language

  activeProfile: ConnectionProfile | null
  apiVersion: SearchApiVersion

  indexName: string
  availableIndexNames: string[]
  setIndexName: (indexName: string) => void

  indexFieldNames: string[]
  defaultIdFieldName: string | null

  defaultLlmEndpoint?: string
  defaultLlmApiKey?: string
  defaultLlmAuthMode?: LlmAuthMode
  defaultLlmBearerToken?: string

  openIndexInspector: (name?: string) => void
}

function downloadTextFile(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/jsonl;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

export function EvalDatasetGenerator(props: EvalDatasetGeneratorProps) {
  const {
    t,
    language,
    activeProfile,
    apiVersion,
    indexName,
    availableIndexNames,
    setIndexName,
    indexFieldNames,
    defaultIdFieldName,
    defaultLlmEndpoint,
    defaultLlmApiKey,
    defaultLlmAuthMode,
    defaultLlmBearerToken,
    openIndexInspector,
  } = props

  // Persisted form is loaded asynchronously from IndexedDB after mount.
  // Until hydration completes, the form shows component defaults; the save
  // effect is gated by `hydratedRef` so we never write defaults back to
  // storage before the load resolves.

  // Source state
  const [keyField, setKeyField] = useState<string>(() => defaultIdFieldName ?? 'docid')
  const [contentFieldsText, setContentFieldsText] = useState<string>(() => {
    // Heuristic default: prefer existing common fields, otherwise fall back to 'text, title'.
    const candidates = ['text', 'title'].filter((f) => indexFieldNames.includes(f))
    if (candidates.length > 0) return candidates.join(', ')
    if (indexFieldNames.includes('content')) return 'content'
    return 'text, title'
  })
  const [sampleSize, setSampleSize] = useState<number>(20)
  const [queriesPerDoc, setQueriesPerDoc] = useState<number>(3)

  // Generation state
  const [edgLanguage, setEdgLanguage] = useState<EvalLanguage>(language === 'en' ? 'en' : 'ja')
  const [queryTypes, setQueryTypes] = useState<EvalQueryType[]>(['factoid', 'how-to'])
  const [domainDescription, setDomainDescription] = useState<string>('')

  // LLM state. apiKey / bearerToken are persisted in IndexedDB to match the
  // Connection profile (admin keys) behavior. Persisted values take
  // precedence over the defaults inherited from the Connection.
  const [llmEndpoint, setLlmEndpoint] = useState<string>(defaultLlmEndpoint ?? '')
  const [llmAuthMode, setLlmAuthMode] = useState<LlmAuthMode>(defaultLlmAuthMode ?? 'apiKey')
  const [llmApiKey, setLlmApiKey] = useState<string>(defaultLlmApiKey ?? '')
  const [llmBearerToken, setLlmBearerToken] = useState<string>(defaultLlmBearerToken ?? '')
  const [llmDeployment, setLlmDeployment] = useState<string>(DEFAULT_LLM_DEPLOYMENT)
  const [llmApiVersion, setLlmApiVersion] = useState<string>(DEFAULT_LLM_API_VERSION)
  const [cliCopied, setCliCopied] = useState<boolean>(false)

  // Phase 2 quality filters
  const [enableGroundingCheck, setEnableGroundingCheck] = useState<boolean>(true)
  const [groundingTopK, setGroundingTopK] = useState<number>(DEFAULT_GROUNDING_TOP_K)
  const [enableSemanticDedup, setEnableSemanticDedup] = useState<boolean>(false)
  const [embeddingDeployment, setEmbeddingDeployment] = useState<string>(DEFAULT_EMBEDDING_DEPLOYMENT)
  const [semanticThreshold, setSemanticThreshold] = useState<number>(DEFAULT_SEMANTIC_THRESHOLD)
  const [showRejected, setShowRejected] = useState<boolean>(false)

  // Phase 3: Ragas-style scenario generation
  const [enableRagasMode, setEnableRagasMode] = useState<boolean>(false)
  const [distSingleSpecific, setDistSingleSpecific] = useState<number>(50)
  const [distSingleAbstract, setDistSingleAbstract] = useState<number>(20)
  const [distMultiSpecific, setDistMultiSpecific] = useState<number>(20)
  const [distMultiAbstract, setDistMultiAbstract] = useState<number>(10)
  const [personasText, setPersonasText] = useState<string>('')
  const [styleWebSearch, setStyleWebSearch] = useState<boolean>(true)
  const [styleChat, setStyleChat] = useState<boolean>(true)
  const [styleFormal, setStyleFormal] = useState<boolean>(false)
  const [styleInformal, setStyleInformal] = useState<boolean>(false)
  const [lengthShort, setLengthShort] = useState<boolean>(true)
  const [lengthMedium, setLengthMedium] = useState<boolean>(true)
  const [lengthLong, setLengthLong] = useState<boolean>(false)
  const [multiHopThreshold, setMultiHopThreshold] = useState<number>(0.1)

  // Phase 4: difficulty / hard negative / schema
  const [enableDifficultyEvolution, setEnableDifficultyEvolution] = useState<boolean>(false)
  const [enableHardNegativeMining, setEnableHardNegativeMining] = useState<boolean>(false)
  const [hardNegativeTopK, setHardNegativeTopK] = useState<number>(10)
  const [schemaEntities, setSchemaEntities] = useState<string>('')
  const [schemaRelations, setSchemaRelations] = useState<string>('')
  const [schemaConstraints, setSchemaConstraints] = useState<string>('')

  // Phase 6: NDCG/XDCG-compatible relevance grades + entity-KG (opt-in).
  const [enableRelevanceGrades, setEnableRelevanceGrades] = useState<boolean>(false)
  const [enableEntityKG, setEnableEntityKG] = useState<boolean>(false)

  // Phase 7a: Judge LLM (deployment name only — same endpoint/auth as generation LLM).
  const [judgeLlmDeployment, setJudgeLlmDeployment] = useState<string>('')

  // Phase 7b: Style Evolution (SNS mode).
  const [enableStyleEvolution, setEnableStyleEvolution] = useState<boolean>(false)
  const [seKeyword, setSeKeyword] = useState<boolean>(true)
  const [seColloquial, setSeColloquial] = useState<boolean>(true)
  const [seTypo, setSeTypo] = useState<boolean>(true)
  const [seAbbreviated, setSeAbbreviated] = useState<boolean>(true)
  const [seCodeSwitch, setSeCodeSwitch] = useState<boolean>(true)

  // Phase 7c: Query Transformation Trace.
  const [enableTrace, setEnableTrace] = useState<boolean>(true)

  // RAFT (Retrieval Augmented Fine-Tuning)
  const [enableRaftMode, setEnableRaftMode] = useState<boolean>(false)
  const [raftDistractorCount, setRaftDistractorCount] = useState<number>(4)

  // Phase 3: persistence
  const [persistTitle, setPersistTitle] = useState<string>('')
  const [persistList, setPersistList] = useState<PersistedEvalDatasetItem[]>(() => listEvalDatasets())
  const [selectedPersistId, setSelectedPersistId] = useState<string>('')
  const [persistToast, setPersistToast] = useState<string>('')

  const { setPendingAutoTuningJsonl, setIsAutoTuningOpen } = useModalState()

  const [validationError, setValidationError] = useState<string | null>(null)

  const { items, isRunning, error, progress, docTextById, start, cancel, reset } = useEvalDatasetGeneration({
    profile: activeProfile,
    apiVersion,
    language,
  })

  // Hydrate form fields from IndexedDB once on mount. While this is in
  // flight, the save effect below stays disabled so it never overwrites
  // persisted values with the initial defaults.
  const hydratedRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    void loadEvalDatasetForm().then((form) => {
      if (cancelled) return
      if (form) {
        if (form.keyField !== undefined) setKeyField(form.keyField)
        if (form.contentFieldsText !== undefined) setContentFieldsText(form.contentFieldsText)
        if (form.sampleSize !== undefined) setSampleSize(form.sampleSize)
        if (form.queriesPerDoc !== undefined) setQueriesPerDoc(form.queriesPerDoc)
        if (form.edgLanguage !== undefined) setEdgLanguage(form.edgLanguage)
        if (form.queryTypes !== undefined) setQueryTypes(form.queryTypes)
        if (form.domainDescription !== undefined) setDomainDescription(form.domainDescription)
        if (form.llmEndpoint !== undefined) setLlmEndpoint(form.llmEndpoint)
        if (form.llmAuthMode !== undefined) setLlmAuthMode(form.llmAuthMode)
        if (form.llmApiKey !== undefined) setLlmApiKey(form.llmApiKey)
        if (form.llmBearerToken !== undefined) setLlmBearerToken(form.llmBearerToken)
        if (form.llmDeployment !== undefined) setLlmDeployment(form.llmDeployment)
        if (form.llmApiVersion !== undefined) setLlmApiVersion(form.llmApiVersion)
        if (form.enableGroundingCheck !== undefined) setEnableGroundingCheck(form.enableGroundingCheck)
        if (form.groundingTopK !== undefined) setGroundingTopK(form.groundingTopK)
        if (form.enableSemanticDedup !== undefined) setEnableSemanticDedup(form.enableSemanticDedup)
        if (form.embeddingDeployment !== undefined) setEmbeddingDeployment(form.embeddingDeployment)
        if (form.semanticThreshold !== undefined) setSemanticThreshold(form.semanticThreshold)
        if (form.showRejected !== undefined) setShowRejected(form.showRejected)
        if (form.enableRagasMode !== undefined) setEnableRagasMode(form.enableRagasMode)
        if (form.distSingleSpecific !== undefined) setDistSingleSpecific(form.distSingleSpecific)
        if (form.distSingleAbstract !== undefined) setDistSingleAbstract(form.distSingleAbstract)
        if (form.distMultiSpecific !== undefined) setDistMultiSpecific(form.distMultiSpecific)
        if (form.distMultiAbstract !== undefined) setDistMultiAbstract(form.distMultiAbstract)
        if (form.personasText !== undefined) setPersonasText(form.personasText)
        if (form.styleWebSearch !== undefined) setStyleWebSearch(form.styleWebSearch)
        if (form.styleChat !== undefined) setStyleChat(form.styleChat)
        if (form.styleFormal !== undefined) setStyleFormal(form.styleFormal)
        if (form.styleInformal !== undefined) setStyleInformal(form.styleInformal)
        if (form.lengthShort !== undefined) setLengthShort(form.lengthShort)
        if (form.lengthMedium !== undefined) setLengthMedium(form.lengthMedium)
        if (form.lengthLong !== undefined) setLengthLong(form.lengthLong)
        if (form.multiHopThreshold !== undefined) setMultiHopThreshold(form.multiHopThreshold)
        if (form.enableDifficultyEvolution !== undefined)
          setEnableDifficultyEvolution(form.enableDifficultyEvolution)
        if (form.enableHardNegativeMining !== undefined)
          setEnableHardNegativeMining(form.enableHardNegativeMining)
        if (form.hardNegativeTopK !== undefined) setHardNegativeTopK(form.hardNegativeTopK)
        if (form.schemaEntities !== undefined) setSchemaEntities(form.schemaEntities)
        if (form.schemaRelations !== undefined) setSchemaRelations(form.schemaRelations)
        if (form.schemaConstraints !== undefined) setSchemaConstraints(form.schemaConstraints)
        if (form.enableRelevanceGrades !== undefined)
          setEnableRelevanceGrades(form.enableRelevanceGrades)
        if (form.enableEntityKG !== undefined) setEnableEntityKG(form.enableEntityKG)
        // Phase 7a: Judge LLM
        if (form.judgeLlmDeployment !== undefined) setJudgeLlmDeployment(form.judgeLlmDeployment)
        // Phase 7b: Style Evolution
        if (form.enableStyleEvolution !== undefined) setEnableStyleEvolution(form.enableStyleEvolution)
        if (form.seKeyword !== undefined) setSeKeyword(form.seKeyword)
        if (form.seColloquial !== undefined) setSeColloquial(form.seColloquial)
        if (form.seTypo !== undefined) setSeTypo(form.seTypo)
        if (form.seAbbreviated !== undefined) setSeAbbreviated(form.seAbbreviated)
        if (form.seCodeSwitch !== undefined) setSeCodeSwitch(form.seCodeSwitch)
        // Phase 7c: Trace
        if (form.enableTrace !== undefined) setEnableTrace(form.enableTrace)
        // RAFT
        if (form.enableRaftMode !== undefined) setEnableRaftMode(form.enableRaftMode)
        if (form.raftDistractorCount !== undefined) setRaftDistractorCount(form.raftDistractorCount)
        if (form.persistTitle !== undefined) setPersistTitle(form.persistTitle)
        if (form.selectedPersistId !== undefined) setSelectedPersistId(form.selectedPersistId)
      }
      hydratedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Persist form fields (debounced) to IndexedDB so users do not lose
  // their configuration across reloads. Save is gated on hydration so we
  // never overwrite persisted values with the initial defaults.
  useEffect(() => {
    if (!hydratedRef.current) return
    const handle = window.setTimeout(() => {
      void saveEvalDatasetForm({
        keyField,
        contentFieldsText,
        sampleSize,
        queriesPerDoc,
        edgLanguage,
        queryTypes,
        domainDescription,
        llmEndpoint,
        llmAuthMode,
        llmApiKey,
        llmBearerToken,
        llmDeployment,
        llmApiVersion,
        enableGroundingCheck,
        groundingTopK,
        enableSemanticDedup,
        embeddingDeployment,
        semanticThreshold,
        showRejected,
        enableRagasMode,
        distSingleSpecific,
        distSingleAbstract,
        distMultiSpecific,
        distMultiAbstract,
        personasText,
        styleWebSearch,
        styleChat,
        styleFormal,
        styleInformal,
        lengthShort,
        lengthMedium,
        lengthLong,
        multiHopThreshold,
        enableDifficultyEvolution,
        enableHardNegativeMining,
        hardNegativeTopK,
        schemaEntities,
        schemaRelations,
        schemaConstraints,
        enableRelevanceGrades,
        enableEntityKG,
        judgeLlmDeployment,
        enableStyleEvolution,
        seKeyword,
        seColloquial,
        seTypo,
        seAbbreviated,
        seCodeSwitch,
        enableTrace,
        enableRaftMode,
        raftDistractorCount,
        persistTitle,
        selectedPersistId,
      })
    }, 300)
    return () => window.clearTimeout(handle)
  }, [
    keyField,
    contentFieldsText,
    sampleSize,
    queriesPerDoc,
    edgLanguage,
    queryTypes,
    domainDescription,
    llmEndpoint,
    llmAuthMode,
    llmApiKey,
    llmBearerToken,
    llmDeployment,
    llmApiVersion,
    enableGroundingCheck,
    groundingTopK,
    enableSemanticDedup,
    embeddingDeployment,
    semanticThreshold,
    showRejected,
    enableRagasMode,
    distSingleSpecific,
    distSingleAbstract,
    distMultiSpecific,
    distMultiAbstract,
    personasText,
    styleWebSearch,
    styleChat,
    styleFormal,
    styleInformal,
    lengthShort,
    lengthMedium,
    lengthLong,
    multiHopThreshold,
    enableDifficultyEvolution,
    enableHardNegativeMining,
    hardNegativeTopK,
    schemaEntities,
    schemaRelations,
    schemaConstraints,
    enableRelevanceGrades,
    enableEntityKG,
    judgeLlmDeployment,
    enableStyleEvolution,
    seKeyword,
    seColloquial,
    seTypo,
    seAbbreviated,
    seCodeSwitch,
    enableTrace,
    enableRaftMode,
    raftDistractorCount,
    persistTitle,
    selectedPersistId,
  ])

  const contentFields = useMemo(
    () =>
      contentFieldsText
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    [contentFieldsText],
  )

  const canRun = !isRunning && !!activeProfile

  const distSum =
    distSingleSpecific + distSingleAbstract + distMultiSpecific + distMultiAbstract
  const distSumOk = Math.abs(distSum - 100) < 0.5

  function normalizeDistribution() {
    const total = distSum
    if (total <= 0) {
      setDistSingleSpecific(50)
      setDistSingleAbstract(20)
      setDistMultiSpecific(20)
      setDistMultiAbstract(10)
      return
    }
    const f = 100 / total
    setDistSingleSpecific(Math.round(distSingleSpecific * f))
    setDistSingleAbstract(Math.round(distSingleAbstract * f))
    setDistMultiSpecific(Math.round(distMultiSpecific * f))
    // Force last to balance to exactly 100 to avoid 99/101 from rounding.
    const partial =
      Math.round(distSingleSpecific * f) +
      Math.round(distSingleAbstract * f) +
      Math.round(distMultiSpecific * f)
    setDistMultiAbstract(100 - partial)
  }

  function toggleQueryType(qt: EvalQueryType) {
    setQueryTypes((prev) => (prev.includes(qt) ? prev.filter((x) => x !== qt) : [...prev, qt]))
  }

  function validate(): string | null {
    if (!activeProfile) return String(t('edgErrProfile'))
    if (!indexName.trim()) return String(t('edgErrIndexName'))
    if (!keyField.trim()) return String(t('edgErrKeyField'))
    if (contentFields.length === 0) return String(t('edgErrContentFields'))
    if (!llmEndpoint.trim()) return String(t('edgErrLlmEndpoint'))
    if (llmAuthMode === 'apiKey' && !llmApiKey.trim()) return String(t('edgErrLlmApiKey'))
    if (llmAuthMode === 'bearer' && !llmBearerToken.trim()) return String(t('edgErrLlmBearerToken'))
    if (!llmDeployment.trim()) return String(t('edgErrLlmDeployment'))
    if (enableSemanticDedup && !embeddingDeployment.trim())
      return String(t('edgErrEmbeddingDeployment'))
    return null
  }

  async function onGenerate() {
    const v = validate()
    setValidationError(v)
    if (v) return
    const config: EvalDatasetGenerationConfig = {
      indexName: indexName.trim(),
      keyField: keyField.trim(),
      contentFields,
      sampleSize,
      queriesPerDoc,
      language: edgLanguage,
      queryTypes: queryTypes.length > 0 ? queryTypes : ['factoid'],
      domainDescription: domainDescription.trim() || undefined,
      llmEndpoint: llmEndpoint.trim(),
      llmAuth:
        llmAuthMode === 'bearer'
          ? { mode: 'bearer', bearerToken: llmBearerToken.trim() }
          : { mode: 'apiKey', apiKey: llmApiKey.trim() },
      llmDeployment: llmDeployment.trim(),
      llmApiVersion: llmApiVersion.trim() || DEFAULT_LLM_API_VERSION,
      enableGroundingCheck,
      groundingTopK: Math.max(1, Math.min(50, Math.floor(groundingTopK || DEFAULT_GROUNDING_TOP_K))),
      enableSemanticDedup,
      embeddingDeployment: embeddingDeployment.trim() || undefined,
      semanticDedupThreshold: Math.max(0, Math.min(1, semanticThreshold)),
      // Phase 3: Ragas-style scenario generation
      enableRagasMode,
      queryDistribution: enableRagasMode
        ? {
            single_specific: Math.max(0, distSingleSpecific) / 100,
            single_abstract: Math.max(0, distSingleAbstract) / 100,
            multi_specific: Math.max(0, distMultiSpecific) / 100,
            multi_abstract: Math.max(0, distMultiAbstract) / 100,
          }
        : undefined,
      personas: enableRagasMode
        ? personasText
            .split(/[,、]/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined,
      styles: enableRagasMode
        ? ([
            styleWebSearch ? 'web_search' : null,
            styleChat ? 'chat' : null,
            styleFormal ? 'formal' : null,
            styleInformal ? 'informal' : null,
          ].filter(Boolean) as EvalDatasetGenerationConfig['styles'])
        : undefined,
      lengths: enableRagasMode
        ? ([
            lengthShort ? 'short' : null,
            lengthMedium ? 'medium' : null,
            lengthLong ? 'long' : null,
          ].filter(Boolean) as EvalDatasetGenerationConfig['lengths'])
        : undefined,
      multiHopPairingThreshold: enableRagasMode ? multiHopThreshold : undefined,
      // Phase 4: difficulty / hard negative / schema
      enableDifficultyEvolution,
      enableHardNegativeMining,
      hardNegativeTopK: Math.max(1, Math.min(50, Math.floor(hardNegativeTopK || 10))),
      domainSchema: (() => {
        const schema: DomainSchema = {}
        const ent = schemaEntities.trim()
        const rel = schemaRelations.trim()
        const con = schemaConstraints.trim()
        if (ent) schema.entities = ent
        if (rel) schema.relations = rel
        if (con) schema.constraints = con
        return ent || rel || con ? schema : undefined
      })(),
      // Phase 6: NDCG/XDCG-compatible relevance grades + entity-KG.
      enableRelevanceGrades,
      enableEntityKG: enableRagasMode ? enableEntityKG : undefined,
      // Phase 7a: Judge LLM (deployment name only).
      judgeLlmDeployment: judgeLlmDeployment.trim() || undefined,
      // Phase 7b: Style Evolution (SNS mode).
      enableStyleEvolution,
      styleEvolutionKinds: enableStyleEvolution
        ? ([
            seKeyword ? 'keyword' : null,
            seColloquial ? 'colloquial' : null,
            seTypo ? 'typo' : null,
            seAbbreviated ? 'abbreviated' : null,
            seCodeSwitch ? 'code_switch' : null,
          ].filter(Boolean) as EvalDatasetGenerationConfig['styleEvolutionKinds'])
        : undefined,
      // Phase 7c: Trace.
      enableTrace,
      // RAFT
      enableRaftMode,
      raftDistractorCount: enableRaftMode ? raftDistractorCount : undefined,
    }
    await start(config)
  }

  async function onCopyCliCommand() {
    const cmd = buildAadCliCommand()
    try {
      await navigator.clipboard.writeText(cmd)
      setCliCopied(true)
      window.setTimeout(() => setCliCopied(false), 1500)
    } catch {
      // ignore
    }
  }

  function onExport() {
    const jsonl = toJsonl(items)
    if (!jsonl) return
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const safeIndex = indexName.replace(/[^a-z0-9_-]/gi, '_') || 'index'
    downloadTextFile(`eval-dataset-${safeIndex}-${ts}.jsonl`, jsonl)
  }

  function onExportRaft() {
    const jsonl = toRaftJsonl(items)
    if (!jsonl) return
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const safeIndex = indexName.replace(/[^a-z0-9_-]/gi, '_') || 'index'
    downloadTextFile(`raft-dataset-${safeIndex}-${ts}.jsonl`, jsonl)
  }

  // ---- Phase 3: persistence + AutoTuning handoff -----------------
  function refreshPersistList() {
    setPersistList(listEvalDatasets())
  }

  function onSavePersist() {
    if (items.length === 0) return
    const id = selectedPersistId || newEvalDatasetId()
    const fallbackTitle = `${indexName || 'dataset'} (${new Date().toLocaleString()})`
    const title = persistTitle.trim() || fallbackTitle
    upsertEvalDataset({
      id,
      title,
      updatedAt: Date.now(),
      indexName: indexName.trim() || undefined,
      itemCount: items.length,
      items,
    })
    refreshPersistList()
    setSelectedPersistId(id)
    setPersistToast(String(t('edgPersistSavedToast')))
    window.setTimeout(() => setPersistToast(''), 1500)
  }

  function onLoadPersist() {
    if (!selectedPersistId) return
    const got = getEvalDataset(selectedPersistId)
    if (!got) return
    setPersistTitle(got.title)
    if (got.indexName) setIndexName(got.indexName)
    const jsonl = toJsonl(got.items)
    setPendingAutoTuningJsonl({
      fileName: `${got.title.replace(/[^a-z0-9_-]/gi, '_') || 'eval-dataset'}.jsonl`,
      text: jsonl,
    })
    setIsAutoTuningOpen(true)
  }

  function onDeletePersist() {
    if (!selectedPersistId) return
    if (!window.confirm(String(t('edgPersistConfirmDelete')))) return
    deleteEvalDataset(selectedPersistId)
    setSelectedPersistId('')
    refreshPersistList()
  }

  function onSendToAutoTuning() {
    const jsonl = toJsonl(items)
    if (!jsonl) return
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const safeIndex = indexName.replace(/[^a-z0-9_-]/gi, '_') || 'index'
    setPendingAutoTuningJsonl({
      fileName: `eval-dataset-${safeIndex}-${ts}.jsonl`,
      text: jsonl,
    })
    setIsAutoTuningOpen(true)
  }

  return (
    <div className="pane__centerContent">
      <div className="section">
        <div className="section__title">{t('evalDatasetGenerator')}</div>
        <div className="app__hint">{t('edgIntro')}</div>
      </div>

      {/* Source ------------------------------------------------------ */}
      <div className="section">
        <div className="section__title"><i className="bi bi-database icon--mr6" />{t('edgSourceTitle')}</div>
        <div className="formGrid">
          <label className="field" data-guide-target="edg-index">
            <span className="field__label">{t('edgIndexNameLabel')}</span>
            <div className="edgIndexRow">
              {availableIndexNames.length > 0 ? (
                <select
                  className="field__input"
                  value={indexName}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => setIndexName(e.target.value)}
                >
                  <option value="">--</option>
                  {availableIndexNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="field__input"
                  value={indexName}
                  onChange={(e) => setIndexName(e.target.value)}
                />
              )}
              <button
                type="button"
                className="btn btn--xs"
                onClick={() => openIndexInspector(indexName)}
                disabled={!activeProfile || !indexName.trim()}
                title={String(t('indexInspector'))}
              >
                <i className="bi bi-eye icon--mr6"></i>
                {t('indexInspector')}
              </button>
            </div>
          </label>

          <label className="field">
            <span className="field__label">{t('edgKeyFieldLabel')}</span>
            <input
              className="field__input"
              value={keyField}
              onChange={(e) => setKeyField(e.target.value)}
              placeholder="docid"
            />
          </label>

          <label className="field">
            <span className="field__label">{t('edgContentFieldsLabel')}</span>
            <input
              className="field__input"
              value={contentFieldsText}
              onChange={(e) => setContentFieldsText(e.target.value)}
              placeholder="text, title"
            />
          </label>

          <label className="field" data-guide-target="edg-sample-size">
            <span className="field__label">{t('edgSampleSizeLabel')}</span>
            <input
              type="number"
              className="field__input"
              min={1}
              max={500}
              value={sampleSize}
              onChange={(e) => setSampleSize(Math.max(1, Math.min(500, Number(e.target.value) || 1)))}
            />
          </label>

          <label className="field">
            <span className="field__label">{t('edgQueriesPerDocLabel')}</span>
            <input
              type="number"
              className="field__input"
              min={1}
              max={20}
              value={queriesPerDoc}
              onChange={(e) =>
                setQueriesPerDoc(Math.max(1, Math.min(20, Number(e.target.value) || 1)))
              }
            />
          </label>
        </div>
      </div>

      {/* Generation -------------------------------------------------- */}
      <div className="section">
        <div className="section__title"><i className="bi bi-sliders icon--mr6" />{t('edgGenerationTitle')}</div>
        <div className="formGrid">
          <label className="field">
            <span className="field__label">{t('edgLanguageLabel')}</span>
            <select
              className="field__input"
              value={edgLanguage}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                setEdgLanguage(e.target.value === 'en' ? 'en' : 'ja')
              }
            >
              <option value="ja">ja</option>
              <option value="en">en</option>
            </select>
          </label>

          <div className="field">
            <span className="field__label">{t('edgQueryTypesLabel')}</span>
            <div className="edgQueryTypes">
              {QUERY_TYPE_OPTIONS.map((qt) => (
                <label key={qt} className="edgQueryTypes__item">
                  <input
                    type="checkbox"
                    checked={queryTypes.includes(qt)}
                    onChange={() => toggleQueryType(qt)}
                  />{' '}
                  {qt}
                </label>
              ))}
            </div>
          </div>

          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">{t('edgDomainDescriptionLabel')}</span>
            <textarea
              className="field__input"
              rows={2}
              value={domainDescription}
              onChange={(e) => setDomainDescription(e.target.value)}
            />
          </label>
        </div>
      </div>

      {/* LLM --------------------------------------------------------- */}
      <div className="section">
        <div className="section__title"><i className="bi bi-robot icon--mr6" />{t('edgLlmTitle')}</div>
        <div className="formGrid">
          <label className="field">
            <span className="field__label">{t('edgLlmEndpointLabel')}</span>
            <input
              className="field__input"
              value={llmEndpoint}
              onChange={(e) => setLlmEndpoint(e.target.value)}
              placeholder="https://YOUR-RESOURCE.openai.azure.com"
            />
          </label>
          <label className="field">
            <span className="field__label">{t('llmAuthModeLabel')}</span>
            <select
              className="field__input"
              value={llmAuthMode}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                setLlmAuthMode(e.target.value === 'bearer' ? 'bearer' : 'apiKey')
              }
            >
              <option value="apiKey">apiKey</option>
              <option value="bearer">bearer (Entra ID)</option>
            </select>
          </label>
          {llmAuthMode === 'apiKey' ? (
            <label className="field">
              <span className="field__label">{t('edgLlmApiKeyLabel')}</span>
              <input
                type="password"
                className="field__input"
                value={llmApiKey}
                onChange={(e) => setLlmApiKey(e.target.value)}
              />
            </label>
          ) : (
            <label className="field">
              <span className="field__label">{t('llmBearerTokenLabel')}</span>
              <input
                type="password"
                className="field__input"
                value={llmBearerToken}
                onChange={(e) => setLlmBearerToken(e.target.value)}
                placeholder={String(t('llmBearerTokenPlaceholder'))}
              />
            </label>
          )}
          <label className="field">
            <span className="field__label">{t('edgLlmDeploymentLabel')}</span>
            <input
              className="field__input"
              value={llmDeployment}
              onChange={(e) => setLlmDeployment(e.target.value)}
              placeholder="gpt-5.4-mini"
            />
          </label>
          <label className="field">
            <span className="field__label">{t('edgLlmApiVersionLabel')}</span>
            <input
              className="field__input"
              value={llmApiVersion}
              onChange={(e) => setLlmApiVersion(e.target.value)}
              placeholder={DEFAULT_LLM_API_VERSION}
            />
          </label>
        </div>
        {llmAuthMode === 'bearer' && (
          <div className="field__hint" style={{ marginTop: 8 }}>
            <div>{t('aadCliHelperDesc')}</div>
            <div className="aadCliHelper">
              <code className="aadCliHelper__code">{buildAadCliCommand()}</code>
              <button
                type="button"
                className="btn btn--icon"
                onClick={() => void onCopyCliCommand()}
                title={String(t('aadCliCopy'))}
              >
                <i className={cliCopied ? 'bi bi-check2' : 'bi bi-clipboard'}></i>
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Quality filters (Phase 2) ----------------------------------- */}
      <div className="section">
        <div className="section__title" data-guide-target="edg-quality"><i className="bi bi-funnel icon--mr6" />{t('edgQualityTitle')}</div>
        <div className="edgScienceInfo">
          <div className="edgScienceInfo__header">
            <i className="bi bi-mortarboard-fill"></i>
            <span>{t('edgSciInfoQualityTitle')}</span>
          </div>
          <div className="edgScienceInfo__body">{t('edgSciInfoQualityBody')}</div>
          <div className="edgScienceInfo__refs">{t('edgSciInfoQualityRefs')}</div>
        </div>
        <div className="formGrid">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">
              <input
                type="checkbox"
                checked={enableGroundingCheck}
                onChange={(e) => setEnableGroundingCheck(e.target.checked)}
              />{' '}
              {t('edgGroundingCheckLabel')}
            </span>
            <div className="field__hint">{t('edgGroundingCheckHint')}</div>
          </label>
          <label className="field">
            <span className="field__label">{t('edgGroundingTopKLabel')}</span>
            <input
              type="number"
              className="field__input"
              min={1}
              max={50}
              value={groundingTopK}
              disabled={!enableGroundingCheck}
              onChange={(e) =>
                setGroundingTopK(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
              }
            />
          </label>

          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">
              <input
                type="checkbox"
                checked={enableSemanticDedup}
                onChange={(e) => setEnableSemanticDedup(e.target.checked)}
              />{' '}
              {t('edgSemanticDedupLabel')}
            </span>
            <div className="field__hint">{t('edgSemanticDedupHint')}</div>
          </label>
          <label className="field" data-guide-target="edg-embedding-deployment">
            <span className="field__label">{t('edgEmbeddingDeploymentLabel')}</span>
            <input
              className="field__input"
              value={embeddingDeployment}
              disabled={!enableSemanticDedup}
              onChange={(e) => setEmbeddingDeployment(e.target.value)}
              placeholder={DEFAULT_EMBEDDING_DEPLOYMENT}
            />
          </label>
          <label className="field">
            <span className="field__label">
              {t('edgSemanticThresholdLabel')} ({semanticThreshold.toFixed(2)})
            </span>
            <input
              type="range"
              className="field__input"
              min={0.5}
              max={1}
              step={0.01}
              value={semanticThreshold}
              disabled={!enableSemanticDedup}
              onChange={(e) => setSemanticThreshold(Number(e.target.value))}
            />
          </label>
        </div>
      </div>

      {/* Phase 3: Ragas-style scenario generation -------------------- */}
      <div className="section" data-guide-target="edg-ragas">
        <h4 className="section__title"><i className="bi bi-grid-3x3-gap icon--mr6" />{t('edgRagasTitle')}</h4>
        <div className="edgScienceInfo">
          <div className="edgScienceInfo__header">
            <i className="bi bi-mortarboard-fill"></i>
            <span>{t('edgSciInfoRagasTitle')}</span>
          </div>
          <div className="edgScienceInfo__body">{t('edgSciInfoRagasBody')}</div>
          <div className="edgScienceInfo__refs">{t('edgSciInfoRagasRefs')}</div>
        </div>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={enableRagasMode}
            onChange={(e) => setEnableRagasMode(e.target.checked)}
          />
          <span className="field__label" style={{ marginBottom: 0 }}>
            {t('edgRagasEnableLabel')}
          </span>
        </label>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {t('edgRagasEnableHint')}
        </p>

        {enableRagasMode && (
          <>
            <div style={{ marginTop: 12 }}>
              <div
                className="field__label"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              >
                <span>
                  {t('edgRagasDistributionLabel')} ({distSum.toFixed(0)}%)
                </span>
                <button
                  type="button"
                  className="btn btn--xs"
                  onClick={normalizeDistribution}
                >
                  <i className="bi bi-magic icon--mr6"></i>
                  {t('edgRagasNormalizeBtn')}
                </button>
              </div>
              {!distSumOk && (
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--accent)',
                    marginTop: 4,
                  }}
                >
                  {t('edgRagasDistSumWarning')}
                </div>
              )}
              <div
                className="edgQuadrant"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 8,
                  marginTop: 8,
                }}
              >
                {(
                  [
                    {
                      key: 'ss',
                      title: 'edgQuadSingleSpecific',
                      desc: 'edgQuadSingleSpecificDesc',
                      val: distSingleSpecific,
                      set: setDistSingleSpecific,
                    },
                    {
                      key: 'sa',
                      title: 'edgQuadSingleAbstract',
                      desc: 'edgQuadSingleAbstractDesc',
                      val: distSingleAbstract,
                      set: setDistSingleAbstract,
                    },
                    {
                      key: 'ms',
                      title: 'edgQuadMultiSpecific',
                      desc: 'edgQuadMultiSpecificDesc',
                      val: distMultiSpecific,
                      set: setDistMultiSpecific,
                    },
                    {
                      key: 'ma',
                      title: 'edgQuadMultiAbstract',
                      desc: 'edgQuadMultiAbstractDesc',
                      val: distMultiAbstract,
                      set: setDistMultiAbstract,
                    },
                  ] as const
                ).map((q) => (
                  <div
                    key={q.key}
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 8,
                      background: 'var(--panel-2)',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{t(q.title)}</div>
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                      {t(q.desc)}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginTop: 6,
                      }}
                    >
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={q.val}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          q.set(Math.max(0, Math.min(100, Number(e.target.value) || 0)))
                        }
                        style={{ flex: 1 }}
                      />
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={1}
                        value={q.val}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          q.set(Math.max(0, Math.min(100, Number(e.target.value) || 0)))
                        }
                        style={{ width: 60 }}
                      />
                      <span style={{ fontSize: 12 }}>%</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <label className="field" style={{ marginTop: 12 }}>
              <span className="field__label">{t('edgPersonasLabel')}</span>
              <input
                type="text"
                className="field__input"
                value={personasText}
                placeholder={String(t('edgPersonasPlaceholder'))}
                onChange={(e) => setPersonasText(e.target.value)}
              />
            </label>

            <div style={{ marginTop: 12 }}>
              <div className="field__label">{t('edgStylesLabel')}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(
                  [
                    ['web_search', styleWebSearch, setStyleWebSearch],
                    ['chat', styleChat, setStyleChat],
                    ['formal', styleFormal, setStyleFormal],
                    ['informal', styleInformal, setStyleInformal],
                  ] as const
                ).map(([label, val, setter]) => (
                  <button
                    key={label}
                    type="button"
                    className={`btn btn--xs${val ? ' btn--search' : ''}`}
                    onClick={() => setter(!val)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 12 }}>
              <div className="field__label">{t('edgLengthsLabel')}</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(
                  [
                    ['short', lengthShort, setLengthShort],
                    ['medium', lengthMedium, setLengthMedium],
                    ['long', lengthLong, setLengthLong],
                  ] as const
                ).map(([label, val, setter]) => (
                  <button
                    key={label}
                    type="button"
                    className={`btn btn--xs${val ? ' btn--search' : ''}`}
                    onClick={() => setter(!val)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <label className="field" style={{ marginTop: 12 }}>
              <span className="field__label">
                {t('edgMultiHopThresholdLabel')} ({multiHopThreshold.toFixed(2)})
              </span>
              <input
                type="range"
                className="field__input"
                min={0}
                max={0.6}
                step={0.01}
                value={multiHopThreshold}
                onChange={(e) =>
                  setMultiHopThreshold(Math.max(0, Math.min(0.6, Number(e.target.value))))
                }
              />
            </label>
          </>
        )}
      </div>

      {/* Phase 4: difficulty / hard negative / schema --------------- */}
      <div className="section" data-guide-target="edg-evol-hardneg">
        <h4 className="section__title"><i className="bi bi-bar-chart-steps icon--mr6" />{t('edgPhase4Title')}</h4>
        <div className="edgScienceInfo">
          <div className="edgScienceInfo__header">
            <i className="bi bi-mortarboard-fill"></i>
            <span>{t('edgSciInfoPhase5Title')}</span>
          </div>
          <div className="edgScienceInfo__body">{t('edgSciInfoPhase5Body')}</div>
          <div className="edgScienceInfo__refs">{t('edgSciInfoPhase5Refs')}</div>
        </div>
        <div className="formGrid">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">
              <input
                type="checkbox"
                checked={enableDifficultyEvolution}
                onChange={(e) => setEnableDifficultyEvolution(e.target.checked)}
              />{' '}
              {t('edgDifficultyEnableLabel')}
            </span>
            <div className="field__hint">{t('edgDifficultyHint')}</div>
          </label>

          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">
              <input
                type="checkbox"
                checked={enableHardNegativeMining}
                onChange={(e) => setEnableHardNegativeMining(e.target.checked)}
              />{' '}
              {t('edgHardnegEnableLabel')}
            </span>
            <div className="field__hint">{t('edgHardnegHint')}</div>
          </label>
          <label className="field">
            <span className="field__label">{t('edgHardnegTopKLabel')}</span>
            <input
              type="number"
              className="field__input"
              min={1}
              max={50}
              disabled={!enableHardNegativeMining}
              value={hardNegativeTopK}
              onChange={(e) =>
                setHardNegativeTopK(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
              }
            />
          </label>
        </div>

        <div style={{ marginTop: 12 }} data-guide-target="edg-domain-schema">
          <div className="field__label">{t('edgSchemaTitle')}</div>
          <div className="field__hint" style={{ marginBottom: 6 }}>{t('edgSchemaHint')}</div>
          <details style={{ marginBottom: 8 }}>
            <summary className="field__hint" style={{ cursor: 'pointer', userSelect: 'none' }}>
              <i className="bi bi-lightbulb icon--mr6" />{t('edgSchemaExampleTitle')}
            </summary>
            <div className="field__hint" style={{ marginTop: 4, paddingLeft: 8 }}>
              <TipsBlock text={String(t('edgSchemaExampleBody'))} />
            </div>
          </details>
          <div className="formGrid">
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span className="field__label">{t('edgSchemaEntities')}</span>
              <textarea
                className="field__input"
                rows={2}
                value={schemaEntities}
                onChange={(e) => setSchemaEntities(e.target.value)}
              />
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span className="field__label">{t('edgSchemaRelations')}</span>
              <textarea
                className="field__input"
                rows={2}
                value={schemaRelations}
                onChange={(e) => setSchemaRelations(e.target.value)}
              />
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span className="field__label">{t('edgSchemaConstraints')}</span>
              <textarea
                className="field__input"
                rows={2}
                value={schemaConstraints}
                onChange={(e) => setSchemaConstraints(e.target.value)}
              />
            </label>
          </div>
        </div>
      </div>

      {/* Phase 6: NDCG/XDCG-compatible relevance grades + entity-KG -- */}
      <div className="section" data-guide-target="edg-relevance-entity">
        <h4 className="section__title"><i className="bi bi-graph-up icon--mr6" />{t('edgPhase6Title')}</h4>
        <div className="edgScienceInfo">
          <div className="edgScienceInfo__header">
            <i className="bi bi-mortarboard-fill"></i>
            <span>{t('edgSciInfoPhase6Title')}</span>
          </div>
          <div className="edgScienceInfo__body">{t('edgSciInfoPhase6Body')}</div>
          <div className="edgScienceInfo__refs">{t('edgSciInfoPhase6Refs')}</div>
        </div>
        <div className="formGrid">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">
              <input
                type="checkbox"
                checked={enableRelevanceGrades}
                onChange={(e) => setEnableRelevanceGrades(e.target.checked)}
              />{' '}
              {t('edgRelevanceGradesEnableLabel')}
            </span>
            <div className="field__hint">{t('edgRelevanceGradesHint')}</div>
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">
              <input
                type="checkbox"
                checked={enableEntityKG}
                disabled={!enableRagasMode}
                onChange={(e) => setEnableEntityKG(e.target.checked)}
              />{' '}
              {t('edgEntityKGEnableLabel')}
            </span>
            <div className="field__hint">{t('edgEntityKGHint')}</div>
          </label>
        </div>
      </div>

      {/* Phase 7: Judge LLM / Style Evolution / Trace --------------- */}
      <div className="section" data-guide-target="edg-phase7">
        <h4 className="section__title"><i className="bi bi-clipboard-check icon--mr6" />{t('edgPhase7Title')}</h4>

        {/* 7a: Judge LLM ------------------------------------------- */}
        <div className="formGrid">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">{t('edgJudgeLlmTitle')}</span>
            <input
              className="field__input"
              value={judgeLlmDeployment}
              onChange={(e) => setJudgeLlmDeployment(e.target.value)}
              placeholder={t('edgJudgeLlmDeploymentPlaceholder')}
            />
            <div className="field__hint">{t('edgJudgeLlmHint')}</div>
          </label>
          {judgeLlmDeployment.trim() &&
            judgeLlmDeployment.trim() === llmDeployment.trim() && (
              <div className="notice notice--warning" style={{ gridColumn: '1 / -1' }} role="status" aria-live="polite">{t('edgJudgeSameModelWarning')}</div>
            )}
        </div>

        {/* 7b: Style Evolution (SNS mode) -------------------------- */}
        <div className="formGrid" style={{ marginTop: 12 }}>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label edgCheckboxLabel">
              <input
                type="checkbox"
                checked={enableStyleEvolution}
                onChange={(e) => setEnableStyleEvolution(e.target.checked)}
              />{' '}
              {t('edgStyleEvolEnableLabel')}
            </span>
            <div className="field__hint">{t('edgStyleEvolHint')}</div>
          </label>
          {enableStyleEvolution && (
            <div className="edgCheckboxGroup" style={{ gridColumn: '1 / -1' }}>
              <label className="edgCheckboxLabel"><input type="checkbox" checked={seKeyword} onChange={(e) => setSeKeyword(e.target.checked)} /> {t('edgSeKeyword')}</label>
              <label className="edgCheckboxLabel"><input type="checkbox" checked={seColloquial} onChange={(e) => setSeColloquial(e.target.checked)} /> {t('edgSeColloquial')}</label>
              <label className="edgCheckboxLabel"><input type="checkbox" checked={seTypo} onChange={(e) => setSeTypo(e.target.checked)} /> {t('edgSeTypo')}</label>
              <label className="edgCheckboxLabel"><input type="checkbox" checked={seAbbreviated} onChange={(e) => setSeAbbreviated(e.target.checked)} /> {t('edgSeAbbreviated')}</label>
              <label className="edgCheckboxLabel"><input type="checkbox" checked={seCodeSwitch} onChange={(e) => setSeCodeSwitch(e.target.checked)} /> {t('edgSeCodeSwitch')}</label>
            </div>
          )}
        </div>

        {/* 7c: Query Transformation Trace -------------------------- */}
        <div className="formGrid" style={{ marginTop: 12 }}>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label edgCheckboxLabel">
              <input
                type="checkbox"
                checked={enableTrace}
                onChange={(e) => setEnableTrace(e.target.checked)}
              />{' '}
              {t('edgTraceEnableLabel')}
            </span>
            <div className="field__hint">{t('edgTraceHint')}</div>
          </label>
        </div>
      </div>

      {/* RAFT — Fine-Tuning Dataset Generation ---------------------- */}
      <div className="section" data-guide-target="edg-raft">
        <h4 className="section__title"><i className="bi bi-layers-fill icon--mr6" />{t('edgRaftTitle')}</h4>
        <div className="formGrid">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label edgCheckboxLabel">
              <input
                type="checkbox"
                checked={enableRaftMode}
                onChange={(e) => setEnableRaftMode(e.target.checked)}
              />{' '}
              {t('edgRaftEnableLabel')}
            </span>
            <div className="field__hint">{t('edgRaftEnableHint')}</div>
          </label>
          {enableRaftMode && (
            <>
              <div style={{ gridColumn: '1 / -1' }}>
                <div className="edgScienceInfo">
                  <div className="edgScienceInfo__header">
                    <i className="bi bi-mortarboard-fill"></i>
                    <span>{t('edgSciInfoRaftTitle')}</span>
                  </div>
                  <div className="edgScienceInfo__body">{t('edgSciInfoRaftBody')}</div>
                  <div className="edgScienceInfo__refs">{t('edgSciInfoRaftRefs')}</div>
                </div>
              </div>
              <label className="field">
                <span className="field__label">{t('edgRaftDistractorCountLabel')}</span>
                <input
                  className="field__input"
                  type="number"
                  min={1}
                  max={10}
                  value={raftDistractorCount}
                  onChange={(e) => setRaftDistractorCount(Math.max(1, Math.min(10, Number(e.target.value))))}
                />
                <div className="field__hint">{t('edgRaftDistractorCountHint')}</div>
              </label>
            </>
          )}
        </div>
      </div>

      {/* Phase 3: persistence (Save / Load / Send to AutoTuning) ---- */}
      <div className="section">
        <h4 className="section__title"><i className="bi bi-save icon--mr6" />{t('edgPersistTitle')}</h4>
        <div className="formGrid">
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">{t('edgPersistTitleField')}</span>
            <input
              className="field__input"
              value={persistTitle}
              onChange={(e) => setPersistTitle(e.target.value)}
              placeholder={String(t('edgPersistTitlePlaceholder'))}
            />
          </label>
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">{t('edgPersistSelectLabel')}</span>
            {persistList.length === 0 ? (
              <div className="app__hint">{t('edgPersistEmpty')}</div>
            ) : (
              <select
                className="field__input"
                value={selectedPersistId}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  setSelectedPersistId(e.target.value)
                }
              >
                <option value="">--</option>
                {persistList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title} ({p.itemCount} items, {new Date(p.updatedAt).toLocaleString()})
                  </option>
                ))}
              </select>
            )}
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={onSavePersist}
            disabled={items.length === 0}
            data-guide-target="edg-persist-save"
          >
            <i className="bi bi-save icon--mr6"></i>
            {t('edgPersistSaveBtn')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onLoadPersist}
            disabled={!selectedPersistId}
          >
            <i className="bi bi-folder2-open icon--mr6"></i>
            {t('edgPersistLoadBtn')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onDeletePersist}
            disabled={!selectedPersistId}
          >
            <i className="bi bi-trash icon--mr6"></i>
            {t('edgPersistDeleteBtn')}
          </button>
          <button
            type="button"
            className="btn btn--search"
            onClick={onSendToAutoTuning}
            disabled={items.length === 0}
            data-guide-target="edg-send-autotuning"
          >
            <i className="bi bi-send icon--mr6"></i>
            {t('edgPersistSendBtn')}
          </button>
          {persistToast && (
            <span style={{ fontSize: 12, color: 'var(--accent)' }}>{persistToast}</span>
          )}
        </div>
      </div>

      {/* Actions ----------------------------------------------------- */}
      <div className="section">
        <div className="formActions" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn--search"
            onClick={() => void onGenerate()}
            disabled={!canRun}
            data-guide-target="edg-generate"
          >
            <i className="bi bi-stars icon--mr6"></i>
            {t('edgGenerate')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={cancel}
            disabled={!isRunning}
          >
            {t('edgCancel')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={reset}
            disabled={isRunning || items.length === 0}
          >
            {t('edgReset')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={onExport}
            disabled={items.length === 0}
          >
            <i className="bi bi-download icon--mr6"></i>
            {t('edgExportJsonl')}
          </button>
          {enableRaftMode && progress.phase === 'done' && items.some((it) => it.raft_cot_answer) && (
            <button
              type="button"
              className="btn"
              onClick={onExportRaft}
            >
              <i className="bi bi-download icon--mr6"></i>
              {t('edgRaftExportBtn')}
            </button>
          )}

          <div
            style={{
              gridColumn: '1 / -1',
              display: (isRunning || progress.phase === 'done') && progress.phaseTotal > 0 ? 'flex' : 'none',
              gap: 12,
              alignItems: 'center',
            }}
          >
            <div style={{ flex: '0 0 auto' }}>
              <span className="mono mono--ellipsesSm">
                {t('edgProgressOverall').replace('{current}', String(progress.phaseIndex)).replace('{total}', String(progress.phaseTotal))}
              </span>
              <progress value={progress.phaseIndex} max={progress.phaseTotal} style={{ width: '100%', display: 'block', marginTop: 2 }} />
            </div>
            <div style={{ flex: 1, minWidth: 0, visibility: isRunning ? 'visible' : 'hidden' }}>
              <span className="mono mono--ellipsesSm">
                {(() => {
                  switch (progress.phase) {
                    case 'sampling':
                      return t('edgPhaseSampling')
                    case 'generating':
                      return t('edgPhaseGenerating')
                    case 'grounding':
                      return t('edgPhaseGrounding')
                    case 'embedding':
                      return t('edgPhaseEmbedding')
                    case 'difficulty':
                      return t('edgPhaseDifficulty')
                    case 'styleevol':
                      return t('edgPhaseStyleEvol')
                    case 'hardneg':
                      return t('edgPhaseHardneg')
                    case 'raft':
                      return t('edgPhaseRaft')
                    default:
                      return t('edgProgressLabel')
                  }
                })()}
                {progress.total > 0 ? `: ${progress.done} / ${progress.total}` : '…'}
              </span>
              <progress
                value={progress.total > 0 ? progress.done : undefined}
                max={progress.total > 0 ? progress.total : undefined}
                style={{ width: '100%', display: 'block', marginTop: 2 }}
              />
            </div>
          </div>
        </div>
        {validationError && (
          <div className="notice notice--error" role="alert">{validationError}</div>
        )}
        {error && <div className="notice notice--error" role="alert">{error}</div>}
      </div>

      {/* Results ----------------------------------------------------- */}
      <div className="section">
        <div className="section__title">
          {t('edgResultsTitle')} ({(() => {
            const kept = items.filter((i) => !i.rejected).length
            const rej = items.length - kept
            return `${kept} ${t('edgKeptCount')} / ${rej} ${t('edgRejectedCount')}`
          })()})
          <label className="edgResults__showRejected">
            <input
              type="checkbox"
              checked={showRejected}
              onChange={(e) => setShowRejected(e.target.checked)}
            />{' '}
            {t('edgShowRejectedLabel')}
          </label>
        </div>
        {items.length === 0 ? (
          <div className="app__hint">{t('edgEmptyResults')}</div>
        ) : (
          <EdgResultsTable
            t={t}
            items={items}
            showRejected={showRejected}
            docTextById={docTextById}
            enableRagasMode={enableRagasMode}
            enableDifficultyEvolution={enableDifficultyEvolution}
            enableHardNegativeMining={enableHardNegativeMining}
            enableStyleEvolution={enableStyleEvolution}
            enableTrace={enableTrace}
            enableRaftMode={enableRaftMode}
          />
        )}
      </div>

      {/* Tips: theory & technology ---------------------------------- */}
      <div className="section">
        <details>
          <summary className="section__title" style={{ cursor: 'pointer' }}>
            <i className="bi bi-info-circle icon--mr6"></i>
            {t('edgTipsTitle')}
          </summary>
          <div className="edgTips">
            <div className="edgTips__lead">
              <TipsBlock text={String(t('edgTipsLead'))} />
            </div>

            <div className="edgTips__group">
              <div className="edgTips__groupTitle">{t('edgTipsWhatItDoesH')}</div>
              <EdgPipelineFlow t={t} />
            </div>

            <div className="edgTips__group">
              <div className="edgTips__groupTitle">{t('edgTipsTechH')}</div>
              <TipsBlock text={String(t('edgTipsTech'))} />
            </div>

            <div className="edgTips__group">
              <div className="edgTips__groupTitle">{t('edgTipsTheoryH')}</div>
              <TipsBlock text={String(t('edgTipsTheory'))} />
            </div>

            <div className="edgTips__group">
              <div className="edgTips__groupTitle">{t('edgTipsLimitsH')}</div>
              <TipsBlock text={String(t('edgTipsLimits'))} />
            </div>

            <div className="edgTips__group">
              <div className="edgTips__groupTitle">{t('edgTipsRecH')}</div>
              <TipsBlock text={String(t('edgTipsRec'))} />
            </div>
          </div>
        </details>
      </div>
    </div>
  )
}
