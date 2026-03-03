import { describe, expect, it } from 'vitest'

import { appendOutputFieldMappingToIndexer, removeOutputFieldMappingFromIndexer } from './skillPipelineOutputFieldMappings'

describe('utils/skillPipelineOutputFieldMappings', () => {
  it('appends a mapping with mappingFunction=null', () => {
    const out = appendOutputFieldMappingToIndexer({}, '/document/pages/*/keyPhrases/*') as any

    expect(Array.isArray(out.outputFieldMappings)).toBe(true)
    expect(out.outputFieldMappings).toHaveLength(1)
    expect(out.outputFieldMappings[0].sourceFieldName).toBe('/document/pages/*/keyPhrases/*')
    expect(typeof out.outputFieldMappings[0].targetFieldName).toBe('string')
    expect(out.outputFieldMappings[0].targetFieldName.length).toBeGreaterThan(0)
    expect(out.outputFieldMappings[0].mappingFunction).toBe(null)
  })

  it('avoids exact duplicates', () => {
    const idx = appendOutputFieldMappingToIndexer({}, '/document/content') as any
    const idx2 = appendOutputFieldMappingToIndexer(idx, '/document/content') as any

    expect(idx2.outputFieldMappings).toHaveLength(1)
  })

  it('disambiguates targetFieldName on collision', () => {
    const a = {
      outputFieldMappings: [{ sourceFieldName: '/document/content', targetFieldName: 'content', mappingFunction: null }],
    }

    const out = appendOutputFieldMappingToIndexer(a as any, '/document/content.') as any

    expect(out.outputFieldMappings).toHaveLength(2)
    expect(out.outputFieldMappings[1].targetFieldName).not.toBe('content')
  })

  it('removes a mapping by source+target', () => {
    const idx = {
      outputFieldMappings: [
        { sourceFieldName: '/document/a', targetFieldName: 'a', mappingFunction: null },
        { sourceFieldName: '/document/b', targetFieldName: 'b', mappingFunction: null },
      ],
    }

    const out = removeOutputFieldMappingFromIndexer(idx as any, { sourceFieldName: '/document/a', targetFieldName: 'a' }) as any
    expect(out.outputFieldMappings).toHaveLength(1)
    expect(out.outputFieldMappings[0].targetFieldName).toBe('b')
  })
})
