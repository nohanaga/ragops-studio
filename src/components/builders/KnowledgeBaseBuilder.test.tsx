// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrUpdateKnowledgeBase, getKnowledgeBase, listKnowledgeBases } from '../../lib/aiSearchRest'
import type { ConnectionProfile } from '../../lib/model'
import { KnowledgeBaseBuilder } from './KnowledgeBaseBuilder'

afterEach(cleanup)

vi.mock('../../lib/aiSearchRest', () => ({
  createOrUpdateKnowledgeBase: vi.fn(),
  getKnowledgeBase: vi.fn(),
  listKnowledgeBases: vi.fn(),
}))

const profile: ConnectionProfile = {
  name: 'Test',
  endpoint: 'https://test.example',
  apiVersion: '2026-11-01-preview',
  authType: 'apiKey',
  apiKey: 'fake',
}
const result = { ok: true, status: 200, requestId: '', url: '' } as const
const retriever = { kind: 'microsoftRetriever1' }
const azureOpenAI = {
  kind: 'azureOpenAI',
  azureOpenAIParameters: {
    modelName: 'gpt-5', resourceUri: 'https://models.example',
    deploymentId: 'previous-deployment', authIdentity: null,
  },
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(listKnowledgeBases).mockResolvedValue({ ...result, response: { value: [{ name: 'policies' }] } })
  vi.mocked(getKnowledgeBase).mockResolvedValue({
    ...result,
    response: {
      name: 'policies',
      models: [retriever, azureOpenAI],
      knowledgeSources: [{ name: 'ks-index' }],
      retrievalReasoningEffort: { kind: 'auto' },
      outputMode: 'extractiveData',
    },
  })
  vi.mocked(createOrUpdateKnowledgeBase).mockResolvedValue({ ...result, response: {} })
})

describe('Knowledge Base Builder Microsoft Retriever 1', () => {
  it('edits the Azure OpenAI deployment without replacing Retriever 1 and can remove the external model', async () => {
    render(<KnowledgeBaseBuilder profile={profile} language="en" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'policies' }))

    const useRetriever = screen.getByRole('checkbox', { name: 'Use Microsoft Retriever 1' })
    await waitFor(() => expect(useRetriever).toBeChecked())
    expect(screen.getByRole('combobox', { name: /Retrieval Reasoning Effort/ })).toHaveValue('auto')
    const deployment = screen.getByRole('textbox', { name: /deploymentId/ })
    expect(deployment).toHaveValue('previous-deployment')
    fireEvent.change(deployment, { target: { value: 'new-deployment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(createOrUpdateKnowledgeBase).toHaveBeenLastCalledWith(expect.objectContaining({
      body: expect.objectContaining({
        models: [retriever, { ...azureOpenAI, azureOpenAIParameters: { ...azureOpenAI.azureOpenAIParameters, deploymentId: 'new-deployment' } }],
        retrievalReasoningEffort: { kind: 'auto' },
      }),
    }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled())
    fireEvent.change(screen.getByRole('combobox', { name: /Azure OpenAI model/ }), { target: { value: '' } })
    expect(useRetriever).toBeChecked()
    expect(screen.getByRole('combobox', { name: /Retrieval Reasoning Effort/ })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: /outputMode/ })).toHaveValue('extractiveData')
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(createOrUpdateKnowledgeBase).toHaveBeenLastCalledWith(expect.objectContaining({
      body: expect.objectContaining({ models: [retriever], retrievalReasoningEffort: { kind: 'minimal' } }),
    }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled())
  })

  it('disables Retriever 1 and prevents a stale Retriever 1 configuration from being saved with the August API', async () => {
    render(<KnowledgeBaseBuilder profile={{ ...profile, apiVersion: '2026-08-01-preview' }} language="en" onClose={vi.fn()} />)
    const useRetriever = screen.getByRole('checkbox', { name: 'Use Microsoft Retriever 1' })
    expect(useRetriever).toBeDisabled()
    expect(useRetriever).toHaveAccessibleDescription(/2026-11-01-preview/)
    fireEvent.click(await screen.findByRole('button', { name: 'policies' }))

    await waitFor(() => expect(useRetriever).toBeChecked())
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled()
    expect(createOrUpdateKnowledgeBase).not.toHaveBeenCalled()
  })
})
