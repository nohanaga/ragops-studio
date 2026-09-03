// @vitest-environment jsdom

import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { IndexSchemaConfigurationEditorPanel, type ConfigEditorTab } from './IndexSchemaOverview'

function createIndexDefinition(): Record<string, unknown> {
  return {
    name: 'focus-test',
    fields: [
      { name: 'id', type: 'Edm.String', key: true, searchable: true, filterable: true, retrievable: true },
      { name: 'score', type: 'Edm.Double', filterable: true },
    ],
    semantic: {
      configurations: [{ name: 'semantic-a', prioritizedFields: {} }],
    },
    scoringProfiles: [{
      name: 'scoring-a',
      text: { weights: {} },
      functions: [{
        type: 'magnitude',
        fieldName: 'score-field-a',
        boost: 2,
        interpolation: 'linear',
        magnitude: { boostingRangeStart: 0, boostingRangeEnd: 10 },
      }],
    }],
    suggesters: [{ name: 'suggester-a', searchMode: 'analyzingInfixMatching', sourceFields: ['id'] }],
    analyzers: [{
      name: 'analyzer-a',
      '@odata.type': '#Microsoft.Azure.Search.CustomAnalyzer',
      tokenizer: 'tokenizer-a',
    }],
    tokenizers: [{ name: 'tokenizer-a', '@odata.type': '#Microsoft.Azure.Search.StandardTokenizerV2' }],
    charFilters: [{ name: 'char-filter-a', '@odata.type': '#Microsoft.Azure.Search.MappingCharFilter', mappings: [] }],
    tokenFilters: [{ name: 'token-filter-a', '@odata.type': '#Microsoft.Azure.Search.AsciiFoldingTokenFilter' }],
    normalizers: [{
      name: 'normalizer-a',
      '@odata.type': '#Microsoft.Azure.Search.CustomNormalizer',
      charFilters: [],
      tokenFilters: ['lowercase'],
    }],
    vectorSearch: {
      profiles: [{ name: 'vector-profile-a', algorithm: 'vector-algorithm-a', vectorizer: 'vectorizer-a', compression: 'compression-a' }],
      algorithms: [{ name: 'vector-algorithm-a', kind: 'hnsw', hnswParameters: { metric: 'cosine' } }],
      vectorizers: [{ name: 'vectorizer-a', kind: 'azureOpenAI', azureOpenAIParameters: {} }],
      compressions: [{ name: 'compression-a', kind: 'scalarQuantization' }],
    },
  }
}

function EditorHarness({ activeTab }: { activeTab: ConfigEditorTab }) {
  const [index, setIndex] = useState<Record<string, unknown>>(createIndexDefinition)

  return (
    <IndexSchemaConfigurationEditorPanel
      editedJson={JSON.stringify(index)}
      baselineJson=""
      isExistingIndex
      language="ja"
      activeTab={activeTab}
      onActiveTabChange={() => {}}
      onChangeIndex={setIndex}
    />
  )
}

describe('IndexSchemaConfigurationEditorPanel focus retention', () => {
  it.each([
    ['semantic', 'semantic-a'],
    ['scoringProfiles', 'scoring-a'],
    ['scoringProfiles', 'score-field-a'],
    ['suggesters', 'suggester-a'],
    ['analyzers', 'analyzer-a'],
    ['analyzers', 'tokenizer-a'],
    ['analyzers', 'char-filter-a'],
    ['analyzers', 'token-filter-a'],
    ['normalizers', 'normalizer-a'],
    ['vectorProfiles', 'vector-profile-a'],
    ['vectorProfiles', 'vector-algorithm-a'],
    ['vectorProfiles', 'vectorizer-a'],
    ['vectorProfiles', 'compression-a'],
  ] satisfies Array<[ConfigEditorTab, string]>)('retains focus in the %s editor when editing %s', (activeTab, initialValue) => {
    render(<EditorHarness activeTab={activeTab} />)
    const matchingInputs = screen.getAllByDisplayValue(initialValue) as HTMLInputElement[]
    const input = matchingInputs[matchingInputs.length - 1]

    input.focus()
    fireEvent.change(input, { target: { value: `${initialValue}-edited` } })

    expect(document.activeElement).toBe(input)
    expect(input.value).toBe(`${initialValue}-edited`)
  })
})