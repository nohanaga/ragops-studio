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

const azureLlmConfig: LlmProviderConfig = {
  provider: 'azure-openai',
  endpoint: 'https://example.openai.azure.com',
  auth: { mode: 'apiKey', apiKey: 'test-key' },
  model: 'test-deployment',
  apiVersion: '2024-10-21',
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

  it('retries content-filtered Azure OpenAI prompts with raw evidence omitted', async () => {
    const rawEvidenceText = 'RAW_EVIDENCE_TEXT_THAT_SHOULD_NOT_BE_SENT_ON_RETRY'
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: 'The response was filtered due to the prompt triggering Azure OpenAI content management policy.',
          code: 'content_filter',
        },
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                primaryLabel: 'Recovered label',
                shortSummary: 'Recovered summary',
                facets: [
                  {
                    label: 'Recovered facet',
                    summary: 'Recovered facet summary',
                    keywords: ['recovered'],
                    supportRatio: 1,
                    representativeDocIds: ['doc-1'],
                  },
                ],
                inclusionCriteria: ['Recovered inclusion'],
                exclusionCriteria: ['Recovered exclusion'],
                evidenceDocIds: ['doc-1'],
                splitCandidate: false,
              }),
            },
            finish_reason: 'stop',
          },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await summarizeClustersV2({
      clusters,
      docs: [
        { id: 'doc-1', title: 'Short safe title', vector: vector([1, 0]) },
        { id: 'doc-2', title: 'Another safe title', vector: vector([0.98, 0.02]) },
        { id: 'doc-3', title: 'Third safe title', vector: vector([0.96, 0.04]) },
      ],
      representativeTexts: new Map([
        ['doc-1', rawEvidenceText],
        ['doc-2', rawEvidenceText],
        ['doc-3', rawEvidenceText],
      ]),
      llmConfig: azureLlmConfig,
      language: 'en',
      traceIndexFields: {
        sourceIndexName: 'source-index',
        keyField: 'id',
        vectorField: 'embedding',
        titleField: 'title',
        titleFieldSource: 'user',
        contentFields: ['content'],
        contentFieldSource: 'user',
      },
      maxInputTokens: 8_192,
    })

    const firstRequest = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    const secondRequest = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(firstRequest.messages[1].content).toContain(rawEvidenceText)
    expect(secondRequest.messages[1].content).not.toContain(rawEvidenceText)
    expect(secondRequest.messages[1].content).toContain('[Content omitted for content-filter retry]')
    expect(result.llmFailureCount).toBe(0)
    expect(result.summaries[0].label).toBe('Recovered label')
    expect(result.traces[0].indexFields).toEqual({
      sourceIndexName: 'source-index',
      keyField: 'id',
      vectorField: 'embedding',
      titleField: 'title',
      titleFieldSource: 'user',
      contentFields: ['content'],
      contentFieldSource: 'user',
    })
  })
})
