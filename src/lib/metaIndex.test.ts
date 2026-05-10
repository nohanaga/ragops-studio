import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ClusterResult } from './clustering'
import type { LlmProviderConfig } from './llmProvider'
import { summarizeClustersV2 } from './metaIndex'

function vector(values: number[]): Float32Array {
  return new Float32Array(values)
}

const llmConfig: LlmProviderConfig = {
  provider: 'lmstudio',
  endpoint: 'http://localhost:1234',
  auth: { mode: 'apiKey', apiKey: 'none' },
  model: 'local-test-model',
}

const clusters: ClusterResult = {
  labels: new Uint16Array([0, 0, 0]),
  centroids: [vector([1, 0])],
  counts: [3],
  inertia: 0,
}

describe('summarizeClustersV2 fallback safety', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not promote long document titles when LM Studio truncates JSON output', async () => {
    const longTitle = 'Very long document body accidentally stored in the title field. '.repeat(20)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [
        {
          message: { content: '{"primaryLabel":"unfinished"' },
          finish_reason: 'length',
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await summarizeClustersV2({
      clusters,
      docs: [
        { id: 'doc-1', title: longTitle, vector: vector([1, 0]) },
        { id: 'doc-2', title: longTitle, vector: vector([0.98, 0.02]) },
        { id: 'doc-3', title: longTitle, vector: vector([0.96, 0.04]) },
      ],
      representativeTexts: new Map(),
      llmConfig,
      language: 'en',
      maxInputTokens: 8_192,
    })

    expect(result.llmFailureCount).toBe(1)
    expect(result.summaries[0].label).toBe('Cluster 0')
    expect(result.summaries[0].label.length).toBeLessThanOrEqual(80)
    expect(result.summaries[0].summary.length).toBeLessThanOrEqual(320)
    expect(result.traces[0].label.length).toBeLessThanOrEqual(80)
  })
})
