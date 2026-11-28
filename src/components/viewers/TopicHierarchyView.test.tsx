// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type CSSProperties } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '../../app/json'
import type { ConnectionProfile } from '../../lib/model'
import { buildTopicHierarchy, TOPIC_GRAPH_NAME, type TopicGraphRow } from '../../lib/topicGraphCoverage'
import { loadChunkText, loadTopicHierarchy, loadWheelChunks, TopicGraphReadError, type TopicWheelChunks } from '../../lib/topicGraphReader'
import { TopicHierarchyView } from './TopicHierarchyView'

type TreeNode = { id: string; kind: string; name: string; collapsed: boolean; children?: TreeNode[] }
type ChartProps = {
  option: {
    title?: { text: string; subtext: string }
    series: Array<{
      type: string; layout?: string; orient?: string; roam?: boolean
      data: Array<{ id: string; name: string; kind?: string; children?: Array<{ id: string; children?: unknown[] }> } & TreeNode>
    }>
  }
  style: CSSProperties
  onEvents: { click: (params: unknown) => void }
}

const chart = vi.hoisted(() => ({ calls: [] as unknown[], mounted: 0 }))
vi.mock('./TopicEChart', () => {
  function TopicEChartStub(props: unknown) {
    const [instance] = useState(() => ++chart.mounted)
    chart.calls.push(props)
    return <div role="img" aria-label="Topic chart" data-instance={instance} />
  }
  return { default: TopicEChartStub }
})
vi.mock('../../lib/topicGraphReader', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/topicGraphReader')>(),
  loadChunkText: vi.fn(),
  loadTopicHierarchy: vi.fn(),
  loadWheelChunks: vi.fn(),
}))

const latest = () => chart.calls.at(-1) as ChartProps
const click = (params: unknown) => act(() => latest().onEvents.click(params))
const topicClick = (id: string, zoomable: boolean) => click({ componentType: 'series', data: { id, kind: 'topic', zoomable } })
const chunkClick = (id: string) => click({ componentType: 'series', data: { id, kind: 'chunk', zoomable: false } })
const ids = (items: Array<{ id: string }>) => items.map((item) => item.id)

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

function view(kind: 'wheel' | 'tree' = 'wheel', topicDefinition: JsonObject = definition) {
  return <TopicHierarchyView profile={profile} indexName="topic-index" definition={topicDefinition} language="en" theme="dark" view={kind} />
}

function chunksResult(overrides: Partial<TopicWheelChunks> = {}): TopicWheelChunks {
  return {
    contentIndex: 'content',
    keyField: 'uid',
    textField: 'snippet',
    assignments: new Map([['doc-a', { leafId: 'topic:2', score: 1 }], ['doc-b', { leafId: 'topic:2', score: 1 }], ['doc-c', { leafId: 'topic:1', score: 1 }]]),
    unassigned: 2,
    truncated: false,
    keyOrdered: true,
    ...overrides,
  }
}

async function overlayChunks(kind: 'wheel' | 'tree' = 'wheel', result = chunksResult()) {
  vi.mocked(loadWheelChunks).mockResolvedValue(result)
  const rendered = render(view(kind))
  await screen.findByRole('img', { name: 'Topic chart' })
  fireEvent.click(screen.getByRole('button', { name: 'Overlay chunks' }))
  await screen.findByRole('button', { name: 'Hide chunks' })
  return rendered
}

describe('TopicHierarchyView', () => {
  beforeEach(() => {
    chart.calls.length = 0
    chart.mounted = 0
    vi.mocked(loadTopicHierarchy).mockResolvedValue(hierarchy)
  })
  afterEach(() => {
    cleanup()
    vi.resetAllMocks()
  })

  describe('as a wheel', () => {
    it('reads the whole topic index once and draws it as a sunburst with the collection in the center', async () => {
      render(view())
      await screen.findByRole('img', { name: 'Topic chart' })

      expect(loadTopicHierarchy).toHaveBeenCalledWith(expect.objectContaining({ profile }), { topicIndex: 'topic-index', topicDefinition: definition })
      const { option } = latest()
      expect(option.series[0].type).toBe('sunburst')
      expect(ids(option.series[0].data)).toEqual(['topic:0', 'topic:1'])
      expect(option.title).toMatchObject({ text: 'Collection', subtext: '3 topics' })
      expect(screen.getByText('Select a topic or a chunk to see its details.')).toBeInTheDocument()
    })

    it('zooms into a topic, goes back with the title in the center or the breadcrumb, and selects a leaf without zooming', async () => {
      render(view())
      await screen.findByRole('img', { name: 'Topic chart' })

      topicClick('topic:0', true)
      expect(ids(latest().option.series[0].data)).toEqual(['topic:2', 'topic:3'])
      expect(latest().option.title).toMatchObject({ text: '0: 寺院', subtext: '2 topics' })
      expect(screen.getByRole('complementary', { name: 'Selection details' })).toHaveTextContent('0: 寺院')
      expect(within(screen.getByRole('navigation', { name: 'Wheel of the topic hierarchy' })).getByRole('button', { name: '0: 寺院' })).toBeDisabled()

      click({ componentType: 'title' })
      expect(ids(latest().option.series[0].data)).toEqual(['topic:0', 'topic:1'])

      topicClick('topic:1', false)
      expect(screen.getByRole('complementary', { name: 'Selection details' })).toHaveTextContent('50%')
      expect(latest().option.title).toMatchObject({ text: 'Collection' })

      topicClick('topic:0', true)
      fireEvent.click(screen.getByRole('button', { name: 'Collection' }))
      expect(ids(latest().option.series[0].data)).toEqual(['topic:0', 'topic:1'])
    })

    it('overlays the chunks only after the user asks, sizes the wheel by chunks and can hide them again', async () => {
      vi.mocked(loadWheelChunks).mockResolvedValue(chunksResult())
      render(view())
      await screen.findByRole('img', { name: 'Topic chart' })
      expect(loadWheelChunks).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Overlay chunks' }))
      await screen.findByRole('button', { name: 'Hide chunks' })

      expect(loadWheelChunks).toHaveBeenCalledWith(expect.objectContaining({ profile }), 'topic-index', hierarchy)
      expect(latest().option.title).toMatchObject({ subtext: '3 chunks' })
      expect(screen.getByText('2 chunks could not be assigned to any topic.')).toBeInTheDocument()
      const topics = latest().option.series[0].data
      expect(ids(topics)).toEqual(['topic:0', 'topic:1'])
      expect(ids(topics[1].children as Array<{ id: string }>)).toEqual(['doc-c'])

      chunkClick('doc-c')
      expect(screen.getByRole('complementary', { name: 'Selection details' })).toHaveTextContent('doc-c')

      fireEvent.click(screen.getByRole('button', { name: 'Hide chunks' }))
      expect(latest().option.title).toMatchObject({ subtext: '3 topics' })
      expect(screen.queryByText('doc-c')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Show chunks' }))
      expect(latest().option.title).toMatchObject({ subtext: '3 chunks' })
      expect(loadWheelChunks).toHaveBeenCalledTimes(1)
    })

    it('says which chunks were left out: the last ones in key order, or whatever the service did not return when the key is not sortable', async () => {
      const { unmount } = await overlayChunks('wheel', chunksResult({ truncated: true }))
      expect(screen.getByText('The content index has more than 500 chunks, so only the first 500 in key order are shown.')).toBeInTheDocument()
      unmount()

      await overlayChunks('wheel', chunksResult({ truncated: true, keyOrdered: false }))
      expect(screen.getByText(/The key field is not sortable, so which chunks are included depends on the order in which the service returns them/)).toBeInTheDocument()
      expect(screen.queryByText(/in key order are shown/)).not.toBeInTheDocument()
    })

    it('explains why the hierarchy or the chunks could not be read', async () => {
      vi.mocked(loadWheelChunks).mockRejectedValue(new TopicGraphReadError('noContentIndex', 'topic-index'))
      render(view())
      await screen.findByRole('img', { name: 'Topic chart' })

      fireEvent.click(screen.getByRole('button', { name: 'Overlay chunks' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not identify the content index (topic-index)')
      expect(screen.getByRole('button', { name: 'Overlay chunks' })).toBeEnabled()

      cleanup()
      chart.calls.length = 0
      vi.mocked(loadTopicHierarchy).mockRejectedValue(new TopicGraphReadError('unsupportedTopicIndex', 'graphName: entity'))
      render(view())
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('cannot be read as an official TopicGraph index (graphName: entity)'))
      expect(chart.calls).toHaveLength(0)
    })
  })

  describe('the text of a chunk', () => {
    it('is read once when a chunk is clicked and shown in the details', async () => {
      vi.mocked(loadChunkText).mockImplementation(async (_connection, _source, key) => `本文 of ${key}`)
      await overlayChunks()
      expect(loadChunkText).not.toHaveBeenCalled()

      chunkClick('doc-c')

      const details = screen.getByRole('complementary', { name: 'Selection details' })
      expect(await within(details).findByText('本文 of doc-c')).toBeInTheDocument()
      expect(within(details).getByText('snippet')).toBeInTheDocument()
      expect(loadChunkText).toHaveBeenCalledWith(
        expect.objectContaining({ profile }), { contentIndex: 'content', keyField: 'uid', textField: 'snippet' }, 'doc-c',
      )

      chunkClick('doc-a')
      expect(await within(details).findByText('本文 of doc-a')).toBeInTheDocument()
      chunkClick('doc-c')
      expect(within(details).getByText('本文 of doc-c')).toBeInTheDocument()
      expect(loadChunkText).toHaveBeenCalledTimes(2)
    })

    it('shows a loading state, a failure that is retried by clicking again, and an empty body', async () => {
      let release: (text: string | undefined) => void = () => {}
      vi.mocked(loadChunkText).mockImplementationOnce(() => new Promise<string | undefined>((resolve) => { release = resolve }))
      await overlayChunks()
      const details = screen.getByRole('complementary', { name: 'Selection details' })

      chunkClick('doc-c')
      expect(within(details).getByRole('status')).toHaveTextContent('Loading the text…')
      release(undefined)
      expect(await within(details).findByText('The text is empty, or the chunk was not found.')).toBeInTheDocument()

      vi.mocked(loadChunkText).mockRejectedValueOnce(new TopicGraphReadError('request', 'Forbidden (r-1)'))
      chunkClick('doc-a')
      expect(await within(details).findByRole('alert')).toHaveTextContent('Could not read from Azure AI Search: Forbidden (r-1)')

      vi.mocked(loadChunkText).mockResolvedValueOnce('recovered')
      chunkClick('doc-a')
      expect(await within(details).findByText('recovered')).toBeInTheDocument()
    })

    it('is not requested when the content index has no recognizable text field', async () => {
      await overlayChunks('wheel', chunksResult({ textField: undefined }))

      chunkClick('doc-c')

      expect(screen.getByText('The content index has no string field that can be shown as the chunk text.')).toBeInTheDocument()
      expect(loadChunkText).not.toHaveBeenCalled()
    })
  })

  describe('as a tree', () => {
    const rootOf = () => latest().option.series[0].data[0] as TreeNode

    it('draws the hierarchy as an ECharts tree under the collection with every topic open', async () => {
      render(view('tree'))
      await screen.findByRole('img', { name: 'Topic chart' })

      const series = latest().option.series[0]
      expect(series).toMatchObject({ type: 'tree', layout: 'orthogonal', orient: 'LR', roam: true })
      expect(rootOf()).toMatchObject({ id: 'root', kind: 'root', name: 'Collection' })
      expect(rootOf().children?.map((child) => child.name)).toEqual(['0: 寺院', '1: 自然'])
      expect(rootOf().children?.[0].children?.map((child) => child.name)).toEqual(['2: 木造建築', '3'])
      expect(rootOf().children?.[0].collapsed).toBe(false)
      expect(screen.getByText('Shows the topic hierarchy as a branching tree', { exact: false })).toBeInTheDocument()
    })

    it('switches between the horizontal, vertical and radial layouts with a new chart each time', async () => {
      render(view('tree'))
      await screen.findByRole('img', { name: 'Topic chart' })
      expect(screen.getByRole('button', { name: 'Horizontal' })).toHaveAttribute('aria-pressed', 'true')

      fireEvent.click(screen.getByRole('button', { name: 'Vertical' }))
      expect(latest().option.series[0]).toMatchObject({ layout: 'orthogonal', orient: 'TB' })
      expect(latest().style).toMatchObject({ height: 640 })
      expect(screen.getByRole('button', { name: 'Vertical' })).toHaveAttribute('aria-pressed', 'true')

      fireEvent.click(screen.getByRole('button', { name: 'Radial' }))
      expect(latest().option.series[0]).toMatchObject({ layout: 'radial' })
      expect(latest().option.series[0].orient).toBeUndefined()
    })

    it('opens or folds the whole tree on request and folds the chunks of a leaf topic by default', async () => {
      await overlayChunks('tree')
      const [temples, nature] = rootOf().children as TreeNode[]
      expect(nature).toMatchObject({ id: 'topic:1', collapsed: true })
      expect(nature.children?.map((child) => child.name)).toEqual(['C3'])
      expect(temples.children?.[0]).toMatchObject({ id: 'topic:2', collapsed: true })

      fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
      expect(rootOf().children?.every((child) => !child.collapsed)).toBe(true)
      expect(rootOf().children?.[0].children?.[0].collapsed).toBe(false)

      fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
      expect(rootOf().collapsed).toBe(false)
      expect(rootOf().children?.every((child) => child.collapsed)).toBe(true)
    })

    it('applies "Expand all" and "Collapse all" again with a new chart each time, so that nodes changed by hand are reset', async () => {
      render(view('tree'))
      const instance = () => screen.getByRole('img', { name: 'Topic chart' }).getAttribute('data-instance')
      await screen.findByRole('img', { name: 'Topic chart' })
      const seen = [instance()]

      for (const name of ['Expand all', 'Expand all', 'Collapse all', 'Collapse all']) {
        fireEvent.click(screen.getByRole('button', { name }))
        seen.push(instance())
      }

      expect(new Set(seen).size).toBe(seen.length)
    })

    it('selects a clicked topic or chunk, reads the chunk text and ignores the collection node', async () => {
      vi.mocked(loadChunkText).mockResolvedValue('伽藍の由来')
      await overlayChunks('tree')

      click({ componentType: 'series', data: { id: 'topic:2', kind: 'topic' } })
      expect(screen.getByRole('complementary', { name: 'Selection details' })).toHaveTextContent('寺院 › 木造建築')
      expect(latest().option.series[0].type).toBe('tree')

      chunkClick('doc-b')
      expect(await screen.findByText('伽藍の由来')).toBeInTheDocument()
      expect(loadChunkText).toHaveBeenCalledWith(expect.objectContaining({ profile }), expect.objectContaining({ textField: 'snippet' }), 'doc-b')

      click({ componentType: 'series', data: { id: 'root', kind: 'root' } })
      expect(screen.getByText('Select a topic or a chunk to see its details.')).toBeInTheDocument()
    })
  })

  describe('when the hierarchy is read again', () => {
    it('starts over without the chunks, texts, selection and zoom of the old hierarchy', async () => {
      vi.mocked(loadChunkText).mockResolvedValue('伽藍の由来')
      const { rerender } = await overlayChunks('wheel')
      chunkClick('doc-c')
      await screen.findByText('伽藍の由来')
      topicClick('topic:0', true)

      rerender(view('wheel', { name: 'topic-index' }))

      await waitFor(() => expect(loadTopicHierarchy).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(screen.getByRole('button', { name: 'Overlay chunks' })).toBeEnabled())
      expect(screen.queryByText('伽藍の由来')).not.toBeInTheDocument()
      expect(screen.getByText('Select a topic or a chunk to see its details.')).toBeInTheDocument()
      expect(latest().option.title).toMatchObject({ text: 'Collection', subtext: '3 topics' })
      expect(loadWheelChunks).toHaveBeenCalledTimes(1)
    })

    it('aborts a chunk request that is still running and lets the user overlay the chunks again', async () => {
      let signal: AbortSignal | undefined
      vi.mocked(loadWheelChunks).mockImplementation((connection) => {
        signal = connection.signal
        return new Promise(() => {})
      })
      const { rerender } = render(view())
      await screen.findByRole('img', { name: 'Topic chart' })
      fireEvent.click(screen.getByRole('button', { name: 'Overlay chunks' }))
      expect(await screen.findByRole('button', { name: 'Loading chunks…' })).toBeDisabled()

      rerender(view('wheel', { name: 'topic-index' }))

      expect(signal?.aborted).toBe(true)
      await waitFor(() => expect(screen.getByRole('button', { name: 'Overlay chunks' })).toBeEnabled())
    })
  })

  describe('the topic list for the keyboard', () => {
    const outline = () => within(screen.getByRole('navigation', { name: 'Topic list for keyboard navigation' }))
    const details = () => screen.getByRole('complementary', { name: 'Selection details' })

    it('lists every topic as a button and zooms the wheel or selects a leaf like a click on the chart', async () => {
      render(view())
      await screen.findByRole('img', { name: 'Topic chart' })
      expect(outline().getAllByRole('button').map((button) => button.textContent)).toEqual(['0: 寺院', '2: 木造建築', '3', '1: 自然'])

      fireEvent.click(outline().getByRole('button', { name: '0: 寺院' }))
      expect(ids(latest().option.series[0].data)).toEqual(['topic:2', 'topic:3'])
      expect(outline().getByRole('button', { name: '0: 寺院' })).toHaveAttribute('aria-current', 'true')

      fireEvent.click(outline().getByRole('button', { name: '3' }))
      expect(details()).toHaveTextContent('10%')
      expect(latest().option.title).toMatchObject({ text: '0: 寺院' })
    })

    it('zooms into a leaf topic that holds chunks, leaves one without chunks alone and reaches the chunk buttons', async () => {
      vi.mocked(loadChunkText).mockResolvedValue('伽藍の由来')
      await overlayChunks('wheel')

      fireEvent.click(outline().getByRole('button', { name: '1: 自然' }))
      expect(ids(latest().option.series[0].data)).toEqual(['doc-c'])

      fireEvent.click(outline().getByRole('button', { name: '3' }))
      expect(latest().option.title).toMatchObject({ text: '1: 自然' })
      expect(details()).toHaveTextContent('10%')

      fireEvent.click(outline().getByRole('button', { name: '2: 木造建築' }))
      fireEvent.click(within(details()).getByRole('button', { name: 'C2' }))
      expect(await within(details()).findByText('伽藍の由来')).toBeInTheDocument()
      expect(loadChunkText).toHaveBeenCalledWith(expect.objectContaining({ profile }), expect.anything(), 'doc-b')
    })

    it('only selects a topic in the tree, where there is nothing to zoom into', async () => {
      render(view('tree'))
      await screen.findByRole('img', { name: 'Topic chart' })

      fireEvent.click(outline().getByRole('button', { name: '0: 寺院' }))

      expect(details()).toHaveTextContent('0: 寺院')
      expect(latest().option.series[0].type).toBe('tree')
      expect(outline().getByRole('button', { name: '0: 寺院' })).toHaveAttribute('aria-current', 'true')
    })
  })

  it('keeps the topic list and the details when no chunk is assigned, and shows the empty state only in place of the chart', async () => {
    await overlayChunks('wheel', chunksResult({ assignments: new Map(), unassigned: 5 }))

    expect(screen.getByText('There are no topics to show.')).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'Topic chart' })).not.toBeInTheDocument()
    const outline = within(screen.getByRole('navigation', { name: 'Topic list for keyboard navigation' }))
    fireEvent.click(outline.getByRole('button', { name: '1: 自然' }))
    const details = screen.getByRole('complementary', { name: 'Selection details' })
    expect(details).toHaveTextContent('1: 自然')
    expect(within(details).getByText('Chunks').nextElementSibling).toHaveTextContent('0')
  })

  it('hands the chart the same event handlers on every render, so that it does not rebind them while the user hovers', async () => {
    const { rerender } = render(view())
    await screen.findByRole('img', { name: 'Topic chart' })
    const first = latest().onEvents

    rerender(view())
    topicClick('topic:0', true)
    rerender(view())

    expect(latest().onEvents).toBe(first)
    expect(latest().option.title).toMatchObject({ text: '0: 寺院' })
  })

  it('keeps the loaded chunks and the selection when the view switches between the wheel and the tree', async () => {
    const { rerender } = await overlayChunks('wheel')
    chunkClick('doc-c')

    rerender(view('tree'))
    expect(latest().option.series[0].type).toBe('tree')
    expect(screen.getByRole('button', { name: 'Hide chunks' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Selection details' })).toHaveTextContent('doc-c')

    rerender(view('wheel'))
    expect(latest().option.series[0].type).toBe('sunburst')
    expect(loadWheelChunks).toHaveBeenCalledTimes(1)
    expect(loadTopicHierarchy).toHaveBeenCalledTimes(1)
  })
})
