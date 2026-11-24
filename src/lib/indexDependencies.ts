/**
 * Dependency graph of the resources around an index:
 *
 *   Knowledge base -> Knowledge source -> Index -> Topic graph profile -> Topic index
 *
 * An arrow always points from the referencing resource to the referenced one.
 * The graph is derived only from explicit references in the definitions:
 * - knowledge base `knowledgeSources[].name`
 * - knowledge source `searchIndexParameters.searchIndexName` and `*Parameters.createdResources.*index`
 * - index field `topicGraphProfile` -> `vectorSearch.topicGraphProfiles[].name`
 * - topic graph profile `indexName`
 * - index `graphProfile.provenanceIndexName`
 * Names are never used to guess a relationship.
 */

type JsonRecord = Record<string, unknown>

export type DependencyNodeKind = 'knowledgeBase' | 'knowledgeSource' | 'index' | 'topicProfile'
export type IndexRole = 'searchTarget' | 'topic' | 'entityGraph' | 'graph' | 'provenance'
export type DependencyEdgeKind = 'kbSource' | 'sourceIndex' | 'fieldProfile' | 'profileIndex' | 'provenance' | 'unlinkedProfile'

export type DependencySnapshot = {
  indexes: JsonRecord[]
  knowledgeSources: JsonRecord[]
  knowledgeBases: JsonRecord[]
}

export type DependencyNode = {
  id: string
  kind: DependencyNodeKind
  name: string
  roles: IndexRole[]
  /** Knowledge source kind, or the default kind of a topic graph profile. */
  detail: string
  /** Name of the index that defines a topic graph profile. */
  ownerIndex: string
  /** Referenced by another resource but not present in the loaded definitions. */
  missing: boolean
}

export type DependencyEdge = {
  id: string
  kind: DependencyEdgeKind
  from: string
  to: string
  label: string
}

export type DependencyGraph = {
  focusId: string
  nodes: DependencyNode[]
  edges: DependencyEdge[]
}

export const DEPENDENCY_NODE_WIDTH = 216
export const DEPENDENCY_NODE_HEIGHT = 96
export const DEPENDENCY_GAP_X = 32
export const DEPENDENCY_GAP_Y = 76

export type PositionedNode = DependencyNode & { x: number; y: number; layer: number }
export type PositionedEdge = DependencyEdge & { path: string; labelX: number; labelY: number }
export type DependencyLayout = { nodes: PositionedNode[]; edges: PositionedEdge[]; width: number; height: number }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export const indexNodeId = (name: string) => `index:${name}`
export const knowledgeSourceNodeId = (name: string) => `knowledgeSource:${name}`
export const knowledgeBaseNodeId = (name: string) => `knowledgeBase:${name}`
export const topicProfileNodeId = (ownerIndex: string, name: string) => `topicProfile:${ownerIndex}:${name}`

/** Replaces (or adds) the definition of one index, for example with the unsaved definition in the editor. */
export function withDraftIndex(snapshot: DependencySnapshot, draft: JsonRecord | null): DependencySnapshot {
  const name = asName(draft?.name)
  if (!draft || !name) return snapshot
  const others = snapshot.indexes.filter((index) => asName(index.name) !== name)
  return { ...snapshot, indexes: [...others, draft] }
}

function walkFields(fields: unknown, visit: (field: JsonRecord, path: string) => void, parentPath = ''): void {
  for (const value of asArray(fields)) {
    if (!isRecord(value)) continue
    const name = asName(value.name)
    const path = parentPath ? `${parentPath}.${name}` : name
    visit(value, path)
    walkFields(value.fields, visit, path)
  }
}

export function buildDependencyGraph(snapshot: DependencySnapshot, focusIndexName: string): DependencyGraph {
  const nodes = new Map<string, DependencyNode>()
  const edges = new Map<string, DependencyEdge>()
  const roles = new Map<string, Set<IndexRole>>()

  const indexDefinitions = new Map<string, JsonRecord>()
  for (const index of snapshot.indexes) {
    const name = asName(index.name)
    if (name) indexDefinitions.set(name, index)
  }
  const sourceNames = new Set(snapshot.knowledgeSources.map((source) => asName(source.name)).filter(Boolean))
  const baseNames = new Set(snapshot.knowledgeBases.map((base) => asName(base.name)).filter(Boolean))

  const ensureIndex = (name: string): string => {
    const id = indexNodeId(name)
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'index', name, roles: [], detail: '', ownerIndex: '', missing: !indexDefinitions.has(name) })
    return id
  }
  const ensureSource = (name: string): string => {
    const id = knowledgeSourceNodeId(name)
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'knowledgeSource', name, roles: [], detail: '', ownerIndex: '', missing: !sourceNames.has(name) })
    return id
  }
  const ensureBase = (name: string): string => {
    const id = knowledgeBaseNodeId(name)
    if (!nodes.has(id)) nodes.set(id, { id, kind: 'knowledgeBase', name, roles: [], detail: '', ownerIndex: '', missing: !baseNames.has(name) })
    return id
  }
  const addRole = (indexName: string, role: IndexRole) => {
    roles.set(indexName, (roles.get(indexName) ?? new Set<IndexRole>()).add(role))
  }
  const addEdge = (kind: DependencyEdgeKind, from: string, to: string, label: string) => {
    const id = `${kind}|${from}|${to}`
    const existing = edges.get(id)
    if (!existing) {
      edges.set(id, { id, kind, from, to, label })
      return
    }
    if (!existing.label.split(', ').includes(label)) edges.set(id, { ...existing, label: `${existing.label}, ${label}` })
  }

  for (const base of snapshot.knowledgeBases) {
    const baseName = asName(base.name)
    if (!baseName) continue
    const baseId = ensureBase(baseName)
    for (const reference of asArray(base.knowledgeSources)) {
      const sourceName = isRecord(reference) ? asName(reference.name) : ''
      if (sourceName) addEdge('kbSource', baseId, ensureSource(sourceName), 'knowledgeSources')
    }
  }

  for (const source of snapshot.knowledgeSources) {
    const sourceName = asName(source.name)
    if (!sourceName) continue
    const sourceId = ensureSource(sourceName)
    const node = nodes.get(sourceId)
    if (node) nodes.set(sourceId, { ...node, detail: typeof source.kind === 'string' ? source.kind : '' })

    const searchIndexName = isRecord(source.searchIndexParameters) ? asName(source.searchIndexParameters.searchIndexName) : ''
    if (searchIndexName) {
      addEdge('sourceIndex', sourceId, ensureIndex(searchIndexName), 'searchIndexName')
      addRole(searchIndexName, 'searchTarget')
    }
    for (const [key, parameters] of Object.entries(source)) {
      if (!key.endsWith('Parameters') || !isRecord(parameters) || !isRecord(parameters.createdResources)) continue
      for (const [resourceKey, value] of Object.entries(parameters.createdResources)) {
        const indexName = asName(value)
        if (!indexName || !/index$/i.test(resourceKey)) continue
        addEdge('sourceIndex', sourceId, ensureIndex(indexName), `createdResources.${resourceKey}`)
        addRole(indexName, resourceKey === 'graphIndex' ? 'entityGraph' : 'searchTarget')
      }
    }
  }

  for (const [indexName, definition] of indexDefinitions) {
    const indexId = ensureIndex(indexName)
    const vectorSearch = isRecord(definition.vectorSearch) ? definition.vectorSearch : {}
    const definedProfiles = new Map<string, JsonRecord>()
    for (const profile of asArray(vectorSearch.topicGraphProfiles)) {
      const profileName = isRecord(profile) ? asName(profile.name) : ''
      if (isRecord(profile) && profileName) definedProfiles.set(profileName, profile)
    }

    const linkedProfiles = new Set<string>()
    const ensureProfile = (profileName: string): string => {
      const id = topicProfileNodeId(indexName, profileName)
      if (!nodes.has(id)) {
        const profile = definedProfiles.get(profileName)
        nodes.set(id, {
          id,
          kind: 'topicProfile',
          name: profileName,
          roles: [],
          detail: profile ? asName(profile.defaultKind) : '',
          ownerIndex: indexName,
          missing: !profile,
        })
      }
      return id
    }

    walkFields(definition.fields, (field, path) => {
      const profileName = asName(field.topicGraphProfile)
      if (!profileName) return
      linkedProfiles.add(profileName)
      addEdge('fieldProfile', indexId, ensureProfile(profileName), `${path}.topicGraphProfile`)
    })

    for (const [profileName, profile] of definedProfiles) {
      const profileId = ensureProfile(profileName)
      if (!linkedProfiles.has(profileName)) addEdge('unlinkedProfile', indexId, profileId, 'topicGraphProfiles')
      const targetName = asName(profile.indexName)
      if (targetName) {
        addEdge('profileIndex', profileId, ensureIndex(targetName), 'indexName')
        addRole(targetName, 'topic')
      }
    }

    if (isRecord(definition.graphProfile)) {
      addRole(indexName, 'graph')
      const provenanceName = asName(definition.graphProfile.provenanceIndexName)
      if (provenanceName) {
        addEdge('provenance', indexId, ensureIndex(provenanceName), 'graphProfile.provenanceIndexName')
        addRole(provenanceName, 'provenance')
      }
    }
  }

  const focusName = asName(focusIndexName)
  const focusId = focusName ? ensureIndex(focusName) : ''

  for (const [name, set] of roles) {
    const id = indexNodeId(name)
    const node = nodes.get(id)
    if (node) nodes.set(id, { ...node, roles: ROLE_ORDER.filter((role) => set.has(role)) })
  }

  if (!focusId) return { focusId, nodes: [], edges: [] }

  const forward = new Map<string, string[]>()
  const backward = new Map<string, string[]>()
  for (const edge of edges.values()) {
    forward.set(edge.from, [...(forward.get(edge.from) ?? []), edge.to])
    backward.set(edge.to, [...(backward.get(edge.to) ?? []), edge.from])
  }
  const reach = (adjacency: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>([focusId])
    const queue = [focusId]
    for (let head = 0; head < queue.length; head += 1) {
      for (const next of adjacency.get(queue[head]) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    return seen
  }
  const lineage = new Set<string>([...reach(forward), ...reach(backward)])

  return {
    focusId,
    nodes: [...nodes.values()].filter((node) => lineage.has(node.id)),
    edges: [...edges.values()].filter((edge) => lineage.has(edge.from) && lineage.has(edge.to)),
  }
}

const ROLE_ORDER: IndexRole[] = ['searchTarget', 'topic', 'entityGraph', 'graph', 'provenance']
const KIND_ORDER: DependencyNodeKind[] = ['knowledgeBase', 'knowledgeSource', 'index', 'topicProfile']

/** Edges that close a cycle. They are drawn but ignored when assigning layers. */
function findBackEdges(graph: DependencyGraph): Set<string> {
  const outgoing = new Map<string, DependencyEdge[]>()
  for (const edge of graph.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
  const state = new Map<string, 'active' | 'done'>()
  const back = new Set<string>()
  const visit = (id: string) => {
    state.set(id, 'active')
    for (const edge of outgoing.get(id) ?? []) {
      const next = state.get(edge.to)
      if (next === 'active') back.add(edge.id)
      else if (!next) visit(edge.to)
    }
    state.set(id, 'done')
  }
  for (const node of graph.nodes) if (!state.has(node.id)) visit(node.id)
  return back
}

/** Top-down layered layout: referencing resources above the resources they reference. */
export function layoutDependencyGraph(graph: DependencyGraph): DependencyLayout {
  const back = findBackEdges(graph)
  const forwardEdges = graph.edges.filter((edge) => !back.has(edge.id))
  const parents = new Map<string, string[]>()
  const indegree = new Map<string, number>(graph.nodes.map((node) => [node.id, 0]))
  for (const edge of forwardEdges) {
    parents.set(edge.to, [...(parents.get(edge.to) ?? []), edge.from])
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1)
  }

  const layer = new Map<string, number>()
  const queue = graph.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)
  for (const id of queue) layer.set(id, 0)
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]
    for (const edge of forwardEdges.filter((candidate) => candidate.from === id)) {
      layer.set(edge.to, Math.max(layer.get(edge.to) ?? 0, (layer.get(id) ?? 0) + 1))
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) - 1)
      if (indegree.get(edge.to) === 0) queue.push(edge.to)
    }
  }

  const rows = new Map<number, DependencyNode[]>()
  for (const node of graph.nodes) rows.set(layer.get(node.id) ?? 0, [...(rows.get(layer.get(node.id) ?? 0) ?? []), node])

  const order = new Map<string, number>()
  const layerIndexes = [...rows.keys()].sort((a, b) => a - b)
  for (const layerIndex of layerIndexes) {
    const row = rows.get(layerIndex) ?? []
    const barycenter = (node: DependencyNode): number => {
      const known = (parents.get(node.id) ?? []).map((parent) => order.get(parent)).filter((value): value is number => value !== undefined)
      return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : 0
    }
    row.sort((a, b) => (
      barycenter(a) - barycenter(b)
      || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
      || a.name.localeCompare(b.name)
    ))
    row.forEach((node, position) => order.set(node.id, position))
  }

  const widest = Math.max(1, ...[...rows.values()].map((row) => row.length))
  const width = widest * DEPENDENCY_NODE_WIDTH + (widest - 1) * DEPENDENCY_GAP_X
  const positioned = new Map<string, PositionedNode>()
  for (const layerIndex of layerIndexes) {
    const row = rows.get(layerIndex) ?? []
    const rowWidth = row.length * DEPENDENCY_NODE_WIDTH + (row.length - 1) * DEPENDENCY_GAP_X
    row.forEach((node, position) => {
      positioned.set(node.id, {
        ...node,
        layer: layerIndex,
        x: (width - rowWidth) / 2 + position * (DEPENDENCY_NODE_WIDTH + DEPENDENCY_GAP_X),
        y: layerIndex * (DEPENDENCY_NODE_HEIGHT + DEPENDENCY_GAP_Y),
      })
    })
  }

  const positionedEdges: PositionedEdge[] = []
  for (const edge of graph.edges) {
    const from = positioned.get(edge.from)
    const to = positioned.get(edge.to)
    if (!from || !to) continue
    const x1 = from.x + DEPENDENCY_NODE_WIDTH / 2
    const y1 = from.y + DEPENDENCY_NODE_HEIGHT
    const x2 = to.x + DEPENDENCY_NODE_WIDTH / 2
    const y2 = to.y
    const offset = Math.max(28, Math.abs(y2 - y1) / 2)
    positionedEdges.push({
      ...edge,
      path: `M ${x1} ${y1} C ${x1} ${y1 + offset}, ${x2} ${y2 - offset}, ${x2} ${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2,
    })
  }

  const lastLayer = layerIndexes.length ? layerIndexes[layerIndexes.length - 1] : 0
  return {
    nodes: [...positioned.values()],
    edges: positionedEdges,
    width,
    height: (lastLayer + 1) * DEPENDENCY_NODE_HEIGHT + lastLayer * DEPENDENCY_GAP_Y,
  }
}
