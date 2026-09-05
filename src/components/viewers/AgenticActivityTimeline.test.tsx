// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { translations } from '../../lib/translations'
import { AgenticActivityTimeline } from './AgenticActivityTimeline'

describe('AgenticActivityTimeline', () => {
  it('shows requested and billed reasoning efforts separately', () => {
    render(
      <AgenticActivityTimeline
        activity={[{
          type: 'agenticReasoning',
          id: 4,
          reasoningTokens: 78,
          retrievalReasoningEffort: { kind: 'low' },
          logicalReasoningEffort: { kind: 'auto' },
        }]}
        t={(key) => translations.ja[key]}
      />,
    )

    expect(screen.getByText('要求値 (logical)')).toBeInTheDocument()
    expect(screen.getByText('auto')).toBeInTheDocument()
    expect(screen.getByText('課金値 (retrieval)')).toBeInTheDocument()
    expect(screen.getByText('low')).toBeInTheDocument()
  })

  it('shows web summarization as a dedicated model activity', () => {
    render(
      <AgenticActivityTimeline
        activity={[{
          type: 'modelWebSummarization',
          id: 2,
          inputTokens: 120,
          outputTokens: 40,
          elapsedMs: 350,
          model: {
            modelName: 'gpt-5-mini',
            deploymentId: 'web-summary-model',
          },
        }]}
        t={(key) => translations.ja[key]}
      />,
    )

    const badge = screen.getByText('modelWebSummarization')
    expect(badge.querySelector('.bi-file-text')).toBeInTheDocument()
    expect(screen.getByText('gpt-5-mini')).toBeInTheDocument()
    expect(screen.getByText('web-summary-model')).toBeInTheDocument()
    expect(screen.getAllByText('120')).toHaveLength(2)
    expect(screen.getAllByText('40')).toHaveLength(2)
  })
})