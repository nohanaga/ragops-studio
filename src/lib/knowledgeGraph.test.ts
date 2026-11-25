import { describe, expect, it } from 'vitest'
import type { JsonObject } from '../app/json'
import { buildGraphDocumentBatch, buildGraphResultView, buildGraphStarterQuery, buildKnowledgeGraph, buildOntologySourceUpdate, buildTopicTitleRows, classifyGraphIndexes, getManagedGraphOwner, parseOntology } from './knowledgeGraph'

const definition = {
  fields: ['id', 'subject', 'sid', 'stype', 'predicate', 'object', 'oid', 'otype', 'graph', 'extra'].map((name) => ({ name, key: name === 'id' })),
  graphProfile: { fields: {
    assertionIdField: 'id', subjectField: 'subject', subjectIdField: 'sid', subjectTypeField: 'stype',
    predicateField: 'predicate', objectField: 'object', objectIdField: 'oid', objectTypeField: 'otype', graphNameField: 'graph',
  } },
}
const edge = { id: 'one', subject: 'A', sid: 'a', stype: 'Person', predicate: 'knows', object: 'B', oid: 'b', otype: 'Person', graph: 'g' }
const ontology = {
  '@context': { o: 'http://www.w3.org/2002/07/owl#', r: 'http://www.w3.org/2000/01/rdf-schema#', ex: 'https://example.org/' },
  '@graph': [
    { '@id': 'ex:A', '@type': 'o:Class', 'r:label': 'A' },
    { '@id': 'ex:B', '@type': 'o:Class' },
    { '@id': 'ex:rel', '@type': 'o:ObjectProperty', 'r:domain': { '@id': 'ex:A' }, 'r:range': { '@id': 'ex:B' } },
  ],
}

describe('knowledge graph editing', () => {
  it('lists actual topic titles without merging IDs across graphs or including hierarchy assertions', () => {
    const title = { ...edge, predicate: 'title', object: 'Topic title', oid: '', otype: 'String' }
    expect(buildTopicTitleRows(definition, [title, { ...title, id: 'duplicate' }, { ...title, id: 'other', graph: 'other' }, edge], 'title')).toEqual([
      { title: 'Topic title', id: 'a', graph: 'g' }, { title: 'Topic title', id: 'a', graph: 'other' },
    ])
    expect(buildTopicTitleRows(definition, [{ ...title, predicate: 'topicTitle' }], 'topicTitle')).toHaveLength(1)
    expect(() => buildTopicTitleRows(definition, [{ ...title, object: 0 }], 'title')).toThrow('title values')
  })

  it('classifies graph resources from bindings without guessing from index names', () => {
    const indexes: JsonObject[] = [
      { name: 'entity-index', ...definition },
      { name: 'topic-index', ...definition },
      { name: 'topic-looking-name', ...definition },
      { name: 'content', vectorSearch: { topicGraphProfiles: [{ name: 'topics', indexName: 'topic-index' }] } },
    ]
    const sources = [{ name: 'source', kind: 'azureBlob', azureBlobParameters: { createdResources: { graphIndex: 'entity-index' } } }]
    expect(classifyGraphIndexes(indexes, sources).map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: 'entity-index', kind: 'entity' }, { name: 'topic-index', kind: 'topic' }, { name: 'topic-looking-name', kind: 'unclassified' },
    ])
  })

  it('reconstructs query paths using assertion IDs, not projected display names', () => {
    const response = { value: [{
      person: 'A', city: 'C',
      '@search.graphProvenance': { evidence: [{ edgeId: 'one' }, { edgeId: 'two' }] },
    }] }
    const view = buildGraphResultView(response, definition, [edge, { ...edge, id: 'two', subject: 'B', sid: 'b', object: 'C', oid: 'c', predicate: 'locatedIn' }])
    expect(view.representation).toBe('evidence')
    expect(view.graph.nodes).toHaveLength(3)
    expect(view.graph.edges).toHaveLength(2)
    expect(view.missingEvidence).toBe(0)
  })

  it('keeps row-only bindings distinct and does not invent graphs for aggregate results', () => {
    const view = buildGraphResultView({ value: [
      { subject: 'Same name', predicate: 'knows', object: 'B' },
      { subject: 'Same name', predicate: 'knows', object: 'C' },
    ] }, null, [])
    expect(view.representation).toBe('projection')
    expect(view.graph.nodes).toHaveLength(4)
    expect(view.graph.edges[0].source).not.toBe(view.graph.edges[1].source)
    const aggregate = buildGraphResultView({ value: [{ total: 2 }] }, null, [])
    expect(aggregate.graph.edges).toHaveLength(0)
    expect(aggregate.rows).toEqual([{ total: 2 }])
  })

  it('generates a scoped starter from actual predicate labels without inventing queries for empty graphs', () => {
    const predicate = 'https://example.org/worksFor'
    const graph = buildKnowledgeGraph(definition, [{ ...edge, predicate }])
    expect(buildGraphStarterQuery(graph)).toBe(`MATCH (a)-[r:\`${predicate}\`]->(b) RETURN a.name AS subject, r.predicate AS predicate, b.name AS object LIMIT 25`)
    expect(buildGraphStarterQuery({ nodes: [], edges: [] })).toBe('')
    for (const predicate of ['bad`label', 'bad\\label', 'bad\u0000label', 'bad\nlabel', 'bad\u007flabel']) {
      expect(() => buildGraphStarterQuery(buildKnowledgeGraph(definition, [{ ...edge, predicate }]))).toThrow('safely')
    }
  })

  it('preserves directed parallel assertions and scopes canonical IDs by graph, not display names', () => {
    const graph = buildKnowledgeGraph(definition, [
      edge, { ...edge, id: 'two', sid: 'b', oid: 'a', predicate: 'manages' },
      { ...edge, id: 'three', predicate: 'worksWith' },
      { ...edge, id: 'four', graph: 'other' },
    ])
    expect(graph.nodes).toHaveLength(4)
    expect(graph.edges).toHaveLength(4)
    expect(graph.edges[0].source).toBe(graph.edges[1].target)
    expect(graph.edges[0].target).toBe(graph.edges[1].source)
    expect(graph.edges[0].id).not.toBe(graph.edges[2].id)
  })

  it('keeps false and zero literal values distinct', () => {
    const graph = buildKnowledgeGraph(definition, [
      { ...edge, object: false, oid: '', otype: 'Boolean' },
      { ...edge, id: 'two', object: 0, oid: '', otype: 'Double' },
    ])
    expect(graph.nodes.map((node) => node.label)).toEqual(['A', 'false', '0'])
  })

  it('sends only changed documents, preserves fields and emits key-only deletes', () => {
    const batch = buildGraphDocumentBatch(definition, [edge, { ...edge, id: 'deleted' }], [
      { ...edge, predicate: 'worksWith', extra: 'keep', '@search.score': 2 },
    ])
    expect(batch.value).toEqual([
      { ...edge, predicate: 'worksWith', extra: 'keep', '@search.action': 'mergeOrUpload' },
      { '@search.action': 'delete', id: 'deleted' },
    ])
    expect(() => buildGraphDocumentBatch(definition, [edge], [{ ...edge, unexpected: 'value' }])).toThrow('Unknown index field')
  })

  it('detects generated graph ownership regardless of source kind', () => {
    expect(getManagedGraphOwner([{ name: 'source', azureBlobParameters: { createdResources: { graphIndex: 'graph' } } }], 'graph')).toBe('source')
    expect(getManagedGraphOwner([], 'graph')).toBeUndefined()
  })
})

describe('ontology editing', () => {
  it('resolves context aliases and rejects deleting a referenced type or duplicate canonical IDs', () => {
    const parsed = parseOntology(JSON.stringify(ontology))
    expect(parsed.graph.edges[0].source).toBe('https://example.org/A')
    expect(parsed.graph.edges[0].target).toBe('https://example.org/B')
    expect(() => parseOntology(JSON.stringify({ ...ontology, '@graph': ontology['@graph'].slice(1) }))).toThrow('existing class')
    expect(() => parseOntology(JSON.stringify({ ...ontology, '@graph': [...ontology['@graph'], { '@id': 'https://example.org/A', '@type': 'o:Class' }] }))).toThrow('Duplicate')
  })

  it('requires reprocessing cache and preserves source settings while stripping read-only resources', () => {
    const source = {
      name: 'source', kind: 'azureBlob', description: 'keep', '@odata.etag': 'etag',
      azureBlobParameters: {
        containerName: 'content', createdResources: { graphIndex: 'graph' },
        ingestionParameters: { cache: { enableReprocessing: true }, custom: 'keep' },
        graphExtraction: { graphName: 'g' },
      },
    }
    const updated = buildOntologySourceUpdate(source, JSON.stringify(ontology))
    expect(updated.description).toBe('keep')
    expect(updated).not.toHaveProperty('@odata.etag')
    expect(updated.azureBlobParameters).not.toHaveProperty('createdResources')
    expect(updated.azureBlobParameters).toMatchObject({ containerName: 'content', ingestionParameters: source.azureBlobParameters.ingestionParameters })
    expect(() => buildOntologySourceUpdate({ ...source, azureBlobParameters: { ...source.azureBlobParameters, ingestionParameters: {} } }, JSON.stringify(ontology))).toThrow('enableReprocessing')
  })
})
