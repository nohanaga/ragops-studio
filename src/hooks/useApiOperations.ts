/**
 * API execution orchestrator.
 *
 * Centralizes request validation, IndexedDB persistence (runs/artifacts), REST
 * execution against Azure AI Search, and UI state updates.
 */

import { useState } from 'react'
import type { ConnectionProfile, Run } from '../lib/model'
import type { CenterTab, LabMode, LatestResponse, SearchFormState, UiLogEntry } from '../types'
import { translations, type Language } from '../lib/translations'
import type { JsonValue } from '../lib/aiSearchRest'
import { addArtifact, createRun, updateRun } from '../lib/db'
import { agenticRetrieve, analyzeIndex, autocompleteDocuments, resolveSearchApiVersion, searchDocuments, suggestDocuments } from '../lib/aiSearchRest'
import { buildSearchBodyFromForm } from '../utils/appRequestBodies'
import { inferRunType, parseJsonStrict, validateRequest } from '../utils'

type TranslationKey = keyof typeof translations.ja

export function useApiOperations(args: {
  labMode: LabMode
  activeProfile: ConnectionProfile | null
  indexName: string
  knowledgeBaseName: string
  selectedExperimentId: string | null
  requestJson: string
  searchForm: SearchFormState
  runNote: string
  language: Language
  t: (key: TranslationKey) => string
  setUiError: (error: string | null) => void
  setUiLog: (log: UiLogEntry | null) => void
  setLatestResponse: (response: LatestResponse | null) => void
  setRunResultMap: React.Dispatch<React.SetStateAction<Record<string, { run: Run; response: LatestResponse | null }>>>
  setSelectedRunIds: React.Dispatch<React.SetStateAction<string[]>>
  setCenterTab: (tab: CenterTab) => void
  setResultPages: React.Dispatch<React.SetStateAction<Record<string, number>>>
  reloadRuns: (experimentId: string | null) => Promise<void>
}) {
  const {
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
  } = args

  const [isExecuting, setIsExecuting] = useState(false)

  function setErrorWithLog(title: string, detail: string) {
    setUiError(title)
    setUiLog({
      level: 'error',
      message: detail,
      timestamp: new Date().toISOString(),
      at: new Date().toISOString(),
      title,
      detail,
    })
  }

  async function onExecute() {
    // Reset UI-level transient state for a fresh execution.
    setUiError(null)
    setUiLog(null)
    setLatestResponse(null)

    // Guardrails: runs must be associated with an experiment and a connection profile.
    if (!selectedExperimentId) {
      setErrorWithLog(t('selectExperiment'), t('experimentIdNull'))
      return
    }
    if (!activeProfile) {
      setErrorWithLog(t('profileNotInitialized'), t('activeProfileNull'))
      return
    }

    let body: JsonValue
    try {
      // Parse + validate request JSON early so we can fail fast before persisting a run.
      body = parseJsonStrict(requestJson)
      validateRequest(labMode, body, language)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErrorWithLog(msg, `Request JSON parse/validate error\nmode=${labMode}\n\n${msg}`)
      return
    }

    const startedAt = new Date().toISOString()

    const ctxApiVersion = labMode === 'agentic'
      ? resolveSearchApiVersion(activeProfile.apiVersion, '2025-11-01-preview')
      : activeProfile.apiVersion
    const context: Run['context'] = {
      endpoint: activeProfile.endpoint,
      apiVersion: ctxApiVersion,
      authType: activeProfile.authType,
      indexName: labMode === 'agentic' ? undefined : indexName.trim(),
      knowledgeBaseName: labMode === 'agentic' ? knowledgeBaseName.trim() : undefined,
    }

    setIsExecuting(true)
    try {
      // Create a Run record first (even if it fails later) to keep traceability.
      const runType = inferRunType(body, labMode)
      const run = await createRun({
        experimentId: selectedExperimentId,
        runType,
        status: 'canceled',
        startedAt,
        endedAt: startedAt,
        context,
        params: body,
        metrics: {},
        note: runNote.trim() || undefined,
      })

      // Persist the exact request JSON as an artifact.
      const requestPretty = JSON.stringify(body ?? {}, null, 2)
      const bytesIn = new TextEncoder().encode(requestPretty).byteLength
      await addArtifact({ runId: run.runId, type: 'request_json', content: requestPretty })

      // Execute the REST request and measure client-side latency.
      const t0 = performance.now()
      const result =
        labMode === 'agentic'
          ? await agenticRetrieve({
              profile: activeProfile,
              knowledgeBaseName,
              body,
              language,
            })
          : labMode === 'analyze'
          ? await analyzeIndex({
              profile: activeProfile,
              indexName,
              apiVersion: activeProfile.apiVersion,
              body,
              language,
            })
          : labMode === 'autocomplete'
          ? await autocompleteDocuments({
              profile: activeProfile,
              indexName,
              apiVersion: activeProfile.apiVersion,
              body,
              language,
            })
          : labMode === 'suggest'
          ? await suggestDocuments({
              profile: activeProfile,
              indexName,
              apiVersion: activeProfile.apiVersion,
              body,
              language,
            })
          : await searchDocuments({
              profile: activeProfile,
              indexName,
              apiVersion: activeProfile.apiVersion,
              body,
              language,
            })
      const latencyMs = Math.round(performance.now() - t0)
      const endedAt = new Date().toISOString()

      if (!result.ok) {
        // Failure path: persist response artifact, update Run metrics/status, show a detailed UI log.
        const responsePretty = JSON.stringify(result.error.response ?? {}, null, 2)
        const bytesOut = new TextEncoder().encode(result.error.responseText ?? responsePretty).byteLength
        await addArtifact({ runId: run.runId, type: 'response_json', content: responsePretty })
        await updateRun(run.runId, {
          status: 'error',
          endedAt,
          metrics: {
            latencyMs,
            elapsedTimeMs: result.elapsedTimeMs,
            httpStatus: result.status,
            serviceRequestId: result.requestId,
              clientRequestId: result.clientRequestId,
            bytesIn,
            bytesOut,
          },
        })

        const title =
          result.status === 0
            ? t('networkError')
            : `${t('apiError')}: HTTP ${result.status}`

        const detail = [
          `title: ${title}`,
          `at: ${endedAt}`,
          `requestId: ${result.requestId}`,
          `url: ${result.url}`,
          `message: ${result.error.message}`,
          '',
          'responseText:',
          result.error.responseText ?? '',
          '',
          'response (json pretty):',
          responsePretty,
        ].join('\n')

        setErrorWithLog(title, detail)
      } else {
        // Success path: build LatestResponse, update the Run map (for compare tabs), and persist response.
        const responsePretty = JSON.stringify(result.response ?? {}, null, 2)
        const bytesOut = new TextEncoder().encode(result.responseText ?? responsePretty).byteLength

        const latestPayload: LatestResponse = {
          at: endedAt,
          requestId: result.requestId,
          clientRequestId: result.clientRequestId,
          url: result.url,
          status: result.status,
          body: result.response,
          requestBody: body,
          runId: run.runId,
          runType,
          latencyMs,
          elapsedTimeMs: result.elapsedTimeMs,
        }

        setLatestResponse(latestPayload)
        setRunResultMap((prev) => ({
          ...prev,
          [run.runId]: { run, response: latestPayload },
        }))

        let resultCount: number | undefined
        let maxScore: number | undefined
        if (labMode !== 'agentic' && result.response && typeof result.response === 'object' && !Array.isArray(result.response)) {
          const resObj = result.response as Record<string, unknown>
          const countVal = resObj['@odata.count']
          if (typeof countVal === 'number') resultCount = countVal

          const valueVal = resObj['value']
          if (Array.isArray(valueVal)) {
            if (resultCount === undefined) resultCount = valueVal.length
            const scores = valueVal
              .map((item) => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
                const score = (item as Record<string, unknown>)['@search.score']
                return typeof score === 'number' ? score : undefined
              })
              .filter((x): x is number => typeof x === 'number')
            if (scores.length > 0) maxScore = Math.max(...scores)
          }
        }

        await addArtifact({ runId: run.runId, type: 'response_json', content: responsePretty })
        await updateRun(run.runId, {
          status: 'success',
          endedAt,
          metrics: {
            latencyMs,
            elapsedTimeMs: result.elapsedTimeMs,
            httpStatus: result.status,
            serviceRequestId: result.requestId,
            clientRequestId: result.clientRequestId,
            resultCount,
            maxScore,
            bytesIn,
            bytesOut,
          },
        })

        setCenterTab('latest')
        setResultPages((prev) => ({ ...prev, latest: 1 }))
      }

      await reloadRuns(selectedExperimentId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const detail = [
        'Unexpected exception while executing request',
        `at: ${new Date().toISOString()}`,
        `mode: ${labMode}`,
        `endpoint: ${activeProfile?.endpoint ?? ''}`,
        `indexName: ${indexName}`,
        `knowledgeBaseName: ${knowledgeBaseName}`,
        '',
        msg,
      ].join('\n')
      setErrorWithLog(msg, detail)
    } finally {
      setIsExecuting(false)
    }
  }

  async function onExecuteAllModes() {
    setUiError(null)
    setUiLog(null)
    setLatestResponse(null)

    if (!selectedExperimentId) {
      setErrorWithLog(t('selectExperiment'), t('experimentIdNull'))
      return
    }
    if (!activeProfile) {
      setErrorWithLog(t('profileNotInitialized'), t('activeProfileNull'))
      return
    }
    if (labMode !== 'semantic-vector') {
      setErrorWithLog('This tool is available only in Semantic/Vector mode', `mode=${labMode}`)
      return
    }
    if (!searchForm.search.trim()) {
      setErrorWithLog('search is required', 'searchForm.search is empty')
      return
    }

    const isPreviewApiVersion = activeProfile.apiVersion.includes('preview')

    const normalizeVectorText = (s: SearchFormState): SearchFormState => {
      if (s.vectorKind !== 'text') return s
      if (s.vectorText.trim()) return s
      return { ...s, vectorText: s.search }
    }

    const base = normalizeVectorText(searchForm)

    // Order: hybrid, vector, semantic, query, then hybrid-semantic (which goes to latest)
    const variants: Array<{ name: string; form: SearchFormState; showInTabs: boolean }> = [
      { name: 'hybrid', form: { ...base, queryType: 'simple', vectorEnabled: true }, showInTabs: true },
      {
        name: 'vector',
        form: {
          ...base,
          queryType: 'simple',
          vectorEnabled: true,
          search: '',
        },
        showInTabs: true,
      },
      { name: 'semantic', form: { ...base, queryType: 'semantic', vectorEnabled: false }, showInTabs: true },
      { name: 'query', form: { ...base, queryType: 'simple', vectorEnabled: false }, showInTabs: true },
      { name: 'semantic_hybrid', form: { ...base, queryType: 'semantic', vectorEnabled: true }, showInTabs: false },
    ]

    const ctxApiVersion = activeProfile.apiVersion
    const context: Run['context'] = {
      endpoint: activeProfile.endpoint,
      apiVersion: ctxApiVersion,
      authType: activeProfile.authType,
      indexName: indexName.trim(),
      knowledgeBaseName: undefined,
    }

    const failures: Array<{ name: string; detail: string }> = []
    const successfulRunIds: string[] = []

    setIsExecuting(true)
    try {
      for (const v of variants) {
        let body: JsonValue
        try {
          body = buildSearchBodyFromForm('semantic-vector', v.form, language, isPreviewApiVersion)
          validateRequest('semantic-vector', body, language)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          failures.push({ name: v.name, detail: `Build/validate failed\nname=${v.name}\n\n${msg}` })
          continue
        }

        const startedAt = new Date().toISOString()
        const runType = inferRunType(body, 'semantic-vector')
        const run = await createRun({
          experimentId: selectedExperimentId,
          runType,
          status: 'canceled',
          startedAt,
          endedAt: startedAt,
          context,
          params: body,
          metrics: {},
          note: runNote.trim() || undefined,
        })

        const requestPretty = JSON.stringify(body ?? {}, null, 2)
        const bytesIn = new TextEncoder().encode(requestPretty).byteLength
        await addArtifact({ runId: run.runId, type: 'request_json', content: requestPretty })

        const t0 = performance.now()
        const result = await searchDocuments({
          profile: activeProfile,
          indexName,
          apiVersion: activeProfile.apiVersion,
          body,
        })
        const latencyMs = Math.round(performance.now() - t0)
        const endedAt = new Date().toISOString()

        if (!result.ok) {
          const responsePretty = JSON.stringify(result.error.response ?? {}, null, 2)
          const bytesOut = new TextEncoder().encode(result.error.responseText ?? responsePretty).byteLength
          await addArtifact({ runId: run.runId, type: 'response_json', content: responsePretty })
          await updateRun(run.runId, {
            status: 'error',
            endedAt,
            metrics: {
              latencyMs,
              elapsedTimeMs: result.elapsedTimeMs,
              httpStatus: result.status,
              serviceRequestId: result.requestId,
              clientRequestId: result.clientRequestId,
              bytesIn,
              bytesOut,
            },
          })

          const title = result.status === 0 ? t('networkError') : `${t('apiError')}: HTTP ${result.status}`

          const detail = [
            `name: ${v.name}`,
            `title: ${title}`,
            `at: ${endedAt}`,
            `requestId: ${result.requestId}`,
            `url: ${result.url}`,
            `message: ${result.error.message}`,
            '',
            'responseText:',
            result.error.responseText ?? '',
            '',
            'response (json pretty):',
            responsePretty,
          ].join('\n')
          failures.push({ name: v.name, detail })
          continue
        }

        const responsePretty = JSON.stringify(result.response ?? {}, null, 2)
        const bytesOut = new TextEncoder().encode(result.responseText ?? responsePretty).byteLength

        const latestPayload: LatestResponse = {
          at: endedAt,
          requestId: result.requestId,
          clientRequestId: result.clientRequestId,
          url: result.url,
          status: result.status,
          body: result.response,
          requestBody: body,
          runId: run.runId,
          runType,
          latencyMs,
          elapsedTimeMs: result.elapsedTimeMs,
        }

        setLatestResponse(latestPayload)
        setRunResultMap((prev) => ({
          ...prev,
          [run.runId]: { run, response: latestPayload },
        }))

        let resultCount: number | undefined
        let maxScore: number | undefined
        if (result.response && typeof result.response === 'object' && !Array.isArray(result.response)) {
          const resObj = result.response as Record<string, unknown>
          const countVal = resObj['@odata.count']
          if (typeof countVal === 'number') resultCount = countVal

          const valueVal = resObj['value']
          if (Array.isArray(valueVal)) {
            if (resultCount === undefined) resultCount = valueVal.length
            const scores = valueVal
              .map((item) => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
                const score = (item as Record<string, unknown>)['@search.score']
                return typeof score === 'number' ? score : undefined
              })
              .filter((x): x is number => typeof x === 'number')
            if (scores.length > 0) maxScore = Math.max(...scores)
          }
        }

        await addArtifact({ runId: run.runId, type: 'response_json', content: responsePretty })
        await updateRun(run.runId, {
          status: 'success',
          endedAt,
          metrics: {
            latencyMs,
            elapsedTimeMs: result.elapsedTimeMs,
            httpStatus: result.status,
            serviceRequestId: result.requestId,
            clientRequestId: result.clientRequestId,
            resultCount,
            maxScore,
            bytesIn,
            bytesOut,
          },
        })

        // Only add to tabs if showInTabs is true
        if (v.showInTabs) {
          successfulRunIds.push(run.runId)
        }
      }

      await reloadRuns(selectedExperimentId)

      // Select successful runs in order and display them
      if (successfulRunIds.length > 0) {
        setSelectedRunIds(successfulRunIds)
        setCenterTab(`run:${successfulRunIds[0]}` as CenterTab)
        setResultPages((prev) => {
          const newPages = { ...prev }
          successfulRunIds.forEach((id) => {
            newPages[`run:${id}`] = 1
          })
          return newPages
        })
      } else {
        setCenterTab('latest')
        setResultPages((prev) => ({ ...prev, latest: 1 }))
      }

      if (failures.length > 0) {
        const summary = `Some runs failed (${failures.length}/${variants.length}). See detail for each.`
        const detail = failures.map((f) => `==== ${f.name} ====\n${f.detail}`).join('\n\n')
        setErrorWithLog(summary, detail)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const detail = [
        'Unexpected exception while executing multi-mode search',
        `at: ${new Date().toISOString()}`,
        `mode: ${labMode}`,
        `endpoint: ${activeProfile?.endpoint ?? ''}`,
        `indexName: ${indexName}`,
        '',
        msg,
      ].join('\n')
      setErrorWithLog(msg, detail)
    } finally {
      setIsExecuting(false)
    }
  }

  return {
    isExecuting,
    onExecute,
    onExecuteAllModes,
  }
}
