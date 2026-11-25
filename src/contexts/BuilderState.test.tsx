// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it } from 'vitest'
import type { AgenticFormState } from '../types'
import { BuilderStateProvider, useBuilderState } from './index'

afterEach(cleanup)

function wrapper({ children }: { children: ReactNode }) {
  return <BuilderStateProvider language="en">{children}</BuilderStateProvider>
}

it('clears KB-specific overrides on a history switch but preserves overrides explicitly restored for the target', () => {
  const { result } = renderHook(useBuilderState, { wrapper })
  const savedForm: AgenticFormState = {
    ...result.current.agenticForm,
    userMessage: 'Find policy changes',
    toolName: 'policy-tool',
    useToolDefaults: false,
    knowledgeSourceParams: [{
      knowledgeSourceName: 'policy-source', kind: 'searchIndex', filterAddOn: "region eq 'CA'",
      includeReferences: true, includeReferenceSourceData: false, neverQuerySource: false,
      resultsProcessing: 'rerank', maxOutputDocuments: '', queryHintOverrides: '',
    }],
  }

  act(() => {
    result.current.setKnowledgeBaseName('policy-kb')
    result.current.setAgenticForm(savedForm)
  })
  act(() => result.current.setKnowledgeBaseName('policy-kb'))
  expect(result.current.agenticForm).toEqual(savedForm)

  act(() => result.current.setKnowledgeBaseName('other-kb'))
  expect(result.current.agenticForm).toEqual({ ...savedForm, toolName: '', useToolDefaults: true, knowledgeSourceParams: [] })

  act(() => {
    result.current.setKnowledgeBaseName('policy-kb')
    result.current.setAgenticForm(savedForm)
  })
  expect(result.current.knowledgeBaseName).toBe('policy-kb')
  expect(result.current.agenticForm).toEqual(savedForm)
})
