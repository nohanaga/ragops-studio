import { describe, expect, it } from 'vitest'
import { color as echartsColor } from 'echarts/core'
import { TOPIC_GRAPH_NAME, buildTopicHierarchy, topicBranchColor, type TopicGraphRow } from './topicGraphCoverage'
import {
  TREE_ROOT_ID, buildSunburstItems, buildSunburstOption, buildTreeItems, buildTreeOption, chunkLabels, countChunks, countLeafTopics, escapeHtml,
  formatShare, topicAncestry, topicWheelLabel, type TopicChartColors, type TopicChartItem, type TopicChartText,
} from './topicCharts'

const row = (fields: TopicGraphRow): TopicGraphRow => ({ graphName: TOPIC_GRAPH_NAME, ...fields })
const edge = (predicate: string, subjectId: string, objectId: string) => row({ predicate, subjectId, objectId })
const prop = (predicate: string, subjectId: string, value: string | number) =>
  row(typeof value === 'string' ? { predicate, subjectId, objectString: value } : { predicate, subjectId, objectDouble: value })

// topic:0 (temples) -> topic:2 (0.4), topic:3 (0.1); topic:1 (nature, 0.5) is a leaf.
const rows: TopicGraphRow[] = [
  edge('HasRootTopic', 'topicgraph:topicgraph-topic', 'topic:0'),
  edge('HasRootTopic', 'topicgraph:topicgraph-topic', 'topic:1'),
  edge('HasSubTopic', 'topic:0', 'topic:2'),
  edge('HasSubTopic', 'topic:0', 'topic:3'),
  prop('prop:title', 'topic:0', '寺院'),
  prop('prop:title', 'topic:2', '木造建築'),
  prop('prop:proportion', 'topic:2', 0.4),
  prop('prop:proportion', 'topic:3', 0.1),
  prop('prop:proportion', 'topic:1', 0.5),
]
const hierarchy = buildTopicHierarchy(rows)
const text: TopicChartText = { collection: 'Collection', share: 'Share', chunks: 'Chunks', assignedTopic: 'Assigned topic', leafTopics: 'Leaf topics' }
const colors: TopicChartColors = { foreground: '#eee', muted: '#999', panel: '#111', border: '#333', accent: '#4af' }
const chunks = new Map([['topic:2', ['a', 'b', 'c']], ['topic:1', ['d']]])
const labels = chunkLabels(['a', 'b', 'c', 'd'])
const input = { hierarchy, labels, text }

const find = (items: readonly TopicChartItem[], id: string): TopicChartItem | undefined => {
  for (const item of items) {
    const found = item.id === id ? item : item.children && find(item.children, id)
    if (found) return found
  }
  return undefined
}
const lightness = (color: string) => Number(/ (\d+)%\)$/.exec(color)?.[1])

describe('topic helpers', () => {
  it('labels topics with their short ID and title, and chunks in key order', () => {
    expect(topicWheelLabel(hierarchy.topics.get('topic:2')!)).toBe('2: 木造建築')
    expect(topicWheelLabel(hierarchy.topics.get('topic:1')!)).toBe('1')
    expect([...chunkLabels(['x', 'y'])]).toEqual([['x', 'C1'], ['y', 'C2']])
  })

  it('walks the ancestry and counts leaf topics and chunks below a topic', () => {
    expect(topicAncestry(hierarchy, 'topic:3')).toEqual(['topic:0', 'topic:3'])
    expect(countLeafTopics(hierarchy)).toBe(3)
    expect(countLeafTopics(hierarchy, 'topic:0')).toBe(2)
    expect(countLeafTopics(hierarchy, 'topic:missing')).toBe(0)
    expect(countChunks(hierarchy, chunks, 'topic:0')).toBe(3)
    expect(countChunks(hierarchy, chunks, 'topic:3')).toBe(0)
  })

  it('formats shares with one decimal only below 10 percent and escapes HTML', () => {
    expect(formatShare(0.5)).toBe('50%')
    expect(formatShare(0.1)).toBe('10%')
    expect(formatShare(0.042)).toBe('4.2%')
    expect(formatShare(0)).toBe('0%')
    expect(escapeHtml(`<b onclick="x">'&'</b>`)).toBe('&lt;b onclick=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/b&gt;')
  })
})

describe('buildSunburstItems', () => {
  it('sizes the leaves by corpus share and lets ECharts sum the parents', () => {
    const { items, total } = buildSunburstItems(input)

    expect(items.map((item) => item.id)).toEqual(['topic:0', 'topic:1'])
    expect(total).toBeCloseTo(1, 10)
    expect(items[0]).toMatchObject({ kind: 'topic', name: '0: 寺院', zoomable: true })
    expect(items[0].value).toBeUndefined()
    expect(items[0].children?.map((item) => [item.id, item.value])).toEqual([['topic:2', 0.4], ['topic:3', 0.1]])
    expect(items[1]).toMatchObject({ id: 'topic:1', value: 0.5, zoomable: false })
  })

  it('colors the branches apart and makes deeper topics lighter', () => {
    const { items } = buildSunburstItems(input)

    expect(items[0].itemStyle.color).not.toBe(items[1].itemStyle.color)
    expect(lightness(items[0].children![0].itemStyle.color)).toBeGreaterThan(lightness(items[0].itemStyle.color))
    expect(items[0].children![0].itemStyle.color.split(' ')[0]).toBe(items[0].itemStyle.color.split(' ')[0])
  })

  it('gives every chunk the same value under its leaf topic and drops the topics that hold none', () => {
    const { items, total } = buildSunburstItems({ ...input, chunks })

    expect(total).toBe(4)
    expect(find(items, 'topic:3')).toBeUndefined()
    const wood = find(items, 'topic:2')!
    expect(wood.value).toBeUndefined()
    expect(wood.children?.map((item) => [item.id, item.name, item.kind, item.value])).toEqual([
      ['a', 'C1', 'chunk', 1], ['b', 'C2', 'chunk', 1], ['c', 'C3', 'chunk', 1],
    ])
    expect(find(items, 'd')).toMatchObject({ kind: 'chunk', topicId: 'topic:1' })
    expect(find(items, 'topic:1')).toMatchObject({ zoomable: true })
  })

  it('starts below the focused topic and ignores a focus that has nothing to show', () => {
    expect(buildSunburstItems({ ...input, focusId: 'topic:0' }).items.map((item) => item.id)).toEqual(['topic:2', 'topic:3'])

    const leaf = buildSunburstItems({ ...input, chunks, focusId: 'topic:2' })
    expect(leaf.items.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(leaf.total).toBe(3)

    const whole = buildSunburstItems(input)
    expect(buildSunburstItems({ ...input, focusId: 'topic:1' })).toEqual(whole)
    expect(buildSunburstItems({ ...input, focusId: 'topic:missing' })).toEqual(whole)
  })

  it('returns nothing when no chunk was placed in any leaf topic', () => {
    expect(buildSunburstItems({ ...input, chunks: new Map() })).toEqual({ items: [], total: 0 })
  })

  it('escapes every index-provided value in the tooltips', () => {
    const hostile = buildTopicHierarchy([
      edge('HasRootTopic', 'topicgraph:topicgraph-topic', 'topic:0'),
      prop('prop:title', 'topic:0', '<img src=x onerror="alert(1)">'),
      prop('prop:proportion', 'topic:0', 1),
    ])
    const topic = buildSunburstItems({ hierarchy: hostile, labels: chunkLabels(['<k>']), text, chunks: new Map([['topic:0', ['<k>']]]) }).items[0]

    expect(topic.tip).not.toContain('<img')
    expect(topic.tip).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(topic.children![0].tip).not.toContain('<k>')
    expect(topic.children![0].tip).toContain('&lt;k&gt;')
  })

  it('describes a topic in its tooltip with the path, share, leaf topics and, when chunks are shown, the chunk count', () => {
    const plain = find(buildSunburstItems(input).items, 'topic:2')!.tip
    expect(plain).toContain('2: 木造建築')
    expect(plain).toContain('寺院 › 木造建築')
    expect(plain).toContain('Share:')
    expect(plain).toContain('40%')
    expect(plain).not.toContain('Chunks:')
    expect(find(buildSunburstItems({ ...input, chunks }).items, 'topic:2')!.tip).toContain('Chunks:')
  })
})

describe('buildSunburstOption', () => {
  const items = buildSunburstItems(input).items
  const option = buildSunburstOption({ items, title: 'Collection', subtitle: '3 topics', colors, animate: true, ariaLabel: 'Wheel' }) as {
    title: { text: string; subtext: string; triggerEvent: boolean }
    tooltip: { formatter: (params: unknown) => string; backgroundColor: string }
    aria: { enabled: boolean; label: { description: string } }
    series: Array<{ type: string; nodeClick: boolean; data: unknown; sort: (a: { dataIndex: number }, b: { dataIndex: number }) => number }>
  }

  it('puts the title in the hole of the sunburst and lets the app, not ECharts, handle zooming', () => {
    expect(option.title).toMatchObject({ text: 'Collection', subtext: '3 topics', triggerEvent: true })
    expect(option.series[0]).toMatchObject({ type: 'sunburst', nodeClick: false })
    expect((option.series[0].data as TopicChartItem[]).map((item) => item.id)).toEqual(['topic:0', 'topic:1'])
    expect(option.aria).toEqual({ enabled: true, label: { description: 'Wheel' } })
    expect(option.tooltip.backgroundColor).toBe('#111')
  })

  it('keeps the order of the hierarchy and shows the prebuilt tooltip', () => {
    expect(option.series[0].sort({ dataIndex: 1 }, { dataIndex: 2 })).toBeLessThan(0)
    expect(option.tooltip.formatter({ data: { tip: '<b>x</b>' } })).toBe('<b>x</b>')
    expect(option.tooltip.formatter({ data: {} })).toBe('')
    expect(option.tooltip.formatter(null)).toBe('')
  })

  it('only uses colors that ECharts can parse, because it derives the hover color from them', () => {
    // A color that ECharts cannot parse (such as the space-separated `hsl(0 62% 52%)`) has no hover color. The hovered
    // segment then loses its fill and cannot be hit, so hovering flips on and off with every pixel the pointer moves.
    const sunburst = buildSunburstItems({ ...input, chunks }).items
    const tree = buildTreeItems({ ...input, chunks, mode: 'expanded', colors })
    const colorsOf = (items: Array<{ itemStyle: { color: string }; children?: unknown[] }>): string[] =>
      items.flatMap((item) => [item.itemStyle.color, ...colorsOf((item.children ?? []) as typeof items)])
    const all = [...colorsOf(sunburst), ...colorsOf([tree.root])]

    expect(all.length).toBeGreaterThan(10)
    for (const value of new Set(all)) {
      expect(echartsColor.parse(value), value).toBeTruthy()
      expect(typeof echartsColor.lift(value, 0.1), value).toBe('string')
    }
    expect(topicBranchColor(3, 60, 50)).toMatch(/^hsl\(\d+, 50%, 60%\)$/)
  })

  it('writes a short name along the ring, a long name along its wide arc, and cuts a long name on a narrow arc', () => {
    const long = '近藤寺の百八盤千手観音と周辺の文化財'
    const crowded = buildTopicHierarchy([
      edge('HasRootTopic', 'topicgraph:topicgraph-topic', 'topic:0'),
      edge('HasRootTopic', 'topicgraph:topicgraph-topic', 'topic:1'),
      edge('HasRootTopic', 'topicgraph:topicgraph-topic', 'topic:2'),
      prop('prop:title', 'topic:0', long),
      prop('prop:title', 'topic:1', long),
      prop('prop:title', 'topic:2', 'Short'),
      prop('prop:proportion', 'topic:0', 0.9),
      prop('prop:proportion', 'topic:1', 0.01),
      prop('prop:proportion', 'topic:2', 0.09),
    ])
    const data = (buildSunburstOption({
      items: buildSunburstItems({ hierarchy: crowded, labels, text }).items, title: '', subtitle: '', colors, animate: false, ariaLabel: '',
    }) as { series: Array<{ data: TopicChartItem[] }> }).series[0].data
    const label = (id: string) => data.find((item) => item.id === id)!.label!

    expect(label('topic:0')).toMatchObject({ rotate: 'tangential' })
    expect(label('topic:0').width).toBeGreaterThan(label('topic:2').width)
    expect(label('topic:1')).toMatchObject({ rotate: 'radial' })
    expect(label('topic:2')).toMatchObject({ rotate: 'radial' })
  })
})

describe('buildTreeItems', () => {
  const build = (mode: 'default' | 'expanded' | 'collapsed', withChunks = false) =>
    buildTreeItems({ ...input, chunks: withChunks ? chunks : undefined, mode, colors })

  it('puts the topics under the collection and sizes a node by the share of its topic', () => {
    const { root } = build('default')

    expect(root).toMatchObject({ id: TREE_ROOT_ID, kind: 'root', name: 'Collection', collapsed: false })
    expect(root.children?.map((item) => item.id)).toEqual(['topic:0', 'topic:1'])
    expect(root.children![0].children?.map((item) => item.id)).toEqual(['topic:2', 'topic:3'])
    expect(root.children![1].symbolSize).toBeGreaterThan(root.children![0].children![1].symbolSize)
    expect(root.children![0].lineStyle.color).toBe(root.children![0].itemStyle.color)
  })

  it('opens the topics and folds the chunks by default, and can open or fold everything', () => {
    const initial = build('default', true).root
    expect(initial.children![0].collapsed).toBe(false)
    expect(initial.children![0].children![0]).toMatchObject({ id: 'topic:2', collapsed: true })
    expect(initial.children![0].children![0].children?.map((item) => item.name)).toEqual(['C1', 'C2', 'C3'])
    expect(initial.children![1]).toMatchObject({ id: 'topic:1', collapsed: true })
    expect(initial.children![0].children![1]).toMatchObject({ id: 'topic:3', collapsed: false })

    const open = build('expanded', true).root
    expect(open.children![0].children![0].collapsed).toBe(false)
    expect(open.children![1].collapsed).toBe(false)

    const folded = build('collapsed', true).root
    expect(folded.collapsed).toBe(false)
    expect(folded.children!.every((item) => item.collapsed)).toBe(true)
  })

  it('counts the leaves that are visible so that the chart can be sized', () => {
    expect(build('default').visibleLeaves).toBe(3)
    expect(build('default', true).visibleLeaves).toBe(3)
    expect(build('expanded', true).visibleLeaves).toBe(5)
    expect(build('collapsed').visibleLeaves).toBe(2)
  })
})

describe('buildTreeOption', () => {
  const { root } = buildTreeItems({ ...input, mode: 'default', colors })
  const series = (layout: 'LR' | 'TB' | 'radial') =>
    (buildTreeOption({ root, layout, colors, animate: false, ariaLabel: 'Tree' }) as {
      animation: boolean
      series: Array<{ type: string; layout: string; orient?: string; roam: boolean; data: unknown[]; edgeShape: string; label: { rotate?: number }; leaves?: { label: { rotate?: number } } }>
    })

  it('draws a pannable, zoomable curved tree whose nodes open and close on click', () => {
    const option = series('LR')

    expect(option.animation).toBe(false)
    expect(option.series[0]).toMatchObject({ type: 'tree', layout: 'orthogonal', orient: 'LR', roam: true, edgeShape: 'curve', data: [root] })
  })

  it('lays the labels out for each direction', () => {
    expect(series('TB').series[0]).toMatchObject({ layout: 'orthogonal', orient: 'TB' })
    expect(series('TB').series[0].label.rotate).toBe(-90)
    expect(series('LR').series[0].label.rotate).toBeUndefined()
    expect(series('radial').series[0]).toMatchObject({ layout: 'radial' })
    expect(series('radial').series[0].orient).toBeUndefined()
  })
})
