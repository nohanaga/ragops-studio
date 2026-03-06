/**
 * Query performance tester.
 *
 * Runs concurrent search requests for a given configuration, aggregates
 * throughput/latency metrics, and stores results as artifacts for later review.
 */

import { useEffect, useMemo, useState } from 'react'

import type { ConnectionProfile } from '../../lib/model'
import { searchDocuments } from '../../lib/aiSearchRest'
import { addArtifact, createRun, listArtifactsByRun, updateRun } from '../../lib/db'
import { translations, type Language } from '../../lib/translations'
import type { SearchFormState } from '../../types'
import { buildSearchBodyFromForm } from '../../utils/appRequestBodies'
import { validateRequest } from '../../utils'
import { InfoTooltip } from '../InfoTooltip'

type TranslationKey = keyof typeof translations.ja

type QpsMode = 'hybrid' | 'semantic_hybrid' | 'vector' | 'semantic' | 'query'

type ModeResult = {
  mode: QpsMode
  requests: number
  success: number
  errors: number
  durationMs: number
  qps: number
  p50LatencyMs?: number
  p95LatencyMs?: number
  p50ElapsedMs?: number
  p95ElapsedMs?: number
  errorSamples?: string[]
}

type QpsTesterArtifactV1 = {
  kind: 'qps_test'
  version: 1
  savedAt: string
  endpoint?: string
  apiVersion?: string
  indexName?: string
  search?: string
  requestsPerMode: number
  concurrency: number
  results: ModeResult[]
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

async function runConcurrent<T>(
  count: number,
  concurrency: number,
  fn: (i: number) => Promise<T>,
): Promise<T[]> {
  const safeConcurrency = Math.max(1, Math.floor(concurrency))
  const results: T[] = new Array(count)
  let next = 0

  const workers = Array.from({ length: Math.min(safeConcurrency, count) }, async () => {
    while (true) {
      const i = next
      next += 1
      if (i >= count) break
      results[i] = await fn(i)
    }
  })

  await Promise.all(workers)
  return results
}

function normalizeVectorText(s: SearchFormState): SearchFormState {
  if (s.vectorKind !== 'text') return s
  if (s.vectorText.trim()) return s
  return { ...s, vectorText: s.search }
}

function buildFormVariant(base: SearchFormState, mode: QpsMode): SearchFormState {
  if (mode === 'hybrid') return { ...base, queryType: 'simple', vectorEnabled: true }
  if (mode === 'semantic_hybrid') return { ...base, queryType: 'semantic', vectorEnabled: true }
  if (mode === 'vector') {
    return {
      ...base,
      queryType: 'simple',
      vectorEnabled: true,
      search: '',
    }
  }
  if (mode === 'semantic') return { ...base, queryType: 'semantic', vectorEnabled: false }
  return { ...base, queryType: 'simple', vectorEnabled: false }
}

export type QueryPerformanceTesterProps = {
  t: (key: TranslationKey) => string
  language: Language
  activeProfile: ConnectionProfile | null
  indexName: string
  searchForm: SearchFormState
  runNote: string
  selectedExperimentId: string | null
  reloadRuns: (experimentId: string | null) => Promise<void>
  restoreRunId?: string | null
  disabled?: boolean
}

export function QueryPerformanceTester(props: QueryPerformanceTesterProps) {
  const { t, language, activeProfile, indexName, searchForm, runNote, selectedExperimentId, reloadRuns, restoreRunId, disabled } = props

  const [isRunning, setIsRunning] = useState(false)
  const [progressText, setProgressText] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ completed: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ModeResult[] | null>(null)
  const [expandedErrorMode, setExpandedErrorMode] = useState<QpsMode | null>(null)

  const [requestsPerMode, setRequestsPerMode] = useState<number>(20)
  const [concurrency, setConcurrency] = useState<number>(5)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // Load QPS test result from a specific run when provided.
        // Note: we intentionally do NOT auto-load the latest result when opening the tab.
        // The user can always click RUN to produce (and then view) results.
        if (!restoreRunId) return

        const artifacts = await listArtifactsByRun(restoreRunId)
        const note = artifacts.find((a) => a.type === 'note')
        if (!note) {
          if (!cancelled) setError(t('noArtifacts'))
          return
        }

        const parsed = JSON.parse(note.content) as Partial<QpsTesterArtifactV1>
        if (parsed.kind !== 'qps_test' || parsed.version !== 1) return
        if (!Array.isArray(parsed.results)) return

        if (typeof parsed.requestsPerMode === 'number') setRequestsPerMode(parsed.requestsPerMode)
        if (typeof parsed.concurrency === 'number') setConcurrency(parsed.concurrency)
        if (!cancelled) setResults(parsed.results as ModeResult[])
      } catch {
        // ignore restore failures
      }
    })()

    return () => {
      cancelled = true
    }
  }, [restoreRunId, t])

  const chart = useMemo(() => {
    const list = results ?? []
    const max = Math.max(0, ...list.map((r) => r.qps))
    return { list, max }
  }, [results])

  async function onRun() {
    setError(null)
    setResults(null)
    setProgress(null)

    if (!selectedExperimentId) {
      setError(t('experimentIdNull'))
      return
    }

    if (!activeProfile) {
      setError(t('profileNotInitialized'))
      return
    }
    if (!indexName.trim()) {
      setError(t('spvErrorIndexNameUnset'))
      return
    }
    if (!searchForm.search.trim()) {
      setError(t('qpsTestErrorQueryEmpty'))
      return
    }

    const safeRequestsPerMode = Math.max(1, Math.min(1000, Math.floor(requestsPerMode)))
    const safeConcurrency = Math.max(1, Math.min(100, Math.floor(concurrency)))

    const isPreviewApiVersion = activeProfile.apiVersion.includes('preview')
    const base = normalizeVectorText(searchForm)

    const modes: QpsMode[] = ['query', 'vector', 'hybrid', 'semantic', 'semantic_hybrid']

    // Create a Run record up-front so it appears in the run list.
    const startedAt = new Date().toISOString()
    let runId: string | null = null

    setIsRunning(true)
    try {
      const nextResults: ModeResult[] = []
      setExpandedErrorMode(null)
      setProgress({ completed: 0, total: modes.length * safeRequestsPerMode })

      // Store a representative request body so Run restore works.
      const representativeForm = buildFormVariant(base, 'semantic_hybrid')
      const representativeBody = buildSearchBodyFromForm(
        'semantic-vector',
        representativeForm,
        language,
        isPreviewApiVersion,
      )
      validateRequest('semantic-vector', representativeBody, language)

      const run = await createRun({
        experimentId: selectedExperimentId,
        runType: 'qps_test',
        status: 'canceled',
        startedAt,
        endedAt: startedAt,
        context: {
          endpoint: activeProfile.endpoint,
          apiVersion: activeProfile.apiVersion,
          authType: activeProfile.authType,
          indexName: indexName.trim(),
        },
        params: representativeBody,
        metrics: {},
        note: runNote.trim() || undefined,
      })
      runId = run.runId

      const requestPretty = JSON.stringify(representativeBody ?? {}, null, 2)
      await addArtifact({ runId: run.runId, type: 'request_json', content: requestPretty })

      for (const mode of modes) {
        setProgressText(t('qpsTestRunningMode').replace('{mode}', mode))

        const form = buildFormVariant(base, mode)
        const body = buildSearchBodyFromForm('semantic-vector', form, language, isPreviewApiVersion)
        validateRequest('semantic-vector', body, language)

        const latencies: number[] = []
        const elapsedTimes: number[] = []
        let success = 0
        let errors = 0
        const errorSamples: string[] = []

        const t0 = performance.now()

        await runConcurrent(safeRequestsPerMode, safeConcurrency, async () => {
          try {
            const r0 = performance.now()
            const result = await searchDocuments({
              profile: activeProfile,
              indexName,
              apiVersion: activeProfile.apiVersion,
              body,
              language,
            })
            const latencyMs = performance.now() - r0
            latencies.push(latencyMs)
            if (typeof result.elapsedTimeMs === 'number' && Number.isFinite(result.elapsedTimeMs)) {
              elapsedTimes.push(result.elapsedTimeMs)
            }

            if (result.ok) {
              success += 1
            } else {
              errors += 1
              if (errorSamples.length < 5) {
                const msg = result.error?.message ?? 'Unknown error'
                errorSamples.push(`HTTP ${result.status} - ${msg}\nrequestId: ${result.requestId}\nurl: ${result.url}`)
              }
            }
          } finally {
            setProgress((prev) => {
              if (!prev) return prev
              const completed = Math.min(prev.total, prev.completed + 1)
              return { ...prev, completed }
            })
          }
        })

        const durationMs = performance.now() - t0
        const qps = success / Math.max(0.001, durationMs / 1000)

        nextResults.push({
          mode,
          requests: safeRequestsPerMode,
          success,
          errors,
          durationMs,
          qps,
          p50LatencyMs: percentile(latencies, 50),
          p95LatencyMs: percentile(latencies, 95),
          p50ElapsedMs: percentile(elapsedTimes, 50),
          p95ElapsedMs: percentile(elapsedTimes, 95),
          errorSamples: errorSamples.length > 0 ? errorSamples : undefined,
        })
      }

      setResults(nextResults)

      if (runId) {
        const endedAt = new Date().toISOString()
        const notePayload: QpsTesterArtifactV1 = {
          kind: 'qps_test',
          version: 1,
          savedAt: endedAt,
          endpoint: activeProfile.endpoint,
          apiVersion: activeProfile.apiVersion,
          indexName: indexName.trim(),
          search: searchForm.search,
          requestsPerMode: safeRequestsPerMode,
          concurrency: safeConcurrency,
          results: nextResults,
        }
        await addArtifact({ runId, type: 'note', content: JSON.stringify(notePayload, null, 2) })
        await updateRun(runId, {
          status: 'success',
          endedAt,
          metrics: {},
        })
        await reloadRuns(selectedExperimentId)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)

      if (runId) {
        const endedAt = new Date().toISOString()
        await updateRun(runId, {
          status: 'error',
          endedAt,
          metrics: {},
        }).catch(() => {
          // ignore
        })
        await reloadRuns(selectedExperimentId).catch(() => {
          // ignore
        })
      }
    } finally {
      setProgressText(null)
      setProgress(null)
      setIsRunning(false)
    }
  }

  return (
    <div className="section qpsTester">
      <div className="section__title">{t('qpsTestTitle')}</div>
      <div className="app__hint">{t('qpsTestHint')}</div>

      <div className="form qpsTester__controls">
        <label className="field">
          <span className="field__label">
            {t('qpsTestRequestsPerMode')}
            <InfoTooltip tooltipKey="qpsRequestsPerMode" language={language} />
          </span>
          <input
            className="field__input"
            type="number"
            min={1}
            max={1000}
            step={1}
            value={requestsPerMode}
            onChange={(e) => setRequestsPerMode(Number(e.target.value))}
            disabled={Boolean(disabled) || isRunning}
          />
        </label>
        <label className="field">
          <span className="field__label">
            {t('qpsTestConcurrency')}
            <InfoTooltip tooltipKey="qpsConcurrency" language={language} />
          </span>
          <input
            className="field__input"
            type="number"
            min={1}
            max={100}
            step={1}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
            disabled={Boolean(disabled) || isRunning}
          />
        </label>
      </div>

      <div className="actions actions--mb10">
        <button
          type="button"
          className="btn btn--multi-mode"
          onClick={() => void onRun()}
          disabled={Boolean(disabled) || isRunning}
        >
          <i className="bi bi-speedometer2 icon--mr6"></i>
          {isRunning ? t('qpsTestRunning') : t('qpsTestRun')}
        </button>
        {(progressText || progress) && (
          <div className="qpsTester__progressWrap">
            {progressText && <div className="mono qpsTester__progress">{progressText}</div>}
            {progress && (
              <div
                className="qpsTester__progressBar"
                role="progressbar"
                aria-label={progressText ?? t('qpsTestRunning')}
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.completed}
              >
                <div
                  className="qpsTester__progressFill"
                  style={{ width: `${Math.max(0, Math.min(100, (progress.completed / Math.max(1, progress.total)) * 100)).toFixed(1)}%` }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="notice notice--error">
          <div className="notice__title">{t('qpsTestErrorTitle')}</div>
          <pre className="mono notice__detail">{error}</pre>
        </div>
      )}

      {chart.list.length > 0 && (
        <div className="qpsChart" role="img" aria-label={t('qpsTestChartAriaLabel')}>
          {chart.list.map((r) => {
            const pct = chart.max > 0 ? Math.max(0, Math.min(1, r.qps / chart.max)) : 0
            return (
              <div key={r.mode} className="qpsChart__row">
                <div className="qpsChart__label mono">{r.mode}</div>
                <div className="qpsChart__barWrap" aria-hidden="true">
                  <div className="qpsChart__bar" style={{ width: `${(pct * 100).toFixed(1)}%` }} />
                </div>
                <div className="qpsChart__value mono">{r.qps.toFixed(2)} QPS</div>
              </div>
            )
          })}
        </div>
      )}

      {chart.list.length > 0 && (
        <div className="qpsTable">
          <div className="qpsTable__header mono">
            <div>{t('qpsTestColMode')}</div>
            <div>{t('qpsTestColQps')}</div>
            <div>{t('qpsTestColP95Client')}</div>
            <div>{t('qpsTestColP95Server')}</div>
            <div>{t('qpsTestColErrors')}</div>
          </div>
          {chart.list.map((r) => (
            <div key={r.mode} className="qpsTable__row mono">
              <div>{r.mode}</div>
              <div>{r.qps.toFixed(2)}</div>
              <div>
                {r.p95LatencyMs !== undefined ? `${r.p95LatencyMs.toFixed(0)} ms` : '-'}
              </div>
              <div>
                {r.p95ElapsedMs !== undefined ? `${r.p95ElapsedMs.toFixed(0)} ms` : '-'}
              </div>
              <div className="qpsTable__errors">
                <span>
                  {r.errors}/{r.requests}
                </span>
                {r.errors > 0 && r.errorSamples && r.errorSamples.length > 0 && (
                  <button
                    type="button"
                    className="btn btn--sm qpsTable__errorBtn"
                    onClick={() => setExpandedErrorMode((prev) => (prev === r.mode ? null : r.mode))}
                    disabled={isRunning}
                  >
                    {expandedErrorMode === r.mode ? t('qpsTestHideErrors') : t('qpsTestShowErrors')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {chart.list.length > 0 && expandedErrorMode && (() => {
        const r = chart.list.find((x) => x.mode === expandedErrorMode)
        if (!r?.errorSamples || r.errorSamples.length === 0) return null
        return (
          <div className="notice notice--warning qpsTester__errorDetails">
            <div className="notice__title">
              {t('qpsTestErrorDetailsTitle').replace('{mode}', expandedErrorMode)}
            </div>
            <pre className="mono notice__detail">{r.errorSamples.join('\n\n---\n\n')}</pre>
          </div>
        )
      })()}
    </div>
  )
}
