// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { translations } from '../../lib/translations'
import { ResultViewPanel } from './ResultViewPanel'

describe('ResultViewPanel', () => {
  it('switches between results and Activity Flow inside the same resultCard', () => {
    const props = {
      view: {
        id: 'latest' as const, label: 'Results (latest)', runType: 'agentic_retrieve' as const,
        response: {
          at: undefined, requestId: 'a', url: '', status: 200, runType: 'agentic_retrieve' as const,
          requestBody: {}, body: { response: [], references: [], activity: [{ type: 'web', id: 1 }] },
        },
      },
      currentPage: 1, onPageChange: vi.fn(),
      t: (key: keyof typeof translations.en) => translations.en[key],
      language: 'en' as const, compareMode: false, onCompareModeChange: vi.fn(),
    }
    function ResultCard() {
      const [mode, setMode] = useState<'results' | 'activity'>('results')
      return <div className="resultCard" data-testid="result-card"><ResultViewPanel {...props} displayMode={mode} onDisplayModeChange={setMode} /></div>
    }
    render(<ResultCard />)
    const card = screen.getByTestId('result-card')
    expect(screen.queryByRole('button', { name: 'Graph' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Activity Flow' }))
    expect(screen.getByTestId('result-card')).toBe(card)
    expect(screen.getByRole('button', { name: 'Activity Flow' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Graph' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trace' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Timeline' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Results (latest)' }))
    expect(screen.getByTestId('result-card')).toBe(card)
    expect(screen.getByRole('button', { name: 'Results (latest)' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: 'Graph' })).not.toBeInTheDocument()
  })

  it('identifies streaming execution before the first event arrives', () => {
    render(
      <ResultViewPanel
        view={{
          id: 'latest',
          label: 'Results (latest)',
          response: null,
          runType: null,
        }}
        currentPage={1}
        onPageChange={vi.fn()}
        t={(key) => translations.ja[key]}
        language="ja"
        compareMode={false}
        onCompareModeChange={vi.fn()}
        isStreamingResponse
      />,
    )

    expect(screen.getByText('ストリーミング中')).toBeInTheDocument()
    expect(screen.getByText('ストリーミング応答を受信中')).toBeInTheDocument()
    expect(screen.getByText('接続し、最初のイベントを待っています。')).toBeInTheDocument()
    expect(screen.queryByText(translations.ja.noResults)).not.toBeInTheDocument()
  })
})