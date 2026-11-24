// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getIndexStatistics, type RestResult } from '../../lib/aiSearchRest'
import type { DependencySnapshotResult } from '../../lib/indexDependencyLoader'
import { loadDependencySnapshot } from '../../lib/indexDependencyLoader'
import type { ConnectionProfile } from '../../lib/model'
import { IndexDependencyMap } from './IndexDependencyMap'

vi.mock('../../lib/indexDependencyLoader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/indexDependencyLoader')>()
  return { ...actual, loadDependencySnapshot: vi.fn() }
})

vi.mock('../../lib/aiSearchRest', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/aiSearchRest')>()
  return { ...actual, getIndexStatistics: vi.fn() }
})

const KB = 'ft-topic-worldheritage-agentic-kb'
const KS = 'ft-topic-worldheritage-agentic-ks'
const CHUNKS = 'ft-topic-worldheritage-src'
const PROFILE = 'iq-notebook-topics'
const TOPICS = 'ft-published-heritage-sites-topics-a49011b13ce3'

const profile: ConnectionProfile = { endpoint: 'https://example.search.windows.net', apiVersion: '2026-11-01-preview', authType: 'apiKey', apiKey: 'key' }

function loaded(overrides: Partial<DependencySnapshotResult> = {}): DependencySnapshotResult {
  const chunkIndex = {
    name: CHUNKS,
    fields: [{ name: 'snippet_vector', type: 'Collection(Edm.Single)', dimensions: 8, topicGraphProfile: PROFILE }],
    vectorSearch: { topicGraphProfiles: [{ name: PROFILE, indexName: TOPICS, defaultKind: 'balanced' }] },
  }
  return {
    snapshot: {
      knowledgeBases: [{ name: KB, knowledgeSources: [{ name: KS }] }],
      knowledgeSources: [{ name: KS, kind: 'searchIndex', searchIndexParameters: { searchIndexName: CHUNKS } }],
      indexes: [chunkIndex, { name: TOPICS, fields: [] }],
    },
    errors: [],
    skippedDetails: 0,
    ...overrides,
  }
}

function statistics(counts: Record<string, number>) {
  vi.mocked(getIndexStatistics).mockImplementation(async (input): Promise<RestResult> => ({
    ok: true,
    status: 200,
    requestId: 'req',
    url: 'https://example.search.windows.net',
    response: { documentCount: counts[input.indexName] ?? 0 },
  }))
}

function renderMap(props: Partial<React.ComponentProps<typeof IndexDependencyMap>> = {}) {
  const handlers = {
    onOpenIndex: vi.fn(),
    onSearchIndex: vi.fn(),
    onOpenTopicProfile: vi.fn(),
    onOpenKnowledgeSource: vi.fn(),
    onOpenKnowledgeBase: vi.fn(),
  }
  render(
    <IndexDependencyMap
      profile={profile}
      apiVersion="2026-11-01-preview"
      language="ja"
      focusIndexName={CHUNKS}
      draftIndex={null}
      draftDirty={false}
      {...handlers}
      {...props}
    />,
  )
  return handlers
}

const node = (id: string) => document.querySelector(`[data-node-id="${id}"]`) as HTMLElement

describe('IndexDependencyMap', () => {
  beforeEach(() => {
    vi.mocked(loadDependencySnapshot).mockReset()
    vi.mocked(getIndexStatistics).mockReset()
    vi.mocked(loadDependencySnapshot).mockResolvedValue(loaded())
    statistics({ [CHUNKS]: 70, [TOPICS]: 102 })
  })
  afterEach(cleanup)

  it('draws the chain from the knowledge base to the topic index with the reference labels and record counts', async () => {
    renderMap()

    await waitFor(() => expect(node(`index:${TOPICS}`)).toBeTruthy())

    expect(within(node(`knowledgeBase:${KB}`)).getByText('ナレッジ ベース')).toBeInTheDocument()
    expect(within(node(`knowledgeSource:${KS}`)).getByText('searchIndex')).toBeInTheDocument()
    expect(within(node(`topicProfile:${CHUNKS}:${PROFILE}`)).getByText('defaultKind: balanced')).toBeInTheDocument()
    expect(within(node(`index:${CHUNKS}`)).getByText('検索対象')).toBeInTheDocument()
    expect(within(node(`index:${CHUNKS}`)).getByText('選択中')).toBeInTheDocument()
    expect(within(node(`index:${TOPICS}`)).getByText('トピック用')).toBeInTheDocument()

    for (const label of ['knowledgeSources', 'searchIndexName', 'snippet_vector.topicGraphProfile', 'indexName']) {
      expect(screen.getByText(label, { selector: 'text' })).toBeInTheDocument()
    }
    expect(document.querySelectorAll('[data-edge-id]')).toHaveLength(4)

    await waitFor(() => {
      expect(within(node(`index:${CHUNKS}`)).getByText('70 件')).toBeInTheDocument()
      expect(within(node(`index:${TOPICS}`)).getByText('102 件')).toBeInTheDocument()
    })
  })

  it('opens each resource in its builder', async () => {
    const handlers = renderMap()
    await waitFor(() => expect(node(`index:${TOPICS}`)).toBeTruthy())

    fireEvent.click(within(node(`knowledgeBase:${KB}`)).getByRole('button', { name: `ナレッジ ベース ${KB} を開く` }))
    fireEvent.click(within(node(`knowledgeSource:${KS}`)).getByRole('button', { name: `ナレッジ ソース ${KS} を開く` }))
    fireEvent.click(within(node(`topicProfile:${CHUNKS}:${PROFILE}`)).getByRole('button', { name: `トピック プロファイル ${PROFILE} を編集` }))
    fireEvent.click(within(node(`index:${TOPICS}`)).getByRole('button', { name: `インデックス ${TOPICS} を表示` }))
    fireEvent.click(within(node(`index:${TOPICS}`)).getByRole('button', { name: `インデックス ${TOPICS} で検索` }))

    expect(handlers.onOpenKnowledgeBase).toHaveBeenCalledWith(KB)
    expect(handlers.onOpenKnowledgeSource).toHaveBeenCalledWith(KS)
    expect(handlers.onOpenTopicProfile).toHaveBeenCalledWith(CHUNKS)
    expect(handlers.onOpenIndex).toHaveBeenCalledWith(TOPICS)
    expect(handlers.onSearchIndex).toHaveBeenCalledWith(TOPICS)
  })

  it('does not offer a link to the selected index itself or to resources that were not found', async () => {
    vi.mocked(loadDependencySnapshot).mockResolvedValue(loaded({
      snapshot: {
        knowledgeBases: [{ name: KB, knowledgeSources: [{ name: KS }, { name: 'deleted-ks' }] }],
        knowledgeSources: [{ name: KS, kind: 'searchIndex', searchIndexParameters: { searchIndexName: 'gone' } }],
        indexes: [],
      },
    }))
    renderMap({ focusIndexName: 'gone' })
    await waitFor(() => expect(node('index:gone')).toBeTruthy())

    expect(within(node('index:gone')).queryByRole('button')).toBeNull()
    expect(within(node('index:gone')).getByText('見つかりません')).toBeInTheDocument()
    expect(node('knowledgeSource:deleted-ks')).toBeNull()
  })

  it('reflects the unsaved definition and flags an index that does not exist yet', async () => {
    const draft = { name: 'brand-new', fields: [{ name: 'v', type: 'Collection(Edm.Single)', dimensions: 4, topicGraphProfile: 'fresh' }], vectorSearch: { topicGraphProfiles: [{ name: 'fresh', indexName: TOPICS, defaultKind: 'balanced' }] } }
    renderMap({ focusIndexName: 'brand-new', draftIndex: draft })

    await waitFor(() => expect(node('topicProfile:brand-new:fresh')).toBeTruthy())

    expect(within(node('index:brand-new')).getByText('新規 (未保存)')).toBeInTheDocument()
    expect(within(node('index:brand-new')).queryByRole('button', { name: /で検索/ })).toBeNull()
    expect(node(`index:${TOPICS}`)).toBeTruthy()
  })

  it('shows a note on the saved index when the editor has unsaved changes', async () => {
    const saved = loaded().snapshot.indexes[0]
    renderMap({ draftIndex: saved, draftDirty: true })

    await waitFor(() => expect(within(node(`index:${CHUNKS}`)).getByText('未保存の変更を反映')).toBeInTheDocument())
  })

  it('reports lists that could not be read and still draws the rest', async () => {
    vi.mocked(loadDependencySnapshot).mockResolvedValue(loaded({
      errors: [{ resource: 'knowledgeBases', message: 'Forbidden' }],
      skippedDetails: 3,
      snapshot: { knowledgeBases: [], knowledgeSources: [], indexes: loaded().snapshot.indexes },
    }))
    renderMap()

    await waitFor(() => expect(screen.getByText('ナレッジ ベース一覧を取得できませんでした: Forbidden')).toBeInTheDocument())
    expect(screen.getByText(/3 件の定義を読み込めていません/)).toBeInTheDocument()
    expect(node(`index:${CHUNKS}`)).toBeTruthy()
    expect(node(`index:${TOPICS}`)).toBeTruthy()
  })

  it('explains when the selected index has no relations and reloads on request', async () => {
    renderMap({ focusIndexName: 'lonely' })

    await waitFor(() => expect(screen.getByText(/関係が見つかりません/)).toBeInTheDocument())
    expect(vi.mocked(loadDependencySnapshot)).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /再読み込み/ }))
    await waitFor(() => expect(vi.mocked(loadDependencySnapshot)).toHaveBeenCalledTimes(2))
  })

  it('asks for an index when none is selected and for a connection when there is none', async () => {
    renderMap({ focusIndexName: '' })
    await waitFor(() => expect(screen.getByText('インデックスを選択すると、関連するリソースを表示します。')).toBeInTheDocument())
    cleanup()
    vi.mocked(loadDependencySnapshot).mockClear()

    renderMap({ profile: null })
    expect(screen.getByRole('button', { name: /再読み込み/ })).toBeDisabled()
    expect(vi.mocked(loadDependencySnapshot)).toHaveBeenCalledTimes(0)
  })
})
