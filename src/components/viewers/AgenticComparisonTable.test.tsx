// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue } from '../../lib/aiSearchRest'
import type { ConnectionProfile } from '../../lib/model'
import { buildTopicHierarchy, TOPIC_GRAPH_NAME, type TopicGraphRow } from '../../lib/topicGraphCoverage'
import type { ResultView } from '../../types'
import { SearchComparisonTable } from './AgenticComparisonTable'

const reader = vi.hoisted(() => ({
  resolveTopicGraphBinding: vi.fn(),
  loadTopicHierarchy: vi.fn(),
  loadChunkVectors: vi.fn(),
  findNearestLeafTopics: vi.fn(),
}))
vi.mock('../../lib/topicGraphReader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/topicGraphReader')>()),
  ...reader,
}))

import { TopicGraphReadError } from '../../lib/topicGraphReader'

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

function agenticRun(id: string, keys: (string | null)[], { graph, synthesize, source = 'content', runStatus, requestedEffort, appliedEffort }: {
  graph?: JsonValue
  synthesize?: boolean
  source?: string
  runStatus?: 'canceled'
  requestedEffort?: string
  appliedEffort?: string
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
        ...(requestedEffort ? { retrievalReasoningEffort: { kind: requestedEffort } } : {}),
        knowledgeSourceParams: [{ kind: 'searchIndex', knowledgeSourceName: source, ...(graph ? { topicGraph: graph } : {}) }],
      },
      body: {
        activity: [
          { type: 'searchIndex', id, knowledgeSourceName: source },
          ...(appliedEffort ? [{ type: 'agenticReasoning', id: 1, retrievalReasoningEffort: { kind: appliedEffort } }] : []),
        ],
        references: keys.map((key, index) => ({ id: chunks[index].ref_id, type: 'searchIndex', activitySource: id, docKey: key })),
        response: [{ content: [{ type: 'text', text: JSON.stringify(chunks) }] }],
      },
    },
  }
}

function renderComparison(views: ResultView[], profile: ConnectionProfile | null = null) {
  return render(<SearchComparisonTable views={views} settings={null} profile={profile} language="en" onClose={vi.fn()} onSelectView={vi.fn()} />)
}

const topicProfile = { endpoint: 'https://search.example', apiVersion: '2026-11-01-preview' } as ConnectionProfile

function resultCell(rowLabel: string | RegExp, column: number) {
  const row = screen.getByRole('rowheader', { name: rowLabel }).closest('tr')!
  return within(within(row).getAllByRole('cell')[column])
}

describe('Agentic diversity comparison', () => {
  it('shows the retrieval reasoning effort of each run in its header, preferring the value the service applied', () => {
    renderComparison([
      agenticRun('Minimal', ['a'], { requestedEffort: 'minimal' }),
      agenticRun('Applied', ['a'], { requestedEffort: 'low', appliedEffort: 'minimal' }),
      agenticRun('Inherited', ['a']),
    ])

    const header = (label: string) => within(screen.getByRole('columnheader', { name: new RegExp(label) }))
    expect(header('Minimal').getByText('retrievalReasoningEffort: minimal')).toBeVisible()
    expect(header('Applied').getByText('retrievalReasoningEffort: minimal')).toBeVisible()
    expect(header('Inherited').getByText('retrievalReasoningEffort: Omitted')).toBeVisible()
  })

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

  describe('topic coverage', () => {
    const row = (fields: TopicGraphRow): TopicGraphRow => ({ graphName: TOPIC_GRAPH_NAME, ...fields })
    const hierarchy = buildTopicHierarchy([
      ...['topic:1', 'topic:2', 'topic:3'].flatMap((id, index) => [
        row({ predicate: 'HasRootTopic', subjectId: 'topicgraph:topicgraph-topic', objectId: id }),
        row({ predicate: 'prop:title', subjectId: id, objectString: ['Temples', 'Mountains', 'Sea'][index] }),
        row({ predicate: 'prop:proportion', subjectId: id, objectDouble: [0.5, 0.3, 0.2][index] }),
      ]),
    ])
    const leafOf: Record<string, string> = { a: 'topic:1', b: 'topic:1', c: 'topic:1', d: 'topic:2', e: 'topic:3' }
    const runs = () => [
      agenticRun('Focused', ['a', 'b', 'c'], { graph: { kind: 'diverse', diversityFactor: 0 } }),
      agenticRun('Varied', ['a', 'd', 'e'], { graph: { kind: 'diverse', diversityFactor: 1 } }),
      agenticRun('Answer', ['a'], { synthesize: true }),
    ]

    it('places the top chunks into leaf topics and compares how widely each run spreads over them', async () => {
      reader.resolveTopicGraphBinding.mockResolvedValue({ topicIndex: 'topic-index' })
      reader.loadTopicHierarchy.mockResolvedValue(hierarchy)
      const vectors = new Map(Object.keys(leafOf).map((key) => [key, [1, 0, 0]]))
      reader.loadChunkVectors.mockResolvedValue(vectors)
      reader.findNearestLeafTopics.mockResolvedValue(new Map(Object.entries(leafOf).map(([key, leafId]) => [key, { leafId, score: 0.9 }])))
      renderComparison(runs(), topicProfile)

      fireEvent.click(screen.getByRole('button', { name: 'Load topics' }))
      await screen.findByRole('rowheader', { name: /Topic distribution/ })

      expect(reader.resolveTopicGraphBinding).toHaveBeenCalledWith(expect.objectContaining({ profile: topicProfile }), 'content')
      expect(reader.loadChunkVectors.mock.calls[0][2].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
      expect(reader.findNearestLeafTopics.mock.calls[0][2]).toBe(vectors)
      const focused = resultCell(/Topic distribution/, 0)
      const varied = resultCell(/Topic distribution/, 1)
      expect(focused.getByText('Hit').nextElementSibling).toHaveTextContent('1 / 3')
      expect(focused.getByText('Effective topics').nextElementSibling).toHaveTextContent('1.00')
      expect(varied.getByText('Hit').nextElementSibling).toHaveTextContent('3 / 3')
      expect(varied.getByText('Effective topics').nextElementSibling).toHaveTextContent('3.00vs. baseline +2.00')
      expect(varied.getByText('Coverage').nextElementSibling).toHaveTextContent('100%')
      expect(varied.getAllByRole('listitem').some((item) => item.title.includes('#2: Mountains'))).toBe(true)
      expect(resultCell(/Topic distribution/, 2).getByLabelText('No ranked grounding data')).toBeVisible()
    })

    it('needs a connection that can read the topic index and reports why a topic graph cannot be followed', async () => {
      const { unmount } = renderComparison(runs())
      expect(screen.getByRole('button', { name: 'Load topics' })).toBeDisabled()
      expect(screen.getByText('Select a connection profile to read the topic index.')).toBeVisible()
      unmount()

      reader.resolveTopicGraphBinding.mockRejectedValue(new TopicGraphReadError('noTopicProfile', 'content'))
      renderComparison(runs(), topicProfile)
      fireEvent.click(screen.getByRole('button', { name: 'Load topics' }))

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('No topic graph profile is linked to the vector field (content).'))
      expect(screen.queryByRole('rowheader', { name: /Topic distribution/ })).not.toBeInTheDocument()
    })
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
