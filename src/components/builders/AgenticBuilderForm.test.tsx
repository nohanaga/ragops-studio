// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { translations } from '../../lib/translations'
import type { AgenticFormState } from '../../types'
import { AgenticBuilderForm } from './AgenticBuilderForm'

afterEach(cleanup)

const baseAgenticForm: AgenticFormState = {
  userMessage: 'What changed?',
  includeActivity: true,
  outputMode: 'answerSynthesis',
  maxRuntimeInSeconds: 60,
  maxOutputSize: 100000,
  retrievalReasoningEffort: 'auto',
  streamResponse: true,
  knowledgeSourceParams: [],
}

function WebKnowledgeSourceForm() {
  const [agenticForm, setAgenticForm] = useState<AgenticFormState>({
    ...baseAgenticForm,
    knowledgeSourceParams: [{
      knowledgeSourceName: 'ks-web-646',
      kind: 'web',
      includeReferences: true,
      includeReferenceSourceData: true,
      alwaysQuerySource: false,
      neverQuerySource: false,
      resultsProcessing: 'rerank',
      maxOutputDocuments: '',
      queryHintOverrides: '',
    }],
  })

  return (
    <AgenticBuilderForm
      t={(key) => key}
      language="ja"
      agenticForm={agenticForm}
      setAgenticForm={setAgenticForm}
      availableKnowledgeSources={[{ name: 'ks-web-646', kind: 'web' }]}
      effectiveApiVersion="2026-08-01-preview"
    />
  )
}

describe('AgenticBuilderForm', () => {
  it('groups Blob settings by purpose and keeps localized help on the graph fields', () => {
    const language = 'ja'
    render(
      <AgenticBuilderForm
        t={(key) => translations[language][key]}
        language={language}
        agenticForm={{
          ...baseAgenticForm,
          toolName: 'graph-search',
          knowledgeSourceParams: [{
            knowledgeSourceName: 'blob-source',
            kind: 'azureBlob',
            includeReferences: true,
            includeReferenceSourceData: true,
            resultsProcessing: '',
            neverQuerySource: false,
            maxOutputDocuments: '',
            queryHintOverrides: '',
            topicGraph: { kind: 'diverse' },
            graphParameters: { provenance: { kind: 'hydrate' } },
          }],
        }}
        setAgenticForm={vi.fn()}
        availableKnowledgeSources={[{ name: 'blob-source', kind: 'azureBlob' }]}
        availableKnowledgeTools={[{ name: 'graph-search', sources: ['blob-source'], reasoningEffort: 'minimal' }]}
        effectiveApiVersion="2026-11-01-preview"
      />,
    )

    const references = within(screen.getByRole('group', { name: '参照' }))
    const retrieval = within(screen.getByRole('group', { name: '取得' }))
    const topicGraph = within(screen.getByRole('group', { name: 'トピックグラフ' }))
    const entityGraph = within(screen.getByRole('group', { name: 'エンティティグラフ' }))

    expect(screen.getByTitle(/推論レベル・出力モード・取得上限をリクエストで上書きしません/)).toBeVisible()
    expect(references.getByRole('checkbox', { name: /includeReferenceSourceData/ })).toBeChecked()
    expect(retrieval.getByRole('textbox', { name: /filterAddOn/ })).toBeVisible()
    expect(topicGraph.getByTitle(/ソースに保存されたトピックグラフ/)).toBeVisible()
    expect(topicGraph.getByTitle(/250〜10,000/)).toBeVisible()
    expect(topicGraph.getByTitle(/値が大きいほど結果の多様性/)).toBeVisible()
    expect(entityGraph.getByTitle(/生成したグラフクエリ/)).toBeVisible()
    expect(entityGraph.getByTitle(/根拠文書の件数の上限/)).toBeVisible()
  })

  it('shows common runtime parameters for web sources without query hints', () => {
    render(<WebKnowledgeSourceForm />)

    expect(screen.getByRole('checkbox', { name: 'knowledgeSourceRequestOverride' })).toBeChecked()
    expect(screen.getByText('includeReferences')).toBeInTheDocument()
    expect(screen.getByText('includeReferenceSourceData')).toBeInTheDocument()
    expect(screen.getByText('alwaysQuerySource')).toBeInTheDocument()
    expect(screen.getByText('neverQuerySource')).toBeInTheDocument()
    expect(screen.getByText('resultsProcessing')).toBeInTheDocument()
    expect(screen.getByText('maxOutputDocuments')).toBeInTheDocument()
    expect(screen.queryByText('queryHintOverrides')).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /GraphSettings/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'knowledgeSourceRequestOverride' }))

    expect(screen.getByText('ks-web-646')).toBeInTheDocument()
    expect(screen.queryByText('includeReferences')).not.toBeInTheDocument()
  })
})