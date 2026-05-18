import type { JsonValue } from '../lib/aiSearchRest'
import type { IndexingPipelineDraft, IndexingPipelineJsonDraft } from '../types/indexingPipeline'

const CURRENT_DRAFT_STORAGE_KEY = 'ragops.indexingPipeline.current.v1'
const LIBRARY_STORAGE_KEY = 'ragops.indexingPipeline.library.v1'
const CURRENT_DRAFT_ID_STORAGE_KEY = 'ragops.indexingPipeline.currentId.v1'

export type PersistedIndexingPipelineItem = {
  id: string
  title: string
  updatedAt: number
  draft: IndexingPipelineDraft
}

type PersistedIndexingPipelineRoot = {
  items: PersistedIndexingPipelineItem[]
}

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

function safeParse(jsonText: string | null): unknown {
  if (!jsonText) return null
  try {
    return JSON.parse(jsonText) as unknown
  } catch {
    return null
  }
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

function readJsonName(jsonText: string): string {
  const parsed = safeParse(jsonText)
  if (!isObject(parsed)) return ''
  return typeof parsed.name === 'string' ? parsed.name.trim() : ''
}

export function deriveIndexingPipelineDraftTitle(draft: IndexingPipelineDraft, fallback = 'Indexing Pipeline draft'): string {
  const indexerName = readJsonName(draft.indexer.text)
  const indexName = readJsonName(draft.index.text)
  const dataSourceName = readJsonName(draft.dataSource.text)

  if (indexerName && indexName) return `${indexerName} -> ${indexName}`
  if (indexerName) return indexerName
  if (dataSourceName && indexName) return `${dataSourceName} -> ${indexName}`
  if (dataSourceName) return dataSourceName
  if (indexName) return indexName
  return fallback
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

function normalizeItem(raw: unknown): PersistedIndexingPipelineItem | null {
  if (!isObject(raw)) return null
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null
  if (typeof raw.title !== 'string') return null
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return null

  const draft = normalizeDraft(raw.draft)
  if (!draft) return null

  return {
    id: raw.id,
    title: raw.title.trim() || deriveIndexingPipelineDraftTitle(draft),
    updatedAt: raw.updatedAt,
    draft,
  }
}

function writeRoot(root: PersistedIndexingPipelineRoot): void {
  try {
    const sanitized: PersistedIndexingPipelineRoot = {
      items: root.items.map((item) => ({
        ...item,
        draft: sanitizeIndexingPipelineDraftForStorage(item.draft),
      })),
    }
    window.localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(sanitized))
  } catch {
    // Ignore restricted storage modes.
  }
}

function readLegacyCurrentDraft(): IndexingPipelineDraft | null {
  const parsed = safeParse(window.localStorage.getItem(CURRENT_DRAFT_STORAGE_KEY))
  return normalizeDraft(parsed)
}

function migrateLegacyCurrentDraft(): PersistedIndexingPipelineRoot {
  const legacyDraft = readLegacyCurrentDraft()
  if (!legacyDraft) return { items: [] }

  const item: PersistedIndexingPipelineItem = {
    id: 'legacy-current',
    title: deriveIndexingPipelineDraftTitle(legacyDraft),
    updatedAt: Date.now(),
    draft: legacyDraft,
  }
  const root = { items: [item] }
  writeRoot(root)
  return root
}

function readRoot(): PersistedIndexingPipelineRoot {
  const raw = window.localStorage.getItem(LIBRARY_STORAGE_KEY)
  if (!raw) return migrateLegacyCurrentDraft()

  const parsed = safeParse(raw)
  if (!isObject(parsed) || !Array.isArray(parsed.items)) return { items: [] }

  const items = parsed.items
    .map(normalizeItem)
    .filter((item): item is PersistedIndexingPipelineItem => item !== null)
  return { items }
}

export function listIndexingPipelineDrafts(): PersistedIndexingPipelineItem[] {
  const root = readRoot()
  return [...root.items].sort((left, right) => right.updatedAt - left.updatedAt)
}

export function getIndexingPipelineDraft(id: string): PersistedIndexingPipelineItem | null {
  const root = readRoot()
  return root.items.find((item) => item.id === id) ?? null
}

export function upsertIndexingPipelineDraft(item: PersistedIndexingPipelineItem): void {
  const root = readRoot()
  const now = Date.now()
  const next: PersistedIndexingPipelineItem = {
    ...item,
    title: item.title.trim() || deriveIndexingPipelineDraftTitle(item.draft),
    updatedAt: now,
    draft: sanitizeIndexingPipelineDraftForStorage({
      ...item.draft,
      updatedAt: new Date(now).toISOString(),
    }),
  }
  const existingIndex = root.items.findIndex((candidate) => candidate.id === next.id)
  if (existingIndex >= 0) {
    root.items[existingIndex] = next
  } else {
    root.items.unshift(next)
  }

  writeRoot(root)
}

export function deleteIndexingPipelineDraft(id: string): void {
  const root = readRoot()
  root.items = root.items.filter((item) => item.id !== id)
  writeRoot(root)

  if (loadIndexingPipelineCurrentDraftId() === id) {
    saveIndexingPipelineCurrentDraftId(null)
    try {
      window.localStorage.removeItem(CURRENT_DRAFT_STORAGE_KEY)
    } catch {
      // Ignore restricted storage modes.
    }
  }
}

export function loadIndexingPipelineCurrentDraftId(): string | null {
  try {
    const value = window.localStorage.getItem(CURRENT_DRAFT_ID_STORAGE_KEY)
    return value && value.trim() ? value : null
  } catch {
    return null
  }
}

export function saveIndexingPipelineCurrentDraftId(id: string | null): void {
  try {
    if (id && id.trim()) {
      window.localStorage.setItem(CURRENT_DRAFT_ID_STORAGE_KEY, id)
    } else {
      window.localStorage.removeItem(CURRENT_DRAFT_ID_STORAGE_KEY)
    }
  } catch {
    // Ignore restricted storage modes.
  }
}

export function loadIndexingPipelineDraft(): IndexingPipelineDraft {
  return createDefaultIndexingPipelineDraft()
}

export function saveIndexingPipelineDraft(draft: IndexingPipelineDraft): void {
  try {
    const sanitized = sanitizeIndexingPipelineDraftForStorage({
      ...draft,
      updatedAt: new Date().toISOString(),
    })
    window.localStorage.setItem(CURRENT_DRAFT_STORAGE_KEY, JSON.stringify(sanitized))
  } catch {
    // Ignore restricted storage modes.
  }
}
