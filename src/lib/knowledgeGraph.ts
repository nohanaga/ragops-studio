import { isJsonObject, type JsonObject } from '../app/json'
import type { JsonValue } from './aiSearchRest'
import { getIndexKeyFieldName, getIndexTopLevelFieldNames, projectDocumentForIndexing } from '../utils/indexClone'

export const KNOWLEDGE_GRAPH_API_VERSION = '2026-11-01-preview'
export const EMPTY_ONTOLOGY = JSON.stringify({
  '@context': { owl: 'http://www.w3.org/2002/07/owl#', rdfs: 'http://www.w3.org/2000/01/rdf-schema#', ex: 'https://example.org/ontology#' },
  '@graph': [],
}, null, 2)

export type WorkbenchNode = { id: string; label: string; type: string; raw: JsonObject }
export type WorkbenchEdge = { id: string; source: string; target: string; label: string; raw: JsonObject }
export type WorkbenchGraph = { nodes: WorkbenchNode[]; edges: WorkbenchEdge[] }
export type GraphIndexKind = 'entity' | 'topic' | 'unclassified'
export type GraphIndexResource = { name: string; kind: GraphIndexKind; definition: JsonObject }

export function graphSourceIndex(source: JsonObject): string | undefined {
  if (source.kind !== 'azureBlob' || !isJsonObject(source.azureBlobParameters)) return undefined
  const resources = source.azureBlobParameters.createdResources
  return isJsonObject(resources) && typeof resources.graphIndex === 'string' && resources.graphIndex ? resources.graphIndex : undefined
}

export function isGraphBlobSource(source: JsonObject): boolean {
  return source.kind === 'azureBlob' && isJsonObject(source.azureBlobParameters)
    && (isJsonObject(source.azureBlobParameters.graphExtraction ?? null) || graphSourceIndex(source) !== undefined)
}

export function classifyGraphIndexes(indexes: JsonObject[], sources: JsonObject[]): GraphIndexResource[] {
  const topics = new Set<string>()
  for (const index of indexes) {
    if (!isJsonObject(index.vectorSearch ?? null) || !Array.isArray(index.vectorSearch.topicGraphProfiles)) continue
    for (const profile of index.vectorSearch.topicGraphProfiles) {
      if (isJsonObject(profile) && typeof profile.indexName === 'string') topics.add(profile.indexName)
    }
  }
  const entities = new Set(sources.map(graphSourceIndex).filter((name): name is string => name !== undefined))
  return indexes.filter((index) => isJsonObject(index.graphProfile ?? null)).map((index) => {
    if (typeof index.name !== 'string' || !index.name) throw new Error('A graph index must have a name.')
    const topic = topics.has(index.name)
    const entity = entities.has(index.name)
    return { name: index.name, kind: topic && !entity ? 'topic' : entity && !topic ? 'entity' : 'unclassified', definition: index }
  })
}

export function buildGraphStarterQuery(graph: WorkbenchGraph): string {
  const edge = graph.edges[0]
  if (!edge) return ''
  const predicate = edge.label
  if (!predicate || /[`\\\u0000-\u001f\u007f]/u.test(predicate)) {
    throw new Error('Cannot safely generate a GQL label for this predicate. Enter a constrained query manually.')
  }
  return `MATCH (a)-[r:\`${predicate}\`]->(b) RETURN a.name AS subject, r.predicate AS predicate, b.name AS object LIMIT 25`
}

export type GraphProvenanceKind = 'none' | 'ids' | 'hydrate'

// 直接 GQL の provenance は ids / hydrate のみ。hydrate には hydrateDocuments が必須で、none は省略で表す。
export function buildGraphProvenanceRequest(kind: GraphProvenanceKind): JsonObject | undefined {
  if (kind === 'ids') return { kind: 'ids' }
  if (kind === 'hydrate') return { kind: 'hydrate', hydrateDocuments: {} }
  return undefined
}

export function graphProvenanceIndexName(definition: JsonValue | null): string | undefined {
  if (!isJsonObject(definition)) return undefined
  const profile = definition.graphProfile ?? null
  if (!isJsonObject(profile)) return undefined
  const name = profile.provenanceIndexName
  return typeof name === 'string' && name ? name : undefined
}

// buildKnowledgeGraph が値ノードに付ける ID は JSON.stringify([graph, 'literal', value]) 形式。
export function isLiteralGraphNode(node: WorkbenchNode): boolean {
  try {
    const parts: unknown = JSON.parse(node.id)
    return Array.isArray(parts) && parts[1] === 'literal'
  } catch { return false }
}

export function requireObject(value: JsonValue, name: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${name}: expected a JSON object.`)
  return value
}

export function parseDocumentArray(text: string): JsonObject[] {
  const value: JsonValue = JSON.parse(text)
  if (!Array.isArray(value) || value.some((item) => !isJsonObject(item))) {
    throw new Error('Documents: expected an array of JSON objects.')
  }
  return value.filter(isJsonObject)
}

export function responseDocuments(value: JsonValue): JsonObject[] {
  const response = requireObject(value, 'Response')
  if (!Array.isArray(response.value) || response.value.some((item) => !isJsonObject(item))) {
    throw new Error('Response.value: expected an array of JSON objects.')
  }
  return response.value.filter(isJsonObject)
}

export function graphResultEvidenceIds(response: JsonValue): string[] {
  if (!isJsonObject(response) || !Array.isArray(response.value)) return []
  const ids = new Set<string>()
  const visit = (value: JsonValue) => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (isJsonObject(value)) {
      if (typeof value.edgeId === 'string' && value.edgeId) ids.add(value.edgeId)
      Object.values(value).forEach(visit)
    }
  }
  response.value.filter(isJsonObject).forEach((row) => {
    if (row['@search.graphProvenance'] !== undefined) visit(row['@search.graphProvenance'])
  })
  return [...ids]
}

export function buildGraphResultView(response: JsonValue, definition: JsonValue | null, evidence: JsonObject[]): {
  rows: JsonObject[]
  graph: WorkbenchGraph
  representation: 'evidence' | 'projection' | 'none'
  missingEvidence: number
} {
  const data = requireObject(response, 'Response')
  const rows = data.value === undefined ? [data] : responseDocuments(data)
  const ids = graphResultEvidenceIds(response)
  if (ids.length && definition) {
    const key = mappedField(graphMappings(definition), 'assertionIdField')
    const required = new Set(ids)
    const assertions = evidence.filter((item) => typeof item[key] === 'string' && required.has(item[key]))
    if (assertions.length) {
      const found = new Set(assertions.map((item) => item[key]))
      return { rows, graph: buildKnowledgeGraph(definition, assertions), representation: 'evidence', missingEvidence: ids.filter((id) => !found.has(id)).length }
    }
  }
  const nodes: WorkbenchNode[] = []
  const edges: WorkbenchEdge[] = []
  rows.forEach((row, index) => {
    if (typeof row.subject !== 'string' || typeof row.predicate !== 'string'
      || !row.predicate || row.object === undefined || row.object === null || typeof row.object === 'object') return
    const source = `query-row:${index}:subject`
    const target = `query-row:${index}:object`
    nodes.push({ id: source, label: row.subject, type: 'Result value', raw: row })
    nodes.push({ id: target, label: String(row.object), type: 'Result value', raw: row })
    edges.push({ id: `query-row:${index}`, source, target, label: row.predicate, raw: row })
  })
  return { rows, graph: { nodes, edges }, representation: edges.length ? 'projection' : 'none', missingEvidence: ids.length }
}

export function graphMappings(definition: JsonValue): JsonObject {
  const index = requireObject(definition, 'Index')
  return requireObject(requireObject(index.graphProfile ?? null, 'graphProfile').fields ?? null, 'graphProfile.fields')
}

function mappedField(mappings: JsonObject, key: string): string {
  const field = mappings[key]
  if (typeof field !== 'string' || !field) throw new Error(`graphProfile.fields.${key}: missing field mapping.`)
  return field
}

export function buildKnowledgeGraph(definition: JsonValue, documents: JsonObject[]): WorkbenchGraph {
  const mappings = graphMappings(definition)
  const fields = Object.fromEntries(
    ['assertionIdField', 'subjectField', 'subjectIdField', 'subjectTypeField', 'predicateField',
      'objectField', 'objectIdField', 'objectTypeField', 'graphNameField'].map((key) => [key, mappedField(mappings, key)]),
  )
  const nodes = new Map<string, WorkbenchNode>()
  const edgeIds = new Set<string>()
  const edges = documents.map((raw): WorkbenchEdge => {
    const text = (key: string) => {
      const value = raw[fields[key]]
      if (typeof value !== 'string' || !value) throw new Error(`${fields[key]}: expected a nonempty string.`)
      return value
    }
    const graph = text('graphNameField')
    const scope = (kind: string, id: string) => JSON.stringify([graph, kind, id])
    const source = scope('entity', text('subjectIdField'))
    const objectId = raw[fields.objectIdField]
    const object = raw[fields.objectField]
    const objectType = text('objectTypeField')
    const target = typeof objectId === 'string' && objectId
      ? scope('entity', objectId)
      : scope('literal', `${objectType}:${JSON.stringify(object)}`)
    if (object === undefined || object === null) throw new Error(`${fields.objectField}: missing object value.`)
    const id = scope('assertion', text('assertionIdField'))
    if (edgeIds.has(id)) throw new Error(`Duplicate assertion: ${id}`)
    edgeIds.add(id)
    nodes.set(source, { id: source, label: text('subjectField'), type: text('subjectTypeField'), raw })
    nodes.set(target, { id: target, label: String(object), type: objectType, raw })
    return { id, source, target, label: text('predicateField'), raw }
  })
  return { nodes: [...nodes.values()], edges }
}

export function buildTopicTitleRows(definition: JsonValue, documents: JsonObject[], titlePredicate: string): Array<{ title: string; id: string; graph: string }> {
  const mappings = graphMappings(definition)
  const predicateField = mappedField(mappings, 'predicateField')
  const idField = mappedField(mappings, 'subjectIdField')
  const titleField = mappedField(mappings, 'objectField')
  const graphField = mappedField(mappings, 'graphNameField')
  const seen = new Set<string>()
  return documents.filter((document) => document[predicateField] === titlePredicate).flatMap((document) => {
    const id = document[idField], title = document[titleField], graph = document[graphField]
    if (typeof id !== 'string' || !id || typeof title !== 'string' || typeof graph !== 'string' || !graph) {
      throw new Error('Topic title assertions require string subject IDs, graph names and title values.')
    }
    const key = JSON.stringify([graph, id, title])
    if (seen.has(key)) return []
    seen.add(key)
    return [{ title, id, graph }]
  })
}

export function buildGraphDocumentBatch(definition: JsonValue, baseline: JsonObject[], documents: JsonObject[]): JsonObject {
  buildKnowledgeGraph(definition, documents)
  const key = getIndexKeyFieldName(definition)
  if (!key) throw new Error('Index: missing key field.')
  const fields = getIndexTopLevelFieldNames(definition)
  const allowed = new Set(fields)
  const project = (document: JsonObject) => {
    for (const field of Object.keys(document)) {
      if (!allowed.has(field) && !field.startsWith('@search.') && !field.startsWith('@odata.')) {
        throw new Error(`Unknown index field: ${field}`)
      }
    }
    const value = projectDocumentForIndexing(document, fields)
    value['@search.action'] = 'mergeOrUpload'
    return value
  }
  const byKey = (items: JsonObject[]) => {
    const map = new Map<string, JsonObject>()
    for (const item of items) {
      const id = item[key]
      if (typeof id !== 'string' || !id) throw new Error(`${key}: expected a nonempty document key.`)
      if (map.has(id)) throw new Error(`Duplicate document key: ${id}`)
      map.set(id, project(item))
    }
    return map
  }
  const old = byKey(baseline)
  const next = byKey(documents)
  return {
    value: [
      ...[...next].filter(([id, document]) => JSON.stringify(document) !== JSON.stringify(old.get(id))).map(([, document]) => document),
      ...[...old.keys()].filter((id) => !next.has(id)).map((id) => ({ '@search.action': 'delete', [key]: id })),
    ],
  }
}

export function getManagedGraphOwner(sources: JsonObject[], indexName: string): string | undefined {
  return sources.find((source) => Object.entries(source).some(([key, parameters]) => {
    if (!key.endsWith('Parameters') || !isJsonObject(parameters)) return false
    const resources = parameters.createdResources
    return isJsonObject(resources) && Object.values(resources).includes(indexName)
  }))?.name?.toString()
}

const OWL = 'http://www.w3.org/2002/07/owl#'
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'

export function parseOntology(text: string): { document: JsonObject; entries: JsonObject[]; graph: WorkbenchGraph } {
  const document = requireObject(JSON.parse(text) as JsonValue, 'Ontology')
  const context = requireObject(document['@context'] ?? null, '@context')
  const expand = (id: string): string => {
    const [prefix, ...parts] = id.split(':')
    const mapping = context[prefix]
    const namespace = typeof mapping === 'string' ? mapping : isJsonObject(mapping) ? mapping['@id'] : undefined
    return typeof namespace === 'string' ? namespace + parts.join(':') : id
  }
  if (!Array.isArray(document['@graph'])) throw new Error('@graph: expected an array.')
  const entries = document['@graph'].map((entry) => requireObject(entry, '@graph entry'))
  const byId = new Map<string, JsonObject>()
  const idOf = (entry: JsonObject) => {
    if (typeof entry['@id'] !== 'string' || !entry['@id']) throw new Error('@id: expected a nonempty string.')
    return expand(entry['@id'])
  }
  for (const entry of entries) {
    const id = idOf(entry)
    if (byId.has(id)) throw new Error(`Duplicate ontology ID: ${entry['@id']}`)
    byId.set(id, entry)
  }
  const property = (entry: JsonObject, uri: string): JsonValue | undefined => Object.entries(entry).find(([key]) => expand(key) === uri)?.[1]
  const hasType = (entry: JsonObject, type: string) => {
    const types = Array.isArray(entry['@type']) ? entry['@type'] : [entry['@type']]
    return types.some((value) => typeof value === 'string' && expand(value) === OWL + type)
  }
  const label = (entry: JsonObject) => {
    const value = property(entry, RDFS + 'label')
    return typeof value === 'string' ? value : String(entry['@id'])
  }
  const classes = entries.filter((entry) => hasType(entry, 'Class'))
  const classIds = new Set(classes.map(idOf))
  const edges = entries.filter((entry) => hasType(entry, 'ObjectProperty')).map((entry): WorkbenchEdge => {
    const reference = (key: string) => {
      const ref = property(entry, RDFS + key)
      if (!ref || !isJsonObject(ref) || typeof ref['@id'] !== 'string' || !classIds.has(expand(ref['@id']))) {
        throw new Error(`${entry['@id']}: ${key} must reference an existing class.`)
      }
      return expand(ref['@id'])
    }
    return { id: idOf(entry), source: reference('domain'), target: reference('range'), label: label(entry), raw: entry }
  })
  return {
    document, entries,
    graph: { nodes: classes.map((entry) => ({ id: idOf(entry), label: label(entry), type: 'owl:Class', raw: entry })), edges },
  }
}

export function buildOntologySourceUpdate(source: JsonObject, ontologyText: string): JsonObject {
  const ontology = parseOntology(ontologyText).document
  if (source.kind !== 'azureBlob') throw new Error('Ontology attachment requires an Azure Blob knowledge source.')
  const parameters = requireObject(source.azureBlobParameters ?? null, 'azureBlobParameters')
  const extraction = requireObject(parameters.graphExtraction ?? null, 'graphExtraction')
  const current = extraction.ontology
  const value = JSON.stringify(ontology)
  const previous = isJsonObject(current) && typeof current.value === 'string' ? JSON.stringify(JSON.parse(current.value)) : undefined
  const ingestion = requireObject(parameters.ingestionParameters ?? null, 'ingestionParameters')
  const cache = ingestion.cache
  if (previous !== value && (!cache || !isJsonObject(cache) || cache.enableReprocessing !== true)) {
    throw new Error('Ontology changes require an existing cache with enableReprocessing=true. Create a new source if no cache was configured.')
  }
  const body = Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('@odata.')))
  const writableParameters = Object.fromEntries(Object.entries(parameters).filter(([key]) => key !== 'createdResources'))
  return {
    ...body,
    azureBlobParameters: {
      ...writableParameters,
      graphExtraction: { ...extraction, ontology: { ...(isJsonObject(current) ? current : {}), kind: 'inline', value } },
    },
  }
}
