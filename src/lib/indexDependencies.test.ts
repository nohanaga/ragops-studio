import { describe, expect, it } from 'vitest'

import {
  DEPENDENCY_NODE_HEIGHT,
  DEPENDENCY_NODE_WIDTH,
  buildDependencyGraph,
  layoutDependencyGraph,
  withDraftIndex,
  type DependencySnapshot,
} from './indexDependencies'

const KB = 'ft-topic-worldheritage-agentic-kb'
const KS = 'ft-topic-worldheritage-agentic-ks'
const CHUNKS = 'ft-topic-worldheritage-src'
const PROFILE = 'iq-notebook-topics'
const TOPICS = 'ft-published-heritage-sites-topics-a49011b13ce3'

function snapshot(): DependencySnapshot {
  return {
    knowledgeBases: [{ name: KB, knowledgeSources: [{ name: KS }] }],
    knowledgeSources: [{ name: KS, kind: 'searchIndex', searchIndexParameters: { searchIndexName: CHUNKS } }],
    indexes: [
      {
        name: CHUNKS,
        fields: [
          { name: 'id', type: 'Edm.String', key: true },
          { name: 'snippet_vector', type: 'Collection(Edm.Single)', dimensions: 8, topicGraphProfile: PROFILE },
        ],
        vectorSearch: { topicGraphProfiles: [{ name: PROFILE, indexName: TOPICS, defaultKind: 'balanced' }] },
      },
      { name: TOPICS, fields: [{ name: 'id', type: 'Edm.String', key: true }], graphProfile: { kind: 'edgeList', fields: {} } },
      { name: 'unrelated', fields: [] },
    ],
  }
}

const labels = (graph: ReturnType<typeof buildDependencyGraph>) => graph.edges.map((edge) => `${edge.from} -[${edge.label}]-> ${edge.to}`).sort()

describe('lib/indexDependencies buildDependencyGraph', () => {
  const expectedEdges = [
    `index:${CHUNKS} -[snippet_vector.topicGraphProfile]-> topicProfile:${CHUNKS}:${PROFILE}`,
    `knowledgeBase:${KB} -[knowledgeSources]-> knowledgeSource:${KS}`,
    `knowledgeSource:${KS} -[searchIndexName]-> index:${CHUNKS}`,
    `topicProfile:${CHUNKS}:${PROFILE} -[indexName]-> index:${TOPICS}`,
  ].sort()

  it('links knowledge base, source, chunk index, topic profile and topic index', () => {
    const graph = buildDependencyGraph(snapshot(), CHUNKS)

    expect(labels(graph)).toEqual(expectedEdges)
    expect(graph.nodes.map((node) => node.kind).sort()).toEqual(['index', 'index', 'knowledgeBase', 'knowledgeSource', 'topicProfile'])
    expect(graph.focusId).toBe(`index:${CHUNKS}`)
  })

  it('shows the same chain when the topic index is the focus', () => {
    const graph = buildDependencyGraph(snapshot(), TOPICS)

    expect(labels(graph)).toEqual(expectedEdges)
    const topic = graph.nodes.find((node) => node.id === `index:${TOPICS}`)
    expect(topic?.roles).toEqual(['topic', 'graph'])
    expect(graph.nodes.find((node) => node.id === `index:${CHUNKS}`)?.roles).toEqual(['searchTarget'])
    expect(graph.nodes.find((node) => node.id === `topicProfile:${CHUNKS}:${PROFILE}`)).toMatchObject({ detail: 'balanced', ownerIndex: CHUNKS, missing: false })
  })

  it('does not include resources that only share an ancestor with the focus', () => {
    const data = snapshot()
    data.knowledgeBases = [{ name: KB, knowledgeSources: [{ name: KS }, { name: 'other-ks' }] }]
    data.knowledgeSources = [...data.knowledgeSources, { name: 'other-ks', kind: 'searchIndex', searchIndexParameters: { searchIndexName: 'unrelated' } }]

    const graph = buildDependencyGraph(data, CHUNKS)

    expect(graph.nodes.map((node) => node.name)).not.toContain('other-ks')
    expect(graph.nodes.map((node) => node.name)).not.toContain('unrelated')
    expect(graph.nodes.map((node) => node.name)).toContain(KB)
  })

  it('marks references to resources that cannot be found', () => {
    const data = snapshot()
    data.knowledgeSources = [{ name: KS, kind: 'searchIndex', searchIndexParameters: { searchIndexName: 'gone' } }]
    data.knowledgeBases = [{ name: KB, knowledgeSources: [{ name: KS }, { name: 'deleted-ks' }] }]

    const graph = buildDependencyGraph(data, 'gone')

    expect(graph.nodes.find((node) => node.name === 'gone')).toMatchObject({ kind: 'index', missing: true })
    expect(graph.nodes.map((node) => node.name)).not.toContain('deleted-ks')

    const fromKb = buildDependencyGraph({ ...data, indexes: [...data.indexes, { name: 'gone', fields: [] }] }, 'gone')
    expect(fromKb.nodes.find((node) => node.name === 'gone')?.missing).toBe(false)
  })

  it('reads the indexes created by a blob knowledge source and its entity graph', () => {
    const data: DependencySnapshot = {
      knowledgeBases: [],
      knowledgeSources: [{
        name: 'blob-ks',
        kind: 'azureBlob',
        azureBlobParameters: { createdResources: { datasource: 'ds', indexer: 'ix', skillset: 'sk', index: 'blob-chunks', graphIndex: 'blob-graph' } },
      }],
      indexes: [
        { name: 'blob-chunks', fields: [] },
        { name: 'blob-graph', fields: [], graphProfile: { kind: 'edgeList', fields: {}, provenanceIndexName: 'blob-chunks' } },
      ],
    }

    const graph = buildDependencyGraph(data, 'blob-graph')

    expect(labels(graph)).toEqual([
      'index:blob-graph -[graphProfile.provenanceIndexName]-> index:blob-chunks',
      'knowledgeSource:blob-ks -[createdResources.graphIndex]-> index:blob-graph',
      'knowledgeSource:blob-ks -[createdResources.index]-> index:blob-chunks',
    ])
    expect(graph.nodes.find((node) => node.name === 'blob-graph')?.roles).toEqual(['entityGraph', 'graph'])
    expect(graph.nodes.find((node) => node.name === 'blob-chunks')?.roles).toEqual(['searchTarget', 'provenance'])
    expect(graph.nodes.find((node) => node.name === 'blob-ks')?.detail).toBe('azureBlob')
  })

  it('keeps an unlinked topic profile and a link to an undefined profile visible', () => {
    const data: DependencySnapshot = {
      knowledgeBases: [],
      knowledgeSources: [],
      indexes: [{
        name: 'docs',
        fields: [{ name: 'vec', type: 'Collection(Edm.Single)', dimensions: 4, topicGraphProfile: 'undefined-profile' }],
        vectorSearch: { topicGraphProfiles: [{ name: 'idle', indexName: 'docs-topics', defaultKind: 'none' }] },
      }, { name: 'docs-topics', fields: [] }],
    }

    const graph = buildDependencyGraph(data, 'docs')

    expect(graph.edges.find((edge) => edge.kind === 'unlinkedProfile')).toMatchObject({ to: 'topicProfile:docs:idle', label: 'topicGraphProfiles' })
    expect(graph.nodes.find((node) => node.id === 'topicProfile:docs:undefined-profile')?.missing).toBe(true)
    expect(graph.nodes.map((node) => node.name)).toContain('docs-topics')
  })

  it('merges the links of several vector fields to one profile', () => {
    const data = snapshot()
    ;(data.indexes[0].fields as Array<Record<string, unknown>>).push({ name: 'title_vector', type: 'Collection(Edm.Single)', dimensions: 8, topicGraphProfile: PROFILE })

    const graph = buildDependencyGraph(data, CHUNKS)

    expect(graph.edges.filter((edge) => edge.kind === 'fieldProfile')).toHaveLength(1)
    expect(graph.edges.find((edge) => edge.kind === 'fieldProfile')?.label).toBe('snippet_vector.topicGraphProfile, title_vector.topicGraphProfile')
  })

  it('shows the unsaved definition of the focus index', () => {
    const base = snapshot()
    const draft = {
      name: CHUNKS,
      fields: [{ name: 'snippet_vector', type: 'Collection(Edm.Single)', dimensions: 8 }],
      vectorSearch: { topicGraphProfiles: [{ name: 'new-profile', indexName: 'other-topics', defaultKind: 'diverse' }] },
    }

    const graph = buildDependencyGraph(withDraftIndex(base, draft), CHUNKS)

    expect(graph.nodes.map((node) => node.name)).toContain('new-profile')
    expect(graph.nodes.map((node) => node.name)).not.toContain(PROFILE)
    expect(graph.nodes.find((node) => node.name === 'other-topics')?.missing).toBe(true)
    expect(withDraftIndex(base, null)).toBe(base)
    expect(withDraftIndex(base, { fields: [] })).toBe(base)
  })

  it('returns one node for an index without relations and nothing without a focus', () => {
    const alone = buildDependencyGraph(snapshot(), 'unrelated')
    expect(alone.nodes.map((node) => node.id)).toEqual(['index:unrelated'])
    expect(alone.edges).toEqual([])
    expect(buildDependencyGraph(snapshot(), '  ')).toEqual({ focusId: '', nodes: [], edges: [] })
  })

  it('terminates when resources reference each other', () => {
    const data: DependencySnapshot = {
      knowledgeBases: [],
      knowledgeSources: [],
      indexes: [{
        name: 'loop',
        fields: [{ name: 'vec', type: 'Collection(Edm.Single)', dimensions: 4, topicGraphProfile: 'self' }],
        vectorSearch: { topicGraphProfiles: [{ name: 'self', indexName: 'loop', defaultKind: 'balanced' }] },
        graphProfile: { kind: 'edgeList', fields: {}, provenanceIndexName: 'loop' },
      }],
    }

    const layout = layoutDependencyGraph(buildDependencyGraph(data, 'loop'))

    expect(layout.nodes).toHaveLength(2)
    expect(layout.edges.length).toBe(3)
  })
})

describe('lib/indexDependencies layoutDependencyGraph', () => {
  it('places referencing resources above the resources they reference', () => {
    const layout = layoutDependencyGraph(buildDependencyGraph(snapshot(), CHUNKS))
    const byName = new Map(layout.nodes.map((node) => [node.name, node]))

    const layers = [KB, KS, CHUNKS, PROFILE, TOPICS].map((name) => byName.get(name)?.layer)
    expect(layers).toEqual([0, 1, 2, 3, 4])
    expect(byName.get(TOPICS)?.y).toBe(4 * (DEPENDENCY_NODE_HEIGHT + 76))
    expect(layout.height).toBe(5 * DEPENDENCY_NODE_HEIGHT + 4 * 76)
    expect(layout.width).toBe(DEPENDENCY_NODE_WIDTH)
    expect(layout.edges).toHaveLength(4)
    for (const edge of layout.edges) expect(edge.path).toMatch(/^M [\d.]+ [\d.]+ C /)
  })

  it('centers narrower rows and keeps nodes of one row apart', () => {
    const data = snapshot()
    data.knowledgeBases = [{ name: 'kb-a', knowledgeSources: [{ name: KS }] }, { name: 'kb-b', knowledgeSources: [{ name: KS }] }]

    const layout = layoutDependencyGraph(buildDependencyGraph(data, CHUNKS))
    const kbs = layout.nodes.filter((node) => node.kind === 'knowledgeBase').sort((a, b) => a.x - b.x)
    const source = layout.nodes.find((node) => node.kind === 'knowledgeSource')

    expect(kbs.map((node) => node.name)).toEqual(['kb-a', 'kb-b'])
    expect(kbs[1].x - kbs[0].x).toBeGreaterThanOrEqual(DEPENDENCY_NODE_WIDTH)
    expect(layout.width).toBe(2 * DEPENDENCY_NODE_WIDTH + 32)
    expect(source?.x).toBe((layout.width - DEPENDENCY_NODE_WIDTH) / 2)
  })

  it('handles an empty graph', () => {
    expect(layoutDependencyGraph({ focusId: '', nodes: [], edges: [] })).toEqual({ nodes: [], edges: [], width: DEPENDENCY_NODE_WIDTH, height: DEPENDENCY_NODE_HEIGHT })
  })
})
