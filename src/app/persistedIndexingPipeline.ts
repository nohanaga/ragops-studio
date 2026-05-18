import type { JsonValue } from '../lib/aiSearchRest'
import type { IndexingPipelineDraft, IndexingPipelineJsonDraft } from '../types/indexingPipeline'

const STORAGE_KEY = 'ragops.indexingPipeline.current.v1'

const DEFAULT_DATA_SOURCE: JsonValue = {
  name: 'sample-datasource',
  type: 'azureblob',
  credentials: {
    connectionString: '<connection-string-or-managed-identity-settings>',
  },
  container: {
    name: 'sample-container',
    query: null,
  },
  dataChangeDetectionPolicy: null,
  dataDeletionDetectionPolicy: null,
}

const DEFAULT_INDEX: JsonValue = {
  name: 'sample-index',
  fields: [
    {
      name: 'id',
      type: 'Edm.String',
      key: true,
      searchable: false,
      filterable: true,
      sortable: true,
      facetable: false,
    },
    {
      name: 'content',
      type: 'Edm.String',
      searchable: true,
      filterable: false,
      sortable: false,
      facetable: false,
    },
    {
      name: 'source_path',
      type: 'Edm.String',
      searchable: false,
      filterable: true,
      sortable: false,
      facetable: false,
    },
  ],
}

const DEFAULT_INDEXER: JsonValue = {
  name: 'sample-indexer',
  dataSourceName: 'sample-datasource',
  targetIndexName: 'sample-index',
  disabled: false,
  schedule: null,
  fieldMappings: [
    {
      sourceFieldName: 'metadata_storage_path',
      targetFieldName: 'source_path',
    },
  ],
  outputFieldMappings: [],
  parameters: {
    batchSize: null,
    maxFailedItems: 0,
    maxFailedItemsPerBatch: 0,
    configuration: {
      dataToExtract: 'contentAndMetadata',
      parsingMode: 'default',
      imageAction: 'none',
    },
  },
}

function toPrettyJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2)
}

function draftFromValue(value: JsonValue, name?: string): IndexingPipelineJsonDraft {
  const text = toPrettyJson(value)
  return {
    text,
    baselineText: text,
    ...(name ? { loadedName: name } : {}),
  }
}

export function createDefaultIndexingPipelineDraft(): IndexingPipelineDraft {
  const now = new Date().toISOString()
  return {
    version: 1,
    updatedAt: now,
    activeTab: 'overview',
    dataSource: draftFromValue(DEFAULT_DATA_SOURCE, 'sample-datasource'),
    index: draftFromValue(DEFAULT_INDEX, 'sample-index'),
    indexer: draftFromValue(DEFAULT_INDEXER, 'sample-indexer'),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isJsonDraft(value: unknown): value is IndexingPipelineJsonDraft {
  return isObject(value) && isString(value.text) && isString(value.baselineText)
}

function normalizeJsonDraft(raw: unknown, fallback: IndexingPipelineJsonDraft): IndexingPipelineJsonDraft {
  if (!isJsonDraft(raw)) return fallback
  return {
    text: raw.text,
    baselineText: raw.baselineText,
    loadedName: typeof raw.loadedName === 'string' ? raw.loadedName : undefined,
    loadedAt: typeof raw.loadedAt === 'string' ? raw.loadedAt : undefined,
  }
}

function normalizeDraft(raw: unknown): IndexingPipelineDraft | null {
  if (!isObject(raw)) return null
  const fallback = createDefaultIndexingPipelineDraft()
  const activeTab = raw.activeTab
  // Migrate legacy tab identifiers from earlier revisions.
  const migratedActiveTab =
    activeTab === 'dataSource' || activeTab === 'configure'
      ? 'source'
      : activeTab === 'mappings'
      ? 'indexer'
      : activeTab === 'runStatus' || activeTab === 'run'
      ? 'overview'
      : activeTab
  return {
    version: 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : fallback.updatedAt,
    activeTab:
      migratedActiveTab === 'overview' ||
      migratedActiveTab === 'source' ||
      migratedActiveTab === 'index' ||
      migratedActiveTab === 'indexer' ||
      migratedActiveTab === 'rawJson'
        ? migratedActiveTab
        : fallback.activeTab,
    dataSource: normalizeJsonDraft(raw.dataSource, fallback.dataSource),
    index: normalizeJsonDraft(raw.index, fallback.index),
    indexer: normalizeJsonDraft(raw.indexer, fallback.indexer),
  }
}

const SECRET_JSON_KEY_PATTERN = /^(connectionString|apiKey|accountKey|applicationSecret|clientSecret|password|sasToken)$/i
const SECRET_TEXT_PATTERN = /("(?:connectionString|apiKey|accountKey|applicationSecret|clientSecret|password|sasToken)"\s*:\s*")([^"]*)(")/gi

function redactSensitiveJsonValue(value: JsonValue, key = ''): JsonValue {
  if (SECRET_JSON_KEY_PATTERN.test(key) && typeof value === 'string' && value.trim().length > 0) {
    return '<redacted>'
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitiveJsonValue(item))
  if (value && typeof value === 'object') {
    const next: Record<string, JsonValue> = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      next[childKey] = redactSensitiveJsonValue(childValue, childKey)
    }
    return next
  }
  return value
}

function maskSensitiveJsonText(text: string): string {
  return text.replace(SECRET_TEXT_PATTERN, '$1<redacted>$3')
}

function sanitizeJsonDraftForStorage(draft: IndexingPipelineJsonDraft): IndexingPipelineJsonDraft {
  const sanitizeText = (text: string) => {
    try {
      const parsed = JSON.parse(text) as JsonValue
      return toPrettyJson(redactSensitiveJsonValue(parsed))
    } catch {
      return maskSensitiveJsonText(text)
    }
  }

  return {
    ...draft,
    text: sanitizeText(draft.text),
    baselineText: sanitizeText(draft.baselineText),
  }
}

export function sanitizeIndexingPipelineDraftForStorage(draft: IndexingPipelineDraft): IndexingPipelineDraft {
  return {
    ...draft,
    dataSource: sanitizeJsonDraftForStorage(draft.dataSource),
    index: sanitizeJsonDraftForStorage(draft.index),
    indexer: sanitizeJsonDraftForStorage(draft.indexer),
  }
}

export function loadIndexingPipelineDraft(): IndexingPipelineDraft {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return createDefaultIndexingPipelineDraft()
    const parsed = JSON.parse(raw) as unknown
    return normalizeDraft(parsed) ?? createDefaultIndexingPipelineDraft()
  } catch {
    return createDefaultIndexingPipelineDraft()
  }
}

export function saveIndexingPipelineDraft(draft: IndexingPipelineDraft): void {
  try {
    const sanitized = sanitizeIndexingPipelineDraftForStorage({
      ...draft,
      updatedAt: new Date().toISOString(),
    })
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized))
  } catch {
    // Ignore restricted storage modes.
  }
}
