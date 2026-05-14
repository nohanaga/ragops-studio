import { describe, expect, it } from 'vitest'

import type { RestResult } from './aiSearchRest'
import {
  calculateCloneRetryDelayMs,
  isRetryableCloneStatus,
  resolveCloneRetryPolicy,
  runCloneOperationWithRetry,
  type IndexCloneRetryNotice,
} from './indexCloneWorker'

function okResult(): RestResult {
  return {
    ok: true,
    status: 200,
    requestId: 'ok',
    url: 'https://example.test',
    response: {},
  }
}

function errorResult(status: number): RestResult {
  return {
    ok: false,
    status,
    requestId: `err-${status}`,
    url: 'https://example.test',
    error: { message: `HTTP ${status}` },
  }
}

describe('lib/indexCloneWorker retry helpers', () => {
  it('classifies transient clone statuses', () => {
    expect(isRetryableCloneStatus(0)).toBe(true)
    expect(isRetryableCloneStatus(429)).toBe(true)
    expect(isRetryableCloneStatus(503)).toBe(true)
    expect(isRetryableCloneStatus(400)).toBe(false)
  })

  it('calculates capped exponential retry delays', () => {
    const policy = resolveCloneRetryPolicy({ maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 250, jitterRatio: 0 })
    expect(calculateCloneRetryDelayMs(1, policy)).toBe(100)
    expect(calculateCloneRetryDelayMs(2, policy)).toBe(200)
    expect(calculateCloneRetryDelayMs(3, policy)).toBe(250)
  })

  it('retries retryable REST results and reports retry notices', async () => {
    let calls = 0
    const delays: number[] = []
    const notices: IndexCloneRetryNotice[] = []

    const result = await runCloneOperationWithRetry(
      async () => {
        calls += 1
        return calls < 3 ? errorResult(429) : okResult()
      },
      {
        operationName: 'search-documents',
        policy: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
        sleep: async (delayMs) => { delays.push(delayMs) },
        onRetry: (notice) => { notices.push(notice) },
      },
    )

    expect(result.ok).toBe(true)
    expect(calls).toBe(3)
    expect(delays).toEqual([10, 20])
    expect(notices.map((notice) => notice.attempt)).toEqual([2, 3])
  })

  it('does not retry non-retryable REST results', async () => {
    let calls = 0
    const result = await runCloneOperationWithRetry(
      async () => {
        calls += 1
        return errorResult(400)
      },
      {
        operationName: 'upload-documents',
        policy: { maxAttempts: 5, initialDelayMs: 10, maxDelayMs: 100, jitterRatio: 0 },
      },
    )

    expect(result.ok).toBe(false)
    expect(calls).toBe(1)
  })
})
