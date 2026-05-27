import { describe, expect, it } from 'vitest'

import { aggregateMicroSignatures, buildHierarchicalSignaturePayload, type MicroSignatureInput } from './clusterSignatureAggregation'

const children: MicroSignatureInput[] = [
  {
    clusterId: 'micro-0',
    documentCount: 30,
    signature: {
      primaryLabel: 'RAG evaluation',
      shortSummary: 'Evaluation datasets and answer quality checks.',
      facets: [
        { label: 'Evaluation datasets', summary: 'Dataset generation', keywords: ['eval', 'dataset'], supportRatio: 0.7, representativeDocIds: ['a'] },
      ],
      inclusionCriteria: ['evaluation workflows'],
      exclusionCriteria: ['model deployment'],
      evidenceDocIds: ['a', 'b'],
      splitCandidate: false,
    },
  },
  {
    clusterId: 'micro-1',
    documentCount: 20,
    signature: {
      primaryLabel: 'Search quality',
      shortSummary: 'Search relevance and ranking checks.',
      facets: [
        { label: 'Search quality', summary: 'Ranking validation', keywords: ['ranking', 'relevance'], supportRatio: 0.6, representativeDocIds: ['c'] },
      ],
      inclusionCriteria: ['ranking checks'],
      exclusionCriteria: ['index deployment'],
      evidenceDocIds: ['c'],
      splitCandidate: false,
    },
  },
]

describe('aggregateMicroSignatures', () => {
  it('aggregates child signatures into a macro signature without inventing evidence', () => {
    const signature = aggregateMicroSignatures({ macroId: 0, children, language: 'en' })

    expect(signature.primaryLabel).toContain('RAG evaluation')
    expect(signature.facets.map((facet) => facet.label)).toContain('Evaluation datasets')
    expect(signature.facets.map((facet) => facet.label)).toContain('Search quality')
    expect(signature.evidenceDocIds).toEqual(['a', 'b', 'c'])
    expect(signature.inclusionCriteria).toEqual(['evaluation workflows', 'ranking checks'])
  })

  it('builds a compact hierarchy payload for persistence', () => {
    const payload = buildHierarchicalSignaturePayload(children)

    expect(payload.strategy).toBe('bottom-up-micro-signatures')
    expect(payload.childClusterIds).toEqual(['micro-0', 'micro-1'])
    expect(payload.childDocumentCounts).toEqual([30, 20])
    expect(payload.childCount).toBe(2)
  })
})
