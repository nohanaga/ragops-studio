/**
 * Reads the topic hierarchy that the Foundry IQ TopicGraph build publishes to a topic index, and summarizes how
 * result chunks spread over its leaf topics.
 *
 * The published topic index is an edge-list graph named `topicgraph-topic`:
 * - `HasRootTopic` (graph -> top-level topic) and `HasSubTopic` (parent -> child) give the hierarchy
 * - `prop:title`, `prop:description` and `prop:proportion` describe a topic; the proportion is its share of the clustered chunks
 * - `HasCentroidVector` stores the centroid of every leaf topic in the index's vector field, which may not be retrievable
 * Chunk membership is not stored. The official reader (topicgraph_consume.release_reader) treats the source chunks nearest
 * a leaf centroid as its members, so a chunk is placed in the leaf whose centroid is nearest to its vector (see topicGraphReader).
 */

export const TOPIC_GRAPH_NAME = 'topicgraph-topic'
export const TOPIC_PREDICATES = {
  root: 'HasRootTopic',
  child: 'HasSubTopic',
  title: 'prop:title',
  description: 'prop:description',
  proportion: 'prop:proportion',
  centroid: 'HasCentroidVector',
} as const

const TOPIC_PREFIX = 'topic:'
const PROPORTION_TOLERANCE = 1e-9

export type TopicGraphRow = {
  graphName?: string
  subjectId?: string
  predicate?: string
  objectId?: string
  objectString?: string
  objectDouble?: number
}

export type TopicNode = {
  id: string
  label?: string
  description?: string
  depth: number
  parentId?: string
  /** Top-level ancestor (the topic itself when it is top-level). */
  branchId: string
  children: string[]
  /** Share of the clustered chunks (0 to 1). For a parent this is the sum over its leaves. */
  proportion: number
}

export type TopicHierarchy = {
  topics: Map<string, TopicNode>
  roots: string[]
  leaves: string[]
}

export type TopicGraphFormatErrorCode =
  | 'empty' | 'graphName' | 'noRoot' | 'multipleParents' | 'orphan' | 'cycle' | 'proportion'

export class TopicGraphFormatError extends Error {
  readonly code: TopicGraphFormatErrorCode
  readonly detail: string

  constructor(code: TopicGraphFormatErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'TopicGraphFormatError'
    this.code = code
    this.detail = detail
  }
}

const isTopicId = (value: string | undefined): value is string => typeof value === 'string' && value.startsWith(TOPIC_PREFIX)

export function buildTopicHierarchy(rows: readonly TopicGraphRow[]): TopicHierarchy {
  if (rows.length === 0) throw new TopicGraphFormatError('empty', 'The topic index has no documents.')
  const foreign = rows.find((row) => row.graphName !== TOPIC_GRAPH_NAME)
  if (foreign) throw new TopicGraphFormatError('graphName', String(foreign.graphName))

  const roots = new Set<string>()
  const parents = new Map<string, string>()
  const titles = new Map<string, string>()
  const descriptions = new Map<string, string>()
  const proportions = new Map<string, number>()
  for (const row of rows) {
    const { predicate, subjectId, objectId } = row
    if (predicate === TOPIC_PREDICATES.root && isTopicId(objectId)) roots.add(objectId)
    else if (predicate === TOPIC_PREDICATES.child && isTopicId(subjectId) && isTopicId(objectId)) {
      if (parents.has(objectId)) throw new TopicGraphFormatError('multipleParents', objectId)
      parents.set(objectId, subjectId)
    } else if (!isTopicId(subjectId)) continue
    else if (predicate === TOPIC_PREDICATES.title && row.objectString?.trim()) titles.set(subjectId, row.objectString.trim())
    else if (predicate === TOPIC_PREDICATES.description && row.objectString?.trim()) descriptions.set(subjectId, row.objectString.trim())
    else if (predicate === TOPIC_PREDICATES.proportion && typeof row.objectDouble === 'number') proportions.set(subjectId, row.objectDouble)
  }
  if (roots.size === 0) throw new TopicGraphFormatError('noRoot', 'No HasRootTopic edge was found.')

  const ids = new Set([...roots, ...parents.keys(), ...parents.values(), ...proportions.keys()])
  const topics = new Map<string, TopicNode>()
  for (const id of [...ids].sort()) {
    topics.set(id, {
      id, label: titles.get(id), description: descriptions.get(id), depth: 0, parentId: parents.get(id), branchId: id, children: [], proportion: 0,
    })
  }
  for (const [child, parent] of parents) topics.get(parent)?.children.push(child)
  for (const root of roots) if (parents.has(root)) throw new TopicGraphFormatError('cycle', `${root} is a root and has a parent.`)

  const visited = new Set<string>()
  let frontier = [...roots].sort()
  for (let depth = 0; frontier.length > 0; depth += 1) {
    const next: string[] = []
    for (const id of frontier) {
      if (visited.has(id)) throw new TopicGraphFormatError('cycle', id)
      visited.add(id)
      const node = topics.get(id)!
      node.depth = depth
      node.branchId = node.parentId ? topics.get(node.parentId)!.branchId : id
      next.push(...node.children)
    }
    frontier = next
  }
  const orphan = [...topics.keys()].find((id) => !visited.has(id))
  if (orphan) throw new TopicGraphFormatError('orphan', orphan)

  const leaves: string[] = []
  for (const node of topics.values()) {
    if (node.children.length > 0) continue
    leaves.push(node.id)
    const proportion = proportions.get(node.id)
    if (proportion === undefined || !(proportion >= 0 && proportion <= 1 + PROPORTION_TOLERANCE)) throw new TopicGraphFormatError('proportion', node.id)
    node.proportion = proportion
  }

  const total = (id: string): number => {
    const node = topics.get(id)!
    if (node.children.length === 0) return node.proportion
    node.proportion = node.children.reduce((sum, child) => sum + total(child), 0)
    return node.proportion
  }
  for (const root of roots) total(root)
  for (const node of topics.values()) node.children.sort((left, right) => topics.get(right)!.proportion - topics.get(left)!.proportion || left.localeCompare(right))

  return { topics, roots: [...roots].sort((left, right) => topics.get(right)!.proportion - topics.get(left)!.proportion || left.localeCompare(right)), leaves }
}

export type LeafAssignment = {
  leafId: string
  /** `@search.score` of the nearest centroid; its scale depends on the vector metric of the topic index. */
  score: number
}

export type TopicHit = {
  leafId: string
  count: number
  /** 1-based ranks of the results in this topic. */
  ranks: number[]
}

export type TopicCoverage = {
  assigned: number
  unassigned: number
  leafCount: number
  hits: TopicHit[]
  /** exp of the Shannon entropy of the topic shares: 1 when all results share a topic, K when K topics are used evenly. */
  effectiveTopics: number
  /** Sum of the corpus shares of the hit leaf topics (0 to 1). */
  corpusCoverage: number
}

export function summarizeTopicCoverage(hierarchy: TopicHierarchy, leafIdByRank: readonly (string | undefined)[]): TopicCoverage {
  const byLeaf = new Map<string, TopicHit>()
  leafIdByRank.forEach((leafId, index) => {
    if (!leafId) return
    const hit = byLeaf.get(leafId) ?? { leafId, count: 0, ranks: [] }
    hit.count += 1
    hit.ranks.push(index + 1)
    byLeaf.set(leafId, hit)
  })
  const hits = [...byLeaf.values()].sort((left, right) => right.count - left.count || left.ranks[0] - right.ranks[0])
  const assigned = hits.reduce((sum, hit) => sum + hit.count, 0)
  const entropy = hits.reduce((sum, hit) => sum - (hit.count / assigned) * Math.log(hit.count / assigned), 0)
  return {
    assigned,
    unassigned: leafIdByRank.length - assigned,
    leafCount: hierarchy.leaves.length,
    hits,
    effectiveTopics: assigned > 0 ? Math.exp(entropy) : 0,
    corpusCoverage: Math.min(1, hits.reduce((sum, hit) => sum + (hierarchy.topics.get(hit.leafId)?.proportion ?? 0), 0)),
  }
}

/** Labels from the top-level topic down to `topicId`, falling back to the topic ID when a topic has no title. */
export function describeTopicPath(hierarchy: TopicHierarchy, topicId: string): string {
  const path: string[] = []
  for (let node = hierarchy.topics.get(topicId); node; node = node.parentId ? hierarchy.topics.get(node.parentId) : undefined) {
    path.unshift(node.label ?? node.id)
  }
  return path.join(' › ')
}

/**
 * A distinct color for the n-th top-level topic (golden-angle hue steps stay apart for any number of branches).
 * The commas matter: ECharts parses colors itself to derive the highlight color, and it does not understand the
 * space-separated `hsl(0 62% 52%)` form. Such a color loses its fill on hover, which makes the segment transparent
 * and unclickable for the moment, so the hover state flips on and off with every pixel the pointer moves.
 */
export function topicBranchColor(index: number, lightness = 52, saturation = 62): string {
  return `hsl(${Math.round(((index * 137.508) % 360 + 360) % 360)}, ${saturation}%, ${lightness}%)`
}

export type TopicTreemapCell = {
  id: string
  branchId: string
  x: number
  y: number
  width: number
  height: number
}

type Rect = { x: number; y: number; width: number; height: number }

function squarify<T extends { value: number }>(items: readonly T[], rect: Rect): Array<T & Rect> {
  const total = items.reduce((sum, item) => sum + item.value, 0)
  const scale = total > 0 ? (rect.width * rect.height) / total : 0
  const sized = items.map((item) => ({ item, area: total > 0 ? Math.max(item.value * scale, 1e-9) : (rect.width * rect.height) / items.length }))
  const placed: Array<T & Rect> = []
  let { x, y, width, height } = rect
  while (sized.length > 0) {
    const side = Math.min(width, height)
    if (side <= 0) {
      for (const entry of sized) placed.push({ ...entry.item, x, y, width: 0, height: 0 })
      break
    }
    const worst = (row: typeof sized) => {
      const sum = row.reduce((acc, entry) => acc + entry.area, 0)
      const max = Math.max(...row.map((entry) => entry.area))
      const min = Math.min(...row.map((entry) => entry.area))
      return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
    }
    const row: typeof sized = []
    let current = Infinity
    while (sized.length > 0) {
      const candidate = [...row, sized[0]]
      const ratio = worst(candidate)
      if (row.length > 0 && ratio > current) break
      row.push(sized.shift()!)
      current = ratio
    }
    const rowArea = row.reduce((acc, entry) => acc + entry.area, 0)
    const thickness = side > 0 ? rowArea / side : 0
    if (width >= height) {
      let cursor = y
      for (const entry of row) {
        const length = thickness > 0 ? entry.area / thickness : 0
        placed.push({ ...entry.item, x, y: cursor, width: thickness, height: length })
        cursor += length
      }
      x += thickness
      width -= thickness
    } else {
      let cursor = x
      for (const entry of row) {
        const length = thickness > 0 ? entry.area / thickness : 0
        placed.push({ ...entry.item, x: cursor, y, width: length, height: thickness })
        cursor += length
      }
      y += thickness
      height -= thickness
    }
  }
  return placed
}

/** Squarified treemap of the leaf topics, sized by corpus share and grouped by hierarchy. `gap` separates the cells. */
export function layoutTopicTreemap(hierarchy: TopicHierarchy, width: number, height: number, gap = 1): TopicTreemapCell[] {
  const cells: TopicTreemapCell[] = []
  const place = (ids: readonly string[], rect: Rect) => {
    const items = ids.map((id) => ({ id, value: hierarchy.topics.get(id)!.proportion }))
    for (const placed of squarify(items, rect)) {
      const node = hierarchy.topics.get(placed.id)!
      const inner = {
        x: placed.x + gap / 2,
        y: placed.y + gap / 2,
        width: Math.max(0, placed.width - gap),
        height: Math.max(0, placed.height - gap),
      }
      if (node.children.length === 0) cells.push({ id: node.id, branchId: node.branchId, ...inner })
      else place(node.children, inner)
    }
  }
  place(hierarchy.roots, { x: 0, y: 0, width, height })
  return cells
}
