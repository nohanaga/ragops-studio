// @vitest-environment jsdom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { SearchApiVersion } from '../../lib/model'
import { applyGraphIndexTemplate } from '../../lib/indexGraphProfiles'
import { IndexSchemaConfigurationEditorPanel, IndexSchemaOverview, type ConfigEditorTab } from './IndexSchemaOverview'
import type { IndexSchemaTemplateKind } from './indexSchemaTemplates'

afterEach(cleanup)

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

function chunkIndexDefinition(): Record<string, unknown> {
  return {
    name: 'docs',
    fields: [
      { name: 'id', type: 'Edm.String', key: true },
      { name: 'embedding', type: 'Collection(Edm.Single)', dimensions: 8, vectorSearchProfile: 'vp' },
      { name: 'embedding2', type: 'Collection(Edm.Single)', dimensions: 8, vectorSearchProfile: 'vp' },
    ],
    vectorSearch: {
      profiles: [{ name: 'vp', algorithm: 'hnsw', vectorizer: 'vz' }],
      algorithms: [{ name: 'hnsw', kind: 'hnsw' }],
      vectorizers: [{ name: 'vz', kind: 'azureOpenAI' }],
    },
  }
}

function GraphHarness({ initial, activeTab, apiVersion = '2026-11-01-preview' }: {
  initial: Record<string, unknown>
  activeTab: ConfigEditorTab
  apiVersion?: SearchApiVersion
}) {
  const [index, setIndex] = useState<Record<string, unknown>>(initial)

  return (
    <>
      <IndexSchemaConfigurationEditorPanel
        editedJson={JSON.stringify(index)}
        baselineJson=""
        isExistingIndex={false}
        language="ja"
        apiVersion={apiVersion}
        indexNames={['docs', 'people-chunks', 'docs-topics']}
        activeTab={activeTab}
        onActiveTabChange={() => {}}
        onChangeIndex={setIndex}
      />
      <output data-testid="index-json">{JSON.stringify(index)}</output>
    </>
  )
}

const currentIndex = (): Record<string, unknown> => JSON.parse(screen.getByTestId('index-json').textContent ?? '{}')

describe('IndexSchemaConfigurationEditorPanel graph profile editor', () => {
  it('adds the edge-list fields and maps every role without validation issues', () => {
    render(<GraphHarness initial={{ name: 'people-graph', fields: [] }} activeTab="graphProfile" />)

    fireEvent.click(screen.getByRole('button', { name: /グラフ用フィールドを追加/ }))

    const index = currentIndex()
    expect(index.graphProfile).toMatchObject({ kind: 'edgeList', fields: { assertionIdField: 'id', subjectField: 'subject', sourceChunkIdField: 'chunk_id' } })
    expect((index.fields as unknown[]).length).toBe(22)
    expect(screen.getByText('22 / 22 件を割り当て済み')).toBeInTheDocument()
    expect(screen.getByText('問題は見つかりません。')).toBeInTheDocument()
  })

  it('offers only compatible fields and flags an existing mapping with the wrong type', () => {
    render(<GraphHarness initial={{ name: 'g', fields: [] }} activeTab="graphProfile" />)
    fireEvent.click(screen.getByRole('button', { name: /グラフ用フィールドを追加/ }))

    const confidenceSelect = screen.getByText('confidenceField').closest('label')?.querySelector('select') as HTMLSelectElement
    const options = within(confidenceSelect).getAllByRole('option').map((option) => option.textContent)
    expect(options).toContain('object_double')
    expect(options).not.toContain('subject')

    fireEvent.change(confidenceSelect, { target: { value: 'object_double' } })
    expect((currentIndex().graphProfile as { fields: Record<string, string> }).fields.confidenceField).toBe('object_double')
    expect(screen.getByText(/フィールド object_double が複数のロール/)).toBeInTheDocument()
  })

  it('shows the type problem of an existing mapping', () => {
    const complete = applyGraphIndexTemplate({ name: 'g', fields: [] })
    const index = { ...complete, graphProfile: { ...(complete.graphProfile as Record<string, unknown>), fields: { ...(complete.graphProfile as { fields: Record<string, string> }).fields, confidenceField: 'subject' } } }
    render(<GraphHarness initial={index} activeTab="graphProfile" />)

    expect(screen.getByText(/confidenceField: フィールド subject の型は Edm.Double である必要があります/)).toBeInTheDocument()
    const confidenceSelect = screen.getByText('confidenceField').closest('label')?.querySelector('select') as HTMLSelectElement
    expect(confidenceSelect.value).toBe('subject')
    expect(within(confidenceSelect).getByRole('option', { name: 'subject (Edm.String)' })).toBeInTheDocument()
  })

  it('stays read-only when the API version does not support the graph schema', () => {
    render(<GraphHarness initial={{ name: 'g', fields: [] }} activeTab="graphProfile" apiVersion="2026-08-01-preview" />)

    expect(screen.getByText(/2026-11-01-preview を選択してください/)).toBeInTheDocument()
    expect((screen.getByRole('button', { name: /グラフプロファイルを追加/ }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /グラフ用フィールドを追加/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('IndexSchemaConfigurationEditorPanel topic graph editor', () => {
  it('adds a profile, links the first vector field and hides properties the kind does not allow', () => {
    render(<GraphHarness initial={chunkIndexDefinition()} activeTab="topicGraph" />)

    fireEvent.click(screen.getByRole('button', { name: /プロファイルを追加/ }))
    let index = currentIndex()
    expect((index.vectorSearch as { topicGraphProfiles: unknown[] }).topicGraphProfiles).toEqual([{ name: 'embedding-topics', defaultKind: 'balanced' }])
    expect((index.fields as Array<{ name: string; topicGraphProfile?: string }>).map((field) => field.topicGraphProfile)).toEqual([undefined, 'embedding-topics', undefined])
    expect(screen.getByLabelText('name')).toHaveProperty('value', 'embedding-topics')
    expect(screen.queryByText('defaultDiversityFactor')).toBeNull()
    expect(screen.getByText('defaultMinDiversityPoolSize')).toBeInTheDocument()

    const kindSelect = screen.getByText('defaultKind').closest('label')?.querySelector('select') as HTMLSelectElement
    fireEvent.change(kindSelect, { target: { value: 'diverse' } })
    expect(screen.getByText('defaultDiversityFactor')).toBeInTheDocument()

    const poolInput = screen.getByText('defaultMinDiversityPoolSize').closest('label')?.querySelector('input') as HTMLInputElement
    fireEvent.change(poolInput, { target: { value: '500' } })
    fireEvent.change(kindSelect, { target: { value: 'none' } })

    index = currentIndex()
    expect((index.vectorSearch as { topicGraphProfiles: unknown[] }).topicGraphProfiles).toEqual([{ name: 'embedding-topics', defaultKind: 'none' }])
    expect(screen.queryByText('defaultDiversityFactor')).toBeNull()
    expect(screen.queryByText('defaultMinDiversityPoolSize')).toBeNull()
  })

  it('renames a profile on blur and keeps the vector field linked', () => {
    render(<GraphHarness initial={chunkIndexDefinition()} activeTab="topicGraph" />)
    fireEvent.click(screen.getByRole('button', { name: /プロファイルを追加/ }))

    const nameInput = screen.getByLabelText('name') as HTMLInputElement
    nameInput.focus()
    fireEvent.change(nameInput, { target: { value: '' } })
    fireEvent.change(nameInput, { target: { value: 'content-topics' } })

    expect(document.activeElement).toBe(nameInput)
    expect((currentIndex().vectorSearch as { topicGraphProfiles: Array<{ name: string }> }).topicGraphProfiles[0].name).toBe('embedding-topics')

    fireEvent.blur(nameInput)

    const index = currentIndex()
    expect((index.vectorSearch as { topicGraphProfiles: Array<{ name: string }> }).topicGraphProfiles[0].name).toBe('content-topics')
    expect((index.fields as Array<{ topicGraphProfile?: string }>)[1].topicGraphProfile).toBe('content-topics')
  })

  it('links another vector field through the field link list', () => {
    render(<GraphHarness initial={chunkIndexDefinition()} activeTab="topicGraph" />)
    fireEvent.click(screen.getByRole('button', { name: /プロファイルを追加/ }))

    const linkSelect = screen.getByText('フィールド: embedding2').closest('label')?.querySelector('select') as HTMLSelectElement
    fireEvent.change(linkSelect, { target: { value: 'embedding-topics' } })

    expect((currentIndex().fields as Array<{ topicGraphProfile?: string }>)[2].topicGraphProfile).toBe('embedding-topics')
    expect(screen.getByText(/複数のベクトルフィールド \(embedding, embedding2\) からリンクされています/)).toBeInTheDocument()
  })

  it('stays read-only when the API version does not support topic graph profiles', () => {
    render(<GraphHarness initial={chunkIndexDefinition()} activeTab="topicGraph" apiVersion="2026-08-01-preview" />)

    expect((screen.getByRole('button', { name: /プロファイルを追加/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/2026-11-01-preview を選択してください/)).toBeInTheDocument()
  })
})

describe('IndexSchemaOverview 2026-11-01-preview graph features', () => {
  function linkedIndex(): Record<string, unknown> {
    const index = chunkIndexDefinition()
    ;(index.vectorSearch as Record<string, unknown>).topicGraphProfiles = [{ name: 'topics', indexName: 'docs-topics', defaultKind: 'balanced' }]
    index.fields = (index.fields as Array<Record<string, unknown>>).map((field) => (field.name === 'embedding' ? { ...field, topicGraphProfile: 'topics' } : field))
    return index
  }

  function OverviewHarness({ baseline, apiVersion = '2026-11-01-preview' }: {
    baseline: string
    apiVersion?: SearchApiVersion
  }) {
    const [index, setIndex] = useState<Record<string, unknown>>(linkedIndex)
    return (
      <>
        <IndexSchemaOverview
          editedJson={JSON.stringify(index)}
          baselineJson={baseline}
          isExistingIndex
          language="ja"
          apiVersion={apiVersion}
          indexNames={['docs', 'docs-topics']}
          onApplyTemplate={() => {}}
          onOpenConfigEditorTab={() => {}}
          onOpenSynonymMapBuilder={() => {}}
          synonymMapNames={[]}
          onChangeIndex={setIndex}
        />
        <output data-testid="index-json">{JSON.stringify(index)}</output>
      </>
    )
  }

  it('summarizes the topic graph link and edits it from the vector field dialog of an existing index', () => {
    render(<OverviewHarness baseline={JSON.stringify(linkedIndex())} />)

    const topicCard = screen.getByText('トピックグラフ', { selector: '.indexSchemaFeature__name' }).closest('.indexSchemaFeature') as HTMLElement
    expect(within(topicCard).getByText('1/1')).toBeInTheDocument()
    expect(within(topicCard).getByText('設定済み')).toBeInTheDocument()
    const graphCard = screen.getByText('グラフプロファイル', { selector: '.indexSchemaFeature__name' }).closest('.indexSchemaFeature') as HTMLElement
    expect(within(graphCard).getByText('未設定')).toBeInTheDocument()

    const row = screen.getByText('embedding', { selector: '.indexSchemaFieldMatrix__path' }).closest('tr') as HTMLElement
    fireEvent.click(within(row).getAllByRole('button', { name: /編集/ })[1])

    const topicInput = document.querySelector('input[list="indexBuilderTopicGraphProfileNames"]') as HTMLInputElement
    expect(topicInput.value).toBe('topics')
    expect(topicInput.disabled).toBe(false)

    fireEvent.change(topicInput, { target: { value: 'other-topics' } })

    const fields = currentIndex().fields as Array<{ name: string; topicGraphProfile?: string }>
    expect(fields.find((field) => field.name === 'embedding')?.topicGraphProfile).toBe('other-topics')
    expect(screen.getByText(/トピックグラフ: \d+ 件の確認事項/)).toBeInTheDocument()
  })

  it('reports index features that the selected API version cannot save and hides the graph templates', () => {
    render(<OverviewHarness baseline="" apiVersion="2026-08-01-preview" />)

    expect(screen.getByText(/vectorSearch.topicGraphProfiles, fields\[\].topicGraphProfile を利用するには API バージョン 2026-11-01-preview が必要です/)).toBeInTheDocument()
    for (const label of ['グラフプロファイル', 'トピックグラフ']) {
      const card = screen.getByText(label, { selector: '.indexSchemaFeature__name' }).closest('.indexSchemaFeature') as HTMLElement
      expect(within(card).queryByRole('button', { name: /追加/ })).toBeNull()
    }
  })

  it('offers the graph templates only when the API version supports them', () => {
    const applied: IndexSchemaTemplateKind[] = []
    const index = chunkIndexDefinition()
    render(
      <IndexSchemaOverview
        editedJson={JSON.stringify(index)}
        baselineJson=""
        isExistingIndex={false}
        language="ja"
        apiVersion="2026-11-01-preview"
        onApplyTemplate={(kind) => applied.push(kind)}
        onOpenConfigEditorTab={() => {}}
        onOpenSynonymMapBuilder={() => {}}
        synonymMapNames={[]}
        onChangeIndex={() => {}}
      />,
    )

    const topicCard = screen.getByText('トピックグラフ', { selector: '.indexSchemaFeature__name' }).closest('.indexSchemaFeature') as HTMLElement
    fireEvent.click(within(topicCard).getByRole('button', { name: /追加/ }))
    const graphCard = screen.getByText('グラフプロファイル', { selector: '.indexSchemaFeature__name' }).closest('.indexSchemaFeature') as HTMLElement
    fireEvent.click(within(graphCard).getByRole('button', { name: /追加/ }))

    expect(applied).toEqual(['topicGraph', 'graphProfile'])
  })
})

describe('IndexSchemaConfigurationEditorPanel 2026-11-01-preview vectorizer and scoring additions', () => {
  it('edits the OpenAI-compatible vectorizer parameters without dropping the stored headers', () => {
    const index = chunkIndexDefinition()
    ;(index.vectorSearch as Record<string, unknown>).vectorizers = [{
      name: 'oai',
      kind: 'openAICompatible',
      openAICompatibleParameters: { uri: 'https://example.com/v1/embeddings', modelName: 'text-embedding-3-small', headers: { Authorization: 'secret' } },
    }]
    render(<GraphHarness initial={index} activeTab="vectorProfiles" />)

    const dimensions = screen.getByText('dimensions').closest('label')?.querySelector('input') as HTMLInputElement
    fireEvent.change(dimensions, { target: { value: '512' } })

    const parameters = ((currentIndex().vectorSearch as { vectorizers: Array<{ openAICompatibleParameters: Record<string, unknown> }> }).vectorizers[0]).openAICompatibleParameters
    expect(parameters).toEqual({ uri: 'https://example.com/v1/embeddings', modelName: 'text-embedding-3-small', dimensions: 512, headers: { Authorization: 'secret' } })
  })

  it('switches a scoring function to random without a field or boost', () => {
    const index = chunkIndexDefinition()
    index.scoringProfiles = [{ name: 'p', functions: [{ type: 'magnitude', fieldName: 'rating', boost: 2, interpolation: 'linear', magnitude: { boostingRangeStart: 0, boostingRangeEnd: 5 } }] }]
    render(<GraphHarness initial={index} activeTab="scoringProfiles" />)

    const typeSelect = screen.getByDisplayValue('magnitude') as HTMLSelectElement
    fireEvent.change(typeSelect, { target: { value: 'random' } })

    expect((currentIndex().scoringProfiles as Array<{ functions: unknown[] }>)[0].functions).toEqual([{ type: 'random', interpolation: 'linear' }])
    expect(screen.getByText('seedParameter')).toBeInTheDocument()
    expect(screen.queryByText('boost')).toBeNull()

    const seed = screen.getByText('seedParameter').closest('label')?.querySelector('input') as HTMLInputElement
    fireEvent.change(seed, { target: { value: 'seed' } })
    expect((currentIndex().scoringProfiles as Array<{ functions: unknown[] }>)[0].functions).toEqual([{ type: 'random', interpolation: 'linear', random: { seedParameter: 'seed' } }])
  })
})