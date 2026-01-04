import type { Dispatch, SetStateAction } from 'react'
import { useEffect } from 'react'
import { getRun, listArtifactsByRun } from '../lib/db'
import type { Run } from '../lib/model'
import type { LatestResponse } from '../types'
import { safeJsonParse } from '../utils'

export function useSelectedRunsArtifacts(params: {
  selectedRunIds: string[]

  setSelectedRun: Dispatch<SetStateAction<Run | null>>
  setIndexName: Dispatch<SetStateAction<string>>
  setKnowledgeBaseName: Dispatch<SetStateAction<string>>
  setRequestJson: Dispatch<SetStateAction<string>>

  setRunResultMap: Dispatch<SetStateAction<Record<string, { run: Run; response: LatestResponse | null }>>>
  setResultPages: Dispatch<SetStateAction<Record<string, number>>>
}) {
  const {
    selectedRunIds,
    setSelectedRun,
    setIndexName,
    setKnowledgeBaseName,
    setRequestJson,
    setRunResultMap,
    setResultPages,
  } = params

  // Keep `selectedRun` in sync with selected run IDs (single-selection).
  useEffect(() => {
    const abortController = new AbortController()
    ;(async () => {
      if (selectedRunIds.length !== 1) {
        setSelectedRun(null)
        return
      }

      const run = await getRun(selectedRunIds[0])
      if (abortController.signal.aborted) return

      setSelectedRun(run ?? null)

      if (run) {
        const ctx = run.context
        if (ctx.indexName) setIndexName(ctx.indexName)
        if (ctx.knowledgeBaseName) setKnowledgeBaseName(ctx.knowledgeBaseName)
        setRequestJson(JSON.stringify(run.params ?? {}, null, 2))
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [selectedRunIds, setSelectedRun, setIndexName, setKnowledgeBaseName, setRequestJson])

  // Load run artifacts for all selected runs and keep runResultMap/pagination in sync.
  useEffect(() => {
    const abortController = new AbortController()
    ;(async () => {
      const nextMap: Record<string, { run: Run; response: LatestResponse | null }> = {}

      for (const runId of selectedRunIds) {
        try {
          const run = await getRun(runId)
          if (!run) continue

          const artifacts = await listArtifactsByRun(runId)
          const requestArtifact = artifacts.find((a) => a.type === 'request_json')
          const responseArtifact = artifacts.find((a) => a.type === 'response_json')

          const requestBody = safeJsonParse(requestArtifact?.content ?? '{}')
          const responseBody = safeJsonParse(responseArtifact?.content ?? '{}')

          nextMap[runId] = {
            run,
            response: {
              at: run.startedAt,
              runId: run.runId,
              requestId: run.metrics.serviceRequestId ?? '',
              clientRequestId: run.metrics.clientRequestId,
              url: '',
              status: run.metrics.httpStatus ?? 200,
              body: responseBody,
              requestBody,
              runType: run.runType,
              latencyMs: run.metrics.latencyMs,
              elapsedTimeMs: run.metrics.elapsedTimeMs,
            },
          }
        } catch (e) {
          console.error('Failed to load run artifacts', e)
        }
      }

      if (abortController.signal.aborted) return

      setRunResultMap(nextMap)
      setResultPages((prev) => {
        const next = { ...prev }

        // Ensure pages exist for selected runs
        for (const runId of selectedRunIds) {
          const key = `run:${runId}`
          if (!next[key]) next[key] = 1
        }

        // Remove pages for deselected runs
        for (const key of Object.keys(next)) {
          if (key.startsWith('run:')) {
            const id = key.slice(4)
            if (!selectedRunIds.includes(id)) delete next[key]
          }
        }

        return next
      })
    })()

    return () => {
      abortController.abort()
    }
  }, [selectedRunIds, setRunResultMap, setResultPages])
}
