// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { translations } from '../../lib/translations'
import type { LatestResponse, ResultView } from '../../types'
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

  it.each(['latest', 'run:saved'] as const)('shows only the graph references produced by each step in %s', (id) => {
    const response: LatestResponse = {
      at: undefined, requestId: 'graph', url: '', status: 200, runType: 'agentic_retrieve', requestBody: {},
      body: {
        response: [],
        activity: [
          {
            type: 'graphSearch', id: 0, knowledgeSourceName: 'employees',
            graphSearchArguments: {
              graphIndexName: 'people-graph', naturalLanguageQuery: 'Who employs Rina?',
              gql: 'MATCH (p)-[:worksFor]->(o) RETURN o.name AS organization',
              attempts: 1, modelElapsedMs: 420, outcome: 'Success', modelName: 'graph-model',
              inputTokens: 180, outputTokens: 32,
            },
          },
          { type: 'graphSearch', id: 2, knowledgeSourceName: 'locations' },
        ],
        references: [
          { type: 'graphSearch', id: 'rows', activitySource: 0, sourceData: { columns: ['organization', 'headcount'], rows: [{ headcount: 0, organization: 'Woodgrove' }] } },
          {
            type: 'graphSearch', id: 'evidence', activitySource: '0',
            sourceData: { uid: 'chunk-1', snippet: 'Rina joined Woodgrove.', details: { excerpts: ['Start date: 2026-01-01.'] } },
          },
          { type: 'graphSearch', id: 'empty', activitySource: 2, sourceData: { columns: ['city'], rows: [] } },
          { type: 'graphSearch', id: 'metadata-only', activitySource: 2, graphIndexName: 'locations-graph' },
          { type: 'searchIndex', id: 'text', activitySource: 0, sourceData: { rows: [{ organization: 'Unrelated' }] } },
        ],
      },
    }
    const view: ResultView = { id, label: 'Results', runType: 'agentic_retrieve', response }
    render(<ResultViewPanel
      view={view} displayMode="activity" currentPage={1} onPageChange={vi.fn()}
      t={(key) => translations.en[key]} language="en" compareMode={false} onCompareModeChange={vi.fn()}
    />)
    const employees = within(screen.getByText('employees').closest('.actTimeline__step')!)
    expect(employees.getByText('Who employs Rina?')).toBeInTheDocument()
    expect(employees.getByText(/^MATCH/)).toBeInTheDocument()
    expect(employees.getByText('people-graph')).toBeInTheDocument()
    expect(employees.getByText('graph-model')).toBeInTheDocument()
    expect(employees.getByText('420 ms')).toBeInTheDocument()
    const table = within(employees.getByRole('table', { name: 'Result rows · #rows' }))
    expect(table.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['organization', 'headcount'])
    expect(table.getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['Woodgrove', '0'])
    expect(employees.getByRole('heading', { name: 'Source document · #evidence' })).toBeVisible()
    expect(employees.getByText(/Rina joined Woodgrove/)).toBeVisible()
    expect(employees.queryByText(/Start date:/)).not.toBeInTheDocument()
    fireEvent.click(employees.getByRole('button', { name: '▶ Array[1]' }))
    expect(employees.getByText(/Start date:/)).toBeVisible()
    fireEvent.click(employees.getByRole('button', { name: '▼ Array[1]' }))
    expect(employees.queryByText(/Start date:/)).not.toBeInTheDocument()
    expect(employees.queryByText(/locations-graph|Unrelated/)).not.toBeInTheDocument()

    const locations = within(screen.getByText('locations').closest('.actTimeline__step')!)
    expect(locations.getByText('locations-graph')).toBeInTheDocument()
    expect(locations.getByText('No result rows were returned.')).toBeInTheDocument()
    expect(locations.getByText('The response does not include data for this reference.')).toBeInTheDocument()
    expect(locations.queryByText(/^MATCH|Woodgrove/)).not.toBeInTheDocument()
  })
})