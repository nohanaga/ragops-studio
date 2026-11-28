import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JsonValue, RestResult } from './aiSearchRest'
import type { ConnectionProfile } from './model'

const rest = vi.hoisted(() => ({
  getKnowledgeSource: vi.fn(),
  getIndexDefinition: vi.fn(),
  listIndexes: vi.fn(),
  searchDocuments: vi.fn(),
}))
vi.mock('./aiSearchRest', () => rest)

import {
  findNearestLeafTopics, loadChunkKeys, loadChunkText, loadChunkVectors, loadTopicHierarchy, loadWheelChunks, MAX_WHEEL_CHUNKS, pickChunkTextField,
  resolveTopicGraphBinding, resolveTopicGraphBindingForTopicIndex, TopicGraphReadError, type TopicGraphBinding,
} from './topicGraphReader'
import { buildTopicHierarchy, TOPIC_GRAPH_NAME } from './topicGraphCoverage'

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

  it('notes that the key field cannot be sorted, so that the chunks are not requested in key order', async () => {
    serve(contentIndex({ fields: [{ name: 'id', type: 'Edm.String', key: true, sortable: false }, { name: 'vec', type: 'Collection(Edm.Single)', dimensions: 3, topicGraphProfile: 'topics' }] }))

    await expect(resolveTopicGraphBinding(connection, 'ks')).resolves.toMatchObject({ keySortable: false })
    serve(contentIndex())
    await expect(resolveTopicGraphBinding(connection, 'ks')).resolves.toMatchObject({ keySortable: true })
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

describe('resolveTopicGraphBindingForTopicIndex', () => {
  function serve(indexes: JsonValue[]) {
    rest.listIndexes.mockResolvedValue(ok({ value: indexes }))
    rest.getIndexDefinition.mockResolvedValue(ok(topicIndex))
  }

  it('finds the content index and vector field that reference the topic index, without a knowledge source', async () => {
    serve([
      { name: 'unrelated', fields: [{ name: 'id', key: true }], vectorSearch: { topicGraphProfiles: [{ name: 'other', indexName: 'other-topics' }] } },
      contentIndex({
        fields: [
          { name: 'id', type: 'Edm.String', key: true },
          { name: 'other_vec', type: 'Collection(Edm.Single)', topicGraphProfile: 'other' },
          { name: 'vec', type: 'Collection(Edm.Single)', topicGraphProfile: 'topics' },
        ],
        vectorSearch: { topicGraphProfiles: [{ name: 'other', indexName: 'other-topics' }, { name: 'topics', indexName: 'topic-index' }] },
      }),
    ])

    await expect(resolveTopicGraphBindingForTopicIndex(connection, 'topic-index')).resolves.toMatchObject({
      sourceName: '', contentIndex: 'content', keyField: 'id', vectorField: 'vec', profileName: 'topics', topicIndex: 'topic-index',
    })
    expect(rest.listIndexes).toHaveBeenCalledWith(expect.objectContaining({ apiVersion: '2026-11-01-preview' }))
  })

  it('ignores an index that keeps a profile for the topic index after its vector field was unlinked', async () => {
    serve([
      contentIndex({ name: 'rebuilt', fields: [{ name: 'id', type: 'Edm.String', key: true }, { name: 'vec', type: 'Collection(Edm.Single)' }] }),
      contentIndex({ name: 'linked' }),
    ])

    await expect(resolveTopicGraphBindingForTopicIndex(connection, 'topic-index')).resolves.toMatchObject({ contentIndex: 'linked' })

    serve([contentIndex({ name: 'rebuilt', fields: [{ name: 'id', type: 'Edm.String', key: true }, { name: 'vec', type: 'Collection(Edm.Single)' }] })])
    await expect(resolveTopicGraphBindingForTopicIndex(connection, 'topic-index')).rejects.toMatchObject({ code: 'noContentIndex' })
  })

  it('reports a missing or ambiguous content index instead of guessing one', async () => {
    serve([{ name: 'other', vectorSearch: { topicGraphProfiles: [{ name: 'p', indexName: 'another-topic-index' }] } }])
    await expect(resolveTopicGraphBindingForTopicIndex(connection, 'topic-index')).rejects.toMatchObject({ code: 'noContentIndex', detail: 'topic-index' })

    serve([contentIndex({ name: 'content-a' }), contentIndex({ name: 'content-b' })])
    await expect(resolveTopicGraphBindingForTopicIndex(connection, 'topic-index')).rejects.toMatchObject({ code: 'ambiguousVector', detail: 'content-a, content-b' })
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

describe('loadChunkKeys', () => {
  it('reads one more key than the limit to tell whether the content index holds more chunks', async () => {
    rest.searchDocuments.mockResolvedValue(ok({ value: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }))

    await expect(loadChunkKeys(connection, binding(), 2)).resolves.toEqual({ keys: ['a', 'b'], truncated: true, ordered: true })
    expect(rest.searchDocuments.mock.calls[0][0]).toMatchObject({ indexName: 'content', body: { search: '*', orderby: 'id asc', select: 'id', top: 3 } })

    await expect(loadChunkKeys(connection, binding(), 3)).resolves.toEqual({ keys: ['a', 'b', 'c'], truncated: false, ordered: true })
  })

  it('does not ask for key order when the key field is not sortable and numbers the chunks it got in key order', async () => {
    rest.searchDocuments.mockResolvedValue(ok({ value: [{ id: 'c' }, { id: 'a' }, { id: 'd' }, { id: 'b' }] }))

    await expect(loadChunkKeys(connection, binding({ keySortable: false }), 3)).resolves.toEqual({ keys: ['a', 'c', 'd'], truncated: true, ordered: false })
    expect(rest.searchDocuments.mock.calls[0][0].body).toEqual({ search: '*', select: 'id', top: 4 })
  })
})

describe('loadWheelChunks', () => {
  const hierarchy = buildTopicHierarchy([
    { graphName: TOPIC_GRAPH_NAME, predicate: 'HasRootTopic', subjectId: 'topicgraph:topicgraph-topic', objectId: 'topic:1' },
    { graphName: TOPIC_GRAPH_NAME, predicate: 'HasRootTopic', subjectId: 'topicgraph:topicgraph-topic', objectId: 'topic:2' },
    { graphName: TOPIC_GRAPH_NAME, predicate: 'prop:proportion', subjectId: 'topic:1', objectDouble: 0.5 },
    { graphName: TOPIC_GRAPH_NAME, predicate: 'prop:proportion', subjectId: 'topic:2', objectDouble: 0.5 },
  ])

  function serve(keys: string[], content: JsonValue = contentIndex()) {
    rest.listIndexes.mockResolvedValue(ok({ value: [content] }))
    rest.getIndexDefinition.mockResolvedValue(ok(topicIndex))
    rest.searchDocuments.mockImplementation(async ({ indexName, body }: { indexName: string; body: { select: string; vectorQueries?: Array<{ vector: number[] }> } }) => {
      if (indexName === 'topic-index') {
        const first = body.vectorQueries![0].vector[0]
        return ok({ value: [{ subject_id: first === 1 ? 'topic:1' : first === 2 ? 'topic:2' : 'topic:9', '@search.score': 0.8 }] })
      }
      if (body.select === 'id') return ok({ value: keys.map((id) => ({ id })) })
      return ok({ value: keys.map((id, index) => ({ id, vec: [index + 1, 0, 0] })) })
    })
  }

  it('places every chunk of the linked content index in a leaf topic and counts the ones that fit nowhere', async () => {
    serve(['a', 'b', 'c'])

    const chunks = await loadWheelChunks(connection, 'topic-index', hierarchy)

    expect([...chunks.assignments]).toEqual([['a', { leafId: 'topic:1', score: 0.8 }], ['b', { leafId: 'topic:2', score: 0.8 }]])
    expect(chunks).toMatchObject({ contentIndex: 'content', keyField: 'id', unassigned: 1, truncated: false, keyOrdered: true })
    expect(chunks.textField).toBeUndefined()
  })

  it('falls back to the keys in the order the service returns them when the key field is not sortable', async () => {
    serve(['b', 'a'], contentIndex({
      fields: [{ name: 'id', type: 'Edm.String', key: true, sortable: false }, { name: 'vec', type: 'Collection(Edm.Single)', dimensions: 3, topicGraphProfile: 'topics' }],
    }))

    const chunks = await loadWheelChunks(connection, 'topic-index', hierarchy)

    expect(chunks.keyOrdered).toBe(false)
    expect([...chunks.assignments.keys()]).toEqual(['a', 'b'])
    const keyRequest = rest.searchDocuments.mock.calls.find(([request]) => request.indexName === 'content' && request.body.select === 'id')
    expect(keyRequest?.[0].body).not.toHaveProperty('orderby')
  })

  it('reports which field holds the chunk text so that a chunk can be read later', async () => {
    serve(['a'], contentIndex({
      fields: [
        { name: 'id', type: 'Edm.String', key: true },
        { name: 'snippet', type: 'Edm.String', searchable: true },
        { name: 'vec', type: 'Collection(Edm.Single)', dimensions: 3, topicGraphProfile: 'topics' },
      ],
    }))

    await expect(loadWheelChunks(connection, 'topic-index', hierarchy)).resolves.toMatchObject({ keyField: 'id', textField: 'snippet' })
  })

  it('reads at most the wheel limit of chunks and reports that the rest was left out', async () => {
    serve(Array.from({ length: MAX_WHEEL_CHUNKS + 1 }, (_, index) => `k${index}`))

    const chunks = await loadWheelChunks(connection, 'topic-index', hierarchy)

    expect(chunks.truncated).toBe(true)
    expect(chunks.assignments.size + chunks.unassigned).toBe(MAX_WHEEL_CHUNKS)
  })
})

describe('pickChunkTextField', () => {
  const content = (...fields: Array<Record<string, JsonValue>>) => ({ name: 'content', fields }) as TopicGraphBinding['topicDefinition']
  const string = (name: string, extra: Record<string, JsonValue> = {}) => ({ name, type: 'Edm.String', ...extra })

  it('prefers the Foundry IQ snippet field, then other well-known body names', () => {
    expect(pickChunkTextField(content(string('uid', { key: true }), string('title'), string('snippet'), string('content')), 'uid', 'v')).toBe('snippet')
    expect(pickChunkTextField(content(string('id', { key: true }), string('title'), string('Chunk')), 'id', 'v')).toBe('Chunk')
  })

  it('guesses a searchable string field that is not an identifier or a location and otherwise gives up', () => {
    expect(pickChunkTextField(content(string('id', { key: true }), string('blob_url'), string('parent_id'), string('description')), 'id', 'v')).toBe('description')
    expect(pickChunkTextField(content(string('id', { key: true }), string('blob_url'), string('hidden', { retrievable: false }), string('tag', { searchable: false })), 'id', 'v')).toBeUndefined()
    expect(pickChunkTextField(content({ name: 'id', type: 'Edm.String', key: true }, { name: 'vec', type: 'Collection(Edm.Single)' }), 'id', 'vec')).toBeUndefined()
  })
})

describe('loadChunkText', () => {
  const source = { contentIndex: 'content', keyField: 'id', textField: 'snippet' }

  it('reads only the text field of the chunk with an escaped key filter', async () => {
    rest.searchDocuments.mockResolvedValue(ok({ value: [{ snippet: '本堂は江戸時代に再建されました。' }] }))

    await expect(loadChunkText(connection, source, "o'k")).resolves.toBe('本堂は江戸時代に再建されました。')
    expect(rest.searchDocuments.mock.calls[0][0]).toMatchObject({
      indexName: 'content', apiVersion: '2026-11-01-preview',
      body: { search: '*', filter: "id eq 'o''k'", select: 'snippet', top: 1 },
    })
  })

  it('returns undefined for a missing chunk or an empty body and reports request failures', async () => {
    rest.searchDocuments.mockResolvedValueOnce(ok({ value: [] }))
    await expect(loadChunkText(connection, source, 'a')).resolves.toBeUndefined()

    rest.searchDocuments.mockResolvedValueOnce(ok({ value: [{ snippet: '  ' }] }))
    await expect(loadChunkText(connection, source, 'a')).resolves.toBeUndefined()

    rest.searchDocuments.mockResolvedValueOnce(failure('Forbidden'))
    await expect(loadChunkText(connection, source, 'a')).rejects.toMatchObject({ code: 'request', detail: 'Forbidden (r-1)' })
  })
})
