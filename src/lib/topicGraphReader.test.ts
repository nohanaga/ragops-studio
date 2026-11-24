import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue, RestResult } from './aiSearchRest'
import type { ConnectionProfile } from './model'

const rest = vi.hoisted(() => ({
  getKnowledgeSource: vi.fn(),
  getIndexDefinition: vi.fn(),
  searchDocuments: vi.fn(),
}))
vi.mock('./aiSearchRest', () => rest)

import {
  findNearestLeafTopics, loadChunkVectors, loadTopicHierarchy, resolveTopicGraphBinding, TopicGraphReadError, type TopicGraphBinding,
} from './topicGraphReader'

const connection = { profile: { endpoint: 'https://search.example', apiVersion: '2026-11-01-preview' } as ConnectionProfile, language: 'en' as const }
const ok = (response: JsonValue): RestResult => ({ ok: true, status: 200, requestId: 'r', url: '', response })
const failure = (message: string): RestResult => ({ ok: false, status: 403, requestId: 'r-1', url: '', error: { message } })

const contentIndex = (overrides: Record<string, JsonValue> = {}): JsonValue => ({
  name: 'content',
  fields: [
    { name: 'id', type: 'Edm.String', key: true },
    { name: 'vec', type: 'Collection(Edm.Single)', dimensions: 3, topicGraphProfile: 'topics' },
  ],
  vectorSearch: { topicGraphProfiles: [{ name: 'topics', indexName: 'topic-index', defaultKind: 'none' }] },
  ...overrides,
})
const topicIndex: JsonValue = {
  name: 'topic-index',
  fields: [
    { name: 'id', type: 'Edm.String', key: true },
    { name: 'object_vector', type: 'Collection(Edm.Single)', dimensions: 3, retrievable: false },
  ],
  graphProfile: {
    fields: {
      graphNameField: 'graph_name', subjectIdField: 'subject_id', predicateField: 'predicate',
      objectIdField: 'object_id', objectStringField: 'object_string', objectDoubleField: 'object_double',
    },
  },
}
const binding = (overrides: Partial<TopicGraphBinding> = {}): TopicGraphBinding => ({
  sourceName: 'ks', contentIndex: 'content', keyField: 'id', vectorField: 'vec', profileName: 'topics', topicIndex: 'topic-index',
  topicDefinition: topicIndex as TopicGraphBinding['topicDefinition'], ...overrides,
})

beforeEach(() => vi.resetAllMocks())

describe('resolveTopicGraphBinding', () => {
  function serve(content: JsonValue, source: JsonValue = { name: 'ks', kind: 'searchIndex', searchIndexParameters: { searchIndexName: 'content' } }) {
    rest.getKnowledgeSource.mockResolvedValue(ok(source))
    rest.getIndexDefinition.mockImplementation(async ({ indexName }: { indexName: string }) => ok(indexName === 'content' ? content : topicIndex))
  }

  it('follows the knowledge source to the content index, its linked vector field and the topic index', async () => {
    serve(contentIndex())

    await expect(resolveTopicGraphBinding(connection, 'ks')).resolves.toMatchObject({
      contentIndex: 'content', keyField: 'id', vectorField: 'vec', profileName: 'topics', topicIndex: 'topic-index',
    })
    expect(rest.getIndexDefinition).toHaveBeenCalledWith(expect.objectContaining({ indexName: 'topic-index', apiVersion: '2026-11-01-preview' }))
  })

  it('uses the index created for a blob knowledge source', async () => {
    serve(contentIndex(), { name: 'ks', kind: 'azureBlob', azureBlobParameters: { createdResources: { index: 'content', graphIndex: 'graph' } } })

    await expect(resolveTopicGraphBinding(connection, 'ks')).resolves.toMatchObject({ contentIndex: 'content' })
  })

  it.each([
    ['noTopicProfile', contentIndex({ fields: [{ name: 'id', key: true }, { name: 'vec', type: 'Collection(Edm.Single)' }] })],
    ['noTopicProfile', contentIndex({ vectorSearch: { topicGraphProfiles: [] } })],
    ['ambiguousVector', contentIndex({ fields: [{ name: 'id', key: true }, { name: 'a', topicGraphProfile: 'topics' }, { name: 'b', topicGraphProfile: 'topics' }] })],
    ['vectorNotRetrievable', contentIndex({ fields: [{ name: 'id', key: true }, { name: 'vec', topicGraphProfile: 'topics', retrievable: false }] })],
  ])('reports %s instead of guessing a topic index', async (code, content) => {
    serve(content)

    await expect(resolveTopicGraphBinding(connection, 'ks')).rejects.toMatchObject({ code })
  })

  it('reports a failed request with the service message', async () => {
    rest.getKnowledgeSource.mockResolvedValue(failure('Forbidden'))

    await expect(resolveTopicGraphBinding(connection, 'ks')).rejects.toMatchObject({ code: 'request', detail: 'Forbidden (r-1)' })
  })
})

describe('loadTopicHierarchy', () => {
  const structure: JsonValue[] = [
    { graph_name: 'topicgraph-topic', subject_id: 'topicgraph:topicgraph-topic', predicate: 'HasRootTopic', object_id: 'topic:0' },
    { graph_name: 'topicgraph-topic', subject_id: 'topic:0', predicate: 'prop:title', object_string: '寺院' },
    { graph_name: 'topicgraph-topic', subject_id: 'topic:0', predicate: 'prop:proportion', object_double: 1 },
  ]

  it('reads only the structure with the mapped field names and never selects the non-retrievable centroid vector', async () => {
    rest.searchDocuments.mockResolvedValue(ok({ value: structure }))

    const hierarchy = await loadTopicHierarchy(connection, binding())

    expect(hierarchy.leaves).toEqual(['topic:0'])
    expect(hierarchy.topics.get('topic:0')).toMatchObject({ label: '寺院', proportion: 1 })
    expect(rest.searchDocuments).toHaveBeenCalledTimes(1)
    expect(rest.searchDocuments.mock.calls[0][0].body).toMatchObject({
      filter: "predicate ne 'HasCentroidVector'", orderby: 'id asc', top: 1000, skip: 0,
      select: 'graph_name,subject_id,predicate,object_id,object_string,object_double',
    })
  })

  it('stops with a format error when the topic index is not a topic graph', async () => {
    rest.searchDocuments.mockResolvedValue(ok({ value: [{ graph_name: 'entity', subject_id: 'a', predicate: 'knows' }] }))

    await expect(loadTopicHierarchy(connection, binding())).rejects.toMatchObject({ code: 'unsupportedTopicIndex' })
    await expect(loadTopicHierarchy(connection, binding({ topicDefinition: { name: 'plain', fields: [] } }))).rejects.toBeInstanceOf(TopicGraphReadError)
  })
})

describe('findNearestLeafTopics', () => {
  it('asks the topic index for the nearest centroid of each chunk vector without reading the centroids', async () => {
    rest.searchDocuments.mockImplementation(async ({ body }: { body: { vectorQueries: Array<{ vector: number[] }> } }) =>
      ok({ value: [{ subject_id: body.vectorQueries[0].vector[0] > 0.5 ? 'topic:1' : 'topic:2', '@search.score': 0.9 }] }))

    const assignments = await findNearestLeafTopics(connection, binding(), new Map([['a', [1, 0, 0]], ['b', [0, 1, 0]]]))

    expect(assignments.get('a')).toEqual({ leafId: 'topic:1', score: 0.9 })
    expect(assignments.get('b')).toEqual({ leafId: 'topic:2', score: 0.9 })
    expect(rest.searchDocuments).toHaveBeenCalledTimes(2)
    expect(rest.searchDocuments.mock.calls[0][0]).toMatchObject({ indexName: 'topic-index' })
    expect(rest.searchDocuments.mock.calls[0][0].body).toEqual({
      vectorQueries: [{ kind: 'vector', vector: [1, 0, 0], fields: 'object_vector', k: 1, exhaustive: true }],
      filter: "predicate eq 'HasCentroidVector'",
      select: 'subject_id',
      top: 1,
    })
  })

  it('leaves a chunk unassigned when the topic index returns no centroid and reports request failures', async () => {
    rest.searchDocuments.mockResolvedValueOnce(ok({ value: [] }))
    await expect(findNearestLeafTopics(connection, binding(), new Map([['a', [1, 0, 0]]]))).resolves.toEqual(new Map())

    rest.searchDocuments.mockResolvedValueOnce(failure('The vector dimensions do not match'))
    await expect(findNearestLeafTopics(connection, binding(), new Map([['a', [1, 0]]]))).rejects.toMatchObject({ code: 'request' })
  })
})

describe('loadChunkVectors', () => {
  it('reads the stored vectors in batches, escapes keys and skips chunks that are missing', async () => {
    rest.searchDocuments.mockImplementation(async ({ body }: { body: { filter: string } }) =>
      ok({ value: body.filter.includes("o''k") ? [{ id: "o'k", vec: [1, 2, 3] }] : [{ id: 'a', vec: [0, 1, 0] }] }))

    const keys = ["o'k", ...Array.from({ length: 30 }, (_, index) => `a${index}`)]
    const vectors = await loadChunkVectors(connection, binding(), keys)

    expect(rest.searchDocuments).toHaveBeenCalledTimes(2)
    expect(rest.searchDocuments.mock.calls[0][0].body).toMatchObject({ select: 'id,vec', top: 25 })
    expect([...vectors.keys()].sort()).toEqual(["o'k", 'a'].sort())
  })

  it('reports vectors that cannot be read when documents come back without them', async () => {
    rest.searchDocuments.mockResolvedValue(ok({ value: [{ id: 'a' }] }))

    await expect(loadChunkVectors(connection, binding(), ['a'])).rejects.toMatchObject({ code: 'vectorNotRetrievable' })
  })
})
