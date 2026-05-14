import { useMemo, useState } from 'react'

import {
  ANALYZE_CHAR_FILTERS,
  ANALYZE_NORMALIZERS,
  ANALYZE_TOKEN_FILTERS,
  ANALYZE_TOKENIZERS,
} from '../../lib/analyzeCatalog'
import { translations, type Language } from '../../lib/translations'
import type { IndexSchemaTemplateKind } from './indexSchemaTemplates'

type TranslationKey = keyof typeof translations.ja

type IndexSchemaOverviewProps = {
  editedJson: string
  baselineJson: string
  isExistingIndex: boolean
  language: Language
  onApplyTemplate: (kind: IndexSchemaTemplateKind) => void
  onChangeIndex: (nextIndex: Record<string, unknown>) => void
}

type IndexSchemaConfigurationEditorPanelProps = {
  editedJson: string
  baselineJson: string
  isExistingIndex: boolean
  language: Language
  onChangeIndex: (nextIndex: Record<string, unknown>) => void
}

type FieldAttributeKey = 'key' | 'searchable' | 'filterable' | 'sortable' | 'facetable' | 'retrievable' | 'stored'
type FieldTextSettingKey = 'analyzer' | 'indexAnalyzer' | 'searchAnalyzer' | 'normalizer' | 'synonymMaps' | 'dimensions' | 'vectorSearchProfile'
type FieldUpdateability = 'safe' | 'rebuild' | 'review'

type FieldRule = {
  supported: boolean
  updateability: FieldUpdateability
  noteKey: TranslationKey
  required?: boolean
}

type FieldSummary = {
  path: string
  pathParts: string[]
  name: string
  type: string
  depth: number
  isComplex: boolean
  isCollection: boolean
  underCollection: boolean
  key: boolean
  searchable: boolean | null
  filterable: boolean | null
  sortable: boolean | null
  facetable: boolean | null
  retrievable: boolean | null
  stored: boolean | null
  analyzer: string
  searchAnalyzer: string
  indexAnalyzer: string
  normalizer: string
  vectorSearchProfile: string
  dimensions: string
  synonymMaps: string[]
  isVector: boolean
}

type FeatureStatus = 'configured' | 'missing' | 'partial'
type ImpactSeverity = 'safe' | 'rebuild' | 'review'

type ImpactItem = {
  severity: ImpactSeverity
  messageKey: TranslationKey
  name: string
}

type FeatureCard = {
  id: string
  icon: string
  labelKey: TranslationKey
  countLabel: string
  status: FeatureStatus
  templateKind?: IndexSchemaTemplateKind
}

type HealthIssue = {
  severity: ImpactSeverity
  messageKey: TranslationKey
  name?: string
}

type SchemaAnalysis = {
  ok: true
  fields: FieldSummary[]
  topLevelFieldCount: number
  keyFields: FieldSummary[]
  searchableFieldCount: number
  vectorFields: FieldSummary[]
  semanticConfigCount: number
  scoringProfileCount: number
  suggesterCount: number
  analyzerCount: number
  normalizerCount: number
  vectorProfileCount: number
  vectorProfileNames: string[]
  corsConfigured: boolean
  encryptionConfigured: boolean
  healthIssues: HealthIssue[]
  impactItems: ImpactItem[]
  impactCounts: Record<ImpactSeverity, number>
  index: Record<string, unknown>
}

type SchemaParseResult = SchemaAnalysis | { ok: false; empty: boolean; error: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asNumberOrString(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : ''
}

function isComplexFieldType(type: string): boolean {
  return type === 'Edm.ComplexType' || type === 'Collection(Edm.ComplexType)'
}

function isCollectionFieldType(type: string): boolean {
  return type.startsWith('Collection(')
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

function isStringFieldType(type: string): boolean {
  return type === 'Edm.String' || type === 'Collection(Edm.String)'
}

function isSimpleField(field: FieldSummary): boolean {
  return !!field.type && !field.isComplex
}

function cloneRecord(record: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!isRecord(value)) return value
  return Object.keys(value)
    .sort((firstKey, secondKey) => firstKey.localeCompare(secondKey))
    .reduce<Record<string, unknown>>((accumulator, key) => {
      accumulator[key] = sortJsonValue(value[key])
      return accumulator
    }, {})
}

function collectFieldSummaries(value: unknown, parentPath = '', depth = 0, parentParts: string[] = [], underCollection = false): FieldSummary[] {
  const summaries: FieldSummary[] = []
  for (const fieldValue of asArray(value)) {
    if (!isRecord(fieldValue)) continue
    const name = asString(fieldValue.name)
    if (!name) continue

    const path = parentPath ? `${parentPath}.${name}` : name
    const pathParts = [...parentParts, name]
    const type = asString(fieldValue.type)
    const isComplex = isComplexFieldType(type)
    const isCollection = isCollectionFieldType(type)
    const vectorSearchProfile = asString(fieldValue.vectorSearchProfile)
    const dimensions = asNumberOrString(fieldValue.dimensions)
    const synonymMaps = asArray(fieldValue.synonymMaps).map(asString).filter(Boolean)
    const isVector = isVectorFieldType(type) || !!dimensions || !!vectorSearchProfile

    summaries.push({
      path,
      pathParts,
      name,
      type,
      depth,
      isComplex,
      isCollection,
      underCollection,
      key: fieldValue.key === true,
      searchable: asBoolean(fieldValue.searchable),
      filterable: asBoolean(fieldValue.filterable),
      sortable: asBoolean(fieldValue.sortable),
      facetable: asBoolean(fieldValue.facetable),
      retrievable: asBoolean(fieldValue.retrievable),
      stored: asBoolean(fieldValue.stored),
      analyzer: asString(fieldValue.analyzer),
      searchAnalyzer: asString(fieldValue.searchAnalyzer),
      indexAnalyzer: asString(fieldValue.indexAnalyzer),
      normalizer: asString(fieldValue.normalizer),
      vectorSearchProfile,
      dimensions,
      synonymMaps,
      isVector,
    })

    summaries.push(...collectFieldSummaries(fieldValue.fields, path, depth + 1, pathParts, underCollection || type === 'Collection(Edm.ComplexType)'))
  }
  return summaries
}

function parseIndexRecord(rawJson: string): Record<string, unknown> | null {
  const trimmed = rawJson.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function getSemanticConfigurations(index: Record<string, unknown>): unknown[] {
  const semantic = isRecord(index.semantic) ? index.semantic : null
  return semantic ? asArray(semantic.configurations) : []
}

function getVectorSearchSection(index: Record<string, unknown>): Record<string, unknown> {
  return isRecord(index.vectorSearch) ? index.vectorSearch : {}
}

function hasConfiguredObject(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length > 0
}

function buildHealthIssues(analysis: Omit<SchemaAnalysis, 'healthIssues' | 'impactItems' | 'impactCounts'>): HealthIssue[] {
  const issues: HealthIssue[] = []
  if (analysis.topLevelFieldCount === 0) {
    issues.push({ severity: 'rebuild', messageKey: 'indexBuilderSchemaIssueNoFields' })
  }
  if (analysis.keyFields.length === 0) {
    issues.push({ severity: 'rebuild', messageKey: 'indexBuilderSchemaIssueNoKey' })
  }
  if (analysis.keyFields.length > 1) {
    issues.push({ severity: 'rebuild', messageKey: 'indexBuilderSchemaIssueMultipleKeys' })
  }
  for (const field of analysis.vectorFields) {
    if (!field.dimensions) {
      issues.push({ severity: 'rebuild', messageKey: 'indexBuilderSchemaIssueVectorDimensionsMissing', name: field.path })
    }
    if (!field.vectorSearchProfile) {
      issues.push({ severity: 'rebuild', messageKey: 'indexBuilderSchemaIssueVectorProfileMissing', name: field.path })
    }
  }
  if (analysis.vectorFields.length > 0 && analysis.vectorProfileCount === 0) {
    issues.push({ severity: 'review', messageKey: 'indexBuilderSchemaIssueVectorSearchMissing' })
  }
  return issues
}

function buildImpactItems(rawBaselineJson: string, candidate: Record<string, unknown>, isExistingIndex: boolean): ImpactItem[] {
  if (!isExistingIndex || !rawBaselineJson.trim()) {
    return [{ severity: 'review', messageKey: 'indexBuilderSchemaImpactNoBaseline', name: '' }]
  }

  const baseline = parseIndexRecord(rawBaselineJson)
  if (!baseline) return [{ severity: 'review', messageKey: 'indexBuilderSchemaImpactNoBaseline', name: '' }]

  const items: ImpactItem[] = []
  const beforeFields = collectFieldSummaries(baseline.fields)
  const afterFields = collectFieldSummaries(candidate.fields)
  const beforeByPath = new Map(beforeFields.map((field) => [field.path, field]))
  const afterByPath = new Map(afterFields.map((field) => [field.path, field]))

  for (const field of afterFields) {
    const before = beforeByPath.get(field.path)
    if (!before) {
      items.push({ severity: 'safe', messageKey: 'indexBuilderSchemaImpactAddedField', name: field.path })
      continue
    }

    const rebuildProperties: Array<keyof FieldSummary> = [
      'type',
      'key',
      'searchable',
      'filterable',
      'sortable',
      'facetable',
      'stored',
      'analyzer',
      'indexAnalyzer',
      'dimensions',
      'vectorSearchProfile',
    ]
    const safeProperties: Array<keyof FieldSummary> = ['retrievable', 'searchAnalyzer']

    if (rebuildProperties.some((property) => stableJson(before[property]) !== stableJson(field[property]))) {
      items.push({ severity: 'rebuild', messageKey: 'indexBuilderSchemaImpactFieldRebuild', name: field.path })
      continue
    }
    if (safeProperties.some((property) => stableJson(before[property]) !== stableJson(field[property]))) {
      items.push({ severity: 'safe', messageKey: 'indexBuilderSchemaImpactFieldSafe', name: field.path })
    }
    if (stableJson(before.synonymMaps) !== stableJson(field.synonymMaps)) {
      items.push({ severity: 'safe', messageKey: 'indexBuilderSchemaImpactSynonymMaps', name: field.path })
    }
  }

  for (const field of beforeFields) {
    if (!afterByPath.has(field.path)) {
      items.push({ severity: 'rebuild', messageKey: 'indexBuilderSchemaImpactRemovedField', name: field.path })
    }
  }

  const sectionComparisons: Array<{ key: string; severity: ImpactSeverity; messageKey: TranslationKey; name: string }> = [
    { key: 'suggesters', severity: 'rebuild', messageKey: 'indexBuilderSchemaImpactSuggesters', name: 'suggesters' },
    { key: 'scoringProfiles', severity: 'safe', messageKey: 'indexBuilderSchemaImpactScoringProfiles', name: 'scoringProfiles' },
    { key: 'semantic', severity: 'safe', messageKey: 'indexBuilderSchemaImpactSemantic', name: 'semantic' },
    { key: 'corsOptions', severity: 'safe', messageKey: 'indexBuilderSchemaImpactCors', name: 'corsOptions' },
    { key: 'encryptionKey', severity: 'safe', messageKey: 'indexBuilderSchemaImpactEncryption', name: 'encryptionKey' },
    { key: 'vectorSearch', severity: 'review', messageKey: 'indexBuilderSchemaImpactVectorSearch', name: 'vectorSearch' },
    { key: 'analyzers', severity: 'review', messageKey: 'indexBuilderSchemaImpactAnalyzers', name: 'analyzers' },
    { key: 'normalizers', severity: 'review', messageKey: 'indexBuilderSchemaImpactNormalizers', name: 'normalizers' },
  ]

  for (const section of sectionComparisons) {
    if (stableJson(baseline[section.key]) !== stableJson(candidate[section.key])) {
      items.push({ severity: section.severity, messageKey: section.messageKey, name: section.name })
    }
  }

  if (items.length === 0) return [{ severity: 'safe', messageKey: 'indexBuilderSchemaImpactNoRisk', name: '' }]
  return items.slice(0, 12)
}

function analyzeSchema(rawJson: string, rawBaselineJson: string, isExistingIndex: boolean): SchemaParseResult {
  const trimmed = rawJson.trim()
  if (!trimmed) return { ok: false, empty: true, error: '' }

  let index: Record<string, unknown>
  try {
    const parsed = JSON.parse(trimmed)
    if (!isRecord(parsed)) return { ok: false, empty: false, error: 'Index definition must be an object' }
    index = parsed
  } catch (error) {
    return { ok: false, empty: false, error: error instanceof Error ? error.message : String(error) }
  }

  const fields = collectFieldSummaries(index.fields)
  const vectorSearch = getVectorSearchSection(index)
  const vectorProfileNames = asArray(vectorSearch.profiles)
    .filter(isRecord)
    .map((profile) => asString(profile.name))
    .filter(Boolean)
  const analysisBase = {
    ok: true as const,
    index,
    fields,
    topLevelFieldCount: asArray(index.fields).filter(isRecord).length,
    keyFields: fields.filter((field) => field.depth === 0 && field.key),
    searchableFieldCount: fields.filter((field) => field.searchable === true).length,
    vectorFields: fields.filter((field) => field.isVector),
    semanticConfigCount: getSemanticConfigurations(index).length,
    scoringProfileCount: asArray(index.scoringProfiles).length,
    suggesterCount: asArray(index.suggesters).length,
    analyzerCount:
      asArray(index.analyzers).length + asArray(index.tokenizers).length + asArray(index.tokenFilters).length + asArray(index.charFilters).length,
    normalizerCount: asArray(index.normalizers).length,
    vectorProfileCount: asArray(vectorSearch.profiles).length,
    vectorProfileNames,
    corsConfigured: hasConfiguredObject(index.corsOptions),
    encryptionConfigured: hasConfiguredObject(index.encryptionKey),
  }
  const impactItems = buildImpactItems(rawBaselineJson, index, isExistingIndex)
  const impactCounts = impactItems.reduce<Record<ImpactSeverity, number>>((counts, item) => {
    counts[item.severity] += 1
    return counts
  }, { safe: 0, rebuild: 0, review: 0 })

  return {
    ...analysisBase,
    healthIssues: buildHealthIssues(analysisBase),
    impactItems,
    impactCounts,
  }
}

function uniqueName(existingNames: string[], baseName: string): string {
  if (!existingNames.includes(baseName)) return baseName
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${baseName}-${suffix}`
    if (!existingNames.includes(candidate)) return candidate
  }
  return `${baseName}-${Date.now()}`
}

function updateFieldsAtPath(
  fields: unknown,
  pathParts: string[],
  updater: (field: Record<string, unknown>) => Record<string, unknown>,
): unknown[] {
  const [targetName, ...remainingParts] = pathParts
  return asArray(fields).map((fieldValue) => {
    if (!isRecord(fieldValue)) return fieldValue
    if (asString(fieldValue.name) !== targetName) return fieldValue

    if (remainingParts.length === 0) return updater({ ...fieldValue })
    return { ...fieldValue, fields: updateFieldsAtPath(fieldValue.fields, remainingParts, updater) }
  })
}

function updateEveryField(
  fields: unknown,
  updater: (field: Record<string, unknown>, pathParts: string[]) => Record<string, unknown>,
  parentParts: string[] = [],
): unknown[] {
  return asArray(fields).map((fieldValue) => {
    if (!isRecord(fieldValue)) return fieldValue
    const name = asString(fieldValue.name)
    const pathParts = name ? [...parentParts, name] : parentParts
    const nextField = updater({ ...fieldValue }, pathParts)
    if (Array.isArray(nextField.fields)) nextField.fields = updateEveryField(nextField.fields, updater, pathParts)
    return nextField
  })
}

function setFieldProperty(
  index: Record<string, unknown>,
  pathParts: string[],
  propertyName: FieldAttributeKey | FieldTextSettingKey,
  value: unknown,
): Record<string, unknown> {
  const next = cloneRecord(index)
  next.fields = updateFieldsAtPath(next.fields, pathParts, (field) => {
    if (value === undefined || value === '') {
      delete field[propertyName]
    } else {
      field[propertyName] = value
    }
    return field
  })
  return next
}

function setKeyField(index: Record<string, unknown>, pathParts: string[], checked: boolean): Record<string, unknown> {
  const targetPath = pathParts.join('.')
  const next = cloneRecord(index)
  next.fields = updateEveryField(next.fields, (field, currentPathParts) => {
    if (currentPathParts.join('.') === targetPath) {
      if (checked) field.key = true
      else delete field.key
      return field
    }
    if (checked && field.key === true) delete field.key
    return field
  })
  return next
}

function getAttributeRule(field: FieldSummary, attribute: FieldAttributeKey): FieldRule {
  if (attribute === 'stored') {
    return field.isVector
      ? { supported: true, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleVectorOnly' }
      : { supported: false, updateability: 'review', noteKey: 'indexBuilderFieldRuleVectorOnly' }
  }

  if (field.isComplex) {
    return { supported: false, updateability: 'review', noteKey: 'indexBuilderFieldRuleComplexNull' }
  }

  if (attribute === 'key') {
    return field.depth === 0 && field.type === 'Edm.String'
      ? { supported: true, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleKey' }
      : { supported: false, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleKey' }
  }

  if (attribute === 'retrievable') {
    return { supported: isSimpleField(field) || field.isVector, updateability: 'safe', noteKey: field.key ? 'indexBuilderFieldRuleKeyRetrievable' : 'indexBuilderFieldRuleSimpleField', required: field.key }
  }

  if (attribute === 'searchable') {
    if (field.isVector) return { supported: true, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleVectorSearchable', required: true }
    return isStringFieldType(field.type)
      ? { supported: true, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleStringSearch' }
      : { supported: false, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleStringSearch' }
  }

  if (attribute === 'filterable') {
    return field.isVector
      ? { supported: false, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleNonVectorSimple' }
      : { supported: isSimpleField(field), updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleNonVectorSimple' }
  }

  if (attribute === 'sortable') {
    const supported = isSimpleField(field) && !field.isVector && !field.isCollection && !field.underCollection
    return { supported, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleSingleValued' }
  }

  const supported = isSimpleField(field) && !field.isVector && field.type !== 'Edm.GeographyPoint' && field.type !== 'Collection(Edm.GeographyPoint)'
  return { supported, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleFacet' }
}

function getTextSettingRule(field: FieldSummary, setting: FieldTextSettingKey): FieldRule {
  if (setting === 'dimensions' || setting === 'vectorSearchProfile') {
    return field.isVector
      ? { supported: true, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleVectorOnly' }
      : { supported: false, updateability: 'review', noteKey: 'indexBuilderFieldRuleVectorOnly' }
  }

  if (field.isComplex || field.isVector) {
    return { supported: false, updateability: 'review', noteKey: field.isVector ? 'indexBuilderFieldRuleVectorNoLexical' : 'indexBuilderFieldRuleComplexNull' }
  }

  if (setting === 'normalizer') {
    return isStringFieldType(field.type)
      ? { supported: true, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleNormalizer' }
      : { supported: false, updateability: 'rebuild', noteKey: 'indexBuilderFieldRuleNormalizer' }
  }

  const supported = isStringFieldType(field.type) && field.searchable !== false
  return {
    supported,
    updateability: setting === 'searchAnalyzer' || setting === 'synonymMaps' ? 'safe' : 'rebuild',
    noteKey: 'indexBuilderFieldRuleSearchableStringOnly',
  }
}

function statusLabelKey(status: FeatureStatus): TranslationKey {
  if (status === 'configured') return 'indexBuilderFeatureConfigured'
  if (status === 'partial') return 'indexBuilderFeaturePartial'
  return 'indexBuilderFeatureMissing'
}

function severityLabelKey(severity: ImpactSeverity): TranslationKey {
  if (severity === 'safe') return 'indexBuilderSchemaImpactSafe'
  if (severity === 'rebuild') return 'indexBuilderSchemaImpactRebuild'
  return 'indexBuilderSchemaImpactReview'
}

function severityIcon(severity: ImpactSeverity): string {
  if (severity === 'safe') return 'bi-check2-circle'
  if (severity === 'rebuild') return 'bi-exclamation-octagon'
  return 'bi-search'
}

function updateabilityIcon(updateability: FieldUpdateability): string {
  if (updateability === 'safe') return 'bi-unlock'
  if (updateability === 'rebuild') return 'bi-lock'
  return 'bi-search'
}

function fieldRuleStatusKey(rule: FieldRule, isExistingIndex: boolean): TranslationKey {
  if (!rule.supported) return 'indexBuilderFieldStatusUnsupported'
  if (rule.required) return 'indexBuilderFieldStatusRequired'
  if (!isExistingIndex) return 'indexBuilderFieldStatusDraftEditable'
  if (rule.updateability === 'safe') return 'indexBuilderFieldStatusSafeUpdate'
  if (rule.updateability === 'rebuild') return 'indexBuilderFieldStatusRebuildLocked'
  return 'indexBuilderFieldStatusReview'
}

function fieldRuleSeverity(rule: FieldRule, isExistingIndex: boolean): ImpactSeverity {
  if (!rule.supported) return 'review'
  if (!isExistingIndex || rule.updateability === 'safe') return 'safe'
  if (rule.updateability === 'rebuild') return 'rebuild'
  return 'review'
}

function canEditRule(rule: FieldRule, isExistingIndex: boolean): boolean {
  return rule.supported && (!isExistingIndex || rule.updateability === 'safe')
}

function getTextSettingValue(field: FieldSummary, setting: FieldTextSettingKey): string {
  if (setting === 'synonymMaps') return field.synonymMaps.join(', ')
  if (setting === 'dimensions') return field.dimensions
  if (setting === 'vectorSearchProfile') return field.vectorSearchProfile
  return field[setting]
}

function formatMessage(t: (key: TranslationKey) => string, key: TranslationKey, name?: string): string {
  return t(key).replaceAll('{name}', name ?? '')
}

function buildFeatureCards(analysis: SchemaAnalysis): FeatureCard[] {
  const vectorStatus: FeatureStatus = analysis.vectorFields.length === 0
    ? 'missing'
    : analysis.vectorProfileCount > 0 && analysis.vectorFields.every((field) => !!field.vectorSearchProfile)
      ? 'configured'
      : 'partial'

  return [
    {
      id: 'fields',
      icon: 'bi-table',
      labelKey: 'indexBuilderFeatureFields',
      countLabel: String(analysis.topLevelFieldCount),
      status: analysis.topLevelFieldCount > 0 ? 'configured' : 'missing',
    },
    {
      id: 'vectorSearch',
      icon: 'bi-diagram-3',
      labelKey: 'indexBuilderFeatureVectorSearch',
      countLabel: `${analysis.vectorFields.length}/${analysis.vectorProfileCount}`,
      status: vectorStatus,
      templateKind: vectorStatus === 'configured' ? undefined : 'vectorSearch',
    },
    {
      id: 'semantic',
      icon: 'bi-stars',
      labelKey: 'indexBuilderFeatureSemantic',
      countLabel: String(analysis.semanticConfigCount),
      status: analysis.semanticConfigCount > 0 ? 'configured' : 'missing',
      templateKind: analysis.semanticConfigCount > 0 ? undefined : 'semantic',
    },
    {
      id: 'scoringProfiles',
      icon: 'bi-graph-up-arrow',
      labelKey: 'indexBuilderFeatureScoringProfiles',
      countLabel: String(analysis.scoringProfileCount),
      status: analysis.scoringProfileCount > 0 ? 'configured' : 'missing',
      templateKind: analysis.scoringProfileCount > 0 ? undefined : 'scoringProfile',
    },
    {
      id: 'suggesters',
      icon: 'bi-lightning-charge',
      labelKey: 'indexBuilderFeatureSuggesters',
      countLabel: String(analysis.suggesterCount),
      status: analysis.suggesterCount > 0 ? 'configured' : 'missing',
      templateKind: analysis.suggesterCount > 0 ? undefined : 'suggester',
    },
    {
      id: 'analyzers',
      icon: 'bi-braces',
      labelKey: 'indexBuilderFeatureAnalyzers',
      countLabel: String(analysis.analyzerCount),
      status: analysis.analyzerCount > 0 ? 'configured' : 'missing',
    },
    {
      id: 'normalizers',
      icon: 'bi-filter-square',
      labelKey: 'indexBuilderFeatureNormalizers',
      countLabel: String(analysis.normalizerCount),
      status: analysis.normalizerCount > 0 ? 'configured' : 'missing',
    },
    {
      id: 'cors',
      icon: 'bi-globe2',
      labelKey: 'indexBuilderFeatureCors',
      countLabel: analysis.corsConfigured ? '1' : '0',
      status: analysis.corsConfigured ? 'configured' : 'missing',
      templateKind: analysis.corsConfigured ? undefined : 'cors',
    },
    {
      id: 'encryption',
      icon: 'bi-shield-lock',
      labelKey: 'indexBuilderFeatureEncryption',
      countLabel: analysis.encryptionConfigured ? '1' : '0',
      status: analysis.encryptionConfigured ? 'configured' : 'missing',
    },
  ]
}

function AttributeIcon({ active, icon, label }: { active: boolean; icon: string; label: string }) {
  return (
    <span className={`indexSchemaFieldMatrix__attr ${active ? 'indexSchemaFieldMatrix__attr--active' : ''}`} title={label}>
      <i className={`bi ${icon}`}></i>
    </span>
  )
}

const fieldAttributeControls: Array<{ key: FieldAttributeKey; labelKey: TranslationKey; icon: string }> = [
  { key: 'key', labelKey: 'indexBuilderAttrKey', icon: 'bi-key' },
  { key: 'searchable', labelKey: 'indexBuilderAttrSearchable', icon: 'bi-search' },
  { key: 'filterable', labelKey: 'indexBuilderAttrFilterable', icon: 'bi-funnel' },
  { key: 'sortable', labelKey: 'indexBuilderAttrSortable', icon: 'bi-sort-alpha-down' },
  { key: 'facetable', labelKey: 'indexBuilderAttrFacetable', icon: 'bi-grid-3x3-gap' },
  { key: 'retrievable', labelKey: 'indexBuilderAttrRetrievable', icon: 'bi-eye' },
  { key: 'stored', labelKey: 'indexBuilderAttrStored', icon: 'bi-archive' },
]

const lexicalSettingControls: Array<{ key: FieldTextSettingKey; labelKey: TranslationKey; icon: string }> = [
  { key: 'analyzer', labelKey: 'indexBuilderAttrAnalyzer', icon: 'bi-braces' },
  { key: 'indexAnalyzer', labelKey: 'indexBuilderAttrIndexAnalyzer', icon: 'bi-box-arrow-in-down' },
  { key: 'searchAnalyzer', labelKey: 'indexBuilderAttrSearchAnalyzer', icon: 'bi-search' },
  { key: 'normalizer', labelKey: 'indexBuilderAttrNormalizer', icon: 'bi-filter-square' },
  { key: 'synonymMaps', labelKey: 'indexBuilderAttrSynonymMaps', icon: 'bi-diagram-2' },
]

const vectorSettingControls: Array<{ key: FieldTextSettingKey; labelKey: TranslationKey; icon: string }> = [
  { key: 'dimensions', labelKey: 'indexBuilderAttrDimensions', icon: 'bi-rulers' },
  { key: 'vectorSearchProfile', labelKey: 'indexBuilderAttrVectorProfile', icon: 'bi-diagram-3' },
]

type ConfigEditorTab = 'semantic' | 'scoringProfiles' | 'suggesters' | 'analyzers' | 'normalizers' | 'vectorProfiles'
type ScoringFunctionType = 'magnitude' | 'freshness' | 'distance' | 'tag'
type ScoringInterpolation = 'constant' | 'linear' | 'quadratic' | 'logarithmic'
type ConfigInputKind = 'text' | 'number' | 'boolean' | 'multiline' | 'select'

type ConfigInputOption = {
  key: string
  label: string
  tooltipKey: ConfigTooltipKey
  kind: ConfigInputKind
  values?: string[]
  placeholder?: string
}

const configEditorTabs: Array<{ id: ConfigEditorTab; labelKey: TranslationKey; icon: string }> = [
  { id: 'semantic', labelKey: 'indexBuilderEditorSemantic', icon: 'bi-stars' },
  { id: 'scoringProfiles', labelKey: 'indexBuilderEditorScoringProfiles', icon: 'bi-graph-up-arrow' },
  { id: 'suggesters', labelKey: 'indexBuilderEditorSuggesters', icon: 'bi-lightning-charge' },
  { id: 'analyzers', labelKey: 'indexBuilderEditorAnalyzers', icon: 'bi-braces' },
  { id: 'normalizers', labelKey: 'indexBuilderEditorNormalizers', icon: 'bi-filter-square' },
  { id: 'vectorProfiles', labelKey: 'indexBuilderEditorVectorProfiles', icon: 'bi-diagram-3' },
]

const scoringFunctionTypes: ScoringFunctionType[] = ['magnitude', 'freshness', 'distance', 'tag']
const scoringInterpolations: ScoringInterpolation[] = ['constant', 'linear', 'quadratic', 'logarithmic']

const indexConfigTooltips = {
  ja: {
    configName: '構成名です。同じ index 内の同種コレクションで一意にし、field や query から参照します。',
    odataType: 'カスタム analyzer/tokenizer/filter/normalizer の具体的な型を指定します。型により有効なオプションが変わります。',
    semanticDefaultConfig: 'query で semantic configuration を明示しない場合に使用される既定構成です。',
    semanticTitleField: 'semantic ranker がタイトルとして扱う searchable/retrievable な string field です。',
    rankingOrder: 'semantic reranker score だけで並べるか、boosted reranker score を使うかを指定します。',
    flightingOptIn: 'semantic ranking の実験的な処理に opt-in するための設定です。',
    contentFields: 'semantic ranking、captions、answers に使う本文 field です。優先順に指定します。',
    keywordFields: 'semantic ranking の補助 signal として使う keyword field です。優先順に指定します。',
    defaultScoringProfile: 'query が scoringProfile を指定しない場合に適用される既定 profile です。',
    functionAggregation: '複数の scoring function の boost を sum/average/minimum/maximum/firstMatching/product などで結合します。',
    textWeights: 'searchable string field の一致に正の倍率を掛け、同じ語でも field によって重みを変えます。',
    functionType: 'magnitude/freshness/distance/tag のいずれかです。function type は小文字で指定します。',
    scoringFieldName: 'scoring function の入力 field です。function は filterable field にのみ適用できます。',
    boost: 'raw score に掛ける正の倍率です。1.0 以外の正数を指定します。',
    interpolation: 'boost が範囲内でどう減衰するかを決める曲線です。linear が既定です。',
    boostingDuration: 'freshness の boost が効く期間です。P10D など XSD dayTimeDuration 形式で指定します。',
    boostingRangeStart: 'magnitude の boost 範囲の開始値です。範囲を逆にすると低い値を優先できます。',
    boostingRangeEnd: 'magnitude の boost 範囲の終了値です。start/end の間で補間されます。',
    constantBoostBeyondRange: 'magnitude の範囲外でも一定 boost を維持するかを指定します。',
    referencePointParameter: 'distance function に渡す query-time parameter 名です。scoringParameters から緯度経度を渡します。',
    boostingDistance: 'distance function の boost が効く距離範囲です。近い document ほど高くできます。',
    tagsParameter: 'tag function に渡す query-time parameter 名です。document の tag と query 側 tag が一致すると boost します。',
    suggesterSearchMode: 'suggester の検索モードです。現在は analyzingInfixMatching を指定します。',
    sourceFields: 'Autocomplete / Suggest API の候補生成に使う searchable string field の一覧です。',
    analyzerTokenizer: 'analyzer は tokenizer を必ず 1 つ持ちます。tokenizer が文字列を token に分割します。',
    analyzerCharFilters: 'tokenization 前に文字列を整形する char filter です。指定順に左から右へ適用されます。',
    analyzerTokenFilters: 'tokenizer 後に token を加工する token filter です。指定順に左から右へ適用されます。',
    maxTokenLength: 'tokenizer が生成する token の最大長です。長すぎる token を抑制します。',
    minGram: 'n-gram / edge n-gram で生成する最小 gram 長です。',
    maxGram: 'n-gram / edge n-gram で生成する最大 gram 長です。',
    tokenChars: 'n-gram tokenizer などで token に含める文字カテゴリです。',
    pattern: 'pattern tokenizer/filter/char filter が入力に適用する正規表現です。',
    flags: '正規表現に渡すフラグです。Java/Lucene の regex flags に従います。',
    group: 'pattern tokenizer が token として取り出す capture group です。',
    isSearchTokenizer: 'Microsoft language tokenizer を検索用 tokenizer として使うかを指定します。',
    language: 'Microsoft language tokenizer/stemmer/snowball などで使用する言語を指定します。',
    mappings: 'mapping char filter の変換規則です。a=>b 形式を 1 行ずつ指定します。',
    replacement: 'pattern_replace の置換文字列です。capture group を参照できます。',
    preserveOriginal: '変換後 token に加えて元 token も残すかを指定します。',
    side: 'edge n-gram を front/back のどちら側から生成するかを指定します。',
    articles: 'elision filter で除去する冠詞などの語を指定します。',
    words: 'keep words filter で保持する語の一覧です。',
    keepWordsCase: 'keep words filter で大文字小文字を区別するかを指定します。',
    keywords: 'keyword marker filter で stemmer から保護する語の一覧です。',
    min: 'length filter などで許容する最小 token 長です。',
    max: 'length filter などで許容する最大 token 長です。',
    maxTokenCount: 'limit token filter が保持する最大 token 数です。',
    consumeAllTokens: 'limit token filter が上限到達後も入力 token を消費するかを指定します。',
    patterns: 'pattern capture filter が token から取り出す正規表現パターンの一覧です。',
    encoder: 'phonetic filter の phonetic encoder を指定します。',
    replace: 'phonetic filter で元 token を置き換えるか、phonetic token を追加するかを指定します。',
    maxShingleSize: 'shingle filter で結合する最大 token 数です。',
    minShingleSize: 'shingle filter で結合する最小 token 数です。',
    outputUnigrams: 'shingle に加えて単語 token も出力するかを指定します。',
    outputUnigramsIfNoShingles: 'shingle が作れない場合に unigram を出力するかを指定します。',
    tokenSeparator: 'shingle filter が token を連結するときの区切り文字です。',
    filterToken: 'shingle filter で filler token として使う文字列です。',
    rules: 'stemmer override filter の上書き rule です。1 行に 1 rule を指定します。',
    stopwords: 'stopwords filter の除外語一覧です。',
    stopwordsList: '事前定義された stopwords list 名です。',
    ignoreCase: 'stopwords/synonym などで大文字小文字を無視するかを指定します。',
    removeTrailingStopWords: 'stopwords filter が末尾 stop word を除去するかを指定します。',
    synonyms: 'synonym token filter の synonym rule です。1 行に 1 rule を指定します。',
    expand: 'synonym rule を双方向に展開するかを指定します。',
    length: 'truncate token filter が token を切り詰める長さです。',
    onlyOnSamePosition: 'unique filter で同一位置の重複 token だけを削除するかを指定します。',
    wordDelimiterFlag: 'word delimiter filter の分割・結合・保持動作を制御します。',
    vectorProfileName: 'vector field の vectorSearchProfile から参照する profile 名です。',
    vectorAlgorithm: 'profile が使用する algorithm 名です。HNSW などの近傍探索構造を決めます。',
    vectorizer: 'query time vectorization に使う vectorizer 名です。profile 経由で vector field に紐づきます。',
    vectorCompression: 'profile が使用する compression 名です。quantization や rescoring を指定します。',
    vectorAlgorithmKind: 'HNSW または exhaustiveKnn です。安定 API では HNSW が基本です。',
    vectorMetric: 'embedding model に合う similarity metric です。Azure OpenAI では cosine が推奨です。',
    hnswM: 'HNSW の双方向リンク数です。既定 4、範囲 4-10。低いほど noise が少なくなりやすい設定です。',
    hnswEfConstruction: 'index 作成時に使う近傍候補数です。既定 400、範囲 100-1000。',
    hnswEfSearch: '検索時に使う近傍候補数です。既定 500、範囲 100-1000。',
    vectorizerKind: 'Azure OpenAI、AI Services Vision、Custom Web API など query time vectorization の方式です。',
    resourceUri: 'vectorizer が呼び出す Azure OpenAI / AI Services などの resource URI です。',
    deploymentId: 'Azure OpenAI vectorizer が使用する embedding model deployment 名です。',
    modelName: 'vectorizer が使用する embedding model 名です。field dimensions と整合させます。',
    apiKey: 'vectorizer 接続用 key です。可能なら managed identity を優先してください。',
    authIdentity: 'vectorizer が resource に接続する managed identity です。',
    vectorizerUri: 'Custom Web API vectorizer の endpoint URI です。',
    httpMethod: 'Custom Web API vectorizer を呼ぶ HTTP method です。',
    timeout: 'Custom Web API vectorizer 呼び出しの timeout です。',
    authResourceId: 'managed identity 認証で token を取得する対象 resource ID です。',
    compressionKind: 'scalarQuantization または binaryQuantization で vector を圧縮します。',
    rerankWithOriginalVectors: 'quantized vector の上位候補を元 vector で再計算して rerank するかを指定します。',
    defaultOversampling: 'quantization の情報損失を補うため内部候補数を k 倍で増やします。既定は 4 です。',
    quantizedDataType: 'scalar quantization のデータ型です。現在は int8 のみサポートされます。',
    truncationDimension: 'Matryoshka 対応 embedding を短い次元に切り詰める設定です。',
  },
  en: {
    configName: 'A configuration name. It must be unique within the same collection in an index and is referenced by fields or queries.',
    odataType: 'Identifies the concrete custom analyzer, tokenizer, filter, or normalizer type. Valid options depend on the type.',
    semanticDefaultConfig: 'The default semantic configuration used when a query does not specify one.',
    semanticTitleField: 'A searchable and retrievable string field treated as the title by semantic ranker.',
    rankingOrder: 'Controls whether ranking uses reranker score only or boosted reranker score.',
    flightingOptIn: 'Opts in to experimental semantic ranking behavior.',
    contentFields: 'Body fields used for semantic ranking, captions, and answers. Order them by priority.',
    keywordFields: 'Keyword fields used as supporting signals for semantic ranking. Order them by priority.',
    defaultScoringProfile: 'The default scoring profile applied when a query does not specify scoringProfile.',
    functionAggregation: 'Combines boosts from multiple scoring functions using sum, average, minimum, maximum, firstMatching, product, and related modes.',
    textWeights: 'Positive multipliers for searchable string fields so the same term can matter more in one field than another.',
    functionType: 'One of magnitude, freshness, distance, or tag. Function type values must be lowercase.',
    scoringFieldName: 'The input field for the scoring function. Functions only apply to filterable fields.',
    boost: 'A positive multiplier for the raw score. It must be positive and not equal to 1.0.',
    interpolation: 'The curve controlling how boost decays across the range. Linear is the default.',
    boostingDuration: 'Freshness boost duration, formatted as an XSD dayTimeDuration such as P10D.',
    boostingRangeStart: 'The starting value for a magnitude boost range. Reverse start/end to prefer lower values.',
    boostingRangeEnd: 'The ending value for a magnitude boost range. Boost is interpolated between start and end.',
    constantBoostBeyondRange: 'Whether magnitude keeps a constant boost beyond the configured range.',
    referencePointParameter: 'Query-time scoringParameters name supplying the latitude/longitude for a distance function.',
    boostingDistance: 'The distance range over which a distance boost applies. Closer documents can rank higher.',
    tagsParameter: 'Query-time scoringParameters name supplying tags. Matching document tags receive a boost.',
    suggesterSearchMode: 'Suggester search mode. Azure AI Search currently uses analyzingInfixMatching.',
    sourceFields: 'Searchable string fields used by Autocomplete and Suggest APIs to generate suggestions.',
    analyzerTokenizer: 'An analyzer requires exactly one tokenizer, which splits text into tokens.',
    analyzerCharFilters: 'Character filters prepare text before tokenization and are applied left to right.',
    analyzerTokenFilters: 'Token filters transform tokenizer output and are applied left to right.',
    maxTokenLength: 'Maximum token length emitted by the tokenizer.',
    minGram: 'Minimum gram length for n-gram and edge n-gram components.',
    maxGram: 'Maximum gram length for n-gram and edge n-gram components.',
    tokenChars: 'Character categories included in tokens by tokenizers such as n-gram.',
    pattern: 'Regular expression used by pattern tokenizer, filter, or character filter.',
    flags: 'Regex flags passed to Java/Lucene regular expression processing.',
    group: 'Capture group emitted as a token by pattern tokenizer.',
    isSearchTokenizer: 'Marks a Microsoft language tokenizer as a search tokenizer.',
    language: 'Language used by Microsoft language tokenizer, stemmer, or snowball processing.',
    mappings: 'Mapping character filter rules, one a=>b rule per line.',
    replacement: 'Replacement text for pattern_replace. Capture groups can be referenced.',
    preserveOriginal: 'Keeps the original token in addition to the transformed token.',
    side: 'Controls whether edge n-grams are generated from the front or back.',
    articles: 'Articles removed by the elision filter.',
    words: 'Terms retained by the keep words filter.',
    keepWordsCase: 'Controls case sensitivity for keep words.',
    keywords: 'Terms protected from stemming by keyword marker filter.',
    min: 'Minimum token length allowed by filters such as length.',
    max: 'Maximum token length allowed by filters such as length.',
    maxTokenCount: 'Maximum number of tokens retained by limit token filter.',
    consumeAllTokens: 'Whether limit token filter keeps consuming input after the limit is reached.',
    patterns: 'Pattern capture expressions, one regular expression per line.',
    encoder: 'Phonetic encoder used by the phonetic filter.',
    replace: 'Whether phonetic output replaces the original token or is added beside it.',
    maxShingleSize: 'Maximum number of tokens combined by shingle filter.',
    minShingleSize: 'Minimum number of tokens combined by shingle filter.',
    outputUnigrams: 'Emits original unigram tokens along with shingles.',
    outputUnigramsIfNoShingles: 'Emits unigram tokens when no shingles can be produced.',
    tokenSeparator: 'Separator used when shingle filter joins tokens.',
    filterToken: 'Filler token used by shingle filter.',
    rules: 'Stemmer override rules, one rule per line.',
    stopwords: 'Stopword terms removed by stopwords filter.',
    stopwordsList: 'Name of a predefined stopword list.',
    ignoreCase: 'Controls case-insensitive matching for stopwords, synonyms, and related filters.',
    removeTrailingStopWords: 'Controls whether trailing stopwords are removed.',
    synonyms: 'Synonym token filter rules, one rule per line.',
    expand: 'Expands synonym rules bidirectionally.',
    length: 'Token length used by truncate token filter.',
    onlyOnSamePosition: 'Unique filter removes duplicates only at the same token position when enabled.',
    wordDelimiterFlag: 'Controls splitting, concatenation, and preservation behavior in word delimiter filter.',
    vectorProfileName: 'Profile name referenced by vector fields through vectorSearchProfile.',
    vectorAlgorithm: 'Algorithm name used by the profile. It determines the nearest-neighbor navigation structure.',
    vectorizer: 'Vectorizer name used for query-time vectorization and linked to vector fields through a profile.',
    vectorCompression: 'Compression name used by the profile for quantization and rescoring behavior.',
    vectorAlgorithmKind: 'HNSW or exhaustiveKnn. Stable APIs primarily use HNSW.',
    vectorMetric: 'Similarity metric aligned to the embedding model. Cosine is recommended for Azure OpenAI embeddings.',
    hnswM: 'HNSW bidirectional link count. Default 4, range 4-10; lower values can reduce noise.',
    hnswEfConstruction: 'Number of nearest neighbors used during indexing. Default 400, range 100-1000.',
    hnswEfSearch: 'Number of nearest neighbors used during search. Default 500, range 100-1000.',
    vectorizerKind: 'Query-time vectorization kind such as Azure OpenAI, AI Services Vision, or Custom Web API.',
    resourceUri: 'Resource URI for Azure OpenAI, AI Services, or related vectorizer resources.',
    deploymentId: 'Azure OpenAI embedding model deployment used by the vectorizer.',
    modelName: 'Embedding model name used by the vectorizer. Keep it aligned with field dimensions.',
    apiKey: 'Connection key for the vectorizer resource. Prefer managed identity when possible.',
    authIdentity: 'Managed identity used by the vectorizer to connect to the resource.',
    vectorizerUri: 'Endpoint URI for a Custom Web API vectorizer.',
    httpMethod: 'HTTP method used when calling a Custom Web API vectorizer.',
    timeout: 'Timeout for Custom Web API vectorizer calls.',
    authResourceId: 'Resource ID used to acquire a managed identity token.',
    compressionKind: 'scalarQuantization or binaryQuantization for compressing vectors.',
    rerankWithOriginalVectors: 'Reranks quantized candidates using the original uncompressed vectors.',
    defaultOversampling: 'Increases internal candidate count by a multiplier to offset quantization loss. Default is 4.',
    quantizedDataType: 'Scalar quantization data type. int8 is currently supported.',
    truncationDimension: 'Truncates Matryoshka-capable embeddings to a shorter dimension.',
  },
} as const

type ConfigTooltipKey = keyof typeof indexConfigTooltips.ja

function ConfigInfo({ tooltipKey, language }: { tooltipKey: ConfigTooltipKey; language: Language }) {
  return <span className="infoTooltip" title={indexConfigTooltips[language][tooltipKey]}>ⓘ</span>
}

function ConfigLabel({ label, tooltipKey, language, className = 'field__label' }: {
  label: string
  tooltipKey: ConfigTooltipKey
  language: Language
  className?: string
}) {
  return (
    <span className={className}>
      <span>{label}</span>
      <ConfigInfo tooltipKey={tooltipKey} language={language} />
    </span>
  )
}

const scoringFunctionGuides = {
  ja: {
    magnitude: {
      title: 'Magnitude: 数値の大小で順位を押し上げる',
      desc: 'filterable な数値 field の値が指定範囲に入るほど boost します。rating、margin、downloadCount、price などに向いています。',
    },
    freshness: {
      title: 'Freshness: 新しさで順位を押し上げる',
      desc: 'Edm.DateTimeOffset の field を現在時刻からの距離として評価します。news、event、更新日など、最近の document を優先したいときに使います。',
    },
    distance: {
      title: 'Distance: 近さで順位を押し上げる',
      desc: 'Edm.GeographyPoint と query-time の reference point を比較します。店舗検索や「近くの候補」を上げる用途に向いています。',
    },
    tag: {
      title: 'Tag: query 側の tag と一致した document を押し上げる',
      desc: 'Edm.String / Collection(Edm.String) の tag field と scoringParameters の tag が一致したときに boost します。',
    },
    curveTitle: 'Boost curve preview',
    yAxis: 'boost',
    xAxis: 'distance / age / range',
    productHint: '複数 functions は functionAggregation で結合されます。product は全 signal で強い document を優先しやすい設定です。',
  },
  en: {
    magnitude: {
      title: 'Magnitude: boost by numeric value',
      desc: 'Boosts documents when a filterable numeric field falls within the configured range. Useful for ratings, margins, downloads, prices, and counts.',
    },
    freshness: {
      title: 'Freshness: boost by recency',
      desc: 'Evaluates an Edm.DateTimeOffset field as distance from now. Use it for news, events, updated dates, and content where recency should matter.',
    },
    distance: {
      title: 'Distance: boost by proximity',
      desc: 'Compares an Edm.GeographyPoint field with a query-time reference point. Useful for stores, facilities, and near-me scenarios.',
    },
    tag: {
      title: 'Tag: boost matching tags',
      desc: 'Boosts documents when Edm.String or Collection(Edm.String) tag fields match tags passed through scoringParameters.',
    },
    curveTitle: 'Boost curve preview',
    yAxis: 'boost',
    xAxis: 'distance / age / range',
    productHint: 'Multiple functions are combined by functionAggregation. product tends to favor documents that are strong across all signals.',
  },
} as const

function getInterpolationPath(interpolation: string): string {
  if (interpolation === 'constant') return 'M12 24 H132 L140 88 H148'
  if (interpolation === 'quadratic') return 'M12 18 C58 20 106 45 148 92'
  if (interpolation === 'logarithmic') return 'M12 18 C34 58 72 78 148 92'
  return 'M12 20 L148 92'
}

function ScoringFunctionGuide({ functionType, interpolation, boost, language }: {
  functionType: ScoringFunctionType
  interpolation: string
  boost: string
  language: Language
}) {
  const guide = scoringFunctionGuides[language]
  const current = guide[functionType]
  const normalizedInterpolation = interpolation || 'linear'
  return (
    <div className="indexSchemaConfigEditor__guide indexSchemaConfigEditor__guide--scoring">
      <div className="indexSchemaConfigEditor__guideText">
        <div className="indexSchemaConfigEditor__guideTitle">{current.title}</div>
        <div className="indexSchemaConfigEditor__guideDesc">{current.desc}</div>
        <div className="indexSchemaConfigEditor__guideHint">{guide.productHint}</div>
      </div>
      <div className="indexSchemaConfigEditor__curve" aria-label={guide.curveTitle}>
        <div className="indexSchemaConfigEditor__curveMeta">
          <span>{guide.curveTitle}</span>
          <strong>{normalizedInterpolation}</strong>
        </div>
        <svg viewBox="0 0 160 110" role="img" aria-label={`${normalizedInterpolation} ${guide.curveTitle}`}>
          <line x1="12" y1="96" x2="150" y2="96" />
          <line x1="12" y1="12" x2="12" y2="96" />
          <path d={getInterpolationPath(normalizedInterpolation)} />
          <circle cx="12" cy="20" r="3" />
          <circle cx="148" cy="92" r="3" />
        </svg>
        <div className="indexSchemaConfigEditor__curveAxes">
          <span>{guide.yAxis}</span>
          <span>{guide.xAxis}</span>
        </div>
        <div className="indexSchemaConfigEditor__curveBoost">boost × {boost || '2'}</div>
      </div>
    </div>
  )
}

const vectorGuideText = {
  ja: {
    title: 'Vector profile は vector field の実行計画です',
    desc: 'profile は algorithm、vectorizer、compression を名前で束ね、field 側の vectorSearchProfile から参照されます。HNSW は index/search の候補数を調整し、compression はメモリとディスクを抑え、必要なら元 vector で rerank します。',
    field: 'vector field',
    profile: 'profile',
    algorithm: 'algorithm',
    vectorizer: 'vectorizer',
    compression: 'compression',
    algorithmHint: 'HNSW / exhaustiveKnn',
    vectorizerHint: 'query text/image -> vector',
    compressionHint: 'quantization + rescoring',
  },
  en: {
    title: 'A vector profile is the execution plan for a vector field',
    desc: 'A profile binds an algorithm, vectorizer, and compression by name, then vector fields reference it through vectorSearchProfile. HNSW tunes indexing/search candidates, compression reduces memory and disk, and rescoring can rerank with original vectors.',
    field: 'vector field',
    profile: 'profile',
    algorithm: 'algorithm',
    vectorizer: 'vectorizer',
    compression: 'compression',
    algorithmHint: 'HNSW / exhaustiveKnn',
    vectorizerHint: 'query text/image -> vector',
    compressionHint: 'quantization + rescoring',
  },
} as const

function VectorSearchGuide({ profileCount, algorithmCount, vectorizerCount, compressionCount, language }: {
  profileCount: number
  algorithmCount: number
  vectorizerCount: number
  compressionCount: number
  language: Language
}) {
  const guide = vectorGuideText[language]
  return (
    <div className="indexSchemaConfigEditor__guide indexSchemaConfigEditor__guide--vector">
      <div className="indexSchemaConfigEditor__guideText">
        <div className="indexSchemaConfigEditor__guideTitle">{guide.title}</div>
        <div className="indexSchemaConfigEditor__guideDesc">{guide.desc}</div>
      </div>
      <div className="indexSchemaConfigEditor__vectorFlow" aria-label={guide.title}>
        <div className="indexSchemaConfigEditor__flowNode">
          <span>{guide.field}</span>
          <strong>vectorSearchProfile</strong>
        </div>
        <div className="indexSchemaConfigEditor__flowArrow">→</div>
        <div className="indexSchemaConfigEditor__flowNode indexSchemaConfigEditor__flowNode--accent">
          <span>{guide.profile}</span>
          <strong>{profileCount}</strong>
        </div>
        <div className="indexSchemaConfigEditor__flowArrow">→</div>
        <div className="indexSchemaConfigEditor__flowStack">
          <div><span>{guide.algorithm}</span><strong>{algorithmCount}</strong><em>{guide.algorithmHint}</em></div>
          <div><span>{guide.vectorizer}</span><strong>{vectorizerCount}</strong><em>{guide.vectorizerHint}</em></div>
          <div><span>{guide.compression}</span><strong>{compressionCount}</strong><em>{guide.compressionHint}</em></div>
        </div>
      </div>
    </div>
  )
}

function setOptionalRecordValue(record: Record<string, unknown>, propertyName: string, value: unknown): Record<string, unknown> {
  const next = { ...record }
  const shouldDelete =
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  if (shouldDelete) delete next[propertyName]
  else next[propertyName] = value
  return next
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function splitTextList(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function stringArrayToText(value: unknown): string {
  return asArray(value).map(asString).filter(Boolean).join('\n')
}

function fieldReferencesToText(value: unknown): string {
  return asArray(value)
    .map((item) => (isRecord(item) ? asString(item.fieldName) : asString(item)))
    .filter(Boolean)
    .join('\n')
}

function textToFieldReferences(value: string): Array<{ fieldName: string }> {
  return splitTextList(value).map((fieldName) => ({ fieldName }))
}

function getFieldReferenceName(field: FieldSummary): string {
  return field.pathParts.join('/')
}

function getFieldOptions(analysis: SchemaAnalysis, predicate: (field: FieldSummary) => boolean): string[] {
  return analysis.fields.filter(predicate).map(getFieldReferenceName)
}

function getTopLevelCollection(index: Record<string, unknown>, propertyName: string): Record<string, unknown>[] {
  return asArray(index[propertyName]).filter(isRecord)
}

function setTopLevelCollection(
  index: Record<string, unknown>,
  propertyName: string,
  collection: Record<string, unknown>[],
): Record<string, unknown> {
  const next = cloneRecord(index)
  next[propertyName] = collection
  return next
}

function updateTopLevelCollectionItem(
  index: Record<string, unknown>,
  propertyName: string,
  itemIndex: number,
  updater: (item: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const collection = getTopLevelCollection(index, propertyName)
  return setTopLevelCollection(
    index,
    propertyName,
    collection.map((item, currentIndex) => (currentIndex === itemIndex ? updater(cloneRecord(item)) : item)),
  )
}

function removeTopLevelCollectionItem(
  index: Record<string, unknown>,
  propertyName: string,
  itemIndex: number,
): Record<string, unknown> {
  return setTopLevelCollection(
    index,
    propertyName,
    getTopLevelCollection(index, propertyName).filter((_item, currentIndex) => currentIndex !== itemIndex),
  )
}

function getSemanticSection(index: Record<string, unknown>): Record<string, unknown> {
  return isRecord(index.semantic) ? index.semantic : {}
}

function updateSemanticSection(
  index: Record<string, unknown>,
  updater: (semantic: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const next = cloneRecord(index)
  const semantic = updater(cloneRecord(getSemanticSection(index)))
  if (Object.keys(semantic).length === 0) delete next.semantic
  else next.semantic = semantic
  return next
}

function getSemanticConfigurationsFromIndex(index: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(getSemanticSection(index).configurations).filter(isRecord)
}

function updateSemanticConfiguration(
  index: Record<string, unknown>,
  configurationIndex: number,
  updater: (configuration: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return updateSemanticSection(index, (semantic) => {
    const configurations = asArray(semantic.configurations).filter(isRecord)
    semantic.configurations = configurations.map((configuration, currentIndex) => (
      currentIndex === configurationIndex ? updater(cloneRecord(configuration)) : configuration
    ))
    return semantic
  })
}

function removeSemanticConfiguration(index: Record<string, unknown>, configurationIndex: number): Record<string, unknown> {
  return updateSemanticSection(index, (semantic) => {
    const configurations = asArray(semantic.configurations).filter(isRecord)
    const removedName = asString(configurations[configurationIndex]?.name)
    const nextConfigurations = configurations.filter((_configuration, currentIndex) => currentIndex !== configurationIndex)
    semantic.configurations = nextConfigurations
    if (removedName && asString(semantic.defaultConfiguration) === removedName) {
      const fallbackName = asString(nextConfigurations[0]?.name)
      if (fallbackName) semantic.defaultConfiguration = fallbackName
      else delete semantic.defaultConfiguration
    }
    return semantic
  })
}

function getPrioritizedFields(configuration: Record<string, unknown>): Record<string, unknown> {
  return isRecord(configuration.prioritizedFields) ? configuration.prioritizedFields : {}
}

function getSemanticList(configuration: Record<string, unknown>, canonicalKey: string, legacyKey: string): string {
  const prioritizedFields = getPrioritizedFields(configuration)
  return fieldReferencesToText(prioritizedFields[canonicalKey] ?? prioritizedFields[legacyKey])
}

function setSemanticList(
  configuration: Record<string, unknown>,
  canonicalKey: string,
  legacyKey: string,
  value: string,
): Record<string, unknown> {
  const prioritizedFields = { ...getPrioritizedFields(configuration) }
  delete prioritizedFields[legacyKey]
  const fieldReferences = textToFieldReferences(value)
  if (fieldReferences.length > 0) prioritizedFields[canonicalKey] = fieldReferences
  else delete prioritizedFields[canonicalKey]
  return setOptionalRecordValue(configuration, 'prioritizedFields', prioritizedFields)
}

function setSemanticTitleField(configuration: Record<string, unknown>, value: string): Record<string, unknown> {
  const prioritizedFields = { ...getPrioritizedFields(configuration) }
  const trimmed = value.trim()
  if (trimmed) prioritizedFields.titleField = { fieldName: trimmed }
  else delete prioritizedFields.titleField
  return setOptionalRecordValue(configuration, 'prioritizedFields', prioritizedFields)
}

function getScoringProfiles(index: Record<string, unknown>): Record<string, unknown>[] {
  return getTopLevelCollection(index, 'scoringProfiles')
}

function getScoringWeightsText(profile: Record<string, unknown>): string {
  const text = isRecord(profile.text) ? profile.text : {}
  const weights = isRecord(text.weights) ? text.weights : {}
  return Object.entries(weights)
    .map(([fieldName, weight]) => `${fieldName}=${typeof weight === 'number' || typeof weight === 'string' ? String(weight) : ''}`)
    .join('\n')
}

function parseScoringWeights(value: string): Record<string, number> {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<Record<string, number>>((weights, line) => {
      const separatorIndex = line.includes('=') ? line.indexOf('=') : line.indexOf(':')
      if (separatorIndex <= 0) return weights
      const fieldName = line.slice(0, separatorIndex).trim()
      const weightValue = Number(line.slice(separatorIndex + 1).trim())
      if (fieldName && Number.isFinite(weightValue)) weights[fieldName] = weightValue
      return weights
    }, {})
}

function setScoringWeights(profile: Record<string, unknown>, value: string): Record<string, unknown> {
  const weights = parseScoringWeights(value)
  if (Object.keys(weights).length === 0) {
    const next = { ...profile }
    delete next.text
    return next
  }
  const text = isRecord(profile.text) ? { ...profile.text } : {}
  text.weights = weights
  return { ...profile, text }
}

function getScoringFunctions(profile: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(profile.functions).filter(isRecord)
}

function setScoringFunctions(profile: Record<string, unknown>, functions: Record<string, unknown>[]): Record<string, unknown> {
  return setOptionalRecordValue(profile, 'functions', functions)
}

function updateScoringFunction(
  profile: Record<string, unknown>,
  functionIndex: number,
  updater: (scoringFunction: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const functions = getScoringFunctions(profile).map((scoringFunction, currentIndex) => (
    currentIndex === functionIndex ? updater(cloneRecord(scoringFunction)) : scoringFunction
  ))
  return setScoringFunctions(profile, functions)
}

function getScoringFunctionType(scoringFunction: Record<string, unknown>): ScoringFunctionType {
  const explicitType = asString(scoringFunction.type) as ScoringFunctionType
  if (scoringFunctionTypes.includes(explicitType)) return explicitType
  return scoringFunctionTypes.find((type) => isRecord(scoringFunction[type])) ?? 'magnitude'
}

function getScoringFunctionParameters(scoringFunction: Record<string, unknown>, type: ScoringFunctionType): Record<string, unknown> {
  if (isRecord(scoringFunction[type])) return scoringFunction[type]
  if (isRecord(scoringFunction.parameters)) return scoringFunction.parameters
  return {}
}

function setScoringFunctionType(scoringFunction: Record<string, unknown>, type: ScoringFunctionType): Record<string, unknown> {
  const next: Record<string, unknown> = { ...scoringFunction, type }
  delete next.parameters
  for (const functionType of scoringFunctionTypes) {
    if (functionType !== type) delete next[functionType]
  }
  if (!isRecord(next[type])) next[type] = {}
  return next
}

function setScoringFunctionParameter(
  scoringFunction: Record<string, unknown>,
  type: ScoringFunctionType,
  parameterName: string,
  value: unknown,
): Record<string, unknown> {
  const next = setScoringFunctionType(scoringFunction, type)
  const parameters = setOptionalRecordValue(getScoringFunctionParameters(next, type), parameterName, value)
  if (Object.keys(parameters).length === 0) delete next[type]
  else next[type] = parameters
  return next
}

function getVectorSearchRecord(index: Record<string, unknown>): Record<string, unknown> {
  return isRecord(index.vectorSearch) ? index.vectorSearch : {}
}

function updateVectorSearch(
  index: Record<string, unknown>,
  updater: (vectorSearch: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const next = cloneRecord(index)
  next.vectorSearch = updater(cloneRecord(getVectorSearchRecord(index)))
  return next
}

function getVectorSearchCollection(index: Record<string, unknown>, propertyName: string): Record<string, unknown>[] {
  return asArray(getVectorSearchRecord(index)[propertyName]).filter(isRecord)
}

function updateVectorSearchCollectionItem(
  index: Record<string, unknown>,
  propertyName: string,
  itemIndex: number,
  updater: (item: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return updateVectorSearch(index, (vectorSearch) => {
    const collection = asArray(vectorSearch[propertyName]).filter(isRecord)
    vectorSearch[propertyName] = collection.map((item, currentIndex) => (
      currentIndex === itemIndex ? updater(cloneRecord(item)) : item
    ))
    return vectorSearch
  })
}

function removeVectorSearchCollectionItem(
  index: Record<string, unknown>,
  propertyName: string,
  itemIndex: number,
): Record<string, unknown> {
  return updateVectorSearch(index, (vectorSearch) => {
    vectorSearch[propertyName] = asArray(vectorSearch[propertyName]).filter((_item, currentIndex) => currentIndex !== itemIndex)
    return vectorSearch
  })
}

function getAlgorithmParameters(algorithm: Record<string, unknown>): Record<string, unknown> {
  const kind = asString(algorithm.kind) || 'hnsw'
  const propertyName = kind === 'exhaustiveKnn' ? 'exhaustiveKnnParameters' : 'hnswParameters'
  return isRecord(algorithm[propertyName]) ? algorithm[propertyName] : {}
}

function setAlgorithmParameter(algorithm: Record<string, unknown>, parameterName: string, value: unknown): Record<string, unknown> {
  const kind = asString(algorithm.kind) || 'hnsw'
  const propertyName = kind === 'exhaustiveKnn' ? 'exhaustiveKnnParameters' : 'hnswParameters'
  const parameters = setOptionalRecordValue(getAlgorithmParameters(algorithm), parameterName, value)
  return { ...algorithm, [propertyName]: parameters }
}

function FieldOptionsDatalist({ id, options }: { id: string; options: string[] }) {
  return (
    <datalist id={id}>
      {options.map((option) => <option key={option} value={option} />)}
    </datalist>
  )
}

function EmptyFeatureNotice({ label }: { label: string }) {
  return <div className="empty indexSchemaConfigEditor__empty">{label}</div>
}

function SemanticConfigEditor({ analysis, t, language, onChangeIndex }: {
  analysis: SchemaAnalysis
  t: (key: TranslationKey) => string
  language: Language
  onChangeIndex: (nextIndex: Record<string, unknown>) => void
}) {
  const semantic = getSemanticSection(analysis.index)
  const configurations = getSemanticConfigurationsFromIndex(analysis.index)
  const configNames = configurations.map((configuration) => asString(configuration.name)).filter(Boolean)
  const semanticFieldOptions = getFieldOptions(
    analysis,
    (field) => isStringFieldType(field.type) && field.searchable !== false && field.retrievable !== false,
  )

  const addConfiguration = () => {
    const name = uniqueName(configNames, 'default')
    const firstContentField = semanticFieldOptions[0] ?? ''
    const nextIndex = updateSemanticSection(analysis.index, (nextSemantic) => {
      const nextConfigurations = asArray(nextSemantic.configurations).filter(isRecord)
      nextSemantic.configurations = [
        ...nextConfigurations,
        {
          name,
          prioritizedFields: firstContentField ? { prioritizedContentFields: [{ fieldName: firstContentField }] } : {},
        },
      ]
      if (!asString(nextSemantic.defaultConfiguration)) nextSemantic.defaultConfiguration = name
      return nextSemantic
    })
    onChangeIndex(nextIndex)
  }

  return (
    <section className="indexSchemaConfigEditor__section">
      <div className="indexSchemaConfigEditor__toolbar">
        <label className="field indexSchemaConfigEditor__toolbarField">
          <ConfigLabel label={t('indexBuilderDefaultSemanticConfig')} tooltipKey="semanticDefaultConfig" language={language} />
          <input
            className="field__input"
            list="indexBuilderSemanticConfigurationNames"
            value={asString(semantic.defaultConfiguration)}
            onChange={(event) => onChangeIndex(updateSemanticSection(analysis.index, (nextSemantic) => setOptionalRecordValue(nextSemantic, 'defaultConfiguration', event.currentTarget.value)))}
            placeholder={t('indexBuilderNone')}
          />
        </label>
        <button type="button" className="btn btn--sm" onClick={addConfiguration}>
          <i className="bi bi-plus-lg icon--mr6"></i>
          {t('indexBuilderAddSemanticConfig')}
        </button>
        <FieldOptionsDatalist id="indexBuilderSemanticConfigurationNames" options={configNames} />
      </div>

      {configurations.length === 0 ? <EmptyFeatureNotice label={t('indexBuilderNoSemanticConfigs')} /> : null}

      <div className="indexSchemaConfigEditor__cards">
        {configurations.map((configuration, configurationIndex) => {
          const prioritizedFields = getPrioritizedFields(configuration)
          const titleField = isRecord(prioritizedFields.titleField) ? asString(prioritizedFields.titleField.fieldName) : ''
          return (
            <div key={`${configurationIndex}-${asString(configuration.name)}`} className="indexSchemaConfigEditor__card">
              <div className="indexSchemaConfigEditor__cardHeader">
                <label className="field">
                  <ConfigLabel label={t('indexBuilderConfigName')} tooltipKey="configName" language={language} />
                  <input
                    className="field__input"
                    value={asString(configuration.name)}
                    onChange={(event) => onChangeIndex(updateSemanticConfiguration(analysis.index, configurationIndex, (nextConfiguration) => setOptionalRecordValue(nextConfiguration, 'name', event.currentTarget.value)))}
                    placeholder="default"
                  />
                </label>
                <button type="button" className="btn btn--mini" onClick={() => onChangeIndex(removeSemanticConfiguration(analysis.index, configurationIndex))}>
                  <i className="bi bi-trash icon--mr6"></i>
                  {t('indexBuilderRemoveItem')}
                </button>
              </div>

              <div className="indexSchemaConfigEditor__grid">
                <label className="field">
                  <ConfigLabel label={t('indexBuilderTitleField')} tooltipKey="semanticTitleField" language={language} />
                  <input
                    className="field__input"
                    list="indexBuilderSemanticFieldOptions"
                    value={titleField}
                    onChange={(event) => onChangeIndex(updateSemanticConfiguration(analysis.index, configurationIndex, (nextConfiguration) => setSemanticTitleField(nextConfiguration, event.currentTarget.value)))}
                    placeholder={t('indexBuilderNone')}
                  />
                </label>
                <label className="field">
                  <ConfigLabel label={t('indexBuilderRankingOrder')} tooltipKey="rankingOrder" language={language} />
                  <select
                    className="field__input"
                    value={asString(configuration.rankingOrder)}
                    onChange={(event) => onChangeIndex(updateSemanticConfiguration(analysis.index, configurationIndex, (nextConfiguration) => setOptionalRecordValue(nextConfiguration, 'rankingOrder', event.currentTarget.value)))}
                  >
                    <option value="">{t('indexBuilderNone')}</option>
                    <option value="rerankerScore">rerankerScore</option>
                    <option value="boostedRerankerScore">boostedRerankerScore</option>
                  </select>
                </label>
                <label className="indexSchemaConfigEditor__checkbox">
                  <input
                    type="checkbox"
                    checked={configuration.flightingOptIn === true}
                    onChange={(event) => onChangeIndex(updateSemanticConfiguration(analysis.index, configurationIndex, (nextConfiguration) => setOptionalRecordValue(nextConfiguration, 'flightingOptIn', event.currentTarget.checked ? true : undefined)))}
                  />
                  <ConfigLabel label={t('indexBuilderFlightingOptIn')} tooltipKey="flightingOptIn" language={language} className="indexSchemaConfigEditor__checkboxLabel" />
                </label>
                <label className="field field--full">
                  <ConfigLabel label={t('indexBuilderContentFields')} tooltipKey="contentFields" language={language} />
                  <textarea
                    className="field__input"
                    rows={3}
                    value={getSemanticList(configuration, 'prioritizedContentFields', 'contentFields')}
                    onChange={(event) => onChangeIndex(updateSemanticConfiguration(analysis.index, configurationIndex, (nextConfiguration) => setSemanticList(nextConfiguration, 'prioritizedContentFields', 'contentFields', event.currentTarget.value)))}
                    placeholder={t('indexBuilderFieldListPlaceholder')}
                  />
                </label>
                <label className="field field--full">
                  <ConfigLabel label={t('indexBuilderKeywordFields')} tooltipKey="keywordFields" language={language} />
                  <textarea
                    className="field__input"
                    rows={3}
                    value={getSemanticList(configuration, 'prioritizedKeywordsFields', 'keywordsFields')}
                    onChange={(event) => onChangeIndex(updateSemanticConfiguration(analysis.index, configurationIndex, (nextConfiguration) => setSemanticList(nextConfiguration, 'prioritizedKeywordsFields', 'keywordsFields', event.currentTarget.value)))}
                    placeholder={t('indexBuilderFieldListPlaceholder')}
                  />
                </label>
              </div>
            </div>
          )
        })}
      </div>
      <FieldOptionsDatalist id="indexBuilderSemanticFieldOptions" options={semanticFieldOptions} />
    </section>
  )
}

function ScoringProfilesEditor({ analysis, t, language, onChangeIndex }: {
  analysis: SchemaAnalysis
  t: (key: TranslationKey) => string
  language: Language
  onChangeIndex: (nextIndex: Record<string, unknown>) => void
}) {
  const profiles = getScoringProfiles(analysis.index)
  const profileNames = profiles.map((profile) => asString(profile.name)).filter(Boolean)
  const searchableFieldOptions = getFieldOptions(analysis, (field) => field.searchable === true && !field.isVector)
  const functionFieldOptions = getFieldOptions(analysis, (field) => field.filterable === true && !field.isVector)

  const addProfile = () => {
    const name = uniqueName(profileNames, 'text-boost')
    const firstSearchableField = searchableFieldOptions[0] ?? ''
    const nextProfile: Record<string, unknown> = {
      name,
      text: { weights: firstSearchableField ? { [firstSearchableField]: 2 } : {} },
      functions: [],
    }
    onChangeIndex(setTopLevelCollection(analysis.index, 'scoringProfiles', [...profiles, nextProfile]))
  }

  return (
    <section className="indexSchemaConfigEditor__section">
      <div className="indexSchemaConfigEditor__toolbar">
        <label className="field indexSchemaConfigEditor__toolbarField">
          <ConfigLabel label={t('indexBuilderDefaultScoringProfile')} tooltipKey="defaultScoringProfile" language={language} />
          <input
            className="field__input"
            list="indexBuilderScoringProfileNames"
            value={asString(analysis.index.defaultScoringProfile)}
            onChange={(event) => onChangeIndex(setOptionalRecordValue(analysis.index, 'defaultScoringProfile', event.currentTarget.value))}
            placeholder={t('indexBuilderNone')}
          />
        </label>
        <button type="button" className="btn btn--sm" onClick={addProfile}>
          <i className="bi bi-plus-lg icon--mr6"></i>
          {t('indexBuilderAddScoringProfile')}
        </button>
        <FieldOptionsDatalist id="indexBuilderScoringProfileNames" options={profileNames} />
      </div>

      {profiles.length === 0 ? <EmptyFeatureNotice label={t('indexBuilderNoScoringProfiles')} /> : null}

      <div className="indexSchemaConfigEditor__cards">
        {profiles.map((profile, profileIndex) => {
          const functions = getScoringFunctions(profile)
          return (
            <div key={`${profileIndex}-${asString(profile.name)}`} className="indexSchemaConfigEditor__card">
              <div className="indexSchemaConfigEditor__cardHeader">
                <label className="field">
                  <ConfigLabel label={t('indexBuilderConfigName')} tooltipKey="configName" language={language} />
                  <input
                    className="field__input"
                    value={asString(profile.name)}
                    onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => setOptionalRecordValue(nextProfile, 'name', event.currentTarget.value)))}
                  />
                </label>
                <label className="field">
                  <ConfigLabel label={t('indexBuilderFunctionAggregation')} tooltipKey="functionAggregation" language={language} />
                  <select
                    className="field__input"
                    value={asString(profile.functionAggregation)}
                    onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => setOptionalRecordValue(nextProfile, 'functionAggregation', event.currentTarget.value)))}
                  >
                    <option value="">{t('indexBuilderNone')}</option>
                    <option value="sum">sum</option>
                    <option value="average">average</option>
                    <option value="minimum">minimum</option>
                    <option value="maximum">maximum</option>
                    <option value="firstMatching">firstMatching</option>
                    <option value="product">product</option>
                  </select>
                </label>
                <button type="button" className="btn btn--mini" onClick={() => onChangeIndex(removeTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex))}>
                  <i className="bi bi-trash icon--mr6"></i>
                  {t('indexBuilderRemoveItem')}
                </button>
              </div>

              <div className="indexSchemaConfigEditor__grid">
                <label className="field field--full">
                  <ConfigLabel label={t('indexBuilderTextWeights')} tooltipKey="textWeights" language={language} />
                  <textarea
                    className="field__input"
                    rows={4}
                    value={getScoringWeightsText(profile)}
                    onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => setScoringWeights(nextProfile, event.currentTarget.value)))}
                    placeholder={t('indexBuilderTextWeightsPlaceholder')}
                  />
                </label>
              </div>

              <div className="indexSchemaConfigEditor__subHeader">
                <span>{t('indexBuilderScoringFunctions')}</span>
                <button
                  type="button"
                  className="btn btn--mini"
                  onClick={() => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => setScoringFunctions(nextProfile, [
                    ...getScoringFunctions(nextProfile),
                    { type: 'magnitude', fieldName: functionFieldOptions[0] ?? '', boost: 2, interpolation: 'linear', magnitude: {} },
                  ])))}
                >
                  <i className="bi bi-plus-lg icon--mr6"></i>
                  {t('indexBuilderAddFunction')}
                </button>
              </div>

              <div className="indexSchemaConfigEditor__nestedCards">
                {functions.map((scoringFunction, functionIndex) => {
                  const functionType = getScoringFunctionType(scoringFunction)
                  const parameters = getScoringFunctionParameters(scoringFunction, functionType)
                  return (
                    <div key={`${functionIndex}-${asString(scoringFunction.fieldName)}`} className="indexSchemaConfigEditor__nestedCard">
                      <ScoringFunctionGuide
                        functionType={functionType}
                        interpolation={asString(scoringFunction.interpolation)}
                        boost={asNumberOrString(scoringFunction.boost)}
                        language={language}
                      />
                      <div className="indexSchemaConfigEditor__grid indexSchemaConfigEditor__grid--compact">
                        <label className="field">
                          <ConfigLabel label={t('indexBuilderFunctionType')} tooltipKey="functionType" language={language} />
                          <select
                            className="field__input"
                            value={functionType}
                            onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => updateScoringFunction(nextProfile, functionIndex, (nextFunction) => setScoringFunctionType(nextFunction, event.currentTarget.value as ScoringFunctionType))))}
                          >
                            {scoringFunctionTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                          </select>
                        </label>
                        <label className="field">
                          <ConfigLabel label={t('indexBuilderFieldName')} tooltipKey="scoringFieldName" language={language} />
                          <input
                            className="field__input"
                            list="indexBuilderScoringFunctionFieldOptions"
                            value={asString(scoringFunction.fieldName)}
                            onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => updateScoringFunction(nextProfile, functionIndex, (nextFunction) => setOptionalRecordValue(nextFunction, 'fieldName', event.currentTarget.value))))}
                          />
                        </label>
                        <label className="field">
                          <ConfigLabel label={t('indexBuilderBoost')} tooltipKey="boost" language={language} />
                          <input
                            className="field__input"
                            type="number"
                            value={asNumberOrString(scoringFunction.boost)}
                            onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => updateScoringFunction(nextProfile, functionIndex, (nextFunction) => setOptionalRecordValue(nextFunction, 'boost', parseOptionalNumber(event.currentTarget.value)))))}
                          />
                        </label>
                        <label className="field">
                          <ConfigLabel label={t('indexBuilderInterpolation')} tooltipKey="interpolation" language={language} />
                          <select
                            className="field__input"
                            value={asString(scoringFunction.interpolation)}
                            onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => updateScoringFunction(nextProfile, functionIndex, (nextFunction) => setOptionalRecordValue(nextFunction, 'interpolation', event.currentTarget.value))))}
                          >
                            <option value="">{t('indexBuilderNone')}</option>
                            {scoringInterpolations.map((interpolation) => <option key={interpolation} value={interpolation}>{interpolation}</option>)}
                          </select>
                        </label>

                        {functionType === 'freshness' ? (
                          <label className="field">
                            <ConfigLabel label={t('indexBuilderBoostingDuration')} tooltipKey="boostingDuration" language={language} />
                            <input
                              className="field__input"
                              value={asString(parameters.boostingDuration)}
                              onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => updateScoringFunction(nextProfile, functionIndex, (nextFunction) => setScoringFunctionParameter(nextFunction, functionType, 'boostingDuration', event.currentTarget.value))))}
                              placeholder="P30D"
                            />
                          </label>
                        ) : null}

                        {functionType === 'magnitude' ? (
                          <>
                            <label className="field">
                              <ConfigLabel label={t('indexBuilderBoostingRangeStart')} tooltipKey="boostingRangeStart" language={language} />
                              <input
                                className="field__input"
                                type="number"
                                value={asNumberOrString(parameters.boostingRangeStart)}
                                onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => updateScoringFunction(nextProfile, functionIndex, (nextFunction) => setScoringFunctionParameter(nextFunction, functionType, 'boostingRangeStart', parseOptionalNumber(event.currentTarget.value)))))}
                              />
                            </label>
                            <label className="field">
                              <ConfigLabel label={t('indexBuilderBoostingRangeEnd')} tooltipKey="boostingRangeEnd" language={language} />
                              <input
                                className="field__input"
                                type="number"
                                value={asNumberOrString(parameters.boostingRangeEnd)}
                                onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => updateScoringFunction(nextProfile, functionIndex, (nextFunction) => setScoringFunctionParameter(nextFunction, functionType, 'boostingRangeEnd', parseOptionalNumber(event.currentTarget.value)))))}
                              />
                            </label>
                            <label className="indexSchemaConfigEditor__checkbox">
                              <input
                                type="checkbox"
                                checked={parameters.constantBoostBeyondRange === true}
                                onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => updateScoringFunction(nextProfile, functionIndex, (nextFunction) => setScoringFunctionParameter(nextFunction, functionType, 'constantBoostBeyondRange', event.currentTarget.checked ? true : undefined))))}
                              />
                              <ConfigLabel label={t('indexBuilderConstantBoostBeyondRange')} tooltipKey="constantBoostBeyondRange" language={language} className="indexSchemaConfigEditor__checkboxLabel" />
                            </label>
                          </>
                        ) : null}

                        {functionType === 'distance' ? (
                          <>
                            <label className="field">
                              <ConfigLabel label={t('indexBuilderReferencePointParameter')} tooltipKey="referencePointParameter" language={language} />
                              <input
                                className="field__input"
                                value={asString(parameters.referencePointParameter)}
                                onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => updateScoringFunction(nextProfile, functionIndex, (nextFunction) => setScoringFunctionParameter(nextFunction, functionType, 'referencePointParameter', event.currentTarget.value))))}
                              />
                            </label>
                            <label className="field">
                              <ConfigLabel label={t('indexBuilderBoostingDistance')} tooltipKey="boostingDistance" language={language} />
                              <input
                                className="field__input"
                                type="number"
                                value={asNumberOrString(parameters.boostingDistance)}
                                onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => updateScoringFunction(nextProfile, functionIndex, (nextFunction) => setScoringFunctionParameter(nextFunction, functionType, 'boostingDistance', parseOptionalNumber(event.currentTarget.value)))))}
                              />
                            </label>
                          </>
                        ) : null}

                        {functionType === 'tag' ? (
                          <label className="field">
                            <ConfigLabel label={t('indexBuilderTagsParameter')} tooltipKey="tagsParameter" language={language} />
                            <input
                              className="field__input"
                              value={asString(parameters.tagsParameter)}
                              onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => updateScoringFunction(nextProfile, functionIndex, (nextFunction) => setScoringFunctionParameter(nextFunction, functionType, 'tagsParameter', event.currentTarget.value))))}
                            />
                          </label>
                        ) : null}
                      </div>
                      <button
                        type="button"
                        className="btn btn--mini"
                        onClick={() => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'scoringProfiles', profileIndex, (nextProfile) => setScoringFunctions(nextProfile, getScoringFunctions(nextProfile).filter((_scoringFunction, currentIndex) => currentIndex !== functionIndex))))}
                      >
                        <i className="bi bi-trash icon--mr6"></i>
                        {t('indexBuilderRemoveItem')}
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <FieldOptionsDatalist id="indexBuilderScoringFunctionFieldOptions" options={functionFieldOptions} />
    </section>
  )
}

function SuggestersEditor({ analysis, t, language, onChangeIndex }: {
  analysis: SchemaAnalysis
  t: (key: TranslationKey) => string
  language: Language
  onChangeIndex: (nextIndex: Record<string, unknown>) => void
}) {
  const suggesters = getTopLevelCollection(analysis.index, 'suggesters')
  const sourceFieldOptions = getFieldOptions(analysis, (field) => isStringFieldType(field.type) && field.searchable === true)
  const addSuggester = () => {
    const name = uniqueName(suggesters.map((suggester) => asString(suggester.name)).filter(Boolean), 'sg')
    onChangeIndex(setTopLevelCollection(analysis.index, 'suggesters', [
      ...suggesters,
      { name, searchMode: 'analyzingInfixMatching', sourceFields: sourceFieldOptions.slice(0, 3) },
    ]))
  }

  return (
    <section className="indexSchemaConfigEditor__section">
      <div className="indexSchemaConfigEditor__toolbar">
        <button type="button" className="btn btn--sm" onClick={addSuggester}>
          <i className="bi bi-plus-lg icon--mr6"></i>
          {t('indexBuilderAddSuggester')}
        </button>
      </div>
      {suggesters.length === 0 ? <EmptyFeatureNotice label={t('indexBuilderNoSuggesters')} /> : null}
      <div className="indexSchemaConfigEditor__cards">
        {suggesters.map((suggester, suggesterIndex) => (
          <div key={`${suggesterIndex}-${asString(suggester.name)}`} className="indexSchemaConfigEditor__card">
            <div className="indexSchemaConfigEditor__cardHeader">
              <label className="field">
                <ConfigLabel label={t('indexBuilderConfigName')} tooltipKey="configName" language={language} />
                <input
                  className="field__input"
                  value={asString(suggester.name)}
                  onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'suggesters', suggesterIndex, (nextSuggester) => setOptionalRecordValue(nextSuggester, 'name', event.currentTarget.value)))}
                />
              </label>
              <label className="field">
                <ConfigLabel label={t('indexBuilderSearchMode')} tooltipKey="suggesterSearchMode" language={language} />
                <select
                  className="field__input"
                  value={asString(suggester.searchMode) || 'analyzingInfixMatching'}
                  onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'suggesters', suggesterIndex, (nextSuggester) => setOptionalRecordValue(nextSuggester, 'searchMode', event.currentTarget.value)))}
                >
                  <option value="analyzingInfixMatching">analyzingInfixMatching</option>
                </select>
              </label>
              <button type="button" className="btn btn--mini" onClick={() => onChangeIndex(removeTopLevelCollectionItem(analysis.index, 'suggesters', suggesterIndex))}>
                <i className="bi bi-trash icon--mr6"></i>
                {t('indexBuilderRemoveItem')}
              </button>
            </div>
            <label className="field field--full">
              <ConfigLabel label={t('indexBuilderSourceFields')} tooltipKey="sourceFields" language={language} />
              <textarea
                className="field__input"
                rows={4}
                value={stringArrayToText(suggester.sourceFields)}
                onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'suggesters', suggesterIndex, (nextSuggester) => setOptionalRecordValue(nextSuggester, 'sourceFields', splitTextList(event.currentTarget.value))))}
                placeholder={t('indexBuilderFieldListPlaceholder')}
              />
            </label>
          </div>
        ))}
      </div>
      <FieldOptionsDatalist id="indexBuilderSuggesterFieldOptions" options={sourceFieldOptions} />
    </section>
  )
}

function getTypeName(record: Record<string, unknown>): string {
  return asString(record['@odata.type']).replace('#Microsoft.Azure.Search.', '').toLowerCase()
}

function getNestedRecord(record: Record<string, unknown>, propertyName: string): Record<string, unknown> {
  return isRecord(record[propertyName]) ? record[propertyName] : {}
}

function getOptionValue(record: Record<string, unknown>, option: ConfigInputOption): string {
  const value = record[option.key]
  if (option.kind === 'multiline') return stringArrayToText(value)
  return asNumberOrString(value) || asString(value)
}

function parseOptionValue(option: ConfigInputOption, value: string): unknown {
  if (option.kind === 'multiline') return splitTextList(value)
  if (option.kind === 'number') return parseOptionalNumber(value)
  return value.trim() || undefined
}

function ConfigOptionField({ record, option, language, onApply, className }: {
  record: Record<string, unknown>
  option: ConfigInputOption
  language: Language
  onApply: (nextRecord: Record<string, unknown>) => void
  className?: string
}) {
  const fieldClassName = className ? `field ${className}` : 'field'
  const checkboxClassName = className ? `indexSchemaConfigEditor__checkbox ${className}` : 'indexSchemaConfigEditor__checkbox'
  if (option.kind === 'boolean') {
    return (
      <label className={checkboxClassName}>
        <input
          type="checkbox"
          checked={record[option.key] === true}
          onChange={(event) => onApply(setOptionalRecordValue(record, option.key, event.currentTarget.checked ? true : undefined))}
        />
        <ConfigLabel label={option.label} tooltipKey={option.tooltipKey} language={language} className="indexSchemaConfigEditor__checkboxLabel" />
      </label>
    )
  }

  if (option.kind === 'select') {
    return (
      <label className={fieldClassName}>
        <ConfigLabel label={option.label} tooltipKey={option.tooltipKey} language={language} />
        <select
          className="field__input"
          value={asString(record[option.key])}
          onChange={(event) => onApply(setOptionalRecordValue(record, option.key, event.currentTarget.value))}
        >
          <option value="">{translations[language].indexBuilderNone}</option>
          {(option.values ?? []).map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
    )
  }

  if (option.kind === 'multiline') {
    return (
      <label className={fieldClassName}>
        <ConfigLabel label={option.label} tooltipKey={option.tooltipKey} language={language} />
        <textarea
          className="field__input"
          rows={3}
          value={getOptionValue(record, option)}
          onChange={(event) => onApply(setOptionalRecordValue(record, option.key, parseOptionValue(option, event.currentTarget.value)))}
          placeholder={option.placeholder}
        />
      </label>
    )
  }

  return (
    <label className={fieldClassName}>
      <ConfigLabel label={option.label} tooltipKey={option.tooltipKey} language={language} />
      <input
        className="field__input"
        type={option.kind === 'number' ? 'number' : 'text'}
        value={getOptionValue(record, option)}
        onChange={(event) => onApply(setOptionalRecordValue(record, option.key, parseOptionValue(option, event.currentTarget.value)))}
        placeholder={option.placeholder}
      />
    </label>
  )
}

function ConfigOptionGrid({ record, options, language, onApply }: {
  record: Record<string, unknown>
  options: ConfigInputOption[]
  language: Language
  onApply: (nextRecord: Record<string, unknown>) => void
}) {
  if (options.length === 0) return null
  return (
    <div className="indexSchemaConfigEditor__grid indexSchemaConfigEditor__grid--compact">
      {options.map((option) => (
        <ConfigOptionField key={option.key} record={record} option={option} language={language} onApply={onApply} />
      ))}
    </div>
  )
}

function getAnalysisComponentOptions(propertyName: string, component: Record<string, unknown>): ConfigInputOption[] {
  const typeName = getTypeName(component)
  if (propertyName === 'charFilters') {
    if (typeName.includes('mappingcharfilter')) return [{ key: 'mappings', label: 'mappings', tooltipKey: 'mappings', kind: 'multiline', placeholder: 'a=>b' }]
    if (typeName.includes('patternreplacecharfilter')) {
      return [
        { key: 'pattern', label: 'pattern', tooltipKey: 'pattern', kind: 'text' },
        { key: 'replacement', label: 'replacement', tooltipKey: 'replacement', kind: 'text' },
      ]
    }
    return []
  }

  if (propertyName === 'tokenizers') {
    if (typeName.includes('edgengramtokenizer') || typeName.includes('ngramtokenizer')) {
      return [
        { key: 'minGram', label: 'minGram', tooltipKey: 'minGram', kind: 'number' },
        { key: 'maxGram', label: 'maxGram', tooltipKey: 'maxGram', kind: 'number' },
        { key: 'tokenChars', label: 'tokenChars', tooltipKey: 'tokenChars', kind: 'multiline', placeholder: 'letter\ndigit' },
      ]
    }
    if (typeName.includes('patterntokenizer')) {
      return [
        { key: 'pattern', label: 'pattern', tooltipKey: 'pattern', kind: 'text' },
        { key: 'flags', label: 'flags', tooltipKey: 'flags', kind: 'text' },
        { key: 'group', label: 'group', tooltipKey: 'group', kind: 'number' },
      ]
    }
    if (typeName.includes('microsoftlanguagestemmingtokenizer') || typeName.includes('microsoftlanguagetokenizer')) {
      return [
        { key: 'maxTokenLength', label: 'maxTokenLength', tooltipKey: 'maxTokenLength', kind: 'number' },
        { key: 'isSearchTokenizer', label: 'isSearchTokenizer', tooltipKey: 'isSearchTokenizer', kind: 'boolean' },
        { key: 'language', label: 'language', tooltipKey: 'language', kind: 'text' },
      ]
    }
    if (typeName.includes('standardtokenizer') || typeName.includes('classic') || typeName.includes('keyword') || typeName.includes('letter') || typeName.includes('lowercase') || typeName.includes('uaxurlemail') || typeName.includes('whitespace')) {
      return [{ key: 'maxTokenLength', label: 'maxTokenLength', tooltipKey: 'maxTokenLength', kind: 'number' }]
    }
    return []
  }

  const tokenFilterCommon: ConfigInputOption[] = []
  if (typeName.includes('asciifolding')) tokenFilterCommon.push({ key: 'preserveOriginal', label: 'preserveOriginal', tooltipKey: 'preserveOriginal', kind: 'boolean' })
  if (typeName.includes('edgengram')) tokenFilterCommon.push({ key: 'minGram', label: 'minGram', tooltipKey: 'minGram', kind: 'number' }, { key: 'maxGram', label: 'maxGram', tooltipKey: 'maxGram', kind: 'number' }, { key: 'side', label: 'side', tooltipKey: 'side', kind: 'select', values: ['front', 'back'] })
  if (typeName.includes('elision')) tokenFilterCommon.push({ key: 'articles', label: 'articles', tooltipKey: 'articles', kind: 'multiline' })
  if (typeName.includes('keepword')) tokenFilterCommon.push({ key: 'words', label: 'words', tooltipKey: 'words', kind: 'multiline' }, { key: 'keepWordsCase', label: 'keepWordsCase', tooltipKey: 'keepWordsCase', kind: 'boolean' })
  if (typeName.includes('keywordmarker')) tokenFilterCommon.push({ key: 'keywords', label: 'keywords', tooltipKey: 'keywords', kind: 'multiline' })
  if (typeName.includes('length')) tokenFilterCommon.push({ key: 'min', label: 'min', tooltipKey: 'min', kind: 'number' }, { key: 'max', label: 'max', tooltipKey: 'max', kind: 'number' })
  if (typeName.includes('limittoken')) tokenFilterCommon.push({ key: 'maxTokenCount', label: 'maxTokenCount', tooltipKey: 'maxTokenCount', kind: 'number' }, { key: 'consumeAllTokens', label: 'consumeAllTokens', tooltipKey: 'consumeAllTokens', kind: 'boolean' })
  if (typeName.includes('patterncapture')) tokenFilterCommon.push({ key: 'patterns', label: 'patterns', tooltipKey: 'patterns', kind: 'multiline' }, { key: 'preserveOriginal', label: 'preserveOriginal', tooltipKey: 'preserveOriginal', kind: 'boolean' })
  if (typeName.includes('patternreplace')) tokenFilterCommon.push({ key: 'pattern', label: 'pattern', tooltipKey: 'pattern', kind: 'text' }, { key: 'replacement', label: 'replacement', tooltipKey: 'replacement', kind: 'text' })
  if (typeName.includes('phonetic')) tokenFilterCommon.push({ key: 'encoder', label: 'encoder', tooltipKey: 'encoder', kind: 'text' }, { key: 'replace', label: 'replace', tooltipKey: 'replace', kind: 'boolean' })
  if (typeName.includes('shingle')) tokenFilterCommon.push({ key: 'minShingleSize', label: 'minShingleSize', tooltipKey: 'minShingleSize', kind: 'number' }, { key: 'maxShingleSize', label: 'maxShingleSize', tooltipKey: 'maxShingleSize', kind: 'number' }, { key: 'outputUnigrams', label: 'outputUnigrams', tooltipKey: 'outputUnigrams', kind: 'boolean' }, { key: 'outputUnigramsIfNoShingles', label: 'outputUnigramsIfNoShingles', tooltipKey: 'outputUnigramsIfNoShingles', kind: 'boolean' }, { key: 'tokenSeparator', label: 'tokenSeparator', tooltipKey: 'tokenSeparator', kind: 'text' }, { key: 'filterToken', label: 'filterToken', tooltipKey: 'filterToken', kind: 'text' })
  if (typeName.includes('snowball') || typeName.includes('stemmer')) tokenFilterCommon.push({ key: 'language', label: 'language', tooltipKey: 'language', kind: 'text' })
  if (typeName.includes('stemmeroverride')) tokenFilterCommon.push({ key: 'rules', label: 'rules', tooltipKey: 'rules', kind: 'multiline' })
  if (typeName.includes('stopwords')) tokenFilterCommon.push({ key: 'stopwords', label: 'stopwords', tooltipKey: 'stopwords', kind: 'multiline' }, { key: 'stopwordsList', label: 'stopwordsList', tooltipKey: 'stopwordsList', kind: 'text' }, { key: 'ignoreCase', label: 'ignoreCase', tooltipKey: 'ignoreCase', kind: 'boolean' }, { key: 'removeTrailingStopWords', label: 'removeTrailingStopWords', tooltipKey: 'removeTrailingStopWords', kind: 'boolean' })
  if (typeName.includes('synonym')) tokenFilterCommon.push({ key: 'synonyms', label: 'synonyms', tooltipKey: 'synonyms', kind: 'multiline' }, { key: 'ignoreCase', label: 'ignoreCase', tooltipKey: 'ignoreCase', kind: 'boolean' }, { key: 'expand', label: 'expand', tooltipKey: 'expand', kind: 'boolean' })
  if (typeName.includes('truncate')) tokenFilterCommon.push({ key: 'length', label: 'length', tooltipKey: 'length', kind: 'number' })
  if (typeName.includes('unique')) tokenFilterCommon.push({ key: 'onlyOnSamePosition', label: 'onlyOnSamePosition', tooltipKey: 'onlyOnSamePosition', kind: 'boolean' })
  if (typeName.includes('worddelimiter')) {
    tokenFilterCommon.push(
      { key: 'generateWordParts', label: 'generateWordParts', tooltipKey: 'wordDelimiterFlag', kind: 'boolean' },
      { key: 'generateNumberParts', label: 'generateNumberParts', tooltipKey: 'wordDelimiterFlag', kind: 'boolean' },
      { key: 'catenateWords', label: 'catenateWords', tooltipKey: 'wordDelimiterFlag', kind: 'boolean' },
      { key: 'catenateNumbers', label: 'catenateNumbers', tooltipKey: 'wordDelimiterFlag', kind: 'boolean' },
      { key: 'catenateAll', label: 'catenateAll', tooltipKey: 'wordDelimiterFlag', kind: 'boolean' },
      { key: 'splitOnCaseChange', label: 'splitOnCaseChange', tooltipKey: 'wordDelimiterFlag', kind: 'boolean' },
      { key: 'preserveOriginal', label: 'preserveOriginal', tooltipKey: 'preserveOriginal', kind: 'boolean' },
      { key: 'splitOnNumerics', label: 'splitOnNumerics', tooltipKey: 'wordDelimiterFlag', kind: 'boolean' },
      { key: 'stemEnglishPossessive', label: 'stemEnglishPossessive', tooltipKey: 'wordDelimiterFlag', kind: 'boolean' },
    )
  }
  return tokenFilterCommon
}

function NestedOptionField({ record, groupKey, option, language, onApply, className }: {
  record: Record<string, unknown>
  groupKey: string
  option: ConfigInputOption
  language: Language
  onApply: (nextRecord: Record<string, unknown>) => void
  className?: string
}) {
  const nestedRecord = getNestedRecord(record, groupKey)
  const applyNested = (nextNestedRecord: Record<string, unknown>) => onApply(setOptionalRecordValue(record, groupKey, nextNestedRecord))
  return <ConfigOptionField record={nestedRecord} option={option} language={language} onApply={applyNested} className={className} />
}

function VectorizerOptionsEditor({ item, language, onApply }: {
  item: Record<string, unknown>
  language: Language
  onApply: (nextItem: Record<string, unknown>) => void
}) {
  const kind = asString(item.kind)
  const parameterGroup = kind === 'customWebApi' ? 'customWebApiParameters' : kind === 'aiServicesVision' ? 'aiServicesVisionParameters' : 'azureOpenAIParameters'
  const options: ConfigInputOption[] = kind === 'customWebApi'
    ? [
        { key: 'uri', label: 'uri', tooltipKey: 'vectorizerUri', kind: 'text' },
        { key: 'httpMethod', label: 'httpMethod', tooltipKey: 'httpMethod', kind: 'select', values: ['POST'] },
        { key: 'timeout', label: 'timeout', tooltipKey: 'timeout', kind: 'text', placeholder: 'PT30S' },
        { key: 'authResourceId', label: 'authResourceId', tooltipKey: 'authResourceId', kind: 'text' },
        { key: 'authIdentity', label: 'authIdentity', tooltipKey: 'authIdentity', kind: 'text' },
      ]
    : [
        { key: 'resourceUri', label: 'resourceUri', tooltipKey: 'resourceUri', kind: 'text' },
        { key: 'deploymentId', label: 'deploymentId', tooltipKey: 'deploymentId', kind: 'text' },
        { key: 'modelName', label: 'modelName', tooltipKey: 'modelName', kind: 'text' },
        { key: 'apiKey', label: 'apiKey', tooltipKey: 'apiKey', kind: 'text' },
        { key: 'authIdentity', label: 'authIdentity', tooltipKey: 'authIdentity', kind: 'text' },
      ]

  return (
    <div className="indexSchemaConfigEditor__grid indexSchemaConfigEditor__grid--compact">
      {options.map((option) => (
        <NestedOptionField
          key={`${parameterGroup}.${option.key}`}
          record={item}
          groupKey={parameterGroup}
          option={option}
          language={language}
          onApply={onApply}
          className="field--vectorizer"
        />
      ))}
    </div>
  )
}

function CompressionOptionsEditor({ item, language, onApply }: {
  item: Record<string, unknown>
  language: Language
  onApply: (nextItem: Record<string, unknown>) => void
}) {
  const kind = asString(item.kind)
  const quantizationOptions: ConfigInputOption[] = kind === 'scalarQuantization'
    ? [{ key: 'quantizedDataType', label: 'quantizedDataType', tooltipKey: 'quantizedDataType', kind: 'select', values: ['int8'] }]
    : []
  const rescoringOptions: ConfigInputOption[] = [
    { key: 'rerankWithOriginalVectors', label: 'rerankWithOriginalVectors', tooltipKey: 'rerankWithOriginalVectors', kind: 'boolean' },
    { key: 'defaultOversampling', label: 'defaultOversampling', tooltipKey: 'defaultOversampling', kind: 'number' },
  ]
  return (
    <div className="indexSchemaConfigEditor__grid indexSchemaConfigEditor__grid--compact">
      {quantizationOptions.map((option) => (
        <NestedOptionField key={`scalarQuantizationParameters.${option.key}`} record={item} groupKey="scalarQuantizationParameters" option={option} language={language} onApply={onApply} className="field--vectorCompression" />
      ))}
      {rescoringOptions.map((option) => (
        <NestedOptionField key={`rescoringOptions.${option.key}`} record={item} groupKey="rescoringOptions" option={option} language={language} onApply={onApply} className="field--vectorCompression" />
      ))}
      <ConfigOptionField
        record={item}
        option={{ key: 'truncationDimension', label: 'truncationDimension', tooltipKey: 'truncationDimension', kind: 'number' }}
        language={language}
        onApply={onApply}
        className="field--vectorCompression"
      />
    </div>
  )
}

function AnalyzersEditor({ analysis, t, language, onChangeIndex }: {
  analysis: SchemaAnalysis
  t: (key: TranslationKey) => string
  language: Language
  onChangeIndex: (nextIndex: Record<string, unknown>) => void
}) {
  const analyzers = getTopLevelCollection(analysis.index, 'analyzers')
  const tokenizers = getTopLevelCollection(analysis.index, 'tokenizers')
  const tokenFilters = getTopLevelCollection(analysis.index, 'tokenFilters')
  const charFilters = getTopLevelCollection(analysis.index, 'charFilters')
  const tokenizerNames = [
    ...ANALYZE_TOKENIZERS,
    ...tokenizers.map((tokenizer) => asString(tokenizer.name)).filter(Boolean),
  ]
  const tokenFilterNames = [
    ...ANALYZE_TOKEN_FILTERS,
    ...tokenFilters.map((tokenFilter) => asString(tokenFilter.name)).filter(Boolean),
  ]
  const charFilterNames = [
    ...ANALYZE_CHAR_FILTERS,
    ...charFilters.map((charFilter) => asString(charFilter.name)).filter(Boolean),
  ]

  const addNamedCollectionItem = (propertyName: string, baseName: string, odataType: string) => {
    const collection = getTopLevelCollection(analysis.index, propertyName)
    const name = uniqueName(collection.map((item) => asString(item.name)).filter(Boolean), baseName)
    onChangeIndex(setTopLevelCollection(analysis.index, propertyName, [...collection, { name, '@odata.type': odataType }]))
  }

  return (
    <section className="indexSchemaConfigEditor__section">
      <div className="indexSchemaConfigEditor__subHeader indexSchemaConfigEditor__subHeader--top">
        <span>{t('indexBuilderAnalyzerDefinitions')}</span>
        <button type="button" className="btn btn--mini" onClick={() => addNamedCollectionItem('analyzers', 'my-analyzer', '#Microsoft.Azure.Search.CustomAnalyzer')}>
          <i className="bi bi-plus-lg icon--mr6"></i>
          {t('indexBuilderAddAnalyzer')}
        </button>
      </div>
      {analyzers.length === 0 ? <EmptyFeatureNotice label={t('indexBuilderNoAnalyzers')} /> : null}
      <div className="indexSchemaConfigEditor__cards">
        {analyzers.map((analyzer, analyzerIndex) => (
          <div key={`${analyzerIndex}-${asString(analyzer.name)}`} className="indexSchemaConfigEditor__card">
            <div className="indexSchemaConfigEditor__cardHeader">
              <label className="field">
                <ConfigLabel label={t('indexBuilderConfigName')} tooltipKey="configName" language={language} />
                <input className="field__input" value={asString(analyzer.name)} onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'analyzers', analyzerIndex, (nextAnalyzer) => setOptionalRecordValue(nextAnalyzer, 'name', event.currentTarget.value)))} />
              </label>
              <label className="field">
                <ConfigLabel label={t('indexBuilderODataType')} tooltipKey="odataType" language={language} />
                <input className="field__input" value={asString(analyzer['@odata.type'])} onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'analyzers', analyzerIndex, (nextAnalyzer) => setOptionalRecordValue(nextAnalyzer, '@odata.type', event.currentTarget.value)))} />
              </label>
              <button type="button" className="btn btn--mini" onClick={() => onChangeIndex(removeTopLevelCollectionItem(analysis.index, 'analyzers', analyzerIndex))}>
                <i className="bi bi-trash icon--mr6"></i>
                {t('indexBuilderRemoveItem')}
              </button>
            </div>
            <div className="indexSchemaConfigEditor__grid">
              <label className="field">
                <ConfigLabel label={t('indexBuilderAnalyzerTokenizer')} tooltipKey="analyzerTokenizer" language={language} />
                <input className="field__input" list="indexBuilderTokenizerOptions" value={asString(analyzer.tokenizer)} onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'analyzers', analyzerIndex, (nextAnalyzer) => setOptionalRecordValue(nextAnalyzer, 'tokenizer', event.currentTarget.value)))} />
              </label>
              <label className="field">
                <ConfigLabel label={t('indexBuilderAnalyzerCharFilters')} tooltipKey="analyzerCharFilters" language={language} />
                <textarea className="field__input" rows={3} value={stringArrayToText(analyzer.charFilters)} onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'analyzers', analyzerIndex, (nextAnalyzer) => setOptionalRecordValue(nextAnalyzer, 'charFilters', splitTextList(event.currentTarget.value))))} />
              </label>
              <label className="field">
                <ConfigLabel label={t('indexBuilderAnalyzerTokenFilters')} tooltipKey="analyzerTokenFilters" language={language} />
                <textarea className="field__input" rows={3} value={stringArrayToText(analyzer.tokenFilters)} onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'analyzers', analyzerIndex, (nextAnalyzer) => setOptionalRecordValue(nextAnalyzer, 'tokenFilters', splitTextList(event.currentTarget.value))))} />
              </label>
            </div>
          </div>
        ))}
      </div>

      <div className="indexSchemaConfigEditor__componentGrid">
        {([
          { propertyName: 'tokenizers', labelKey: 'indexBuilderTokenizers', baseName: 'my-tokenizer', odataType: '#Microsoft.Azure.Search.StandardTokenizerV2' },
          { propertyName: 'charFilters', labelKey: 'indexBuilderCharFilters', baseName: 'my-char-filter', odataType: '#Microsoft.Azure.Search.MappingCharFilter' },
          { propertyName: 'tokenFilters', labelKey: 'indexBuilderTokenFilters', baseName: 'my-token-filter', odataType: '#Microsoft.Azure.Search.AsciiFoldingTokenFilter' },
        ] as const).map((section) => {
          const collection = getTopLevelCollection(analysis.index, section.propertyName)
          return (
            <div key={section.propertyName} className="indexSchemaConfigEditor__card">
              <div className="indexSchemaConfigEditor__subHeader">
                <span>{t(section.labelKey)}</span>
                <button type="button" className="btn btn--mini" onClick={() => addNamedCollectionItem(section.propertyName, section.baseName, section.odataType)}>
                  <i className="bi bi-plus-lg icon--mr6"></i>
                  {t('indexBuilderAddItem')}
                </button>
              </div>
              {collection.length === 0 ? <EmptyFeatureNotice label={t('indexBuilderNoComponents')} /> : null}
              <div className="indexSchemaConfigEditor__nestedCards">
                {collection.map((component, componentIndex) => (
                  <div key={`${componentIndex}-${asString(component.name)}`} className="indexSchemaConfigEditor__nestedCard">
                    <div className="indexSchemaConfigEditor__grid indexSchemaConfigEditor__grid--compact">
                      <label className="field">
                        <ConfigLabel label={t('indexBuilderConfigName')} tooltipKey="configName" language={language} />
                        <input className="field__input" value={asString(component.name)} onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, section.propertyName, componentIndex, (nextComponent) => setOptionalRecordValue(nextComponent, 'name', event.currentTarget.value)))} />
                      </label>
                      <label className="field">
                        <ConfigLabel label={t('indexBuilderODataType')} tooltipKey="odataType" language={language} />
                        <input className="field__input" value={asString(component['@odata.type'])} onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, section.propertyName, componentIndex, (nextComponent) => setOptionalRecordValue(nextComponent, '@odata.type', event.currentTarget.value)))} />
                      </label>
                      <ConfigOptionGrid
                        record={component}
                        options={getAnalysisComponentOptions(section.propertyName, component)}
                        language={language}
                        onApply={(nextComponent) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, section.propertyName, componentIndex, () => nextComponent))}
                      />
                    </div>
                    <button type="button" className="btn btn--mini" onClick={() => onChangeIndex(removeTopLevelCollectionItem(analysis.index, section.propertyName, componentIndex))}>
                      <i className="bi bi-trash icon--mr6"></i>
                      {t('indexBuilderRemoveItem')}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <FieldOptionsDatalist id="indexBuilderTokenizerOptions" options={tokenizerNames} />
      <FieldOptionsDatalist id="indexBuilderTokenFilterOptions" options={tokenFilterNames} />
      <FieldOptionsDatalist id="indexBuilderCharFilterOptions" options={charFilterNames} />
    </section>
  )
}

function NormalizersEditor({ analysis, t, language, onChangeIndex }: {
  analysis: SchemaAnalysis
  t: (key: TranslationKey) => string
  language: Language
  onChangeIndex: (nextIndex: Record<string, unknown>) => void
}) {
  const normalizers = getTopLevelCollection(analysis.index, 'normalizers')
  const charFilters = getTopLevelCollection(analysis.index, 'charFilters')
  const tokenFilters = getTopLevelCollection(analysis.index, 'tokenFilters')
  const charFilterNames = [...ANALYZE_CHAR_FILTERS, ...charFilters.map((charFilter) => asString(charFilter.name)).filter(Boolean)]
  const tokenFilterNames = [...ANALYZE_TOKEN_FILTERS, ...tokenFilters.map((tokenFilter) => asString(tokenFilter.name)).filter(Boolean)]

  const addNormalizer = () => {
    const name = uniqueName(normalizers.map((normalizer) => asString(normalizer.name)).filter(Boolean), 'my-normalizer')
    onChangeIndex(setTopLevelCollection(analysis.index, 'normalizers', [
      ...normalizers,
      { name, '@odata.type': '#Microsoft.Azure.Search.CustomNormalizer', charFilters: [], tokenFilters: ['lowercase'] },
    ]))
  }

  return (
    <section className="indexSchemaConfigEditor__section">
      <div className="indexSchemaConfigEditor__toolbar">
        <button type="button" className="btn btn--sm" onClick={addNormalizer}>
          <i className="bi bi-plus-lg icon--mr6"></i>
          {t('indexBuilderAddNormalizer')}
        </button>
      </div>
      {normalizers.length === 0 ? <EmptyFeatureNotice label={t('indexBuilderNoNormalizers')} /> : null}
      <div className="indexSchemaConfigEditor__cards">
        {normalizers.map((normalizer, normalizerIndex) => (
          <div key={`${normalizerIndex}-${asString(normalizer.name)}`} className="indexSchemaConfigEditor__card">
            <div className="indexSchemaConfigEditor__cardHeader">
              <label className="field">
                <ConfigLabel label={t('indexBuilderConfigName')} tooltipKey="configName" language={language} />
                <input className="field__input" list="indexBuilderBuiltInNormalizerOptions" value={asString(normalizer.name)} onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'normalizers', normalizerIndex, (nextNormalizer) => setOptionalRecordValue(nextNormalizer, 'name', event.currentTarget.value)))} />
              </label>
              <label className="field">
                <ConfigLabel label={t('indexBuilderODataType')} tooltipKey="odataType" language={language} />
                <input className="field__input" value={asString(normalizer['@odata.type'])} onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'normalizers', normalizerIndex, (nextNormalizer) => setOptionalRecordValue(nextNormalizer, '@odata.type', event.currentTarget.value)))} />
              </label>
              <button type="button" className="btn btn--mini" onClick={() => onChangeIndex(removeTopLevelCollectionItem(analysis.index, 'normalizers', normalizerIndex))}>
                <i className="bi bi-trash icon--mr6"></i>
                {t('indexBuilderRemoveItem')}
              </button>
            </div>
            <div className="indexSchemaConfigEditor__grid">
              <label className="field">
                <ConfigLabel label={t('indexBuilderAnalyzerCharFilters')} tooltipKey="analyzerCharFilters" language={language} />
                <textarea className="field__input" rows={3} value={stringArrayToText(normalizer.charFilters)} onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'normalizers', normalizerIndex, (nextNormalizer) => setOptionalRecordValue(nextNormalizer, 'charFilters', splitTextList(event.currentTarget.value))))} />
              </label>
              <label className="field">
                <ConfigLabel label={t('indexBuilderAnalyzerTokenFilters')} tooltipKey="analyzerTokenFilters" language={language} />
                <textarea className="field__input" rows={3} value={stringArrayToText(normalizer.tokenFilters)} onChange={(event) => onChangeIndex(updateTopLevelCollectionItem(analysis.index, 'normalizers', normalizerIndex, (nextNormalizer) => setOptionalRecordValue(nextNormalizer, 'tokenFilters', splitTextList(event.currentTarget.value))))} />
              </label>
            </div>
          </div>
        ))}
      </div>
      <FieldOptionsDatalist id="indexBuilderBuiltInNormalizerOptions" options={[...ANALYZE_NORMALIZERS]} />
      <FieldOptionsDatalist id="indexBuilderNormalizerCharFilterOptions" options={charFilterNames} />
      <FieldOptionsDatalist id="indexBuilderNormalizerTokenFilterOptions" options={tokenFilterNames} />
    </section>
  )
}

function VectorProfilesEditor({ analysis, t, language, onChangeIndex }: {
  analysis: SchemaAnalysis
  t: (key: TranslationKey) => string
  language: Language
  onChangeIndex: (nextIndex: Record<string, unknown>) => void
}) {
  const profiles = getVectorSearchCollection(analysis.index, 'profiles')
  const algorithms = getVectorSearchCollection(analysis.index, 'algorithms')
  const vectorizers = getVectorSearchCollection(analysis.index, 'vectorizers')
  const compressions = getVectorSearchCollection(analysis.index, 'compressions')
  const algorithmNames = algorithms.map((algorithm) => asString(algorithm.name)).filter(Boolean)
  const vectorizerNames = vectorizers.map((vectorizer) => asString(vectorizer.name)).filter(Boolean)
  const compressionNames = compressions.map((compression) => asString(compression.name)).filter(Boolean)

  const addVectorCollectionItem = (propertyName: string, item: Record<string, unknown>) => {
    const collection = getVectorSearchCollection(analysis.index, propertyName)
    onChangeIndex(updateVectorSearch(analysis.index, (vectorSearch) => {
      vectorSearch[propertyName] = [...collection, item]
      return vectorSearch
    }))
  }

  return (
    <section className="indexSchemaConfigEditor__section">
      <VectorSearchGuide
        profileCount={profiles.length}
        algorithmCount={algorithms.length}
        vectorizerCount={vectorizers.length}
        compressionCount={compressions.length}
        language={language}
      />
      <div className="indexSchemaConfigEditor__componentGrid">
        <div className="indexSchemaConfigEditor__card indexSchemaConfigEditor__card--vectorProfile">
          <div className="indexSchemaConfigEditor__subHeader">
            <span>{t('indexBuilderVectorProfiles')}</span>
            <button type="button" className="btn btn--mini" onClick={() => addVectorCollectionItem('profiles', { name: uniqueName(profiles.map((profile) => asString(profile.name)).filter(Boolean), 'vector-profile'), algorithm: algorithmNames[0] ?? '' })}>
              <i className="bi bi-plus-lg icon--mr6"></i>
              {t('indexBuilderAddVectorProfile')}
            </button>
          </div>
          {profiles.length === 0 ? <EmptyFeatureNotice label={t('indexBuilderNoVectorProfiles')} /> : null}
          <div className="indexSchemaConfigEditor__nestedCards">
            {profiles.map((profile, profileIndex) => (
              <div key={`${profileIndex}-${asString(profile.name)}`} className="indexSchemaConfigEditor__nestedCard indexSchemaConfigEditor__nestedCard--vectorProfile">
                <div className="indexSchemaConfigEditor__grid indexSchemaConfigEditor__grid--compact">
                  <label className="field field--vectorProfile"><ConfigLabel label={t('indexBuilderConfigName')} tooltipKey="vectorProfileName" language={language} /><input className="field__input" value={asString(profile.name)} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, 'profiles', profileIndex, (nextProfile) => setOptionalRecordValue(nextProfile, 'name', event.currentTarget.value)))} /></label>
                  <label className="field field--vectorAlgorithm"><ConfigLabel label={t('indexBuilderAlgorithm')} tooltipKey="vectorAlgorithm" language={language} /><input className="field__input" list="indexBuilderVectorAlgorithmNames" value={asString(profile.algorithm)} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, 'profiles', profileIndex, (nextProfile) => setOptionalRecordValue(nextProfile, 'algorithm', event.currentTarget.value)))} /></label>
                  <label className="field field--vectorizer"><ConfigLabel label={t('indexBuilderVectorizer')} tooltipKey="vectorizer" language={language} /><input className="field__input" list="indexBuilderVectorizerNames" value={asString(profile.vectorizer)} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, 'profiles', profileIndex, (nextProfile) => setOptionalRecordValue(nextProfile, 'vectorizer', event.currentTarget.value)))} /></label>
                  <label className="field field--vectorCompression"><ConfigLabel label={t('indexBuilderCompression')} tooltipKey="vectorCompression" language={language} /><input className="field__input" list="indexBuilderCompressionNames" value={asString(profile.compression)} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, 'profiles', profileIndex, (nextProfile) => setOptionalRecordValue(nextProfile, 'compression', event.currentTarget.value)))} /></label>
                </div>
                <button type="button" className="btn btn--mini" onClick={() => onChangeIndex(removeVectorSearchCollectionItem(analysis.index, 'profiles', profileIndex))}><i className="bi bi-trash icon--mr6"></i>{t('indexBuilderRemoveItem')}</button>
              </div>
            ))}
          </div>
        </div>

        <div className="indexSchemaConfigEditor__card indexSchemaConfigEditor__card--vectorAlgorithm">
          <div className="indexSchemaConfigEditor__subHeader">
            <span>{t('indexBuilderVectorAlgorithms')}</span>
            <button type="button" className="btn btn--mini" onClick={() => addVectorCollectionItem('algorithms', { name: uniqueName(algorithmNames, 'hnsw-config'), kind: 'hnsw', hnswParameters: { metric: 'cosine', m: 4, efConstruction: 400, efSearch: 500 } })}>
              <i className="bi bi-plus-lg icon--mr6"></i>
              {t('indexBuilderAddVectorAlgorithm')}
            </button>
          </div>
          {algorithms.length === 0 ? <EmptyFeatureNotice label={t('indexBuilderNoVectorAlgorithms')} /> : null}
          <div className="indexSchemaConfigEditor__nestedCards">
            {algorithms.map((algorithm, algorithmIndex) => {
              const parameters = getAlgorithmParameters(algorithm)
              const kind = asString(algorithm.kind) || 'hnsw'
              return (
                <div key={`${algorithmIndex}-${asString(algorithm.name)}`} className="indexSchemaConfigEditor__nestedCard indexSchemaConfigEditor__nestedCard--vectorAlgorithm">
                  <div className="indexSchemaConfigEditor__grid indexSchemaConfigEditor__grid--compact">
                    <label className="field field--vectorAlgorithm"><ConfigLabel label={t('indexBuilderConfigName')} tooltipKey="configName" language={language} /><input className="field__input" value={asString(algorithm.name)} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, 'algorithms', algorithmIndex, (nextAlgorithm) => setOptionalRecordValue(nextAlgorithm, 'name', event.currentTarget.value)))} /></label>
                    <label className="field field--vectorAlgorithm"><ConfigLabel label={t('indexBuilderKind')} tooltipKey="vectorAlgorithmKind" language={language} /><select className="field__input" value={kind} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, 'algorithms', algorithmIndex, (nextAlgorithm) => ({ ...nextAlgorithm, kind: event.currentTarget.value })))}><option value="hnsw">hnsw</option><option value="exhaustiveKnn">exhaustiveKnn</option></select></label>
                    <label className="field field--vectorAlgorithm"><ConfigLabel label={t('indexBuilderMetric')} tooltipKey="vectorMetric" language={language} /><select className="field__input" value={asString(parameters.metric)} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, 'algorithms', algorithmIndex, (nextAlgorithm) => setAlgorithmParameter(nextAlgorithm, 'metric', event.currentTarget.value)))}><option value="">{t('indexBuilderNone')}</option><option value="cosine">cosine</option><option value="dotProduct">dotProduct</option><option value="euclidean">euclidean</option><option value="hamming">hamming</option></select></label>
                    {kind === 'hnsw' ? (
                      <>
                        <label className="field field--vectorAlgorithm"><ConfigLabel label={t('indexBuilderHnswM')} tooltipKey="hnswM" language={language} /><input className="field__input" type="number" value={asNumberOrString(parameters.m)} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, 'algorithms', algorithmIndex, (nextAlgorithm) => setAlgorithmParameter(nextAlgorithm, 'm', parseOptionalNumber(event.currentTarget.value))))} /></label>
                        <label className="field field--vectorAlgorithm"><ConfigLabel label={t('indexBuilderHnswEfConstruction')} tooltipKey="hnswEfConstruction" language={language} /><input className="field__input" type="number" value={asNumberOrString(parameters.efConstruction)} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, 'algorithms', algorithmIndex, (nextAlgorithm) => setAlgorithmParameter(nextAlgorithm, 'efConstruction', parseOptionalNumber(event.currentTarget.value))))} /></label>
                        <label className="field field--vectorAlgorithm"><ConfigLabel label={t('indexBuilderHnswEfSearch')} tooltipKey="hnswEfSearch" language={language} /><input className="field__input" type="number" value={asNumberOrString(parameters.efSearch)} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, 'algorithms', algorithmIndex, (nextAlgorithm) => setAlgorithmParameter(nextAlgorithm, 'efSearch', parseOptionalNumber(event.currentTarget.value))))} /></label>
                      </>
                    ) : null}
                  </div>
                  <button type="button" className="btn btn--mini" onClick={() => onChangeIndex(removeVectorSearchCollectionItem(analysis.index, 'algorithms', algorithmIndex))}><i className="bi bi-trash icon--mr6"></i>{t('indexBuilderRemoveItem')}</button>
                </div>
              )
            })}
          </div>
        </div>

        {([
          { propertyName: 'vectorizers', labelKey: 'indexBuilderVectorizers', addKey: 'indexBuilderAddVectorizer', baseName: 'my-vectorizer', defaultItem: { kind: 'azureOpenAI' } },
          { propertyName: 'compressions', labelKey: 'indexBuilderVectorCompressions', addKey: 'indexBuilderAddVectorCompression', baseName: 'my-compression', defaultItem: { kind: 'scalarQuantization', rescoringOptions: { rerankWithOriginalVectors: true, defaultOversampling: 4 } } },
        ] as const).map((section) => {
          const collection = getVectorSearchCollection(analysis.index, section.propertyName)
          return (
            <div key={section.propertyName} className={`indexSchemaConfigEditor__card ${section.propertyName === 'vectorizers' ? 'indexSchemaConfigEditor__card--vectorizer' : 'indexSchemaConfigEditor__card--vectorCompression'}`}>
              <div className="indexSchemaConfigEditor__subHeader">
                <span>{t(section.labelKey)}</span>
                <button type="button" className="btn btn--mini" onClick={() => addVectorCollectionItem(section.propertyName, { name: uniqueName(collection.map((item) => asString(item.name)).filter(Boolean), section.baseName), ...section.defaultItem })}>
                  <i className="bi bi-plus-lg icon--mr6"></i>
                  {t(section.addKey)}
                </button>
              </div>
              {collection.length === 0 ? <EmptyFeatureNotice label={t('indexBuilderNoComponents')} /> : null}
              <div className="indexSchemaConfigEditor__nestedCards">
                {collection.map((item, itemIndex) => (
                  <div key={`${itemIndex}-${asString(item.name)}`} className={`indexSchemaConfigEditor__nestedCard ${section.propertyName === 'vectorizers' ? 'indexSchemaConfigEditor__nestedCard--vectorizer' : 'indexSchemaConfigEditor__nestedCard--vectorCompression'}`}>
                    <div className="indexSchemaConfigEditor__grid indexSchemaConfigEditor__grid--compact">
                      <label className={`field ${section.propertyName === 'vectorizers' ? 'field--vectorizer' : 'field--vectorCompression'}`}><ConfigLabel label={t('indexBuilderConfigName')} tooltipKey="configName" language={language} /><input className="field__input" value={asString(item.name)} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, section.propertyName, itemIndex, (nextItem) => setOptionalRecordValue(nextItem, 'name', event.currentTarget.value)))} /></label>
                      <label className={`field ${section.propertyName === 'vectorizers' ? 'field--vectorizer' : 'field--vectorCompression'}`}><ConfigLabel label={t('indexBuilderKind')} tooltipKey={section.propertyName === 'vectorizers' ? 'vectorizerKind' : 'compressionKind'} language={language} /><input className="field__input" value={asString(item.kind)} onChange={(event) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, section.propertyName, itemIndex, (nextItem) => setOptionalRecordValue(nextItem, 'kind', event.currentTarget.value)))} /></label>
                      {section.propertyName === 'vectorizers' ? (
                        <VectorizerOptionsEditor item={item} language={language} onApply={(nextItem) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, section.propertyName, itemIndex, () => nextItem))} />
                      ) : (
                        <CompressionOptionsEditor item={item} language={language} onApply={(nextItem) => onChangeIndex(updateVectorSearchCollectionItem(analysis.index, section.propertyName, itemIndex, () => nextItem))} />
                      )}
                    </div>
                    <button type="button" className="btn btn--mini" onClick={() => onChangeIndex(removeVectorSearchCollectionItem(analysis.index, section.propertyName, itemIndex))}><i className="bi bi-trash icon--mr6"></i>{t('indexBuilderRemoveItem')}</button>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <FieldOptionsDatalist id="indexBuilderVectorAlgorithmNames" options={algorithmNames} />
      <FieldOptionsDatalist id="indexBuilderVectorizerNames" options={vectorizerNames} />
      <FieldOptionsDatalist id="indexBuilderCompressionNames" options={compressionNames} />
    </section>
  )
}

function IndexSchemaConfigurationEditors({ analysis, isExistingIndex, t, language, onChangeIndex }: {
  analysis: SchemaAnalysis
  isExistingIndex: boolean
  t: (key: TranslationKey) => string
  language: Language
  onChangeIndex: (nextIndex: Record<string, unknown>) => void
}) {
  const [activeTab, setActiveTab] = useState<ConfigEditorTab>('semantic')

  return (
    <section className="indexSchemaPanel indexSchemaPanel--wide indexSchemaConfigEditor">
      <div className="indexSchemaPanel__title">
        <i className="bi bi-ui-checks-grid icon--mr6"></i>
        {t('indexBuilderConfigEditors')}
      </div>
      <div className="indexSchemaWorkbench__hint">
        {isExistingIndex ? t('indexBuilderConfigEditorsExistingHint') : t('indexBuilderConfigEditorsHint')}
      </div>
      <div className="indexSchemaConfigEditor__tabs" role="tablist" aria-label={t('indexBuilderConfigEditors')}>
        {configEditorTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            className={`btn btn--tab ${activeTab === tab.id ? 'btn--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <i className={`bi ${tab.icon} icon--mr6`}></i>
            {t(tab.labelKey)}
          </button>
        ))}
      </div>
      <div className="indexSchemaConfigEditor__body" role="tabpanel">
        {activeTab === 'semantic' ? <SemanticConfigEditor analysis={analysis} t={t} language={language} onChangeIndex={onChangeIndex} /> : null}
        {activeTab === 'scoringProfiles' ? <ScoringProfilesEditor analysis={analysis} t={t} language={language} onChangeIndex={onChangeIndex} /> : null}
        {activeTab === 'suggesters' ? <SuggestersEditor analysis={analysis} t={t} language={language} onChangeIndex={onChangeIndex} /> : null}
        {activeTab === 'analyzers' ? <AnalyzersEditor analysis={analysis} t={t} language={language} onChangeIndex={onChangeIndex} /> : null}
        {activeTab === 'normalizers' ? <NormalizersEditor analysis={analysis} t={t} language={language} onChangeIndex={onChangeIndex} /> : null}
        {activeTab === 'vectorProfiles' ? <VectorProfilesEditor analysis={analysis} t={t} language={language} onChangeIndex={onChangeIndex} /> : null}
      </div>
    </section>
  )
}

export function IndexSchemaConfigurationEditorPanel({ editedJson, baselineJson, isExistingIndex, language, onChangeIndex }: IndexSchemaConfigurationEditorPanelProps) {
  const t = (key: TranslationKey): string => String(translations[language][key] ?? '')
  const analysis = useMemo(() => analyzeSchema(editedJson, baselineJson, isExistingIndex), [editedJson, baselineJson, isExistingIndex])

  if (!analysis.ok) {
    return (
      <div className="indexSchemaWorkbench indexSchemaWorkbench--empty">
        <div className="indexSchemaWorkbench__header">
          <div>
            <div className="indexSchemaWorkbench__title">
              <i className="bi bi-ui-checks-grid icon--mr6"></i>
              {t('indexBuilderConfigEditors')}
            </div>
            <div className="indexSchemaWorkbench__hint">
              {analysis.empty ? t('indexBuilderSchemaNoDefinition') : formatMessage(t, 'indexBuilderSchemaParseError', analysis.error)}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="indexSchemaWorkbench">
      <IndexSchemaConfigurationEditors
        analysis={analysis}
        isExistingIndex={isExistingIndex}
        t={t}
        language={language}
        onChangeIndex={onChangeIndex}
      />
    </div>
  )
}

export function IndexSchemaOverview({ editedJson, baselineJson, isExistingIndex, language, onApplyTemplate, onChangeIndex }: IndexSchemaOverviewProps) {
  const t = (key: TranslationKey): string => String(translations[language][key] ?? '')
  const analysis = useMemo(() => analyzeSchema(editedJson, baselineJson, isExistingIndex), [editedJson, baselineJson, isExistingIndex])
  const [selectedFieldPath, setSelectedFieldPath] = useState('')

  const selectedField = analysis.ok
    ? analysis.fields.find((field) => field.path === selectedFieldPath) ?? analysis.fields[0] ?? null
    : null

  const applyBooleanSetting = (attribute: FieldAttributeKey, checked: boolean) => {
    if (!analysis.ok || !selectedField) return
    const rule = getAttributeRule(selectedField, attribute)
    const currentValue = selectedField[attribute] === true
    const canRepairUnsupported = !isExistingIndex && !rule.supported && currentValue && !checked
    if (!canEditRule(rule, isExistingIndex) && !canRepairUnsupported) return
    if (rule.required && !checked) return
    if (!rule.supported && checked) return

    const nextIndex = attribute === 'key'
      ? setKeyField(analysis.index, selectedField.pathParts, checked)
      : setFieldProperty(analysis.index, selectedField.pathParts, attribute, checked)
    onChangeIndex(nextIndex)
  }

  const applyTextSetting = (setting: FieldTextSettingKey, value: string) => {
    if (!analysis.ok || !selectedField) return
    const rule = getTextSettingRule(selectedField, setting)
    if (!canEditRule(rule, isExistingIndex)) return

    const trimmed = value.trim()
    let nextValue: unknown = trimmed
    if (!trimmed) nextValue = undefined
    if (setting === 'dimensions' && trimmed) {
      const parsed = Number(trimmed)
      nextValue = Number.isFinite(parsed) ? parsed : trimmed
    }
    if (setting === 'synonymMaps') {
      const names = trimmed.split(',').map((name) => name.trim()).filter(Boolean).slice(0, 1)
      nextValue = names.length > 0 ? names : undefined
    }
    onChangeIndex(setFieldProperty(analysis.index, selectedField.pathParts, setting, nextValue))
  }

  if (!analysis.ok) {
    return (
      <div className="indexSchemaWorkbench indexSchemaWorkbench--empty">
        <div className="indexSchemaWorkbench__header">
          <div>
            <div className="indexSchemaWorkbench__title">
              <i className="bi bi-stars icon--mr6"></i>
              {t('indexBuilderSchemaWorkbench')}
            </div>
            <div className="indexSchemaWorkbench__hint">
              {analysis.empty ? t('indexBuilderSchemaNoDefinition') : formatMessage(t, 'indexBuilderSchemaParseError', analysis.error)}
            </div>
          </div>
        </div>
      </div>
    )
  }

  const featureCards = buildFeatureCards(analysis)
  const healthIssues: HealthIssue[] = analysis.healthIssues.length > 0
    ? analysis.healthIssues
    : [{ severity: 'safe', messageKey: 'indexBuilderSchemaIssueNone' }]
  const visibleFields = analysis.fields.slice(0, 18)
  const hiddenFieldCount = Math.max(0, analysis.fields.length - visibleFields.length)

  return (
    <div className="indexSchemaWorkbench">
      <div className="indexSchemaWorkbench__header">
        <div>
          <div className="indexSchemaWorkbench__title">
            <i className="bi bi-stars icon--mr6"></i>
            {t('indexBuilderSchemaWorkbench')}
          </div>
          <div className="indexSchemaWorkbench__hint">{t('indexBuilderSchemaWorkbenchHint')}</div>
        </div>
        <div className="indexSchemaWorkbench__modeBadge">
          {isExistingIndex ? t('indexBuilderSchemaModeExisting') : t('indexBuilderSchemaModeDraft')}
        </div>
      </div>

      <div className="indexSchemaMetrics">
        <div className="indexSchemaMetric">
          <span className="indexSchemaMetric__label">{t('indexBuilderMetricFields')}</span>
          <span className="indexSchemaMetric__value">{analysis.topLevelFieldCount}</span>
        </div>
        <div className="indexSchemaMetric">
          <span className="indexSchemaMetric__label">{t('indexBuilderMetricKey')}</span>
          <span className="indexSchemaMetric__value indexSchemaMetric__value--text">
            {analysis.keyFields[0]?.name || '-'}
          </span>
        </div>
        <div className="indexSchemaMetric">
          <span className="indexSchemaMetric__label">{t('indexBuilderMetricSearchable')}</span>
          <span className="indexSchemaMetric__value">{analysis.searchableFieldCount}</span>
        </div>
        <div className="indexSchemaMetric">
          <span className="indexSchemaMetric__label">{t('indexBuilderMetricVector')}</span>
          <span className="indexSchemaMetric__value">{analysis.vectorFields.length}</span>
        </div>
      </div>

      <div className="indexSchemaWorkbench__panels">
        <section className="indexSchemaPanel">
          <div className="indexSchemaPanel__title">
            <i className="bi bi-grid-1x2 icon--mr6"></i>
            {t('indexBuilderPortalParity')}
          </div>
          <div className="indexSchemaFeatureGrid">
            {featureCards.map((feature) => (
              <div key={feature.id} className={`indexSchemaFeature indexSchemaFeature--${feature.status}`}>
                <div className="indexSchemaFeature__top">
                  <span className="indexSchemaFeature__icon"><i className={`bi ${feature.icon}`}></i></span>
                  <span className="indexSchemaFeature__count">{feature.countLabel}</span>
                </div>
                <div className="indexSchemaFeature__name">{t(feature.labelKey)}</div>
                <div className="indexSchemaFeature__bottom">
                  <span className={`indexSchemaBadge indexSchemaBadge--${feature.status}`}>
                    {t(statusLabelKey(feature.status))}
                  </span>
                  {feature.templateKind ? (
                    <button
                      type="button"
                      className="btn btn--mini indexSchemaFeature__action"
                      onClick={() => onApplyTemplate(feature.templateKind as IndexSchemaTemplateKind)}
                      title={t('indexBuilderApplyTemplateTitle')}
                    >
                      <i className="bi bi-plus-lg icon--mr6"></i>
                      {t('indexBuilderApplyTemplate')}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="indexSchemaPanel">
          <div className="indexSchemaPanel__title">
            <i className="bi bi-shield-check icon--mr6"></i>
            {t('indexBuilderUpdateImpact')}
          </div>
          <div className="indexSchemaImpactCounts">
            {(['safe', 'review', 'rebuild'] as ImpactSeverity[]).map((severity) => (
              <span key={severity} className={`indexSchemaImpactPill indexSchemaImpactPill--${severity}`}>
                <i className={`bi ${severityIcon(severity)} icon--mr6`}></i>
                {t(severityLabelKey(severity))}: {analysis.impactCounts[severity]}
              </span>
            ))}
          </div>
          <div className="indexSchemaImpactList">
            {analysis.impactItems.map((item, itemIndex) => (
              <div key={`${item.severity}-${item.messageKey}-${item.name}-${itemIndex}`} className={`indexSchemaImpactItem indexSchemaImpactItem--${item.severity}`}>
                <i className={`bi ${severityIcon(item.severity)}`}></i>
                <span>{formatMessage(t, item.messageKey, item.name)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="indexSchemaPanel indexSchemaPanel--wide">
        <div className="indexSchemaPanel__title">
          <i className="bi bi-table icon--mr6"></i>
          {t('indexBuilderFieldMatrix')}
        </div>
        <div className="indexSchemaHealthBar">
          {healthIssues.map((issue, issueIndex) => (
            <span key={`${issue.messageKey}-${issue.name ?? ''}-${issueIndex}`} className={`indexSchemaHealth indexSchemaHealth--${issue.severity}`}>
              <i className={`bi ${severityIcon(issue.severity)} icon--mr6`}></i>
              {formatMessage(t, issue.messageKey, issue.name)}
            </span>
          ))}
        </div>

        <div className="indexSchemaFieldMatrix">
          <table>
            <thead>
              <tr>
                <th>{t('indexBuilderFieldColumnName')}</th>
                <th>{t('indexBuilderFieldColumnAttrs')}</th>
                <th>{t('indexBuilderFieldColumnAnalyzer')}</th>
                <th>{t('indexBuilderFieldColumnVector')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleFields.map((field) => (
                <tr
                  key={field.path}
                  className={field.path === selectedField?.path ? 'indexSchemaFieldMatrix__row--selected' : ''}
                  onClick={() => setSelectedFieldPath(field.path)}
                >
                  <td>
                    <div className="indexSchemaFieldMatrix__name" style={{ paddingLeft: `${field.depth * 14}px` }}>
                      <span className="indexSchemaFieldMatrix__path">{field.path}</span>
                      <span className="indexSchemaFieldMatrix__type">{field.type || '-'}</span>
                    </div>
                  </td>
                  <td>
                    <div className="indexSchemaFieldMatrix__attrs">
                      <AttributeIcon active={field.key} icon="bi-key" label={t('indexBuilderAttrKey')} />
                      <AttributeIcon active={field.searchable === true} icon="bi-search" label={t('indexBuilderAttrSearchable')} />
                      <AttributeIcon active={field.filterable === true} icon="bi-funnel" label={t('indexBuilderAttrFilterable')} />
                      <AttributeIcon active={field.sortable === true} icon="bi-sort-alpha-down" label={t('indexBuilderAttrSortable')} />
                      <AttributeIcon active={field.facetable === true} icon="bi-grid-3x3-gap" label={t('indexBuilderAttrFacetable')} />
                      <AttributeIcon active={field.retrievable === true} icon="bi-eye" label={t('indexBuilderAttrRetrievable')} />
                    </div>
                  </td>
                  <td>
                    <span className="indexSchemaFieldMatrix__mono">
                      {field.analyzer || field.searchAnalyzer || field.indexAnalyzer || field.normalizer || '-'}
                    </span>
                  </td>
                  <td>
                    <span className="indexSchemaFieldMatrix__mono">
                      {field.vectorSearchProfile || field.dimensions
                        ? `${field.vectorSearchProfile || '-'}${field.dimensions ? ` / ${field.dimensions}` : ''}`
                        : '-'}
                    </span>
                  </td>
                </tr>
              ))}
              {visibleFields.length === 0 ? (
                <tr>
                  <td colSpan={4}>
                    <div className="empty">{t('indexBuilderSchemaNoFields')}</div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {hiddenFieldCount > 0 ? (
          <div className="indexSchemaFieldMatrix__more">
            {t('indexBuilderFieldMatrixMore').replaceAll('{count}', String(hiddenFieldCount))}
          </div>
        ) : null}
      </section>

      <section className="indexSchemaPanel indexSchemaPanel--wide indexSchemaFieldSettings">
        <div className="indexSchemaPanel__title">
          <i className="bi bi-sliders icon--mr6"></i>
          {t('indexBuilderFieldSettings')}
        </div>
        <div className="indexSchemaWorkbench__hint">{t('indexBuilderFieldSettingsHint')}</div>

        {!selectedField ? (
          <div className="empty indexSchemaFieldSettings__empty">{t('indexBuilderFieldNoSelection')}</div>
        ) : (
          <div className="indexSchemaFieldSettings__layout">
            <div className="indexSchemaFieldSettings__rail" aria-label={t('indexBuilderFieldSelect')}>
              {analysis.fields.map((field) => (
                <button
                  key={field.path}
                  type="button"
                  className={`indexSchemaFieldSettings__fieldBtn ${field.path === selectedField.path ? 'indexSchemaFieldSettings__fieldBtn--active' : ''}`}
                  onClick={() => setSelectedFieldPath(field.path)}
                  title={field.path}
                >
                  <span className="indexSchemaFieldSettings__fieldPath" style={{ paddingLeft: `${field.depth * 12}px` }}>
                    {field.path}
                  </span>
                  <span className="indexSchemaFieldSettings__fieldType">{field.type || '-'}</span>
                </button>
              ))}
            </div>

            <div className="indexSchemaFieldSettings__detail">
              <div className="indexSchemaFieldSettings__summary">
                <div>
                  <div className="indexSchemaFieldSettings__selectedName">{selectedField.path}</div>
                  <div className="indexSchemaFieldSettings__selectedType">{selectedField.type || '-'}</div>
                </div>
                <span className={`indexSchemaHealth indexSchemaHealth--${isExistingIndex ? 'review' : 'safe'}`}>
                  <i className={`bi ${isExistingIndex ? 'bi-eye' : 'bi-pencil-square'} icon--mr6`}></i>
                  {isExistingIndex ? t('indexBuilderFieldModeExisting') : t('indexBuilderFieldModeDraft')}
                </span>
              </div>

              <div className="indexSchemaFieldSettings__cards">
                <div className="indexSchemaFieldSettings__card">
                  <div className="indexSchemaFieldSettings__cardTitle">
                    <i className="bi bi-toggles icon--mr6"></i>
                    {t('indexBuilderFieldUsage')}
                  </div>
                  <div className="indexSchemaFieldSettings__toggleGrid">
                    {fieldAttributeControls.map((control) => {
                      const rule = getAttributeRule(selectedField, control.key)
                      const currentValue = selectedField[control.key] === true
                      const canRepairUnsupported = !isExistingIndex && !rule.supported && currentValue
                      const disabled = (rule.required && currentValue) || (!canEditRule(rule, isExistingIndex) && !canRepairUnsupported)
                      const severity = fieldRuleSeverity(rule, isExistingIndex)
                      return (
                        <label key={control.key} className={`indexSchemaFieldSettings__toggle indexSchemaFieldSettings__toggle--${severity}`}>
                          <input
                            type="checkbox"
                            checked={currentValue}
                            disabled={disabled}
                            onChange={(event) => applyBooleanSetting(control.key, event.currentTarget.checked)}
                          />
                          <span className="indexSchemaFieldSettings__toggleIcon"><i className={`bi ${control.icon}`}></i></span>
                          <span className="indexSchemaFieldSettings__toggleText">
                            <span className="indexSchemaFieldSettings__label">{t(control.labelKey)}</span>
                            <span className={`indexSchemaFieldSettings__status indexSchemaFieldSettings__status--${severity}`}>
                              <i className={`bi ${rule.supported ? updateabilityIcon(rule.updateability) : 'bi-ban'} icon--mr6`}></i>
                              {t(fieldRuleStatusKey(rule, isExistingIndex))}
                            </span>
                            <span className="indexSchemaFieldSettings__note">{t(rule.noteKey)}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>

                <div className="indexSchemaFieldSettings__card">
                  <div className="indexSchemaFieldSettings__cardTitle">
                    <i className="bi bi-braces icon--mr6"></i>
                    {t('indexBuilderFieldLexical')}
                  </div>
                  <div className="indexSchemaFieldSettings__formGrid">
                    {lexicalSettingControls.map((control) => {
                      const rule = getTextSettingRule(selectedField, control.key)
                      const disabled = !canEditRule(rule, isExistingIndex)
                      const severity = fieldRuleSeverity(rule, isExistingIndex)
                      return (
                        <label key={control.key} className="indexSchemaFieldSettings__inputField">
                          <span className="indexSchemaFieldSettings__inputLabel">
                            <i className={`bi ${control.icon} icon--mr6`}></i>
                            {t(control.labelKey)}
                          </span>
                          <input
                            className="field__input"
                            value={getTextSettingValue(selectedField, control.key)}
                            onChange={(event) => applyTextSetting(control.key, event.currentTarget.value)}
                            disabled={disabled}
                            placeholder={control.key === 'synonymMaps' ? t('indexBuilderFieldSynonymMapsPlaceholder') : t('indexBuilderFieldInputPlaceholder')}
                          />
                          <span className={`indexSchemaFieldSettings__status indexSchemaFieldSettings__status--${severity}`}>
                            <i className={`bi ${rule.supported ? updateabilityIcon(rule.updateability) : 'bi-ban'} icon--mr6`}></i>
                            {t(fieldRuleStatusKey(rule, isExistingIndex))}
                          </span>
                          <span className="indexSchemaFieldSettings__note">{t(rule.noteKey)}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>

                <div className="indexSchemaFieldSettings__card">
                  <div className="indexSchemaFieldSettings__cardTitle">
                    <i className="bi bi-diagram-3 icon--mr6"></i>
                    {t('indexBuilderFieldVector')}
                  </div>
                  <div className="indexSchemaFieldSettings__formGrid indexSchemaFieldSettings__formGrid--compact">
                    {vectorSettingControls.map((control) => {
                      const rule = getTextSettingRule(selectedField, control.key)
                      const disabled = !canEditRule(rule, isExistingIndex)
                      const severity = fieldRuleSeverity(rule, isExistingIndex)
                      return (
                        <label key={control.key} className="indexSchemaFieldSettings__inputField">
                          <span className="indexSchemaFieldSettings__inputLabel">
                            <i className={`bi ${control.icon} icon--mr6`}></i>
                            {t(control.labelKey)}
                          </span>
                          <input
                            className="field__input"
                            type={control.key === 'dimensions' ? 'number' : 'text'}
                            min={control.key === 'dimensions' ? 2 : undefined}
                            max={control.key === 'dimensions' ? 4096 : undefined}
                            list={control.key === 'vectorSearchProfile' ? 'indexBuilderVectorProfiles' : undefined}
                            value={getTextSettingValue(selectedField, control.key)}
                            onChange={(event) => applyTextSetting(control.key, event.currentTarget.value)}
                            disabled={disabled}
                            placeholder={control.key === 'dimensions' ? t('indexBuilderFieldDimensionPlaceholder') : t('indexBuilderFieldVectorProfilePlaceholder')}
                          />
                          <span className={`indexSchemaFieldSettings__status indexSchemaFieldSettings__status--${severity}`}>
                            <i className={`bi ${rule.supported ? updateabilityIcon(rule.updateability) : 'bi-ban'} icon--mr6`}></i>
                            {t(fieldRuleStatusKey(rule, isExistingIndex))}
                          </span>
                          <span className="indexSchemaFieldSettings__note">{t(rule.noteKey)}</span>
                        </label>
                      )
                    })}
                    <datalist id="indexBuilderVectorProfiles">
                      {analysis.vectorProfileNames.map((name) => <option key={name} value={name} />)}
                    </datalist>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>

    </div>
  )
}
