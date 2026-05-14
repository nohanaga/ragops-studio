import { useMemo } from 'react'

import { translations, type Language } from '../../lib/translations'

type TranslationKey = keyof typeof translations.ja

export type IndexSchemaTemplateKind = 'semantic' | 'suggester' | 'scoringProfile' | 'cors' | 'vectorSearch'

type IndexSchemaOverviewProps = {
  editedJson: string
  baselineJson: string
  isExistingIndex: boolean
  language: Language
  onApplyTemplate: (kind: IndexSchemaTemplateKind) => void
}

type FieldSummary = {
  path: string
  name: string
  type: string
  depth: number
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
  corsConfigured: boolean
  encryptionConfigured: boolean
  healthIssues: HealthIssue[]
  impactItems: ImpactItem[]
  impactCounts: Record<ImpactSeverity, number>
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

function collectFieldSummaries(value: unknown, parentPath = '', depth = 0): FieldSummary[] {
  const summaries: FieldSummary[] = []
  for (const fieldValue of asArray(value)) {
    if (!isRecord(fieldValue)) continue
    const name = asString(fieldValue.name)
    if (!name) continue

    const path = parentPath ? `${parentPath}.${name}` : name
    const type = asString(fieldValue.type)
    const vectorSearchProfile = asString(fieldValue.vectorSearchProfile)
    const dimensionsValue = fieldValue.dimensions
    const dimensions = typeof dimensionsValue === 'number' || typeof dimensionsValue === 'string' ? String(dimensionsValue) : ''
    const synonymMaps = asArray(fieldValue.synonymMaps).map(asString).filter(Boolean)
    const isVector = type.includes('Collection(Edm.Single)') || !!dimensions || !!vectorSearchProfile

    summaries.push({
      path,
      name,
      type,
      depth,
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

    summaries.push(...collectFieldSummaries(fieldValue.fields, path, depth + 1))
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
  const analysisBase = {
    ok: true as const,
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
    const isVector = type.includes('Collection(Edm.Single)') || !!nextField.dimensions || !!nextField.vectorSearchProfile
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
    if (contentFieldNames.length > 0) prioritizedFields.contentFields = contentFieldNames.map((fieldName) => ({ fieldName }))
    if (keywordFieldNames.length > 0) prioritizedFields.keywordsFields = keywordFieldNames.map((fieldName) => ({ fieldName }))
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

export function IndexSchemaOverview({ editedJson, baselineJson, isExistingIndex, language, onApplyTemplate }: IndexSchemaOverviewProps) {
  const t = (key: TranslationKey): string => String(translations[language][key] ?? '')
  const analysis = useMemo(() => analyzeSchema(editedJson, baselineJson, isExistingIndex), [editedJson, baselineJson, isExistingIndex])

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
                <tr key={field.path}>
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
    </div>
  )
}
