/**
 * Index definition helpers for the 2026-11-01-preview graph features.
 *
 * Covers `graphProfile` (edge-list graph index), `vectorSearch.topicGraphProfiles`
 * and the field-level `topicGraphProfile` link. All helpers are pure: they never
 * mutate their input and keep unknown properties of the index definition intact.
 *
 * References:
 * - https://learn.microsoft.com/rest/api/searchservice/indexes/create-or-update?view=rest-searchservice-2026-11-01-preview
 * - https://learn.microsoft.com/azure/search/agentic-knowledge-source-how-to-topic-graph
 */

import type { Language } from './translations'

type JsonRecord = Record<string, unknown>

export const GRAPH_PROFILE_KINDS = ['edgeList'] as const
export const TOPIC_GRAPH_KINDS = ['none', 'diverse', 'balanced'] as const
export type TopicGraphKind = (typeof TOPIC_GRAPH_KINDS)[number]

export const TOPIC_GRAPH_LIMITS = {
  diversityFactor: { min: 0, max: 1, defaultValue: 0.2 },
  minDiversityPoolSize: { min: 250, max: 10000, defaultValue: 1000 },
} as const

export type GraphFieldValueType = 'string' | 'double' | 'boolean' | 'dateTime'
export type GraphFieldAttribute = 'filterable' | 'facetable' | 'sortable'
export type GraphRoleGroup = 'identity' | 'subject' | 'predicate' | 'object' | 'confidence' | 'provenance'

export type GraphFieldRole =
  | 'assertionIdField'
  | 'factIdField'
  | 'graphNameField'
  | 'subjectField'
  | 'subjectTypeField'
  | 'subjectIdField'
  | 'subjectIdDisplayNameField'
  | 'predicateField'
  | 'objectField'
  | 'objectStringField'
  | 'objectDoubleField'
  | 'objectBoolField'
  | 'objectDateTimeField'
  | 'objectTypeField'
  | 'objectIdField'
  | 'objectIdDisplayNameField'
  | 'confidenceField'
  | 'subjectConfidenceField'
  | 'predicateConfidenceField'
  | 'objectConfidenceField'
  | 'sourceChunkIdField'
  | 'sourceParentIdField'

export type GraphRoleSpec = {
  role: GraphFieldRole
  group: GraphRoleGroup
  valueType: GraphFieldValueType
  /** Attributes the REST reference requires on the mapped field. */
  attributes: GraphFieldAttribute[]
  /** The assertion ID role must be the index key. */
  key?: boolean
  /** Field name used by the official graph index sample. */
  templateField: string
  description: Record<Language, string>
}

const EDM_TYPES: Record<GraphFieldValueType, string> = {
  string: 'Edm.String',
  double: 'Edm.Double',
  boolean: 'Edm.Boolean',
  dateTime: 'Edm.DateTimeOffset',
}

export function graphValueTypeToEdm(valueType: GraphFieldValueType): string {
  return EDM_TYPES[valueType]
}

export const GRAPH_ROLE_GROUPS: GraphRoleGroup[] = ['identity', 'subject', 'predicate', 'object', 'confidence', 'provenance']

export const GRAPH_ROLE_SPECS: GraphRoleSpec[] = [
  {
    role: 'assertionIdField',
    group: 'identity',
    valueType: 'string',
    attributes: ['filterable', 'sortable'],
    key: true,
    templateField: 'id',
    description: {
      ja: '独立して管理されるアサーション (主張) を識別する文字列のキーフィールドです。filterable と sortable が必要です。',
      en: 'String index key that identifies an independently managed assertion. Must be filterable and sortable.',
    },
  },
  {
    role: 'factIdField',
    group: 'identity',
    valueType: 'string',
    attributes: ['filterable'],
    templateField: 'fact_id',
    description: {
      ja: '意味上のファクト (事実) を識別する文字列フィールドです。filterable が必要です。複数のアサーションが同じファクトを裏付けることができます。',
      en: 'String field that identifies the semantic fact. Must be filterable. Multiple assertions can support the same fact.',
    },
  },
  {
    role: 'graphNameField',
    group: 'identity',
    valueType: 'string',
    attributes: ['filterable', 'facetable', 'sortable'],
    templateField: 'graph_name',
    description: {
      ja: '正規 ID を修飾するグラフ名の文字列フィールドです。filterable、facetable、sortable が必要です。',
      en: 'Graph-name string field that qualifies canonical identities. Must be filterable, facetable, and sortable.',
    },
  },
  {
    role: 'subjectField',
    group: 'subject',
    valueType: 'string',
    attributes: ['filterable', 'facetable', 'sortable'],
    templateField: 'subject',
    description: {
      ja: '主語の表示値を持つ文字列フィールドです。filterable、facetable、sortable が必要です。',
      en: 'Subject display-value string field. Must be filterable, facetable, and sortable.',
    },
  },
  {
    role: 'subjectTypeField',
    group: 'subject',
    valueType: 'string',
    attributes: ['filterable', 'facetable'],
    templateField: 'subject_type',
    description: {
      ja: '主語の型を持つ文字列フィールドです。filterable と facetable が必要です。',
      en: 'Subject type string field. Must be filterable and facetable.',
    },
  },
  {
    role: 'subjectIdField',
    group: 'subject',
    valueType: 'string',
    attributes: ['filterable', 'facetable', 'sortable'],
    templateField: 'subject_id',
    description: {
      ja: '主語の正規 ID を持つ文字列フィールドです。filterable、facetable、sortable が必要です。',
      en: 'Canonical subject ID string field. Must be filterable, facetable, and sortable.',
    },
  },
  {
    role: 'subjectIdDisplayNameField',
    group: 'subject',
    valueType: 'string',
    attributes: [],
    templateField: 'subject_display_name',
    description: {
      ja: '主語の正規 ID の表示名を持つ文字列フィールドです。',
      en: 'Canonical subject display-name string field.',
    },
  },
  {
    role: 'predicateField',
    group: 'predicate',
    valueType: 'string',
    attributes: ['filterable', 'facetable'],
    templateField: 'predicate',
    description: {
      ja: '述語を持つ文字列フィールドです。filterable と facetable が必要です。',
      en: 'Predicate string field. Must be filterable and facetable.',
    },
  },
  {
    role: 'objectField',
    group: 'object',
    valueType: 'string',
    attributes: ['filterable', 'facetable', 'sortable'],
    templateField: 'object',
    description: {
      ja: '目的語の表示値を持つ文字列フィールドです。filterable、facetable、sortable が必要です。',
      en: 'Object display-value string field. Must be filterable, facetable, and sortable.',
    },
  },
  {
    role: 'objectStringField',
    group: 'object',
    valueType: 'string',
    attributes: ['filterable', 'facetable'],
    templateField: 'object_string',
    description: {
      ja: '目的語の文字列値を持つフィールドです。filterable と facetable が必要です。',
      en: 'Object string-value field. Must be filterable and facetable.',
    },
  },
  {
    role: 'objectDoubleField',
    group: 'object',
    valueType: 'double',
    attributes: ['filterable', 'facetable', 'sortable'],
    templateField: 'object_double',
    description: {
      ja: '目的語の数値を持つ Edm.Double フィールドです。filterable、facetable、sortable が必要です。',
      en: 'Object numeric-value Edm.Double field. Must be filterable, facetable, and sortable.',
    },
  },
  {
    role: 'objectBoolField',
    group: 'object',
    valueType: 'boolean',
    attributes: ['filterable'],
    templateField: 'object_bool',
    description: {
      ja: '目的語の真偽値を持つ Edm.Boolean フィールドです。filterable が必要です。',
      en: 'Object Boolean-value Edm.Boolean field. Must be filterable.',
    },
  },
  {
    role: 'objectDateTimeField',
    group: 'object',
    valueType: 'dateTime',
    attributes: ['filterable'],
    templateField: 'object_datetime',
    description: {
      ja: '目的語の日付値を持つ Edm.DateTimeOffset フィールドです。filterable が必要です。',
      en: 'Object date-value Edm.DateTimeOffset field. Must be filterable.',
    },
  },
  {
    role: 'objectTypeField',
    group: 'object',
    valueType: 'string',
    attributes: ['filterable', 'facetable'],
    templateField: 'object_type',
    description: {
      ja: '目的語の型を持つ文字列フィールドです。filterable と facetable が必要です。',
      en: 'Object type string field. Must be filterable and facetable.',
    },
  },
  {
    role: 'objectIdField',
    group: 'object',
    valueType: 'string',
    attributes: ['filterable', 'facetable', 'sortable'],
    templateField: 'object_id',
    description: {
      ja: '目的語の正規 ID を持つ文字列フィールドです。filterable、facetable、sortable が必要です。',
      en: 'Canonical object ID string field. Must be filterable, facetable, and sortable.',
    },
  },
  {
    role: 'objectIdDisplayNameField',
    group: 'object',
    valueType: 'string',
    attributes: [],
    templateField: 'object_display_name',
    description: {
      ja: '目的語の正規 ID の表示名を持つ文字列フィールドです。',
      en: 'Canonical object display-name string field.',
    },
  },
  {
    role: 'confidenceField',
    group: 'confidence',
    valueType: 'double',
    attributes: [],
    templateField: 'confidence',
    description: {
      ja: '関係全体の信頼度を持つ Edm.Double フィールドです。',
      en: 'Overall relationship confidence Edm.Double field.',
    },
  },
  {
    role: 'subjectConfidenceField',
    group: 'confidence',
    valueType: 'double',
    attributes: [],
    templateField: 'subject_confidence',
    description: {
      ja: '主語の根拠付け (グラウンディング) の信頼度を持つ Edm.Double フィールドです。',
      en: 'Subject grounding confidence Edm.Double field.',
    },
  },
  {
    role: 'predicateConfidenceField',
    group: 'confidence',
    valueType: 'double',
    attributes: [],
    templateField: 'predicate_confidence',
    description: {
      ja: '述語の整合 (アラインメント) の信頼度を持つ Edm.Double フィールドです。',
      en: 'Predicate alignment confidence Edm.Double field.',
    },
  },
  {
    role: 'objectConfidenceField',
    group: 'confidence',
    valueType: 'double',
    attributes: [],
    templateField: 'object_confidence',
    description: {
      ja: '目的語の根拠付け (グラウンディング) の信頼度を持つ Edm.Double フィールドです。',
      en: 'Object grounding confidence Edm.Double field.',
    },
  },
  {
    role: 'sourceChunkIdField',
    group: 'provenance',
    valueType: 'string',
    attributes: [],
    templateField: 'chunk_id',
    description: {
      ja: '出典チャンクの識別子を持つ文字列フィールドです。出典 (プロビナンス) の結合に使用します。',
      en: 'Source chunk identifier string field used for provenance joins.',
    },
  },
  {
    role: 'sourceParentIdField',
    group: 'provenance',
    valueType: 'string',
    attributes: [],
    templateField: 'parent_id',
    description: {
      ja: '出典となる親ドキュメントの識別子を持つ文字列フィールドです。',
      en: 'Parent source document identifier string field.',
    },
  },
]

export const GRAPH_ROLE_COUNT = GRAPH_ROLE_SPECS.length

export type GraphIssueSeverity = 'error' | 'warning'

export type GraphIssueCode =
  | 'graphProfileInvalid'
  | 'graphKindMissing'
  | 'graphKindUnsupported'
  | 'graphFieldsMissing'
  | 'graphRoleUnmapped'
  | 'graphFieldNotFound'
  | 'graphTypeMismatch'
  | 'graphAttributesDisabled'
  | 'graphAssertionNotKey'
  | 'graphNotRetrievable'
  | 'graphNormalizer'
  | 'graphDuplicateField'
  | 'graphProvenanceUnknown'
  | 'topicProfileInvalid'
  | 'topicNameMissing'
  | 'topicNameDuplicate'
  | 'topicIndexMissing'
  | 'topicIndexUnknown'
  | 'topicKindMissing'
  | 'topicKindInvalid'
  | 'topicDiversityNotAllowed'
  | 'topicDiversityRange'
  | 'topicPoolNotAllowed'
  | 'topicPoolRange'
  | 'topicFieldNotVector'
  | 'topicFieldUnknownProfile'
  | 'topicProfileUnused'
  | 'topicProfileShared'
  | 'topicNoVectorizer'

export type GraphIssue = {
  severity: GraphIssueSeverity
  code: GraphIssueCode
  params: Record<string, string>
}

export type GraphValidationOptions = {
  /** Names of the indexes that exist on the service. An empty list disables existence checks. */
  indexNames?: string[]
  /** Name of the index being edited. It is never suggested as a related index. */
  ownIndexName?: string
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function cloneRecord(record: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(record)) as JsonRecord
}

export function uniqueName(existingNames: string[], baseName: string): string {
  if (!existingNames.includes(baseName)) return baseName
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${baseName}-${suffix}`
    if (!existingNames.includes(candidate)) return candidate
  }
  return `${baseName}-${Date.now()}`
}

const VECTOR_FIELD_TYPES = [
  'Collection(Edm.Single)',
  'Collection(Edm.Half)',
  'Collection(Edm.Int16)',
  'Collection(Edm.SByte)',
  'Collection(Edm.Byte)',
]

function isVectorField(field: JsonRecord): boolean {
  return VECTOR_FIELD_TYPES.includes(asString(field.type)) || field.dimensions !== undefined || !!asString(field.vectorSearchProfile)
}

function getTopLevelFields(index: JsonRecord): JsonRecord[] {
  return asArray(index.fields).filter(isRecord)
}

export function getTopLevelFieldTypes(index: JsonRecord): Map<string, string> {
  return new Map(getTopLevelFields(index).map((field) => [asString(field.name), asString(field.type)]))
}

// ── graphProfile ──────────────────────────────────────────────────────────────

export type GraphProfileState = {
  present: boolean
  kind: string
  provenanceIndexName: string
  mappings: Partial<Record<GraphFieldRole, string>>
}

export function readGraphProfile(index: JsonRecord): GraphProfileState {
  const profile = isRecord(index.graphProfile) ? index.graphProfile : null
  const fieldMap = profile && isRecord(profile.fields) ? profile.fields : {}
  const mappings: Partial<Record<GraphFieldRole, string>> = {}
  for (const spec of GRAPH_ROLE_SPECS) {
    const value = asString(fieldMap[spec.role]).trim()
    if (value) mappings[spec.role] = value
  }
  return {
    present: profile !== null,
    kind: profile ? asString(profile.kind) : '',
    provenanceIndexName: profile ? asString(profile.provenanceIndexName) : '',
    mappings,
  }
}

export function countMappedGraphRoles(index: JsonRecord): number {
  return Object.keys(readGraphProfile(index).mappings).length
}

function withGraphProfile(index: JsonRecord, updater: (profile: JsonRecord) => JsonRecord): JsonRecord {
  const next = cloneRecord(index)
  const current = isRecord(next.graphProfile) ? next.graphProfile : {}
  next.graphProfile = updater(current)
  return next
}

export function addGraphProfile(index: JsonRecord): JsonRecord {
  return withGraphProfile(index, (profile) => ({
    ...profile,
    kind: asString(profile.kind) || GRAPH_PROFILE_KINDS[0],
    fields: isRecord(profile.fields) ? profile.fields : {},
  }))
}

export function removeGraphProfile(index: JsonRecord): JsonRecord {
  const next = cloneRecord(index)
  delete next.graphProfile
  return next
}

export function setGraphProfileKind(index: JsonRecord, kind: string): JsonRecord {
  return withGraphProfile(index, (profile) => {
    const next = { ...profile }
    if (kind) next.kind = kind
    else delete next.kind
    if (!isRecord(next.fields)) next.fields = {}
    return next
  })
}

export function setGraphProvenanceIndexName(index: JsonRecord, name: string): JsonRecord {
  return withGraphProfile(index, (profile) => {
    const next = { ...profile }
    if (name.trim()) next.provenanceIndexName = name.trim()
    else delete next.provenanceIndexName
    if (!isRecord(next.fields)) next.fields = {}
    return next
  })
}

export function setGraphRoleField(index: JsonRecord, role: GraphFieldRole, fieldName: string): JsonRecord {
  return withGraphProfile(index, (profile) => {
    const fields = isRecord(profile.fields) ? { ...profile.fields } : {}
    if (fieldName) fields[role] = fieldName
    else delete fields[role]
    return { ...profile, fields }
  })
}

/** Top-level fields that can serve a graph role: single-valued primitives of the expected type. */
export function getGraphRoleCandidates(index: JsonRecord, spec: GraphRoleSpec): string[] {
  const expectedType = EDM_TYPES[spec.valueType]
  return getTopLevelFields(index)
    .filter((field) => asString(field.type) === expectedType)
    .map((field) => asString(field.name))
    .filter(Boolean)
}

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function roleNameAliases(spec: GraphRoleSpec): string[] {
  const withoutSuffix = spec.role.replace(/Field$/, '')
  return [normalizeFieldName(spec.templateField), normalizeFieldName(withoutSuffix)]
}

/** Fills unmapped roles with existing fields whose name matches the role (for example `subject_id` or `subjectId`). */
export function suggestGraphFieldMappings(index: JsonRecord): JsonRecord {
  const state = readGraphProfile(index)
  const used = new Set(Object.values(state.mappings))
  const additions: Partial<Record<GraphFieldRole, string>> = {}
  for (const spec of GRAPH_ROLE_SPECS) {
    if (state.mappings[spec.role]) continue
    const aliases = roleNameAliases(spec)
    const match = getGraphRoleCandidates(index, spec).find((name) => !used.has(name) && aliases.includes(normalizeFieldName(name)))
    if (!match) continue
    additions[spec.role] = match
    used.add(match)
  }

  return withGraphProfile(index, (profile) => ({
    ...profile,
    kind: asString(profile.kind) || GRAPH_PROFILE_KINDS[0],
    fields: { ...(isRecord(profile.fields) ? profile.fields : {}), ...additions },
  }))
}

function buildTemplateField(spec: GraphRoleSpec): JsonRecord {
  const field: JsonRecord = { name: spec.templateField, type: EDM_TYPES[spec.valueType], retrievable: true }
  if (spec.key) field.key = true
  if (spec.valueType === 'string') {
    field.searchable = false
    for (const attribute of ['filterable', 'sortable', 'facetable'] as const) {
      field[attribute] = spec.attributes.includes(attribute)
    }
    return field
  }
  for (const attribute of spec.attributes) field[attribute] = true
  return field
}

/**
 * Adds the edge-list fields of the official graph index sample for every unmapped role
 * and maps them in `graphProfile.fields`. Existing mappings and fields are kept.
 */
export function applyGraphIndexTemplate(index: JsonRecord): JsonRecord {
  const state = readGraphProfile(index)
  const next = cloneRecord(index)
  const fields = asArray(next.fields)
  const existingNames = new Set(getTopLevelFields(next).map((field) => asString(field.name)))
  const existingKey = getTopLevelFields(next).find((field) => field.key === true)
  const additions: Partial<Record<GraphFieldRole, string>> = {}

  for (const spec of GRAPH_ROLE_SPECS) {
    if (state.mappings[spec.role]) continue
    if (spec.key && existingKey) {
      additions[spec.role] = asString(existingKey.name)
      continue
    }
    additions[spec.role] = spec.templateField
    if (existingNames.has(spec.templateField)) continue
    fields.push(buildTemplateField(spec))
    existingNames.add(spec.templateField)
  }

  next.fields = fields
  return withGraphProfile(next, (profile) => ({
    ...profile,
    kind: asString(profile.kind) || GRAPH_PROFILE_KINDS[0],
    fields: { ...additions, ...(isRecord(profile.fields) ? profile.fields : {}) },
  }))
}

/** Enables the attributes the REST reference requires on every mapped top-level field. */
export function enableRequiredGraphAttributes(index: JsonRecord): JsonRecord {
  const state = readGraphProfile(index)
  const existingKey = asString(getTopLevelFields(index).find((field) => field.key === true)?.name)
  const required = new Map<string, Set<string>>()
  for (const spec of GRAPH_ROLE_SPECS) {
    const name = state.mappings[spec.role]
    if (!name) continue
    const attributes = required.get(name) ?? new Set<string>(['retrievable'])
    for (const attribute of spec.attributes) attributes.add(attribute)
    // An index has exactly one key field, so another existing key is never replaced.
    if (spec.key && (!existingKey || existingKey === name)) attributes.add('key')
    required.set(name, attributes)
  }

  const next = cloneRecord(index)
  next.fields = asArray(next.fields).map((value) => {
    if (!isRecord(value)) return value
    const attributes = required.get(asString(value.name))
    if (!attributes) return value
    const field = { ...value }
    for (const attribute of attributes) field[attribute] = true
    return field
  })
  return next
}

export function validateGraphProfile(index: JsonRecord, options: GraphValidationOptions = {}): GraphIssue[] {
  if (index.graphProfile === undefined || index.graphProfile === null) return []
  if (!isRecord(index.graphProfile)) return [{ severity: 'error', code: 'graphProfileInvalid', params: {} }]

  const issues: GraphIssue[] = []
  const profile = index.graphProfile
  const kind = asString(profile.kind).trim()
  if (!kind) issues.push({ severity: 'error', code: 'graphKindMissing', params: {} })
  else if (!(GRAPH_PROFILE_KINDS as readonly string[]).includes(kind)) {
    issues.push({ severity: 'error', code: 'graphKindUnsupported', params: { kind } })
  }

  if (!isRecord(profile.fields)) {
    issues.push({ severity: 'error', code: 'graphFieldsMissing', params: {} })
    return issues
  }

  const fieldsByName = new Map(getTopLevelFields(index).map((field) => [asString(field.name), field]))
  const rolesByField = new Map<string, GraphFieldRole[]>()
  const reportedFieldIssues = new Set<string>()

  for (const spec of GRAPH_ROLE_SPECS) {
    const mapped = asString(profile.fields[spec.role]).trim()
    if (!mapped) {
      issues.push({ severity: 'error', code: 'graphRoleUnmapped', params: { role: spec.role } })
      continue
    }
    rolesByField.set(mapped, [...(rolesByField.get(mapped) ?? []), spec.role])

    const field = fieldsByName.get(mapped)
    if (!field) {
      issues.push({ severity: 'error', code: 'graphFieldNotFound', params: { role: spec.role, field: mapped } })
      continue
    }

    const expectedType = EDM_TYPES[spec.valueType]
    const actualType = asString(field.type)
    if (actualType !== expectedType) {
      issues.push({ severity: 'error', code: 'graphTypeMismatch', params: { role: spec.role, field: mapped, expected: expectedType, actual: actualType || '-' } })
      continue
    }

    const disabled = spec.attributes.filter((attribute) => field[attribute] === false)
    if (disabled.length > 0) {
      issues.push({ severity: 'error', code: 'graphAttributesDisabled', params: { role: spec.role, field: mapped, attributes: disabled.join(', ') } })
    }
    if (spec.key && field.key !== true) {
      issues.push({ severity: 'error', code: 'graphAssertionNotKey', params: { role: spec.role, field: mapped } })
    }
    if (field.retrievable === false && !reportedFieldIssues.has(`retrievable:${mapped}`)) {
      reportedFieldIssues.add(`retrievable:${mapped}`)
      issues.push({ severity: 'error', code: 'graphNotRetrievable', params: { field: mapped } })
    }
    if (spec.valueType === 'string' && asString(field.normalizer) && !reportedFieldIssues.has(`normalizer:${mapped}`)) {
      reportedFieldIssues.add(`normalizer:${mapped}`)
      issues.push({ severity: 'error', code: 'graphNormalizer', params: { field: mapped } })
    }
  }

  for (const [field, roles] of rolesByField) {
    const sharesAssertionAndFact = roles.length === 2 && roles.includes('assertionIdField') && roles.includes('factIdField')
    if (roles.length > 1 && !sharesAssertionAndFact) {
      issues.push({ severity: 'error', code: 'graphDuplicateField', params: { field, roles: roles.join(', ') } })
    }
  }

  const provenance = asString(profile.provenanceIndexName).trim()
  const knownIndexes = options.indexNames ?? []
  if (provenance && knownIndexes.length > 0 && !knownIndexes.includes(provenance)) {
    issues.push({ severity: 'warning', code: 'graphProvenanceUnknown', params: { name: provenance } })
  }

  return issues
}

// ── topicGraphProfiles ────────────────────────────────────────────────────────

export type TopicGraphProfilePatch = {
  name?: string
  indexName?: string
  defaultKind?: string
  defaultDiversityFactor?: number | undefined
  defaultMinDiversityPoolSize?: number | undefined
}

export function getTopicGraphProfiles(index: JsonRecord): JsonRecord[] {
  const vectorSearch = isRecord(index.vectorSearch) ? index.vectorSearch : {}
  return asArray(vectorSearch.topicGraphProfiles).filter(isRecord)
}

function withTopicGraphProfiles(index: JsonRecord, updater: (profiles: JsonRecord[]) => JsonRecord[]): JsonRecord {
  const next = cloneRecord(index)
  const vectorSearch = isRecord(next.vectorSearch) ? next.vectorSearch : {}
  vectorSearch.topicGraphProfiles = updater(asArray(vectorSearch.topicGraphProfiles).filter(isRecord))
  next.vectorSearch = vectorSearch
  return next
}

export type VectorFieldLink = {
  path: string
  pathParts: string[]
  type: string
  dimensions: string
  vectorSearchProfile: string
  topicGraphProfile: string
}

export function collectVectorFieldLinks(index: JsonRecord): VectorFieldLink[] {
  const links: VectorFieldLink[] = []
  const walk = (fields: unknown, parentParts: string[]) => {
    for (const value of asArray(fields)) {
      if (!isRecord(value)) continue
      const name = asString(value.name)
      if (!name) continue
      const pathParts = [...parentParts, name]
      if (isVectorField(value)) {
        links.push({
          path: pathParts.join('.'),
          pathParts,
          type: asString(value.type),
          dimensions: value.dimensions === undefined || value.dimensions === null ? '' : String(value.dimensions),
          vectorSearchProfile: asString(value.vectorSearchProfile),
          topicGraphProfile: asString(value.topicGraphProfile),
        })
      }
      walk(value.fields, pathParts)
    }
  }
  walk(index.fields, [])
  return links
}

function updateFieldsAtPath(fields: unknown, pathParts: string[], updater: (field: JsonRecord) => JsonRecord): unknown[] {
  const [targetName, ...rest] = pathParts
  return asArray(fields).map((value) => {
    if (!isRecord(value) || asString(value.name) !== targetName) return value
    if (rest.length === 0) return updater({ ...value })
    return { ...value, fields: updateFieldsAtPath(value.fields, rest, updater) }
  })
}

function updateEveryField(fields: unknown, updater: (field: JsonRecord) => JsonRecord): unknown[] {
  return asArray(fields).map((value) => {
    if (!isRecord(value)) return value
    const field = updater({ ...value })
    if (Array.isArray(field.fields)) field.fields = updateEveryField(field.fields, updater)
    return field
  })
}

/** Links (or, with an empty name, unlinks) a vector field to a topic graph profile. */
export function setFieldTopicGraphProfile(index: JsonRecord, pathParts: string[], profileName: string): JsonRecord {
  const next = cloneRecord(index)
  next.fields = updateFieldsAtPath(next.fields, pathParts, (field) => {
    if (profileName) field.topicGraphProfile = profileName
    else delete field.topicGraphProfile
    return field
  })
  return next
}

function retargetFieldLinks(index: JsonRecord, fromName: string, toName: string): JsonRecord {
  const next = cloneRecord(index)
  next.fields = updateEveryField(next.fields, (field) => {
    if (asString(field.topicGraphProfile) !== fromName) return field
    if (toName) field.topicGraphProfile = toName
    else delete field.topicGraphProfile
    return field
  })
  return next
}

export function addTopicGraphProfile(index: JsonRecord, linkedFieldPathParts?: string[]): JsonRecord {
  const profiles = getTopicGraphProfiles(index)
  const baseName = linkedFieldPathParts ? `${linkedFieldPathParts[linkedFieldPathParts.length - 1]}-topics` : 'topic-graph'
  const name = uniqueName(profiles.map((profile) => asString(profile.name)).filter(Boolean), baseName)
  const added = withTopicGraphProfiles(index, (current) => [...current, { name, defaultKind: 'balanced' }])
  return linkedFieldPathParts ? setFieldTopicGraphProfile(added, linkedFieldPathParts, name) : added
}

export function updateTopicGraphProfile(index: JsonRecord, profileIndex: number, patch: TopicGraphProfilePatch): JsonRecord {
  const current = getTopicGraphProfiles(index)[profileIndex]
  if (!current) return index
  const previousName = asString(current.name)

  const updated = withTopicGraphProfiles(index, (profiles) => profiles.map((profile, position) => {
    if (position !== profileIndex) return profile
    const next = { ...profile }
    for (const key of Object.keys(patch) as Array<keyof TopicGraphProfilePatch>) {
      const value = patch[key]
      if (value === undefined || value === '') delete next[key]
      else next[key] = value
    }

    // Properties that the selected kind does not allow are dropped so that the saved profile stays valid.
    if (patch.defaultKind !== undefined) {
      const kind = asString(next.defaultKind)
      if (kind !== 'diverse') delete next.defaultDiversityFactor
      if (kind !== 'diverse' && kind !== 'balanced') delete next.defaultMinDiversityPoolSize
    }
    return next
  }))

  if (patch.name === undefined || !previousName || !patch.name.trim() || patch.name === previousName) return updated
  return retargetFieldLinks(updated, previousName, patch.name)
}

export function removeTopicGraphProfile(index: JsonRecord, profileIndex: number): JsonRecord {
  const removedName = asString(getTopicGraphProfiles(index)[profileIndex]?.name)
  const next = withTopicGraphProfiles(index, (profiles) => profiles.filter((_profile, position) => position !== profileIndex))
  return removedName ? retargetFieldLinks(next, removedName, '') : next
}

function hasVectorizer(index: JsonRecord, vectorSearchProfileName: string): boolean {
  const vectorSearch = isRecord(index.vectorSearch) ? index.vectorSearch : {}
  const profile = asArray(vectorSearch.profiles).filter(isRecord).find((item) => asString(item.name) === vectorSearchProfileName)
  const vectorizerName = profile ? asString(profile.vectorizer) : ''
  if (!vectorizerName) return false
  return asArray(vectorSearch.vectorizers).filter(isRecord).some((item) => asString(item.name) === vectorizerName)
}

export function validateTopicGraphProfiles(index: JsonRecord, options: GraphValidationOptions = {}): GraphIssue[] {
  const issues: GraphIssue[] = []
  const vectorSearch = isRecord(index.vectorSearch) ? index.vectorSearch : {}
  const rawProfiles = asArray(vectorSearch.topicGraphProfiles)
  const knownIndexes = (options.indexNames ?? []).filter((name) => name !== options.ownIndexName)
  const profileNames = new Set<string>()

  rawProfiles.forEach((value, position) => {
    const label = `#${position + 1}`
    if (!isRecord(value)) {
      issues.push({ severity: 'error', code: 'topicProfileInvalid', params: { profile: label } })
      return
    }

    const name = asString(value.name).trim()
    const profileLabel = name || label
    if (!name) issues.push({ severity: 'error', code: 'topicNameMissing', params: { profile: label } })
    else if (profileNames.has(name)) issues.push({ severity: 'error', code: 'topicNameDuplicate', params: { profile: name } })
    if (name) profileNames.add(name)

    const indexName = asString(value.indexName).trim()
    if (!indexName) issues.push({ severity: 'error', code: 'topicIndexMissing', params: { profile: profileLabel } })
    else if (knownIndexes.length > 0 && !knownIndexes.includes(indexName)) {
      issues.push({ severity: 'warning', code: 'topicIndexUnknown', params: { profile: profileLabel, name: indexName } })
    }

    const kind = asString(value.defaultKind).trim()
    if (!kind) issues.push({ severity: 'error', code: 'topicKindMissing', params: { profile: profileLabel } })
    else if (!(TOPIC_GRAPH_KINDS as readonly string[]).includes(kind)) {
      issues.push({ severity: 'error', code: 'topicKindInvalid', params: { profile: profileLabel, kind } })
    }

    const factor = value.defaultDiversityFactor
    if (factor !== undefined && factor !== null) {
      const { min, max } = TOPIC_GRAPH_LIMITS.diversityFactor
      if (kind !== 'diverse') issues.push({ severity: 'error', code: 'topicDiversityNotAllowed', params: { profile: profileLabel } })
      else if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < min || factor > max) {
        issues.push({ severity: 'error', code: 'topicDiversityRange', params: { profile: profileLabel } })
      }
    }

    const pool = value.defaultMinDiversityPoolSize
    if (pool !== undefined && pool !== null) {
      const { min, max } = TOPIC_GRAPH_LIMITS.minDiversityPoolSize
      if (kind !== 'diverse' && kind !== 'balanced') issues.push({ severity: 'error', code: 'topicPoolNotAllowed', params: { profile: profileLabel } })
      else if (typeof pool !== 'number' || !Number.isInteger(pool) || pool < min || pool > max) {
        issues.push({ severity: 'error', code: 'topicPoolRange', params: { profile: profileLabel } })
      }
    }
  })

  const linkedFields = new Map<string, string[]>()
  const collect = (fields: unknown, parentParts: string[]) => {
    for (const value of asArray(fields)) {
      if (!isRecord(value)) continue
      const fieldName = asString(value.name)
      const pathParts = [...parentParts, fieldName]
      const path = pathParts.join('.')
      const reference = asString(value.topicGraphProfile).trim()
      if (reference) {
        if (!isVectorField(value)) issues.push({ severity: 'error', code: 'topicFieldNotVector', params: { field: path } })
        if (!profileNames.has(reference)) {
          issues.push({ severity: 'error', code: 'topicFieldUnknownProfile', params: { field: path, profile: reference } })
        } else {
          linkedFields.set(reference, [...(linkedFields.get(reference) ?? []), path])
          if (!hasVectorizer(index, asString(value.vectorSearchProfile))) {
            issues.push({ severity: 'warning', code: 'topicNoVectorizer', params: { field: path, profile: reference } })
          }
        }
      }
      collect(value.fields, pathParts)
    }
  }
  collect(index.fields, [])

  for (const name of profileNames) {
    const fields = linkedFields.get(name) ?? []
    if (fields.length === 0) issues.push({ severity: 'warning', code: 'topicProfileUnused', params: { profile: name } })
    if (fields.length > 1) issues.push({ severity: 'warning', code: 'topicProfileShared', params: { profile: name, fields: fields.join(', ') } })
  }

  return issues
}

// ── 2026-11-01-preview feature detection ──────────────────────────────────────

export const NOVEMBER_INDEX_SCHEMA_API_VERSION = '2026-11-01-preview'

/**
 * Features of the candidate definition that a known older API version cannot accept.
 * Newer or unrecognised version strings are not blocked.
 */
export function findUnsupportedNovemberIndexFeatures(index: JsonRecord, apiVersion: string): string[] {
  const versionDate = apiVersion.trim().match(/^(\d{4}-\d{2}-\d{2})/)?.[1]
  if (!versionDate || versionDate >= NOVEMBER_INDEX_SCHEMA_API_VERSION.slice(0, 10)) return []
  return findNovemberIndexFeatures(index)
}

/** Properties of an index definition that only exist in the 2026-11-01-preview schema. */
export function findNovemberIndexFeatures(index: JsonRecord): string[] {
  const features: string[] = []
  if (index.graphProfile !== undefined && index.graphProfile !== null) features.push('graphProfile')
  if (isRecord(index.vectorSearch)) {
    if (asArray(index.vectorSearch.topicGraphProfiles).length > 0) features.push('vectorSearch.topicGraphProfiles')
    if (asArray(index.vectorSearch.vectorizers).some((vectorizer) => isRecord(vectorizer) && asString(vectorizer.kind) === 'openAICompatible')) {
      features.push('vectorSearch.vectorizers[openAICompatible]')
    }
  }
  if (index.oneLakeSecuritySource !== undefined && index.oneLakeSecuritySource !== null) features.push('oneLakeSecuritySource')
  if (asArray(index.scoringProfiles).some((profile) => isRecord(profile) && asArray(profile.functions).some((fn) => isRecord(fn) && asString(fn.type) === 'random'))) {
    features.push('scoringProfiles[].functions[random]')
  }

  let hasTopicLink = false
  let hasOrganizationExpiration = false
  let hasOneLakeFilter = false
  const scan = (fields: unknown) => {
    for (const value of asArray(fields)) {
      if (!isRecord(value)) continue
      if (asString(value.topicGraphProfile)) hasTopicLink = true
      if (value.organizationAccessExpiration !== undefined && value.organizationAccessExpiration !== null) hasOrganizationExpiration = true
      if (['oneLakeParentFolders', 'oneLakeLakehouseId'].includes(asString(value.permissionFilter))) hasOneLakeFilter = true
      scan(value.fields)
    }
  }
  scan(index.fields)
  if (hasTopicLink) features.push('fields[].topicGraphProfile')
  if (hasOrganizationExpiration) features.push('fields[].organizationAccessExpiration')
  if (hasOneLakeFilter) features.push('fields[].permissionFilter[oneLake]')
  return features
}
