import { describe, expect, it } from 'vitest'
import {
  buildGqlFromBuilder, buildGqlTemplates, buildGqlVocabulary, EMPTY_GQL_VOCABULARY, formatGqlMessage, gqlIdentifier, gqlString,
} from './gqlAssist'
import type { WorkbenchEdge, WorkbenchGraph, WorkbenchNode } from './knowledgeGraph'

const entity = (id: string, label: string, type: string): WorkbenchNode => ({ id: JSON.stringify(['g', 'entity', id]), label, type, raw: {} })
const literal = (value: string, type: string): WorkbenchNode => ({ id: JSON.stringify(['g', 'literal', `${type}:"${value}"`]), label: value, type, raw: {} })
const edge = (id: string, source: WorkbenchNode, predicate: string, target: WorkbenchNode): WorkbenchEdge => ({ id, source: source.id, target: target.id, label: predicate, raw: {} })

const ada = entity('ada', 'Ada', 'Person')
const bob = entity('bob', 'Bob', 'Person')
const contoso = entity('contoso', 'Contoso', 'Organization')
const seattle = entity('seattle', 'Seattle', 'Place')
const graph: WorkbenchGraph = {
  nodes: [ada, bob, contoso, seattle, literal('engineer', 'string')],
  edges: [
    edge('1', ada, 'worksFor', contoso),
    edge('2', bob, 'worksFor', contoso),
    edge('3', contoso, 'locatedIn', seattle),
    edge('4', ada, 'title', literal('engineer', 'string')),
  ],
}

describe('buildGqlVocabulary', () => {
  it('counts node types, predicates and entity-to-entity patterns without treating literal values as nodes', () => {
    const vocabulary = buildGqlVocabulary(graph, true)
    expect(vocabulary.loaded).toBe(true)
    expect(vocabulary.nodeTypes).toEqual([{ name: 'Person', count: 2 }, { name: 'Organization', count: 1 }, { name: 'Place', count: 1 }])
    expect(vocabulary.predicates).toEqual([{ name: 'worksFor', count: 2 }, { name: 'locatedIn', count: 1 }, { name: 'title', count: 1 }])
    expect(vocabulary.patterns.map((pattern) => [pattern.subjectType, pattern.predicate, pattern.objectType, pattern.count]))
      .toEqual([['Person', 'worksFor', 'Organization', 2], ['Organization', 'locatedIn', 'Place', 1]])
    expect(vocabulary.entities[0]).toMatchObject({ name: 'Contoso', degree: 3, outDegree: 1 })
    expect(vocabulary.entities.some((item) => item.name === 'engineer')).toBe(false)
  })
})

describe('GQL quoting', () => {
  it('quotes names that are not plain identifiers and refuses values that cannot be written safely', () => {
    expect(gqlIdentifier('Person')).toBe('Person')
    expect(gqlIdentifier('人物')).toBe('`人物`')
    expect(gqlIdentifier('Match')).toBe('`Match`')
    expect(gqlIdentifier('a`b')).toBeNull()
    expect(gqlString('Ada')).toBe("'Ada'")
    expect(gqlString("O'Brien")).toBeNull()
    expect(gqlString('line\nbreak')).toBeNull()
    expect(formatGqlMessage('{a} and {b}', { a: 'x' })).toBe('x and {b}')
  })
})

describe('buildGqlTemplates', () => {
  it('builds templates from the loaded graph and falls back to marked sample values without one', () => {
    const templates = buildGqlTemplates(buildGqlVocabulary(graph, true))
    const byId = Object.fromEntries(templates.map((template) => [template.id, template]))
    expect(byId.typedRelation).toMatchObject({ sample: false, level: 1 })
    expect(byId.typedRelation.gql).toBe([
      'MATCH (a:Person)-[r]->(b:Organization)',
      "WHERE r.predicate = 'worksFor'",
      'RETURN a.name AS subject, r.predicate AS predicate, b.name AS object',
      'ORDER BY subject, object',
      'LIMIT 25',
    ].join('\n'))
    expect(byId.sharedNeighbor.gql).toContain('(a:Person)-[:worksFor]->(n:Organization)<-[:worksFor]-(b:Person)')
    expect(byId.twoHop.gql).toContain("first.predicate = 'worksFor' AND second.predicate = 'locatedIn'")
    expect(byId.evidence).toMatchObject({ provenance: 'hydrate', sample: false })
    expect(templates.some((template) => template.group === 'topic')).toBe(false)

    const sample = buildGqlTemplates(EMPTY_GQL_VOCABULARY)
    expect(sample.filter((template) => template.group === 'general').every((template) => template.sample)).toBe(true)
    expect(sample.find((template) => template.id === 'typedRelation')?.gql).toContain('(a:Person)-[r]->(b:Organization)')
  })

  it('uses ids provenance without a provenance index and adds topic templates only for topic predicates', () => {
    const root = entity('root', 'Root', 'Graph')
    const topic = entity('t1', 'Billing', 'Topic')
    const child = entity('t2', 'Invoices', 'Topic')
    const topicGraph: WorkbenchGraph = {
      nodes: [root, topic, child],
      edges: [edge('1', root, 'HasRootTopic', topic), edge('2', topic, 'HasSubTopic', child)],
    }
    const templates = buildGqlTemplates(buildGqlVocabulary(topicGraph, false))
    expect(templates.find((template) => template.id === 'evidence')?.provenance).toBe('ids')
    expect(templates.filter((template) => template.group === 'topic').map((template) => template.id))
      .toEqual(['topicRoots', 'topicHierarchy', 'topicCounts'])
  })

  it('skips names that cannot be quoted safely', () => {
    const risky = entity('risky', "O'Brien", 'Person')
    const templates = buildGqlTemplates(buildGqlVocabulary({ nodes: [risky, contoso], edges: [edge('1', risky, 'worksFor', contoso)] }, false))
    expect(templates.find((template) => template.id === 'fromName')?.sample).toBe(true)
    expect(templates.find((template) => template.id === 'evidence')?.sample).toBe(true)
    expect(templates.every((template) => !template.gql.includes("O'Brien"))).toBe(true)
  })
})

describe('buildGqlFromBuilder', () => {
  const base = { startType: '', predicate: '', endType: '', startName: '', endName: '', includeIds: false, orderByName: true, limit: 25 }

  it('generates a triple query from the chosen conditions', () => {
    expect(buildGqlFromBuilder({ ...base, startType: 'Person', predicate: 'worksFor', startName: 'Ada', includeIds: true })).toEqual({
      ok: true,
      constrained: true,
      gql: [
        'MATCH (a:Person)-[r]->(b)',
        "WHERE r.predicate = 'worksFor' AND a.name = 'Ada'",
        'RETURN a.name AS subject, r.predicate AS predicate, b.name AS object, a.id AS subject_id, b.id AS object_id',
        'ORDER BY subject, object',
        'LIMIT 25',
      ].join('\n'),
    })
  })

  it('flags unconstrained queries and rejects unsafe text or invalid limits', () => {
    expect(buildGqlFromBuilder(base)).toMatchObject({ ok: true, constrained: false })
    expect(buildGqlFromBuilder({ ...base, startName: "O'Brien" })).toEqual({ ok: false, error: 'unsafeText' })
    expect(buildGqlFromBuilder({ ...base, limit: 0 })).toEqual({ ok: false, error: 'limit' })
    expect(buildGqlFromBuilder({ ...base, limit: 1001 })).toEqual({ ok: false, error: 'limit' })
  })
})
