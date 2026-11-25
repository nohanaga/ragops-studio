// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { addArtifact, createExperiment, createRun } from '../lib/db'
import type { ConnectionProfile } from '../lib/model'
import { translations } from '../lib/translations'
import { useKnowledgeBaseData } from '../hooks/useKnowledgeBaseData'
import { useRunRestore } from '../hooks/useRunRestore'
import { useSelectedRunsArtifacts } from '../hooks/useSelectedRunsArtifacts'
import { server } from '../test/mswServer'
import { buildAgenticBodyFromForm } from '../utils/appRequestBodies'
import { BuilderStateProvider, useBuilderState } from './index'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function wrapper({ children }: { children: ReactNode }) {
  return <BuilderStateProvider language="en">{children}</BuilderStateProvider>
}

it('clears old overrides on history selection and preserves saved overrides on explicit restoration', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  const savedRequest = {
    toolName: 'policy-tool', outputMode: 'extractiveData', retrievalReasoningEffort: { kind: 'minimal' },
    intents: [{ type: 'semantic', search: 'Find policy changes' }], maxOutputSizeInTokens: 50,
    knowledgeSourceParams: [{
      knowledgeSourceName: 'policy-source', kind: 'searchIndex', filterAddOn: "region eq 'CA'",
      includeReferences: true, includeReferenceSourceData: false, neverQuerySource: false,
      resultsProcessing: 'rerank', maxOutputDocuments: '', queryHintOverrides: '',
    }],
  }

  const { experimentId } = await createExperiment({ name: 'KB history test' })
  const seedRun = (knowledgeBaseName: string) => createRun({
    experimentId, runType: 'agentic_retrieve', status: 'success',
    startedAt: '2026-11-25T00:00:00.000Z',
    context: { knowledgeBaseName, endpoint: 'https://example.search.windows.net', apiVersion: '2026-11-01-preview', authType: 'apiKey' },
    params: savedRequest, metrics: {},
  })
  const policyRun = await seedRun('policy-kb')
  const otherRun = await seedRun('other-kb')
  await addArtifact({ runId: policyRun.runId, type: 'request_json', content: JSON.stringify(savedRequest) })

  const noop = () => {}
  const { result, rerender } = renderHook(({ selectedRunIds }) => {
    const builder = useBuilderState()
    useSelectedRunsArtifacts({
      ...builder, selectedRunIds, setSelectedRun: noop, setRunResultMap: noop, setResultPages: noop,
    })
    const { onRestoreRun } = useRunRestore({
      ...builder, t: (key) => translations.en[key], format: (key) => translations.en[key],
      setQpsTesterRestoreRunId: noop, setIsQpsTesterOpen: noop, setAutoTuningRestoreRunId: noop, setIsAutoTuningOpen: noop,
      setCenterTab: noop, setLatestResponse: noop, setRunResultMap: noop, setResultPages: noop,
    })
    return { ...builder, onRestoreRun }
  }, { wrapper, initialProps: { selectedRunIds: [] as string[] } })

  const restorePolicyRun = () => act(() => result.current.onRestoreRun(policyRun.runId))
  const outgoingRequest = () => buildAgenticBodyFromForm(result.current.agenticForm, '2026-11-01-preview')
  await restorePolicyRun()
  expect(result.current.knowledgeBaseName).toBe('policy-kb')
  expect(outgoingRequest()).toMatchObject({ toolName: 'policy-tool', maxOutputSizeInTokens: 50, knowledgeSourceParams: [{ filterAddOn: "region eq 'CA'" }] })
  expect(outgoingRequest()).not.toHaveProperty('maxOutputSize')

  rerender({ selectedRunIds: [otherRun.runId] })
  await waitFor(() => expect(result.current.knowledgeBaseName).toBe('other-kb'))
  expect(outgoingRequest()).not.toHaveProperty('toolName')
  expect(outgoingRequest()).not.toHaveProperty('knowledgeSourceParams')

  await restorePolicyRun()
  expect(result.current.knowledgeBaseName).toBe('policy-kb')
  expect(outgoingRequest()).toMatchObject({ toolName: 'policy-tool', knowledgeSourceParams: [{ filterAddOn: "region eq 'CA'" }] })
})

it('applies standalone Retriever 1 defaults without constraining a KB with an external model', async () => {
  const profile: ConnectionProfile = {
    endpoint: 'https://example.search.windows.net', apiVersion: '2026-11-01-preview', authType: 'apiKey', apiKey: 'test-key',
  }
  server.use(
    http.get('/api-proxy/knowledgebases', () => HttpResponse.json({ value: [] })),
    http.get('/api-proxy/knowledgesources', () => HttpResponse.json({ value: [] })),
    http.get('/api-proxy/knowledgebases/:name', ({ params }) => HttpResponse.json({
      knowledgeSources: [{ name: 'policies', kind: 'searchIndex' }],
      models: [{ kind: 'microsoftRetriever1' }, ...(params.name === 'mixed' ? [{ kind: 'azureOpenAI' }] : [])],
    })),
  )
  const { result } = renderHook(() => {
    const builder = useBuilderState()
    const knowledgeBase = useKnowledgeBaseData({
      ...builder, labMode: 'agentic', activeProfile: profile, editingKnowledgeBase: false, language: 'en',
    })
    return { ...builder, ...knowledgeBase }
  }, { wrapper })

  act(() => result.current.setKnowledgeBaseName('standalone'))
  await waitFor(() => expect(result.current.standaloneRetriever1).toBe(true))
  expect(result.current.agenticForm).toMatchObject({ retrievalReasoningEffort: 'minimal', outputMode: 'extractiveData' })

  act(() => {
    result.current.setKnowledgeBaseName('mixed')
    result.current.setAgenticForm((form) => ({ ...form, retrievalReasoningEffort: 'auto', outputMode: 'answerSynthesis' }))
  })
  await waitFor(() => expect(result.current.availableKnowledgeSources).toHaveLength(1))
  expect(result.current.standaloneRetriever1).toBe(false)
  expect(result.current.agenticForm).toMatchObject({ retrievalReasoningEffort: 'auto', outputMode: 'answerSynthesis' })
})
