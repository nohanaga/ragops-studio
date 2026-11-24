import { describe, expect, it } from 'vitest'
import { EMPTY_GQL_VOCABULARY, type GqlVocabulary } from './gqlAssist'
import { analyzeGql, explainGql, getGqlCompletions } from './gqlSyntax'

const vocabulary: GqlVocabulary = {
  nodeTypes: [{ name: 'Person', count: 2 }, { name: 'Organization', count: 1 }],
  predicates: [{ name: 'worksFor', count: 2 }, { name: 'locatedIn', count: 1 }],
  patterns: [],
  entities: [{ name: 'Ada', type: 'Person', degree: 2, outDegree: 1 }, { name: "O'Brien", type: 'Person', degree: 1, outDegree: 1 }],
  hasProvenanceIndex: true,
  loaded: true,
}
const codes = (text: string, source: GqlVocabulary = vocabulary) => analyzeGql(text, source).map((item) => item.code)

describe('analyzeGql', () => {
  it('accepts a well-formed constrained query', () => {
    expect(codes("MATCH (a:Person)-[r]->(b) WHERE r.predicate = 'worksFor' RETURN a.name AS who LIMIT 5")).toEqual([])
    expect(codes('')).toEqual([])
  })

  it('reports structural mistakes before running', () => {
    expect(codes("MATCH (a:Person RETURN a.name WHERE a.name = 'x")).toContain('unterminatedString')
    expect(codes('MATCH (a:Person-[r]->(b) RETURN a.name LIMIT 5')).toContain('unbalanced')
    expect(codes('SELECT * FROM x')).toEqual(expect.arrayContaining(['missingMatch', 'missingReturn']))
    expect(codes('MATCH (a:Person) RETURN a.name')).toContain('missingLimit')
    expect(codes('MATCH (a)-[r]->(b) RETURN a.name LIMIT 5')).toContain('unconstrained')
  })

  it('catches full-width symbols and SQL-style operators outside string literals only', () => {
    const fullWidth = analyzeGql("MATCH (a:Person) WHERE a.name ＝ 'Ａｄａ（旧）' RETURN a.name LIMIT 5", vocabulary).find((item) => item.code === 'fullWidth')
    expect(fullWidth?.params.chars).toBe('＝')
    expect(codes("MATCH (a:Person) WHERE a.name = '（旧）' RETURN a.name LIMIT 5")).not.toContain('fullWidth')
    expect(analyzeGql("MATCH (a:Person) WHERE a.name == 'Ada' RETURN a.name LIMIT 5", vocabulary).find((item) => item.code === 'badOperator')?.params.op).toBe('==')
    expect(codes("MATCH (a:Person) WHERE a.name = '==' RETURN a.name LIMIT 5")).not.toContain('badOperator')
  })

  it('suggests the closest known label and ignores unknown labels when no graph is loaded', () => {
    const type = analyzeGql('MATCH (a:person)-[r]->(b) RETURN a.name LIMIT 5', vocabulary).find((item) => item.code === 'unknownNodeType')
    expect(type?.params).toEqual({ name: 'person', suggestion: 'Person' })
    const predicate = analyzeGql("MATCH (a)-[r]->(b) WHERE r.predicate = 'worksfor' RETURN a.name LIMIT 5", vocabulary).find((item) => item.code === 'unknownPredicate')
    expect(predicate?.params.suggestion).toBe('worksFor')
    expect(codes('MATCH (a:person)-[r]->(b) RETURN a.name LIMIT 5', EMPTY_GQL_VOCABULARY)).not.toContain('unknownNodeType')
  })

  it('asks for backticks around non-ASCII labels', () => {
    expect(analyzeGql('MATCH (a:人物)-[r]->(b) RETURN a.name LIMIT 5', vocabulary).find((item) => item.code === 'unquotedLabel')?.params.label).toBe('人物')
    expect(codes('MATCH (a:`人物`)-[r]->(b) RETURN a.name LIMIT 5')).not.toContain('unquotedLabel')
  })
})

describe('explainGql', () => {
  it('splits clauses outside brackets and describes the pattern, conditions and columns', () => {
    const explanation = explainGql("MATCH (a:Person)-[r:worksFor]->(b) WHERE r.predicate = 'worksFor' AND a.name = 'Ada' RETURN a.name AS who, count(*) AS total ORDER BY who DESC LIMIT 5")
    expect(explanation.clauses.map((clause) => clause.keyword)).toEqual(['MATCH', 'WHERE', 'RETURN', 'ORDER BY', 'LIMIT'])
    expect(explanation.clauses[0].pattern.map((element) => [element.kind, element.variable, element.label, element.direction]))
      .toEqual([['node', 'a', 'Person', 'any'], ['edge', 'r', 'worksFor', 'out'], ['node', 'b', '', 'any']])
    expect(explanation.clauses[1].items).toEqual([
      { code: 'wherePredicate', params: { variable: 'r', value: "'worksFor'" } },
      { code: 'whereName', params: { variable: 'a', value: "'Ada'" } },
    ])
    expect(explanation.clauses[2].items.map((item) => item.code)).toEqual(['returnColumn', 'returnAggregate'])
    expect(explanation.clauses[3].items).toEqual([{ code: 'orderDesc', params: { expr: 'who' } }])
    expect(explanation.clauses[4].items).toEqual([{ code: 'limit', params: { n: '5' } }])
  })

  it('does not split on keywords inside string literals, backticks or inline element filters', () => {
    const explanation = explainGql("MATCH (a:`Return Type` {name: 'where'})<-[e WHERE e.predicate = 'limit']-(b) RETURN a.name")
    expect(explanation.clauses.map((clause) => clause.keyword)).toEqual(['MATCH', 'RETURN'])
    expect(explanation.clauses[0].pattern.map((element) => [element.kind, element.label, element.direction])).toEqual([
      ['node', 'Return Type', 'any'], ['edge', '', 'in'], ['node', '', 'any'],
    ])
    expect(explanation.clauses[0].pattern[0].filter).toBe("{name: 'where'}")
  })

  it('keeps unexplainable text visible', () => {
    expect(explainGql('SELECT 1 MATCH (a) RETURN a.name').leading).toBe('SELECT 1')
  })
})

describe('getGqlCompletions', () => {
  const complete = (text: string, caret = text.length) => getGqlCompletions(text, caret, vocabulary)

  it('suggests node types inside parentheses and predicates inside brackets', () => {
    expect(complete('MATCH (a:')?.items.map((item) => item.label)).toEqual(['Person', 'Organization'])
    expect(complete('MATCH (a:Pe')).toMatchObject({ from: 9, to: 11, items: [{ label: 'Person', insertText: 'Person', kind: 'nodeType' }] })
    expect(complete('MATCH (a)-[r:work')?.items).toMatchObject([{ label: 'worksFor', kind: 'predicate' }])
  })

  it('suggests predicates and names inside string literals and closes the quote only when needed', () => {
    expect(complete("MATCH (a)-[r]->(b) WHERE r.predicate = 'wo")).toMatchObject({ from: 40, to: 42, items: [{ label: 'worksFor', insertText: "worksFor'" }] })
    const closed = "WHERE r.predicate = 'wo' RETURN"
    expect(complete(closed, 22)).toMatchObject({ items: [{ label: 'worksFor', insertText: 'worksFor' }], to: 23 })
    expect(complete("WHERE a.name = '")?.items.map((item) => item.label)).toEqual(['Ada'])
    expect(complete("WHERE a.name = 'x")).toBeNull()
  })

  it('suggests properties by variable kind', () => {
    expect(complete('MATCH (a)-[r]->(b) WHERE a.')?.items.map((item) => item.label)).toEqual(['name', 'id'])
    expect(complete('MATCH (a)-[r]->(b) WHERE r.')?.items.map((item) => item.label)).toEqual(['predicate'])
    expect(complete('MATCH (a)-[r]->(b) WHERE r.pre')).toMatchObject({ from: 27, to: 30, items: [{ label: 'predicate' }] })
  })

  it('suggests the next clause, keywords and column expressions while typing', () => {
    expect(complete('')?.items.map((item) => item.label)).toEqual(['MATCH'])
    expect(complete('MATCH (a)-[r]->(b) ')?.items.map((item) => item.label)).toEqual(['WHERE', 'RETURN'])
    expect(complete('MATCH (a)-[r]->(b) RETURN a.name ')?.items.map((item) => item.label)).toEqual(['ORDER BY', 'GROUP BY', 'LIMIT'])
    expect(complete('MATCH (a)-[r]->(b) RETURN a.name LIMIT 5 ')).toBeNull()
    expect(complete('MATCH (a)-[r]->(b) RE')?.items.map((item) => item.label)).toEqual(['RETURN'])
    expect(complete('MATCH (a)-[r]->(b) RETURN ')?.items.map((item) => item.label)).toEqual(['a.name', 'a.id', 'r.predicate', 'b.name', 'b.id', 'count(*)'])
    expect(complete('MATCH (a)-[r]->(b) RETURN a.name AS su')).toBeNull()
    expect(complete('MATCH (ma')).toBeNull()
  })
})
