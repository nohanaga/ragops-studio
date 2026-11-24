import { isLiteralGraphNode, type GraphProvenanceKind, type WorkbenchGraph } from './knowledgeGraph'
import type { TranslationKey } from './translations'

export type GqlPattern = {
  subjectType: string
  predicate: string
  objectType: string
  count: number
  subjectExample: string
  objectExample: string
}
export type GqlEntity = { name: string; type: string; degree: number; outDegree: number }
export type GqlVocabulary = {
  nodeTypes: Array<{ name: string; count: number }>
  predicates: Array<{ name: string; count: number }>
  patterns: GqlPattern[]
  entities: GqlEntity[]
  hasProvenanceIndex: boolean
  loaded: boolean
}

export const EMPTY_GQL_VOCABULARY: GqlVocabulary = {
  nodeTypes: [], predicates: [], patterns: [], entities: [], hasProvenanceIndex: false, loaded: false,
}

const MAX_PATTERNS = 30
const MAX_ENTITIES = 30
const TOPIC_ROOT_PREDICATE = 'HasRootTopic'
const TOPIC_SUB_PREDICATE = 'HasSubTopic'
const RESERVED_WORDS = new Set([
  'MATCH', 'WHERE', 'RETURN', 'ORDER', 'BY', 'LIMIT', 'OFFSET', 'AND', 'OR', 'NOT', 'AS', 'DISTINCT', 'NEXT', 'FILTER',
  'LET', 'FOR', 'IN', 'IS', 'NULL', 'TRUE', 'FALSE', 'GROUP', 'UNION', 'ASC', 'DESC', 'XOR', 'OPTIONAL', 'CALL', 'WITH',
])

const byCountThenName = <T extends { count: number; name: string }>(a: T, b: T) => b.count - a.count || a.name.localeCompare(b.name)

// 取得済みのグラフ (アサーションから組み立てたノードとエッジ) から、GQL に書ける型・関係名・パターンを集計します。
export function buildGqlVocabulary(graph: WorkbenchGraph, hasProvenanceIndex: boolean): GqlVocabulary {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const typeCounts = new Map<string, number>()
  const entities = new Map<string, GqlEntity>()
  for (const node of graph.nodes) {
    if (isLiteralGraphNode(node)) continue
    typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1)
    entities.set(node.id, { name: node.label, type: node.type, degree: 0, outDegree: 0 })
  }
  const predicateCounts = new Map<string, number>()
  const patterns = new Map<string, GqlPattern>()
  for (const edge of graph.edges) {
    predicateCounts.set(edge.label, (predicateCounts.get(edge.label) ?? 0) + 1)
    const source = nodes.get(edge.source)
    const target = nodes.get(edge.target)
    if (!source || !target) continue
    const from = entities.get(edge.source)
    const to = entities.get(edge.target)
    if (from) { from.degree += 1; from.outDegree += 1 }
    if (to) to.degree += 1
    if (!from || !to) continue
    const key = JSON.stringify([source.type, edge.label, target.type])
    const existing = patterns.get(key)
    if (existing) existing.count += 1
    else patterns.set(key, {
      subjectType: source.type, predicate: edge.label, objectType: target.type, count: 1,
      subjectExample: source.label, objectExample: target.label,
    })
  }
  return {
    nodeTypes: [...typeCounts].map(([name, count]) => ({ name, count })).sort(byCountThenName),
    predicates: [...predicateCounts].map(([name, count]) => ({ name, count })).sort(byCountThenName),
    patterns: [...patterns.values()]
      .sort((a, b) => b.count - a.count || a.predicate.localeCompare(b.predicate) || a.subjectType.localeCompare(b.subjectType))
      .slice(0, MAX_PATTERNS),
    entities: [...entities.values()]
      .sort((a, b) => b.degree - a.degree || a.name.localeCompare(b.name))
      .slice(0, MAX_ENTITIES),
    hasProvenanceIndex,
    loaded: true,
  }
}

const hasControlCharacter = (value: string) => [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)

// 型名・関係名として GQL に書ける形にします。特殊文字を含む場合はバッククォートで囲み、安全に囲めない場合は null です。
export function gqlIdentifier(name: string): string | null {
  if (!name || /[`\\]/.test(name) || hasControlCharacter(name)) return null
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !RESERVED_WORDS.has(name.toUpperCase()) ? name : `\`${name}\``
}

// 文字列リテラルにします。エスケープが必要な文字を含む値は、誤ったクエリを作らないよう null を返します。
export function gqlString(value: string): string | null {
  if (!value || /['"\\]/.test(value) || hasControlCharacter(value)) return null
  return `'${value}'`
}

const ident = (name: string) => gqlIdentifier(name) ?? ''
const text = (value: string) => gqlString(value) ?? ''
export const isSafeGqlPattern = (pattern: GqlPattern) => [pattern.subjectType, pattern.objectType].every((name) => gqlIdentifier(name) !== null)
  && gqlString(pattern.predicate) !== null

export type GqlTemplateId = 'typedRelation' | 'predicateOnly' | 'fromName' | 'sharedNeighbor' | 'twoHop' | 'countBy'
  | 'evidence' | 'topicRoots' | 'topicHierarchy' | 'topicCounts'
export type GqlTemplateLevel = 1 | 2 | 3 | 4
export type GqlTemplate = {
  id: GqlTemplateId
  level: GqlTemplateLevel
  group: 'general' | 'topic'
  titleKey: TranslationKey
  descriptionKey: TranslationKey
  gql: string
  provenance?: Exclude<GraphProvenanceKind, 'none'>
  sample: boolean
}

const SAMPLE_PATTERN: GqlPattern = {
  subjectType: 'Person', predicate: 'worksFor', objectType: 'Organization', count: 1, subjectExample: 'Ada', objectExample: 'Contoso',
}
const SAMPLE_SECOND_HOP = { predicate: 'locatedIn', type: 'Place' }

export function gqlTypedRelationQuery(pattern: GqlPattern): string {
  return [
    `MATCH (a:${ident(pattern.subjectType)})-[r]->(b:${ident(pattern.objectType)})`,
    `WHERE r.predicate = ${text(pattern.predicate)}`,
    'RETURN a.name AS subject, r.predicate AS predicate, b.name AS object',
    'ORDER BY subject, object',
    'LIMIT 25',
  ].join('\n')
}

export function gqlFromNameQuery(name: string): string {
  return [
    'MATCH (subject)-[edge]->(object)',
    `WHERE subject.name = ${text(name)}`,
    'RETURN subject.id AS subject_id, subject.name AS subject_name,',
    '       edge.predicate AS relation, object.id AS object_id, object.name AS object_name',
    'ORDER BY relation, object_name',
    'LIMIT 25',
  ].join('\n')
}

export function isSafeGqlEntityName(name: string): boolean {
  return gqlString(name) !== null
}

// 翻訳文の {key} を値で置き換えます。
export function formatGqlMessage(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => params[key] ?? placeholder)
}

type Resolved = { gql: string; sample: boolean; provenance?: GqlTemplate['provenance'] }

// 連鎖 (A -P1-> B -P2-> C) と、同じ相手に向かう 2 本 (A -P1-> M <-P2- B) のうち、取得済みのグラフに実在するものを探します。
function findTwoHop(patterns: GqlPattern[]): Resolved | null {
  const chain = patterns.flatMap((first) => patterns
    .filter((second) => second.subjectType === first.objectType && (second.predicate !== first.predicate || second.objectType !== first.subjectType))
    .map((second) => ({ first, second, score: (second.predicate !== first.predicate ? 1_000_000 : 0) + Math.min(first.count, second.count) })))
    .sort((a, b) => b.score - a.score)[0]
  if (chain) {
    return {
      sample: false,
      gql: [
        `MATCH (a:${ident(chain.first.subjectType)})-[first]->(b:${ident(chain.first.objectType)})-[second]->(c:${ident(chain.second.objectType)})`,
        `WHERE first.predicate = ${text(chain.first.predicate)} AND second.predicate = ${text(chain.second.predicate)}`,
        'RETURN a.name AS start_name, b.name AS middle_name, c.name AS end_name',
        'LIMIT 25',
      ].join('\n'),
    }
  }
  const converge = patterns.flatMap((first) => patterns
    .filter((second) => second.objectType === first.objectType && second.predicate !== first.predicate)
    .map((second) => ({ first, second, score: Math.min(first.count, second.count) })))
    .sort((a, b) => b.score - a.score)[0]
  if (!converge) return null
  return {
    sample: false,
    gql: [
      'MATCH (a)-[first]->(middle)<-[second]-(b)',
      `WHERE first.predicate = ${text(converge.first.predicate)} AND second.predicate = ${text(converge.second.predicate)}`,
      'RETURN a.name AS first_name, middle.name AS shared, b.name AS second_name',
      'LIMIT 25',
    ].join('\n'),
  }
}

export function buildGqlTemplates(vocabulary: GqlVocabulary): GqlTemplate[] {
  const patterns = vocabulary.patterns.filter(isSafeGqlPattern)
  const lead = patterns[0]
  const entity = vocabulary.entities
    .filter((item) => item.outDegree > 0 && gqlString(item.name) !== null)
    .sort((a, b) => b.outDegree - a.outDegree || b.degree - a.degree)[0]
  const evidenceSource = patterns.find((pattern) => gqlString(pattern.subjectExample) !== null)
  const predicate = vocabulary.predicates.find((item) => gqlString(item.name) !== null)?.name
  const shared = patterns.find((pattern) => pattern.count >= 2)
  const evidenceKind = vocabulary.hasProvenanceIndex ? 'hydrate' : 'ids'
  const pattern = lead ?? SAMPLE_PATTERN
  const twoHop: Resolved = findTwoHop(patterns) ?? {
    sample: true,
    gql: [
      `MATCH (person:${SAMPLE_PATTERN.subjectType})-[job]->(org:${SAMPLE_PATTERN.objectType})-[location]->(city:${SAMPLE_SECOND_HOP.type})`,
      `WHERE job.predicate = '${SAMPLE_PATTERN.predicate}' AND location.predicate = '${SAMPLE_SECOND_HOP.predicate}'`,
      'RETURN person.name AS person, org.name AS organization, city.name AS city',
      'LIMIT 25',
    ].join('\n'),
  }
  const resolved: Array<[Omit<GqlTemplate, 'gql' | 'sample' | 'provenance' | 'group'>, Resolved]> = [
    [{ id: 'typedRelation', level: 1, titleKey: 'kgGqlTplTypedRelationTitle', descriptionKey: 'kgGqlTplTypedRelationDesc' },
      { gql: gqlTypedRelationQuery(pattern), sample: !lead }],
    [{ id: 'predicateOnly', level: 1, titleKey: 'kgGqlTplPredicateOnlyTitle', descriptionKey: 'kgGqlTplPredicateOnlyDesc' },
      { gql: [
        `MATCH (a)-[r:${ident(predicate ?? SAMPLE_PATTERN.predicate)}]->(b)`,
        'RETURN a.name AS subject, r.predicate AS predicate, b.name AS object',
        'LIMIT 25',
      ].join('\n'), sample: !predicate }],
    [{ id: 'fromName', level: 2, titleKey: 'kgGqlTplFromNameTitle', descriptionKey: 'kgGqlTplFromNameDesc' },
      { gql: gqlFromNameQuery(entity?.name ?? SAMPLE_PATTERN.subjectExample), sample: !entity }],
    [{ id: 'sharedNeighbor', level: 2, titleKey: 'kgGqlTplSharedNeighborTitle', descriptionKey: 'kgGqlTplSharedNeighborDesc' },
      { gql: [
        `MATCH (a:${ident((shared ?? SAMPLE_PATTERN).subjectType)})-[:${ident((shared ?? SAMPLE_PATTERN).predicate)}]->(n:${ident((shared ?? SAMPLE_PATTERN).objectType)})`
          + `<-[:${ident((shared ?? SAMPLE_PATTERN).predicate)}]-(b:${ident((shared ?? SAMPLE_PATTERN).subjectType)})`,
        'WHERE a.name < b.name',
        'RETURN a.name AS a_name, b.name AS b_name, n.name AS shared',
        'ORDER BY shared',
        'LIMIT 25',
      ].join('\n'), sample: !shared }],
    [{ id: 'twoHop', level: 3, titleKey: 'kgGqlTplTwoHopTitle', descriptionKey: 'kgGqlTplTwoHopDesc' }, twoHop],
    [{ id: 'countBy', level: 3, titleKey: 'kgGqlTplCountByTitle', descriptionKey: 'kgGqlTplCountByDesc' },
      { gql: [
        `MATCH (a:${ident(pattern.subjectType)})-[r]->(b:${ident(pattern.objectType)})`,
        `WHERE r.predicate = ${text(pattern.predicate)}`,
        'RETURN b.id AS target_id, b.name AS target, count(*) AS relation_count',
        'GROUP BY b.id, b.name',
        'ORDER BY relation_count DESC, target',
        'LIMIT 10',
      ].join('\n'), sample: !lead }],
    [{ id: 'evidence', level: 4, titleKey: 'kgGqlTplEvidenceTitle', descriptionKey: 'kgGqlTplEvidenceDesc' },
      { gql: [
        'MATCH (a)-[r]->(b)',
        `WHERE a.name = ${text((evidenceSource ?? SAMPLE_PATTERN).subjectExample)} AND r.predicate = ${text((evidenceSource ?? SAMPLE_PATTERN).predicate)}`,
        'RETURN a.name AS subject, r.predicate AS predicate, b.name AS object',
        'ORDER BY object',
        'LIMIT 10',
      ].join('\n'), sample: !evidenceSource, provenance: evidenceKind }],
  ]
  const templates = resolved.map(([meta, value]): GqlTemplate => ({ ...meta, group: 'general', ...value }))
  const names = new Set(vocabulary.predicates.map((item) => item.name))
  if (names.has(TOPIC_ROOT_PREDICATE)) {
    templates.push({
      id: 'topicRoots', level: 1, group: 'topic', titleKey: 'kgGqlTplTopicRootsTitle', descriptionKey: 'kgGqlTplTopicRootsDesc', sample: false,
      gql: [
        'MATCH (root)-[edge]->(topic)',
        `WHERE edge.predicate = '${TOPIC_ROOT_PREDICATE}'`,
        'RETURN root.id AS graph_id, topic.id AS topic_id, topic.name AS topic_name',
        'ORDER BY topic_id',
        'LIMIT 25',
      ].join('\n'),
    })
    if (names.has(TOPIC_SUB_PREDICATE)) {
      templates.push({
        id: 'topicHierarchy', level: 3, group: 'topic', titleKey: 'kgGqlTplTopicHierarchyTitle', descriptionKey: 'kgGqlTplTopicHierarchyDesc', sample: false,
        gql: [
          'MATCH (root)-[first]->(parent)-[second]->(child)',
          `WHERE first.predicate = '${TOPIC_ROOT_PREDICATE}' AND second.predicate = '${TOPIC_SUB_PREDICATE}'`,
          'RETURN root.id AS graph_id, parent.name AS parent_topic, child.name AS child_topic',
          'ORDER BY parent_topic, child_topic',
          'LIMIT 25',
        ].join('\n'),
      }, {
        id: 'topicCounts', level: 3, group: 'topic', titleKey: 'kgGqlTplTopicCountsTitle', descriptionKey: 'kgGqlTplTopicCountsDesc', sample: false,
        gql: [
          'MATCH (parent)-[edge]->(child)',
          `WHERE edge.predicate = '${TOPIC_SUB_PREDICATE}'`,
          'RETURN parent.id AS parent_id, parent.name AS parent_topic, count(*) AS child_connections',
          'GROUP BY parent.id, parent.name',
          'ORDER BY child_connections DESC, parent_topic',
          'LIMIT 25',
        ].join('\n'),
      })
    }
  }
  return templates
}

export type GqlBuilderInput = {
  startType: string
  predicate: string
  endType: string
  startName: string
  endName: string
  includeIds: boolean
  orderByName: boolean
  limit: number
}
export type GqlBuilderResult =
  | { ok: true; gql: string; constrained: boolean }
  | { ok: false; error: 'unsafeText' | 'limit' }

export const GQL_BUILDER_MAX_LIMIT = 1000

// 「始点 - 関係 → 終点」の条件から、subject / predicate / object 列を返す GQL を組み立てます。
export function buildGqlFromBuilder(input: GqlBuilderInput): GqlBuilderResult {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > GQL_BUILDER_MAX_LIMIT) return { ok: false, error: 'limit' }
  const startType = input.startType.trim()
  const endType = input.endType.trim()
  const predicate = input.predicate.trim()
  const startName = input.startName.trim()
  const endName = input.endName.trim()
  const startLabel = startType ? gqlIdentifier(startType) : ''
  const endLabel = endType ? gqlIdentifier(endType) : ''
  const predicateLiteral = predicate ? gqlString(predicate) : ''
  const startLiteral = startName ? gqlString(startName) : ''
  const endLiteral = endName ? gqlString(endName) : ''
  if (startLabel === null || endLabel === null || predicateLiteral === null || startLiteral === null || endLiteral === null) {
    return { ok: false, error: 'unsafeText' }
  }
  const conditions = [
    predicateLiteral && `r.predicate = ${predicateLiteral}`,
    startLiteral && `a.name = ${startLiteral}`,
    endLiteral && `b.name = ${endLiteral}`,
  ].filter(Boolean)
  const columns = ['a.name AS subject', 'r.predicate AS predicate', 'b.name AS object',
    ...(input.includeIds ? ['a.id AS subject_id', 'b.id AS object_id'] : [])]
  return {
    ok: true,
    constrained: Boolean(startLabel || endLabel || conditions.length),
    gql: [
      `MATCH (a${startLabel ? `:${startLabel}` : ''})-[r]->(b${endLabel ? `:${endLabel}` : ''})`,
      ...(conditions.length ? [`WHERE ${conditions.join(' AND ')}`] : []),
      `RETURN ${columns.join(', ')}`,
      ...(input.orderByName ? ['ORDER BY subject, object'] : []),
      `LIMIT ${input.limit}`,
    ].join('\n'),
  }
}
