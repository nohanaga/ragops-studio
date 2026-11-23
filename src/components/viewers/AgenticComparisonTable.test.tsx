// @vitest-environment jsdom

import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '../../lib/aiSearchRest'
import type { ResultView } from '../../types'
import { SearchComparisonTable } from './AgenticComparisonTable'

function agenticRun(id: string, keys: (string | null)[], { graph, synthesize, source = 'content', runStatus }: {
  graph?: JsonValue
  synthesize?: boolean
  source?: string
  runStatus?: 'canceled'
} = {}): ResultView {
  const chunks = keys.map((key, index) => ({ ref_id: `${id}-${index}`, title: key ?? 'Unknown document' }))
  return {
    id: `run:${id}`,
    label: id,
    runType: 'agentic_retrieve',
    response: {
      at: undefined, requestId: '', url: '', status: 200, runType: 'agentic_retrieve', runStatus,
      requestBody: {
        outputMode: synthesize ? 'answerSynthesis' : 'extractiveData',
        knowledgeSourceParams: [{ kind: 'searchIndex', knowledgeSourceName: source, ...(graph ? { topicGraph: graph } : {}) }],
      },
      body: {
        activity: [{ type: 'searchIndex', id, knowledgeSourceName: source }],
        references: keys.map((key, index) => ({ id: chunks[index].ref_id, type: 'searchIndex', activitySource: id, docKey: key })),
        response: [{ content: [{ type: 'text', text: JSON.stringify(chunks) }] }],
      },
    },
  }
}

function renderComparison(views: ResultView[]) {
  return render(<SearchComparisonTable views={views} settings={null} language="en" onClose={vi.fn()} onSelectView={vi.fn()} />)
}

function resultCell(rowLabel: string, column: number) {
  const row = screen.getByRole('rowheader', { name: rowLabel }).closest('tr')!
  return within(within(row).getAllByRole('cell')[column])
}

describe('Agentic diversity comparison', () => {
  it('compares recorded topic settings and recomputes document changes for the selected baseline and K', () => {
    renderComparison([
      agenticRun('Run A', ['a', 'a', 'b', 'c', 'd', 'e'], { graph: { kind: 'diverse', diversityFactor: 0, minDiversityPoolSize: 250 } }),
      agenticRun('Run B', ['b', 'a', 'f', 'c', 'd', 'e'], { graph: { kind: 'diverse', diversityFactor: 0.8, minDiversityPoolSize: 250 } }),
      agenticRun('Run C', ['a']),
      agenticRun('Another source', ['a'], { source: 'other' }),
    ])

    expect(resultCell('content', 0).getByText('0')).toBeVisible()
    expect(resultCell('content', 1).getByText('0.8')).toBeVisible()
    expect(resultCell('content', 1).getByText('Request differs')).toBeVisible()
    expect(resultCell('content', 2).getByText('No override (effective value unknown)')).toBeVisible()
    expect(resultCell('content', 3).getByText('Source not recorded')).toBeVisible()
    const topTen = resultCell('Top 10', 1)
    expect(topTen.getByText('Common').parentElement).toHaveTextContent('Common5')
    expect(topTen.getByText('Added', { selector: 'dt' }).parentElement).toHaveTextContent('Added1')
    expect(topTen.getByText('Dropped', { selector: 'dt' }).parentElement).toHaveTextContent('Dropped0')
    expect(resultCell('Top 10', 3).getByText('Common').parentElement).toHaveTextContent('Common0')

    fireEvent.change(screen.getByRole('combobox', { name: /Compare top K/ }), { target: { value: '5' } })
    fireEvent.change(screen.getByRole('combobox', { name: /Baseline run/ }), { target: { value: 'run:Run B' } })
    const topFive = resultCell('Top 5', 0)
    expect(topFive.getByText('Common').parentElement).toHaveTextContent('Common4')
    expect(topFive.getByText('Added', { selector: 'dt' }).parentElement).toHaveTextContent('Added0')
    expect(topFive.getByText('Dropped', { selector: 'dt' }).parentElement).toHaveTextContent('Dropped1')
    expect(topFive.getByText(/#3 f/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Show matching document ranks: a' }).length).toBeGreaterThan(0)
  })

  it('distinguishes unranked answers and results that cannot be matched from empty ranked results', () => {
    renderComparison([
      agenticRun('Unidentified', [null, 'b']),
      agenticRun('Baseline', ['a']),
      agenticRun('Answer', ['a'], { synthesize: true }),
      agenticRun('Canceled', ['a'], { runStatus: 'canceled' }),
      agenticRun('Empty', []),
    ])

    expect(screen.getByRole('combobox', { name: /Baseline run/ })).toHaveValue('run:Baseline')
    expect(screen.getByText('No ranked grounding data')).toBeVisible()
    expect(screen.getByText('1 references')).toBeVisible()
    expect(resultCell('Top 10', 0).getByText('Results without a document identity: 1')).toBeVisible()
    expect(resultCell('Top 10', 0).queryByText('Dropped')).not.toBeInTheDocument()
    expect(resultCell('Top 10', 2).getByLabelText('No ranked grounding data')).toBeVisible()
    expect(resultCell('Top 10', 3).getByLabelText('Incomplete or failed')).toBeVisible()
    expect(resultCell('Top 10', 4).getByText('Dropped', { selector: 'dt' }).parentElement).toHaveTextContent('Dropped1')
  })
})
