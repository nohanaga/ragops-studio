// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'

import type { AgenticFormState } from '../../types'
import { AgenticBuilderForm } from './AgenticBuilderForm'

function WebKnowledgeSourceForm() {
  const [agenticForm, setAgenticForm] = useState<AgenticFormState>({
    userMessage: 'What changed?',
    includeActivity: true,
    outputMode: 'answerSynthesis',
    maxRuntimeInSeconds: 60,
    maxOutputSize: 100000,
    retrievalReasoningEffort: 'auto',
    streamResponse: true,
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

    fireEvent.click(screen.getByRole('checkbox', { name: 'knowledgeSourceRequestOverride' }))

    expect(screen.getByText('ks-web-646')).toBeInTheDocument()
    expect(screen.queryByText('includeReferences')).not.toBeInTheDocument()
  })
})