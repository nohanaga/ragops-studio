import type { Language } from './translations'

export type DataSourceDescriptor = {
  type: string
  aliases?: string[]
  labelJa: string
  labelEn: string
  family: 'storage' | 'database' | 'saas'
  connectionShape: string
  containerShape: string
  notesJa: string
  notesEn: string
  preview?: boolean
}

export type IndexerSchemaField = {
  name: string
  valueType: string
  appliesTo: string[]
  notesJa: string
  notesEn: string
  preview?: boolean
}

export const SUPPORTED_DATA_SOURCE_DESCRIPTORS: DataSourceDescriptor[] = [
  {
    type: 'azureblob',
    labelJa: 'Azure Blob Storage',
    labelEn: 'Azure Blob Storage',
    family: 'storage',
    connectionShape: 'credentials.connectionString or managed identity connection metadata',
    containerShape: 'container.name, optional container.query for virtual folders',
    notesJa: 'Blob/ADLS互換のコンテンツをクロールします。metadata_storage_* フィールド、画像抽出、JSON/CSV解析と組み合わせる前提です。',
    notesEn: 'Crawls blob-style content. Commonly combined with metadata_storage_* fields, image extraction, and JSON/CSV parsing.',
  },
  {
    type: 'adlsgen2',
    labelJa: 'Azure Data Lake Storage Gen2',
    labelEn: 'Azure Data Lake Storage Gen2',
    family: 'storage',
    connectionShape: 'credentials.connectionString or managed identity connection metadata',
    containerShape: 'container.name, optional container.query for folder scope',
    notesJa: '階層 namespace を持つ Data Lake のファイルを対象にします。Blob系の解析パラメータを共有します。',
    notesEn: 'Targets files in Data Lake accounts with hierarchical namespace. Shares most blob parsing parameters.',
  },
  {
    type: 'onelake',
    labelJa: 'Microsoft OneLake',
    labelEn: 'Microsoft OneLake',
    family: 'storage',
    connectionShape: 'workspace/lakehouse endpoint and identity-based access metadata',
    containerShape: 'container.name and path-like query/scope values',
    notesJa: 'Microsoft Fabric OneLake 用のデータソースです。API version により preview 扱いのため、未知プロパティは保持します。',
    notesEn: 'Data source for Microsoft Fabric OneLake. Preview surface can evolve by API version, so unknown properties are preserved.',
    preview: true,
  },
  {
    type: 'azuretable',
    labelJa: 'Azure Table Storage',
    labelEn: 'Azure Table Storage',
    family: 'storage',
    connectionShape: 'credentials.connectionString or managed identity connection metadata',
    containerShape: 'container.name, optional container.query for table filters',
    notesJa: 'Table Storage のエンティティを index document として取り込みます。PartitionKey/RowKeyの扱いに注意します。',
    notesEn: 'Ingests Table Storage entities as index documents. PartitionKey/RowKey handling is usually important.',
  },
  {
    type: 'azurefile',
    aliases: ['azurefiles'],
    labelJa: 'Azure Files',
    labelEn: 'Azure Files',
    family: 'storage',
    connectionShape: 'credentials.connectionString or managed identity connection metadata',
    containerShape: 'container.name for file share, optional query/path scope',
    notesJa: 'Azure Files の共有をクロールします。API/documentation 世代により azurefile / azurefiles の表記差があります。',
    notesEn: 'Crawls Azure Files shares. Some API/documentation generations use azurefile while others use azurefiles.',
    preview: true,
  },
  {
    type: 'azuresql',
    labelJa: 'Azure SQL / SQL Server',
    labelEn: 'Azure SQL / SQL Server',
    family: 'database',
    connectionShape: 'credentials.connectionString or managed identity SQL connection metadata',
    containerShape: 'container.name for table or view, optional query for custom SQL',
    notesJa: 'SQL table/view/query を取り込みます。変更検出・削除検出 policy と queryTimeout を組み合わせます。',
    notesEn: 'Ingests SQL tables/views/queries. Often combined with change detection, deletion detection, and queryTimeout.',
  },
  {
    type: 'cosmosdb',
    labelJa: 'Azure Cosmos DB',
    labelEn: 'Azure Cosmos DB',
    family: 'database',
    connectionShape: 'credentials.connectionString or managed identity Cosmos connection metadata',
    containerShape: 'container.name, optional container.query for SQL API query',
    notesJa: 'Cosmos DB のコンテナーを取り込みます。高水位マーク、クエリ、パーティション設計の影響を受けます。',
    notesEn: 'Ingests Cosmos DB containers. High-water marks, query shape, and partitioning affect behavior.',
  },
  {
    type: 'mysql',
    labelJa: 'Azure Database for MySQL',
    labelEn: 'Azure Database for MySQL',
    family: 'database',
    connectionShape: 'credentials.connectionString for MySQL-compatible source',
    containerShape: 'container.name for table or view, optional query',
    notesJa: 'MySQL 系データソースです。SQL系と同様に queryTimeout や変更検出設計を確認します。',
    notesEn: 'MySQL-compatible data source. Validate queryTimeout and change-detection design as with other SQL sources.',
    preview: true,
  },
  {
    type: 'sharepoint',
    labelJa: 'SharePoint Online',
    labelEn: 'SharePoint Online',
    family: 'saas',
    connectionShape: 'siteUrl/tenant and identity-based access metadata',
    containerShape: 'site/library/list scope depending on API version',
    notesJa: 'SharePoint コンテンツを取り込みます。認可、ACL、ファイル解析、拡張子 filter の確認が重要です。',
    notesEn: 'Ingests SharePoint content. Authorization, ACLs, parsing, and extension filters are critical.',
    preview: true,
  },
]

export const DATA_SOURCE_TYPE_ALIASES_BY_API_VERSION: Record<string, Record<string, string>> = {
  default: {
    azurefiles: 'azurefile',
  },
  '2026-04-01': {
    azurefiles: 'azurefile',
  },
}

export const INDEXER_TOP_LEVEL_FIELDS: IndexerSchemaField[] = [
  { name: 'name', valueType: 'string', appliesTo: ['all'], notesJa: 'Indexer 名。URL path と body の name を一致させます。', notesEn: 'Indexer name. Keep URL path and body name aligned.' },
  { name: 'description', valueType: 'string', appliesTo: ['all'], notesJa: '任意説明。運用メモとして残します。', notesEn: 'Optional description for operational notes.' },
  { name: 'dataSourceName', valueType: 'string', appliesTo: ['all'], notesJa: '参照する Data Source 名。', notesEn: 'Name of the referenced data source.' },
  { name: 'targetIndexName', valueType: 'string', appliesTo: ['all'], notesJa: '投入先 Index 名。', notesEn: 'Target index name.' },
  { name: 'skillsetName', valueType: 'string', appliesTo: ['enrichment'], notesJa: '任意の Skillset 名。AI enrichment を使う場合に設定します。', notesEn: 'Optional skillset name for AI enrichment.' },
  { name: 'disabled', valueType: 'boolean', appliesTo: ['all'], notesJa: 'Indexer の無効化フラグ。', notesEn: 'Disables indexer execution when true.' },
  { name: 'schedule', valueType: 'object', appliesTo: ['all'], notesJa: 'interval / startTime による定期実行設定。', notesEn: 'Recurring schedule with interval and startTime.' },
  { name: 'parameters', valueType: 'object', appliesTo: ['all'], notesJa: 'batchSize, failure tolerance, configuration を含む実行設定。', notesEn: 'Execution settings including batchSize, failure tolerance, and configuration.' },
  { name: 'fieldMappings', valueType: 'array', appliesTo: ['all'], notesJa: 'ソース field から index field への明示 mapping。', notesEn: 'Explicit source-field to index-field mappings.' },
  { name: 'outputFieldMappings', valueType: 'array', appliesTo: ['enrichment'], notesJa: 'enrichment output から index field への mapping。', notesEn: 'Mappings from enrichment outputs to index fields.' },
  { name: 'cache', valueType: 'object', appliesTo: ['enrichment'], notesJa: 'Incremental enrichment cache の設定。', notesEn: 'Incremental enrichment cache settings.' },
  { name: 'encryptionKey', valueType: 'object', appliesTo: ['all'], notesJa: 'Customer-managed key 設定。', notesEn: 'Customer-managed key settings.' },
  { name: '@odata.etag', valueType: 'string', appliesTo: ['service-read'], notesJa: 'Service が返す ETag。保存時はそのまま保持できます。', notesEn: 'Service-returned ETag. It can be preserved in drafts.' },
]

export const INDEXER_PARAMETER_FIELDS: IndexerSchemaField[] = [
  { name: 'batchSize', valueType: 'number', appliesTo: ['all'], notesJa: '1 batch あたりの document 数。データソースや payload サイズで調整します。', notesEn: 'Documents per batch. Tune by data source and payload size.' },
  { name: 'maxFailedItems', valueType: 'number', appliesTo: ['all'], notesJa: 'Indexer 全体で許容する失敗 item 数。-1 は制限なしとして扱われます。', notesEn: 'Total failed item tolerance. -1 is treated as unlimited.' },
  { name: 'maxFailedItemsPerBatch', valueType: 'number', appliesTo: ['all'], notesJa: '1 batch 内で許容する失敗 item 数。', notesEn: 'Failed item tolerance per batch.' },
  { name: 'base64EncodeKeys', valueType: 'boolean', appliesTo: ['all'], notesJa: 'Key を URL safe base64 に encode します。', notesEn: 'Encodes keys as URL-safe base64.' },
  { name: 'configuration', valueType: 'object', appliesTo: ['all'], notesJa: 'Data source 固有の解析・実行パラメータ。', notesEn: 'Data-source-specific parsing and execution parameters.' },
]

export const INDEXER_CONFIGURATION_FIELDS: IndexerSchemaField[] = [
  { name: 'parsingMode', valueType: 'string', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: 'default/json/jsonArray/jsonLines/delimitedText/text などの解析 mode。', notesEn: 'Parsing mode such as default/json/jsonArray/jsonLines/delimitedText/text.' },
  { name: 'dataToExtract', valueType: 'string', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: 'contentAndMetadata / storageMetadata / allMetadata など抽出対象。', notesEn: 'Extraction target such as contentAndMetadata, storageMetadata, or allMetadata.' },
  { name: 'documentRoot', valueType: 'string', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile'], notesJa: 'JSON document の root path。', notesEn: 'Root path for JSON documents.' },
  { name: 'textSplitMode', valueType: 'string', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile'], notesJa: '大きな text blob の分割 mode。', notesEn: 'Splitting mode for large text blobs.' },
  { name: 'delimitedTextHeaders', valueType: 'string', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile'], notesJa: 'CSV/TSV など delimitedText の header 名一覧。', notesEn: 'Header names for delimitedText sources such as CSV/TSV.' },
  { name: 'delimitedTextDelimiter', valueType: 'string', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile'], notesJa: 'delimitedText の区切り文字。', notesEn: 'Delimiter for delimitedText parsing.' },
  { name: 'firstLineContainsHeaders', valueType: 'boolean', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile'], notesJa: '先頭行を header として扱うか。', notesEn: 'Whether the first line contains headers.' },
  { name: 'indexedFileNameExtensions', valueType: 'string', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: 'index 対象に含める拡張子。カンマ区切り。', notesEn: 'Comma-separated extensions to include.' },
  { name: 'excludedFileNameExtensions', valueType: 'string', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: 'index 対象から除外する拡張子。カンマ区切り。', notesEn: 'Comma-separated extensions to exclude.' },
  { name: 'failOnUnsupportedContentType', valueType: 'boolean', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: '未対応 content type で失敗扱いにするか。', notesEn: 'Whether unsupported content types fail the run.' },
  { name: 'failOnUnprocessableDocument', valueType: 'boolean', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: '解析不能 document で失敗扱いにするか。', notesEn: 'Whether unprocessable documents fail the run.' },
  { name: 'indexStorageMetadataOnlyForOversizedDocuments', valueType: 'boolean', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: 'サイズ超過 document は storage metadata のみ登録するか。', notesEn: 'Whether oversized documents should index storage metadata only.' },
  { name: 'imageAction', valueType: 'string', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: '画像正規化/抽出動作。Skillset と組み合わせます。', notesEn: 'Image normalization/extraction behavior, usually with a skillset.' },
  { name: 'normalizedImageMaxWidth', valueType: 'number', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: '正規化画像の最大幅。', notesEn: 'Maximum width for normalized images.' },
  { name: 'normalizedImageMaxHeight', valueType: 'number', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: '正規化画像の最大高さ。', notesEn: 'Maximum height for normalized images.' },
  { name: 'allowSkillsetToReadFileData', valueType: 'boolean', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: 'Skillset が /document/file_data を読めるようにします。', notesEn: 'Allows the skillset to read /document/file_data.' },
  { name: 'pdfTextRotationAlgorithm', valueType: 'string', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: 'PDF text rotation の処理 algorithm。', notesEn: 'Algorithm for PDF text rotation handling.' },
  { name: 'executionEnvironment', valueType: 'string', appliesTo: ['all'], notesJa: 'standard/private など Indexer 実行環境。', notesEn: 'Indexer execution environment, such as standard/private.' },
  { name: 'queryTimeout', valueType: 'string', appliesTo: ['azuresql', 'cosmosdb', 'mysql'], notesJa: 'DB query timeout。', notesEn: 'Database query timeout.' },
  { name: 'convertHighWaterMarkToRowVersion', valueType: 'boolean', appliesTo: ['azuresql'], notesJa: 'SQL rowversion を high-water mark に変換します。', notesEn: 'Converts SQL rowversion to high-water mark values.' },
  { name: 'assumeOrderByHighWaterMarkColumn', valueType: 'boolean', appliesTo: ['cosmosdb'], notesJa: 'Cosmos DB の high-water mark column による ORDER BY 前提を制御します。', notesEn: 'Controls Cosmos DB ORDER BY high-water-mark assumptions.' },
  { name: 'additionalColumns', valueType: 'string', appliesTo: ['sharepoint'], notesJa: 'SharePoint から追加で取得する列。', notesEn: 'Additional SharePoint columns to retrieve.' },
  { name: 'disableImageVerbalization', valueType: 'boolean', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: '画像 verbalization preview 機能を無効化します。', notesEn: 'Disables preview image verbalization behavior.' , preview: true },
  { name: 'imageVerbalizationDescription', valueType: 'string', appliesTo: ['azureblob', 'adlsgen2', 'onelake', 'azurefile', 'sharepoint'], notesJa: '画像 verbalization の説明文や指示。', notesEn: 'Description/instructions for image verbalization.' , preview: true },
]

const parameterDocs: Record<string, { ja: string; en: string }> = {
  'dataSource.name': {
    ja: '必須。データソース定義の名前です。データソースはインデクサーが取り込み対象のデータ、資格情報、変更検出ポリシーを参照するための独立したリソースです。',
    en: 'Required. The data source name. A data source is an independent resource that an indexer uses to reference data to index, credentials, and policies for identifying changes.',
  },
  'credentials.connectionString': {
    ja: '必須。データソースへの接続情報です。Blob Storage ではストレージ接続文字列、Managed Identity 形式、または SAS 形式の接続文字列を指定できます。',
    en: 'Required. Connection information for the data source. For Blob Storage, this can be a storage connection string, a managed identity connection string, or a SAS-based connection string.',
  },
  'container.name': {
    ja: '必須。データソースの物理スコープです。Blob Storage では Blob コンテナー、SQL ではテーブルまたはビューなど、取り込み対象の名前を指定します。',
    en: 'Required. The physical scope of the data source. For Blob Storage, this is the blob container; for SQL, it is commonly a table or view.',
  },
  'container.query': {
    ja: 'データソース内の範囲を絞り込む追加指定です。Blob Storage では仮想フォルダー、SharePoint ではライブラリや追加列などのソース固有クエリを指定できます。',
    en: 'An additional source-specific scope. For Blob Storage, this can be a virtual folder; for SharePoint, it can include library scope and extra column settings.',
  },
  'index.name': {
    ja: '必須。検索インデックスの名前です。インデクサーの targetIndexName が、このインデックスを参照します。',
    en: 'Required. The search index name. The indexer targetIndexName points to this index.',
  },
  name: {
    ja: '必須。インデクサーの名前です。インデクサー コレクション内で一意である必要があります。',
    en: 'Required. The indexer name. It must be unique within the indexer collection.',
  },
  description: {
    ja: 'インデクサーの説明です。運用上のメモや用途を記録できます。',
    en: 'The indexer description. Use it for operational notes or purpose.',
  },
  dataSourceName: {
    ja: '必須。このインデクサーが読み取るデータソースの名前です。',
    en: 'Required. The name of the data source from which this indexer reads data.',
  },
  targetIndexName: {
    ja: '必須。このインデクサーが書き込む検索インデックスの名前です。',
    en: 'Required. The name of the search index to which this indexer writes data.',
  },
  skillsetName: {
    ja: 'このインデクサーと一緒に実行するスキルセットの名前です。AI enrichment を使う場合に指定します。',
    en: 'The name of the skillset executing with this indexer. Set it when the indexer uses AI enrichment.',
  },
  disabled: {
    ja: 'インデクサーを無効化するかどうかを示します。既定値は false です。',
    en: 'A value indicating whether the indexer is disabled. Default is false.',
  },
  'schedule.interval': {
    ja: 'インデクサー実行間隔です。スケジュールは定期実行を表し、interval と startTime を持ちます。',
    en: 'The interval of time between indexer executions. A schedule represents recurring indexer execution and includes interval and startTime.',
  },
  fieldMappings: {
    ja: 'データソース内のフィールドと、インデックス内の対応するターゲット フィールドの間のマッピングを定義します。',
    en: 'Defines mappings between fields in the data source and corresponding target fields in the index.',
  },
  outputFieldMappings: {
    ja: 'エンリッチメントの後、インデックス作成の直前に適用される出力フィールド マッピングです。',
    en: 'Output field mappings are applied after enrichment and immediately before indexing.',
  },
  sourceFieldName: {
    ja: '必須。データソース内のフィールド名です。フィールドマッピングで参照する入力側のフィールドを指定します。',
    en: 'Required. The name of the field in the data source used as the source side of a field mapping.',
  },
  targetFieldName: {
    ja: 'インデックス内のターゲット フィールド名です。既定値は sourceFieldName と同じ名前です。',
    en: 'The name of the target field in the index. The default is the same as sourceFieldName.',
  },
  mappingFunction: {
    ja: 'インデックス作成前にソース フィールド値へ適用する変換関数です。',
    en: 'A function to apply to each source field value before indexing.',
  },
  batchSize: {
    ja: 'パフォーマンス向上のため、データソースから読み取りインデックスへ投入する項目数を 1 バッチ単位で指定します。既定値はデータソースの種類に依存します。Azure SQL Database と Azure Cosmos DB は 1000、Azure Blob Storage と SharePoint は 10 です。',
    en: 'Specifies the number of items read from the data source and indexed as a single batch to improve performance. The default depends on the data source type: 1000 for Azure SQL Database and Azure Cosmos DB, and 10 for Azure Blob Storage and SharePoint.',
  },
  maxFailedItems: {
    ja: 'インデクサー実行を成功扱いにできる失敗項目数の上限です。-1 は制限なし、既定値は 0 です。',
    en: 'The maximum number of items that can fail indexing for indexer execution to still be considered successful. -1 means no limit. Default is 0.',
  },
  maxFailedItemsPerBatch: {
    ja: '1 バッチ内で、バッチを成功扱いにできる失敗項目数の上限です。-1 は制限なし、既定値は 0 です。',
    en: 'The maximum number of items in a single batch that can fail indexing for the batch to still be considered successful. -1 means no limit. Default is 0.',
  },
  base64EncodeKeys: {
    ja: 'ドキュメント キー値を URL-safe base64 で自動エンコードするかを制御します。既定値は true です。false の場合、インデクサーはキー値を自動的に base64 エンコードしません。',
    en: 'Controls whether document key values are automatically encoded as URL-safe base64. The default is true. When set to false, the indexer does not automatically base64 encode document key values.',
  },
  configuration: {
    ja: 'インデクサー固有の configuration プロパティの辞書です。各名前は固有プロパティ名で、値はプリミティブ型である必要があります。',
    en: 'A dictionary of indexer-specific configuration properties. Each name is a specific property and each value must be a primitive type.',
  },
  parsingMode: {
    ja: 'Blob データソースの解析モードです。既定値は default です。default、text、delimitedText、json、jsonArray、jsonLines を使用して、Blob を検索ドキュメントへ変換する粒度を制御します。',
    en: 'Represents the parsing mode for a blob data source. The default is default. Values such as default, text, delimitedText, json, jsonArray, and jsonLines control how blobs become search documents.',
  },
  dataToExtract: {
    ja: 'Azure Blob Storage から抽出するデータを指定します。既定値は contentAndMetadata です。imageAction が none 以外の場合は、画像コンテンツから抽出するデータも制御します。',
    en: 'Specifies the data to extract from Azure Blob Storage. The default is contentAndMetadata. When imageAction is not none, it also tells the indexer which data to extract from image content.',
  },
  documentRoot: {
    ja: 'JSON 配列を対象にする場合、構造化または半構造化ドキュメント内で配列へのパスを指定します。',
    en: 'For JSON arrays, specifies the path to the array within a structured or semi-structured document.',
  },
  textSplitMode: {
    ja: '現在の REST API の IndexingParametersConfiguration 一覧では、テキストの粒度制御は主に parsingMode と AI エンリッチメントの Text Split スキルとして説明されています。利用前に対象 API バージョンの対応状況を確認してください。',
    en: 'Current REST API docs describe text granularity mainly through parsingMode and the Text Split skill in AI enrichment. Verify support for this advanced setting against your target API version before use.',
  },
  delimitedTextHeaders: {
    ja: 'CSV Blob の列ヘッダーをカンマ区切りで指定します。インデックス内の宛先フィールドへのマッピングに使用できます。',
    en: 'For CSV blobs, specifies a comma-delimited list of column headers, useful for mapping source fields to destination fields in an index.',
  },
  delimitedTextDelimiter: {
    ja: 'CSV Blob で、各行が新しいドキュメントを開始する場合の単一文字区切りを指定します。',
    en: 'For CSV blobs, specifies the single-character delimiter where each line starts a new document.',
  },
  firstLineContainsHeaders: {
    ja: 'CSV Blob の最初の空でない行にヘッダーが含まれるかどうかを示します。既定値は true です。',
    en: 'For CSV blobs, indicates whether the first non-blank line contains headers. Default is true.',
  },
  indexedFileNameExtensions: {
    ja: 'Azure Blob Storage から処理するファイル拡張子をカンマ区切りで指定します。例: .docx, .pptx, .msg。',
    en: 'A comma-delimited list of filename extensions to select when processing from Azure Blob Storage, such as .docx, .pptx, .msg.',
  },
  excludedFileNameExtensions: {
    ja: 'Azure Blob Storage から処理するときに無視するファイル拡張子をカンマ区切りで指定します。例: .png, .mp4。',
    en: 'A comma-delimited list of filename extensions to ignore when processing from Azure Blob Storage, such as .png, .mp4.',
  },
  failOnUnsupportedContentType: {
    ja: '未対応のコンテンツタイプが検出されたときに続行するか失敗させるかを制御します。false にすると処理を継続できます。',
    en: 'Controls whether indexing continues when an unsupported content type is encountered. Set to false if you want to continue indexing.',
  },
  failOnUnprocessableDocument: {
    ja: '処理不能なドキュメントがあった場合に続行するか失敗させるかを制御します。false にすると処理を継続できます。',
    en: 'Controls whether indexing continues when a document cannot be processed. Set to false if you want to continue indexing.',
  },
  indexStorageMetadataOnlyForOversizedDocuments: {
    ja: 'サイズ超過 Blob は既定でエラー扱いです。true にすると、コンテンツを処理できない場合でもストレージ メタデータのインデックス作成を試みます。',
    en: 'Oversized blobs are treated as errors by default. Set to true to still index storage metadata when content cannot be processed.',
  },
  imageAction: {
    ja: 'Blob 内の埋め込み画像や画像ファイルの処理方法を決めます。既定値は none です。none 以外を指定する場合は、インデクサーにスキルセットを関連付ける必要があります。',
    en: 'Determines how to process embedded images and image files in Blob Storage. The default is none. Any value other than none requires a skillset attached to the indexer.',
  },
  normalizedImageMaxWidth: {
    ja: 'imageAction が設定されている場合に生成される正規化画像の最大幅をピクセル単位で指定します。既定値は 2000、最小値は 50、最大値は 10000 です。',
    en: 'Maximum width in pixels for normalized images generated when imageAction is set. The default is 2000, the minimum is 50, and the maximum is 10000.',
  },
  normalizedImageMaxHeight: {
    ja: 'imageAction が設定されている場合に生成される正規化画像の最大高さをピクセル単位で指定します。既定値は 2000、最小値は 50、最大値は 10000 です。',
    en: 'Maximum height in pixels for normalized images generated when imageAction is set. The default is 2000, the minimum is 50, and the maximum is 10000.',
  },
  allowSkillsetToReadFileData: {
    ja: '既定値は false です。true の場合、元ファイル データを表す /document/file_data パスを作成し、カスタム スキルや Document Extraction スキルに渡せるようにします。',
    en: 'The default is false. If true, creates a /document/file_data path representing the original file data so it can be passed to a custom skill or the Document Extraction skill.',
  },
  pdfTextRotationAlgorithm: {
    ja: 'PDF のテキスト抽出アルゴリズムです。既定値は none です。detectAngles は回転した埋め込みテキストの抽出品質を改善する場合がありますが、少しパフォーマンスに影響することがあります。',
    en: 'Determines the algorithm for text extraction from PDF files. The default is none. detectAngles may improve extraction for rotated embedded text, with a small performance impact.',
  },
  executionEnvironment: {
    ja: 'インデクサーの実行環境を指定します。standard は推奨既定値、private は shared private link 経由で安全にリソースへアクセスする必要がある場合に使用します。',
    en: 'Specifies the environment in which the indexer executes. standard is the recommended default; private is for accessing resources securely over shared private links.',
  },
  queryTimeout: {
    ja: 'Azure SQL Database データソースで、既定の 5 分を超えるクエリ タイムアウトを hh:mm:ss 形式で指定します。',
    en: 'For Azure SQL Database data sources, increases the query timeout beyond the 5-minute default, specified as hh:mm:ss.',
  },
  convertHighWaterMarkToRowVersion: {
    ja: 'SQL の High Water Mark 列に rowversion 型を使う場合に true にします。インデクサーは実行前に rowversion 値から 1 を引き、重複 rowversion を持つ行の取りこぼしを避けます。',
    en: 'Set to true to use the rowversion type for a SQL high-water mark column. The indexer subtracts one from the rowversion value before running to avoid missing rows with duplicate rowversion values.',
  },
  assumeOrderByHighWaterMarkColumn: {
    ja: 'Cosmos DB インデクサーで、インデックス作成用クエリが _ts 列で ORDER BY されていることを Cosmos DB へ示すヒントです。増分インデックス作成の結果を改善します。',
    en: 'For Cosmos DB indexers, hints that the query used for indexing is ordered by the _ts column. This improves results for incremental indexing scenarios.',
  },
  additionalColumns: {
    ja: 'SharePoint ドキュメント ライブラリから追加でインデックス作成する列です。値は列名のカンマ区切りリストです。',
    en: 'For SharePoint document libraries, a comma-separated list of additional column names to index.',
  },
  disableImageVerbalization: {
    ja: '画像の言語化を無効化するかどうかを示します。既定値は false で、画像の言語化は有効です。true にすると無効化します。',
    en: 'Indicates whether image verbalization should be disabled. The default is false, which enables image verbalization; set true to disable it.',
  },
  imageVerbalizationDescription: {
    ja: '現行の REST インデクサー構成一覧には、このプレビュー パラメーターの個別説明は掲載されていません。画像の言語化は GenAI Prompt スキルによる画像説明生成として説明されています。対象 API バージョンを確認してください。',
    en: 'Current REST indexer configuration docs do not list an individual description for this preview parameter. Image verbalization is documented as image description generation through the GenAI Prompt skill. Verify support for your target API version.',
  },
}

const requiredParameterNames = new Set([
  'dataSource.name',
  'credentials.connectionString',
  'container.name',
  'index.name',
  'name',
  'dataSourceName',
  'targetIndexName',
  'sourceFieldName',
])

export function isRequiredSchemaParameter(name: string): boolean {
  return requiredParameterNames.has(name)
}

export function schemaParameterDocs(name: string, language: Language, fallback = ''): string {
  const docs = parameterDocs[name]
  if (docs) return language === 'ja' ? docs.ja : docs.en
  return fallback
}

export function getCanonicalDataSourceType(type: string): string {
  const raw = type.trim().toLowerCase()
  if (!raw) return ''
  const explicit = DATA_SOURCE_TYPE_ALIASES_BY_API_VERSION.default[raw]
  return explicit ?? raw
}

export function findDataSourceDescriptor(type: string): DataSourceDescriptor | null {
  const canonical = getCanonicalDataSourceType(type)
  return SUPPORTED_DATA_SOURCE_DESCRIPTORS.find((descriptor) => {
    if (descriptor.type === canonical) return true
    return descriptor.aliases?.some((alias) => getCanonicalDataSourceType(alias) === canonical) ?? false
  }) ?? null
}

export function dataSourceLabel(descriptor: DataSourceDescriptor, language: Language): string {
  return language === 'ja' ? descriptor.labelJa : descriptor.labelEn
}

export function schemaFieldNotes(field: IndexerSchemaField, language: Language): string {
  return language === 'ja' ? field.notesJa : field.notesEn
}
