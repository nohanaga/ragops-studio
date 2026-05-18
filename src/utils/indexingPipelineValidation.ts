import { findDataSourceDescriptor, getCanonicalDataSourceType, INDEXER_CONFIGURATION_FIELDS, INDEXER_PARAMETER_FIELDS, INDEXER_TOP_LEVEL_FIELDS } from '../lib/aiSearchIndexerSchemas'
import type { JsonValue } from '../lib/aiSearchRest'
import type { Language } from '../lib/translations'
import type { IndexingPipelineDraft, IndexingPipelineResourceKind, IndexingPipelineValidationIssue, ParsedIndexingPipelineDraft } from '../types/indexingPipeline'

export type ParsedJsonResult =
  | { ok: true; value: JsonValue }
  | { ok: false; message: string }

function text(language: Language, ja: string, en: string): string {
  return language === 'ja' ? ja : en
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readString(record: Record<string, JsonValue>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value.trim() : ''
}

function readArray(record: Record<string, JsonValue>, key: string): JsonValue[] {
  const value = record[key]
  return Array.isArray(value) ? value : []
}

function supportsUserAssignedManagedIdentity(apiVersion: string): boolean {
  const match = apiVersion.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return false
  const [, year, month, day] = match
  return `${year}-${month}-${day}` >= '2026-04-01'
}

function hasUserAssignedDataSourceIdentity(dataSource: JsonValue | null): boolean {
  if (!isRecord(dataSource) || !isRecord(dataSource.identity)) return false
  return typeof dataSource.identity.userAssignedIdentity === 'string' && dataSource.identity.userAssignedIdentity.trim().length > 0
}

function parseResource(textValue: string): ParsedJsonResult {
  try {
    const parsed = JSON.parse(textValue) as JsonValue
    return { ok: true, value: parsed }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export function parseIndexingPipelineDraft(draft: IndexingPipelineDraft): ParsedIndexingPipelineDraft {
  const dataSource = parseResource(draft.dataSource.text)
  const index = parseResource(draft.index.text)
  const indexer = parseResource(draft.indexer.text)
  return {
    dataSource: dataSource.ok ? dataSource.value : null,
    index: index.ok ? index.value : null,
    indexer: indexer.ok ? indexer.value : null,
  }
}

export function parseDraftJson(textValue: string): ParsedJsonResult {
  return parseResource(textValue)
}

export function getResourceName(value: JsonValue | null | undefined): string {
  if (!isRecord(value)) return ''
  return readString(value, 'name')
}

export function getDataSourceType(value: JsonValue | null | undefined): string {
  if (!isRecord(value)) return ''
  return readString(value, 'type')
}

export function getIndexerReferences(value: JsonValue | null | undefined): { dataSourceName: string; targetIndexName: string; skillsetName: string } {
  if (!isRecord(value)) return { dataSourceName: '', targetIndexName: '', skillsetName: '' }
  return {
    dataSourceName: readString(value, 'dataSourceName'),
    targetIndexName: readString(value, 'targetIndexName'),
    skillsetName: readString(value, 'skillsetName'),
  }
}

export function getFieldNames(indexValue: JsonValue | null | undefined): string[] {
  if (!isRecord(indexValue)) return []
  return readArray(indexValue, 'fields')
    .map((field) => (isRecord(field) ? readString(field, 'name') : ''))
    .filter((fieldName) => fieldName.length > 0)
}

export function getKeyFieldName(indexValue: JsonValue | null | undefined): string {
  if (!isRecord(indexValue)) return ''
  const fields = readArray(indexValue, 'fields')
  for (const field of fields) {
    if (!isRecord(field)) continue
    if (field.key === true) return readString(field, 'name')
  }
  return ''
}

export function getFieldMappings(indexerValue: JsonValue | null | undefined, key: 'fieldMappings' | 'outputFieldMappings'): Array<{ sourceFieldName: string; targetFieldName: string; mappingFunction?: JsonValue }> {
  if (!isRecord(indexerValue)) return []
  return readArray(indexerValue, key)
    .filter(isRecord)
    .map((mapping) => ({
      sourceFieldName: readString(mapping, 'sourceFieldName'),
      targetFieldName: readString(mapping, 'targetFieldName'),
      mappingFunction: mapping.mappingFunction,
    }))
}

function addIssue(issues: IndexingPipelineValidationIssue[], issue: IndexingPipelineValidationIssue): void {
  issues.push(issue)
}

function validateJsonParse(params: {
  draft: IndexingPipelineDraft
  resource: IndexingPipelineResourceKind
  language: Language
  issues: IndexingPipelineValidationIssue[]
}): JsonValue | null {
  const { draft, resource, language, issues } = params
  const textValue = draft[resource].text
  const parsed = parseResource(textValue)
  if (parsed.ok) {
    if (!isRecord(parsed.value)) {
      addIssue(issues, {
        id: `${resource}:notObject`,
        resource,
        severity: 'error',
        message: text(language, 'JSON は object である必要があります。', 'JSON must be an object.'),
      })
      return parsed.value
    }
    return parsed.value
  }

  addIssue(issues, {
    id: `${resource}:jsonParse`,
    resource,
    severity: 'error',
    message: text(language, `JSON の解析に失敗しました: ${parsed.message}`, `Failed to parse JSON: ${parsed.message}`),
  })
  return null
}

export function validateIndexingPipelineDraft(params: {
  draft: IndexingPipelineDraft
  apiVersion: string
  language: Language
}): IndexingPipelineValidationIssue[] {
  const { draft, apiVersion, language } = params
  const issues: IndexingPipelineValidationIssue[] = []

  const dataSource = validateJsonParse({ draft, resource: 'dataSource', language, issues })
  const index = validateJsonParse({ draft, resource: 'index', language, issues })
  const indexer = validateJsonParse({ draft, resource: 'indexer', language, issues })

  const dataSourceName = getResourceName(dataSource)
  const dataSourceType = getDataSourceType(dataSource)
  const indexName = getResourceName(index)
  const indexerName = getResourceName(indexer)
  const indexerRefs = getIndexerReferences(indexer)

  if (!dataSourceName) {
    addIssue(issues, {
      id: 'dataSource:nameMissing',
      resource: 'dataSource',
      severity: 'error',
      message: text(language, 'Data Source の name が未設定です。', 'Data source name is missing.'),
    })
  }

  if (!dataSourceType) {
    addIssue(issues, {
      id: 'dataSource:typeMissing',
      resource: 'dataSource',
      severity: 'error',
      message: text(language, 'Data Source の type が未設定です。', 'Data source type is missing.'),
    })
  } else if (!findDataSourceDescriptor(dataSourceType)) {
    addIssue(issues, {
      id: 'dataSource:typeUnknown',
      resource: 'dataSource',
      severity: 'warning',
      message: text(
        language,
        `Data Source type "${dataSourceType}" は catalog 未登録です。未知プロパティとして保持します。`,
        `Data source type "${dataSourceType}" is not in the catalog. It will be preserved as an unknown type.`,
      ),
    })
  } else if (getCanonicalDataSourceType(dataSourceType) !== dataSourceType.toLowerCase()) {
    addIssue(issues, {
      id: 'dataSource:typeAlias',
      resource: 'dataSource',
      severity: 'info',
      message: text(
        language,
        `Data Source type "${dataSourceType}" は alias として認識しました。`,
        `Data source type "${dataSourceType}" was recognized as an alias.`,
      ),
    })
  }

  if (hasUserAssignedDataSourceIdentity(dataSource) && !supportsUserAssignedManagedIdentity(apiVersion)) {
    addIssue(issues, {
      id: 'dataSource:userAssignedIdentityApiVersion',
      resource: 'dataSource',
      severity: 'error',
      message: text(
        language,
        'Data Source の User Assigned Managed Identity は REST API version 2026-04-01 以降でサポートされます。',
        'Data source user-assigned managed identity is supported in REST API version 2026-04-01 or later.',
      ),
    })
  }

  if (!indexName) {
    addIssue(issues, {
      id: 'index:nameMissing',
      resource: 'index',
      severity: 'error',
      message: text(language, 'Index の name が未設定です。', 'Index name is missing.'),
    })
  }

  const indexFieldNames = getFieldNames(index)
  if (index && indexFieldNames.length === 0) {
    addIssue(issues, {
      id: 'index:fieldsMissing',
      resource: 'index',
      severity: 'error',
      message: text(language, 'Index fields が未設定です。', 'Index fields are missing.'),
    })
  }
  if (index && indexFieldNames.length > 0 && !getKeyFieldName(index)) {
    addIssue(issues, {
      id: 'index:keyMissing',
      resource: 'index',
      severity: 'warning',
      message: text(language, 'key=true の field が見つかりません。', 'No field with key=true was found.'),
    })
  }

  if (!indexerName) {
    addIssue(issues, {
      id: 'indexer:nameMissing',
      resource: 'indexer',
      severity: 'error',
      message: text(language, 'Indexer の name が未設定です。', 'Indexer name is missing.'),
    })
  }
  if (!indexerRefs.dataSourceName) {
    addIssue(issues, {
      id: 'indexer:dataSourceNameMissing',
      resource: 'indexer',
      severity: 'error',
      message: text(language, 'Indexer の dataSourceName が未設定です。', 'Indexer dataSourceName is missing.'),
    })
  } else if (dataSourceName && indexerRefs.dataSourceName !== dataSourceName) {
    addIssue(issues, {
      id: 'pipeline:dataSourceReferenceMismatch',
      resource: 'pipeline',
      severity: 'error',
      message: text(
        language,
        `Indexer は "${indexerRefs.dataSourceName}" を参照していますが、draft Data Source は "${dataSourceName}" です。`,
        `Indexer references "${indexerRefs.dataSourceName}" but the draft data source is "${dataSourceName}".`,
      ),
    })
  }

  if (!indexerRefs.targetIndexName) {
    addIssue(issues, {
      id: 'indexer:targetIndexNameMissing',
      resource: 'indexer',
      severity: 'error',
      message: text(language, 'Indexer の targetIndexName が未設定です。', 'Indexer targetIndexName is missing.'),
    })
  } else if (indexName && indexerRefs.targetIndexName !== indexName) {
    addIssue(issues, {
      id: 'pipeline:indexReferenceMismatch',
      resource: 'pipeline',
      severity: 'error',
      message: text(
        language,
        `Indexer は "${indexerRefs.targetIndexName}" を参照していますが、draft Index は "${indexName}" です。`,
        `Indexer references "${indexerRefs.targetIndexName}" but the draft index is "${indexName}".`,
      ),
    })
  }

  const allMappings = [
    ...getFieldMappings(indexer, 'fieldMappings'),
    ...getFieldMappings(indexer, 'outputFieldMappings'),
  ]
  for (const mapping of allMappings) {
    if (!mapping.targetFieldName) continue
    if (indexFieldNames.length > 0 && !indexFieldNames.includes(mapping.targetFieldName)) {
      addIssue(issues, {
        id: `mapping:missingTarget:${mapping.targetFieldName}`,
        resource: 'indexer',
        severity: 'warning',
        message: text(
          language,
          `mapping target "${mapping.targetFieldName}" は Index fields に存在しません。`,
          `Mapping target "${mapping.targetFieldName}" does not exist in index fields.`,
        ),
      })
    }
  }

  if (isRecord(indexer)) {
    const knownTopLevel = new Set(INDEXER_TOP_LEVEL_FIELDS.map((field) => field.name))
    const unknownTopLevel = Object.keys(indexer).filter((key) => !knownTopLevel.has(key))
    if (unknownTopLevel.length > 0) {
      addIssue(issues, {
        id: 'indexer:unknownTopLevel',
        resource: 'indexer',
        severity: 'info',
        message: text(
          language,
          `Indexer の未登録 top-level property を保持します: ${unknownTopLevel.join(', ')}`,
          `Unknown indexer top-level properties will be preserved: ${unknownTopLevel.join(', ')}`,
        ),
      })
    }

    const parameters = isRecord(indexer.parameters) ? indexer.parameters : null
    if (parameters) {
      const knownParameterFields = new Set(INDEXER_PARAMETER_FIELDS.map((field) => field.name))
      const unknownParameterFields = Object.keys(parameters).filter((key) => !knownParameterFields.has(key))
      if (unknownParameterFields.length > 0) {
        addIssue(issues, {
          id: 'indexer:unknownParameters',
          resource: 'indexer',
          severity: 'info',
          message: text(
            language,
            `Indexer parameters の未登録 property を保持します: ${unknownParameterFields.join(', ')}`,
            `Unknown indexer parameter properties will be preserved: ${unknownParameterFields.join(', ')}`,
          ),
        })
      }

      const configuration = isRecord(parameters.configuration) ? parameters.configuration : null
      if (configuration) {
        const knownConfigurationFields = new Set(INDEXER_CONFIGURATION_FIELDS.map((field) => field.name))
        const unknownConfigurationFields = Object.keys(configuration).filter((key) => !knownConfigurationFields.has(key))
        if (unknownConfigurationFields.length > 0) {
          addIssue(issues, {
            id: 'indexer:unknownConfiguration',
            resource: 'indexer',
            severity: 'info',
            message: text(
              language,
              `parameters.configuration の未登録 property を保持します: ${unknownConfigurationFields.join(', ')}`,
              `Unknown parameters.configuration properties will be preserved: ${unknownConfigurationFields.join(', ')}`,
            ),
          })
        }
      }
    } else {
      addIssue(issues, {
        id: 'indexer:parametersMissing',
        resource: 'indexer',
        severity: 'info',
        message: text(language, 'parameters は未設定です。必要に応じて追加してください。', 'parameters is not set. Add it if needed.'),
      })
    }
  }

  if (issues.length === 0) {
    addIssue(issues, {
      id: 'pipeline:ready',
      resource: 'pipeline',
      severity: 'info',
      message: text(language, '基本検証は通過しています。Publish 前に差分と権限を確認してください。', 'Basic validation passed. Review diffs and permissions before publishing.'),
    })
  }

  return issues
}

export function countIssuesBySeverity(issues: IndexingPipelineValidationIssue[]): Record<'error' | 'warning' | 'info', number> {
  return issues.reduce(
    (counts, issue) => ({ ...counts, [issue.severity]: counts[issue.severity] + 1 }),
    { error: 0, warning: 0, info: 0 },
  )
}
