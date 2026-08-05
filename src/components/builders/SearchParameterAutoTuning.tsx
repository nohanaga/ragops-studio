/**
 * Search parameter auto-tuning lab.
 *
 * Runs a grid-search style evaluation loop over multiple `SearchFormState`
 * combinations and scores them with IR metrics (precision@k / recall@k / NDCG / MRR).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'

import Dropdown from 'bootstrap/js/dist/dropdown'

import type { JsonValue } from '../../lib/aiSearchRest'
import { getIndexDefinition, searchDocuments } from '../../lib/aiSearchRest'
import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import { addArtifact, createRun, listArtifactsByRun, updateRun } from '../../lib/db'
import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import type { SearchFormState } from '../../types'
import { buildSearchBodyFromForm } from '../../utils/appRequestBodies'
import { JsonViewer } from '../viewers/JsonViewer'
import { useModalState } from '../../contexts'
import {
  getEvalDataset,
  listEvalDatasets,
  type PersistedEvalDatasetItem,
} from '../../app/persistedEvalDatasets'
import { toJsonl } from '../../lib/evalDatasetGenerator'
import { parseRelevanceGrades, scoreIrObjective, type IrObjective } from '../../lib/irMetrics'

type TranslationKey = keyof typeof translations.ja

type Objective = IrObjective

type JsonlRow = Record<string, unknown>

type AutoTuningQueryTrace = {
  /** 1-based row index inside the dataset */
  rowIndex: number
  query: string
  expectedIds: string[]
  returnedIds: string[]
  score: number
  /** HTTP status code from the search API (e.g. 200, 400, 0=network error) */
  httpStatus?: number
  /** Non-empty when the search API returned an error for this row */
  error?: string
  /** Raw API error response text (may contain LLM/vectorizer error details) */
  apiResponseText?: string
  /** Warnings such as empty results, skipped rows, etc. */
  warning?: string
  /** Search request body sent to the API (for debugging) */
  requestBody?: Record<string, unknown>
  /** Number of result items returned by the API */
  resultCount?: number
  /** Full search API response JSON (for debugging score-0 rows) */
  searchResponse?: JsonValue
}

type AutoTuningLogRow = {
  i: number
  indexName: string
  score: number
  evaluatedQueries: number
  params: Partial<SearchFormState>
  isBest: boolean
  /** Per-query traces — populated when enableTrace is true */
  queryTraces?: AutoTuningQueryTrace[]
}

type FieldStats = {
  key: string
  hasString: boolean
  hasStringArray: boolean
  hasRelevanceGrades: boolean
}

type TraceColDef = {
  key: string
  title: string
  width: number
  mono?: boolean
  wrap?: boolean
  render: (qt: AutoTuningQueryTrace) => ReactNode
  titleFn?: (qt: AutoTuningQueryTrace) => string | undefined
}

const TRACE_MIN_COL_WIDTH = 40
const TRACE_MAX_COL_WIDTH = 800

type JsonlParseError =
  | { kind: 'invalidObject'; line: number }
  | { kind: 'parseError'; line: number; message: string }

function safeParseJsonl(text: string): { rows: JsonlRow[]; error: JsonlParseError | null } {
  // Parse JSON Lines into objects.
  // This is strict about "one JSON object per line" to keep dataset authoring predictable.
  const rows: JsonlRow[] = []
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    try {
      const parsed = JSON.parse(line) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { rows: [], error: { kind: 'invalidObject', line: i + 1 } }
      }
      rows.push(parsed as JsonlRow)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { rows: [], error: { kind: 'parseError', line: i + 1, message: msg } }
    }
  }
  return { rows, error: null }
}

function inferFieldStats(rows: JsonlRow[]): FieldStats[] {
  const map = new Map<string, FieldStats>()
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const current = map.get(key) ?? { key, hasString: false, hasStringArray: false, hasRelevanceGrades: false }
      const v = row[key]
      if (typeof v === 'string') current.hasString = true
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) current.hasStringArray = true
      if (parseRelevanceGrades(v)) current.hasRelevanceGrades = true
      map.set(key, current)
    }
  }
  return Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key))
}

function asStringList(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) return value
  return []
}

function parseCsvNumbers(text: string): number[] {
  const nums = text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n))
  return Array.from(new Set(nums))
}

function parseCsvStrings(text: string): string[] {
  const items = text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return Array.from(new Set(items))
}

function formatSelectedListLabel(items: string[], maxItems: number, noneLabel: string): string {
  if (items.length === 0) return noneLabel
  if (items.length <= maxItems) return items.join(', ')
  const head = items.slice(0, maxItems).join(', ')
  return `${head} (+${items.length - maxItems})`
}

function buildRange(min: number, max: number, step: number): number[] {
  // Utility: generate a numeric range with safety guards.
  if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(step)) return []
  if (step <= 0) return []
  if (max < min) return []
  const out: number[] = []
  // Guard against infinite loops.
  const maxItems = 500
  for (let v = min, i = 0; v <= max + 1e-12 && i < maxItems; v += step, i++) {
    const rounded = Math.round(v * 1000000) / 1000000
    out.push(rounded)
  }
  return out
}

function buildQueryTypePatches(tokens: string[]): Array<Partial<SearchFormState>> {
  const out: Array<Partial<SearchFormState>> = []
  for (const raw of tokens) {
    const token = raw.trim()
    if (!token) continue

    // Pure queryType tokens (SearchFormState.queryType)
    if (token === 'simple' || token === 'full' || token === 'semantic') {
      out.push({ queryType: token })
      continue
    }

    // Convenience aliases for request variants
    if (token === 'vector') {
      // Vector-only: vector enabled, search empty
      out.push({ queryType: 'simple', vectorEnabled: true, search: '' })
      continue
    }
    if (token === 'hybrid') {
      // Hybrid: text + vector
      out.push({ queryType: 'simple', vectorEnabled: true })
      continue
    }
    if (token === 'semantic-hybrid' || token === 'semantic_hybrid') {
      out.push({ queryType: 'semantic', vectorEnabled: true })
      continue
    }
  }
  // de-dup by JSON stringification (good enough for this small patch set)
  const uniq = new Map<string, Partial<SearchFormState>>()
  for (const p of out) uniq.set(JSON.stringify(p), p)
  return Array.from(uniq.values())
}

export type SearchParameterAutoTuningProps = {
  t: (key: TranslationKey) => string
  language: Language

  activeProfile: ConnectionProfile | null
  indexName: string
  availableIndexNames: string[]
  isIndexNamesLoading: boolean
  onReloadIndexNames: () => void | Promise<void>
  setIndexName: (indexName: string) => void
  apiVersion: SearchApiVersion
  isPreviewApiVersion: boolean

  indexFieldNames: string[]
  vectorFieldNames: string[]
  defaultIdFieldName: string | null

  searchForm: SearchFormState
  setSearchForm: React.Dispatch<React.SetStateAction<SearchFormState>>
  runNote: string

  selectedExperimentId: string | null
  reloadRuns: (experimentId: string | null) => Promise<void>
  restoreRunId?: string | null
  /** Open the Eval Dataset Generator and switch the center tab to it. */
  onOpenEvalDatasetGenerator?: () => void
}

export function SearchParameterAutoTuning(props: SearchParameterAutoTuningProps) {
  const {
    t,
    language,
    activeProfile,
    indexName,
    availableIndexNames,
    isIndexNamesLoading,
    onReloadIndexNames,
    setIndexName,
    apiVersion,
    isPreviewApiVersion,
    indexFieldNames,
    vectorFieldNames,
    defaultIdFieldName,
    searchForm,
    setSearchForm,
    runNote,

    selectedExperimentId,
    reloadRuns,
    restoreRunId,
    onOpenEvalDatasetGenerator,
  } = props

  const format = useCallback((key: TranslationKey, params: Record<string, string | number>): string => {
    let text = String(t(key) ?? '')
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
    return text
  }, [t])

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const stopRef = useRef(false)

  const hideClosestBootstrapDropdown = (fromEl: HTMLElement | null) => {
    if (!fromEl) return
    const dropdownRoot = fromEl.closest('.dropdown')
    if (!dropdownRoot) return
    const toggle = dropdownRoot.querySelector('[data-bs-toggle="dropdown"]') as HTMLElement | null
    if (!toggle) return
    Dropdown.getOrCreateInstance(toggle).hide()
  }

  const [datasetFileName, setDatasetFileName] = useState<string>('')
  const [rows, setRows] = useState<JsonlRow[]>([])
  const [datasetError, setDatasetError] = useState<string | null>(null)
  const [restoredRowsCount, setRestoredRowsCount] = useState<number | null>(null)

  const { setIsEvalDatasetGeneratorOpen, pendingAutoTuningJsonl, setPendingAutoTuningJsonl } = useModalState()
  const [savedDatasetList, setSavedDatasetList] = useState<PersistedEvalDatasetItem[]>(() => listEvalDatasets())
  const [selectedSavedDatasetId, setSelectedSavedDatasetId] = useState<string>('')

  const fieldStats = useMemo(() => inferFieldStats(rows), [rows])
  const stringFields = useMemo(() => fieldStats.filter((s) => s.hasString).map((s) => s.key), [fieldStats])
  const answerFields = useMemo(
    () => fieldStats.filter((s) => s.hasStringArray || s.hasString).map((s) => s.key),
    [fieldStats],
  )
  const relevanceGradesFields = useMemo(
    () => fieldStats.filter((s) => s.hasRelevanceGrades).map((s) => s.key),
    [fieldStats],
  )

  const [queryField, setQueryField] = useState<string>('')
  const [answerField, setAnswerField] = useState<string>('')
  const [relevanceGradesField, setRelevanceGradesField] = useState<string>('')
  const [resultIdField, setResultIdField] = useState<string>('')

  const [objective, setObjective] = useState<Objective>('recall@k')
  const [evalK, setEvalK] = useState<number>(10)

  // HyDE evaluation settings (Phase A: dataset-only)
  const [enableHydeEval, setEnableHydeEval] = useState(false)
  const [hydeField, setHydeField] = useState<string>('hyde_hypothesis')
  const [hydeApplyTo, setHydeApplyTo] = useState<'vectorTextOnly' | 'replaceQueryAndVectorText'>('vectorTextOnly')

  const [optIndexName, setOptIndexName] = useState(true)
  const [indexNameValuesCsv, setIndexNameValuesCsv] = useState<string>(() => indexName.trim())
  const indexDropdownToggleRef = useRef<HTMLButtonElement | null>(null)
  const indexFilterInputRef = useRef<HTMLInputElement | null>(null)
  const [indexFilterText, setIndexFilterText] = useState('')

  const [optVectorWeight, setOptVectorWeight] = useState(false)
  const [vectorWeightMin, setVectorWeightMin] = useState<number>(0.1)
  const [vectorWeightMax, setVectorWeightMax] = useState<number>(1.0)
  const [vectorWeightStep, setVectorWeightStep] = useState<number>(0.1)

  const [optVectorK, setOptVectorK] = useState(false)
  const [vectorKValuesCsv, setVectorKValuesCsv] = useState<string>('10,20,50,100')

  const [optHybridMaxTextRecallSize, setOptHybridMaxTextRecallSize] = useState(false)
  const [hybridMaxTextRecallSizeValuesCsv, setHybridMaxTextRecallSizeValuesCsv] = useState<string>('50,100,500,1000')

  const [optQueryType, setOptQueryType] = useState(true)
  const [queryTypeValuesCsv, setQueryTypeValuesCsv] = useState<string>('simple')

  // queryType dropdown (debug-style)
  const QUERY_TYPE_OPTIONS = useMemo(
    () => ['simple', 'full', 'semantic', 'hybrid', 'vector', 'semantic-hybrid'] as const,
    [],
  )
  const queryTypeDropdownToggleRef = useRef<HTMLButtonElement | null>(null)
  const queryTypeFilterInputRef = useRef<HTMLInputElement | null>(null)
  const [queryTypeFilterText, setQueryTypeFilterText] = useState('')

  const toggleCsvSelectionOrdered = (csv: string, value: string, orderedUniverse: readonly string[]): string => {
    const selected = new Set(parseCsvStrings(csv))
    if (selected.has(value)) {
      selected.delete(value)
    } else {
      selected.add(value)
    }
    return orderedUniverse.filter((v) => selected.has(v)).join(',')
  }

  const indexNameOptions = useMemo(() => {
    const opts = new Set<string>()
    for (const n of availableIndexNames) {
      const v = String(n ?? '').trim()
      if (v) opts.add(v)
    }
    if (indexName.trim()) opts.add(indexName.trim())
    return Array.from(opts).sort((a, b) => a.localeCompare(b))
  }, [availableIndexNames, indexName])

  const filteredIndexNameOptions = useMemo(() => {
    const q = indexFilterText.trim().toLowerCase()
    if (!q) return indexNameOptions
    return indexNameOptions.filter((n) => n.toLowerCase().includes(q))
  }, [indexNameOptions, indexFilterText])

  useEffect(() => {
    if (!indexNameValuesCsv.trim() && indexName.trim()) {
      setIndexNameValuesCsv(indexName.trim())
    }
  }, [indexName, indexNameValuesCsv])

  type Combination = {
    indexName: string
    patch: Partial<SearchFormState>
  }

  const [optVectorThresholdKind, setOptVectorThresholdKind] = useState(false)
  const [thresholdKindIncludeUnset, setThresholdKindIncludeUnset] = useState(true)
  const [thresholdKindIncludeVectorSimilarity, setThresholdKindIncludeVectorSimilarity] = useState(true)
  const [thresholdKindIncludeSearchScore, setThresholdKindIncludeSearchScore] = useState(true)

  const [optVectorThresholdValue, setOptVectorThresholdValue] = useState(false)
  const [vectorThresholdValueMin, setVectorThresholdValueMin] = useState<number>(0.5)
  const [vectorThresholdValueMax, setVectorThresholdValueMax] = useState<number>(0.9)
  const [vectorThresholdValueStep, setVectorThresholdValueStep] = useState<number>(0.05)

  const [isRunning, setIsRunning] = useState(false)
  const [enableTrace, setEnableTrace] = useState(true)
  const [expandedLogRow, setExpandedLogRow] = useState<number | null>(null)
  const [traceColWidths, setTraceColWidths] = useState<Record<string, number>>({})
  const traceDragState = useRef<{ key: string; startX: number; startWidth: number } | null>(null)
  const [traceActiveResizer, setTraceActiveResizer] = useState<string | null>(null)
  const traceTableRef = useRef<HTMLTableElement>(null)
  const [traceDetailModal, setTraceDetailModal] = useState<AutoTuningQueryTrace | null>(null)
  const [progressText, setProgressText] = useState<string>('')
  const [progressCurrent, setProgressCurrent] = useState<number>(0)
  const [progressTotal, setProgressTotal] = useState<number>(0)
  const [childProgressCurrent, setChildProgressCurrent] = useState<number>(0)
  const [childProgressTotal, setChildProgressTotal] = useState<number>(0)
  const [runError, setRunError] = useState<string | null>(null)

  type AutoTuningArtifactV1 = {
    kind: 'auto_tuning'
    version: 1
    savedAt: string
    endpoint?: string
    apiVersion?: string
    indexName?: string
    datasetFileName?: string
    datasetRowsCount?: number
    queryField?: string
    answerField?: string
    relevanceGradesField?: string
    resultIdField?: string
    objective?: Objective
    k?: number
    options?: {
      optIndexName: boolean
      indexNameValuesCsv: string
      optVectorWeight: boolean
      vectorWeightMin: number
      vectorWeightMax: number
      vectorWeightStep: number
      optVectorK: boolean
      vectorKValuesCsv: string
      optHybridMaxTextRecallSize: boolean
      hybridMaxTextRecallSizeValuesCsv: string
      optQueryType: boolean
      queryTypeValuesCsv: string
      optVectorThresholdKind: boolean
      thresholdKindIncludeUnset: boolean
      thresholdKindIncludeVectorSimilarity: boolean
      thresholdKindIncludeSearchScore: boolean
      optVectorThresholdValue: boolean
      vectorThresholdValueMin: number
      vectorThresholdValueMax: number
      vectorThresholdValueStep: number
      // HyDE
      enableHydeEval?: boolean
      hydeField?: string
      hydeApplyTo?: 'vectorTextOnly' | 'replaceQueryAndVectorText'
      // Trace
      enableTrace?: boolean
    }
    bestResult?: {
      indexName: string
      params: Partial<SearchFormState>
      score: number
      objective: Objective
      k: number
    } | null
    logRows?: AutoTuningLogRow[]
    stopped?: boolean
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (!restoreRunId) return

        const artifacts = await listArtifactsByRun(restoreRunId)
        const note = artifacts.find((a) => a.type === 'note')
        if (!note) {
          if (!cancelled) setRunError(t('noArtifacts'))
          return
        }

        const parsed = JSON.parse(note.content) as Partial<AutoTuningArtifactV1>
        if (parsed.kind !== 'auto_tuning' || parsed.version !== 1) return

        if (cancelled) return

        setDatasetError(null)
        setRunError(null)

        setDatasetFileName(typeof parsed.datasetFileName === 'string' ? parsed.datasetFileName : '')
        setRestoredRowsCount(typeof parsed.datasetRowsCount === 'number' ? parsed.datasetRowsCount : null)
        setRows([])

        if (typeof parsed.queryField === 'string') setQueryField(parsed.queryField)
        if (typeof parsed.answerField === 'string') setAnswerField(parsed.answerField)
        if (typeof parsed.relevanceGradesField === 'string') setRelevanceGradesField(parsed.relevanceGradesField)
        if (typeof parsed.resultIdField === 'string') setResultIdField(parsed.resultIdField)
        if (parsed.objective === 'precision@k' || parsed.objective === 'recall@k' || parsed.objective === 'ndcg' || parsed.objective === 'mrr') {
          setObjective(parsed.objective)
        }
        if (typeof parsed.k === 'number' && Number.isFinite(parsed.k) && parsed.k > 0) setEvalK(parsed.k)

        const opt = parsed.options
        if (opt && typeof opt === 'object') {
          setOptIndexName(Boolean(opt.optIndexName))
          if (typeof opt.indexNameValuesCsv === 'string') setIndexNameValuesCsv(opt.indexNameValuesCsv)
          setOptVectorWeight(Boolean(opt.optVectorWeight))
          if (typeof opt.vectorWeightMin === 'number') setVectorWeightMin(opt.vectorWeightMin)
          if (typeof opt.vectorWeightMax === 'number') setVectorWeightMax(opt.vectorWeightMax)
          if (typeof opt.vectorWeightStep === 'number') setVectorWeightStep(opt.vectorWeightStep)
          setOptVectorK(Boolean(opt.optVectorK))
          if (typeof opt.vectorKValuesCsv === 'string') setVectorKValuesCsv(opt.vectorKValuesCsv)
          setOptHybridMaxTextRecallSize(Boolean(opt.optHybridMaxTextRecallSize))
          if (typeof opt.hybridMaxTextRecallSizeValuesCsv === 'string') setHybridMaxTextRecallSizeValuesCsv(opt.hybridMaxTextRecallSizeValuesCsv)
          setOptQueryType(Boolean(opt.optQueryType))
          if (typeof opt.queryTypeValuesCsv === 'string') setQueryTypeValuesCsv(opt.queryTypeValuesCsv)
          setOptVectorThresholdKind(Boolean(opt.optVectorThresholdKind))
          setThresholdKindIncludeUnset(Boolean(opt.thresholdKindIncludeUnset))
          setThresholdKindIncludeVectorSimilarity(Boolean(opt.thresholdKindIncludeVectorSimilarity))
          setThresholdKindIncludeSearchScore(Boolean(opt.thresholdKindIncludeSearchScore))
          setOptVectorThresholdValue(Boolean(opt.optVectorThresholdValue))
          if (typeof opt.vectorThresholdValueMin === 'number') setVectorThresholdValueMin(opt.vectorThresholdValueMin)
          if (typeof opt.vectorThresholdValueMax === 'number') setVectorThresholdValueMax(opt.vectorThresholdValueMax)
          if (typeof opt.vectorThresholdValueStep === 'number') setVectorThresholdValueStep(opt.vectorThresholdValueStep)
          // HyDE
          if (typeof opt.enableHydeEval === 'boolean') setEnableHydeEval(opt.enableHydeEval)
          if (typeof opt.hydeField === 'string') setHydeField(opt.hydeField)
          if (opt.hydeApplyTo === 'vectorTextOnly' || opt.hydeApplyTo === 'replaceQueryAndVectorText') setHydeApplyTo(opt.hydeApplyTo)
          // Trace
          if (typeof opt.enableTrace === 'boolean') setEnableTrace(opt.enableTrace)
        }

        const restoredBest = parsed.bestResult
        if (restoredBest && typeof restoredBest === 'object') {
          if (typeof restoredBest.indexName === 'string' && typeof restoredBest.score === 'number' && restoredBest.params && typeof restoredBest.params === 'object') {
            setBestResult({
              indexName: restoredBest.indexName,
              params: restoredBest.params as Partial<SearchFormState>,
              score: restoredBest.score,
              objective: (restoredBest.objective ?? objective) as Objective,
              k: (typeof restoredBest.k === 'number' ? restoredBest.k : evalK),
            })
          }
        } else {
          setBestResult(null)
        }

        if (Array.isArray(parsed.logRows)) {
          setLogRows(
            parsed.logRows
              .filter((r) => r && typeof r === 'object')
              .map((r) => {
                const rr = r as Record<string, unknown>
                return {
                  i: typeof rr.i === 'number' ? rr.i : 0,
                  indexName: typeof rr.indexName === 'string' ? rr.indexName : '',
                  score: typeof rr.score === 'number' ? rr.score : 0,
                  evaluatedQueries: typeof rr.evaluatedQueries === 'number' ? rr.evaluatedQueries : 0,
                  params: (rr.params && typeof rr.params === 'object') ? (rr.params as Partial<SearchFormState>) : {},
                  isBest: Boolean(rr.isBest),
                  queryTraces: Array.isArray(rr.queryTraces) ? (rr.queryTraces as AutoTuningQueryTrace[]) : undefined,
                }
              }),
          )
        } else {
          setLogRows([])
        }
      } catch {
        // ignore restore failures
      }
    })()

    return () => {
      cancelled = true
    }
  }, [evalK, objective, restoreRunId, t])

  const [logRows, setLogRows] = useState<AutoTuningLogRow[]>([])

  const [bestResult, setBestResult] = useState<
    | {
        indexName: string
        params: Partial<SearchFormState>
        score: number
        objective: Objective
        k: number
      }
    | null
  >(null)

  const selectedIndexNames = useMemo(() => {
    const names = optIndexName ? parseCsvStrings(indexNameValuesCsv) : [indexName.trim()]
    return names.map((s) => s.trim()).filter((s) => s.length > 0)
  }, [indexName, indexNameValuesCsv, optIndexName])

  const extractFieldNamesFromIndexSchema = (schema: JsonValue): string[] => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return []
    const fields = (schema as { fields?: unknown }).fields
    if (!Array.isArray(fields)) return []
    return fields
      .filter((f): f is { name?: unknown } => !!f && typeof f === 'object' && !Array.isArray(f))
      .map((f) => (typeof f.name === 'string' ? f.name.trim() : ''))
      .filter((n) => n.length > 0)
  }

  const [scoringFieldOptions, setScoringFieldOptions] = useState<string[]>(indexFieldNames)
  const [scoringFieldHint, setScoringFieldHint] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const run = async () => {
      setScoringFieldHint(null)

      // If index optimization is off, just use the current Request Builder index field list.
      if (!optIndexName) {
        setScoringFieldOptions(indexFieldNames)
        return
      }

      // If optimizing indexes, build options from the checked indexes.
      if (!activeProfile || !apiVersion.trim()) {
        setScoringFieldOptions(indexFieldNames)
        return
      }

      if (selectedIndexNames.length === 0) {
        setScoringFieldOptions([])
        setScoringFieldHint(t('atHintSelectIndexFirst'))
        return
      }

      const results = await Promise.all(
        selectedIndexNames.map(async (idx) => {
          try {
            const res = await getIndexDefinition({ profile: activeProfile, indexName: idx, apiVersion, language })
            if (!res.ok) return { idx, fields: [] as string[] }
            return { idx, fields: extractFieldNamesFromIndexSchema(res.response) }
          } catch {
            return { idx, fields: [] as string[] }
          }
        }),
      )

      if (cancelled) return

      const fieldLists = results.map((r) => r.fields)
      if (fieldLists.length === 0) {
        setScoringFieldOptions([])
        return
      }

      // Use intersection across selected indexes to ensure the chosen docId field works for all.
      const common = fieldLists.reduce<string[]>((acc, cur) => {
        if (acc.length === 0) return cur
        const set = new Set(cur)
        return acc.filter((f) => set.has(f))
      }, fieldLists[0] ?? [])

      const uniqSorted = Array.from(new Set(common)).sort((a, b) => a.localeCompare(b))
      setScoringFieldOptions(uniqSorted)
      if (uniqSorted.length === 0) {
        setScoringFieldHint(t('atHintNoCommonFieldsAcrossIndexes'))
      }
    }

    void run()
    return () => {
      cancelled = true
    }
  }, [activeProfile, apiVersion, indexFieldNames, language, optIndexName, selectedIndexNames, t])

  const effectiveDefaultIdField = useMemo(() => {
    const names = scoringFieldOptions
    if (defaultIdFieldName && names.includes(defaultIdFieldName)) return defaultIdFieldName

    // Prefer common id-like field names (case-insensitive)
    const lowerToActual = new Map<string, string>()
    for (const n of names) lowerToActual.set(n.toLowerCase(), n)
    const pick = (...candidatesLower: string[]): string => {
      for (const c of candidatesLower) {
        const hit = lowerToActual.get(c)
        if (hit) return hit
      }
      return ''
    }

    return (
      pick('docid', 'documentid', '_id', 'id', 'key') ||
      names[0] ||
      ''
    )
  }, [defaultIdFieldName, scoringFieldOptions])

  useEffect(() => {
    if (scoringFieldOptions.length === 0) return
    if (!resultIdField || !scoringFieldOptions.includes(resultIdField)) {
      if (effectiveDefaultIdField) setResultIdField(effectiveDefaultIdField)
    }
  }, [effectiveDefaultIdField, resultIdField, scoringFieldOptions])

  const canRun = useMemo(() => {
    const hasIndex = !!indexName.trim() || (optIndexName && parseCsvStrings(indexNameValuesCsv).length > 0)
    return !!activeProfile && hasIndex && !!apiVersion.trim() && rows.length > 0
  }, [activeProfile, apiVersion, indexName, indexNameValuesCsv, optIndexName, rows.length])

  async function onUploadDataset(file: File) {
    const text = await file.text()
    loadDatasetFromText(text, file.name)
  }

  function loadDatasetFromText(text: string, fileName: string) {
    setDatasetError(null)
    setRunError(null)
    setBestResult(null)
    setRows([])
    setRestoredRowsCount(null)
    setDatasetFileName(fileName)

    const parsed = safeParseJsonl(text)
    if (parsed.error) {
      if (parsed.error.kind === 'invalidObject') {
        setDatasetError(format('atJsonlInvalidObjectLine', { line: parsed.error.line }))
      } else {
        setDatasetError(format('atJsonlParseErrorLine', { line: parsed.error.line, message: parsed.error.message }))
      }
      return
    }

    setRows(parsed.rows)
    setLogRows([])

    // Set defaults based on common conventions.
    const keys = inferFieldStats(parsed.rows)
    const stringKeys = keys.filter((s) => s.hasString).map((s) => s.key)
    const answerKeys = keys.filter((s) => s.hasStringArray || s.hasString).map((s) => s.key)
    const relevanceGradeKeys = keys.filter((s) => s.hasRelevanceGrades).map((s) => s.key)

    const q = (parsed.rows[0]?.query && typeof parsed.rows[0].query === 'string') ? 'query' : (stringKeys[0] ?? '')
    // Prefer expected_ids (common eval convention), then positive_passages, then first available
    const a =
      answerKeys.includes('expected_ids')
        ? 'expected_ids'
        : (parsed.rows[0]?.positive_passages && Array.isArray(parsed.rows[0].positive_passages))
          ? 'positive_passages'
          : (answerKeys[0] ?? '')

    setQueryField(q)
    setAnswerField(a)
    setRelevanceGradesField(
      relevanceGradeKeys.includes('relevance_grades') ? 'relevance_grades' : (relevanceGradeKeys[0] ?? ''),
    )
    setResultIdField((prev) => prev || effectiveDefaultIdField)
  }

  // Consume pending JSONL handed off from the Eval Dataset Generator.
  useEffect(() => {
    if (!pendingAutoTuningJsonl) return
    loadDatasetFromText(pendingAutoTuningJsonl.text, pendingAutoTuningJsonl.fileName)
    setPendingAutoTuningJsonl(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoTuningJsonl])

  function onLoadSavedDataset(id: string) {
    setSelectedSavedDatasetId(id)
    if (!id) return
    const got = getEvalDataset(id)
    if (!got) return
    const text = toJsonl(got.items)
    const fname = `${got.title.replace(/[^a-z0-9_-]/gi, '_') || 'eval-dataset'}.jsonl`
    loadDatasetFromText(text, fname)
  }

  function refreshSavedDatasetList() {
    setSavedDatasetList(listEvalDatasets())
  }

  function buildCombinations(): Combination[] {
    const baseIndex = indexName.trim()
    let combos: Combination[] = [{ indexName: baseIndex, patch: {} }]

    const expandIndexName = (values: string[]): void => {
      combos = combos.flatMap((c) => values.map((v) => ({ ...c, indexName: v })))
    }
    const expandPatchValue = (key: keyof SearchFormState, values: unknown[]): void => {
      combos = combos.flatMap((c) => values.map((v) => ({ ...c, patch: { ...c.patch, [key]: v } as Partial<SearchFormState> })))
    }
    const expandPatch = (patches: Array<Partial<SearchFormState>>): void => {
      combos = combos.flatMap((c) => patches.map((p) => ({ ...c, patch: { ...c.patch, ...p } })))
    }

    if (optIndexName) {
      const idxs = parseCsvStrings(indexNameValuesCsv)
      expandIndexName(idxs)
    }
    if (optVectorWeight) {
      expandPatchValue('vectorWeight', buildRange(vectorWeightMin, vectorWeightMax, vectorWeightStep))
    }
    if (optVectorK) {
      expandPatchValue('vectorK', parseCsvNumbers(vectorKValuesCsv))
    }
    if (optHybridMaxTextRecallSize) {
      expandPatchValue('hybridMaxTextRecallSize', parseCsvNumbers(hybridMaxTextRecallSizeValuesCsv))
    }
    if (optQueryType) {
      expandPatch(buildQueryTypePatches(parseCsvStrings(queryTypeValuesCsv)))
    }
    if (optVectorThresholdKind) {
      const kinds: Array<'' | 'vectorSimilarity' | 'searchScore'> = []
      if (thresholdKindIncludeUnset) kinds.push('')
      if (thresholdKindIncludeVectorSimilarity) kinds.push('vectorSimilarity')
      if (thresholdKindIncludeSearchScore) kinds.push('searchScore')
      expandPatchValue('vectorThresholdKind', kinds)
    }
    if (optVectorThresholdValue) {
      expandPatchValue('vectorThresholdValue', buildRange(vectorThresholdValueMin, vectorThresholdValueMax, vectorThresholdValueStep))
    }

    return combos
  }

  const extractVectorFieldNamesFromIndexSchema = (schema: JsonValue): string[] => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return []
    const fields = (schema as { fields?: unknown }).fields
    if (!Array.isArray(fields)) return []
    return fields
      .filter((f): f is { name?: unknown; type?: unknown } => !!f && typeof f === 'object' && !Array.isArray(f))
      .map((f) => ({ name: typeof f.name === 'string' ? f.name : '', type: typeof f.type === 'string' ? f.type : '' }))
      .filter((f) => {
        if (!f.name.trim()) return false
        const type = f.type
        const typeLower = type.toLowerCase()
        return (
          type.startsWith('Collection(Edm.Single)') ||
          type.startsWith('Collection(Edm.Half)') ||
          typeLower.includes('vector')
        )
      })
      .map((f) => f.name.trim())
  }

  async function runOptimization() {
    setRunError(null)
    setBestResult(null)
    setLogRows([])
    stopRef.current = false
    setRestoredRowsCount(null)

    if (!activeProfile) {
      setRunError(t('profileNotInitialized'))
      return
    }
    if (!selectedExperimentId) {
      setRunError(t('experimentIdNull'))
      return
    }
    if (!indexName.trim() && !(optIndexName && parseCsvStrings(indexNameValuesCsv).length > 0)) {
      setRunError(t('spvErrorIndexNameUnset'))
      return
    }
    if (!apiVersion.trim()) {
      setRunError(t('atErrApiVersionRequired'))
      return
    }
    if (!queryField) {
      setRunError(t('atErrQueryFieldRequired'))
      return
    }
    if (!answerField) {
      setRunError(t('atErrAnswerFieldRequired'))
      return
    }
    if (!resultIdField) {
      setRunError(t('atErrResultIdFieldRequired'))
      return
    }
    if (!Number.isFinite(evalK) || evalK <= 0) {
      setRunError(t('atErrKPositive'))
      return
    }

    const combinations = buildCombinations()

    if (optIndexName && parseCsvStrings(indexNameValuesCsv).length === 0) {
      setRunError(t('atErrIndexValuesInvalid'))
      return
    }

    const willUseVector = combinations.some((c) => {
      const p = c.patch
      const hasVectorEnabled = Object.prototype.hasOwnProperty.call(p, 'vectorEnabled')
      const ve = hasVectorEnabled ? Boolean((p as Partial<SearchFormState>).vectorEnabled) : Boolean(searchForm.vectorEnabled)
      return ve
    })

    // Precompute per-index fallback vector fields when vector is used.
    const vectorFieldsByIndex = new Map<string, string>()
    if (willUseVector) {
      const uniqueIndexes = Array.from(new Set(combinations.map((c) => c.indexName))).filter((x) => x.trim())
      const missing: string[] = []

      for (const idx of uniqueIndexes) {
        // Prefer the Request Builder's current vectorFields if it exists in this index.
        const preferred = searchForm.vectorFields?.trim() ? searchForm.vectorFields.trim() : ''

        // Fetch schema to learn vector fields for this index.
        let schemaFields: string[] = []
        try {
          const res = await getIndexDefinition({ profile: activeProfile, indexName: idx, apiVersion, language })
          schemaFields = res.ok ? extractVectorFieldNamesFromIndexSchema(res.response) : []
        } catch {
          schemaFields = []
        }

        // Fallback to the current index's vectorFieldNames if schema fetch failed for the current index.
        if (schemaFields.length === 0 && idx === indexName.trim() && Array.isArray(vectorFieldNames)) {
          schemaFields = vectorFieldNames
        }

        const preferredList = preferred
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)

        const hasAnyPreferred = preferredList.length > 0 && preferredList.some((f) => schemaFields.includes(f))
        const chosen = hasAnyPreferred ? preferred : (schemaFields[0] ?? '')

        if (!chosen) {
          missing.push(idx)
          continue
        }
        vectorFieldsByIndex.set(idx, chosen)
      }

      if (missing.length > 0) {
        setRunError(format('atErrVectorFieldsMissing', { indexes: missing.join(', ') }))
        return
      }
    }
    if (optVectorWeight && buildRange(vectorWeightMin, vectorWeightMax, vectorWeightStep).length === 0) {
      setRunError(t('atErrVectorWeightRangeInvalid'))
      return
    }
    if (optVectorK && parseCsvNumbers(vectorKValuesCsv).length === 0) {
      setRunError(t('atErrVectorKValuesInvalid'))
      return
    }
    if (optHybridMaxTextRecallSize && parseCsvNumbers(hybridMaxTextRecallSizeValuesCsv).length === 0) {
      setRunError(t('atErrHybridMaxTextRecallSizeValuesInvalid'))
      return
    }
    if (optQueryType) {
      const tokens = parseCsvStrings(queryTypeValuesCsv)
      const patches = buildQueryTypePatches(tokens)
      if (patches.length === 0) {
        setRunError(t('atErrQueryTypeValuesInvalid'))
        return
      }
    }
    if (optVectorThresholdKind && !(thresholdKindIncludeUnset || thresholdKindIncludeVectorSimilarity || thresholdKindIncludeSearchScore)) {
      setRunError(t('atErrVectorThresholdKindAtLeastOne'))
      return
    }
    if (optVectorThresholdValue && buildRange(vectorThresholdValueMin, vectorThresholdValueMax, vectorThresholdValueStep).length === 0) {
      setRunError(t('atErrVectorThresholdValueRangeInvalid'))
      return
    }

    if (combinations.length > 2000) {
      setRunError(format('atErrTooManyCombinations', { n: combinations.length }))
      return
    }

    const startedAt = new Date().toISOString()
    let runId: string | null = null

    setIsRunning(true)
    setProgressCurrent(0)
    setProgressTotal(combinations.length)
    setProgressText('')
    setChildProgressCurrent(0)
    setChildProgressTotal(rows.length)

    const t0 = performance.now()

    try {
      // Create a Run record up-front so it appears in the run list.
      // Store a representative request_json so App restore can restore the Request Builder state.
      const firstRow = rows[0] ?? null
      const firstQueryRaw = firstRow ? firstRow[queryField] : null
      const firstQuery = typeof firstQueryRaw === 'string' ? firstQueryRaw : ''

      const base: SearchFormState = { ...searchForm, queryType: 'simple', facets: '' }
      const representativeForm: SearchFormState = {
        ...base,
        top: Math.max(base.top ?? 0, evalK),
        select: resultIdField,
        search: firstQuery,
      }
      const representativeBody = buildSearchBodyFromForm('semantic-vector', representativeForm, language, isPreviewApiVersion)

      const run = await createRun({
        experimentId: selectedExperimentId,
        runType: 'auto_tuning',
        status: 'canceled',
        startedAt,
        endedAt: startedAt,
        context: {
          endpoint: activeProfile.endpoint,
          apiVersion,
          authType: activeProfile.authType,
          indexName: indexName.trim(),
        },
        params: representativeBody,
        metrics: {},
        note: runNote.trim() || undefined,
      })
      runId = run.runId

      await addArtifact({ runId: run.runId, type: 'request_json', content: JSON.stringify(representativeBody ?? {}, null, 2) })
      let bestScore = -Infinity
      let bestParams: Partial<SearchFormState> | null = null
      let bestIndexName: string | null = null

      // Local log for reliable persistence (React state can lag behind).
      const logRowsLocal: AutoTuningLogRow[] = []

      for (let ci = 0; ci < combinations.length; ci++) {
        if (stopRef.current) break

        const combo = combinations[ci]
        const patch = combo.patch
        const comboIndexName = combo.indexName
        setProgressCurrent(ci + 1)
        setProgressText(format('atProgressTesting', { current: ci + 1, total: combinations.length }))

        // Child progress: per-dataset-row loop within the current combination.
        setChildProgressCurrent(0)
        setChildProgressTotal(rows.length)

        let total = 0
        let count = 0
        const traces: AutoTuningQueryTrace[] = []

        for (let qi = 0; qi < rows.length; qi++) {
          if (stopRef.current) break

          setChildProgressCurrent(qi + 1)

          const row = rows[qi]
          const query = row[queryField]
          const relevantList = asStringList(row[answerField])
          if (typeof query !== 'string') {
            if (enableTrace) {
              traces.push({
                rowIndex: qi + 1,
                query: String(query ?? ''),
                expectedIds: [],
                returnedIds: [],
                score: 0,
                warning: 'skipped:query-not-string',
              })
            }
            continue
          }
          if (relevantList.length === 0) {
            if (enableTrace) {
              traces.push({
                rowIndex: qi + 1,
                query,
                expectedIds: [],
                returnedIds: [],
                score: 0,
                warning: 'skipped:no-expected-ids',
              })
            }
            continue
          }
          const relevant = new Set(relevantList)
          const relevanceGrades = relevanceGradesField
            ? parseRelevanceGrades(row[relevanceGradesField])
            : undefined

          // Decouple AutoTuning from Request Builder defaults: use a stable base.
          // queryType defaults to 'simple' unless explicitly overridden by the optimization patch.
          const base: SearchFormState = { ...searchForm, queryType: 'simple', facets: '' }
          const top = Math.max(base.top ?? 0, evalK)

          const form: SearchFormState = {
            ...base,
            ...patch,
            top,
          }

          const applyVectorText = (text: string) => {
            if (!(form.vectorKind === 'text' && form.vectorEnabled)) return
            form.vectorText = text
            if (Array.isArray(form.vectorQueries) && form.vectorQueries.length > 0) {
              form.vectorQueries = form.vectorQueries.map((draft) =>
                draft.vectorKind === 'text'
                  ? { ...draft, vectorText: text }
                  : draft,
              )
            }
          }

          // Reduce response payload: for scoring we only need the docId field.
          // Always select just that field unless you later add tuning for `select`.
          form.select = resultIdField

          // Default search unless this patch explicitly sets it (vector-only uses search='')
          const patchHasSearch = Object.prototype.hasOwnProperty.call(patch, 'search')
          form.search = patchHasSearch ? String((patch as Partial<SearchFormState>).search ?? '') : query

          // If vector is enabled with integrated vectorization, always set vectorText from the dataset query.
          // The Request Builder may have a stale vectorText value — never carry it through.
          applyVectorText(query)

          // HyDE: override vectorText (and optionally search) with hypothesis from dataset
          if (enableHydeEval) {
            const hypothesis = typeof row[hydeField] === 'string' ? (row[hydeField] as string).trim() : ''
            if (hypothesis) {
              if (hydeApplyTo === 'vectorTextOnly') {
                applyVectorText(hypothesis)
              } else {
                // replaceQueryAndVectorText
                form.search = hypothesis
                applyVectorText(hypothesis)
              }
            }
          }

          // Ensure vector.fields is set for vector/hybrid queries.
          if (form.vectorEnabled && !form.vectorFields.trim()) {
            form.vectorFields = vectorFieldsByIndex.get(comboIndexName) ?? ''
          }

          const body = buildSearchBodyFromForm('semantic-vector', form, language, isPreviewApiVersion)
          const result = await searchDocuments({
            profile: activeProfile,
            indexName: comboIndexName,
            apiVersion,
            body,
            language,
          })

          if (!result.ok) {
            // Trace the API error per-row instead of aborting the entire run
            if (enableTrace) {
              traces.push({
                rowIndex: qi + 1,
                query: query,
                expectedIds: relevantList,
                returnedIds: [],
                score: 0,
                httpStatus: result.status,
                error: [
                  `HTTP ${result.status}`,
                  result.error.message,
                ].filter(Boolean).join(' — '),
                apiResponseText: result.error.responseText ?? '',
                requestBody: body as Record<string, unknown>,
                resultCount: 0,
              })
            }
            // Still throw to abort the run, as the error likely affects all rows
            const detail = [
              format('atApiErrorHttp', { status: result.status }),
              format('atApiErrorRequestId', { requestId: result.requestId }),
              format('atApiErrorUrl', { url: result.url }),
              '',
              result.error.message,
              '',
              result.error.responseText ?? '',
            ].join('\n')
            throw new Error(detail)
          }

          const response = result.response
          const value = (response && typeof response === 'object' && !Array.isArray(response)) ? (response as Record<string, unknown>).value : null
          const items = Array.isArray(value) ? value : []

          const returnedIds = items
            .map((it) => {
              if (!it || typeof it !== 'object' || Array.isArray(it)) return null
              const v = (it as Record<string, unknown>)[resultIdField]
              return typeof v === 'string' ? v : null
            })
            .filter((x): x is string => typeof x === 'string')

          const rowScore = scoreIrObjective(objective, returnedIds, relevant, evalK, relevanceGrades)
          total += rowScore
          count++

          if (enableTrace) {
            const warning =
              items.length === 0 ? 'empty-results' :
              returnedIds.length === 0 ? `no-ids-in-field:${resultIdField}` :
              rowScore === 0 ? 'score-zero' :
              undefined
            traces.push({
              rowIndex: qi + 1,
              query: query,
              expectedIds: relevantList,
              returnedIds,
              score: rowScore,
              httpStatus: result.status,
              warning,
              requestBody: body as Record<string, unknown>,
              resultCount: items.length,
              searchResponse: result.response,
            })
          }
        }

        const avg = count === 0 ? 0 : total / count

        const isNewBest = avg > bestScore
        if (isNewBest) {
          bestScore = avg
          bestParams = patch
          bestIndexName = comboIndexName
          setBestResult({ indexName: comboIndexName, params: patch, score: avg, objective, k: evalK })
        }

        if (isNewBest) {
          for (const r of logRowsLocal) r.isBest = false
        }
        logRowsLocal.push({
          i: ci + 1,
          indexName: comboIndexName,
          score: avg,
          evaluatedQueries: count,
          params: patch,
          isBest: isNewBest,
          queryTraces: enableTrace ? traces : undefined,
        })
        setLogRows([...logRowsLocal])
      }

      if (!stopRef.current && bestParams) {
        setProgressText(
          format('atProgressDoneBestScore', {
            score: bestScore.toFixed(4),
            indexPart: bestIndexName ? ` (index=${bestIndexName})` : '',
          }),
        )
      } else if (stopRef.current) {
        setProgressText(t('atProgressStopped'))
      }

      if (runId) {
        const endedAt = new Date().toISOString()
        const stopped = Boolean(stopRef.current)

        // Update run params to show the best configuration (for the representative query) when available.
        if (bestParams) {
          const base: SearchFormState = { ...searchForm, queryType: 'simple', facets: '' }
          const top = Math.max(base.top ?? 0, evalK)
          const form: SearchFormState = {
            ...base,
            ...bestParams,
            top,
          }
          form.select = resultIdField
          const patchHasSearch = Object.prototype.hasOwnProperty.call(bestParams, 'search')
          const firstRow = rows[0] ?? null
          const firstQueryRaw = firstRow ? firstRow[queryField] : null
          const firstQuery = typeof firstQueryRaw === 'string' ? firstQueryRaw : ''
          form.search = patchHasSearch ? String((bestParams as Partial<SearchFormState>).search ?? '') : firstQuery
          const body = buildSearchBodyFromForm('semantic-vector', form, language, isPreviewApiVersion)
          await addArtifact({ runId, type: 'request_json', content: JSON.stringify(body ?? {}, null, 2) }).catch(() => {
            // ignore
          })
          await updateRun(runId, { params: body }).catch(() => {
            // ignore
          })
        }

        const notePayload: AutoTuningArtifactV1 = {
          kind: 'auto_tuning',
          version: 1,
          savedAt: endedAt,
          endpoint: activeProfile.endpoint,
          apiVersion,
          indexName: indexName.trim(),
          datasetFileName,
          datasetRowsCount: rows.length,
          queryField,
          answerField,
          relevanceGradesField,
          resultIdField,
          objective,
          k: evalK,
          options: {
            optIndexName,
            indexNameValuesCsv,
            optVectorWeight,
            vectorWeightMin,
            vectorWeightMax,
            vectorWeightStep,
            optVectorK,
            vectorKValuesCsv,
            optHybridMaxTextRecallSize,
            hybridMaxTextRecallSizeValuesCsv,
            optQueryType,
            queryTypeValuesCsv,
            optVectorThresholdKind,
            thresholdKindIncludeUnset,
            thresholdKindIncludeVectorSimilarity,
            thresholdKindIncludeSearchScore,
            optVectorThresholdValue,
            vectorThresholdValueMin,
            vectorThresholdValueMax,
            vectorThresholdValueStep,
            // HyDE
            enableHydeEval,
            hydeField,
            hydeApplyTo,
            // Trace
            enableTrace,
          },
          bestResult: bestParams && bestIndexName ? {
            indexName: bestIndexName,
            params: bestParams,
            score: bestScore,
            objective,
            k: evalK,
          } : null,
          logRows: logRowsLocal,
          stopped,
        }
        await addArtifact({ runId, type: 'note', content: JSON.stringify(notePayload, null, 2) })

        await updateRun(runId, {
          status: stopped ? 'canceled' : 'success',
          endedAt,
          metrics: {
            elapsedTimeMs: performance.now() - t0,
          },
        })
        await reloadRuns(selectedExperimentId)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRunError(msg)

      if (runId) {
        const endedAt = new Date().toISOString()
        await updateRun(runId, {
          status: 'error',
          endedAt,
          metrics: {
            elapsedTimeMs: performance.now() - t0,
          },
        }).catch(() => {
          // ignore
        })
        await reloadRuns(selectedExperimentId).catch(() => {
          // ignore
        })
      }
    } finally {
      setIsRunning(false)
    }
  }

  const bestParamsJson: JsonValue = useMemo(() => {
    if (!bestResult) return null
    return bestResult.params as unknown as JsonValue
  }, [bestResult])

  const bestLogScore = useMemo(() => {
    if (logRows.length === 0) return null
    let best = -Infinity
    for (const r of logRows) {
      if (Number.isFinite(r.score) && r.score > best) best = r.score
    }
    return best === -Infinity ? null : best
  }, [logRows])

  const objectiveFormulaText = useMemo(() => {
    switch (objective) {
      case 'precision@k':
        return format('atObjectiveFormulaPrecision', { k: evalK })
      case 'recall@k':
        return format('atObjectiveFormulaRecall', { k: evalK })
      case 'ndcg':
        return format(
          relevanceGradesField ? 'atObjectiveFormulaNdcgGraded' : 'atObjectiveFormulaNdcg',
          { k: evalK },
        )
      case 'mrr':
        return format('atObjectiveFormulaMrr', { k: evalK })
    }
  }, [evalK, format, objective, relevanceGradesField])

  /** Build dynamic trace columns based on available data in the expanded row. */
  const buildTraceColumns = useCallback(
    (traces: AutoTuningQueryTrace[]): TraceColDef[] => {
      const cols: TraceColDef[] = [
        { key: 'idx', title: '#', width: 36, mono: true, render: (qt) => qt.rowIndex },
        {
          key: 'query', title: String(t('atTraceColQuery')), width: 200, wrap: true,
          render: (qt) => qt.query,
          titleFn: (qt) => qt.query,
        },
        {
          key: 'expected', title: String(t('atTraceColExpected')), width: 140, mono: true,
          render: (qt) => qt.expectedIds.length > 2 ? `${qt.expectedIds.slice(0, 2).join(', ')}…(${qt.expectedIds.length})` : qt.expectedIds.join(', '),
          titleFn: (qt) => qt.expectedIds.join(', '),
        },
        {
          key: 'returned', title: String(t('atTraceColReturned')), width: 140, mono: true,
          render: (qt) => qt.returnedIds.length > 2 ? `${qt.returnedIds.slice(0, 2).join(', ')}…(${qt.returnedIds.length})` : qt.returnedIds.join(', '),
          titleFn: (qt) => qt.returnedIds.join(', '),
        },
        { key: 'score', title: String(t('atLogColScore')), width: 80, mono: true, render: (qt) => qt.score.toFixed(4) },
      ]

      // httpStatus — show if any row had a non-200 status or explicit status captured
      const hasHttpStatus = traces.some((qt) => typeof qt.httpStatus === 'number')
      if (hasHttpStatus) {
        cols.push({
          key: 'httpStatus', title: 'HTTP', width: 60, mono: true,
          render: (qt) => typeof qt.httpStatus === 'number' ? qt.httpStatus : '',
        })
      }

      // resultCount — show if captured
      const hasResultCount = traces.some((qt) => typeof qt.resultCount === 'number')
      if (hasResultCount) {
        cols.push({
          key: 'resultCount', title: String(t('atTraceColResultCount')), width: 60, mono: true,
          render: (qt) => typeof qt.resultCount === 'number' ? qt.resultCount : '',
        })
      }

      // status column — always last, shows error/warning/success
      cols.push({
        key: 'status', title: String(t('atTraceColStatus')), width: 180, wrap: true,
        render: (qt) => {
          if (qt.error) {
            return (
              <span style={{ color: 'var(--danger, #d32f2f)' }}>
                ❌ {qt.error}
              </span>
            )
          }
          if (qt.warning) {
            return (
              <span style={{ color: 'var(--warning, #f57c00)' }}>
                ⚠ {qt.warning}
              </span>
            )
          }
          return <span aria-label="success" style={{ color: 'var(--success, #388e3c)' }}>✓</span>
        },
      })

      // apiResponseText — show a dedicated column when any row has it (LLM / vectorizer error details)
      const hasApiResponse = traces.some((qt) => qt.apiResponseText && qt.apiResponseText.trim())
      if (hasApiResponse) {
        cols.push({
          key: 'apiResponse', title: String(t('atTraceColApiResponse')), width: 300, wrap: true,
          render: (qt) => {
            const txt = qt.apiResponseText?.trim() ?? ''
            if (!txt) return ''
            return txt.length > 200 ? txt.slice(0, 200) + '…' : txt
          },
        })
      }

      // searchResponse — show the full API response for debugging score-0 rows
      const hasSearchResponse = traces.some((qt) => qt.searchResponse != null)
      if (hasSearchResponse) {
        cols.push({
          key: 'searchResponse', title: String(t('atTraceColSearchResponse')), width: 320, wrap: true,
          render: (qt) => {
            if (qt.searchResponse == null) return ''
            const s = JSON.stringify(qt.searchResponse)
            return s.length > 200 ? s.slice(0, 200) + '…' : s
          },
        })
      }

      // requestBody — show when available (for debugging vector queries etc.)
      const hasRequestBody = traces.some((qt) => qt.requestBody)
      if (hasRequestBody) {
        cols.push({
          key: 'requestBody', title: String(t('atTraceColRequestBody')), width: 220, wrap: true,
          render: (qt) => {
            if (!qt.requestBody) return ''
            const s = JSON.stringify(qt.requestBody)
            return s.length > 120 ? s.slice(0, 120) + '…' : s
          },
        })
      }

      // Detail button — always shown when trace is enabled, opens the req/res modal
      cols.push({
        key: 'detail', title: '', width: 56,
        render: (qt) => (
          <button
            type="button"
            className="btn btn--xs"
            style={{ fontSize: 10, padding: '1px 6px', whiteSpace: 'nowrap' }}
            onClick={() => setTraceDetailModal(qt)}
          >
            {t('atTraceViewDetail')}
          </button>
        ),
      })

      return cols
    },
    [t],
  )

  const traceEffectiveWidths = useCallback(
    (cols: TraceColDef[]) => {
      const out: Record<string, number> = {}
      for (const c of cols) out[c.key] = traceColWidths[c.key] ?? c.width
      return out
    },
    [traceColWidths],
  )

  const onTraceResizerPointerDown = useCallback(
    (key: string, currentWidth: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      traceDragState.current = { key, startX: e.clientX, startWidth: currentWidth }
      setTraceActiveResizer(key)
      const target = e.currentTarget
      target.setPointerCapture(e.pointerId)

      const onMove = (ev: PointerEvent) => {
        const s = traceDragState.current
        if (!s) return
        const delta = ev.clientX - s.startX
        const next = Math.max(TRACE_MIN_COL_WIDTH, Math.min(TRACE_MAX_COL_WIDTH, s.startWidth + delta))
        setTraceColWidths((prev) => (prev[s.key] === next ? prev : { ...prev, [s.key]: next }))
      }
      const onUp = () => {
        traceDragState.current = null
        setTraceActiveResizer(null)
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
      }
      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onUp)
    },
    [],
  )

  return (
    <div className="pane__centerContent">
      <div className="section">
        <div className="section__title">{t('searchParameterAutoTuning')}</div>
        <div className="app__hint">
          {t('atIntro')}
        </div>

        <div className="form form--compact">
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">{t('atDatasetLabel')}</span>
            <div className="atDatasetUploadBox" data-guide-target="autotuning-upload">
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {t('atUploadJsonl')}
                </button>
                <button
                  type="button"
                  className="btn btn--search"
                  title={String(t('atGenerateDatasetHint'))}
                  onClick={() => {
                    if (onOpenEvalDatasetGenerator) {
                      onOpenEvalDatasetGenerator()
                    } else {
                      setIsEvalDatasetGeneratorOpen(true)
                    }
                  }}
                >
                  <i className="bi bi-stars icon--mr6"></i>
                  {t('atGenerateDataset')}
                </button>
                {savedDatasetList.length > 0 && (
                  <select
                    className="field__input"
                    style={{ minWidth: 220, maxWidth: 360 }}
                    title={String(t('atLoadSavedDatasetHint'))}
                    value={selectedSavedDatasetId}
                    onChange={(e) => onLoadSavedDataset(e.target.value)}
                    onFocus={refreshSavedDatasetList}
                  >
                    <option value="">{t('atLoadSavedDataset')}</option>
                    {savedDatasetList.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title} ({p.itemCount})
                      </option>
                    ))}
                  </select>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/jsonl,.jsonl,application/x-ndjson"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.currentTarget.files?.[0]
                    e.currentTarget.value = ''
                    if (!file) return
                    void onUploadDataset(file)
                  }}
                />
                <div className="pane__meta">{datasetFileName ? datasetFileName : t('atNoFileSelected')}</div>
                <div className="pane__meta">{rows.length > 0 ? format('atRowsCount', { n: rows.length }) : (restoredRowsCount !== null ? format('atRowsCount', { n: restoredRowsCount }) : '')}</div>
              </div>
              <div className="app__hint" style={{ marginTop: 8, marginBottom: 0 }}>
                {t('atJsonlFormatHint')}
              </div>
            </div>
          </div>

          {datasetError && (
            <div className="notice notice--error" style={{ gridColumn: '1 / -1' }}>
              <div className="notice__title">{t('atDatasetErrorTitle')}</div>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{datasetError}</pre>
            </div>
          )}

          <label className="field">
            <span className="field__label">{t('atQueryFieldLabel')}</span>
            <select className="field__input" value={queryField} onChange={(e) => setQueryField(e.target.value)}>
              <option value="">{t('atSelectPlaceholder')}</option>
              {stringFields.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span className="field__label">{t('atAnswerFieldLabel')}</span>
            <select className="field__input" value={answerField} onChange={(e) => setAnswerField(e.target.value)}>
              <option value="">{t('atSelectPlaceholder')}</option>
              {answerFields.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>

          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">{t('atRelevanceGradesFieldLabel')}</span>
            <select
              className="field__input"
              value={relevanceGradesField}
              onChange={(e) => setRelevanceGradesField(e.target.value)}
            >
              <option value="">{t('atRelevanceGradesBinaryFallback')}</option>
              {relevanceGradesFields.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>

          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span className="field__label">{t('atResultDocIdFieldLabel')}</span>
            <select className="field__input" value={resultIdField} onChange={(e) => setResultIdField(e.target.value)}>
              <option value="">{t('atSelectPlaceholder')}</option>
              {scoringFieldOptions.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            {scoringFieldHint && (
              <div className="field__hint">{scoringFieldHint}</div>
            )}
          </label>
        </div>
      </div>

      <div className="section" data-guide-target="autotuning-params">
        <div className="section__title">{t('atOptimizationTitle')}</div>
        <div className="app__hint">{t('atOptimizationHint')}</div>
        <div className="form form--compact">
          <label className="field" data-guide-target="autotuning-metric">
            <span className="field__label">{t('atObjectiveLabel')}</span>
            <select className="field__input" value={objective} onChange={(e) => setObjective(e.target.value as Objective)}>
              <option value="precision@k">Precision@k</option>
              <option value="recall@k">Recall@k</option>
              <option value="ndcg">nDCG</option>
              <option value="mrr">MRR@k</option>
            </select>
            <div className="field__hint" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
              {objectiveFormulaText}
            </div>
          </label>

          <label className="field">
            <span className="field__label">{t('atKLabel')}</span>
            <input
              type="number"
              className="field__input"
              value={evalK}
              min={1}
              step={1}
              onChange={(e) => setEvalK(parseInt(e.target.value || '0', 10))}
            />
          </label>

          {/* HyDE — Query Strategy ---------------------------------- */}
          <div style={{ gridColumn: '1 / -1', borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 4 }}>
            <label className="field" style={{ marginBottom: 8 }}>
              <span className="field__label" style={{ fontWeight: 600 }}>
                <i className="bi bi-lightbulb-fill icon--mr6" />{t('atHydeTitle')}
              </span>
            </label>
            <label className="field" style={{ marginBottom: 4 }}>
              <span className="field__label">
                <input
                  type="checkbox"
                  checked={enableHydeEval}
                  onChange={(e) => setEnableHydeEval(e.target.checked)}
                />{' '}
                {t('atHydeEnableLabel')}
              </span>
              <div className="field__hint">{t('atHydeEnableHint')}</div>
            </label>
            {enableHydeEval && (
              <>
                <label className="field" style={{ marginBottom: 4 }}>
                  <span className="field__label">{t('atHydeFieldLabel')}</span>
                  <input
                    className="field__input"
                    type="text"
                    value={hydeField}
                    onChange={(e) => setHydeField(e.target.value)}
                    style={{ maxWidth: 260 }}
                  />
                </label>
                <label className="field" style={{ marginBottom: 4 }}>
                  <span className="field__label">{t('atHydeApplyToLabel')}</span>
                  <select
                    className="field__input"
                    value={hydeApplyTo}
                    onChange={(e) => setHydeApplyTo(e.target.value as 'vectorTextOnly' | 'replaceQueryAndVectorText')}
                    style={{ maxWidth: 300 }}
                  >
                    <option value="vectorTextOnly">{t('atHydeApplyVectorOnly')}</option>
                    <option value="replaceQueryAndVectorText">{t('atHydeApplyBoth')}</option>
                  </select>
                </label>
                {!searchForm.vectorEnabled && (
                  <div className="field__hint">{t('atHydeNoVectorWarning')}</div>
                )}
              </>
            )}
          </div>

          <div className="kv" style={{ gridColumn: '1 / -1' }}>
            <div className="kv__row">
              <div className="kv__k">{t('atSearchSpaceLabel')}</div>
              <div className="kv__v">{t('atSearchSpaceHint')}</div>
            </div>
          </div>

          <div style={{ gridColumn: '1 / -1' }}>
            <div className="field__label" style={{ marginBottom: 6 }}>{t('atParametersToOptimize')}</div>

            <div className="qpsTable qpsTable--overflowVisible">
              <div className="qpsTable__header" style={{ gridTemplateColumns: '220px 1fr' }}>
                <div style={{ fontSize: 12 }}>{t('atTableColParameter')}</div>
                <div style={{ fontSize: 12 }}>{t('atTableColSearchSpace')}</div>
              </div>

              <div className="qpsTable__row" style={{ gridTemplateColumns: '220px 1fr' }}>
                <div className="mono" style={{ fontSize: 12 }}>
                  <label><input type="checkbox" checked={optIndexName} onChange={(e) => setOptIndexName(e.target.checked)} /> index</label>
                </div>
                <div className="actions" style={{ gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
                  <div className="mono" style={{ display: 'grid', gridTemplateColumns: '60px 1fr', alignItems: 'center', gap: 8, width: '100%' }}>
                    <span style={{ marginRight: 4 }}>{t('atValuesLabel')}</span>
                    <div className="indexSelectControl">
                      <div className="dropdown analyzer-bs" style={{ width: '100%' }}>
                        <button
                          ref={indexDropdownToggleRef}
                          type="button"
                          className="field__input"
                          data-bs-toggle="dropdown"
                          data-bs-auto-close="outside"
                          data-bs-display="static"
                          disabled={!optIndexName}
                          onClick={() => {
                            setIndexFilterText('')
                            window.setTimeout(() => indexFilterInputRef.current?.focus(), 0)
                          }}
                          style={{ width: '100%', textAlign: 'left' }}
                        >
                          <span className="dropdown-toggle__label">
                            {(() => {
                              const selected = parseCsvStrings(indexNameValuesCsv)
                              return formatSelectedListLabel(selected, 3, t('atNone'))
                            })()}
                          </span>
                          <span className="dropdown-toggle__caret" aria-hidden="true" />
                        </button>

                        <div className="dropdown-menu dropdown-menu--left" style={{ width: '100%' }}>
                          <div className="dropdown-menu__pad">
                            <input
                              ref={indexFilterInputRef}
                              className="field__input"
                              value={indexFilterText}
                              onChange={(e) => setIndexFilterText(e.target.value)}
                              placeholder={t('atFilterPlaceholder')}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') hideClosestBootstrapDropdown(e.currentTarget)
                              }}
                            />
                          </div>

                          {filteredIndexNameOptions.map((name) => {
                            const selected = parseCsvStrings(indexNameValuesCsv).includes(name)
                            return (
                              <button
                                key={name}
                                type="button"
                                className={'dropdown-item dropdown-item--check' + (selected ? ' active' : '')}
                                onClick={() => {
                                  setIndexNameValuesCsv((p) => toggleCsvSelectionOrdered(p, name, indexNameOptions))
                                }}
                              >
                                <input className="dropdown-check" type="checkbox" checked={selected} readOnly />
                                <span className="dropdown-label">{name}</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn btn--icon indexSelectReloadBtn"
                        onClick={() => void onReloadIndexNames()}
                        disabled={!activeProfile || !apiVersion.trim() || isIndexNamesLoading}
                        title={t('indexBuilderRefreshIndexListTitle')}
                        aria-label={t('indexBuilderRefreshIndexListTitle')}
                      >
                        <i className={isIndexNamesLoading ? 'bi bi-arrow-repeat spin' : 'bi bi-arrow-clockwise'} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="qpsTable__row" style={{ gridTemplateColumns: '220px 1fr' }}>
                <div className="mono" style={{ fontSize: 12 }}>
                  <label><input type="checkbox" checked={optVectorWeight} onChange={(e) => setOptVectorWeight(e.target.checked)} /> vectorWeight</label>
                </div>
                <div className="actions" style={{ gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
                  <label className="mono">{t('atMinLabel')} <input type="number" className="field__input" style={{ width: 120 }} value={vectorWeightMin} step={0.05} onChange={(e) => setVectorWeightMin(Number(e.target.value))} disabled={!optVectorWeight} /></label>
                  <label className="mono">{t('atMaxLabel')} <input type="number" className="field__input" style={{ width: 120 }} value={vectorWeightMax} step={0.05} onChange={(e) => setVectorWeightMax(Number(e.target.value))} disabled={!optVectorWeight} /></label>
                  <label className="mono">{t('atStepLabel')} <input type="number" className="field__input" style={{ width: 120 }} value={vectorWeightStep} step={0.01} onChange={(e) => setVectorWeightStep(Number(e.target.value))} disabled={!optVectorWeight} /></label>
                </div>
              </div>

              <div className="qpsTable__row" style={{ gridTemplateColumns: '220px 1fr' }}>
                <div className="mono" style={{ fontSize: 12 }}>
                  <label><input type="checkbox" checked={optVectorK} onChange={(e) => setOptVectorK(e.target.checked)} /> vectorK</label>
                </div>
                <div className="actions" style={{ gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
                  <label className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ marginRight: 4 }}>{t('atValuesLabel')}</span>
                    <input
                      type="text"
                      className="field__input"
                      style={{ width: 240 }}
                      value={vectorKValuesCsv}
                      onChange={(e) => setVectorKValuesCsv(e.target.value)}
                      disabled={!optVectorK}
                      placeholder="10,20,50"
                    />
                  </label>
                </div>
              </div>

              <div className="qpsTable__row" style={{ gridTemplateColumns: '220px 1fr' }}>
                <div className="mono" style={{ fontSize: 12 }}>
                  <label><input type="checkbox" checked={optHybridMaxTextRecallSize} onChange={(e) => setOptHybridMaxTextRecallSize(e.target.checked)} /> hybridMaxTextRecallSize</label>
                </div>
                <div className="actions" style={{ gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
                  <label className="mono" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ marginRight: 4 }}>{t('atValuesLabel')}</span>
                    <input
                      type="text"
                      className="field__input"
                      style={{ width: 240 }}
                      value={hybridMaxTextRecallSizeValuesCsv}
                      onChange={(e) => setHybridMaxTextRecallSizeValuesCsv(e.target.value)}
                      disabled={!optHybridMaxTextRecallSize}
                      placeholder="50,100,500"
                    />
                  </label>
                </div>
              </div>

              <div className="qpsTable__row" style={{ gridTemplateColumns: '220px 1fr' }}>
                <div className="mono" style={{ fontSize: 12 }}>
                  <label><input type="checkbox" checked={optQueryType} onChange={(e) => setOptQueryType(e.target.checked)} /> queryType</label>
                </div>
                <div className="actions" style={{ gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
                  <div className="mono" style={{ display: 'grid', gridTemplateColumns: '60px 1fr', alignItems: 'center', gap: 8, width: '100%' }}>
                    <span style={{ marginRight: 4 }}>{t('atValuesLabel')}</span>
                    <div className="dropdown analyzer-bs" style={{ width: '100%' }}>
                      <button
                        type="button"
                        className="field__input"
                        data-bs-toggle="dropdown"
                        data-bs-auto-close="outside"
                        data-bs-display="static"
                        ref={queryTypeDropdownToggleRef}
                        disabled={!optQueryType}
                        onClick={() => {
                          setQueryTypeFilterText('')
                          window.setTimeout(() => queryTypeFilterInputRef.current?.focus(), 0)
                        }}
                        style={{ width: '100%', textAlign: 'left' }}
                      >
                        <span className="dropdown-toggle__label">
                          {(() => {
                            const selected = parseCsvStrings(queryTypeValuesCsv)
                            return formatSelectedListLabel(selected, 4, t('atNone'))
                          })()}
                        </span>
                        <span className="dropdown-toggle__caret" aria-hidden="true" />
                      </button>

                      <div className="dropdown-menu dropdown-menu--left" style={{ width: '100%' }}>
                        <div className="dropdown-menu__pad">
                          <input
                            ref={queryTypeFilterInputRef}
                            className="field__input"
                            value={queryTypeFilterText}
                            onChange={(e) => setQueryTypeFilterText(e.target.value)}
                            placeholder={t('atFilterPlaceholder')}
                            onKeyDown={(e) => {
                              if (e.key === 'Escape') hideClosestBootstrapDropdown(e.currentTarget)
                            }}
                          />
                        </div>

                        {QUERY_TYPE_OPTIONS.filter((name) => {
                          const q = queryTypeFilterText.trim().toLowerCase()
                          if (!q) return true
                          return name.toLowerCase().includes(q)
                        }).map((name) => {
                          const selected = parseCsvStrings(queryTypeValuesCsv).includes(name)
                          return (
                            <button
                              key={name}
                              type="button"
                              className={'dropdown-item dropdown-item--check' + (selected ? ' active' : '')}
                              onClick={() => {
                                setQueryTypeValuesCsv((p) => toggleCsvSelectionOrdered(p, name, QUERY_TYPE_OPTIONS))
                              }}
                            >
                              <input className="dropdown-check" type="checkbox" checked={selected} readOnly />
                              <span className="dropdown-label">{name}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="qpsTable__row" style={{ gridTemplateColumns: '220px 1fr' }}>
                <div className="mono" style={{ fontSize: 12 }}>
                  <label><input type="checkbox" checked={optVectorThresholdKind} onChange={(e) => setOptVectorThresholdKind(e.target.checked)} /> vectorThresholdKind</label>
                </div>
                <div className="actions" style={{ gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
                  <label className="mono"><input type="checkbox" checked={thresholdKindIncludeUnset} onChange={(e) => setThresholdKindIncludeUnset(e.target.checked)} disabled={!optVectorThresholdKind} /> {t('atThresholdUnset')}</label>
                  <label className="mono"><input type="checkbox" checked={thresholdKindIncludeVectorSimilarity} onChange={(e) => setThresholdKindIncludeVectorSimilarity(e.target.checked)} disabled={!optVectorThresholdKind} /> vectorSimilarity</label>
                  <label className="mono"><input type="checkbox" checked={thresholdKindIncludeSearchScore} onChange={(e) => setThresholdKindIncludeSearchScore(e.target.checked)} disabled={!optVectorThresholdKind} /> searchScore</label>
                </div>
              </div>

              <div className="qpsTable__row" style={{ gridTemplateColumns: '220px 1fr' }}>
                <div className="mono" style={{ fontSize: 12 }}>
                  <label><input type="checkbox" checked={optVectorThresholdValue} onChange={(e) => setOptVectorThresholdValue(e.target.checked)} /> vectorThresholdValue</label>
                </div>
                <div className="actions" style={{ gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
                  <label className="mono">{t('atMinLabel')} <input type="number" className="field__input" style={{ width: 120 }} value={vectorThresholdValueMin} step={0.01} onChange={(e) => setVectorThresholdValueMin(Number(e.target.value))} disabled={!optVectorThresholdValue} /></label>
                  <label className="mono">{t('atMaxLabel')} <input type="number" className="field__input" style={{ width: 120 }} value={vectorThresholdValueMax} step={0.01} onChange={(e) => setVectorThresholdValueMax(Number(e.target.value))} disabled={!optVectorThresholdValue} /></label>
                  <label className="mono">{t('atStepLabel')} <input type="number" className="field__input" style={{ width: 120 }} value={vectorThresholdValueStep} step={0.01} onChange={(e) => setVectorThresholdValueStep(Number(e.target.value))} disabled={!optVectorThresholdValue} /></label>
                </div>
              </div>
            </div>
          </div>

          <div className="actions" style={{ gridColumn: '1 / -1', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn--search" onClick={() => void runOptimization()} disabled={!canRun || isRunning} data-guide-target="autotuning-run">
              {isRunning ? t('atRunning') : t('atStartOptimization')}
            </button>
            <button
              type="button"
              className="btn"
              style={{ whiteSpace: 'nowrap' }}
              onClick={() => {
                stopRef.current = true
              }}
              disabled={!isRunning}
            >
              {t('atStop')}
            </button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={enableTrace}
                onChange={(e) => setEnableTrace(e.target.checked)}
                disabled={isRunning}
              />
              {t('atEnableTrace')}
            </label>
            <div className="pane__meta">{progressText}</div>
          </div>

          {progressTotal > 0 && (
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="mono mono--ellipsesSm" style={{ marginBottom: 4 }}>
                {format('atProgressSearchSpace', { current: progressCurrent, total: progressTotal })}
              </div>
              <progress value={progressCurrent} max={progressTotal} style={{ width: '100%' }} />

              {isRunning && childProgressTotal > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="mono mono--ellipsesSm" style={{ marginBottom: 4 }}>
                    {format('atProgressQueries', { current: childProgressCurrent, total: childProgressTotal })}
                  </div>
                  <progress value={childProgressCurrent} max={childProgressTotal} style={{ width: '100%' }} />
                </div>
              )}
            </div>
          )}

          {runError && (
            <div className="notice notice--error" style={{ gridColumn: '1 / -1' }}>
              <div className="notice__title">{t('atErrorTitle')}</div>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap' }}>{runError}</pre>
            </div>
          )}

          {bestResult && (
            <div className="section" style={{ gridColumn: '1 / -1', marginTop: 10 }}>
              <div className="section__title">{t('atBestResultTitle')}</div>
              <div className="kv kv--mb16">
                <div className="kv__row">
                  <div className="kv__k">index</div>
                  <div className="kv__v mono">{bestResult.indexName}</div>
                </div>
                <div className="kv__row">
                  <div className="kv__k">objective</div>
                  <div className="kv__v mono">{bestResult.objective} (k={bestResult.k})</div>
                </div>
                <div className="kv__row">
                  <div className="kv__k">score</div>
                  <div className="kv__v mono">{bestResult.score.toFixed(6)}</div>
                </div>
              </div>

              <div className="mono jsonViewer__body" style={{ marginBottom: 10 }}>
                <JsonViewer data={bestParamsJson} t={t} hideRootObjectToggle />
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    if (!bestResult) return
                    if (bestResult.indexName && bestResult.indexName !== indexName) {
                      setIndexName(bestResult.indexName)
                    }
                    setSearchForm((prev) => ({ ...prev, ...(bestResult.params as Partial<SearchFormState>) }))
                  }}
                  disabled={!bestResult}
                >
                  {t('atApplyToRequestBuilder')}
                </button>
              </div>
            </div>
          )}

          {(logRows.length > 0 || isRunning) && (
            <div className="section" style={{ gridColumn: '1 / -1', marginTop: 10 }}>
              <div className="section__title">{t('atSearchLogTitle')}</div>
              <div className="app__hint">{t('atSearchLogHint')}</div>

              <div className="spvStage__tableWrap spvStage__tableWrap--scrollY">
                <table className="spvTable">
                  <thead>
                    <tr>
                      <th className="spvCol--rank spvCell--ellipsis">#</th>
                      <th className="spvCell--ellipsis">{t('atLogColIndex')}</th>
                      <th className="spvCol--score spvCell--ellipsis">{t('atLogColScore')}</th>
                      <th className="spvCol--docid spvCell--ellipsis">{t('atLogColQueries')}</th>
                      <th className="spvCell--ellipsis">{t('atLogColParams')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logRows.map((r) => {
                      const isExpanded = expandedLogRow === r.i
                      const hasTraces = Array.isArray(r.queryTraces) && r.queryTraces.length > 0
                      return (
                        <React.Fragment key={r.i}>
                          <tr
                            style={hasTraces ? { cursor: 'pointer' } : undefined}
                            onClick={() => {
                              if (!hasTraces) return
                              setExpandedLogRow(isExpanded ? null : r.i)
                            }}
                          >
                            <td className="spvCell--ellipsis">
                              {(() => {
                                const eps = 1e-12
                                const isTop = bestLogScore !== null && Math.abs(r.score - bestLogScore) <= eps
                                const prefix = hasTraces ? (isExpanded ? '▼' : '▶') + ' ' : ''
                                return isTop ? `${prefix}★${r.i}` : `${prefix}${r.i}`
                              })()}
                            </td>
                            <td className="spvCell--ellipsis" title={r.indexName}><span className="mono">{r.indexName}</span></td>
                            <td className="spvCell--ellipsis" title={String(r.score)}>
                              {(() => {
                                const eps = 1e-12
                                const isTop = bestLogScore !== null && Math.abs(r.score - bestLogScore) <= eps
                                const s = r.score.toFixed(6)
                                return isTop ? `★${s}` : s
                              })()}
                            </td>
                            <td className="spvCell--ellipsis">{r.evaluatedQueries}</td>
                            <td style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                              <span className="mono">{JSON.stringify(r.params, null, 2)}</span>
                            </td>
                          </tr>

                          {isExpanded && hasTraces && (() => {
                            const traceCols = buildTraceColumns(r.queryTraces!)
                            const widths = traceEffectiveWidths(traceCols)
                            return (
                            <tr>
                              <td colSpan={5} style={{ padding: 0 }}>
                                <div style={{ background: 'var(--bg-secondary, #f8f8f8)', padding: '8px 12px', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
                                  <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6 }}>{t('atTraceDetailTitle')}</div>
                                  <div style={{ overflowX: 'auto' }}>
                                    <table className="spvTable edgResults__table" style={{ fontSize: 11 }} ref={traceTableRef}>
                                      <colgroup>
                                        {traceCols.map((c) => (
                                          <col key={c.key} style={{ width: `${widths[c.key]}px` }} />
                                        ))}
                                      </colgroup>
                                      <thead>
                                        <tr>
                                          {traceCols.map((c) => (
                                            <th key={c.key} className={c.mono ? 'edgMono' : undefined} title={c.title}>
                                              {c.title}
                                              <div
                                                className={`edgColResizer${traceActiveResizer === c.key ? ' edgColResizer--active' : ''}`}
                                                onPointerDown={onTraceResizerPointerDown(c.key, widths[c.key])}
                                              />
                                            </th>
                                          ))}
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {r.queryTraces!.map((qt) => {
                                          const hasIssue = Boolean(qt.error || qt.warning)
                                          return (
                                            <tr key={qt.rowIndex} style={hasIssue ? { background: qt.error ? 'var(--bg-danger, #fff5f5)' : 'var(--bg-warning, #fffbf0)' } : undefined}>
                                              {traceCols.map((c) => {
                                                const content = c.render(qt)
                                                const titleStr = c.titleFn ? c.titleFn(qt) : (typeof content === 'string' ? content : undefined)
                                                return (
                                                  <td
                                                    key={c.key}
                                                    className={[c.mono ? 'edgMono' : '', c.wrap ? 'edgCell--wrap' : ''].filter(Boolean).join(' ') || undefined}
                                                    title={titleStr}
                                                  >
                                                    {content}
                                                  </td>
                                                )
                                              })}
                                            </tr>
                                          )
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </div>
                              </td>
                            </tr>
                            )
                          })()}
                        </React.Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Trace detail modal — shows full request / response JSON */}
      {traceDetailModal && (
        <div className="modal-overlay" onClick={() => setTraceDetailModal(null)}>
          <div className="modal-content" style={{ maxWidth: 900, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('atTraceDetailModalTitle')} — #{traceDetailModal.rowIndex}</h2>
              <button type="button" className="btn" onClick={() => setTraceDetailModal(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ overflow: 'auto', flex: 1 }}>
              {/* Summary */}
              <div className="kv kv--mb16" style={{ fontSize: 12 }}>
                <div className="kv__row"><div className="kv__k">query</div><div className="kv__v mono">{traceDetailModal.query}</div></div>
                <div className="kv__row"><div className="kv__k">score</div><div className="kv__v mono">{traceDetailModal.score.toFixed(4)}</div></div>
                {typeof traceDetailModal.httpStatus === 'number' && (
                  <div className="kv__row"><div className="kv__k">HTTP</div><div className="kv__v mono">{traceDetailModal.httpStatus}</div></div>
                )}
                {typeof traceDetailModal.resultCount === 'number' && (
                  <div className="kv__row"><div className="kv__k">{t('atTraceColResultCount')}</div><div className="kv__v mono">{traceDetailModal.resultCount}</div></div>
                )}
                {traceDetailModal.error && (
                  <div className="kv__row"><div className="kv__k">error</div><div className="kv__v mono" style={{ color: 'var(--danger, #d32f2f)' }}>{traceDetailModal.error}</div></div>
                )}
                {traceDetailModal.warning && (
                  <div className="kv__row"><div className="kv__k">warning</div><div className="kv__v mono" style={{ color: 'var(--warning, #f57c00)' }}>{traceDetailModal.warning}</div></div>
                )}
                <div className="kv__row"><div className="kv__k">{t('atTraceColExpected')}</div><div className="kv__v mono">{traceDetailModal.expectedIds.join(', ') || '—'}</div></div>
                <div className="kv__row"><div className="kv__k">{t('atTraceColReturned')}</div><div className="kv__v mono">{traceDetailModal.returnedIds.join(', ') || '—'}</div></div>
              </div>

              {/* Request Body */}
              {traceDetailModal.requestBody && (
                <div className="field" style={{ marginBottom: 12 }}>
                  <span className="field__label">{t('atTraceColRequestBody')}</span>
                  <div className="mono jsonViewer__body">
                    <JsonViewer data={traceDetailModal.requestBody as JsonValue} t={t} />
                  </div>
                </div>
              )}

              {/* Search Response */}
              {traceDetailModal.searchResponse != null && (
                <div className="field" style={{ marginBottom: 12 }}>
                  <span className="field__label">{t('atTraceColSearchResponse')}</span>
                  <div className="mono jsonViewer__body">
                    <JsonViewer data={traceDetailModal.searchResponse} t={t} />
                  </div>
                </div>
              )}

              {/* API Error Response */}
              {traceDetailModal.apiResponseText && (
                <div className="field" style={{ marginBottom: 12 }}>
                  <span className="field__label">{t('atTraceColApiResponse')}</span>
                  <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11, background: 'var(--bg-secondary, #f8f8f8)', padding: 8, borderRadius: 4, maxHeight: 300, overflow: 'auto' }}>
                    {traceDetailModal.apiResponseText}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
