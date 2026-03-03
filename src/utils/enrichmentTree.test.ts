import { describe, expect, it } from 'vitest'

import { _internal, buildEnrichmentTreeModel } from './enrichmentTree'

describe('enrichmentTree', () => {
  it('normalizes and joins paths safely', () => {
    expect(_internal.normalizePath('document/content')).toBe('/document/content')
    expect(_internal.joinPath('/document', 'entities')).toBe('/document/entities')
    expect(_internal.joinPath('/document/', '/entities')).toBe('/document/entities')
  })

  it('builds a /document-rooted tree and produced paths', () => {
    const model = buildEnrichmentTreeModel({
      nodes: [
        {
          id: 's1',
          type: 'skill',
          position: { x: 0, y: 0 },
          data: {
            kind: 'skill',
            skill: {
              '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
              name: 'split',
              context: '/document',
              inputs: [{ name: 'text', source: '/document/content' }],
              outputs: [{ name: 'textItems', targetName: 'chunks' }],
            },
          },
        } as any,
      ],
      indexer: {
        name: 'ix',
        targetIndexName: 'idx',
        outputFieldMappings: [{ sourceFieldName: '/document/chunks', targetFieldName: 'chunks' }],
      } as any,
    })

    expect(model.root.path).toBe('/document')
    expect(model.producedPathSet.has('/document/chunks')).toBe(true)
    expect(model.indexerUsages.some((x) => x.sourceFieldName === '/document/chunks' && x.targetFieldName === 'chunks')).toBe(true)
  })
})
