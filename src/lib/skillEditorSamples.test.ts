import { describe, expect, it } from 'vitest'

import { buildSkillEditorSampleCode, buildSkillEditorSampleRequest } from './skillEditorSamples'

describe('skillEditorSamples', () => {
  it('builds a request payload with sample values for ALL inputs', () => {
    const sample = buildSkillEditorSampleRequest([
      { name: 'text', source: '/document/content' },
      { name: 'pageNumber', source: '/document/metadata/pageNumber' },
      { name: 'tags', source: '/document/tags' },
      { name: 'metadata', source: '/document/metadata' },
    ])

    expect(sample.values).toHaveLength(1)
    expect(sample.values[0].data).toEqual({
      text: 'Azure AI Search custom skill sample text for local testing.',
      pageNumber: 1,
      tags: ['sample'],
      metadata: { key: 'value' },
    })
  })

  it('builds python code that extracts all inputs and returns declared output names', () => {
    const sample = buildSkillEditorSampleCode({
      inputs: [
        { name: 'text', source: '/document/content' },
        { name: 'title', source: '/document/title' },
        { name: 'tags', source: '/document/tags' },
        { name: 'metadata', source: '/document/metadata' },
      ],
      outputs: [
        { name: 'result', targetName: 'customResult' },
        { name: 'tagCount', targetName: 'tagCount' },
        { name: 'source', targetName: 'source' },
      ],
      fallbackCode: 'fallback',
    })

    expect(sample).toContain('def process(input: dict) -> dict:')
    // All inputs should be extracted
    expect(sample).toContain('text = input.get("text", "")')
    expect(sample).toContain('title = input.get("title", "")')
    expect(sample).toContain('tags = input.get("tags", "")')
    expect(sample).toContain('metadata = input.get("metadata", "")')
    expect(sample).toContain('text = str(text) + "🌷🌷🌷"')
    expect(sample).toContain('"result": text')
    expect(sample).toContain('"tagCount": text')
    expect(sample).toContain('"source": text')
  })

  it('falls back to the generic code when the skill shape is incomplete', () => {
    expect(buildSkillEditorSampleCode({ fallbackCode: 'fallback' })).toBe('fallback')
    expect(buildSkillEditorSampleCode({ inputs: [{ name: 'text' }], fallbackCode: 'fallback' })).toBe('fallback')
  })
})