import type { JsonValue } from '../lib/aiSearchRest'
import type { Run } from '../lib/model'
import type { LatestResponse } from '../types'

export function restoreRunResponse(run: Run, requestBody: JsonValue, responseBody: JsonValue): LatestResponse {
  const streamState = run.responseMetadata?.streamState
  return {
    at: run.startedAt,
    runId: run.runId,
    requestId: run.metrics.serviceRequestId ?? '',
    clientRequestId: run.metrics.clientRequestId,
    url: '',
    status: run.status === 'canceled' ? 0 : run.metrics.httpStatus ?? 200,
    body: responseBody,
    requestBody,
    runType: run.runType,
    runStatus: run.status,
    latencyMs: run.metrics.latencyMs,
    elapsedTimeMs: run.metrics.elapsedTimeMs,
    responseFormat: run.responseMetadata?.responseFormat,
    streamState: streamState ? { ...streamState, runningActivityIds: [...streamState.runningActivityIds] } : undefined,
  }
}
