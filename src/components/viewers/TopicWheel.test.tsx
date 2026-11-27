// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '../../lib/model'
import { buildTopicHierarchy, TOPIC_GRAPH_NAME, type TopicGraphRow } from '../../lib/topicGraphCoverage'
import { loadTopicHierarchy, loadWheelChunks, TopicGraphReadError } from '../../lib/topicGraphReader'
import { TopicWheel } from './TopicWheel'

vi.mock('../../lib/topicGraphReader', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/topicGraphReader')>(),
  loadTopicHierarchy: vi.fn(),
  loadWheelChunks: vi.fn(),
}))

const row = (fields: TopicGraphRow): TopicGraphRow => ({ graphName: TOPIC_GRAPH_NAME, ...fields })
// topic:0 (寺院) -> topic:2 (木造建築, 0.4), topic:3 (0.1); topic:1 (自然, 0.5) is a leaf.
const hierarchy = buildTopicHierarchy([
  row({ predicate: 'HasRootTopic', subjectId: 'topicgraph:topicgraph-topic', objectId: 'topic:0' }),
  row({ predicate: 'HasRootTopic', subjectId: 'topicgraph:topicgraph-topic', objectId: 'topic:1' }),
  row({ predicate: 'HasSubTopic', subjectId: 'topic:0', objectId: 'topic:2' }),
  row({ predicate: 'HasSubTopic', subjectId: 'topic:0', objectId: 'topic:3' }),
  row({ predicate: 'prop:title', subjectId: 'topic:0', objectString: '寺院' }),
  row({ predicate: 'prop:title', subjectId: 'topic:1', objectString: '自然' }),
  row({ predicate: 'prop:title', subjectId: 'topic:2', objectString: '木造建築' }),
  row({ predicate: 'prop:proportion', subjectId: 'topic:2', objectDouble: 0.4 }),
  row({ predicate: 'prop:proportion', subjectId: 'topic:3', objectDouble: 0.1 }),
  row({ predicate: 'prop:proportion', subjectId: 'topic:1', objectDouble: 0.5 }),
])
const profile = { endpoint: 'https://example.search.windows.net', apiVersion: '2026-11-01-preview', authType: 'apiKey', apiKey: 'test-key' } as ConnectionProfile
const definition = { name: 'topic-index' }

function wheel() {
  return <TopicWheel profile={profile} indexName="topic-index" definition={definition} language="en" />
}

describe('TopicWheel', () => {
  beforeEach(() => {
    vi.mocked(loadTopicHierarchy).mockResolvedValue(hierarchy)
  })
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  it('reads the whole topic index once, zooms into a topic and returns from the center', async () => {
    render(wheel())
    await screen.findByRole('group', { name: 'Wheel of the topic hierarchy' })
    expect(loadTopicHierarchy).toHaveBeenCalledWith(expect.objectContaining({ profile }), { topicIndex: 'topic-index', topicDefinition: definition })
    expect(screen.getByText('3 topics')).toBeInTheDocument()
    expect(screen.getByText('Select a topic or a chunk to see its details.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '0: 寺院' }))
    expect(screen.getByText('2 topics')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2: 木造建築' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '1: 自然' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Selection details' })).toHaveTextContent('0: 寺院')

    fireEvent.click(screen.getByRole('button', { name: 'Go up one level' }))
    expect(screen.getByText('3 topics')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '1: 自然' })).toBeInTheDocument()
  })

  it('selects a leaf topic without zooming and shows its share of the corpus', async () => {
    render(wheel())
    await screen.findByRole('group', { name: 'Wheel of the topic hierarchy' })

    fireEvent.click(screen.getByRole('button', { name: '1: 自然' }))

    expect(screen.getByRole('complementary', { name: 'Selection details' })).toHaveTextContent('50%')
    expect(screen.getByText('3 topics')).toBeInTheDocument()
  })

  it('overlays the chunks only after the user asks, sizes the wheel by chunks and can hide them again', async () => {
    vi.mocked(loadWheelChunks).mockResolvedValue({
      contentIndex: 'content',
      assignments: new Map([['doc-a', { leafId: 'topic:2', score: 1 }], ['doc-b', { leafId: 'topic:2', score: 1 }], ['doc-c', { leafId: 'topic:1', score: 1 }]]),
      unassigned: 2,
      truncated: false,
    })
    render(wheel())
    await screen.findByRole('group', { name: 'Wheel of the topic hierarchy' })
    expect(loadWheelChunks).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'C1' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Overlay chunks' }))

    expect(await screen.findByText('3 chunks')).toBeInTheDocument()
    expect(loadWheelChunks).toHaveBeenCalledWith(expect.objectContaining({ profile }), 'topic-index', hierarchy)
    expect(screen.getByText('2 chunks could not be assigned to any topic.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'C3' }))
    expect(screen.getByRole('complementary', { name: 'Selection details' })).toHaveTextContent('doc-c')

    fireEvent.click(screen.getByRole('button', { name: 'Hide chunks' }))
    expect(screen.queryByRole('button', { name: 'C1' })).not.toBeInTheDocument()
    expect(screen.getByText('3 topics')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show chunks' }))
    expect(screen.getByRole('button', { name: 'C1' })).toBeInTheDocument()
    expect(loadWheelChunks).toHaveBeenCalledTimes(1)
  })

  it('explains why the hierarchy or the chunks could not be read', async () => {
    vi.mocked(loadWheelChunks).mockRejectedValue(new TopicGraphReadError('noContentIndex', 'topic-index'))
    render(wheel())
    await screen.findByRole('group', { name: 'Wheel of the topic hierarchy' })

    fireEvent.click(screen.getByRole('button', { name: 'Overlay chunks' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not identify the content index (topic-index)')
    expect(screen.getByRole('button', { name: 'Overlay chunks' })).toBeEnabled()

    cleanup()
    vi.mocked(loadTopicHierarchy).mockRejectedValue(new TopicGraphReadError('unsupportedTopicIndex', 'graphName: entity'))
    render(wheel())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('cannot be read as an official TopicGraph index (graphName: entity)'))
    expect(screen.queryByRole('group', { name: 'Wheel of the topic hierarchy' })).not.toBeInTheDocument()
  })
})
