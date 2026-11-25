import { describe, expect, it } from 'vitest'
import {
  TOPIC_GRAPH_NAME, TopicGraphFormatError, buildTopicHierarchy, layoutTopicTreemap, summarizeTopicCoverage,
  type TopicGraphRow,
} from './topicGraphCoverage'

const row = (fields: TopicGraphRow): TopicGraphRow => ({ graphName: TOPIC_GRAPH_NAME, ...fields })
const edge = (predicate: string, subjectId: string, objectId: string) => row({ predicate, subjectId, objectId })
const prop = (predicate: string, subjectId: string, value: string | number) =>
  row(typeof value === 'string' ? { predicate, subjectId, objectString: value } : { predicate, subjectId, objectDouble: value })

// topic:0 (temples) -> topic:2, topic:3; topic:1 (nature) is a leaf.
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

describe('buildTopicHierarchy', () => {
  it('builds depth, branches, leaves and parent proportions from the edge list', () => {
    const hierarchy = buildTopicHierarchy(rows)

    expect(hierarchy.roots).toEqual(['topic:0', 'topic:1'])
    expect(hierarchy.leaves.sort()).toEqual(['topic:1', 'topic:2', 'topic:3'])
    expect(hierarchy.topics.get('topic:2')).toMatchObject({ depth: 1, branchId: 'topic:0', parentId: 'topic:0', label: '木造建築' })
    expect(hierarchy.topics.get('topic:0')?.proportion).toBeCloseTo(0.5, 10)
    expect(hierarchy.topics.get('topic:0')?.children).toEqual(['topic:2', 'topic:3'])
  })

  it('rejects documents that are not a complete topic hierarchy instead of guessing', () => {
    const code = (input: TopicGraphRow[]) => {
      try {
        buildTopicHierarchy(input)
      } catch (error) {
        return error instanceof TopicGraphFormatError ? error.code : 'unexpected'
      }
      return 'none'
    }

    expect(code([])).toBe('empty')
    expect(code([{ ...rows[0], graphName: 'entity-graph' }])).toBe('graphName')
    expect(code(rows.filter((item) => item.predicate !== 'HasRootTopic'))).toBe('noRoot')
    expect(code([...rows, edge('HasSubTopic', 'topic:1', 'topic:2')])).toBe('multipleParents')
    expect(code(rows.filter((item) => !(item.predicate === 'prop:proportion' && item.subjectId === 'topic:1')))).toBe('proportion')
    expect(code([...rows, edge('HasSubTopic', 'topic:9', 'topic:8')])).toBe('orphan')
  })
})

describe('summarizeTopicCoverage', () => {
  const hierarchy = buildTopicHierarchy(rows)

  it('counts hit topics, the effective number of topics and the corpus share they cover', () => {
    const spread = summarizeTopicCoverage(hierarchy, ['topic:2', 'topic:1', 'topic:3', 'topic:1'])
    expect(spread).toMatchObject({ assigned: 4, unassigned: 0, leafCount: 3 })
    expect(spread.hits[0]).toEqual({ leafId: 'topic:1', count: 2, ranks: [2, 4] })
    expect(spread.corpusCoverage).toBeCloseTo(1, 10)
    expect(spread.effectiveTopics).toBeCloseTo(Math.exp(-(0.5 * Math.log(0.5) + 2 * 0.25 * Math.log(0.25))), 10)

    const focused = summarizeTopicCoverage(hierarchy, ['topic:2', 'topic:2', undefined, 'topic:2'])
    expect(focused).toMatchObject({ assigned: 3, unassigned: 1 })
    expect(focused.effectiveTopics).toBeCloseTo(1, 10)
    expect(focused.corpusCoverage).toBeCloseTo(0.4, 10)
    expect(summarizeTopicCoverage(hierarchy, [undefined]).effectiveTopics).toBe(0)
  })
})

describe('layoutTopicTreemap', () => {
  it('fills the area in proportion to each leaf share without overlaps', () => {
    const hierarchy = buildTopicHierarchy(rows)
    const cells = layoutTopicTreemap(hierarchy, 200, 100, 0)

    expect(cells.map((cell) => cell.id).sort()).toEqual(['topic:1', 'topic:2', 'topic:3'])
    for (const cell of cells) {
      expect(cell.width * cell.height).toBeCloseTo(hierarchy.topics.get(cell.id)!.proportion * 20000, 4)
      expect(cell.branchId).toBe(hierarchy.topics.get(cell.id)!.branchId)
    }
    for (const [index, left] of cells.entries()) {
      for (const right of cells.slice(index + 1)) {
        const overlapX = Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x)
        const overlapY = Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y)
        expect(overlapX <= 1e-9 || overlapY <= 1e-9).toBe(true)
      }
    }
  })
})
