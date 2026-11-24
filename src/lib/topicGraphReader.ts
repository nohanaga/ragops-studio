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
import { getIndexDefinition, getKnowledgeSource, searchDocuments, type JsonValue, type RestResult } from './aiSearchRest'
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

export async function resolveTopicGraphBinding(connection: TopicGraphConnection, sourceName: string): Promise<TopicGraphBinding> {
  const { profile, language, signal } = connection
  const source = asObject(unwrap(await getKnowledgeSource({ profile, knowledgeSourceName: sourceName, language })), 'Knowledge source')
  signal?.throwIfAborted()
  const contentIndex = contentIndexName(source)
  if (!contentIndex) throw new TopicGraphReadError('noContentIndex', sourceName)

  const content = asObject(unwrap(await getIndexDefinition({
    profile, indexName: contentIndex, apiVersion: KNOWLEDGE_GRAPH_API_VERSION, language, signal,
  })), 'Content index')
  const linked = topLevelFields(content).filter((field) => text(field.topicGraphProfile))
  if (linked.length === 0) throw new TopicGraphReadError('noTopicProfile', contentIndex)
  if (linked.length > 1) throw new TopicGraphReadError('ambiguousVector', linked.map((field) => text(field.name)).join(', '))
  const vector = linked[0]
  const vectorField = text(vector.name)
  if (vector.retrievable === false || vector.stored === false) throw new TopicGraphReadError('vectorNotRetrievable', `${contentIndex}.${vectorField}`)

  const profileName = text(vector.topicGraphProfile)
  const profiles = isJsonObject(content.vectorSearch ?? null) && Array.isArray((content.vectorSearch as JsonObject).topicGraphProfiles)
    ? ((content.vectorSearch as JsonObject).topicGraphProfiles as JsonValue[]) : []
  const profileDefinition = profiles.find((item): item is JsonObject => isJsonObject(item) && text(item.name) === profileName)
  const topicIndex = text(profileDefinition?.indexName)
  if (!topicIndex) throw new TopicGraphReadError('noTopicProfile', `${contentIndex}.${vectorField} -> ${profileName}`)
  const keyField = getIndexKeyFieldName(content)
  if (!keyField) throw new TopicGraphReadError('noContentIndex', `${contentIndex}: no key field`)

  const topicDefinition = asObject(unwrap(await getIndexDefinition({
    profile, indexName: topicIndex, apiVersion: KNOWLEDGE_GRAPH_API_VERSION, language, signal,
  })), 'Topic index')
  return { sourceName, contentIndex, keyField, vectorField, profileName, topicIndex, topicDefinition }
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
export async function loadTopicHierarchy(connection: TopicGraphConnection, binding: TopicGraphBinding): Promise<TopicHierarchy> {
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
