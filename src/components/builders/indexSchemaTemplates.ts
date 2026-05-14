export type IndexSchemaTemplateKind = 'semantic' | 'suggester' | 'scoringProfile' | 'cors' | 'vectorSearch'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>
}

function uniqueName(existingNames: string[], baseName: string): string {
  if (!existingNames.includes(baseName)) return baseName
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${baseName}-${suffix}`
    if (!existingNames.includes(candidate)) return candidate
  }
  return `${baseName}-${Date.now()}`
}

function isVectorFieldType(type: string): boolean {
  return [
    'Collection(Edm.Single)',
    'Collection(Edm.Half)',
    'Collection(Edm.Int16)',
    'Collection(Edm.SByte)',
    'Collection(Edm.Byte)',
  ].includes(type)
}

function getVectorSearchSection(index: Record<string, unknown>): Record<string, unknown> {
  return isRecord(index.vectorSearch) ? index.vectorSearch : {}
}

function getFieldRecords(index: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(index.fields).filter(isRecord)
}

function getTextFields(index: Record<string, unknown>): Record<string, unknown>[] {
  return getFieldRecords(index).filter((field) => {
    const type = asString(field.type)
    return (type === 'Edm.String' || type === 'Collection(Edm.String)') && field.searchable !== false
  })
}

function getFieldName(field: Record<string, unknown>): string {
  return asString(field.name)
}

function updateVectorFieldProfiles(fields: unknown, profileName: string): unknown {
  return asArray(fields).map((fieldValue) => {
    if (!isRecord(fieldValue)) return fieldValue
    const nextField: Record<string, unknown> = { ...fieldValue }
    const type = asString(nextField.type)
    const isVector = isVectorFieldType(type) || !!nextField.dimensions || !!nextField.vectorSearchProfile
    if (isVector && !nextField.vectorSearchProfile) nextField.vectorSearchProfile = profileName
    if (Array.isArray(nextField.fields)) nextField.fields = updateVectorFieldProfiles(nextField.fields, profileName)
    return nextField
  })
}

export function applyIndexSchemaTemplate(index: Record<string, unknown>, kind: IndexSchemaTemplateKind): Record<string, unknown> {
  const next = cloneRecord(index)
  const textFields = getTextFields(next)
  const textFieldNames = textFields.map(getFieldName).filter(Boolean)

  if (kind === 'semantic') {
    const semantic = isRecord(next.semantic) ? { ...next.semantic } : {}
    const configurations = asArray(semantic.configurations).filter(isRecord)
    const configName = uniqueName(configurations.map((configuration) => asString(configuration.name)).filter(Boolean), 'default')
    const titleFieldName = textFieldNames.find((name) => /title|name|heading/i.test(name)) ?? textFieldNames[0] ?? ''
    const contentFieldNames = textFieldNames.filter((name) => name !== titleFieldName).slice(0, 5)
    const keywordFieldNames = textFieldNames.filter((name) => /keyword|tag|category|facet/i.test(name)).slice(0, 3)
    const prioritizedFields: Record<string, unknown> = {}
    if (titleFieldName) prioritizedFields.titleField = { fieldName: titleFieldName }
    if (contentFieldNames.length > 0) prioritizedFields.prioritizedContentFields = contentFieldNames.map((fieldName) => ({ fieldName }))
    if (keywordFieldNames.length > 0) prioritizedFields.prioritizedKeywordsFields = keywordFieldNames.map((fieldName) => ({ fieldName }))
    semantic.configurations = [...configurations, { name: configName, prioritizedFields }]
    next.semantic = semantic
    return next
  }

  if (kind === 'suggester') {
    const suggesters = asArray(next.suggesters).filter(isRecord)
    const suggesterName = uniqueName(suggesters.map((suggester) => asString(suggester.name)).filter(Boolean), 'sg')
    next.suggesters = [
      ...suggesters,
      {
        name: suggesterName,
        searchMode: 'analyzingInfixMatching',
        sourceFields: textFieldNames.slice(0, 3),
      },
    ]
    return next
  }

  if (kind === 'scoringProfile') {
    const scoringProfiles = asArray(next.scoringProfiles).filter(isRecord)
    const profileName = uniqueName(scoringProfiles.map((profile) => asString(profile.name)).filter(Boolean), 'text-boost')
    const firstTextField = textFieldNames[0]
    next.scoringProfiles = [
      ...scoringProfiles,
      {
        name: profileName,
        text: { weights: firstTextField ? { [firstTextField]: 2 } : {} },
        functions: [],
      },
    ]
    return next
  }

  if (kind === 'cors') {
    next.corsOptions = { allowedOrigins: ['*'], maxAgeInSeconds: 300 }
    return next
  }

  const vectorSearch = getVectorSearchSection(next)
  const algorithms = asArray(vectorSearch.algorithms).filter(isRecord)
  const profiles = asArray(vectorSearch.profiles).filter(isRecord)
  const algorithmName = uniqueName(algorithms.map((algorithm) => asString(algorithm.name)).filter(Boolean), 'hnsw-config')
  const profileName = uniqueName(profiles.map((profile) => asString(profile.name)).filter(Boolean), 'vector-profile')
  next.vectorSearch = {
    ...vectorSearch,
    algorithms: [
      ...algorithms,
      {
        name: algorithmName,
        kind: 'hnsw',
        hnswParameters: { metric: 'cosine', m: 4, efConstruction: 400, efSearch: 500 },
      },
    ],
    profiles: [...profiles, { name: profileName, algorithm: algorithmName }],
  }
  next.fields = updateVectorFieldProfiles(next.fields, profileName)
  return next
}