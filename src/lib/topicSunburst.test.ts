import { describe, expect, it } from 'vitest'
import { TOPIC_GRAPH_NAME, buildTopicHierarchy, type TopicGraphRow } from './topicGraphCoverage'
import {
  chunkLabels, countChunks, countLeafTopics, fitWheelText, layoutTopicSunburst, placeWheelLabel, ringSegmentPath, topicAncestry, topicWheelLabel,
} from './topicSunburst'

const row = (fields: TopicGraphRow): TopicGraphRow => ({ graphName: TOPIC_GRAPH_NAME, ...fields })
const edge = (predicate: string, subjectId: string, objectId: string) => row({ predicate, subjectId, objectId })
const prop = (predicate: string, subjectId: string, value: string | number) =>
  row(typeof value === 'string' ? { predicate, subjectId, objectString: value } : { predicate, subjectId, objectDouble: value })

// topic:0 (temples) -> topic:2 (0.4), topic:3 (0.1); topic:1 (nature, 0.5) is a leaf.
const hierarchy = buildTopicHierarchy([
  edge('HasRootTopic', 'topicgraph:topicgraph-topic', 'topic:0'),
  edge('HasRootTopic', 'topicgraph:topicgraph-topic', 'topic:1'),
  edge('HasSubTopic', 'topic:0', 'topic:2'),
  edge('HasSubTopic', 'topic:0', 'topic:3'),
  prop('prop:title', 'topic:0', '寺院'),
  prop('prop:title', 'topic:2', '木造建築'),
  prop('prop:proportion', 'topic:2', 0.4),
  prop('prop:proportion', 'topic:3', 0.1),
  prop('prop:proportion', 'topic:1', 0.5),
])

const arcOf = (arcs: ReturnType<typeof layoutTopicSunburst>['arcs'], id: string) => arcs.find((arc) => arc.id === id)

describe('layoutTopicSunburst', () => {
  it('sizes arcs by corpus share and puts every depth on its own ring when no chunks are given', () => {
    const { arcs, levels, total } = layoutTopicSunburst(hierarchy)

    expect(levels).toBe(2)
    expect(total).toBeCloseTo(1, 10)
    expect(arcOf(arcs, 'topic:0')).toMatchObject({ depth: 1, start: 0, zoomable: true, branchIndex: 0 })
    expect(arcOf(arcs, 'topic:0')!.end).toBeCloseTo(Math.PI, 10)
    expect(arcOf(arcs, 'topic:1')).toMatchObject({ depth: 1, zoomable: false, branchIndex: 1 })
    expect(arcOf(arcs, 'topic:2')).toMatchObject({ depth: 2, start: 0 })
    expect(arcOf(arcs, 'topic:2')!.end).toBeCloseTo(Math.PI * 0.8, 10)
    expect(arcOf(arcs, 'topic:3')!.start).toBeCloseTo(Math.PI * 0.8, 10)
    expect(arcOf(arcs, 'topic:3')!.end).toBeCloseTo(Math.PI, 10)
  })

  it('gives every chunk the same width and drops the topics that hold none', () => {
    const chunks = new Map([['topic:2', ['a', 'b', 'c']], ['topic:1', ['d']]])
    const { arcs, levels, total } = layoutTopicSunburst(hierarchy, chunks)

    expect(total).toBe(4)
    expect(levels).toBe(3)
    expect(arcOf(arcs, 'topic:3')).toBeUndefined()
    expect(arcOf(arcs, 'topic:0')!.end).toBeCloseTo((Math.PI * 2 * 3) / 4, 10)
    expect(arcOf(arcs, 'topic:1')).toMatchObject({ zoomable: true, value: 1 })
    const widths = ['a', 'b', 'c', 'd'].map((key) => arcOf(arcs, key)!).map((arc) => arc.end - arc.start)
    widths.forEach((width) => expect(width).toBeCloseTo(Math.PI / 2, 10))
    expect(arcOf(arcs, 'a')).toMatchObject({ kind: 'chunk', topicId: 'topic:2', depth: 3, branchIndex: 0 })
    expect(arcOf(arcs, 'd')).toMatchObject({ kind: 'chunk', topicId: 'topic:1', depth: 2, branchIndex: 1 })
  })

  it('zooms into a topic and ignores a focus that has nothing to show', () => {
    const chunks = new Map([['topic:2', ['a', 'b']]])
    const zoomed = layoutTopicSunburst(hierarchy, undefined, 'topic:0')
    expect(zoomed.arcs.map((arc) => arc.id)).toEqual(['topic:2', 'topic:3'])
    expect(zoomed.levels).toBe(1)
    expect(arcOf(zoomed.arcs, 'topic:2')).toMatchObject({ depth: 1, start: 0 })
    expect(arcOf(zoomed.arcs, 'topic:3')!.end).toBeCloseTo(Math.PI * 2, 10)

    const leaf = layoutTopicSunburst(hierarchy, chunks, 'topic:2')
    expect(leaf.arcs.map((arc) => arc.id)).toEqual(['a', 'b'])
    expect(leaf.total).toBe(2)

    expect(layoutTopicSunburst(hierarchy, undefined, 'topic:1')).toEqual(layoutTopicSunburst(hierarchy))
    expect(layoutTopicSunburst(hierarchy, undefined, 'topic:missing')).toEqual(layoutTopicSunburst(hierarchy))
  })

  it('returns no arcs when no chunk was placed in any leaf topic', () => {
    expect(layoutTopicSunburst(hierarchy, new Map())).toEqual({ arcs: [], levels: 0, total: 0 })
  })
})

describe('topic helpers', () => {
  it('labels topics with their short ID and title, and chunks in key order', () => {
    expect(topicWheelLabel(hierarchy.topics.get('topic:2')!)).toBe('2: 木造建築')
    expect(topicWheelLabel(hierarchy.topics.get('topic:1')!)).toBe('1')
    expect([...chunkLabels(['x', 'y'])]).toEqual([['x', 'C1'], ['y', 'C2']])
  })

  it('walks the ancestry and counts leaf topics and chunks below a topic', () => {
    const chunks = new Map([['topic:2', ['a', 'b']], ['topic:1', ['c']]])

    expect(topicAncestry(hierarchy, 'topic:3')).toEqual(['topic:0', 'topic:3'])
    expect(countLeafTopics(hierarchy)).toBe(3)
    expect(countLeafTopics(hierarchy, 'topic:0')).toBe(2)
    expect(countLeafTopics(hierarchy, 'topic:missing')).toBe(0)
    expect(countChunks(hierarchy, chunks, 'topic:0')).toBe(2)
    expect(countChunks(hierarchy, chunks, 'topic:3')).toBe(0)
  })
})

describe('ringSegmentPath', () => {
  it('draws a segment clockwise from 12 o\'clock', () => {
    expect(ringSegmentPath(10, 20, 0, Math.PI / 2)).toBe('M0 -20 A20 20 0 0 1 20 0 L10 0 A10 10 0 0 0 0 -10 Z')
  })

  it('uses the large-arc flag past a half turn and stays drawable for a full turn', () => {
    expect(ringSegmentPath(10, 20, 0, Math.PI * 1.5)).toContain('A20 20 0 1 1')
    const full = ringSegmentPath(10, 20, 0, Math.PI * 2)
    expect(full).not.toMatch(/NaN/)
    expect(full).toContain('A20 20 0 1 1')
  })
})

describe('wheel labels', () => {
  it('shortens text by display width, counting Japanese characters as full width', () => {
    expect(fitWheelText('abc', 100, 11)).toBe('abc')
    expect(fitWheelText('近藤寺の本堂', 40, 11)).toBe('近藤寺…')
    expect(fitWheelText('近藤寺', 5, 11)).toBeUndefined()
  })

  it('places a radial label that is never upside down and skips segments that are too small', () => {
    expect(placeWheelLabel('寺院', 64, 140, 0, Math.PI, 11)).toMatchObject({ x: 102, y: 0, rotation: 0, text: '寺院' })
    expect(placeWheelLabel('寺院', 64, 140, Math.PI, Math.PI * 2, 11)).toMatchObject({ x: -102, rotation: 0 })
    expect(placeWheelLabel('寺院', 64, 140, 0, 0.01, 11)).toBeUndefined()
    expect(placeWheelLabel('寺院', 64, 70, 0, Math.PI, 11)).toBeUndefined()
  })
})
