import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { json } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import { JsonViewer } from '../viewers/JsonViewer'
import {
  IndexingPipelinePublishModal,
  type IndexingPipelinePublishResourceKind,
  type IndexingPipelinePublishReviewResource,
} from './IndexingPipelinePublishModal'
import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import type { ThemePreference } from '../../types/app'
import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import {
  createOrUpdateDataSource,
  createOrUpdateIndex,
  createOrUpdateIndexer,
  getDataSourceDefinition,
  getIndexDefinition,
  getIndexStatistics,
  getIndexerDefinition,
  getIndexerStatus,
  listDataSources,
  listIndexes,
  listIndexers,
  resetIndexer,
  runIndexer,
  searchDocuments,
  type JsonValue,
  type RestResult,
} from '../../lib/aiSearchRest'
import { normalizeStorageResourceIdInput } from '../../lib/azureBlobStorage'
import { computeIndexDiff } from '../../utils/indexDiff'
import { computeResourceDiff, type ResourceDiffResult } from '../../utils/skillsetDiff'
import {
  dataSourceLabel,
  findDataSourceDescriptor,
  INDEXER_CONFIGURATION_FIELDS,
  INDEXER_PARAMETER_FIELDS,
  SUPPORTED_DATA_SOURCE_DESCRIPTORS,
  isRequiredSchemaParameter,
  schemaParameterDocs,
  schemaFieldNotes,
  type DataSourceDescriptor,
  type IndexerSchemaField,
} from '../../lib/aiSearchIndexerSchemas'
import {
  createDefaultIndexingPipelineDraft,
  createEmptyIndexingPipelineDraft,
  deleteIndexingPipelineDraft,
  deriveIndexingPipelineDraftTitle,
  getIndexingPipelineDraft,
  listIndexingPipelineDrafts,
  upsertIndexingPipelineDraft,
  type PersistedIndexingPipelineItem,
} from '../../app/persistedIndexingPipeline'
import type {
  IndexingPipelineDraft,
  IndexingPipelineEditorTab,
  IndexingPipelineJsonDraft,
  IndexingPipelineResourceKind,
  IndexingPipelineValidationIssue,
} from '../../types/indexingPipeline'
import {
  countIssuesBySeverity,
  getDataSourceType,
  getFieldMappings,
  getFieldNames,
  getIndexerReferences,
  getKeyFieldName,
  getResourceName,
  parseDraftJson,
  parseIndexingPipelineDraft,
  validateIndexingPipelineDraft,
} from '../../utils/indexingPipelineValidation'

type IndexingPipelineBuilderProps = {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion | ''
  language: Language
  theme: ThemePreference
  copyToClipboard: (text: string) => Promise<void>
  onOpenIndexBuilder?: (indexName: string) => void
}

type UiMessage = { type: 'success' | 'error' | 'info' | 'warning'; text: string }

type ResourceLists = {
  dataSources: string[]
  indexes: string[]
  indexers: string[]
}

type VerificationState = {
  stats: JsonValue | null
  sample: JsonValue | null
  error: string | null
}

type PipelineStepId = 'validate' | 'dataSource' | 'index' | 'indexer' | 'run' | 'status' | 'verify'
type PipelineStepStatus = 'idle' | 'running' | 'success' | 'error' | 'skipped'
type DataSourceCredentialMode = 'connectionString' | 'systemAssignedManagedIdentity' | 'userAssignedManagedIdentity'

type PipelineStepState = {
  status: PipelineStepStatus
  detail?: string
  response?: JsonValue | null
  updatedAt?: string
}

type PipelineStepMap = Record<PipelineStepId, PipelineStepState>

type PreparedPipelineDrafts = {
  dataSource: Record<string, JsonValue>
  index: Record<string, JsonValue>
  indexer: Record<string, JsonValue>
  dataSourceName: string
  indexName: string
  indexerName: string
}

type PipelineUpdateReviewResource = IndexingPipelinePublishReviewResource & {
  candidate: Record<string, JsonValue>
}

const emptyResourceLists: ResourceLists = { dataSources: [], indexes: [], indexers: [] }
const DATA_SOURCE_USER_ASSIGNED_IDENTITY_ODATA_TYPE = '#Microsoft.Azure.Search.DataUserAssignedIdentity'

const stepOrder: PipelineStepId[] = ['validate', 'dataSource', 'index', 'indexer', 'run', 'status', 'verify']

const copy = {
  ja: {
    subtitle: 'データソースからインデックス作成、インデクサー実行、ターゲットインデックス検証までを 1 つのパイプラインとして設計・追跡します。',
    missingConnection: '接続プロファイルと API version を設定してください。',
    resources: 'Service resource hub',
    refreshResources: '再読み込み',
    loadSelected: '選択 Indexer を読込',
    noIndexers: 'Indexer はありません',
    noDataSources: 'Data Source はありません',
    noIndexes: 'Index はありません',
    dataSources: 'Data Sources',
    dataSource: 'Data Source',
    indexes: 'Indexes',
    index: 'Index',
    indexers: 'Indexers',
    newDraft: '新規ドラフト',
    saveDraft: 'ドラフトを保存',
    saveDraftAs: '名前を付けて保存',
    savedDrafts: 'ローカルドラフト一覧',
    noPipelineLoadedTitle: 'パイプライン未選択',
    noPipelineLoadedHint: 'パイプラインが選択されていません。',
    noSavedDrafts: '保存済みドラフトはありません。',
    loadDraft: '読み込み',
    cloneDraft: '複製',
    deleteDraft: '削除',
    saveDraftAsPrompt: 'ドラフト名を入力してください:',
    loadDraftConfirm: '現在の編集中の内容は破棄されます。選択したドラフトを読み込みますか？',
    cloneDraftConfirm: '選択したドラフトを複製して開きますか？',
    deleteDraftConfirm: 'このドラフトを削除しますか？',
    draftLoaded: 'ドラフトを読み込みました。',
    draftDeleted: 'ドラフトを削除しました。',
    draftCloned: 'ドラフトを複製しました。',
    currentDraft: '編集中',
    noLocalDraftLoaded: '未保存',
    copyJson: 'JSON コピー',
    clear: 'クリア',
    overview: 'Pipeline',
    sourceInspector: 'Source node',
    indexInspector: 'Index node',
    indexerInspector: 'Indexer node',
    runInspector: 'Run tracker',
    rawJson: 'Raw JSON',
    openOverview: 'Overview',
    openRun: 'Run tracker',
    openRawJson: 'Raw JSON',
    nodeNavHint: 'パイプラインノードをクリックすると、そのノード専用のインスペクターが開きます。',
    selectedNode: '選択ノード',
    parameterGroupsTitle: 'Indexer パラメーター',
    parameterGroupsHint: 'Azure AI Search のインデクサー設定は、グループごとに意味と影響範囲が異なります。必要なグループだけを展開して調整してください。',
    nothingToConfigure: 'インデクサーパラメーターは現在のソース種別では使われません。',
    sourceTypeHero: 'ソースの種別',
    sourceTypeHint: 'インデクサーがクロールするデータソースの種別を選択してください。選択した種別に応じて、設定項目とインデクサーパラメーターが切り替わります。',
    changeSourceType: 'ソース種別を変更',
    connectionGroup: '接続 / 認証',
    connectionGroupHint: '認証は接続文字列または Managed Identity で提供します。シークレットは保存時に自動的にマスキングされます。',
    containerGroup: 'コンテナー / スコープ',
    containerGroupHint: 'コンテナー、テーブル、サイト、ライブラリなど、取り込み対象の物理スコープを指定します。クエリで仮想フォルダーや取得範囲を絞り込みます。',
    indexerIdentityGroup: 'アイデンティティ',
    indexerIdentityGroupHint: 'インデクサー名、参照するデータソース、ターゲットインデックス、スキルセット、スケジュールを扱います。スケジュール間隔は ISO 8601 表記 (PT2H など) です。',
    indexerMappingsGroup: 'フィールドマッピング',
    indexerMappingsGroupHint: 'ソースフィールドとインデックスフィールドのスキーマが一致しない場合にマッピングを定義します。スキルセットの出力をインデックスへ保存する場合は outputFieldMappings を使用します。',
    indexHeroTitle: 'ターゲット Index',
    indexHeroHint: 'スキーマとキー フィールドは Index Builder で設計します。ここではインデクサーが参照するターゲットと、現在のフィールド一覧を確認します。',
    keyFieldHint: 'キー フィールドはインデックス内でドキュメントを一意に識別します。URL やパスをキーに使う場合は、インデクサーの base64EncodeKeys を true にします。',
    openInIndexBuilder: 'Index Builder で開く',
    checks: 'Checks',
    pipeline: 'Pipeline',
    source: 'Source',
    importProcess: 'Indexer',
    target: 'Target index',
    verification: 'Verify index',
    selected: '選択中',
    draftSaved: 'ドラフトを保存しました。シークレット値は保存時にマスキングされます。',
    draftReset: '新しい Indexing Pipeline draft を作成しました。',
    copied: 'JSON をコピーしました。',
    loading: '読み込み中',
    failedToLoad: '読み込みに失敗しました',
    loadedPipeline: 'Indexer pipeline を読み込みました',
    partialLoad: '一部の依存リソースを読み込めませんでした',
    fieldMappings: 'fieldMappings',
    outputFieldMappings: 'outputFieldMappings',
    sourceField: 'Source field',
    targetField: 'Target field',
    mappingFunction: 'Mapping function',
    noMappings: 'Mapping はありません',
    addMapping: 'Mapping を追加',
    removeMapping: 'Mapping を削除',
    mappingFunctionName: 'Mapping function 名',
    resetIndexer: 'Indexer リセット',
    resetIndexerConfirm: 'この Indexer の変更追跡状態をリセットします。次回実行時に対象データが再処理される可能性があります。実行しますか？',
    resetQueued: 'Indexer reset を要求しました。次回実行で再処理されます。',
    runIndexer: 'Indexer 実行',
    refreshStatus: 'Status 更新',
    verifyTarget: 'Target 検証',
    updateRunPipeline: 'Publish & Run pipeline',
    updateRunStarted: 'Publish & Run pipeline を開始しました。',
    updateReviewLoading: '差分を取得中...',
    noResourceUpdates: '更新対象はありません。Publish を省略して Run のみ実行します。',
    status: 'Indexer status',
    lastRun: 'Last run response',
    indexVerification: 'Index verification',
    noStatus: 'Status はまだ取得していません。',
    noVerification: 'Target Index 検証はまだ実行していません。',
    runQueued: 'Indexer run を要求しました。',
    statusUpdated: 'Indexer status を更新しました。',
    verified: 'Target Index を検証しました。',
    errors: 'Errors',
    warnings: 'Warnings',
    infos: 'Info',
    dataSourceName: 'dataSourceName',
    fields: 'fields',
    keyField: 'key field',
    targetIndexUnset: 'targetIndexName が未設定です。',
    indexerNameUnset: 'Indexer name が未設定です。',
    searchIndexers: 'Indexerを検索',
    selectedIndexer: 'Load from Indexer',
    filterIndexers: 'Indexer を絞り込み',
    noIndexerMatches: '一致する Indexer はありません',
    loadedIndexerContext: '読み込み中の Indexer',
    newIndexerDraftBadge: '新規',
    serviceLoadedBadge: '読込済み',
    draftIndexerName: 'Draft 名',
    unsaved: '未保存',
    resourceCounts: 'Service counts',
    chooseType: 'Source type',
    applyType: 'このtypeを適用',
    sourceBasics: 'Data ingest source',
    indexBasics: 'Target index',
    indexerBasics: 'Indexer orchestration',
    indexerParameters: 'Indexer parameters',
    configurationParameters: 'Source-specific configuration',
    runPipeline: 'Run pipeline',
    formsFirst: 'フォームでパイプラインを編集し、Raw JSON は確認・例外設定に使います。',
    name: 'Name',
    description: 'Description',
    type: 'Type',
    containerName: 'Container / table / scope',
    containerQuery: 'Query / folder scope',
    credentialMode: 'Credential mode',
    credentialModeConnectionString: '接続文字列 / キー',
    credentialModeSystemManagedIdentity: 'システム割り当て Managed Identity',
    credentialModeUserManagedIdentity: 'ユーザー割り当て Managed Identity',
    managedIdentityResourceId: '接続先 Resource ID',
    userAssignedIdentity: 'User-assigned identity Resource ID',
    managedIdentityResourceIdHint: 'Azure Portal のストレージアカウント URL、/subscriptions/...、ResourceId=/subscriptions/... のいずれを貼り付けても、credentials.connectionString には ResourceId=/subscriptions/...; として保存します。',
    userAssignedIdentityHint: 'Search サービスに割り当て済みの User Assigned Managed Identity の Resource ID を指定します。REST API version 2026-04-01 以降が必要です。',
    userAssignedIdentityApiWarning: 'User Assigned Managed Identity は REST API version 2026-04-01 以降でサポートされます。',
    connectionString: '接続文字列 / 資格情報プレースホルダー',
    disabled: 'Disabled',
    scheduleInterval: 'Schedule interval',
    targetIndexName: 'targetIndexName',
    skillsetName: 'skillsetName',
    batchSize: 'batchSize',
    maxFailedItems: 'maxFailedItems',
    maxFailedItemsPerBatch: 'maxFailedItemsPerBatch',
    base64EncodeKeys: 'base64EncodeKeys',
    documentCount: 'documents',
    sampleCount: 'sample docs',
    activeFields: 'active fields',
    vectorFields: 'vector fields',
    runStarted: 'Pipeline run を開始しました。',
    pipelineCompleted: 'Pipeline run が完了しました。',
    validationBlocked: 'Validation error があるため停止しました。',
    parseBlocked: 'JSON parse error があるため停止しました。',
    rawJsonHint: 'Raw JSON は高度な設定と未知プロパティ保持のために残しています。通常の編集は各ノードのインスペクターを使用してください。',
    statusIdle: '待機中',
    statusRunning: '実行中',
    statusSuccess: '完了',
    statusError: '失敗',
    statusSkipped: '未実行',
    stepValidate: 'ドラフト検証',
    stepDataSource: 'データソース更新',
    stepIndex: 'インデックス作成 / 更新',
    stepIndexer: 'インデクサー更新',
    stepRun: 'インデクサー実行',
    stepStatus: 'ステータス取得',
    stepVerify: 'ターゲット検証',
  },
  en: {
    subtitle: 'Design and track data ingest through index creation, indexer execution, and target-index verification as one pipeline.',
    missingConnection: 'Set a connection profile and API version first.',
    resources: 'Service resource hub',
    refreshResources: 'Refresh',
    loadSelected: 'Load selected indexer',
    noIndexers: 'No indexers',
    noDataSources: 'No data sources',
    noIndexes: 'No indexes',
    dataSources: 'Data Sources',
    dataSource: 'Data Source',
    indexes: 'Indexes',
    index: 'Index',
    indexers: 'Indexers',
    newDraft: 'New draft',
    saveDraft: 'Save draft',
    saveDraftAs: 'Save as',
    savedDrafts: 'Local Pipeline Drafts',
    noPipelineLoadedTitle: 'No pipeline selected',
    noPipelineLoadedHint: 'No pipeline is selected.',
    noSavedDrafts: 'No saved drafts.',
    loadDraft: 'Load',
    cloneDraft: 'Clone',
    deleteDraft: 'Delete',
    saveDraftAsPrompt: 'Enter a draft name:',
    loadDraftConfirm: 'This will discard your current edits. Load the selected draft?',
    cloneDraftConfirm: 'Clone the selected draft and open the copy?',
    deleteDraftConfirm: 'Delete this draft?',
    draftLoaded: 'Draft loaded.',
    draftDeleted: 'Draft deleted.',
    draftCloned: 'Draft cloned.',
    currentDraft: 'Current',
    noLocalDraftLoaded: 'Not saved',
    copyJson: 'Copy JSON',
    clear: 'Clear',
    overview: 'Pipeline',
    sourceInspector: 'Source node',
    indexInspector: 'Index node',
    indexerInspector: 'Indexer node',
    runInspector: 'Run tracker',
    rawJson: 'Raw JSON',
    openOverview: 'Overview',
    openRun: 'Run tracker',
    openRawJson: 'Raw JSON',
    nodeNavHint: 'Click a pipeline node to open its dedicated inspector.',
    selectedNode: 'Selected node',
    parameterGroupsTitle: 'Indexer parameter groups',
    parameterGroupsHint: 'Azure AI Search indexer parameters have very different impact per group. Expand only what you need to change.',
    nothingToConfigure: 'No indexer parameters apply to the current source type.',
    sourceTypeHero: 'Source type',
    sourceTypeHint: 'Choose the kind of data the indexer should crawl. Settings and parameters below adapt to your choice.',
    changeSourceType: 'Change source type',
    connectionGroup: 'Connection / identity',
    connectionGroupHint: 'Authenticate with a connection string or managed identity. Secret values are redacted automatically on save.',
    containerGroup: 'Container / scope',
    containerGroupHint: 'Pick the physical scope (container, table, site, library, ...) to index. Use Query to narrow with a folder or query.',
    indexerIdentityGroup: 'Identity',
    indexerIdentityGroupHint: 'Indexer name, references (Data Source / Target Index / Skillset) and the schedule. Schedule interval uses ISO 8601 (for example PT2H).',
    indexerMappingsGroup: 'Field mappings',
    indexerMappingsGroupHint: 'Use fieldMappings when source and index field names do not match. Use outputFieldMappings to project skillset outputs into the index.',
    indexHeroTitle: 'Target index',
    indexHeroHint: 'Design the schema and key field in Index Schema Builder. Here you confirm what the indexer targets and view the current field set.',
    keyFieldHint: 'The key field uniquely identifies each document. If you key on a URL or path, set the indexer parameter base64EncodeKeys to true.',
    openInIndexBuilder: 'Open in Index Builder',
    checks: 'Checks',
    pipeline: 'Pipeline',
    source: 'Source',
    importProcess: 'Indexer',
    target: 'Target index',
    verification: 'Verify index',
    selected: 'Selected',
    draftSaved: 'Draft saved. Secret values are redacted on save.',
    draftReset: 'Created a new Indexing Pipeline draft.',
    copied: 'Copied JSON.',
    loading: 'Loading',
    failedToLoad: 'Failed to load',
    loadedPipeline: 'Loaded indexer pipeline.',
    partialLoad: 'Some dependent resources could not be loaded.',
    fieldMappings: 'fieldMappings',
    outputFieldMappings: 'outputFieldMappings',
    sourceField: 'Source field',
    targetField: 'Target field',
    mappingFunction: 'Mapping function',
    noMappings: 'No mappings',
    addMapping: 'Add mapping',
    removeMapping: 'Remove mapping',
    mappingFunctionName: 'Mapping function name',
    resetIndexer: 'Reset indexer',
    resetIndexerConfirm: 'Reset this indexer change-tracking state? The next run may reprocess the source data.',
    resetQueued: 'Requested indexer reset. The next run will reprocess source data.',
    runIndexer: 'Run indexer',
    refreshStatus: 'Refresh status',
    verifyTarget: 'Verify target',
    updateRunPipeline: 'Publish & Run pipeline',
    updateRunStarted: 'Publish & Run pipeline started.',
    updateReviewLoading: 'Loading diff...',
    noResourceUpdates: 'No resource updates. Skipping update and running the indexer.',
    status: 'Indexer status',
    lastRun: 'Last run response',
    indexVerification: 'Index verification',
    noStatus: 'Status has not been loaded yet.',
    noVerification: 'Target index verification has not run yet.',
    runQueued: 'Requested indexer run.',
    statusUpdated: 'Indexer status refreshed.',
    verified: 'Target index verified.',
    errors: 'Errors',
    warnings: 'Warnings',
    infos: 'Info',
    dataSourceName: 'dataSourceName',
    fields: 'fields',
    keyField: 'key field',
    targetIndexUnset: 'targetIndexName is not set.',
    indexerNameUnset: 'Indexer name is not set.',
    searchIndexers: 'Search indexers',
    selectedIndexer: 'Load from Indexer',
    filterIndexers: 'Filter indexers',
    noIndexerMatches: 'No matching indexers',
    loadedIndexerContext: 'Current indexer',
    newIndexerDraftBadge: 'New',
    serviceLoadedBadge: 'Loaded',
    draftIndexerName: 'Draft name',
    unsaved: 'Unsaved',
    resourceCounts: 'Service counts',
    chooseType: 'Source type',
    applyType: 'Apply this type',
    sourceBasics: 'Data ingest source',
    indexBasics: 'Target index',
    indexerBasics: 'Indexer orchestration',
    indexerParameters: 'Indexer parameters',
    configurationParameters: 'Source-specific configuration',
    runPipeline: 'Run pipeline',
    formsFirst: 'Edit the pipeline through forms. Raw JSON is for inspection and advanced exceptions.',
    name: 'Name',
    description: 'Description',
    type: 'Type',
    containerName: 'Container / table / scope',
    containerQuery: 'Query / folder scope',
    credentialMode: 'Credential mode',
    credentialModeConnectionString: 'Connection string / key',
    credentialModeSystemManagedIdentity: 'System-assigned managed identity',
    credentialModeUserManagedIdentity: 'User-assigned managed identity',
    managedIdentityResourceId: 'Target Resource ID',
    userAssignedIdentity: 'User-assigned identity Resource ID',
    managedIdentityResourceIdHint: 'Paste an Azure portal storage account URL, /subscriptions/..., or ResourceId=/subscriptions/.... It is stored in credentials.connectionString as ResourceId=/subscriptions/...;.',
    userAssignedIdentityHint: 'Specify the Resource ID of a user-assigned managed identity already attached to the search service. Requires REST API version 2026-04-01 or later.',
    userAssignedIdentityApiWarning: 'User-assigned managed identity is supported in REST API version 2026-04-01 or later.',
    connectionString: 'Connection string / credential placeholder',
    disabled: 'Disabled',
    scheduleInterval: 'Schedule interval',
    targetIndexName: 'targetIndexName',
    skillsetName: 'skillsetName',
    batchSize: 'batchSize',
    maxFailedItems: 'maxFailedItems',
    maxFailedItemsPerBatch: 'maxFailedItemsPerBatch',
    base64EncodeKeys: 'base64EncodeKeys',
    documentCount: 'documents',
    sampleCount: 'sample docs',
    activeFields: 'active fields',
    vectorFields: 'vector fields',
    runStarted: 'Pipeline run started.',
    pipelineCompleted: 'Pipeline run completed.',
    validationBlocked: 'Stopped because validation has errors.',
    parseBlocked: 'Stopped because one or more JSON drafts cannot be parsed.',
    rawJsonHint: 'Raw JSON remains available for advanced settings and unknown property preservation. Use the node inspectors for normal edits.',
    statusIdle: 'Idle',
    statusRunning: 'Running',
    statusSuccess: 'Done',
    statusError: 'Failed',
    statusSkipped: 'Skipped',
    stepValidate: 'Validate draft',
    stepDataSource: 'Update Data Source',
    stepIndex: 'Create / update Index',
    stepIndexer: 'Update Indexer',
    stepRun: 'Run Indexer',
    stepStatus: 'Read Status',
    stepVerify: 'Verify Target Index',
  },
} as const

type CopyKey = keyof typeof copy.ja

const auxNavItems: Array<{ id: IndexingPipelineEditorTab; icon: string; labelKey: CopyKey }> = [
  { id: 'overview', icon: 'bi-diagram-3', labelKey: 'openOverview' },
  { id: 'rawJson', icon: 'bi-braces', labelKey: 'openRawJson' },
]

const auxNavGuideTargets: Partial<Record<IndexingPipelineEditorTab, string>> = {
  overview: 'ipb-tab-overview',
  rawJson: 'ipb-tab-raw-json',
}

type ParameterGroupId =
  | 'performance'
  | 'failureTolerance'
  | 'keyHandling'
  | 'executionEnv'
  | 'sourceParsing'
  | 'fileFilters'
  | 'imageHandling'
  | 'database'
  | 'sharepoint'
  | 'previewVerbalization'

type ParamScope = 'parameter' | 'configuration'
type FieldMappingKey = 'fieldMappings' | 'outputFieldMappings'

type ParameterGroupDef = {
  id: ParameterGroupId
  titleJa: string
  titleEn: string
  introJa: string
  introEn: string
  members: Array<{ name: string; scope: ParamScope }>
}

const PARAMETER_GROUPS: ParameterGroupDef[] = [
  {
    id: 'performance',
    titleJa: 'スループット',
    titleEn: 'Throughput',
    introJa: '1 batch あたりの document 数を調整して、ingest 速度と service 側 throttling のバランスをとります。',
    introEn: 'Tune documents per batch to balance ingest speed against service-side throttling.',
    members: [{ name: 'batchSize', scope: 'parameter' }],
  },
  {
    id: 'failureTolerance',
    titleJa: '失敗の許容',
    titleEn: 'Failure tolerance',
    introJa: '解析できない document を許容する閾値です。-1 は無制限。本番では小さく、初期化時は緩めるのが定石です。',
    introEn: 'Thresholds for items the indexer is allowed to fail on. -1 means unlimited. Usually small in production, looser during initial loads.',
    members: [
      { name: 'maxFailedItems', scope: 'parameter' },
      { name: 'maxFailedItemsPerBatch', scope: 'parameter' },
    ],
  },
  {
    id: 'keyHandling',
    titleJa: 'Key 整形',
    titleEn: 'Key handling',
    introJa: 'metadata_storage_path のような URL を index の key に使う場合、URL-safe base64 へ encode する必要があります。',
    introEn: 'When using URL-like values such as metadata_storage_path as the index key, URL-safe base64 encoding is required.',
    members: [{ name: 'base64EncodeKeys', scope: 'parameter' }],
  },
  {
    id: 'executionEnv',
    titleJa: '実行環境',
    titleEn: 'Execution environment',
    introJa: 'standard は共有実行環境、private は managed private endpoint を使う隔離環境です。ネットワーク要件で選びます。',
    introEn: 'standard runs on shared compute, private runs in an isolated environment that supports managed private endpoints. Choose based on network requirements.',
    members: [{ name: 'executionEnvironment', scope: 'configuration' }],
  },
  {
    id: 'sourceParsing',
    titleJa: 'ソース解析',
    titleEn: 'Source parsing',
    introJa: 'JSON / JSON Lines / CSV / プレーンテキスト など、blob の中身をどう document として解釈するかを決めます。',
    introEn: 'Decides how blob content is interpreted as documents — JSON, JSON Lines, CSV, plain text, etc.',
    members: [
      { name: 'parsingMode', scope: 'configuration' },
      { name: 'dataToExtract', scope: 'configuration' },
      { name: 'documentRoot', scope: 'configuration' },
      { name: 'textSplitMode', scope: 'configuration' },
      { name: 'firstLineContainsHeaders', scope: 'configuration' },
      { name: 'delimitedTextHeaders', scope: 'configuration' },
      { name: 'delimitedTextDelimiter', scope: 'configuration' },
    ],
  },
  {
    id: 'fileFilters',
    titleJa: 'ファイルフィルター',
    titleEn: 'File filters',
    introJa: '対象 / 除外する拡張子と、解析不能ファイル時の挙動を定義します。教育用ノート: 失敗扱いにする/しないで run のステータスが変わります。',
    introEn: 'Define included/excluded extensions and how unsupported files behave. Note: choosing fail-on-* changes whether the run reports as failed.',
    members: [
      { name: 'indexedFileNameExtensions', scope: 'configuration' },
      { name: 'excludedFileNameExtensions', scope: 'configuration' },
      { name: 'failOnUnsupportedContentType', scope: 'configuration' },
      { name: 'failOnUnprocessableDocument', scope: 'configuration' },
      { name: 'indexStorageMetadataOnlyForOversizedDocuments', scope: 'configuration' },
    ],
  },
  {
    id: 'imageHandling',
    titleJa: '画像処理',
    titleEn: 'Image handling',
    introJa: '画像を正規化し、Skillset から扱えるようにします。OCR / image embedding 設計と密接に関係します。',
    introEn: 'Normalizes images so a skillset can process them. Closely tied to OCR / image embedding design.',
    members: [
      { name: 'imageAction', scope: 'configuration' },
      { name: 'normalizedImageMaxWidth', scope: 'configuration' },
      { name: 'normalizedImageMaxHeight', scope: 'configuration' },
      { name: 'allowSkillsetToReadFileData', scope: 'configuration' },
      { name: 'pdfTextRotationAlgorithm', scope: 'configuration' },
    ],
  },
  {
    id: 'database',
    titleJa: 'データベース固有',
    titleEn: 'Database options',
    introJa: 'SQL / Cosmos DB 系の query timeout と high-water mark の扱いを設定します。',
    introEn: 'Query timeout and high-water-mark behavior for SQL / Cosmos DB sources.',
    members: [
      { name: 'queryTimeout', scope: 'configuration' },
      { name: 'convertHighWaterMarkToRowVersion', scope: 'configuration' },
      { name: 'assumeOrderByHighWaterMarkColumn', scope: 'configuration' },
    ],
  },
  {
    id: 'sharepoint',
    titleJa: 'SharePoint 連携',
    titleEn: 'SharePoint integration',
    introJa: 'SharePoint Online 用の追加列指定など。Site/Library/List scope と組み合わせて使います。',
    introEn: 'SharePoint Online specific options such as additional columns. Combine with site/library/list scope.',
    members: [{ name: 'additionalColumns', scope: 'configuration' }],
  },
  {
    id: 'previewVerbalization',
    titleJa: '画像 verbalization (preview)',
    titleEn: 'Image verbalization (preview)',
    introJa: 'preview 機能。画像内容を自然言語化する処理を有効化/無効化します。',
    introEn: 'Preview feature toggling automatic verbalization of image content.',
    members: [
      { name: 'disableImageVerbalization', scope: 'configuration' },
      { name: 'imageVerbalizationDescription', scope: 'configuration' },
    ],
  },
]

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function prettyJson(value: JsonValue | null | undefined): string {
  return JSON.stringify(value ?? null, null, 2)
}

function cloneRecordForDiff(value: Record<string, JsonValue>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function redactConnectionStringForDiff(value: string, marker?: 'current' | 'draft'): string {
  const prefix = /^ResourceId=/i.test(value.trim()) ? 'ResourceId=' : ''
  const suffix = prefix ? ';' : ''
  return `${prefix}<redacted${marker ? `:${marker}` : ''}>${suffix}`
}

function setMaskedConnectionString(value: Record<string, unknown>, marker?: 'current' | 'draft') {
  const credentials = value.credentials
  if (credentials && typeof credentials === 'object' && !Array.isArray(credentials)) {
    const credentialRecord = credentials as Record<string, unknown>
    if (typeof credentialRecord.connectionString === 'string' && credentialRecord.connectionString.trim()) {
      credentialRecord.connectionString = redactConnectionStringForDiff(credentialRecord.connectionString, marker)
    }
  }
}

function getConnectionStringForDiff(value: Record<string, unknown>): string | null {
  const credentials = value.credentials
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return null
  const connectionString = (credentials as Record<string, unknown>).connectionString
  return typeof connectionString === 'string' ? connectionString : null
}

function maskDataSourceCredentialsForDiffPair(before: Record<string, JsonValue>, after: Record<string, JsonValue>): [Record<string, unknown>, Record<string, unknown>] {
  const maskedBefore = cloneRecordForDiff(before)
  const maskedAfter = cloneRecordForDiff(after)
  const beforeConnectionString = getConnectionStringForDiff(maskedBefore)
  const afterConnectionString = getConnectionStringForDiff(maskedAfter)
  const changed = beforeConnectionString !== afterConnectionString
  setMaskedConnectionString(maskedBefore, changed && beforeConnectionString ? 'current' : undefined)
  setMaskedConnectionString(maskedAfter, changed && afterConnectionString ? 'draft' : undefined)
  return [maskedBefore, maskedAfter]
}

function computePipelineResourceDiff(kind: IndexingPipelinePublishResourceKind, before: Record<string, JsonValue>, after: Record<string, JsonValue>): ResourceDiffResult {
  if (kind === 'index') return computeIndexDiff(cloneRecordForDiff(before), cloneRecordForDiff(after))
  if (kind === 'dataSource') {
    const [maskedBefore, maskedAfter] = maskDataSourceCredentialsForDiffPair(before, after)
    return computeResourceDiff(maskedBefore, maskedAfter)
  }
  return computeResourceDiff(cloneRecordForDiff(before), cloneRecordForDiff(after), {
    namedArrays: [
      { field: 'fieldMappings', label: 'field mapping' },
      { field: 'outputFieldMappings', label: 'output field mapping' },
    ],
  })
}

function responseToLogJson(result: RestResult): JsonValue {
  if (result.ok) {
    return {
      ok: true,
      status: result.status,
      requestId: result.requestId,
      clientRequestId: result.clientRequestId ?? null,
      url: result.url,
      response: result.response,
    }
  }
  return {
    ok: false,
    status: result.status,
    requestId: result.requestId,
    clientRequestId: result.clientRequestId ?? null,
    url: result.url,
    error: {
      message: result.error.message,
      response: result.error.response ?? null,
      responseText: result.error.responseText ?? null,
    },
  }
}

function jsonDraftFromValue(value: JsonValue, loadedName: string): IndexingPipelineJsonDraft {
  const text = prettyJson(value)
  return {
    text,
    baselineText: text,
    loadedName,
    loadedAt: new Date().toISOString(),
  }
}

function extractNames(response: JsonValue): string[] {
  if (!isRecord(response) || !Array.isArray(response.value)) return []
  return Array.from(new Set(
    response.value
      .map((item) => (isRecord(item) && typeof item.name === 'string' ? item.name.trim() : ''))
      .filter((name) => name.length > 0),
  )).sort((left, right) => left.localeCompare(right))
}

function firstErrorMessage(results: Array<{ label: string; result: RestResult | null }>): string {
  return results
    .filter((entry): entry is { label: string; result: Extract<RestResult, { ok: false }> } => !!entry.result && !entry.result.ok)
    .map((entry) => `${entry.label}: ${entry.result.error.message}`)
    .join('\n')
}

function dirtyResources(draft: IndexingPipelineDraft): IndexingPipelineResourceKind[] {
  return (['dataSource', 'index', 'indexer'] as const).filter((resource) => draft[resource].text !== draft[resource].baselineText)
}

function issueClass(issue: IndexingPipelineValidationIssue): string {
  return `ipbIssue ipbIssue--${issue.severity}`
}

function createIdleRunTracker(): PipelineStepMap {
  return {
    validate: { status: 'idle' },
    dataSource: { status: 'idle' },
    index: { status: 'idle' },
    indexer: { status: 'idle' },
    run: { status: 'idle' },
    status: { status: 'idle' },
    verify: { status: 'idle' },
  }
}

function getStringField(value: JsonValue | null, key: string): string {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : ''
}

function getBooleanField(value: JsonValue | null, key: string): boolean {
  return isRecord(value) && typeof value[key] === 'boolean' ? value[key] : false
}

function getObjectField(value: JsonValue | null, key: string): Record<string, JsonValue> {
  if (!isRecord(value)) return {}
  const child = value[key]
  return isRecord(child) ? child : {}
}

function getNumberInputValue(value: JsonValue | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function getTextInputValue(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function isManagedIdentityConnectionString(value: JsonValue | undefined): boolean {
  return typeof value === 'string' && /^ResourceId=/i.test(value.trim())
}

function stripManagedIdentityConnectionString(value: JsonValue | undefined): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  const match = /^ResourceId=([^;]+);?$/i.exec(trimmed)
  return match ? match[1] : ''
}

function formatManagedIdentityConnectionString(resourceId: string): string {
  const trimmed = normalizeStorageResourceIdInput(resourceId)
  if (!trimmed) return 'ResourceId=;'
  if (/^ResourceId=/i.test(trimmed)) return trimmed.endsWith(';') ? trimmed : `${trimmed};`
  return `ResourceId=${trimmed};`
}

function getDataSourceCredentialMode(credentials: Record<string, JsonValue>, identity: Record<string, JsonValue>): DataSourceCredentialMode {
  if (identity['@odata.type'] === DATA_SOURCE_USER_ASSIGNED_IDENTITY_ODATA_TYPE) return 'userAssignedManagedIdentity'
  if (typeof identity.userAssignedIdentity === 'string' && identity.userAssignedIdentity.trim()) return 'userAssignedManagedIdentity'
  if (isManagedIdentityConnectionString(credentials.connectionString)) return 'systemAssignedManagedIdentity'
  return 'connectionString'
}

function supportsUserAssignedManagedIdentity(apiVersion: SearchApiVersion | ''): boolean {
  const match = String(apiVersion).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return false
  const [, year, month, day] = match
  return `${year}-${month}-${day}` >= '2026-04-01'
}

function getMappingFunctionName(value: JsonValue | undefined): string {
  return isRecord(value) && typeof value.name === 'string' ? value.name : ''
}

function parseDraftObject(draft: IndexingPipelineJsonDraft): { ok: true; value: Record<string, JsonValue> } | { ok: false; message: string } {
  const parsed = parseDraftJson(draft.text)
  if (!parsed.ok) return { ok: false, message: parsed.message }
  if (!isRecord(parsed.value)) return { ok: false, message: 'JSON root must be an object.' }
  return { ok: true, value: parsed.value }
}

function fieldCount(value: JsonValue | null): number {
  if (!isRecord(value) || !Array.isArray(value.fields)) return 0
  return value.fields.length
}

function vectorFieldCount(value: JsonValue | null): number {
  if (!isRecord(value) || !Array.isArray(value.fields)) return 0
  return value.fields.filter((field) => isRecord(field) && typeof field.type === 'string' && field.type.toLowerCase().includes('collection(edm.single)')).length
}

function sampleDocumentCount(value: JsonValue | null): number {
  if (!isRecord(value)) return 0
  const values = value.value
  return Array.isArray(values) ? values.length : 0
}

function documentCountFromStats(value: JsonValue | null): string {
  if (!isRecord(value)) return '-'
  const count = value.documentCount
  return typeof count === 'number' ? count.toLocaleString() : '-'
}

function descriptorHint(descriptor: DataSourceDescriptor, language: Language): string {
  return language === 'ja' ? descriptor.notesJa : descriptor.notesEn
}

function applicableConfigFields(dataSourceType: string): IndexerSchemaField[] {
  const canonical = findDataSourceDescriptor(dataSourceType)?.type ?? dataSourceType
  return INDEXER_CONFIGURATION_FIELDS.filter((field) => field.appliesTo.includes('all') || field.appliesTo.includes(canonical))
}

function selectOptionsForConfig(name: string): string[] | null {
  switch (name) {
    case 'parsingMode':
      return ['default', 'text', 'json', 'jsonArray', 'jsonLines', 'delimitedText']
    case 'dataToExtract':
      return ['contentAndMetadata', 'storageMetadata', 'allMetadata']
    case 'imageAction':
      return ['none', 'generateNormalizedImages', 'generateNormalizedImagePerPage']
    case 'pdfTextRotationAlgorithm':
      return ['none', 'detectAngles']
    case 'executionEnvironment':
      return ['standard', 'private']
    default:
      return null
  }
}

function stepIcon(status: PipelineStepStatus): string {
  switch (status) {
    case 'running': return 'bi-arrow-repeat spin'
    case 'success': return 'bi-check2-circle'
    case 'error': return 'bi-x-circle'
    case 'skipped': return 'bi-dash-circle'
    default: return 'bi-circle'
  }
}

export function IndexingPipelineBuilder({ profile, apiVersion, language, theme, copyToClipboard, onOpenIndexBuilder }: IndexingPipelineBuilderProps) {
  const t = useCallback((key: CopyKey): string => copy[language][key], [language])
  const globalT = useCallback((key: keyof typeof translations.ja): string => String(translations[language][key] ?? ''), [language])
  const canQuery = !!profile && !!apiVersion && apiVersion.trim().length > 0
  const codeMirrorTheme = useMemo(() => (theme === 'light' || theme === 'solarized' ? githubLight : githubDark), [theme])

  const initialDraft = useMemo(() => createEmptyIndexingPipelineDraft(), [])
  const initialSavedDrafts = useMemo(() => listIndexingPipelineDrafts(), [])
  const [draft, setDraft] = useState<IndexingPipelineDraft>(() => initialDraft)
  const [hasPipelineDraft, setHasPipelineDraft] = useState(false)
  const [activeTab, setActiveTab] = useState<IndexingPipelineEditorTab>(() => initialDraft.activeTab)
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null)
  const [savedDrafts, setSavedDrafts] = useState<PersistedIndexingPipelineItem[]>(() => initialSavedDrafts)
  const [localDraftLibraryOpen, setLocalDraftLibraryOpen] = useState(false)
  const [localDraftError, setLocalDraftError] = useState<string | null>(null)
  const [rawJsonResource, setRawJsonResource] = useState<IndexingPipelineResourceKind>('indexer')
  const [resourceLists, setResourceLists] = useState<ResourceLists>(emptyResourceLists)
  const [selectedIndexerName, setSelectedIndexerName] = useState('')
  const [resourceFilter, setResourceFilter] = useState('')
  const indexerFilterInputRef = useRef<HTMLInputElement | null>(null)
  const [loadingResources, setLoadingResources] = useState(false)
  const [loadingPipeline, setLoadingPipeline] = useState(false)
  const [message, setMessage] = useState<UiMessage | null>(null)
  const [resetLoading, setResetLoading] = useState(false)
  const [runLoading, setRunLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(false)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [lastRunResponse, setLastRunResponse] = useState<JsonValue | null>(null)
  const [lastStatus, setLastStatus] = useState<JsonValue | null>(null)
  const [verification, setVerification] = useState<VerificationState>({ stats: null, sample: null, error: null })
  const [runTracker, setRunTracker] = useState<PipelineStepMap>(() => createIdleRunTracker())
  const [publishReviewOpen, setPublishReviewOpen] = useState(false)
  const [publishReviewLoading, setPublishReviewLoading] = useState(false)
  const [pendingUpdateResources, setPendingUpdateResources] = useState<PipelineUpdateReviewResource[]>([])
  const [publishReviewActiveKind, setPublishReviewActiveKind] = useState<IndexingPipelinePublishResourceKind>('dataSource')
  const [publishReviewDiffViewMode, setPublishReviewDiffViewMode] = useState<'semantic' | 'text'>('semantic')

  const parsed = useMemo(() => parseIndexingPipelineDraft(draft), [draft])
  const validationIssues = useMemo(
    () => hasPipelineDraft ? validateIndexingPipelineDraft({ draft, apiVersion: String(apiVersion ?? ''), language }) : [],
    [apiVersion, draft, hasPipelineDraft, language],
  )
  const issueCounts = useMemo(() => countIssuesBySeverity(validationIssues), [validationIssues])
  const unsavedResources = useMemo(() => hasPipelineDraft ? dirtyResources(draft) : [], [draft, hasPipelineDraft])
  const currentSavedDraft = useMemo(
    () => currentDraftId ? savedDrafts.find((item) => item.id === currentDraftId) ?? null : null,
    [currentDraftId, savedDrafts],
  )
  const currentDraftTitle = hasPipelineDraft ? (currentSavedDraft?.title ?? deriveIndexingPipelineDraftTitle(draft)) : t('noPipelineLoadedTitle')

  const dataSourceName = getResourceName(parsed.dataSource)
  const dataSourceType = getDataSourceType(parsed.dataSource)
  const dataSourceDescriptor = dataSourceType ? findDataSourceDescriptor(dataSourceType) : null
  const indexName = getResourceName(parsed.index)
  const indexerName = getResourceName(parsed.indexer)
  const indexerRefs = getIndexerReferences(parsed.indexer)
  const indexFieldNames = getFieldNames(parsed.index)
  const keyFieldName = getKeyFieldName(parsed.index)
  const fieldMappings = getFieldMappings(parsed.indexer, 'fieldMappings')
  const outputFieldMappings = getFieldMappings(parsed.indexer, 'outputFieldMappings')
  const activeIndexerName = hasPipelineDraft ? indexerName : ''
  const dataSourceContainer = getObjectField(parsed.dataSource, 'container')
  const dataSourceCredentials = getObjectField(parsed.dataSource, 'credentials')
  const dataSourceIdentity = getObjectField(parsed.dataSource, 'identity')
  const dataSourceCredentialMode = getDataSourceCredentialMode(dataSourceCredentials, dataSourceIdentity)
  const dataSourceManagedIdentityResourceId = stripManagedIdentityConnectionString(dataSourceCredentials.connectionString)
  const dataSourceUserAssignedIdentity = getTextInputValue(dataSourceIdentity.userAssignedIdentity)
  const userAssignedIdentityApiSupported = supportsUserAssignedManagedIdentity(apiVersion)
  const indexerSchedule = getObjectField(parsed.indexer, 'schedule')
  const indexerParameters = getObjectField(parsed.indexer, 'parameters')
  const indexerConfiguration = getObjectField(indexerParameters, 'configuration')
  const activeConfigFields = applicableConfigFields(dataSourceType)
  const filteredIndexers = useMemo(() => {
    const filter = resourceFilter.trim().toLowerCase()
    if (!filter) return resourceLists.indexers
    return resourceLists.indexers.filter((name) => name.toLowerCase().includes(filter))
  }, [resourceFilter, resourceLists.indexers])

  const hideClosestBootstrapDropdown = (fromEl: HTMLElement | null) => {
    if (!fromEl) return
    const dropdownRoot = fromEl.closest('.dropdown')
    if (!dropdownRoot) return
    const toggle = dropdownRoot.querySelector('[data-bs-toggle="dropdown"]') as HTMLElement | null
    if (!toggle) return
    toggle.click()
  }

  const setTab = (tab: IndexingPipelineEditorTab) => {
    setActiveTab(tab)
    setDraft((current) => ({ ...current, activeTab: tab }))
  }

  const updateDraftText = (resource: IndexingPipelineResourceKind, textValue: string) => {
    setDraft((current) => ({
      ...current,
      [resource]: {
        ...current[resource],
        text: textValue,
      },
    }))
  }

  const updateResourceObject = (resource: IndexingPipelineResourceKind, updater: (value: Record<string, JsonValue>) => Record<string, JsonValue>) => {
    setDraft((current) => {
      const parsedResource = parseDraftObject(current[resource])
      const base = parsedResource.ok ? { ...parsedResource.value } : {}
      const next = updater(base)
      return {
        ...current,
        [resource]: {
          ...current[resource],
          text: prettyJson(next),
        },
      }
    })
  }

  const updateNestedObject = (resource: IndexingPipelineResourceKind, key: string, changes: Record<string, JsonValue>) => {
    updateResourceObject(resource, (value) => {
      const child = isRecord(value[key]) ? { ...(value[key] as Record<string, JsonValue>) } : {}
      return { ...value, [key]: { ...child, ...changes } }
    })
  }

  const setIndexerParameter = (name: string, value: JsonValue | undefined) => {
    updateResourceObject('indexer', (current) => {
      const parameters = isRecord(current.parameters) ? { ...current.parameters } : {}
      if (value === undefined) delete parameters[name]
      else parameters[name] = value
      return { ...current, parameters }
    })
  }

  const setIndexerConfiguration = (name: string, value: JsonValue | undefined) => {
    updateResourceObject('indexer', (current) => {
      const parameters = isRecord(current.parameters) ? { ...current.parameters } : {}
      const configuration = isRecord(parameters.configuration) ? { ...parameters.configuration } : {}
      if (value === undefined) delete configuration[name]
      else configuration[name] = value
      parameters.configuration = configuration
      return { ...current, parameters }
    })
  }

  const setDataSourceCredentialMode = (mode: DataSourceCredentialMode) => {
    updateResourceObject('dataSource', (current) => {
      const credentials = isRecord(current.credentials) ? { ...current.credentials } : {}
      const currentResourceId = stripManagedIdentityConnectionString(credentials.connectionString)
      const next: Record<string, JsonValue> = { ...current }

      if (mode === 'connectionString') {
        delete next.identity
        if (isManagedIdentityConnectionString(credentials.connectionString)) credentials.connectionString = ''
        next.credentials = credentials
        return next
      }

      credentials.connectionString = formatManagedIdentityConnectionString(currentResourceId)
      next.credentials = credentials

      if (mode === 'systemAssignedManagedIdentity') {
        delete next.identity
        return next
      }

      const identity = isRecord(current.identity) ? { ...current.identity } : {}
      next.identity = {
        ...identity,
        '@odata.type': DATA_SOURCE_USER_ASSIGNED_IDENTITY_ODATA_TYPE,
        userAssignedIdentity: typeof identity.userAssignedIdentity === 'string' ? identity.userAssignedIdentity : '',
      }
      return next
    })
  }

  const setDataSourceManagedIdentityResourceId = (resourceId: string) => {
    updateResourceObject('dataSource', (current) => {
      const credentials = isRecord(current.credentials) ? { ...current.credentials } : {}
      credentials.connectionString = formatManagedIdentityConnectionString(resourceId)
      return { ...current, credentials }
    })
  }

  const setDataSourceUserAssignedIdentity = (resourceId: string) => {
    updateResourceObject('dataSource', (current) => {
      const identity = isRecord(current.identity) ? { ...current.identity } : {}
      return {
        ...current,
        identity: {
          ...identity,
          '@odata.type': DATA_SOURCE_USER_ASSIGNED_IDENTITY_ODATA_TYPE,
          userAssignedIdentity: resourceId,
        },
      }
    })
  }

  const updateMappingRow = (key: FieldMappingKey, rowIndex: number, changes: Record<string, JsonValue | undefined>) => {
    updateResourceObject('indexer', (current) => {
      const rows = Array.isArray(current[key])
        ? current[key].filter(isRecord).map((row) => ({ ...row }))
        : []
      const nextRow = { ...(rows[rowIndex] ?? {}) }
      for (const [changeKey, changeValue] of Object.entries(changes)) {
        if (changeValue === undefined) delete nextRow[changeKey]
        else nextRow[changeKey] = changeValue
      }
      rows[rowIndex] = nextRow
      return { ...current, [key]: rows }
    })
  }

  const addMappingRow = (key: FieldMappingKey) => {
    updateResourceObject('indexer', (current) => {
      const rows = Array.isArray(current[key])
        ? current[key].filter(isRecord).map((row) => ({ ...row }))
        : []
      return {
        ...current,
        [key]: [
          ...rows,
          { sourceFieldName: '', targetFieldName: '' },
        ],
      }
    })
  }

  const removeMappingRow = (key: FieldMappingKey, rowIndex: number) => {
    updateResourceObject('indexer', (current) => {
      const rows = Array.isArray(current[key])
        ? current[key].filter(isRecord).map((row) => ({ ...row }))
        : []
      rows.splice(rowIndex, 1)
      return { ...current, [key]: rows }
    })
  }

  const setMappingFunctionName = (key: FieldMappingKey, rowIndex: number, value: string) => {
    const name = value.trim()
    if (!name) {
      updateMappingRow(key, rowIndex, { mappingFunction: undefined })
      return
    }
    const existingMapping = key === 'fieldMappings' ? fieldMappings[rowIndex] : outputFieldMappings[rowIndex]
    const existingFunction = isRecord(existingMapping?.mappingFunction) ? { ...existingMapping.mappingFunction } : {}
    updateMappingRow(key, rowIndex, { mappingFunction: { ...existingFunction, name } })
  }

  const applyDataSourceDescriptor = (descriptor: DataSourceDescriptor) => {
    const nextDataSourceName = dataSourceName || `${descriptor.type}-datasource`
    updateResourceObject('dataSource', (current) => {
      const container = isRecord(current.container) ? { ...current.container } : {}
      const credentials = isRecord(current.credentials) ? { ...current.credentials } : { connectionString: '<connection-string-or-managed-identity-settings>' }
      return {
        ...current,
        name: typeof current.name === 'string' && current.name.trim() ? current.name : nextDataSourceName,
        type: descriptor.type,
        credentials,
        container: {
          name: typeof container.name === 'string' && container.name.trim() ? container.name : descriptor.family === 'database' ? 'table-or-view-name' : 'container-or-scope-name',
          query: container.query ?? null,
        },
      }
    })
    updateResourceObject('indexer', (current) => ({
      ...current,
      dataSourceName: typeof current.dataSourceName === 'string' && current.dataSourceName.trim() ? current.dataSourceName : nextDataSourceName,
    }))
    setMessage({ type: 'success', text: language === 'ja' ? `${dataSourceLabel(descriptor, language)} をdraftに適用しました。` : `Applied ${dataSourceLabel(descriptor, language)} to the draft.` })
  }

  const setRunStep = (id: PipelineStepId, status: PipelineStepStatus, detail?: string, response?: JsonValue | null) => {
    setRunTracker((current) => ({
      ...current,
      [id]: { status, detail, response, updatedAt: new Date().toISOString() },
    }))
  }

  const refreshResourceLists = useCallback(async () => {
    if (!profile || !apiVersion.trim()) {
      setResourceLists(emptyResourceLists)
      return
    }

    setLoadingResources(true)
    setMessage(null)
    try {
      const [indexerResult, dataSourceResult, indexResult] = await Promise.all([
        listIndexers({ profile, apiVersion, language }),
        listDataSources({ profile, apiVersion, language }),
        listIndexes({ profile, apiVersion, language }),
      ])

      const nextLists = {
        indexers: indexerResult.ok ? extractNames(indexerResult.response) : [],
        dataSources: dataSourceResult.ok ? extractNames(dataSourceResult.response) : [],
        indexes: indexResult.ok ? extractNames(indexResult.response) : [],
      }
      setResourceLists(nextLists)
      setSelectedIndexerName((current) => current || nextLists.indexers[0] || '')

      const errors = firstErrorMessage([
        { label: t('indexers'), result: indexerResult },
        { label: t('dataSources'), result: dataSourceResult },
        { label: t('indexes'), result: indexResult },
      ])
      if (errors) setMessage({ type: 'error', text: errors })
    } catch (error) {
      setResourceLists(emptyResourceLists)
      setMessage({ type: 'error', text: `${t('failedToLoad')}: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setLoadingResources(false)
    }
  }, [apiVersion, language, profile, t])

  const loadPipelineFromIndexer = useCallback(async (name: string) => {
    const targetIndexerName = name.trim()
    if (!profile || !apiVersion.trim() || !targetIndexerName) return

    setLoadingPipeline(true)
    setMessage(null)
    try {
      const indexerResult = await getIndexerDefinition({ profile, apiVersion, indexerName: targetIndexerName, language })
      if (!indexerResult.ok) {
        setMessage({ type: 'error', text: indexerResult.error.message })
        return
      }

      const indexerValue = indexerResult.response
      const refs = getIndexerReferences(indexerValue)
      const [dataSourceResult, indexResult] = await Promise.all([
        refs.dataSourceName
          ? getDataSourceDefinition({ profile, apiVersion, dataSourceName: refs.dataSourceName, language })
          : Promise.resolve(null),
        refs.targetIndexName
          ? getIndexDefinition({ profile, apiVersion, indexName: refs.targetIndexName, language })
          : Promise.resolve(null),
      ])

      setDraft((current) => ({
        ...current,
        activeTab: 'overview',
        indexer: jsonDraftFromValue(indexerValue, targetIndexerName),
        dataSource: dataSourceResult?.ok
          ? jsonDraftFromValue(dataSourceResult.response, refs.dataSourceName)
          : current.dataSource,
        index: indexResult?.ok
          ? jsonDraftFromValue(indexResult.response, refs.targetIndexName)
          : current.index,
      }))
      setHasPipelineDraft(true)
      setActiveTab('overview')
      setRawJsonResource('indexer')
      setSelectedIndexerName(targetIndexerName)
      setCurrentDraftId(null)
      setRunTracker(createIdleRunTracker())

      const dependencyErrors = firstErrorMessage([
        { label: t('dataSource'), result: dataSourceResult },
        { label: t('index'), result: indexResult },
      ])
      setMessage({ type: dependencyErrors ? 'info' : 'success', text: dependencyErrors ? `${t('partialLoad')}\n${dependencyErrors}` : t('loadedPipeline') })
    } catch (error) {
      setMessage({ type: 'error', text: `${t('failedToLoad')}: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setLoadingPipeline(false)
    }
  }, [apiVersion, language, profile, t])

  useEffect(() => {
    setResourceLists(emptyResourceLists)
    setSelectedIndexerName('')
    if (!canQuery) return
    void refreshResourceLists()
  }, [canQuery, refreshResourceLists])

  const refreshSavedDrafts = useCallback(() => {
    setSavedDrafts(listIndexingPipelineDrafts())
  }, [])

  useEffect(() => {
    if (localDraftLibraryOpen) refreshSavedDrafts()
  }, [localDraftLibraryOpen, refreshSavedDrafts])

  const resetTransientPipelineState = () => {
    setLastRunResponse(null)
    setLastStatus(null)
    setVerification({ stats: null, sample: null, error: null })
    setRunTracker(createIdleRunTracker())
  }

  const saveDraftToLibrary = (mode: 'save' | 'saveAs', titleOverride?: string) => {
    if (!hasPipelineDraft) {
      setMessage({ type: 'info', text: t('noPipelineLoadedHint') })
      return
    }

    const id = mode === 'save' && currentDraftId ? currentDraftId : uuidv4()
    const nextDraft = { ...draft, activeTab }
    const title = (titleOverride ?? currentSavedDraft?.title ?? deriveIndexingPipelineDraftTitle(nextDraft)).trim() || deriveIndexingPipelineDraftTitle(nextDraft)

    try {
      upsertIndexingPipelineDraft({ id, title, updatedAt: Date.now(), draft: nextDraft })
      setCurrentDraftId(id)
      setLocalDraftError(null)
      refreshSavedDrafts()
      setMessage({ type: 'success', text: t('draftSaved') })
    } catch (error) {
      setLocalDraftError(error instanceof Error ? error.message : String(error))
    }
  }

  const saveDraft = () => {
    saveDraftToLibrary('save')
  }

  const saveDraftAs = () => {
    const name = window.prompt(t('saveDraftAsPrompt'), currentDraftTitle)
    if (name == null) return
    saveDraftToLibrary('saveAs', name.trim() || currentDraftTitle)
  }

  const loadSavedDraft = (id: string) => {
    if (id !== currentDraftId && unsavedResources.length > 0) {
      const ok = window.confirm(t('loadDraftConfirm'))
      if (!ok) return
    }

    const item = getIndexingPipelineDraft(id)
    if (!item) {
      refreshSavedDrafts()
      setLocalDraftError(language === 'ja' ? '選択したドラフトが見つかりません。' : 'The selected draft was not found.')
      return
    }

    setDraft(item.draft)
    setHasPipelineDraft(true)
    setActiveTab(item.draft.activeTab)
    setCurrentDraftId(item.id)
    setRawJsonResource('indexer')
    resetTransientPipelineState()
    setLocalDraftError(null)
    setMessage({ type: 'success', text: t('draftLoaded') })
  }

  const cloneSavedDraft = (id: string) => {
    const ok = window.confirm(t('cloneDraftConfirm'))
    if (!ok) return

    const item = getIndexingPipelineDraft(id)
    if (!item) {
      refreshSavedDrafts()
      setLocalDraftError(language === 'ja' ? '選択したドラフトが見つかりません。' : 'The selected draft was not found.')
      return
    }

    const clonedId = uuidv4()
    const clonedTitle = `${item.title} (copy)`
    upsertIndexingPipelineDraft({
      id: clonedId,
      title: clonedTitle,
      updatedAt: Date.now(),
      draft: item.draft,
    })
    setDraft(item.draft)
    setHasPipelineDraft(true)
    setActiveTab(item.draft.activeTab)
    setCurrentDraftId(clonedId)
    setRawJsonResource('indexer')
    resetTransientPipelineState()
    setLocalDraftError(null)
    refreshSavedDrafts()
    setMessage({ type: 'success', text: t('draftCloned') })
  }

  const deleteSavedDraft = (id: string) => {
    const ok = window.confirm(t('deleteDraftConfirm'))
    if (!ok) return

    deleteIndexingPipelineDraft(id)
    if (id === currentDraftId) {
      const next = createEmptyIndexingPipelineDraft()
      setDraft(next)
      setActiveTab(next.activeTab)
      setHasPipelineDraft(false)
      setCurrentDraftId(null)
      setRawJsonResource('indexer')
      resetTransientPipelineState()
    }
    refreshSavedDrafts()
    setMessage({ type: 'success', text: t('draftDeleted') })
  }

  const renderLocalDraftLibrary = () => {
    if (!localDraftLibraryOpen) return null

    return (
      <section className="ipbLocalDraftLibrary" data-guide-target="ipb-local-drafts">
        <div className="ipbLocalDraftLibrary__header">
          <div>
            <div className="ipbPanelHeader__title">{t('savedDrafts')} ({savedDrafts.length})</div>
          </div>
        </div>
        {localDraftError && <div className="notice notice--error builder__notice">{localDraftError}</div>}
        {savedDrafts.length === 0 ? (
          <div className="empty ipbLocalDraftLibrary__empty">{t('noSavedDrafts')}</div>
        ) : (
          <div className="ipbLocalDraftList">
            {savedDrafts.map((item) => {
              const isCurrent = item.id === currentDraftId
              return (
                <div key={item.id} className={'ipbLocalDraftItem' + (isCurrent ? ' ipbLocalDraftItem--current' : '')}>
                  <div className="ipbLocalDraftItem__main" title={`${item.title} - ${new Date(item.updatedAt).toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US')}`}>
                    <span className="ipbLocalDraftItem__title">{item.title}</span>
                    {isCurrent && <span className="ipbLocalDraftItem__badge">{t('currentDraft')}</span>}
                  </div>
                  <span className="ipbLocalDraftItem__date">{new Date(item.updatedAt).toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US')}</span>
                  <div className="ipbLocalDraftItem__actions">
                    <button type="button" className="btn btn--sm" onClick={() => loadSavedDraft(item.id)} title={t('loadDraft')} aria-label={t('loadDraft')}>
                      <i className="bi bi-file-earmark-play"></i>
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => cloneSavedDraft(item.id)} title={t('cloneDraft')} aria-label={t('cloneDraft')}>
                      <i className="bi bi-copy"></i>
                    </button>
                    <button type="button" className="btn btn--sm" onClick={() => deleteSavedDraft(item.id)} title={t('deleteDraft')} aria-label={t('deleteDraft')}>
                      <i className="bi bi-trash"></i>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    )
  }

  const createNewDraft = () => {
    if (unsavedResources.length > 0) {
      const ok = window.confirm(language === 'ja' ? '未保存の変更を破棄しますか？' : 'Discard unsaved changes?')
      if (!ok) return
    }
    const next = createDefaultIndexingPipelineDraft()
    setDraft(next)
    setHasPipelineDraft(true)
    setActiveTab(next.activeTab)
    setCurrentDraftId(null)
    setRawJsonResource('indexer')
    resetTransientPipelineState()
    setMessage({ type: 'success', text: t('draftReset') })
  }

  const clearPipeline = () => {
    if (unsavedResources.length > 0) {
      const ok = window.confirm(language === 'ja' ? '未保存の変更を破棄しますか？' : 'Discard unsaved changes?')
      if (!ok) return
    }

    const next = createEmptyIndexingPipelineDraft()
    setDraft(next)
    setHasPipelineDraft(false)
    setActiveTab(next.activeTab)
    setCurrentDraftId(null)
    setRawJsonResource('indexer')
    setPublishReviewOpen(false)
    setPendingUpdateResources([])
    resetTransientPipelineState()
    setMessage(null)
  }

  const copyActiveJson = async () => {
    if (!hasPipelineDraft) {
      setMessage({ type: 'info', text: t('noPipelineLoadedHint') })
      return
    }
    await copyToClipboard(draft[rawJsonResource].text)
    setMessage({ type: 'success', text: t('copied') })
  }

  const refreshIndexerStatus = useCallback(async () => {
    if (!hasPipelineDraft) {
      setMessage({ type: 'info', text: t('noPipelineLoadedHint') })
      return
    }

    const targetIndexerName = activeIndexerName.trim()
    if (!profile || !apiVersion.trim() || !targetIndexerName) {
      setMessage({ type: 'error', text: t('indexerNameUnset') })
      return
    }

    setStatusLoading(true)
    setMessage(null)
    setRunStep('status', 'running')
    try {
      const statusResult = await getIndexerStatus({ profile, apiVersion, indexerName: targetIndexerName, language })
      const log = responseToLogJson(statusResult)
      setLastStatus(log)
      if (!statusResult.ok) {
        setRunStep('status', 'error', statusResult.error.message, log)
        setMessage({ type: 'error', text: statusResult.error.message })
        return
      }
      setRunStep('status', 'success', `${statusResult.status}`, log)
      setMessage({ type: 'success', text: t('statusUpdated') })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setRunStep('status', 'error', detail)
      setMessage({ type: 'error', text: detail })
    } finally {
      setStatusLoading(false)
    }
  }, [activeIndexerName, apiVersion, hasPipelineDraft, language, profile, t])

  const startIndexerReset = async () => {
    if (!hasPipelineDraft) {
      setMessage({ type: 'info', text: t('noPipelineLoadedHint') })
      return
    }

    const targetIndexerName = activeIndexerName.trim()
    if (!profile || !apiVersion.trim() || !targetIndexerName) {
      setMessage({ type: 'error', text: t('indexerNameUnset') })
      return
    }

    const ok = window.confirm(t('resetIndexerConfirm'))
    if (!ok) return

    setResetLoading(true)
    setMessage(null)
    try {
      const resetResult = await resetIndexer({ profile, apiVersion, indexerName: targetIndexerName, language })
      if (!resetResult.ok) {
        setMessage({ type: 'error', text: resetResult.error.message })
        return
      }
      setMessage({ type: 'success', text: t('resetQueued') })
      await refreshIndexerStatus()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setMessage({ type: 'error', text: detail })
    } finally {
      setResetLoading(false)
    }
  }

  const startIndexerRun = async () => {
    if (!hasPipelineDraft) {
      setMessage({ type: 'info', text: t('noPipelineLoadedHint') })
      return
    }

    const targetIndexerName = activeIndexerName.trim()
    if (!profile || !apiVersion.trim() || !targetIndexerName) {
      setMessage({ type: 'error', text: t('indexerNameUnset') })
      return
    }

    setRunLoading(true)
    setMessage(null)
    setRunStep('run', 'running')
    try {
      const runResult = await runIndexer({ profile, apiVersion, indexerName: targetIndexerName, language })
      const log = responseToLogJson(runResult)
      setLastRunResponse(log)
      if (!runResult.ok) {
        setRunStep('run', 'error', runResult.error.message, log)
        setMessage({ type: 'error', text: runResult.error.message })
        return
      }
      setRunStep('run', 'success', `${runResult.status}`, log)
      setMessage({ type: 'success', text: t('runQueued') })
      await refreshIndexerStatus()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setRunStep('run', 'error', detail)
      setMessage({ type: 'error', text: detail })
    } finally {
      setRunLoading(false)
    }
  }

  const verifyTargetIndex = async () => {
    if (!hasPipelineDraft) {
      setMessage({ type: 'info', text: t('noPipelineLoadedHint') })
      return
    }

    const targetIndexName = (indexerRefs.targetIndexName || indexName).trim()
    if (!profile || !apiVersion.trim() || !targetIndexName) {
      setMessage({ type: 'error', text: t('targetIndexUnset') })
      return
    }

    setVerifyLoading(true)
    setMessage(null)
    setRunStep('verify', 'running')
    try {
      const [statsResult, sampleResult] = await Promise.all([
        getIndexStatistics({ profile, apiVersion, indexName: targetIndexName, language }),
        searchDocuments({
          profile,
          apiVersion,
          indexName: targetIndexName,
          language,
          body: { search: '*', top: 3, count: true } as JsonValue,
        }),
      ])

      const error = firstErrorMessage([
        { label: 'stats', result: statsResult },
        { label: 'sample', result: sampleResult },
      ])
      const nextVerification = {
        stats: statsResult.ok ? statsResult.response : responseToLogJson(statsResult),
        sample: sampleResult.ok ? sampleResult.response : responseToLogJson(sampleResult),
        error: error || null,
      }
      setVerification(nextVerification)
      if (error) {
        setRunStep('verify', 'error', error, nextVerification as unknown as JsonValue)
      } else {
        setRunStep('verify', 'success', `${documentCountFromStats(nextVerification.stats)} ${t('documentCount')}`, nextVerification as unknown as JsonValue)
      }
      setMessage({ type: error ? 'error' : 'success', text: error || t('verified') })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      setVerification({ stats: null, sample: null, error: detail })
      setRunStep('verify', 'error', detail)
      setMessage({ type: 'error', text: detail })
    } finally {
      setVerifyLoading(false)
    }
  }

  const preparePipelineDrafts = (): PreparedPipelineDrafts | null => {
    if (!hasPipelineDraft) {
      setMessage({ type: 'info', text: t('noPipelineLoadedHint') })
      return null
    }

    if (!profile || !apiVersion.trim()) {
      setMessage({ type: 'error', text: t('missingConnection') })
      return null
    }

    const dsDraft = parseDraftObject(draft.dataSource)
    const indexDraft = parseDraftObject(draft.index)
    const indexerDraft = parseDraftObject(draft.indexer)

    if (!dsDraft.ok || !indexDraft.ok || !indexerDraft.ok) {
      const detail = [dsDraft, indexDraft, indexerDraft].filter((result) => !result.ok).map((result) => result.message).join('\n')
      setMessage({ type: 'error', text: `${t('parseBlocked')}\n${detail}` })
      return null
    }

    const blockingIssues = validationIssues.filter((issue) => issue.severity === 'error')
    if (blockingIssues.length > 0) {
      const detail = blockingIssues.map((issue) => issue.message).join('\n')
      setMessage({ type: 'error', text: `${t('validationBlocked')}\n${detail}` })
      return null
    }

    const dsName = getResourceName(dsDraft.value)
    const idxName = getResourceName(indexDraft.value)
    const idxrName = getResourceName(indexerDraft.value)
    return {
      dataSource: dsDraft.value,
      index: indexDraft.value,
      indexer: indexerDraft.value,
      dataSourceName: dsName,
      indexName: idxName,
      indexerName: idxrName,
    }
  }

  const getServiceResourceBaseline = async (kind: IndexingPipelinePublishResourceKind, name: string): Promise<{ ok: true; exists: boolean; value: Record<string, JsonValue> } | { ok: false; message: string }> => {
    const activeProfile = profile
    const activeApiVersion = apiVersion.trim()
    if (!activeProfile || !activeApiVersion) return { ok: false, message: t('missingConnection') }
    const result = kind === 'dataSource'
      ? await getDataSourceDefinition({ profile: activeProfile, apiVersion: activeApiVersion, dataSourceName: name, language })
      : kind === 'index'
        ? await getIndexDefinition({ profile: activeProfile, apiVersion: activeApiVersion, indexName: name, language })
        : await getIndexerDefinition({ profile: activeProfile, apiVersion: activeApiVersion, indexerName: name, language })

    if (result.ok) {
      return isRecord(result.response) ? { ok: true, exists: true, value: result.response } : { ok: false, message: `${name}: JSON root must be an object.` }
    }
    if (result.status === 404) return { ok: true, exists: false, value: {} }
    return { ok: false, message: result.error.message }
  }

  const openUpdateRunReview = async () => {
    const prepared = preparePipelineDrafts()
    if (!prepared) return

    setPublishReviewLoading(true)
    setMessage(null)
    try {
      const specs: Array<{ kind: IndexingPipelinePublishResourceKind; label: string; name: string; candidate: Record<string, JsonValue> }> = [
        { kind: 'dataSource', label: t('dataSource'), name: prepared.dataSourceName, candidate: prepared.dataSource },
        { kind: 'index', label: t('index'), name: prepared.indexName, candidate: prepared.index },
        { kind: 'indexer', label: t('indexers'), name: prepared.indexerName, candidate: prepared.indexer },
      ]

      const reviewResources: PipelineUpdateReviewResource[] = []
      for (const spec of specs) {
        const baseline = await getServiceResourceBaseline(spec.kind, spec.name)
        if (!baseline.ok) {
          setMessage({ type: 'error', text: baseline.message })
          return
        }
        const semanticDiff = computePipelineResourceDiff(spec.kind, baseline.value, spec.candidate)
        if (baseline.exists && semanticDiff.identical) continue
        const [maskedBaseline, maskedCandidate] = spec.kind === 'dataSource'
          ? maskDataSourceCredentialsForDiffPair(baseline.value, spec.candidate)
          : [baseline.value, spec.candidate]
        const baselineText = spec.kind === 'dataSource' ? JSON.stringify(maskedBaseline, null, 2) : prettyJson(baseline.value)
        const candidateText = spec.kind === 'dataSource' ? JSON.stringify(maskedCandidate, null, 2) : prettyJson(spec.candidate)
        reviewResources.push({
          kind: spec.kind,
          label: spec.label,
          name: spec.name,
          action: baseline.exists ? 'update' : 'create',
          baselineText,
          candidateText,
          semanticDiff,
          candidate: spec.candidate,
        })
      }

      if (reviewResources.length === 0) {
        setMessage({ type: 'info', text: t('noResourceUpdates') })
        await executeUpdateAndRunPipeline([], prepared)
        return
      }

      setPendingUpdateResources(reviewResources)
      setPublishReviewActiveKind(reviewResources[0].kind)
      setPublishReviewDiffViewMode('semantic')
      setPublishReviewOpen(true)
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setPublishReviewLoading(false)
    }
  }

  const markResourcePublished = (resource: IndexingPipelineResourceKind, name: string) => {
    setDraft((current) => ({
      ...current,
      [resource]: {
        ...current[resource],
        baselineText: current[resource].text,
        loadedName: name,
        loadedAt: new Date().toISOString(),
      },
    }))
  }

  async function executeUpdateAndRunPipeline(updates = pendingUpdateResources, preparedInput?: PreparedPipelineDrafts) {
    const prepared = preparedInput ?? preparePipelineDrafts()
    if (!prepared) return
    const activeProfile = profile
    const activeApiVersion = apiVersion.trim()
    if (!activeProfile || !activeApiVersion) {
      setMessage({ type: 'error', text: t('missingConnection') })
      return
    }

    setPublishReviewOpen(false)
    setRunLoading(true)
    setStatusLoading(true)
    setVerifyLoading(true)
    setRunTracker(createIdleRunTracker())
    setMessage({ type: 'info', text: t('updateRunStarted') })

    const updatesByKind = new Map<IndexingPipelinePublishResourceKind, PipelineUpdateReviewResource>()
    for (const update of updates) updatesByKind.set(update.kind, update)

    setRunStep('validate', 'running')
    setRunStep('validate', 'success', `${prepared.dataSourceName} -> ${prepared.indexerName} -> ${prepared.indexName}`)

    try {
      const dataSourceUpdate = updatesByKind.get('dataSource')
      if (dataSourceUpdate) {
        setRunStep('dataSource', 'running', prepared.dataSourceName)
        const dsResult = await createOrUpdateDataSource({ profile: activeProfile, apiVersion: activeApiVersion, dataSourceName: prepared.dataSourceName, body: dataSourceUpdate.candidate, language })
        const dsLog = responseToLogJson(dsResult)
        setRunStep('dataSource', dsResult.ok ? 'success' : 'error', dsResult.ok ? `${dsResult.status}` : dsResult.error.message, dsLog)
        if (!dsResult.ok) throw new Error(dsResult.error.message)
        markResourcePublished('dataSource', prepared.dataSourceName)
      } else {
        setRunStep('dataSource', 'skipped', t('noResourceUpdates'))
      }

      const indexUpdate = updatesByKind.get('index')
      if (indexUpdate) {
        setRunStep('index', 'running', prepared.indexName)
        const indexResult = await createOrUpdateIndex({ profile: activeProfile, apiVersion: activeApiVersion, indexName: prepared.indexName, body: indexUpdate.candidate, language })
        const indexLog = responseToLogJson(indexResult)
        setRunStep('index', indexResult.ok ? 'success' : 'error', indexResult.ok ? `${indexResult.status}` : indexResult.error.message, indexLog)
        if (!indexResult.ok) throw new Error(indexResult.error.message)
        markResourcePublished('index', prepared.indexName)
      } else {
        setRunStep('index', 'skipped', t('noResourceUpdates'))
      }

      const indexerUpdate = updatesByKind.get('indexer')
      if (indexerUpdate) {
        setRunStep('indexer', 'running', prepared.indexerName)
        const indexerResult = await createOrUpdateIndexer({ profile: activeProfile, apiVersion: activeApiVersion, indexerName: prepared.indexerName, body: indexerUpdate.candidate, language })
        const indexerLog = responseToLogJson(indexerResult)
        setRunStep('indexer', indexerResult.ok ? 'success' : 'error', indexerResult.ok ? `${indexerResult.status}` : indexerResult.error.message, indexerLog)
        if (!indexerResult.ok) throw new Error(indexerResult.error.message)
        markResourcePublished('indexer', prepared.indexerName)
      } else {
        setRunStep('indexer', 'skipped', t('noResourceUpdates'))
      }

      setRunStep('run', 'running', prepared.indexerName)
      const runResult = await runIndexer({ profile: activeProfile, apiVersion: activeApiVersion, indexerName: prepared.indexerName, language })
      const runLog = responseToLogJson(runResult)
      setLastRunResponse(runLog)
      setRunStep('run', runResult.ok ? 'success' : 'error', runResult.ok ? `${runResult.status}` : runResult.error.message, runLog)
      if (!runResult.ok) throw new Error(runResult.error.message)

      setRunStep('status', 'running', prepared.indexerName)
      const statusResult = await getIndexerStatus({ profile: activeProfile, apiVersion: activeApiVersion, indexerName: prepared.indexerName, language })
      const statusLog = responseToLogJson(statusResult)
      setLastStatus(statusLog)
      setRunStep('status', statusResult.ok ? 'success' : 'error', statusResult.ok ? `${statusResult.status}` : statusResult.error.message, statusLog)
      if (!statusResult.ok) throw new Error(statusResult.error.message)

      setRunStep('verify', 'running', prepared.indexName)
      const [statsResult, sampleResult] = await Promise.all([
        getIndexStatistics({ profile: activeProfile, apiVersion: activeApiVersion, indexName: prepared.indexName, language }),
        searchDocuments({ profile: activeProfile, apiVersion: activeApiVersion, indexName: prepared.indexName, language, body: { search: '*', top: 3, count: true } as JsonValue }),
      ])
      const verifyError = firstErrorMessage([
        { label: 'stats', result: statsResult },
        { label: 'sample', result: sampleResult },
      ])
      const nextVerification = {
        stats: statsResult.ok ? statsResult.response : responseToLogJson(statsResult),
        sample: sampleResult.ok ? sampleResult.response : responseToLogJson(sampleResult),
        error: verifyError || null,
      }
      setVerification(nextVerification)
      setRunStep('verify', verifyError ? 'error' : 'success', verifyError || `${documentCountFromStats(nextVerification.stats)} ${t('documentCount')}`, nextVerification as unknown as JsonValue)
      if (verifyError) throw new Error(verifyError)

      setMessage({ type: 'success', text: t('pipelineCompleted') })
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setRunLoading(false)
      setStatusLoading(false)
      setVerifyLoading(false)
    }
  }

  const renderResourceHub = () => (
    <section className="ipbResourceHub" data-guide-target="ipb-resources">
      <div className="ipbResourceHub__left">
        <div className="ipbPanelHeader__title">{t('resources')}</div>
        <div className="ipbResourceHub__counts" aria-label={t('resourceCounts')}>
          <span><i className="bi bi-arrow-repeat"></i>{resourceLists.indexers.length} {t('indexers')}</span>
          <span><i className="bi bi-hdd-network"></i>{resourceLists.dataSources.length} {t('dataSources')}</span>
          <span><i className="bi bi-table"></i>{resourceLists.indexes.length} {t('indexes')}</span>
        </div>
      </div>
      <div className="ipbResourceHub__controls">
        <label className="field ipbField ipbIndexerDropdownField">
          <span className="field__label">{t('selectedIndexer')}</span>
          <div className="dropdown analyzer-bs ipbIndexerDropdown">
            <button
              type="button"
              className="field__input ipbIndexerDropdown__toggle"
              data-guide-target="ipb-indexer-select"
              data-bs-toggle="dropdown"
              data-bs-auto-close="outside"
              data-bs-display="static"
              aria-haspopup="true"
              disabled={resourceLists.indexers.length === 0}
              onClick={() => {
                setResourceFilter('')
                window.setTimeout(() => indexerFilterInputRef.current?.focus(), 0)
              }}
            >
              <span className="dropdown-toggle__label">{selectedIndexerName || t('noIndexers')}</span>
              <span className="dropdown-toggle__caret" aria-hidden="true" />
            </button>
            <div className="dropdown-menu dropdown-menu--left ipbIndexerDropdown__menu">
              <div className="dropdown-menu__pad">
                <input
                  ref={indexerFilterInputRef}
                  type="text"
                  className="field__input"
                  placeholder={t('filterIndexers')}
                  value={resourceFilter}
                  onChange={(event) => setResourceFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') hideClosestBootstrapDropdown(event.currentTarget)
                  }}
                />
              </div>
              {filteredIndexers.length === 0 && <div className="dropdown-item disabled">{t('noIndexerMatches')}</div>}
              {filteredIndexers.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={'dropdown-item ' + (name === selectedIndexerName ? 'active' : '')}
                  onClick={(event) => {
                    setSelectedIndexerName(name)
                    setResourceFilter('')
                    hideClosestBootstrapDropdown(event.currentTarget)
                  }}
                >
                  <span className="dropdown-label">{name}</span>
                </button>
              ))}
            </div>
          </div>
        </label>
        <button type="button" className="btn" onClick={refreshResourceLists} disabled={!canQuery || loadingResources}>
          <i className="bi bi-arrow-clockwise icon--mr6"></i>
          {loadingResources ? t('loading') : t('refreshResources')}
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void loadPipelineFromIndexer(selectedIndexerName)}
          disabled={!canQuery || loadingPipeline || !selectedIndexerName.trim()}
        >
          <i className="bi bi-box-arrow-in-down icon--mr6"></i>
          {loadingPipeline ? `${t('loading')}...` : t('loadSelected')}
        </button>
      </div>
    </section>
  )

  const renderLoadedIndexerBar = () => {
    if (!hasPipelineDraft) {
      return (
        <div className="ipbLoadedIndexerBar" aria-label={t('loadedIndexerContext')}>
          <span className="ipbLoadedIndexerBar__badge ipbLoadedIndexerBar__badge--new">{t('noPipelineLoadedTitle')}</span>
          <span className="ipbLoadedIndexerBar__meta">{t('noLocalDraftLoaded')}</span>
        </div>
      )
    }

    const isServiceLoaded = !!draft.indexer.loadedAt
    const loadedName = draft.indexer.loadedName?.trim() || ''
    const currentName = indexerName || loadedName || '-'
    const indexerDirty = unsavedResources.includes('indexer')
    return (
      <div className="ipbLoadedIndexerBar" aria-label={t('loadedIndexerContext')}>
        <span className={'ipbLoadedIndexerBar__badge ' + (isServiceLoaded ? 'ipbLoadedIndexerBar__badge--loaded' : 'ipbLoadedIndexerBar__badge--new')}>
          {isServiceLoaded ? t('serviceLoadedBadge') : t('newIndexerDraftBadge')}
        </span>
        <span className="ipbLoadedIndexerBar__main mono">
          {isServiceLoaded ? (loadedName || '-') : currentName}
        </span>
        <span className="ipbLoadedIndexerBar__meta">{currentDraftId ? `${t('currentDraft')}: ${currentDraftTitle}` : t('noLocalDraftLoaded')}</span>
        {isServiceLoaded && currentName !== loadedName && (
          <span className="ipbLoadedIndexerBar__meta mono">{t('draftIndexerName')}: {currentName}</span>
        )}
        {indexerDirty && <span className="ipbLoadedIndexerBar__dirty">{t('unsaved')}</span>}
      </div>
    )
  }

  const combinedPipelineStatus = (...ids: PipelineStepId[]): PipelineStepStatus => {
    const statuses = ids.map((id) => runTracker[id]?.status ?? 'idle')
    if (statuses.includes('running')) return 'running'
    if (statuses.includes('error')) return 'error'
    if (statuses.includes('success')) return 'success'
    if (statuses.includes('skipped')) return 'skipped'
    return 'idle'
  }

  const pipelineNodeClass = (kind: 'source' | 'indexer' | 'index' | 'verify', tab: IndexingPipelineEditorTab, status: PipelineStepStatus) => [
    'ipbPipelineNode',
    `ipbPipelineNode--${kind}`,
    activeTab === tab ? 'ipbPipelineNode--active' : '',
    status !== 'idle' ? `ipbPipelineNode--${status}` : '',
  ].filter(Boolean).join(' ')

  const renderPipelineStrip = () => (
    <div className="ipbPipelineCanvas" aria-label={t('pipeline')}>
      <button type="button" className={pipelineNodeClass('source', 'source', combinedPipelineStatus('dataSource'))} data-guide-target="ipb-node-source" onClick={() => setTab('source')}>
        <span className="ipbPipelineNode__icon"><i className="bi bi-hdd-network"></i></span>
        <span className="ipbPipelineNode__label">{t('source')}</span>
        <strong>{dataSourceName || '-'}</strong>
        <em>{dataSourceDescriptor ? dataSourceLabel(dataSourceDescriptor, language) : dataSourceType || '-'}</em>
      </button>
      <span className="ipbPipelineEdge"><i className="bi bi-arrow-right"></i></span>
      <button type="button" className={pipelineNodeClass('indexer', 'indexer', combinedPipelineStatus('indexer', 'run', 'status'))} data-guide-target="ipb-node-indexer" onClick={() => setTab('indexer')}>
        <span className="ipbPipelineNode__icon"><i className="bi bi-arrow-repeat"></i></span>
        <span className="ipbPipelineNode__label">{t('importProcess')}</span>
        <strong>{indexerName || '-'}</strong>
        <em>{getBooleanField(parsed.indexer, 'disabled') ? t('disabled') : `${fieldMappings.length + outputFieldMappings.length} mappings`}</em>
      </button>
      <span className="ipbPipelineEdge"><i className="bi bi-arrow-right"></i></span>
      <button type="button" className={pipelineNodeClass('index', 'index', combinedPipelineStatus('index'))} data-guide-target="ipb-node-index" onClick={() => setTab('index')}>
        <span className="ipbPipelineNode__icon"><i className="bi bi-table"></i></span>
        <span className="ipbPipelineNode__label">{t('target')}</span>
        <strong>{indexerRefs.targetIndexName || indexName || '-'}</strong>
        <em>{fieldCount(parsed.index)} {t('fields')} / {vectorFieldCount(parsed.index)} {t('vectorFields')}</em>
      </button>
      <span className="ipbPipelineEdge"><i className="bi bi-arrow-right"></i></span>
      <button type="button" className={pipelineNodeClass('verify', 'overview', combinedPipelineStatus('verify'))} data-guide-target="ipb-node-verify" onClick={() => setTab('overview')}>
        <span className="ipbPipelineNode__icon"><i className="bi bi-check2-circle"></i></span>
        <span className="ipbPipelineNode__label">{t('verification')}</span>
        <strong>{documentCountFromStats(verification.stats)}</strong>
        <em>{sampleDocumentCount(verification.sample)} {t('sampleCount')}</em>
      </button>
    </div>
  )

  const renderRunTracker = (compact = false) => (
    <div className={compact ? 'ipbRunTracker ipbRunTracker--compact' : 'ipbRunTracker'}>
      {stepOrder.map((stepId) => {
        const step = runTracker[stepId]
        const labelKey = (`step${stepId[0].toUpperCase()}${stepId.slice(1)}`) as CopyKey
        const statusKey = (`status${step.status[0].toUpperCase()}${step.status.slice(1)}`) as CopyKey
        return (
          <div key={stepId} className={`ipbRunStep ipbRunStep--${step.status}`}>
            <span className="ipbRunStep__icon"><i className={`bi ${stepIcon(step.status)}`}></i></span>
            <span className="ipbRunStep__body">
              <strong>{t(labelKey)}</strong>
              <em>{step.detail || t(statusKey)}</em>
            </span>
          </div>
        )
      })}
    </div>
  )

  const renderOverview = () => (
    <div className="ipbOverview ipbRunStatus">
      <div className="ipbHeroGrid">
        <section className="ipbHeroPanel ipbHeroPanel--run ipbRunStatus__pipeline" data-guide-target="ipb-run-tracker">
          <div className="ipbHeroPanel__header">
            <div>
              <div className="ipbPanelHeader__title">{t('runPipeline')}</div>
              <div className="ipbPanelHeader__meta">{t('formsFirst')}</div>
            </div>
            <div className="ipbRunCommandBar" data-guide-target="ipb-overview-run-actions">
              <button type="button" className="btn" onClick={startIndexerReset} disabled={!hasPipelineDraft || !canQuery || resetLoading || runLoading || statusLoading || !activeIndexerName.trim()}>
                <i className="bi bi-arrow-counterclockwise icon--mr6"></i>
                {resetLoading ? `${t('loading')}...` : t('resetIndexer')}
              </button>
              <button type="button" className="btn" onClick={startIndexerRun} disabled={!hasPipelineDraft || !canQuery || resetLoading || runLoading || statusLoading || !activeIndexerName.trim()}>
                <i className="bi bi-play-circle icon--mr6"></i>
                {runLoading ? `${t('loading')}...` : t('runIndexer')}
              </button>
              <button type="button" className="btn" onClick={refreshIndexerStatus} disabled={!hasPipelineDraft || !canQuery || resetLoading || statusLoading || !activeIndexerName.trim()}>
                <i className="bi bi-arrow-clockwise icon--mr6"></i>
                {statusLoading ? `${t('loading')}...` : t('refreshStatus')}
              </button>
              <button type="button" className="btn" onClick={verifyTargetIndex} disabled={!hasPipelineDraft || !canQuery || verifyLoading || !(indexerRefs.targetIndexName || indexName).trim()}>
                <i className="bi bi-check2-circle icon--mr6"></i>
                {verifyLoading ? `${t('loading')}...` : t('verifyTarget')}
              </button>
            </div>
          </div>
          {renderRunTracker()}
        </section>

        <section className="ipbHeroPanel ipbHeroPanel--verification" data-guide-target="ipb-verification">
          <div className="ipbPanelHeader__title">{t('indexVerification')}</div>
          <div className="ipbMetricGrid">
            <div className="ipbMetric"><span>{t('documentCount')}</span><strong>{documentCountFromStats(verification.stats)}</strong></div>
            <div className="ipbMetric"><span>{t('sampleCount')}</span><strong>{sampleDocumentCount(verification.sample)}</strong></div>
            <div className="ipbMetric"><span>{t('activeFields')}</span><strong>{indexFieldNames.length}</strong></div>
            <div className="ipbMetric"><span>{t('vectorFields')}</span><strong>{vectorFieldCount(parsed.index)}</strong></div>
          </div>
        </section>
      </div>

      <section className="ipbReferencePanel ipbReferencePanel--verification">
        <div className="ipbPanelHeader__title">{t('indexVerification')}</div>
        {verification.error && <div className="notice notice--error">{verification.error}</div>}
        {verification.stats || verification.sample ? (
          <div className="ipbVerificationGrid">
            <div>
              <div className="form__metaTitle">stats</div>
              <div className="mono jsonViewer__body rawJsonViewer">
                <JsonViewer data={verification.stats ?? null} t={globalT} />
              </div>
            </div>
            <div>
              <div className="form__metaTitle">sample</div>
              <div className="mono jsonViewer__body rawJsonViewer">
                <JsonViewer data={verification.sample ?? null} t={globalT} />
              </div>
            </div>
          </div>
        ) : (
          <div className="empty">{t('noVerification')}</div>
        )}
      </section>

      <div className="ipbReferenceGrid ipbReferenceGrid--run">
        <section className="ipbReferencePanel">
          <div className="ipbPanelHeader__title">{t('status')}</div>
          {lastStatus ? (
            <div className="mono jsonViewer__body rawJsonViewer">
              <JsonViewer data={lastStatus} t={globalT} />
            </div>
          ) : <div className="empty">{t('noStatus')}</div>}
        </section>
        <section className="ipbReferencePanel">
          <div className="ipbPanelHeader__title">{t('lastRun')}</div>
          {lastRunResponse ? <pre className="ipbPre mono">{prettyJson(lastRunResponse)}</pre> : <div className="empty">{t('noStatus')}</div>}
        </section>
      </div>
    </div>
  )

  const renderInspectorGroupHeader = (titleJa: string, titleEn: string, introJa: string, introEn: string) => (
    <header className="ipbGroup__header">
      <div>
        <div className="ipbGroup__title">{language === 'ja' ? titleJa : titleEn}</div>
        <div className="ipbGroup__intro">{language === 'ja' ? introJa : introEn}</div>
      </div>
    </header>
  )

  const renderParameterInfo = (docsText: string) => docsText ? (
    <span className="infoTooltip ipbParameterInfoTooltip" title={docsText} aria-label={docsText}>ⓘ</span>
  ) : null

  const renderParameterName = (label: string, docsKey: string, mono = false, fallback = '') => {
    const docsText = schemaParameterDocs(docsKey, language, fallback)
    return (
      <span className="ipbParameterLabel">
        <span className={mono ? 'mono' : undefined}>{label}</span>
        {isRequiredSchemaParameter(docsKey) && <span className="ipbRequiredMark" title={language === 'ja' ? '必須' : 'Required'}>*</span>}
        {renderParameterInfo(docsText)}
      </span>
    )
  }

  const renderDataSourceDesigner = () => (
    <section className="ipbInspector ipbInspector--source" data-guide-target="ipb-source-designer">
      <header className="ipbInspector__hero">
        <div className="ipbInspector__heroIcon"><i className="bi bi-hdd-network"></i></div>
        <div>
          <div className="ipbInspector__eyebrow">{t('source')}</div>
          <h2 className="ipbInspector__title">{dataSourceDescriptor ? dataSourceLabel(dataSourceDescriptor, language) : (dataSourceType || (language === 'ja' ? '未設定' : 'Not set'))}</h2>
          <p className="ipbInspector__lede">{dataSourceDescriptor ? descriptorHint(dataSourceDescriptor, language) : t('sourceTypeHint')}</p>
        </div>
        <div className="ipbInspector__heroMeta">
          <span className="indexSchemaBadge indexSchemaBadge--configured">{dataSourceType || '-'}</span>
          <strong>{dataSourceName || '-'}</strong>
        </div>
      </header>

      <details className="ipbGroup ipbGroup--catalog" open={!dataSourceDescriptor}>
        <summary>
          <span className="ipbGroup__summaryTitle"><i className="bi bi-collection icon--mr6"></i>{t('sourceTypeHero')}</span>
          <span className="ipbGroup__summaryHint">{t('changeSourceType')}</span>
        </summary>
        <div className="ipbGroup__body">
          <p className="ipbGroup__intro">{t('sourceTypeHint')}</p>
          <div className="ipbSourceTypeGrid">
            {SUPPORTED_DATA_SOURCE_DESCRIPTORS.map((descriptor) => (
              <button
                key={descriptor.type}
                type="button"
                className={'ipbSourceTypeCard' + (dataSourceDescriptor?.type === descriptor.type ? ' ipbSourceTypeCard--active' : '')}
                onClick={() => applyDataSourceDescriptor(descriptor)}
                title={descriptorHint(descriptor, language)}
              >
                <span className="ipbSourceTypeCard__top">
                  <strong>{dataSourceLabel(descriptor, language)}</strong>
                  {descriptor.preview && <em>preview</em>}
                </span>
                <span className="mono">{descriptor.type}</span>
                <span className="ipbSourceTypeCard__hint">{descriptorHint(descriptor, language)}</span>
              </button>
            ))}
          </div>
        </div>
      </details>

      <section className="ipbGroup" data-group="connection" data-guide-target="ipb-source-connection">
        {renderInspectorGroupHeader(
          t('connectionGroup'),
          t('connectionGroup'),
          t('connectionGroupHint'),
          t('connectionGroupHint'),
        )}
        <div className="ipbGroup__body ipbFormGrid">
          <label className="field ipbField">
            <span className="field__label">{renderParameterName(t('name'), 'dataSource.name')}</span>
            <input className="field__input" value={dataSourceName} onChange={(event) => updateResourceObject('dataSource', (value) => ({ ...value, name: event.target.value }))} />
          </label>
          <label className="field ipbField">
            <span className="field__label">{t('credentialMode')}</span>
            <select className="field__input" value={dataSourceCredentialMode} onChange={(event) => setDataSourceCredentialMode(event.target.value as DataSourceCredentialMode)}>
              <option value="connectionString">{t('credentialModeConnectionString')}</option>
              <option value="systemAssignedManagedIdentity">{t('credentialModeSystemManagedIdentity')}</option>
              <option value="userAssignedManagedIdentity">{t('credentialModeUserManagedIdentity')}</option>
            </select>
          </label>
          {dataSourceCredentialMode === 'connectionString' ? (
            <label className="field ipbField ipbField--wide">
              <span className="field__label">{renderParameterName(t('connectionString'), 'credentials.connectionString')}</span>
              <input className="field__input" value={getTextInputValue(dataSourceCredentials.connectionString)} onChange={(event) => updateNestedObject('dataSource', 'credentials', { connectionString: event.target.value })} placeholder="<connection-string-or-managed-identity-settings>" />
            </label>
          ) : (
            <>
              <label className="field ipbField ipbField--wide">
                <span className="field__label">{renderParameterName(t('managedIdentityResourceId'), 'credentials.connectionString')}</span>
                <input className="field__input" value={dataSourceManagedIdentityResourceId} onChange={(event) => setDataSourceManagedIdentityResourceId(event.target.value)} placeholder="/subscriptions/{subscription-id}/resourceGroups/{resource-group}/providers/Microsoft.Storage/storageAccounts/{account}" />
                <span className="ipbParamRow__hint">{t('managedIdentityResourceIdHint')}</span>
              </label>
              {dataSourceCredentialMode === 'userAssignedManagedIdentity' && (
                <label className="field ipbField ipbField--wide">
                  <span className="field__label">{t('userAssignedIdentity')}</span>
                  <input className="field__input" value={dataSourceUserAssignedIdentity} onChange={(event) => setDataSourceUserAssignedIdentity(event.target.value)} placeholder="/subscriptions/{subscription-id}/resourceGroups/{resource-group}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/{identity-name}" />
                  <span className="ipbParamRow__hint">{t('userAssignedIdentityHint')}</span>
                </label>
              )}
              {dataSourceCredentialMode === 'userAssignedManagedIdentity' && !userAssignedIdentityApiSupported && (
                <div className="notice notice--warning builder__notice ipbField--wide" role="status" aria-live="polite">
                  {t('userAssignedIdentityApiWarning')}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="ipbGroup" data-group="container" data-guide-target="ipb-source-container">
        {renderInspectorGroupHeader(
          t('containerGroup'),
          t('containerGroup'),
          t('containerGroupHint'),
          t('containerGroupHint'),
        )}
        <div className="ipbGroup__body ipbFormGrid">
          <label className="field ipbField">
            <span className="field__label">{renderParameterName(t('containerName'), 'container.name')}</span>
            <input className="field__input" value={getTextInputValue(dataSourceContainer.name)} onChange={(event) => updateNestedObject('dataSource', 'container', { name: event.target.value })} />
          </label>
          <label className="field ipbField">
            <span className="field__label">{renderParameterName(t('containerQuery'), 'container.query')}</span>
            <input className="field__input" value={getTextInputValue(dataSourceContainer.query)} onChange={(event) => updateNestedObject('dataSource', 'container', { query: event.target.value.trim() ? event.target.value : null })} />
          </label>
        </div>
      </section>
    </section>
  )

  const renderIndexDesigner = () => {
    const targetIndexName = (indexerRefs.targetIndexName || indexName).trim()
    const canOpenIndexBuilder = !!targetIndexName && !!onOpenIndexBuilder && (resourceLists.indexes.includes(targetIndexName) || draft.index.loadedName === targetIndexName)
    const explicitTargetIndexName = indexerRefs.targetIndexName.trim()
    const isIndexReferenceMatched = !!explicitTargetIndexName && !!indexName && explicitTargetIndexName === indexName
    const hasIndexReferenceMismatch = !!explicitTargetIndexName && !!indexName && explicitTargetIndexName !== indexName
    const hasIndexReferenceMissing = !explicitTargetIndexName || !indexName
    const indexReferenceStateLabel = hasIndexReferenceMissing
      ? (language === 'ja' ? '未設定' : 'Missing')
      : hasIndexReferenceMismatch
        ? (language === 'ja' ? '不一致' : 'Mismatch')
        : (language === 'ja' ? '一致' : 'Matched')
    const indexReferenceStateClass = hasIndexReferenceMissing || hasIndexReferenceMismatch ? 'indexSchemaBadge indexSchemaBadge--missing' : 'indexSchemaBadge indexSchemaBadge--configured'
    return (
    <section className="ipbInspector ipbInspector--index" data-guide-target="ipb-index-designer">
      <header className="ipbInspector__hero">
        <div className="ipbInspector__heroIcon"><i className="bi bi-table"></i></div>
        <div>
          <div className="ipbInspector__eyebrow">{t('target')}</div>
          <h2 className="ipbInspector__title">{targetIndexName || (language === 'ja' ? '未設定' : 'Not set')}</h2>
          <p className="ipbInspector__lede">{t('indexHeroHint')}</p>
        </div>
        <div className="ipbInspector__heroMeta">
          <span className={indexReferenceStateClass}>{indexReferenceStateLabel}</span>
          <span className="indexSchemaBadge indexSchemaBadge--configured">{vectorFieldCount(parsed.index)} {t('vectorFields')}</span>
          <strong>{fieldCount(parsed.index)} {t('fields')}</strong>
          {canOpenIndexBuilder && (
            <button type="button" className="btn ipbInlineAction" onClick={() => onOpenIndexBuilder(targetIndexName)}>
              <i className="bi bi-box-arrow-up-right icon--mr6"></i>
              {t('openInIndexBuilder')}
            </button>
          )}
        </div>
      </header>

      <section className="ipbGroup">
        {renderInspectorGroupHeader(
          'リファレンス',
          'References',
          'targetIndexName は Indexer 側で設定します。この画面では draft Index の name と一致していることだけ確認します。',
          'targetIndexName is configured on the Indexer side. This view only confirms that it matches the draft index name.',
        )}
        <div className="ipbGroup__body ipbSummaryGrid">
          <div className="ipbSummaryCard">
            <span className="ipbSummaryCard__label">{renderParameterName(t('name'), 'index.name')}</span>
            <strong className="ipbSummaryCard__value mono">{indexName || '-'}</strong>
            <span className="ipbSummaryCard__meta">{language === 'ja' ? 'draft Index 定義の name です。変更は Index Builder または Raw JSON で行います。' : 'The name in the draft index definition. Change it in Index Builder or Raw JSON.'}</span>
          </div>
          <div className="ipbSummaryCard">
            <span className="ipbSummaryCard__label">{renderParameterName(t('targetIndexName'), 'targetIndexName', true)}</span>
            <strong className="ipbSummaryCard__value mono">{explicitTargetIndexName || '-'}</strong>
            <span className="ipbSummaryCard__meta">{language === 'ja' ? 'Indexer が参照する投入先です。変更は Indexer タブで行います。' : 'The target referenced by the indexer. Change it in the Indexer tab.'}</span>
          </div>
          <div className={'ipbSummaryCard ' + (isIndexReferenceMatched ? 'ipbSummaryCard--success' : hasIndexReferenceMismatch ? 'ipbSummaryCard--error' : '')}>
            <span className="ipbSummaryCard__label">{language === 'ja' ? '参照状態' : 'Reference state'}</span>
            <strong className="ipbSummaryCard__value">{indexReferenceStateLabel}</strong>
            <span className="ipbSummaryCard__meta">{language === 'ja' ? 'Publish & Run pipeline 前に一致している必要があります。' : 'It must match before Publish & Run pipeline.'}</span>
          </div>
        </div>
        {!explicitTargetIndexName && <div className="notice notice--error">{language === 'ja' ? 'Indexer タブで targetIndexName を設定してください。' : 'Set targetIndexName in the Indexer tab.'}</div>}
        {!indexName && <div className="notice notice--error">{language === 'ja' ? 'draft Index の name が未設定です。Index Builder または Raw JSON で設定してください。' : 'The draft index name is missing. Set it in Index Builder or Raw JSON.'}</div>}
        {hasIndexReferenceMismatch && <div className="notice notice--error">{language === 'ja' ? `Indexer は "${explicitTargetIndexName}" を参照していますが、draft Index は "${indexName}" です。` : `Indexer references "${explicitTargetIndexName}" but the draft index is "${indexName}".`}</div>}
      </section>

      <section className="ipbGroup">
        {renderInspectorGroupHeader(
          'Key / Field 一覧',
          'Key / fields',
          t('keyFieldHint'),
          t('keyFieldHint'),
        )}
        <div className="ipbGroup__body">
          <div className="ipbFieldRibbon">
            {indexFieldNames.slice(0, 24).map((field) => (
              <span key={field} className={'ipbFieldPill' + (field === keyFieldName ? ' ipbFieldPill--key' : '')}>{field}{field === keyFieldName ? ' · key' : ''}</span>
            ))}
            {indexFieldNames.length > 24 && <span className="ipbFieldPill">+{indexFieldNames.length - 24}</span>}
            {indexFieldNames.length === 0 && <span className="empty">{language === 'ja' ? 'field がまだありません。' : 'No fields yet.'}</span>}
          </div>
        </div>
      </section>
    </section>
    )
  }

  const renderConfigInput = (field: IndexerSchemaField, value: JsonValue | undefined, onChange: (value: JsonValue | undefined) => void) => {
    const options = selectOptionsForConfig(field.name)
    const tip = schemaFieldNotes(field, language)
    const docsTip = schemaParameterDocs(field.name, language, tip)
    if (field.valueType === 'boolean') {
      return (
        <label className="ipbParamRow ipbParamRow--toggle" title={docsTip}>
          <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
          <span className="ipbParamRow__main">
            <span className="ipbParamRow__name">{renderParameterName(field.name, field.name, true, tip)}</span>
            <span className="ipbParamRow__hint">{tip}</span>
          </span>
        </label>
      )
    }
    const inputControl = field.valueType === 'number' ? (
      <input className="field__input" type="number" value={getNumberInputValue(value)} onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))} />
    ) : options ? (
      <select className="field__input" value={getTextInputValue(value)} onChange={(event) => onChange(event.target.value || undefined)}>
        <option value="">-</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    ) : (
      <input className="field__input" value={getTextInputValue(value)} onChange={(event) => onChange(event.target.value.trim() ? event.target.value : undefined)} />
    )
    return (
      <label className="field ipbField ipbParamRow" title={docsTip}>
        <span className="field__label ipbParamRow__label">{renderParameterName(field.name, field.name, true, tip)}</span>
        {inputControl}
        <span className="ipbParamRow__hint">{tip}</span>
      </label>
    )
  }

  const indexerParameterFieldMap = useMemo(() => {
    const map = new Map<string, IndexerSchemaField>()
    for (const field of INDEXER_PARAMETER_FIELDS) map.set(field.name, field)
    for (const field of INDEXER_CONFIGURATION_FIELDS) map.set(field.name, field)
    return map
  }, [])

  const activeConfigFieldNames = useMemo(() => new Set(activeConfigFields.map((field) => field.name)), [activeConfigFields])

  const renderParameterGroup = (group: ParameterGroupDef) => {
    const members = group.members
      .map((member) => {
        const field = indexerParameterFieldMap.get(member.name)
        if (!field) return null
        if (member.scope === 'configuration' && !activeConfigFieldNames.has(member.name)) return null
        return { field, scope: member.scope }
      })
      .filter((entry): entry is { field: IndexerSchemaField; scope: ParamScope } => entry !== null)
    if (members.length === 0) return null
    const previewMembers = members.filter((m) => m.field.preview).length
    const activeMembers = members.filter((m) => {
      const value = m.scope === 'configuration' ? indexerConfiguration[m.field.name] : indexerParameters[m.field.name]
      return value !== undefined && value !== null && value !== '' && value !== false
    }).length
    return (
      <details key={group.id} className="ipbGroup ipbGroup--param" open={activeMembers > 0}>
        <summary>
          <span className="ipbGroup__summaryTitle">
            <i className="bi bi-sliders icon--mr6"></i>{language === 'ja' ? group.titleJa : group.titleEn}
            {previewMembers > 0 && <em className="ipbGroup__previewBadge">preview</em>}
          </span>
          <span className="ipbGroup__summaryHint">{activeMembers} / {members.length} {language === 'ja' ? '設定済み' : 'set'}</span>
        </summary>
        <div className="ipbGroup__body">
          <p className="ipbGroup__intro">{language === 'ja' ? group.introJa : group.introEn}</p>
          <div className="ipbParamList">
            {members.map(({ field, scope }) => (
              <div key={`${scope}:${field.name}`}>{renderConfigInput(
                field,
                scope === 'configuration' ? indexerConfiguration[field.name] : indexerParameters[field.name],
                (value) => scope === 'configuration' ? setIndexerConfiguration(field.name, value) : setIndexerParameter(field.name, value),
              )}</div>
            ))}
          </div>
        </div>
      </details>
    )
  }

  const renderMappingEditor = (key: FieldMappingKey, items: ReturnType<typeof getFieldMappings>, title: string) => {
    const targetFieldListId = `${key}-target-fields`
    return (
      <section className="ipbMappingEditor" data-guide-target={`ipb-${key}`}>
        <div className="ipbMappingEditor__header">
          <div className="ipbMappings__title">{renderParameterName(title, key, true)}</div>
          <button type="button" className="btn btn--sm" onClick={() => addMappingRow(key)}>
            <i className="bi bi-plus-lg icon--mr6"></i>
            {t('addMapping')}
          </button>
        </div>
        <datalist id={targetFieldListId}>
          {indexFieldNames.map((fieldName) => <option key={fieldName} value={fieldName} />)}
        </datalist>
        {items.length === 0 ? (
          <div className="empty ipbMappingEditor__empty">{t('noMappings')}</div>
        ) : (
          <div className="ipbMappingRows">
            {items.map((mapping, index) => {
              const targetMissing = !!mapping.targetFieldName && !indexFieldNames.includes(mapping.targetFieldName)
              return (
                <div className="ipbMappingRow" key={`${key}:${index}`}>
                  <label className="field ipbField">
                    <span className="field__label">{renderParameterName(t('sourceField'), 'sourceFieldName', true)}</span>
                    <input
                      className="field__input mono"
                      value={mapping.sourceFieldName}
                      onChange={(event) => updateMappingRow(key, index, { sourceFieldName: event.target.value })}
                    />
                  </label>
                  <label className="field ipbField">
                    <span className="field__label">{renderParameterName(t('targetField'), 'targetFieldName', true)}</span>
                    <input
                      className={'field__input mono' + (targetMissing ? ' ipbFieldInputWarn' : '')}
                      list={targetFieldListId}
                      value={mapping.targetFieldName}
                      onChange={(event) => updateMappingRow(key, index, { targetFieldName: event.target.value })}
                    />
                  </label>
                  <label className="field ipbField">
                    <span className="field__label">{renderParameterName(t('mappingFunctionName'), 'mappingFunction', true)}</span>
                    <input
                      className="field__input mono"
                      placeholder="base64Encode"
                      value={getMappingFunctionName(mapping.mappingFunction)}
                      onChange={(event) => setMappingFunctionName(key, index, event.target.value)}
                    />
                  </label>
                  <button type="button" className="btn btn--icon ipbMappingRow__remove" onClick={() => removeMappingRow(key, index)} title={t('removeMapping')} aria-label={t('removeMapping')}>
                    <i className="bi bi-trash"></i>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </section>
    )
  }

  const renderIndexerDesigner = () => {
    const activeGroups = PARAMETER_GROUPS.map((group) => ({
      group,
      memberCount: group.members.filter((member) => {
        if (!indexerParameterFieldMap.has(member.name)) return false
        if (member.scope === 'configuration' && !activeConfigFieldNames.has(member.name)) return false
        return true
      }).length,
    })).filter((entry) => entry.memberCount > 0)
    return (
      <section className="ipbInspector ipbInspector--indexer" data-guide-target="ipb-indexer-designer">
        <header className="ipbInspector__hero">
          <div className="ipbInspector__heroIcon"><i className="bi bi-arrow-repeat"></i></div>
          <div>
            <div className="ipbInspector__eyebrow">{t('importProcess')}</div>
            <h2 className="ipbInspector__title">{indexerName || (language === 'ja' ? '未設定' : 'Not set')}</h2>
            <p className="ipbInspector__lede">{language === 'ja'
              ? 'Indexer は Data Source をクロールし、必要なら Skillset で enrich し、Target Index に投入します。下記のグループ単位で必要な設定だけ展開してください。'
              : 'The indexer crawls the data source, optionally enriches via a skillset, and writes into the target index. Expand only the groups you need.'}</p>
          </div>
          <div className="ipbInspector__heroMeta">
            <span className={getBooleanField(parsed.indexer, 'disabled') ? 'indexSchemaBadge indexSchemaBadge--missing' : 'indexSchemaBadge indexSchemaBadge--configured'}>
              {getBooleanField(parsed.indexer, 'disabled') ? t('disabled') : 'enabled'}
            </span>
            <strong>{indexerRefs.dataSourceName || '-'}</strong>
            <em>→ {indexerRefs.targetIndexName || '-'}</em>
          </div>
        </header>

        <section className="ipbGroup">
          {renderInspectorGroupHeader(
            t('indexerIdentityGroup'),
            t('indexerIdentityGroup'),
            t('indexerIdentityGroupHint'),
            t('indexerIdentityGroupHint'),
          )}
          <div className="ipbGroup__body ipbFormGrid">
            <label className="field ipbField">
              <span className="field__label">{renderParameterName(t('name'), 'name')}</span>
              <input className="field__input" value={indexerName} onChange={(event) => updateResourceObject('indexer', (value) => ({ ...value, name: event.target.value }))} />
            </label>
            <label className="field ipbField">
              <span className="field__label">{renderParameterName(t('dataSourceName'), 'dataSourceName', true)}</span>
              <select className="field__input" value={indexerRefs.dataSourceName || dataSourceName} onChange={(event) => updateResourceObject('indexer', (value) => ({ ...value, dataSourceName: event.target.value }))}>
                <option value={dataSourceName}>{dataSourceName || '-'}</option>
                {resourceLists.dataSources.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="field ipbField">
              <span className="field__label">{renderParameterName(t('targetIndexName'), 'targetIndexName', true)}</span>
              <select className="field__input" value={indexerRefs.targetIndexName || indexName} onChange={(event) => updateResourceObject('indexer', (value) => ({ ...value, targetIndexName: event.target.value }))}>
                <option value={indexName}>{indexName || '-'}</option>
                {resourceLists.indexes.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
            </label>
            <label className="field ipbField">
              <span className="field__label">{renderParameterName(t('skillsetName'), 'skillsetName', true)}</span>
              <input className="field__input" value={getStringField(parsed.indexer, 'skillsetName')} onChange={(event) => updateResourceObject('indexer', (value) => ({ ...value, skillsetName: event.target.value.trim() ? event.target.value : null }))} />
            </label>
            <label className="ipbParamRow ipbParamRow--toggle">
              <input type="checkbox" checked={getBooleanField(parsed.indexer, 'disabled')} onChange={(event) => updateResourceObject('indexer', (value) => ({ ...value, disabled: event.target.checked }))} />
              <span className="ipbParamRow__main">
                <span className="ipbParamRow__name">{renderParameterName('disabled', 'disabled', true)}</span>
                <span className="ipbParamRow__hint">{language === 'ja' ? 'true で indexer を停止します。schedule もスキップされます。' : 'When true, the indexer is paused and schedules are skipped.'}</span>
              </span>
            </label>
            <label className="field ipbField">
              <span className="field__label">{renderParameterName(t('scheduleInterval'), 'schedule.interval')}</span>
              <input className="field__input" placeholder="PT2H" value={getTextInputValue(indexerSchedule.interval)} onChange={(event) => updateNestedObject('indexer', 'schedule', { interval: event.target.value.trim() ? event.target.value : null })} />
            </label>
          </div>
        </section>

        <section className="ipbGroup ipbGroup--mappings" data-guide-target="ipb-indexer-mappings">
          {renderInspectorGroupHeader(
            t('indexerMappingsGroup'),
            t('indexerMappingsGroup'),
            t('indexerMappingsGroupHint'),
            t('indexerMappingsGroupHint'),
          )}
          <div className="ipbGroup__body ipbMappings">
            {renderMappingEditor('fieldMappings', fieldMappings, t('fieldMappings'))}
            {renderMappingEditor('outputFieldMappings', outputFieldMappings, t('outputFieldMappings'))}
          </div>
        </section>

        <section className="ipbGroup ipbGroup--paramSurface">
          <header className="ipbGroup__header">
            <div>
              <div className="ipbGroup__title">{t('parameterGroupsTitle')}</div>
              <div className="ipbGroup__intro">{t('parameterGroupsHint')}</div>
            </div>
            <span className="indexSchemaBadge indexSchemaBadge--configured">{activeGroups.length} {language === 'ja' ? 'グループ' : 'groups'}</span>
          </header>
          <div className="ipbGroup__body ipbParameterGroups">
            {activeGroups.length === 0 && <div className="empty">{t('nothingToConfigure')}</div>}
            {activeGroups.map((entry) => renderParameterGroup(entry.group))}
          </div>
        </section>
      </section>
    )
  }

  const renderRawJson = () => {
    const parseResult = parseDraftJson(draft[rawJsonResource].text)
    return (
      <div className="ipbRawJson" data-guide-target="ipb-raw-json">
        <div className="ipbRawJson__header">
          <div>
            <div className="ipbPanelHeader__title">{t('rawJson')}</div>
            <div className="ipbPanelHeader__meta">{t('rawJsonHint')}</div>
          </div>
          <div className="ipbRawJson__controls">
            {(['dataSource', 'index', 'indexer'] as const).map((resource) => (
              <button key={resource} type="button" className={'btn btn--tab ' + (rawJsonResource === resource ? 'btn--active' : '')} onClick={() => setRawJsonResource(resource)}>
                {resource}
              </button>
            ))}
          </div>
        </div>
        {!parseResult.ok && <div className="notice notice--error">{parseResult.message}</div>}
        <div className="builder__jsonViewBox ipbJsonEditor__box">
          <div className="synonym-editor">
            <ExpandableCodeMirror
              t={globalT}
              modalTitle={`${globalT('indexingPipelineBuilder')} - ${rawJsonResource}`}
              value={draft[rawJsonResource].text}
              height="calc(100vh - 390px)"
              theme={codeMirrorTheme}
              basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
              extensions={[json(), EditorView.lineWrapping]}
              onChange={(value) => updateDraftText(rawJsonResource, value)}
            />
          </div>
        </div>
      </div>
    )
  }

  const renderChecks = () => (
    <aside className="ipbChecks">
      <div className="ipbPanelHeader__title">{t('checks')}</div>
      <div className="indexSchemaImpactCounts">
        <span className="indexSchemaImpactPill indexSchemaImpactPill--rebuild">{t('errors')}: {issueCounts.error}</span>
        <span className="indexSchemaImpactPill indexSchemaImpactPill--review">{t('warnings')}: {issueCounts.warning}</span>
        <span className="indexSchemaImpactPill indexSchemaImpactPill--safe">{t('infos')}: {issueCounts.info}</span>
      </div>
      {unsavedResources.length > 0 && (
        <div className="notice notice--warning">
          {language === 'ja' ? `未保存: ${unsavedResources.join(', ')}` : `Unsaved: ${unsavedResources.join(', ')}`}
        </div>
      )}
      <div className="ipbIssueList">
        {validationIssues.map((issue) => (
          <button key={issue.id} type="button" className={issueClass(issue)} onClick={() => setTab(issue.resource === 'pipeline' ? 'overview' : issue.resource === 'dataSource' ? 'source' : issue.resource === 'index' ? 'index' : 'indexer')}>
            <span className="ipbIssue__severity">{issue.severity}</span>
            <span className="ipbIssue__resource">{issue.resource}</span>
            <span className="ipbIssue__message">{issue.message}</span>
          </button>
        ))}
      </div>
    </aside>
  )

  const renderNoPipelineState = () => (
    <section className="ipbReferencePanel">
      <div className="ipbPanelHeader__title">{t('noPipelineLoadedTitle')}</div>
      <div className="actions actions--mt10">
        <button type="button" className="btn btn--primary" onClick={createNewDraft}>
          <i className="bi bi-plus-lg icon--mr6"></i>
          {t('newDraft')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void loadPipelineFromIndexer(selectedIndexerName)}
          disabled={!canQuery || loadingPipeline || !selectedIndexerName.trim()}
        >
          <i className="bi bi-box-arrow-in-down icon--mr6"></i>
          {loadingPipeline ? `${t('loading')}...` : t('loadSelected')}
        </button>
      </div>
    </section>
  )

  return (
    <div className="pane__centerContent ipb">
      <div className="section ipb__section">
        <div className="ipbToolbar">
          <div className="ipbToolbar__titleBlock">
            <div className="section__title">
              <i className="bi bi-diagram-3 icon--mr6"></i>
              {globalT('indexingPipelineBuilder')}
            </div>
            <div className="section__hint">{t('subtitle')}</div>
          </div>
          <div className="ipbToolbar__actions">
            <button type="button" className="btn" onClick={createNewDraft}>
              <i className="bi bi-plus-lg icon--mr6"></i>
              {t('newDraft')}
            </button>
            <button type="button" className="btn" onClick={saveDraft} disabled={!hasPipelineDraft}>
              <i className="bi bi-save icon--mr6"></i>
              {t('saveDraft')}
            </button>
            <button type="button" className="btn" onClick={saveDraftAs} disabled={!hasPipelineDraft}>
              <i className="bi bi-save2 icon--mr6"></i>
              {t('saveDraftAs')}
            </button>
            <button
              type="button"
              className={'btn ' + (localDraftLibraryOpen ? 'btn--active' : '')}
              onClick={() => setLocalDraftLibraryOpen((open) => !open)}
            >
              <i className="bi bi-folder2-open icon--mr6"></i>
              {t('savedDrafts')} ({savedDrafts.length})
            </button>
            <button type="button" className="btn" onClick={copyActiveJson} disabled={!hasPipelineDraft || activeTab !== 'rawJson'}>
              <i className="bi bi-clipboard icon--mr6"></i>
              {t('copyJson')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={clearPipeline}
              disabled={loadingPipeline || resetLoading || runLoading || statusLoading || verifyLoading || publishReviewLoading}
            >
              <i className="bi bi-eraser icon--mr6"></i>
              {t('clear')}
            </button>
          </div>
        </div>

        {!canQuery && <div className="notice notice--error builder__notice">{t('missingConnection')}</div>}
        {message && <div className={`notice notice--${message.type} builder__notice`}>{message.text}</div>}
        {renderLocalDraftLibrary()}

        {renderResourceHub()}
        {renderLoadedIndexerBar()}

        {hasPipelineDraft ? <div className="ipbStudioLayout">
          <main className="ipbWorkbench">
            <div className="ipbPrimaryNav" role="tablist" aria-label={globalT('indexingPipelineBuilder')}>
              <div className="ipbPrimaryNav__pipeline">
                {renderPipelineStrip()}
                <div className="ipbPrimaryNav__hint"><i className="bi bi-info-circle icon--mr6"></i>{t('nodeNavHint')}</div>
              </div>
              <div className="ipbPrimaryNav__aux">
                {auxNavItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === item.id}
                    className={'btn btn--tab ipbAuxTab ' + (activeTab === item.id ? 'btn--active' : '')}
                    data-guide-target={auxNavGuideTargets[item.id]}
                    onClick={() => setTab(item.id)}
                  >
                    <i className={`bi ${item.icon} icon--mr6`}></i>
                    {t(item.labelKey)}
                  </button>
                ))}
                <div className="ipbAuxRunActions">
                  <button type="button" className="btn ipbAuxRunButton" data-guide-target="ipb-reset-indexer" onClick={startIndexerReset} disabled={!hasPipelineDraft || !canQuery || resetLoading || runLoading || statusLoading || publishReviewLoading || !activeIndexerName.trim()}>
                    <i className="bi bi-arrow-counterclockwise icon--mr6"></i>
                    {resetLoading ? `${t('loading')}...` : t('resetIndexer')}
                  </button>
                  <button type="button" className="btn ipbAuxRunButton" data-guide-target="ipb-run-indexer" onClick={startIndexerRun} disabled={!hasPipelineDraft || !canQuery || resetLoading || runLoading || statusLoading || publishReviewLoading || !activeIndexerName.trim()}>
                    <i className="bi bi-play-circle icon--mr6"></i>
                    {runLoading ? `${t('loading')}...` : t('runIndexer')}
                  </button>
                  <button type="button" className="btn btn--primary ipbAuxRunButton" data-guide-target="ipb-publish-run" onClick={openUpdateRunReview} disabled={!hasPipelineDraft || !canQuery || resetLoading || runLoading || statusLoading || verifyLoading || publishReviewLoading}>
                    <i className="bi bi-play-fill icon--mr6"></i>
                    {publishReviewLoading ? t('updateReviewLoading') : runLoading ? `${t('loading')}...` : t('updateRunPipeline')}
                  </button>
                </div>
              </div>
            </div>

            <div className="ipbTabPanel">
              {activeTab === 'overview' && renderOverview()}
              {activeTab === 'source' && renderDataSourceDesigner()}
              {activeTab === 'index' && renderIndexDesigner()}
              {activeTab === 'indexer' && renderIndexerDesigner()}
              {activeTab === 'rawJson' && renderRawJson()}
            </div>
          </main>
          {renderChecks()}
        </div> : renderNoPipelineState()}
        <IndexingPipelinePublishModal
          open={publishReviewOpen}
          language={language}
          theme={theme}
          resources={pendingUpdateResources}
          activeKind={publishReviewActiveKind}
          diffViewMode={publishReviewDiffViewMode}
          updateLoading={runLoading}
          copyToClipboard={copyToClipboard}
          onActiveKindChange={setPublishReviewActiveKind}
          onDiffViewModeChange={setPublishReviewDiffViewMode}
          onConfirmUpdateRun={() => { void executeUpdateAndRunPipeline() }}
          onClose={() => setPublishReviewOpen(false)}
        />
      </div>
    </div>
  )
}
