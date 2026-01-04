import { useEffect } from 'react'
import { getRun, listArtifactsByRun } from '../lib/db'
import type { LatestResponse } from '../types'
import { safeJsonParse } from '../utils'
import { loadLastViewedRunId } from '../app/persistedLatestRun'

/**
 * Restores the `latest` tab content after a page refresh.
 *
 * The UI persists the selected run tabs separately, but `latestResponse` is an
 * in-memory snapshot. We persist the last `latest` runId and reconstruct the
 * LatestResponse payload from IndexedDB artifacts.
 */
export function useLatestResponseRestore(params: {
  selectedExperimentId: string | null
  centerTab: string
  latestResponse: LatestResponse | null
  setLatestResponse: (v: LatestResponse | null) => void
  setResultPages: React.Dispatch<React.SetStateAction<Record<string, number>>>
}) {
  const { selectedExperimentId, centerTab, latestResponse, setLatestResponse, setResultPages } = params

  useEffect(() => {
    const abortController = new AbortController()

    ;(async () => {
      if (!selectedExperimentId) return
      if (centerTab !== 'latest') return
      if (latestResponse) return

      const runId = loadLastViewedRunId()
      if (!runId) return

      try {
        const run = await getRun(runId)
        if (!run) return

        const artifacts = await listArtifactsByRun(runId)
        const requestArtifact = artifacts.find((a) => a.type === 'request_json')
        const responseArtifact = artifacts.find((a) => a.type === 'response_json')

        const requestBody = safeJsonParse(requestArtifact?.content ?? '{}')
        const responseBody = safeJsonParse(responseArtifact?.content ?? '{}')

        const restoredResponse: LatestResponse = {
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
        }

        if (abortController.signal.aborted) return

        setLatestResponse(restoredResponse)
        setResultPages((prev) => ({ ...prev, latest: 1 }))
      } catch (e) {
        // Best-effort restore; ignore errors.
        console.error('Failed to restore latest response', e)
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [selectedExperimentId, centerTab, latestResponse, setLatestResponse, setResultPages])
}
