import { describe, expect, it } from 'vitest'

import {
  GRAPH_ROLE_COUNT,
  addTopicGraphProfile,
  applyGraphIndexTemplate,
  collectVectorFieldLinks,
  countMappedGraphRoles,
  enableRequiredGraphAttributes,
  findNovemberIndexFeatures,
  findUnsupportedNovemberIndexFeatures,
  getTopicGraphProfiles,
  readGraphProfile,
  removeTopicGraphProfile,
  setFieldTopicGraphProfile,
  setGraphRoleField,
  suggestGraphFieldMappings,
  updateTopicGraphProfile,
  validateGraphProfile,
  validateTopicGraphProfiles,
  type GraphIssue,
} from './indexGraphProfiles'

type Index = Record<string, unknown>

const codes = (issues: GraphIssue[]) => issues.map((issue) => issue.code)

function chunkIndex(): Index {
  return {
    name: 'docs',
    fields: [
      { name: 'id', type: 'Edm.String', key: true },
      { name: 'content', type: 'Edm.String', searchable: true },
      { name: 'embedding', type: 'Collection(Edm.Single)', dimensions: 1536, vectorSearchProfile: 'vp' },
      { name: 'embedding2', type: 'Collection(Edm.Single)', dimensions: 1536, vectorSearchProfile: 'vp' },
    ],
    vectorSearch: {
      profiles: [{ name: 'vp', algorithm: 'hnsw', vectorizer: 'vz' }],
      algorithms: [{ name: 'hnsw', kind: 'hnsw' }],
      vectorizers: [{ name: 'vz', kind: 'azureOpenAI' }],
    },
  }
}

describe('lib/indexGraphProfiles graphProfile', () => {
  it('builds a valid edge-list graph index from the template', () => {
    const next = applyGraphIndexTemplate({ name: 'people-graph', fields: [] })

    expect(readGraphProfile(next).kind).toBe('edgeList')
    expect(countMappedGraphRoles(next)).toBe(GRAPH_ROLE_COUNT)
    expect((next.fields as unknown[]).length).toBe(GRAPH_ROLE_COUNT)
    expect(validateGraphProfile(next)).toEqual([])
    expect((next.fields as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'id', key: true, filterable: true, sortable: true })
  })

  it('reuses the existing key field and keeps existing mappings and unrelated properties', () => {
    const index: Index = {
      name: 'g',
      description: 'keep me',
      fields: [{ name: 'edge_key', type: 'Edm.String', key: true }, { name: 'subject', type: 'Edm.String' }],
      graphProfile: { kind: 'edgeList', fields: { subjectField: 'subject' }, provenanceIndexName: 'chunks' },
    }

    const next = applyGraphIndexTemplate(index)
    const profile = readGraphProfile(next)

    expect(profile.mappings.assertionIdField).toBe('edge_key')
    expect(profile.mappings.subjectField).toBe('subject')
    expect(profile.provenanceIndexName).toBe('chunks')
    expect(next.description).toBe('keep me')
    expect((next.fields as Array<{ name: string }>).filter((field) => field.name === 'subject')).toHaveLength(1)
    expect((next.fields as Array<{ key?: boolean }>).filter((field) => field.key === true)).toHaveLength(1)
  })

  it('does not report anything for an ordinary document index', () => {
    expect(validateGraphProfile(chunkIndex())).toEqual([])
  })

  it('reports unmapped roles, unknown fields, wrong types and disabled attributes', () => {
    const index: Index = {
      name: 'g',
      fields: [
        { name: 'id', type: 'Edm.String', key: true },
        { name: 'subject', type: 'Edm.String', filterable: false },
        { name: 'score', type: 'Edm.String' },
      ],
      graphProfile: {
        kind: 'edgeList',
        fields: { assertionIdField: 'id', subjectField: 'subject', confidenceField: 'score', predicateField: 'missing' },
      },
    }

    const issues = validateGraphProfile(index)

    expect(codes(issues)).toContain('graphAttributesDisabled')
    expect(issues.find((issue) => issue.code === 'graphTypeMismatch')?.params).toMatchObject({ role: 'confidenceField', expected: 'Edm.Double', actual: 'Edm.String' })
    expect(issues.find((issue) => issue.code === 'graphFieldNotFound')?.params).toMatchObject({ role: 'predicateField', field: 'missing' })
    expect(issues.filter((issue) => issue.code === 'graphRoleUnmapped').length).toBe(GRAPH_ROLE_COUNT - 4)
  })

  it('requires the assertion ID to be the key, retrievable fields and no normalizer', () => {
    const complete = applyGraphIndexTemplate({ name: 'g', fields: [] })
    const fields = (complete.fields as Array<Record<string, unknown>>).map((field) => {
      if (field.name === 'id') return { ...field, key: false }
      if (field.name === 'subject') return { ...field, retrievable: false }
      if (field.name === 'predicate') return { ...field, normalizer: 'lowercase' }
      return field
    })

    const issues = validateGraphProfile({ ...complete, fields })

    expect(codes(issues)).toEqual(expect.arrayContaining(['graphAssertionNotKey', 'graphNotRetrievable', 'graphNormalizer']))
  })

  it('allows assertion and fact IDs to share a field but not other roles', () => {
    const complete = applyGraphIndexTemplate({ name: 'g', fields: [] })
    const shared = setGraphRoleField(complete, 'factIdField', 'id')
    expect(codes(validateGraphProfile(shared))).not.toContain('graphDuplicateField')

    const duplicated = setGraphRoleField(complete, 'objectField', 'subject')
    expect(validateGraphProfile(duplicated).find((issue) => issue.code === 'graphDuplicateField')?.params.field).toBe('subject')
  })

  it('warns about an unknown provenance index only when index names are known', () => {
    const index = applyGraphIndexTemplate({ name: 'g', fields: [] })
    const withProvenance = { ...index, graphProfile: { ...(index.graphProfile as Index), provenanceIndexName: 'chunks' } }

    expect(codes(validateGraphProfile(withProvenance))).not.toContain('graphProvenanceUnknown')
    expect(codes(validateGraphProfile(withProvenance, { indexNames: ['other'] }))).toContain('graphProvenanceUnknown')
    expect(codes(validateGraphProfile(withProvenance, { indexNames: ['chunks'] }))).not.toContain('graphProvenanceUnknown')
  })

  it('maps unassigned roles by field name in snake_case or camelCase', () => {
    const index: Index = {
      name: 'g',
      fields: [
        { name: 'id', type: 'Edm.String', key: true },
        { name: 'subjectId', type: 'Edm.String' },
        { name: 'object_double', type: 'Edm.Double' },
        { name: 'subject', type: 'Edm.Int32' },
      ],
    }

    const mapped = readGraphProfile(suggestGraphFieldMappings(index)).mappings

    expect(mapped).toEqual({ assertionIdField: 'id', subjectIdField: 'subjectId', objectDoubleField: 'object_double' })
  })

  it('enables the attributes that mapped fields require', () => {
    const complete = applyGraphIndexTemplate({ name: 'g', fields: [] })
    const broken = {
      ...complete,
      fields: (complete.fields as Array<Record<string, unknown>>).map((field) => (
        field.name === 'subject_id' ? { ...field, filterable: false, sortable: false, retrievable: false } : field
      )),
    }
    expect(validateGraphProfile(broken).length).toBeGreaterThan(0)

    expect(validateGraphProfile(enableRequiredGraphAttributes(broken))).toEqual([])
  })

  it('never moves the key to another field when enabling required attributes', () => {
    const index: Index = {
      name: 'g',
      fields: [{ name: 'edge_key', type: 'Edm.String', key: true }, { name: 'id', type: 'Edm.String' }],
      graphProfile: { kind: 'edgeList', fields: { assertionIdField: 'id' } },
    }

    const fields = enableRequiredGraphAttributes(index).fields as Array<{ name: string; key?: boolean }>

    expect(fields.filter((field) => field.key === true).map((field) => field.name)).toEqual(['edge_key'])
  })

  it('does not mutate its input', () => {
    const index: Index = { name: 'g', fields: [] }
    const snapshot = JSON.stringify(index)
    applyGraphIndexTemplate(index)
    suggestGraphFieldMappings(index)
    expect(JSON.stringify(index)).toBe(snapshot)
  })
})

describe('lib/indexGraphProfiles topicGraphProfiles', () => {
  it('adds a profile linked to the first unlinked vector field', () => {
    const index = chunkIndex()
    const links = collectVectorFieldLinks(index)
    expect(links.map((link) => link.path)).toEqual(['embedding', 'embedding2'])

    const next = addTopicGraphProfile(index, links[0].pathParts)

    expect(getTopicGraphProfiles(next)).toEqual([{ name: 'embedding-topics', defaultKind: 'balanced' }])
    expect(collectVectorFieldLinks(next)[0].topicGraphProfile).toBe('embedding-topics')
    expect(collectVectorFieldLinks(next)[1].topicGraphProfile).toBe('')
    expect((next.vectorSearch as Index).profiles).toEqual((index.vectorSearch as Index).profiles)
  })

  it('validates required properties, kinds and numeric ranges', () => {
    const index = chunkIndex()
    ;(index.vectorSearch as Index).topicGraphProfiles = [
      { name: 'a', defaultKind: 'none', defaultDiversityFactor: 0.5, defaultMinDiversityPoolSize: 500 },
      { name: 'b', indexName: 'topics', defaultKind: 'balanced', defaultDiversityFactor: 0.5, defaultMinDiversityPoolSize: 100 },
      { name: 'c', indexName: 'topics', defaultKind: 'diverse', defaultDiversityFactor: 1.5, defaultMinDiversityPoolSize: 10000 },
      { name: 'd', indexName: 'topics', defaultKind: 'weird' },
      { name: 'd', indexName: 'topics' },
    ]

    const issues = codes(validateTopicGraphProfiles(index))

    expect(issues).toEqual(expect.arrayContaining([
      'topicIndexMissing',
      'topicDiversityNotAllowed',
      'topicPoolNotAllowed',
      'topicPoolRange',
      'topicDiversityRange',
      'topicKindInvalid',
      'topicKindMissing',
      'topicNameDuplicate',
    ]))
  })

  it('accepts the boundary values of the documented ranges', () => {
    const index = chunkIndex()
    ;(index.vectorSearch as Index).topicGraphProfiles = [
      { name: 'low', indexName: 't', defaultKind: 'diverse', defaultDiversityFactor: 0, defaultMinDiversityPoolSize: 250 },
      { name: 'high', indexName: 't', defaultKind: 'diverse', defaultDiversityFactor: 1, defaultMinDiversityPoolSize: 10000 },
    ]
    index.fields = (index.fields as Array<Record<string, unknown>>).map((field) => (
      field.name === 'embedding' ? { ...field, topicGraphProfile: 'low' } : field.name === 'embedding2' ? { ...field, topicGraphProfile: 'high' } : field
    ))

    expect(validateTopicGraphProfiles(index)).toEqual([])
  })

  it('checks field links against the defined profiles and the vector profile', () => {
    const index = chunkIndex()
    ;(index.vectorSearch as Index).topicGraphProfiles = [{ name: 'topics', indexName: 't', defaultKind: 'balanced' }, { name: 'unused', indexName: 't', defaultKind: 'none' }]
    index.fields = (index.fields as Array<Record<string, unknown>>).map((field) => {
      if (field.name === 'content') return { ...field, topicGraphProfile: 'topics' }
      if (field.name === 'embedding') return { ...field, topicGraphProfile: 'missing' }
      if (field.name === 'embedding2') return { ...field, topicGraphProfile: 'topics', vectorSearchProfile: 'no-vectorizer' }
      return field
    })

    const issues = validateTopicGraphProfiles(index)

    expect(codes(issues)).toEqual(expect.arrayContaining(['topicFieldNotVector', 'topicFieldUnknownProfile', 'topicNoVectorizer', 'topicProfileUnused']))
  })

  it('warns when the topic index is not on the service, excluding the index itself', () => {
    const index = chunkIndex()
    ;(index.vectorSearch as Index).topicGraphProfiles = [{ name: 'topics', indexName: 'docs', defaultKind: 'balanced' }]

    expect(codes(validateTopicGraphProfiles(index, { indexNames: ['docs', 'other'], ownIndexName: 'docs' }))).toContain('topicIndexUnknown')
    expect(codes(validateTopicGraphProfiles(index))).not.toContain('topicIndexUnknown')
  })

  it('drops properties that the selected kind does not allow', () => {
    let index = addTopicGraphProfile(chunkIndex())
    index = updateTopicGraphProfile(index, 0, { defaultKind: 'diverse', defaultDiversityFactor: 0.3, defaultMinDiversityPoolSize: 400 })
    expect(getTopicGraphProfiles(index)[0]).toMatchObject({ defaultKind: 'diverse', defaultDiversityFactor: 0.3, defaultMinDiversityPoolSize: 400 })

    index = updateTopicGraphProfile(index, 0, { defaultKind: 'balanced' })
    expect(getTopicGraphProfiles(index)[0]).toEqual({ name: 'topic-graph', defaultKind: 'balanced', defaultMinDiversityPoolSize: 400 })

    index = updateTopicGraphProfile(index, 0, { defaultKind: 'none' })
    expect(getTopicGraphProfiles(index)[0]).toEqual({ name: 'topic-graph', defaultKind: 'none' })
  })

  it('keeps field links in step when a profile is renamed or removed', () => {
    const first = collectVectorFieldLinks(chunkIndex())[0].pathParts
    let index = addTopicGraphProfile(chunkIndex(), first)

    index = updateTopicGraphProfile(index, 0, { name: 'renamed' })
    expect(collectVectorFieldLinks(index)[0].topicGraphProfile).toBe('renamed')
    expect(getTopicGraphProfiles(index)[0].name).toBe('renamed')

    index = removeTopicGraphProfile(index, 0)
    expect(getTopicGraphProfiles(index)).toEqual([])
    expect(collectVectorFieldLinks(index)[0].topicGraphProfile).toBe('')
    expect(index.fields).toEqual(chunkIndex().fields)
  })

  it('links and unlinks nested vector fields by path', () => {
    const index: Index = {
      name: 'nested',
      fields: [{ name: 'parent', type: 'Collection(Edm.ComplexType)', fields: [{ name: 'vec', type: 'Collection(Edm.Single)', dimensions: 8 }] }],
    }

    const linked = setFieldTopicGraphProfile(index, ['parent', 'vec'], 'topics')
    expect(collectVectorFieldLinks(linked)).toMatchObject([{ path: 'parent.vec', topicGraphProfile: 'topics' }])

    expect(setFieldTopicGraphProfile(linked, ['parent', 'vec'], '')).toEqual(index)
  })
})

describe('lib/indexGraphProfiles API version support', () => {
  it('detects properties that only exist in 2026-11-01-preview', () => {
    const index: Index = {
      name: 'x',
      graphProfile: { kind: 'edgeList', fields: {} },
      oneLakeSecuritySource: { fabricWorkspaceId: 'a', lakehouseId: 'b' },
      fields: [{ name: 'v', type: 'Collection(Edm.Single)', topicGraphProfile: 't' }, { name: 'p', type: 'Edm.String', permissionFilter: 'oneLakeParentFolders' }],
      vectorSearch: { topicGraphProfiles: [{ name: 't' }], vectorizers: [{ name: 'oai', kind: 'openAICompatible' }] },
      scoringProfiles: [{ name: 's', functions: [{ type: 'random' }] }],
    }

    expect(findNovemberIndexFeatures(index)).toEqual([
      'graphProfile',
      'vectorSearch.topicGraphProfiles',
      'vectorSearch.vectorizers[openAICompatible]',
      'oneLakeSecuritySource',
      'scoringProfiles[].functions[random]',
      'fields[].topicGraphProfile',
      'fields[].permissionFilter[oneLake]',
    ])
    expect(findNovemberIndexFeatures(chunkIndex())).toEqual([])
  })

  it('blocks only known older API versions', () => {
    const index: Index = { name: 'x', graphProfile: { kind: 'edgeList', fields: {} } }

    expect(findUnsupportedNovemberIndexFeatures(index, '2026-08-01-preview')).toEqual(['graphProfile'])
    expect(findUnsupportedNovemberIndexFeatures(index, '2026-10-01')).toEqual(['graphProfile'])
    expect(findUnsupportedNovemberIndexFeatures(index, '2026-11-01-preview')).toEqual([])
    expect(findUnsupportedNovemberIndexFeatures(index, '2027-02-01-preview')).toEqual([])
    expect(findUnsupportedNovemberIndexFeatures(index, 'custom')).toEqual([])
    expect(findUnsupportedNovemberIndexFeatures({ name: 'x', fields: [] }, '2026-08-01-preview')).toEqual([])
  })
})
