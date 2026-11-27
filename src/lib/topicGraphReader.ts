/**
 * Read-only access to the resources behind a topic graph:
 *
 *   knowledge source -> content index -> vector field `topicGraphProfile` -> `vectorSearch.topicGraphProfiles[].indexName` -> topic index
 *
 * It reads the topic hierarchy from the topic index, the stored vectors of result chunks from the content index, and
 * asks the topic index which leaf centroid is nearest to each chunk vector. Nothing is written.
 */

import { isJsonObject, type JsonObject } from '../app/json'
import { getIndexKeyFieldName } from '../utils/indexClone'
import { getIndexDefinition, getKnowledgeSource, listIndexes, searchDocuments, type JsonValue, type RestResult } from './aiSearchRest'
import { KNOWLEDGE_GRAPH_API_VERSION, graphMappings } from './knowledgeGraph'
import type { ConnectionProfile } from './model'
import { buildTopicHierarchy, TOPIC_PREDICATES, TopicGraphFormatError, type LeafAssignment, type TopicGraphRow, type TopicHierarchy } from './topicGraphCoverage'
import type { Language } from './translations'

export type TopicGraphReadErrorCode =
  | 'request' | 'noContentIndex' | 'noTopicProfile' | 'ambiguousVector' | 'vectorNotRetrievable' | 'unsupportedTopicIndex' | 'tooLarge'

export class TopicGraphReadError extends Error {
  readonly code: TopicGraphReadErrorCode
  readonly detail: string

  constructor(code: TopicGraphReadErrorCode, detail: string) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'TopicGraphReadError'
    this.code = code
    this.detail = detail
  }
}

export type TopicGraphConnection = {
  profile: ConnectionProfile
  language: Language
  signal?: AbortSignal
}

export type TopicGraphBinding = {
  sourceName: string
  contentIndex: string
  keyField: string
  vectorField: string
  profileName: string
  topicIndex: string
  topicDefinition: JsonObject
}

export const MAX_TOPIC_DOCUMENTS = 10_000
const STRUCTURE_PAGE_SIZE = 1000
const CHUNK_VECTOR_BATCH_SIZE = 25
const NEAREST_CONCURRENCY = 6
const TOPIC_VECTOR_FIELD = 'object_vector'

function unwrap(result: RestResult): JsonValue {
  if (!result.ok) throw new TopicGraphReadError('request', `${result.error.message} (${result.requestId})`)
  return result.response
}

function asObject(value: JsonValue, what: string): JsonObject {
  if (!isJsonObject(value)) throw new TopicGraphReadError('request', `${what}: expected a JSON object.`)
  return value
}

const text = (value: JsonValue | undefined): string => (typeof value === 'string' ? value.trim() : '')
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`

function contentIndexName(source: JsonObject): string {
  const searchIndex = isJsonObject(source.searchIndexParameters ?? null) ? text((source.searchIndexParameters as JsonObject).searchIndexName) : ''
  if (searchIndex) return searchIndex
  for (const [key, parameters] of Object.entries(source)) {
    if (!key.endsWith('Parameters') || !isJsonObject(parameters) || !isJsonObject(parameters.createdResources ?? null)) continue
    const resources = parameters.createdResources as JsonObject
    const created = Object.entries(resources).find(([name, value]) => /index$/i.test(name) && name !== 'graphIndex' && text(value))
    if (created) return text(created[1])
  }
  return ''
}

function topLevelFields(definition: JsonObject): JsonObject[] {
  return Array.isArray(definition.fields) ? definition.fields.filter((field): field is JsonObject => isJsonObject(field)) : []
}

function topicGraphProfiles(index: JsonObject): JsonObject[] {
  const vectorSearch = index.vectorSearch ?? null
  return isJsonObject(vectorSearch) && Array.isArray(vectorSearch.topicGraphProfiles)
    ? vectorSearch.topicGraphProfiles.filter((item): item is JsonObject => isJsonObject(item)) : []
}

/** `onlyTopicIndex` limits the linked vector fields to the ones whose profile points at that topic index. */
async function bindContentIndex(
  connection: TopicGraphConnection,
  sourceName: string,
  contentIndex: string,
  content: JsonObject,
  onlyTopicIndex?: string,
): Promise<TopicGraphBinding> {
  const { profile, language, signal } = connection
  const profiles = topicGraphProfiles(content)
  const indexNameOf = (profileName: string) => text(profiles.find((item) => text(item.name) === profileName)?.indexName)
  const linked = topLevelFields(content).filter((field) => {
    const profileName = text(field.topicGraphProfile)
    return profileName !== '' && (onlyTopicIndex === undefined || indexNameOf(profileName) === onlyTopicIndex)
  })
  if (linked.length === 0) throw new TopicGraphReadError('noTopicProfile', contentIndex)
  if (linked.length > 1) throw new TopicGraphReadError('ambiguousVector', linked.map((field) => text(field.name)).join(', '))
  const vector = linked[0]
  const vectorField = text(vector.name)
  if (vector.retrievable === false || vector.stored === false) throw new TopicGraphReadError('vectorNotRetrievable', `${contentIndex}.${vectorField}`)

  const profileName = text(vector.topicGraphProfile)
  const topicIndex = indexNameOf(profileName)
  if (!topicIndex) throw new TopicGraphReadError('noTopicProfile', `${contentIndex}.${vectorField} -> ${profileName}`)
  const keyField = getIndexKeyFieldName(content)
  if (!keyField) throw new TopicGraphReadError('noContentIndex', `${contentIndex}: no key field`)

  const topicDefinition = asObject(unwrap(await getIndexDefinition({
    profile, indexName: topicIndex, apiVersion: KNOWLEDGE_GRAPH_API_VERSION, language, signal,
  })), 'Topic index')
  return { sourceName, contentIndex, keyField, vectorField, profileName, topicIndex, topicDefinition }
}

export async function resolveTopicGraphBinding(connection: TopicGraphConnection, sourceName: string): Promise<TopicGraphBinding> {
  const { profile, language, signal } = connection
  const source = asObject(unwrap(await getKnowledgeSource({ profile, knowledgeSourceName: sourceName, language, signal })), 'Knowledge source')
  signal?.throwIfAborted()
  const contentIndex = contentIndexName(source)
  if (!contentIndex) throw new TopicGraphReadError('noContentIndex', sourceName)

  const content = asObject(unwrap(await getIndexDefinition({
    profile, indexName: contentIndex, apiVersion: KNOWLEDGE_GRAPH_API_VERSION, language, signal,
  })), 'Content index')
  return bindContentIndex(connection, sourceName, contentIndex, content)
}

/**
 * Finds the content index whose vector field links to `topicIndexName` through `vectorSearch.topicGraphProfiles`.
 * The binding has an empty `sourceName` because no knowledge source is involved.
 */
export async function resolveTopicGraphBindingForTopicIndex(connection: TopicGraphConnection, topicIndexName: string): Promise<TopicGraphBinding> {
  const { profile, language, signal } = connection
  const indexes = documents(unwrap(await listIndexes({ profile, apiVersion: KNOWLEDGE_GRAPH_API_VERSION, language, signal })))
  const candidates = indexes.filter((index) => topicGraphProfiles(index).some((item) => text(item.indexName) === topicIndexName))
  if (candidates.length === 0) throw new TopicGraphReadError('noContentIndex', topicIndexName)
  if (candidates.length > 1) throw new TopicGraphReadError('ambiguousVector', candidates.map((index) => text(index.name)).join(', '))
  return bindContentIndex(connection, '', text(candidates[0].name), candidates[0], topicIndexName)
}

function topicFields(definition: JsonObject) {
  try {
    const mappings = graphMappings(definition)
    const field = (role: string) => {
      const name = text(mappings[role])
      if (!name) throw new Error(role)
      return name
    }
    const vectors = topLevelFields(definition).filter((candidate) => text(candidate.vectorSearchProfile) || typeof candidate.dimensions === 'number')
    const vector = vectors.find((candidate) => text(candidate.name) === TOPIC_VECTOR_FIELD) ?? (vectors.length === 1 ? vectors[0] : undefined)
    const key = getIndexKeyFieldName(definition)
    if (!vector || !key) throw new Error('vector or key field')
    return {
      key,
      graph: field('graphNameField'),
      subject: field('subjectIdField'),
      predicate: field('predicateField'),
      objectId: field('objectIdField'),
      objectString: field('objectStringField'),
      objectDouble: field('objectDoubleField'),
      vector: text(vector.name),
    }
  } catch (error) {
    throw new TopicGraphReadError('unsupportedTopicIndex', error instanceof Error ? error.message : String(error))
  }
}

function documents(response: JsonValue): JsonObject[] {
  const value = asObject(response, 'Search response').value
  return Array.isArray(value) ? value.filter((item): item is JsonObject => isJsonObject(item)) : []
}

const toNumberArray = (value: JsonValue | undefined): number[] | undefined =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'number') ? (value as number[]) : undefined

async function* pages(connection: TopicGraphConnection, indexName: string, body: JsonObject, size: number): AsyncGenerator<JsonObject[]> {
  for (let skip = 0; ; skip += size) {
    const page = documents(unwrap(await searchDocuments({
      profile: connection.profile, indexName, apiVersion: KNOWLEDGE_GRAPH_API_VERSION, language: connection.language, signal: connection.signal,
      body: { ...body, top: size, skip },
    })))
    yield page
    if (page.length < size) return
  }
}

/** Reads every topic document and rebuilds the hierarchy. The centroid vectors are not read: they may not be retrievable. */
export async function loadTopicHierarchy(
  connection: TopicGraphConnection,
  binding: Pick<TopicGraphBinding, 'topicIndex' | 'topicDefinition'>,
): Promise<TopicHierarchy> {
  const fields = topicFields(binding.topicDefinition)
  const rows: TopicGraphRow[] = []

  for await (const page of pages(connection, binding.topicIndex, {
    search: '*',
    orderby: `${fields.key} asc`,
    filter: `${fields.predicate} ne ${literal(TOPIC_PREDICATES.centroid)}`,
    select: [fields.graph, fields.subject, fields.predicate, fields.objectId, fields.objectString, fields.objectDouble].join(','),
  }, STRUCTURE_PAGE_SIZE)) {
    for (const item of page) {
      rows.push({
        graphName: text(item[fields.graph]),
        subjectId: text(item[fields.subject]),
        predicate: text(item[fields.predicate]),
        objectId: text(item[fields.objectId]),
        objectString: typeof item[fields.objectString] === 'string' ? item[fields.objectString] as string : undefined,
        objectDouble: typeof item[fields.objectDouble] === 'number' ? item[fields.objectDouble] as number : undefined,
      })
    }
    if (rows.length > MAX_TOPIC_DOCUMENTS) throw new TopicGraphReadError('tooLarge', String(MAX_TOPIC_DOCUMENTS))
  }

  try {
    return buildTopicHierarchy(rows)
  } catch (error) {
    if (error instanceof TopicGraphFormatError) throw new TopicGraphReadError('unsupportedTopicIndex', error.message)
    throw error
  }
}

/** Reads the stored vectors of the given chunk keys. Keys that are missing from the index or have no vector are left out. */
export async function loadChunkVectors(
  connection: TopicGraphConnection,
  binding: TopicGraphBinding,
  keys: readonly string[],
): Promise<Map<string, number[]>> {
  const vectors = new Map<string, number[]>()
  const unique = [...new Set(keys)]
  let found = 0
  for (let start = 0; start < unique.length; start += CHUNK_VECTOR_BATCH_SIZE) {
    const batch = unique.slice(start, start + CHUNK_VECTOR_BATCH_SIZE)
    const page = documents(unwrap(await searchDocuments({
      profile: connection.profile, indexName: binding.contentIndex, apiVersion: KNOWLEDGE_GRAPH_API_VERSION,
      language: connection.language, signal: connection.signal,
      body: {
        search: '*',
        filter: batch.map((key) => `${binding.keyField} eq ${literal(key)}`).join(' or '),
        select: `${binding.keyField},${binding.vectorField}`,
        top: batch.length,
      },
    })))
    for (const item of page) {
      const key = text(item[binding.keyField])
      const vector = toNumberArray(item[binding.vectorField])
      if (!key) continue
      found += 1
      if (vector) vectors.set(key, vector)
    }
  }
  if (found > 0 && vectors.size === 0) throw new TopicGraphReadError('vectorNotRetrievable', `${binding.contentIndex}.${binding.vectorField}`)
  return vectors
}

/** Reads up to `limit` chunk keys in key order and reports whether the content index holds more. */
export async function loadChunkKeys(
  connection: TopicGraphConnection,
  binding: TopicGraphBinding,
  limit: number,
): Promise<{ keys: string[]; truncated: boolean }> {
  const page = documents(unwrap(await searchDocuments({
    profile: connection.profile, indexName: binding.contentIndex, apiVersion: KNOWLEDGE_GRAPH_API_VERSION,
    language: connection.language, signal: connection.signal,
    body: { search: '*', orderby: `${binding.keyField} asc`, select: binding.keyField, top: limit + 1 },
  })))
  const keys = page.map((item) => text(item[binding.keyField])).filter((key) => key !== '')
  return { keys: keys.slice(0, limit), truncated: keys.length > limit }
}

export const MAX_WHEEL_CHUNKS = 500

export type TopicWheelChunks = {
  contentIndex: string
  /** Leaf topic of every chunk that could be placed, by chunk key, in key order. */
  assignments: ReadonlyMap<string, LeafAssignment>
  /** Chunks that were read but could not be placed in a leaf topic. */
  unassigned: number
  /** True when the content index holds more than `MAX_WHEEL_CHUNKS` chunks. */
  truncated: boolean
}

/** Places the chunks of the content index linked to the topic index into the leaf topics of `hierarchy`. Nothing is written. */
export async function loadWheelChunks(
  connection: TopicGraphConnection,
  topicIndexName: string,
  hierarchy: TopicHierarchy,
): Promise<TopicWheelChunks> {
  const binding = await resolveTopicGraphBindingForTopicIndex(connection, topicIndexName)
  const { keys, truncated } = await loadChunkKeys(connection, binding, MAX_WHEEL_CHUNKS)
  const vectors = await loadChunkVectors(connection, binding, keys)
  const nearest = await findNearestLeafTopics(connection, binding, vectors)
  connection.signal?.throwIfAborted()
  const assignments = new Map<string, LeafAssignment>()
  for (const key of keys) {
    const assignment = nearest.get(key)
    if (assignment && hierarchy.topics.get(assignment.leafId)?.children.length === 0) assignments.set(key, assignment)
  }
  return { contentIndex: binding.contentIndex, assignments, unassigned: keys.length - assignments.size, truncated }
}

/**
 * Finds the leaf topic whose centroid is nearest to each chunk vector by running a vector query on the topic index.
 * The centroids stay on the service, so this works even when the topic index vector field is not retrievable.
 * The query is exhaustive because the index holds only one centroid per leaf topic.
 */
export async function findNearestLeafTopics(
  connection: TopicGraphConnection,
  binding: TopicGraphBinding,
  vectors: ReadonlyMap<string, readonly number[]>,
): Promise<Map<string, LeafAssignment>> {
  const fields = topicFields(binding.topicDefinition)
  const assignments = new Map<string, LeafAssignment>()
  const queue = [...vectors]
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      connection.signal?.throwIfAborted()
      const [key, vector] = next
      const [nearest] = documents(unwrap(await searchDocuments({
        profile: connection.profile, indexName: binding.topicIndex, apiVersion: KNOWLEDGE_GRAPH_API_VERSION,
        language: connection.language, signal: connection.signal,
        body: {
          vectorQueries: [{ kind: 'vector', vector: [...vector], fields: fields.vector, k: 1, exhaustive: true }],
          filter: `${fields.predicate} eq ${literal(TOPIC_PREDICATES.centroid)}`,
          select: fields.subject,
          top: 1,
        },
      })))
      const leafId = text(nearest?.[fields.subject])
      const score = nearest?.['@search.score']
      if (leafId) assignments.set(key, { leafId, score: typeof score === 'number' ? score : 0 })
    }
  }
  await Promise.all(Array.from({ length: Math.min(NEAREST_CONCURRENCY, queue.length) }, worker))
  return assignments
}
