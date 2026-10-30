// @vitest-environment jsdom

import type { ReactNode } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { translations } from '../../lib/translations'
import { AgenticActivityTimeline } from './AgenticActivityTimeline'
import type { ActivityGraphNode } from '../../lib/agenticActivityGraph'

type TestNodeData = ActivityGraphNode & { statusLabel: string; countLabel: string }

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({ nodes, nodeTypes, onNodeClick, onPaneClick, children }: {
    nodes: { id: string; data: TestNodeData; position: { x: number; y: number }; selected: boolean }[]
    nodeTypes: { activity: (props: { data: TestNodeData; selected: boolean }) => ReactNode }
    onNodeClick: (event: null, node: { id: string }) => void
    onPaneClick: () => void
    children: ReactNode
  }) => (
    <div data-testid="graph-canvas" onClick={(event) => { if (event.target === event.currentTarget) onPaneClick() }}>
      {nodes.map((node) => (
        <div key={node.id}>
          <button data-x={node.position.x} data-y={node.position.y} onClick={() => onNodeClick(null, node)}>{node.data.title}: {node.data.subtitle}</button>
          <nodeTypes.activity data={node.data} selected={node.selected} />
        </div>
      ))}
      {children}
    </div>
  ),
  Handle: () => null,
  Background: () => null,
  Controls: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ControlButton: 'button',
  Position: { Top: 'top', Bottom: 'bottom' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
  useReactFlow: () => ({ zoomIn: vi.fn(), zoomOut: vi.fn(), fitView: vi.fn() }),
}))

afterEach(cleanup)
const t = (key: keyof typeof translations.ja) => translations.ja[key]
const activity = [{
  type: 'searchIndex', id: 1, knowledgeSourceName: 'products', elapsedMs: 25,
  searchIndexArguments: { search: '実行されたクエリ' },
  queryHintProcessing: { generatedFilter: "category eq 'books'" },
}]

describe('AgenticActivityGraph integration', () => {
  it.each(['ja', 'en'] as const)('closes details with the close button or background and reopens them on node selection (%s)', (language) => {
    const localized = (key: keyof typeof translations.en) => translations[language][key]
    render(<AgenticActivityTimeline activity={activity} t={localized} language={language} />)
    fireEvent.click(screen.getByRole('button', { name: localized('actGraphView') }))
    const canvas = screen.getByTestId('graph-canvas')
    const workspace = canvas.closest('.actGraph__workspace')
    const source = screen.getByRole('button', { name: /^searchIndex:/ })
    const details = () => screen.queryByRole('region', { name: localized('actGraphDetails') })

    expect(details()).toBeInTheDocument()
    const closeButton = screen.getByRole('button', { name: localized('actTraceCollapse') })
    const header = closeButton.closest('.actGraph__inspectorHeader')!
    expect(within(header).getByText(localized('actGraphSelect'))).toBeInTheDocument()
    expect(within(header).queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: localized('actGraphSelect') })).toHaveClass('actGraph__nodeSelect')
    fireEvent.click(source)
    expect(screen.getByRole('combobox')).toHaveValue('activity-0')
    expect(workspace).not.toHaveClass('actGraph__workspace--collapsed')
    fireEvent.click(screen.getByRole('button', { name: localized('actTraceCollapse') }))
    expect(details()).not.toBeInTheDocument()
    expect(workspace).toHaveClass('actGraph__workspace--collapsed')
    expect(canvas.querySelector('.actGraph__node--selected')).toBeNull()

    fireEvent.click(source)
    expect(details()).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveValue('activity-0')
    expect(workspace).not.toHaveClass('actGraph__workspace--collapsed')
    fireEvent.click(screen.getByRole('button', { name: localized('actGraphFit') }))
    expect(details()).toBeInTheDocument()
    fireEvent.click(canvas)
    expect(details()).not.toBeInTheDocument()
    expect(workspace).toHaveClass('actGraph__workspace--collapsed')
    expect(canvas.querySelector('.actGraph__node--selected')).toBeNull()

    fireEvent.click(source)
    expect(details()).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveValue('activity-0')
    expect(workspace).not.toHaveClass('actGraph__workspace--collapsed')
  })

  it('keeps timeline as default, opens graph, inspects recorded hints, and switches back', () => {
    render(<AgenticActivityTimeline activity={activity} t={t} language="ja" />)
    expect(screen.queryByTestId('graph-canvas')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'グラフ' }))
    expect(screen.getByTestId('graph-canvas')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^searchIndex:/ }))
    expect(screen.getByText('実行時のクエリヒント')).toBeInTheDocument()
    expect(screen.getAllByText(/category eq/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '全体を表示' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'トレース' }))
    expect(screen.queryByTestId('graph-canvas')).not.toBeInTheDocument()
    expect(screen.getByText('実行されたクエリ')).toBeInTheDocument()
  })

  it('offers the graph for an activity-free response and supports keyboard-friendly node selection', () => {
    render(
      <AgenticActivityTimeline
        activity={[]}
        t={t}
        language="ja"
        response={{ at: undefined, requestId: '', url: '', runType: 'agentic_retrieve', status: 502, requestBody: {}, body: { error: { message: 'failed-source' } }, responseFormat: 'json' }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'グラフ' }))
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'delivery' } })
    expect(screen.getAllByText(/failed-source/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /JSON · HTTP 502/ })).toBeInTheDocument()
  })

  it('uses English labels without changing the graph mode when activity updates', () => {
    const english = (key: keyof typeof translations.en) => translations.en[key]
    const { rerender } = render(<AgenticActivityTimeline activity={activity} t={english} language="en" />)
    fireEvent.click(screen.getByRole('button', { name: 'Graph' }))
    rerender(<AgenticActivityTimeline activity={[...activity, { type: 'agenticReasoning', id: 2 }]} t={english} language="en" />)
    expect(screen.getByRole('button', { name: 'Graph' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^agenticReasoning:/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fit view' })).toBeInTheDocument()
  })

  it('places searchIndex and web side by side at the same height even when their times do not overlap', () => {
    render(<AgenticActivityTimeline t={t} language="ja" activity={[
      { type: 'modelQueryPlanning', id: 0 },
      { type: 'searchIndex', id: 1, startedAt: '2026-10-22T00:00:00Z', completedAt: '2026-10-22T00:00:00.100Z' },
      { type: 'web', id: 2, startedAt: '2026-10-22T00:00:01Z', completedAt: '2026-10-22T00:00:01.100Z' },
      { type: 'agenticReasoning', id: 3 },
    ]} />)
    fireEvent.click(screen.getByRole('button', { name: 'グラフ' }))
    const search = screen.getByRole('button', { name: /^searchIndex:/ })
    const web = screen.getByRole('button', { name: /^web:/ })
    expect(search.dataset.y).toBe(web.dataset.y)
    expect(Math.abs(Number(search.dataset.x) - Number(web.dataset.x))).toBeGreaterThanOrEqual(260)
  })

  it('wraps the settings object tree in the standard monospace JSON font and size container', () => {
    render(<AgenticActivityTimeline activity={activity} t={t} language="ja" response={{
      at: undefined, requestId: '', url: '', status: 200, runType: 'agentic_retrieve',
      requestBody: { knowledgeSourceParams: [{ knowledgeSourceName: 'products', resultsProcessing: 'none' }] },
      body: { activity, response: [], references: [] },
    }} />)
    fireEvent.click(screen.getByRole('button', { name: 'グラフ' }))
    fireEvent.click(screen.getByRole('button', { name: /^searchIndex:/ }))
    const toggles = screen.getAllByRole('button', { name: '▼ Object' })
    expect(toggles.every((toggle) => toggle.closest('.mono.jsonViewer__body.rawJsonViewer'))).toBe(true)
  })

  it.each([0, 42])('identifies the graph count %i with an icon and localized hit label', (count) => {
    render(<AgenticActivityTimeline t={t} language="ja" activity={[{ type: 'searchIndex', id: 1, count }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'グラフ' }))
    const hits = screen.getByLabelText(`ヒット: ${count}`)
    expect(hits).toHaveTextContent(`ヒット: ${count}`)
    expect(hits.querySelector('.bi-collection')).not.toBeNull()
  })

  it('separates the knowledge source and query into icon-labeled subtitle rows', () => {
    render(<AgenticActivityTimeline activity={activity} t={t} language="ja" />)
    fireEvent.click(screen.getByRole('button', { name: 'グラフ' }))
    const source = screen.getByText('products').closest('.actGraph__subtitleRow')!
    const query = screen.getByText('実行されたクエリ').closest('.actGraph__subtitleRow')!
    expect(source).not.toBe(query)
    expect(source.querySelector('.bi-database')).not.toBeNull()
    expect(query.querySelector('.bi-search')).not.toBeNull()
    expect(source).toHaveAttribute('title', 'products')
    expect(query).toHaveAttribute('title', '実行されたクエリ')
    expect(source.parentElement).toBe(query.parentElement)
    expect(source.parentElement).toHaveClass('actGraph__nodeSubtitle')
  })

  it('does not render an empty source row for query-only activities', () => {
    render(<AgenticActivityTimeline activity={[{ type: 'web', id: 1, webArguments: { search: 'query only' } }]} t={t} language="ja" />)
    fireEvent.click(screen.getByRole('button', { name: 'グラフ' }))
    const subtitle = screen.getByText('query only').closest('.actGraph__nodeSubtitle')!
    expect(subtitle.querySelector('.bi-database')).toBeNull()
    expect(subtitle.querySelectorAll('.actGraph__subtitleRow')).toHaveLength(1)
  })

  it('shows result text by default and request text when the request node is selected', () => {
    render(<AgenticActivityTimeline activity={activity} t={t} language="ja" response={{
      at: undefined, requestId: '', url: '', status: 200, runType: 'agentic_retrieve',
      requestBody: { messages: [{ role: 'user', content: [{ type: 'text', text: '検索する内容' }] }] },
      body: { response: [{ role: 'assistant', content: [{ type: 'text', text: '最終的な回答本文' }] }], references: [] },
    }} />)
    fireEvent.click(screen.getByRole('button', { name: 'グラフ' }))
    expect(within(screen.getByRole('region', { name: '最終結果のテキスト' })).getByText('最終的な回答本文')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^検索要求:/ }))
    expect(within(screen.getByRole('region', { name: '検索要求のテキスト' })).getByText('検索する内容')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '最終結果のテキスト' })).not.toBeInTheDocument()
  })
})
