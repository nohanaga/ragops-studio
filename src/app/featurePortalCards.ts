/**
 * Feature Portal card definitions and guide data.
 *
 * Extracted into its own module so the guide drawer can render
 * at the AppLayout level (outside the Portal tab) and persist after
 * the user launches a feature.
 */

export type CardCategory = 'search' | 'builder' | 'optimization' | 'devtool' | 'experiment' | 'azure'

export type GuideStep = {
  icon: string
  titleJa: string
  titleEn: string
  descJa: string
  descEn: string
  /**
   * Optional CSS selector (e.g. `[data-guide-target="search-query"]`) that
   * identifies the UI element to highlight while this step is active in
   * companion mode. Unresolved selectors gracefully degrade (no highlight).
   */
  targetSelector?: string
}

export type FeatureGuide = {
  stepsJa: string
  stepsEn: string
  steps: GuideStep[]
  tipsJa?: string[]
  tipsEn?: string[]
  docsUrl?: string
}

export type PortalCard = {
  id: string
  icon: string
  isEmoji?: boolean
  category: CardCategory
  titleJa: string
  titleEn: string
  descJa: string
  descEn: string
  action?: string
  disabled?: boolean
  guide?: FeatureGuide
}

export const CATEGORY_ORDER: CardCategory[] = [
  'search',
  'builder',
  'optimization',
  'devtool',
  'experiment',
  'azure',
]

export const CATEGORY_META: Record<CardCategory, { labelJa: string; labelEn: string; iconClass: string }> = {
  search: { labelJa: '検索モード', labelEn: 'Search Modes', iconClass: 'bi-search' },
  builder: { labelJa: 'ビルダーツール', labelEn: 'Builder Tools', iconClass: 'bi-tools' },
  optimization: { labelJa: '最適化 & テスト', labelEn: 'Optimization & Testing', iconClass: 'bi-speedometer' },
  devtool: { labelJa: '開発者ツール', labelEn: 'Developer Tools', iconClass: 'bi-wrench-adjustable' },
  experiment: { labelJa: '実験管理', labelEn: 'Experiment Management', iconClass: 'bi-journal-bookmark' },
  azure: { labelJa: 'Azure AI Search 機能（未実装）', labelEn: 'Azure AI Search Features (Coming Soon)', iconClass: 'bi-cloud' },
}

export const PORTAL_CARDS: PortalCard[] = [
  // ── Search Modes ─────────────────────────────────────────────
  {
    id: 'fulltext-search',
    icon: 'search',
    category: 'search',
    titleJa: 'フルテキスト検索',
    titleEn: 'Full-Text Search',
    descJa: 'simple / full クエリ構文による全文検索。フィルター、ファセット、スコアリングプロファイルに対応。',
    descEn: 'Full-text search with simple / full query syntax. Supports filters, facets, and scoring profiles.',
    action: 'openQueryMode',
    guide: {
      stepsJa: 'フルテキスト検索の使い方',
      stepsEn: 'How to use Full-Text Search',
      steps: [
        { icon: 'plug', titleJa: '接続設定', titleEn: 'Configure Connection', descJa: '画面上部の接続セクションで Azure AI Search のエンドポイントと API キーを入力します。', descEn: 'Enter your Azure AI Search endpoint and API key in the connection section at the top.', targetSelector: '[data-guide-target="connection-section"]' },
        { icon: 'list-ul', titleJa: 'インデックス選択', titleEn: 'Select Index', descJa: 'ドロップダウンから検索対象のインデックスを選択します。', descEn: 'Choose the target index from the dropdown.', targetSelector: '[data-guide-target="index-dropdown"]' },
        { icon: 'pencil-square', titleJa: 'クエリ入力', titleEn: 'Enter Query', descJa: 'search フィールドに検索キーワードを入力します。queryType で simple / full を選択できます。', descEn: 'Type your search keywords in the search field. Choose simple or full queryType.', targetSelector: '[data-guide-target="search-query"]' },
        { icon: 'funnel', titleJa: 'フィルター設定 (任意)', titleEn: 'Set Filters (Optional)', descJa: 'filter, orderby, select などのパラメータでクエリを絞り込みます。', descEn: 'Refine your query with filter, orderby, select, and other parameters.', targetSelector: '[data-guide-target="query-type"]' },
        { icon: 'play-circle', titleJa: '検索実行', titleEn: 'Execute Search', descJa: 'Execute ボタンを押して検索を実行します。結果は右ペインに JSON で表示されます。', descEn: 'Click Execute to run the search. Results appear as JSON in the right pane.', targetSelector: '[data-guide-target="execute-button"]' },
      ],
      tipsJa: ['queryType を full にすると Lucene 構文 (ワイルドカード、正規表現) が使えます', 'select パラメータで返却フィールドを限定するとレスポンスが軽量になります'],
      tipsEn: ['Set queryType to full to use Lucene syntax (wildcards, regex)', 'Use the select parameter to limit returned fields for lighter responses'],
      docsUrl: 'https://learn.microsoft.com/azure/search/search-query-overview',
    },
  },
  {
    id: 'semantic-search',
    icon: 'stars',
    category: 'search',
    titleJa: 'セマンティック検索',
    titleEn: 'Semantic Search',
    descJa: 'Bing 由来の深層学習モデルによるセマンティックランキング。キャプションとアンサーの生成。',
    descEn: 'Semantic ranking with deep learning models from Bing. Generates captions and answers.',
    action: 'openSemanticVectorMode',
    guide: {
      stepsJa: 'セマンティック検索の使い方',
      stepsEn: 'How to use Semantic Search',
      steps: [
        { icon: 'toggles', titleJa: 'Lab Mode 切替', titleEn: 'Switch Lab Mode', descJa: 'Semantic-Vector モードを選択します（上部のモード切替）。', descEn: 'Select Semantic-Vector mode from the mode switcher at the top.', targetSelector: '[data-guide-target="lab-mode-switcher"]' },
        { icon: 'list-ul', titleJa: 'インデックス選択', titleEn: 'Select Index', descJa: 'セマンティック構成のあるインデックスを選択します。', descEn: 'Select an index that has a semantic configuration.', targetSelector: '[data-guide-target="index-dropdown"]' },
        { icon: 'pencil-square', titleJa: 'クエリ入力', titleEn: 'Enter Query', descJa: '自然言語でクエリを入力します。', descEn: 'Enter a natural language query.', targetSelector: '[data-guide-target="search-query"]' },
        { icon: 'gear', titleJa: 'セマンティック構成', titleEn: 'Semantic Configuration', descJa: 'queryType を semantic に設定し、semanticConfiguration を選択します。', descEn: 'Set queryType to semantic and select a semanticConfiguration.', targetSelector: '[data-guide-target="query-type"]' },
        { icon: 'play-circle', titleJa: '実行 & 確認', titleEn: 'Execute & Review', descJa: 'Execute を押して結果を確認します。@search.rerankerScore でセマンティックスコアを確認できます。', descEn: 'Click Execute and review results. Check @search.rerankerScore for semantic scores.', targetSelector: '[data-guide-target="execute-button"]' },
      ],
      tipsJa: ['セマンティックランカーを使うにはインデックスにセマンティック構成が必要です', 'debug パラメータを semantic に設定するとランキング根拠を確認できます'],
      tipsEn: ['Semantic ranker requires a semantic configuration on the index', 'Set debug parameter to semantic to see ranking rationale'],
      docsUrl: 'https://learn.microsoft.com/azure/search/semantic-search-overview',
    },
  },
  {
    id: 'vector-search',
    icon: 'diagram-3',
    category: 'search',
    titleJa: 'ベクトル検索',
    titleEn: 'Vector Search',
    descJa: 'テキスト / 画像のベクトルクエリ。HNSW / KNN アルゴリズム、フィルター付きベクトル検索に対応。',
    descEn: 'Vector queries for text / image. Supports HNSW / KNN algorithms with filtered vector search.',
    action: 'openSemanticVectorMode',
    guide: {
      stepsJa: 'ベクトル検索の使い方',
      stepsEn: 'How to use Vector Search',
      steps: [
        { icon: 'toggles', titleJa: 'Semantic-Vector モード', titleEn: 'Semantic-Vector Mode', descJa: 'Semantic-Vector モードに切り替えてベクトルセクションを有効にします。', descEn: 'Switch to Semantic-Vector mode to enable the vector section.', targetSelector: '[data-guide-target="lab-mode-switcher"]' },
        { icon: 'list-ul', titleJa: 'インデックス選択', titleEn: 'Select Index', descJa: 'ベクトルフィールドを持つインデックスを選択します。', descEn: 'Select an index that contains vector fields.', targetSelector: '[data-guide-target="index-dropdown"]' },
        { icon: 'input-cursor-text', titleJa: 'クエリ入力', titleEn: 'Query Input', descJa: 'テキストでクエリを入力します（統合ベクトル化）。', descEn: 'Enter a text query (integrated vectorization).', targetSelector: '[data-guide-target="search-query"]' },
        { icon: 'play-circle', titleJa: '実行', titleEn: 'Execute', descJa: 'Execute を押してベクトル検索を実行します。', descEn: 'Click Execute to run vector search.', targetSelector: '[data-guide-target="execute-button"]' },
      ],
      tipsJa: ['search フィールドにテキストも入力するとハイブリッド検索になります', 'vectorExhaustive を有効にすると正確な KNN 検索が実行されます（低速）'],
      tipsEn: ['Adding text in the search field enables hybrid search', 'Enable vectorExhaustive for exact KNN search (slower)'],
      docsUrl: 'https://learn.microsoft.com/azure/search/vector-search-overview',
    },
  },
  {
    id: 'hybrid-search',
    icon: 'intersect',
    category: 'search',
    titleJa: 'ハイブリッド検索',
    titleEn: 'Hybrid Search',
    descJa: 'テキスト検索とベクトル検索を RRF (Reciprocal Rank Fusion) で統合。maxTextRecallSize で調整可能。',
    descEn: 'Combines text and vector search using RRF (Reciprocal Rank Fusion). Tunable via maxTextRecallSize.',
    action: 'openSemanticVectorMode',
    guide: {
      stepsJa: 'ハイブリッド検索の使い方',
      stepsEn: 'How to use Hybrid Search',
      steps: [
        { icon: 'toggles', titleJa: 'モード設定', titleEn: 'Set Mode', descJa: 'Semantic-Vector モードで、search フィールドにテキスト、ベクトルセクションも有効にします。', descEn: 'In Semantic-Vector mode, enter text in search and enable the vector section.', targetSelector: '[data-guide-target="lab-mode-switcher"]' },
        { icon: 'pencil-square', titleJa: 'クエリ入力', titleEn: 'Enter Query', descJa: 'search フィールドにテキストを入力します（ベクトルと統合されます）。', descEn: 'Enter text in the search field (combined with vector query).', targetSelector: '[data-guide-target="search-query"]' },
        { icon: 'play-circle', titleJa: '実行 & 比較', titleEn: 'Execute & Compare', descJa: '実行後、@search.score (RRF 融合スコア) を確認します。All Modes で全モード同時実行も可能。', descEn: 'After execution, check @search.score (RRF fusion score). Use All Modes to run all modes at once.', targetSelector: '[data-guide-target="execute-button"]' },
      ],
      tipsJa: ['vectorWeight=0.5 が一般的な出発点です', 'All Modes 実行で text / vector / hybrid / semantic_hybrid を一括比較できます'],
      tipsEn: ['vectorWeight=0.5 is a good starting point', 'Use All Modes to compare text / vector / hybrid / semantic_hybrid at once'],
      docsUrl: 'https://learn.microsoft.com/azure/search/hybrid-search-overview',
    },
  },
  {
    id: 'agentic-retrieval',
    icon: 'robot',
    category: 'search',
    titleJa: 'Agentic Retrieval',
    titleEn: 'Agentic Retrieval',
    descJa: 'Knowledge Base / Knowledge Source を使ったエージェント型検索。アクティビティタイムライン可視化。',
    descEn: 'Agent-based retrieval using Knowledge Base / Source. Activity timeline visualization.',
    action: 'openAgenticMode',
    guide: {
      stepsJa: 'Agentic Retrieval の使い方',
      stepsEn: 'How to use Agentic Retrieval',
      steps: [
        { icon: 'toggles', titleJa: 'Agentic モード', titleEn: 'Agentic Mode', descJa: 'Lab Mode を Agentic に切り替えます。API バージョンは自動的に preview に設定されます。', descEn: 'Switch Lab Mode to Agentic. API version is automatically set to preview.', targetSelector: '[data-guide-target="lab-mode-switcher"]' },
        { icon: 'database', titleJa: 'Knowledge Base 選択', titleEn: 'Select Knowledge Base', descJa: 'ドロップダウンから使用する Knowledge Base を選択します。', descEn: 'Choose the Knowledge Base to use from the dropdown.', targetSelector: '[data-guide-target="knowledge-base-dropdown"]' },
        { icon: 'pencil-square', titleJa: 'クエリ入力', titleEn: 'Enter Query', descJa: '自然言語で質問を入力します。エージェントが最適なソースを自動選択して検索します。', descEn: 'Enter your question in natural language. The agent automatically selects optimal sources.', targetSelector: '[data-guide-target="agentic-messages"]' },
        { icon: 'play-circle', titleJa: '実行', titleEn: 'Execute', descJa: 'Execute を押してエージェント検索を実行します。', descEn: 'Click Execute to run agentic retrieval.', targetSelector: '[data-guide-target="execute-button"]' },
      ],
      tipsJa: ['Knowledge Base は事前に Knowledge Base Builder で作成しておく必要があります', 'retrievalReasoningEffort で推論の深さを調整できます'],
      tipsEn: ['Knowledge Base must be created in advance using Knowledge Base Builder', 'Adjust reasoning depth with retrievalReasoningEffort'],
      docsUrl: 'https://learn.microsoft.com/azure/search/search-agentic-retrieval-concept',
    },
  },
  {
    id: 'analyze-api',
    icon: 'eyedropper',
    category: 'search',
    titleJa: 'テキスト分析 (Analyze API)',
    titleEn: 'Text Analysis (Analyze API)',
    descJa: 'アナライザー、トークナイザー、文字フィルター、トークンフィルターの動作を確認。',
    descEn: 'Test analyzers, tokenizers, char filters, and token filters interactively.',
    action: 'openAnalyzeMode',
    guide: {
      stepsJa: 'テキスト分析の使い方',
      stepsEn: 'How to use Text Analysis',
      steps: [
        { icon: 'toggles', titleJa: 'Analyze モード', titleEn: 'Analyze Mode', descJa: 'Lab Mode を Analyze に切り替えます。', descEn: 'Switch Lab Mode to Analyze.', targetSelector: '[data-guide-target="lab-mode-switcher"]' },
        { icon: 'list-ul', titleJa: 'インデックス選択', titleEn: 'Select Index', descJa: '分析対象のインデックスを選択します。', descEn: 'Select the target index for analysis.', targetSelector: '[data-guide-target="index-dropdown"]' },
        { icon: 'input-cursor-text', titleJa: 'テキスト入力', titleEn: 'Enter Text', descJa: '分析したいテキストを text フィールドに入力します。', descEn: 'Enter the text you want to analyze in the text field.', targetSelector: '[data-guide-target="analyze-text"]' },
        { icon: 'gear', titleJa: 'アナライザー選択', titleEn: 'Select Analyzer', descJa: 'analyzerName でアナライザーを選択するか、tokenizer + filters の組み合わせを指定します。', descEn: 'Choose an analyzer by analyzerName, or specify a tokenizer + filters combination.', targetSelector: '[data-guide-target="analyze-analyzer"]' },
        { icon: 'play-circle', titleJa: '実行', titleEn: 'Execute', descJa: '実行するとテキストがトークンに分割された結果が表示されます。', descEn: 'Execute to see how the text is split into tokens.', targetSelector: '[data-guide-target="execute-button"]' },
      ],
      tipsJa: ['日本語には ja.lucene や ja.microsoft アナライザーが適しています', 'カスタムアナライザーはインデックス定義の analyzers セクションで作成できます'],
      tipsEn: ['For Japanese text, ja.lucene or ja.microsoft analyzers work well', 'Custom analyzers are defined in the analyzers section of the index definition'],
      docsUrl: 'https://learn.microsoft.com/azure/search/search-analyzers',
    },
  },

  // ── Builder Tools ────────────────────────────────────────────
  {
    id: 'index-builder',
    icon: 'bookmark-star',
    category: 'builder',
    titleJa: 'Index Builder',
    titleEn: 'Index Builder',
    descJa: 'インデックスのスキーマ作成・編集・削除。統計情報の表示、JSON インポート/エクスポート。',
    descEn: 'Create, edit, and delete index schemas. View statistics, import/export JSON.',
    action: 'openIndexBuilder',
    guide: {
      stepsJa: 'Index Builder の使い方',
      stepsEn: 'How to use Index Builder',
      steps: [
        { icon: 'box-arrow-in-right', titleJa: '開く', titleEn: 'Open', descJa: 'ツールメニューまたはこのカードから Index Builder を開きます。', descEn: 'Open Index Builder from the Tools menu or this card.' },
        { icon: 'list-ul', titleJa: 'インデックス一覧', titleEn: 'Index List', descJa: '接続先サービスの全インデックスが一覧表示されます。選択して詳細を確認できます。', descEn: 'All indexes from the connected service are listed. Select one to view details.', targetSelector: '[data-guide-target="index-builder-list"]' },
        { icon: 'code-slash', titleJa: 'JSON 編集', titleEn: 'Edit JSON', descJa: 'JSON エディタでインデックス定義を編集します。フィールド、ベクトル設定、セマンティック構成を定義します。', descEn: 'Edit index definitions in the JSON editor. Define fields, vector settings, and semantic configs.', targetSelector: '[data-guide-target="index-builder-editor"]' },
        { icon: 'cloud-upload', titleJa: '作成 / 更新', titleEn: 'Create / Update', descJa: 'Create で新規作成、Update で既存インデックスを更新します。', descEn: 'Use Create for new indexes, Update for existing ones.', targetSelector: '[data-guide-target="index-builder-actions"]' },
      ],
      tipsJa: ['JSON ファイルからインポートして既存の定義をベースに編集できます', '統計情報 (documentCount, storageSize) でインデックスの状態を確認できます'],
      tipsEn: ['Import from JSON files to edit based on existing definitions', 'Check index status via statistics (documentCount, storageSize)'],
      docsUrl: 'https://learn.microsoft.com/azure/search/search-how-to-create-search-index',
    },
  },
  {
    id: 'synonym-map-builder',
    icon: 'journal-text',
    category: 'builder',
    titleJa: 'Synonym Map Builder',
    titleEn: 'Synonym Map Builder',
    descJa: 'Solr 形式のシノニムマップを作成・編集。同義語と明示的マッピングに対応。',
    descEn: 'Create and edit Solr-format synonym maps. Supports equivalency and explicit mappings.',
    action: 'openSynonymMapBuilder',
    guide: {
      stepsJa: 'Synonym Map Builder の使い方',
      stepsEn: 'How to use Synonym Map Builder',
      steps: [
        { icon: 'box-arrow-in-right', titleJa: '開く', titleEn: 'Open', descJa: 'ツールメニューから Synonym Map Builder を開きます。', descEn: 'Open Synonym Map Builder from the Tools menu.' },
        { icon: 'list-ul', titleJa: '既存マップ選択', titleEn: 'Select Existing Map', descJa: '既存のシノニムマップを選択するか、新規作成します。', descEn: 'Select an existing synonym map or create a new one.', targetSelector: '[data-guide-target="synonym-map-list"]' },
        { icon: 'pencil-square', titleJa: 'ルール編集', titleEn: 'Edit Rules', descJa: '同義語ルールを追加します。カンマ区切り (等価) または => 記法 (明示的マッピング) で記述します。', descEn: 'Add synonym rules. Use comma-separated (equivalency) or => notation (explicit mapping).', targetSelector: '[data-guide-target="synonym-map-editor"]' },
        { icon: 'cloud-upload', titleJa: '保存', titleEn: 'Save', descJa: 'Azure に公開してシノニムマップを保存します。', descEn: 'Publish to Azure to save the synonym map.', targetSelector: '[data-guide-target="synonym-map-actions"]' },
      ],
      tipsJa: ['等価例: laptop, notebook, portable computer', '明示的マッピング例: USA, U.S.A. => United States'],
      tipsEn: ['Equivalency example: laptop, notebook, portable computer', 'Explicit mapping example: USA, U.S.A. => United States'],
      docsUrl: 'https://learn.microsoft.com/azure/search/search-synonyms',
    },
  },
  {
    id: 'knowledge-source-builder',
    icon: 'collection',
    category: 'builder',
    titleJa: 'Knowledge Source Builder',
    titleEn: 'Knowledge Source Builder',
    descJa: 'Agentic Retrieval 用のナレッジソースを作成・管理。',
    descEn: 'Create and manage knowledge sources for Agentic Retrieval.',
    action: 'openKnowledgeSourceBuilder',
    guide: {
      stepsJa: 'Knowledge Source Builder の使い方',
      stepsEn: 'How to use Knowledge Source Builder',
      steps: [
        { icon: 'box-arrow-in-right', titleJa: '開く', titleEn: 'Open', descJa: 'ツールメニューから Knowledge Source Builder を開きます。', descEn: 'Open Knowledge Source Builder from the Tools menu.' },
        { icon: 'plus-circle', titleJa: '新規作成', titleEn: 'Create New', descJa: 'ソース名、検索インデックス名、セマンティック構成名を指定して作成します。', descEn: 'Specify source name, search index name, and semantic configuration name to create.', targetSelector: '[data-guide-target="knowledge-source-form"]' },
        { icon: 'gear', titleJa: 'フィールド設定', titleEn: 'Configure Fields', descJa: 'sourceDataFields と searchFields を設定してデータとクエリのマッピングを定義します。', descEn: 'Set sourceDataFields and searchFields to define data and query mappings.', targetSelector: '[data-guide-target="knowledge-source-fields"]' },
        { icon: 'cloud-upload', titleJa: '保存', titleEn: 'Save', descJa: 'Azure に公開します。作成後は Knowledge Base Builder から参照できます。', descEn: 'Publish to Azure. After creation, it can be referenced from Knowledge Base Builder.', targetSelector: '[data-guide-target="knowledge-source-actions"]' },
      ],
      tipsJa: ['Knowledge Source は Knowledge Base の構成要素です。先に作成してからKnowledge Base に追加します'],
      tipsEn: ['Knowledge Sources are building blocks of Knowledge Bases. Create them first, then add to a Knowledge Base'],
      docsUrl: 'https://learn.microsoft.com/azure/search/search-agentic-retrieval-how-to-create',
    },
  },
  {
    id: 'knowledge-base-builder',
    icon: 'database',
    category: 'builder',
    titleJa: 'Knowledge Base Builder',
    titleEn: 'Knowledge Base Builder',
    descJa: 'ナレッジベースの作成・編集。複数のナレッジソースを束ねて管理。',
    descEn: 'Create and edit knowledge bases. Bundle multiple knowledge sources.',
    action: 'openKnowledgeBaseBuilder',
    guide: {
      stepsJa: 'Knowledge Base Builder の使い方',
      stepsEn: 'How to use Knowledge Base Builder',
      steps: [
        { icon: 'box-arrow-in-right', titleJa: '開く', titleEn: 'Open', descJa: 'ツールメニューから Knowledge Base Builder を開きます。', descEn: 'Open Knowledge Base Builder from the Tools menu.' },
        { icon: 'plus-circle', titleJa: '新規作成', titleEn: 'Create New', descJa: 'ナレッジベース名と説明を入力します。', descEn: 'Enter knowledge base name and description.', targetSelector: '[data-guide-target="knowledge-base-form"]' },
        { icon: 'collection', titleJa: 'ソース追加', titleEn: 'Add Sources', descJa: '事前に作成した Knowledge Source を knowledgeSources 配列に追加します。', descEn: 'Add previously created Knowledge Sources to the knowledgeSources array.', targetSelector: '[data-guide-target="knowledge-base-sources"]' },
        { icon: 'cloud-upload', titleJa: '保存', titleEn: 'Save', descJa: 'Azure に公開します。作成後は Agentic モードで利用できます。', descEn: 'Publish to Azure. After creation, use it in Agentic mode.', targetSelector: '[data-guide-target="knowledge-base-actions"]' },
      ],
      tipsJa: ['1つの Knowledge Base に複数の Knowledge Source を束ねることで、エージェントが最適なソースを自動選択します'],
      tipsEn: ['Bundling multiple Knowledge Sources in one Knowledge Base lets the agent automatically select the best source'],
      docsUrl: 'https://learn.microsoft.com/azure/search/search-agentic-retrieval-how-to-create',
    },
  },
  {
    id: 'skill-pipeline-builder',
    icon: 'diagram-2',
    isEmoji: false,
    category: 'builder',
    titleJa: 'Skill Pipeline Builder',
    titleEn: 'Skill Pipeline Builder',
    descJa: 'スキルセットをビジュアル DAG エディタで構築。15 種の組み込みスキルテンプレート、デバッグランナー付き。',
    descEn: 'Author skillsets with a visual DAG editor. 15 built-in skill templates with debug runner.',
    action: 'openSkillPipelineBuilder',
    guide: {
      stepsJa: 'Skill Pipeline Builder の使い方',
      stepsEn: 'How to use Skill Pipeline Builder',
      steps: [
        { icon: 'box-arrow-in-right', titleJa: '開く', titleEn: 'Open', descJa: 'ツールメニューから Skill Pipeline Builder を開きます。', descEn: 'Open Skill Pipeline Builder from the Tools menu.' },
        { icon: 'plus-circle', titleJa: 'スキル追加', titleEn: 'Add Skills', descJa: 'ツールバーから15 種の組み込みスキルテンプレートを選択してノードを追加します。', descEn: 'Choose from 15 built-in skill templates from the toolbar to add nodes.', targetSelector: '[data-guide-target="spb-toolbar"]' },
        { icon: 'link-45deg', titleJa: '接続', titleEn: 'Connect', descJa: 'キャンバス上のノードのポートをドラッグして入出力を接続します。エンリッチメントパスが自動設定されます。', descEn: 'Drag node ports on the canvas to connect inputs/outputs. Enrichment paths are auto-configured.', targetSelector: '[data-guide-target="spb-canvas"]' },
        { icon: 'code-slash', titleJa: 'JSON 編集', titleEn: 'Edit JSON', descJa: 'Skillset JSON タブでスキルセット全体の JSON を直接編集できます。', descEn: 'Use the Skillset JSON tab to edit the full skillset JSON directly.', targetSelector: '[data-guide-target="spb-tab-skillsetJson"]' },
        { icon: 'bug', titleJa: 'デバッグ', titleEn: 'Debug', descJa: 'Debug Runner タブで実データを使ってスキル出力をプレビューできます。', descEn: 'Use the Debug Runner tab to preview skill outputs with real data.', targetSelector: '[data-guide-target="spb-tab-debugRunner"]' },
        { icon: 'cloud-upload', titleJa: '公開', titleEn: 'Publish', descJa: 'Diff 確認付きで Azure にスキルセットを公開します。', descEn: 'Publish skillsets to Azure with diff confirmation.', targetSelector: '[data-guide-target="spb-publish"]' },
      ],
      tipsJa: ['キャンバスを右クリックすると Indexer / Index の読み込みメニューが表示されます', 'ローカル保存で複数のパイプライン構成を保持できます'],
      tipsEn: ['Right-click the canvas to load Indexer / Index from the menu', 'Use local save to maintain multiple pipeline configurations'],
      docsUrl: 'https://learn.microsoft.com/azure/search/cognitive-search-defining-skillset',
    },
  },
  {
    id: 'skill-code-editor',
    icon: 'code-slash',
    category: 'builder',
    titleJa: 'Custom Skill LiveEditor',
    titleEn: 'Custom Skill LiveEditor',
    descJa: 'Python カスタムスキルをブラウザ内で開発・テスト・デプロイ。Pyodide によるローカル実行対応。',
    descEn: 'Develop, test, and deploy Python custom skills in-browser. Local execution via Pyodide.',
    action: 'openSkillEditor',
    guide: {
      stepsJa: 'Custom Skill LiveEditor の使い方',
      stepsEn: 'How to use Custom Skill LiveEditor',
      steps: [
        { icon: 'code-slash', titleJa: 'Code タブ', titleEn: 'Code Tab', descJa: 'Code タブに切り替えて Python コードを記述します。def process(input: dict) -> dict の契約に従います。', descEn: 'Switch to the Code tab and write Python code following the def process(input: dict) -> dict contract.', targetSelector: '[data-guide-target="sce-tab-code"]' },
        { icon: 'terminal', titleJa: 'Test タブ', titleEn: 'Test Tab', descJa: 'Test タブで入力 JSON を編集して Local Run (Pyodide) または Remote Run で実行します。', descEn: 'In the Test tab, edit test input JSON and run with Local Run (Pyodide) or Remote Run.', targetSelector: '[data-guide-target="sce-tab-test"]' },
        { icon: 'gear', titleJa: 'Settings タブ', titleEn: 'Settings Tab', descJa: 'Settings タブでランタイム URL の設定、ヘルスチェック、スキルのアップロードを行います。', descEn: 'In the Settings tab, configure runtime URL, health check, and skill upload.', targetSelector: '[data-guide-target="sce-tab-settings"]' },
        { icon: 'cloud-upload', titleJa: 'デプロイ', titleEn: 'Deploy', descJa: 'Blob Storage にコードをアップロードし、Azure Container Apps のランタイムに反映します。', descEn: 'Upload code to Blob Storage and deploy to Azure Container Apps runtime.', targetSelector: '[data-guide-target="sce-tab-settings"]' },
      ],
      tipsJa: ['Local Run は Pyodide (WebAssembly) で動作するため、サーバー不要で即座にテストできます', 'Skill Pipeline Builder からスキルノードを選択して直接開くこともできます'],
      tipsEn: ['Local Run uses Pyodide (WebAssembly) so you can test instantly without a server', 'You can also open directly from a skill node in the Skill Pipeline Builder'],
      docsUrl: 'https://learn.microsoft.com/azure/search/cognitive-search-custom-skill-web-api',
    },
  },
  {
    id: 'filter-builder',
    icon: 'funnel',
    category: 'builder',
    titleJa: 'Filter Builder',
    titleEn: 'Filter Builder',
    descJa: 'OData フィルター式を GUI で構築。複数条件の AND/OR ロジックに対応。',
    descEn: 'Build OData filter expressions via GUI. Supports AND/OR logic with multiple conditions.',
    action: 'openFilterBuilder',
    guide: {
      stepsJa: 'Filter Builder の使い方',
      stepsEn: 'How to use Filter Builder',
      steps: [
        { icon: 'box-arrow-in-right', titleJa: '開く', titleEn: 'Open', descJa: 'Request Builder の filter フィールド横のボタンから Filter Builder を開きます。', descEn: 'Open Filter Builder from the button next to the filter field in Request Builder.' },
        { icon: 'plus-circle', titleJa: '条件追加', titleEn: 'Add Condition', descJa: 'フィールド名、演算子 (eq, ne, gt, ge, lt, le, search.in 等)、値を指定して条件を追加します。', descEn: 'Add conditions by specifying field name, operator (eq, ne, gt, ge, lt, le, search.in, etc.), and value.' },
        { icon: 'diagram-3', titleJa: 'ロジック結合', titleEn: 'Combine Logic', descJa: '複数の条件を AND / OR で結合します。', descEn: 'Combine multiple conditions with AND / OR logic.' },
        { icon: 'check2-circle', titleJa: '適用', titleEn: 'Apply', descJa: '生成されたフィルター式をプレビューして、Request Builder に適用します。', descEn: 'Preview the generated filter expression and apply it to the Request Builder.' },
      ],
      tipsJa: ['OData フィルター構文: field eq value, search.in(field, \'a,b,c\') など', 'Filterable に設定されたフィールドのみフィルター可能です'],
      tipsEn: ['OData filter syntax: field eq value, search.in(field, \'a,b,c\'), etc.', 'Only fields marked as Filterable can be filtered'],
      docsUrl: 'https://learn.microsoft.com/azure/search/search-filters',
    },
  },

  // ── Optimization & Testing ───────────────────────────────────
  {
    id: 'auto-tuning',
    icon: 'sliders',
    category: 'optimization',
    titleJa: 'Search Parameter AutoTuning',
    titleEn: 'Search Parameter AutoTuning',
    descJa: 'JSONL 評価データセットを使ったグリッドサーチによる検索パラメータの自動最適化。',
    descEn: 'Automated grid search optimization of search parameters using JSONL evaluation datasets.',
    action: 'openAutoTuning',
    guide: {
      stepsJa: 'AutoTuning の使い方',
      stepsEn: 'How to use AutoTuning',
      steps: [
        { icon: 'file-earmark-arrow-up', titleJa: 'データセット準備', titleEn: 'Prepare Dataset', descJa: 'JSONL 形式の評価データセットを準備します。各行に query (検索クエリ) と expected_ids (正解ドキュメントID) を含めます。', descEn: 'Prepare a JSONL evaluation dataset. Each line should contain query (search query) and expected_ids (ground truth document IDs).', targetSelector: '[data-guide-target="autotuning-upload"]' },
        { icon: 'sliders', titleJa: 'パラメータ空間設定', titleEn: 'Set Parameter Space', descJa: '最適化するパラメータ (インデックス、vectorWeight、vectorK、queryType 等) と探索範囲を設定します。', descEn: 'Configure parameters to optimize (index, vectorWeight, vectorK, queryType, etc.) and their search ranges.', targetSelector: '[data-guide-target="autotuning-params"]' },
        { icon: 'bullseye', titleJa: '評価指標選択', titleEn: 'Select Metric', descJa: '最適化目標 (Precision@k, Recall@k, NDCG, MRR) と k 値を設定します。', descEn: 'Set the optimization objective (Precision@k, Recall@k, NDCG, MRR) and k value.', targetSelector: '[data-guide-target="autotuning-metric"]' },
        { icon: 'play-circle', titleJa: '実行', titleEn: 'Execute', descJa: 'Run をクリックしてグリッドサーチを開始します。進捗はリアルタイムで表示されます。', descEn: 'Click Run to start the grid search. Progress is displayed in real-time.', targetSelector: '[data-guide-target="autotuning-run"]' },
      ],
      tipsJa: ['samples/ ディレクトリにサンプル JSONL データセットがあります', '結果は Experiment Run として保存され、後から復元・比較できます'],
      tipsEn: ['Sample JSONL datasets are available in the samples/ directory', 'Results are saved as Experiment Runs and can be restored and compared later'],
      docsUrl: 'https://learn.microsoft.com/azure/search/search-query-overview',
    },
  },
  {
    id: 'vector-optimizer',
    icon: 'arrows-angle-contract',
    category: 'optimization',
    titleJa: 'Vector Optimizer',
    titleEn: 'Vector Optimizer',
    descJa: '量子化・次元削減・ストレージ設定の組み合わせで理論サイズを比較。コスト最適化を支援。',
    descEn: 'Compare theoretical sizes for quantization, dimension reduction, and storage combinations.',
    action: 'openVectorOptimizer',
    guide: {
      stepsJa: 'Vector Optimizer の使い方',
      stepsEn: 'How to use Vector Optimizer',
      steps: [
        { icon: 'box-arrow-in-right', titleJa: '開く', titleEn: 'Open', descJa: 'ツールメニューから Vector Optimizer を開きます。', descEn: 'Open Vector Optimizer from the Tools menu.' },
        { icon: 'sliders', titleJa: 'ベクトル設定', titleEn: 'Vector Settings', descJa: 'ベクトル次元数、入力フォーマット (float32/float16) を設定します。', descEn: 'Set vector dimensions and input format (float32/float16).', targetSelector: '[data-guide-target="vo-dimensions"]' },
        { icon: 'gear', titleJa: '最適化オプション', titleEn: 'Optimization Options', descJa: '量子化 (scalar/binary)、truncationDimension、stored、rescoring の組み合わせを設定します。', descEn: 'Configure combinations of quantization (scalar/binary), truncationDimension, stored, and rescoring.', targetSelector: '[data-guide-target="vo-settings"]' },
        { icon: 'bar-chart', titleJa: 'サイズ比較', titleEn: 'Compare Sizes', descJa: '各設定の理論サイズ (バイト数) が自動計算されて比較表示されます。', descEn: 'Theoretical sizes (bytes) are automatically calculated and compared.', targetSelector: '[data-guide-target="vo-estimate"]' },
      ],
      tipsJa: ['scalarQuantization (int8) でメモリ使用量を約 75% 削減できます', 'MRL (truncationDimension) と量子化の併用でさらにサイズを縮小できます'],
      tipsEn: ['scalarQuantization (int8) can reduce memory usage by about 75%', 'Combining MRL (truncationDimension) with quantization further reduces size'],
      docsUrl: 'https://learn.microsoft.com/azure/search/vector-search-how-to-quantization',
    },
  },
  {
    id: 'qps-tester',
    icon: 'speedometer2',
    category: 'optimization',
    titleJa: 'QPS Tester',
    titleEn: 'QPS Tester',
    descJa: '5 種の検索モードで QPS・レイテンシ (p50/p95) を計測。キャパシティプランニングに最適。',
    descEn: 'Measure QPS and latency (p50/p95) across 5 search modes. Ideal for capacity planning.',
    action: 'openQpsTester',
    guide: {
      stepsJa: 'QPS Tester の使い方',
      stepsEn: 'How to use QPS Tester',
      steps: [
        { icon: 'box-arrow-in-right', titleJa: '開く', titleEn: 'Open', descJa: 'ツールメニューから QPS Tester を開きます。', descEn: 'Open QPS Tester from the Tools menu.' },
        { icon: 'pencil-square', titleJa: 'クエリ設定', titleEn: 'Configure Query', descJa: 'Request Builder の現在のクエリ設定がテストに使用されます。事前にクエリを設定してください。', descEn: 'The current query settings from Request Builder are used for testing. Set up your query beforehand.' },
        { icon: 'people', titleJa: '同時実行数', titleEn: 'Concurrency', descJa: 'リクエスト数と同時実行リクエスト数を設定します。', descEn: 'Set the requests per mode and concurrency.', targetSelector: '[data-guide-target="qps-controls"]' },
        { icon: 'play-circle', titleJa: '実行', titleEn: 'Execute', descJa: '5 種の検索モード (query, semantic, vector, hybrid, semantic_hybrid) で計測を開始します。', descEn: 'Start measurement across 5 search modes (query, semantic, vector, hybrid, semantic_hybrid).', targetSelector: '[data-guide-target="qps-run"]' },
        { icon: 'clipboard-data', titleJa: '結果確認', titleEn: 'Review Results', descJa: 'QPS、p50/p95 レイテンシ、エラー数を確認します。結果は Experiment Run として保存されます。', descEn: 'Check QPS, p50/p95 latency, and error counts. Results are saved as Experiment Runs.' },
      ],
      tipsJa: ['本番環境と同じ SKU・レプリカ数で計測すると正確な結果が得られます', 'p95 レイテンシが SLA 以下であることを確認しましょう'],
      tipsEn: ['Measure with the same SKU and replica count as production for accurate results', 'Verify that p95 latency is within your SLA targets'],
      docsUrl: 'https://learn.microsoft.com/azure/search/search-performance-optimization',
    },
  },

  // ── Developer Tools / Visualizers ────────────────────────────
  {
    id: 'search-pipeline-visualizer',
    icon: 'bar-chart-steps',
    category: 'devtool',
    titleJa: 'Search Pipeline Visualizer',
    titleEn: 'Search Pipeline Visualizer',
    descJa: '4 段階の検索パイプライン (Text → Vector → Hybrid → Semantic) を並列実行して可視化。',
    descEn: 'Visualize the 4-stage search pipeline (Text → Vector → Hybrid → Semantic) side by side.',
    action: 'openSearchPipelineVisualizer',
    guide: {
      stepsJa: 'Search Pipeline Visualizer の使い方',
      stepsEn: 'How to use Search Pipeline Visualizer',
      steps: [
        { icon: 'box-arrow-in-right', titleJa: '開く', titleEn: 'Open', descJa: 'ツールメニューから Search Pipeline Visualizer を開きます。', descEn: 'Open Search Pipeline Visualizer from the Tools menu.' },
        { icon: 'pencil-square', titleJa: 'クエリ入力', titleEn: 'Enter Query', descJa: '検索クエリを入力し、ベクトルフィールドとセマンティック構成を設定します。', descEn: 'Enter a search query and configure vector fields and semantic configuration.', targetSelector: '[data-guide-target="spv-query"]' },
        { icon: 'play-circle', titleJa: '実行', titleEn: 'Execute', descJa: '4 つの検索ステージ (Text, Vector, Hybrid, Semantic Hybrid) が並列実行されます。', descEn: 'Four search stages (Text, Vector, Hybrid, Semantic Hybrid) run in parallel.', targetSelector: '[data-guide-target="spv-run"]' },
        { icon: 'eye', titleJa: '結果比較', titleEn: 'Compare Results', descJa: '各ステージの結果を並べて比較します。ドキュメントをクリックすると各ステージでの順位が強調表示されます。', descEn: 'Compare results side by side. Click a document to highlight its rank across all stages.' },
      ],
      tipsJa: ['関連ドキュメントがどのステージで脱落するか確認するのに最適です', 'セマンティックリランキングの効果を直感的に把握できます'],
      tipsEn: ['Great for identifying which stage drops relevant documents', 'Intuitively understand the impact of semantic reranking'],
      docsUrl: 'https://learn.microsoft.com/azure/search/hybrid-search-overview',
    },
  },
  {
    id: 'text-to-vector',
    icon: '123',
    category: 'devtool',
    titleJa: 'Text to Vector',
    titleEn: 'Text to Vector',
    descJa: 'テキストからベクトル埋め込みを生成。次元数の確認とクエリへの貼り付けが可能。',
    descEn: 'Generate vector embeddings from text. Check dimensions and paste into queries.',
    action: 'openTextToVector',
    guide: {
      stepsJa: 'Text to Vector の使い方',
      stepsEn: 'How to use Text to Vector',
      steps: [
        { icon: 'box-arrow-in-right', titleJa: '開く', titleEn: 'Open', descJa: 'ツールメニューから Text to Vector を開きます。', descEn: 'Open Text to Vector from the Tools menu.' },
        { icon: 'gear', titleJa: 'エンドポイント設定', titleEn: 'Configure Endpoint', descJa: 'Azure OpenAI のエンドポイント、API キー、モデル名を入力します。', descEn: 'Enter your Azure OpenAI endpoint, API key, and model name.', targetSelector: '[data-guide-target="t2v-endpoint"]' },
        { icon: 'input-cursor-text', titleJa: 'テキスト入力', titleEn: 'Enter Text', descJa: '埋め込みに変換したいテキストを入力します。', descEn: 'Enter the text you want to convert to embeddings.', targetSelector: '[data-guide-target="t2v-input"]' },
        { icon: 'play-circle', titleJa: '生成', titleEn: 'Generate', descJa: 'Generate をクリックしてベクトルを生成します。次元数も表示されます。', descEn: 'Click Generate to create the vector. Dimensions are also displayed.', targetSelector: '[data-guide-target="t2v-generate"]' },
        { icon: 'clipboard', titleJa: 'コピー & 貼り付け', titleEn: 'Copy & Paste', descJa: '生成されたベクトルをコピーして、Request Builder のベクトルクエリに貼り付けます。', descEn: 'Copy the generated vector and paste it into the vector query in Request Builder.' },
      ],
      tipsJa: ['text-embedding-ada-002 は 1536 次元、text-embedding-3-small は 1536 次元（MRL で削減可能）です'],
      tipsEn: ['text-embedding-ada-002 is 1536 dimensions, text-embedding-3-small is 1536 dimensions (reducible via MRL)'],
      docsUrl: 'https://learn.microsoft.com/azure/search/vector-search-integrated-vectorization',
    },
  },
  {
    id: 'index-inspector',
    icon: 'info-circle',
    category: 'devtool',
    titleJa: 'Index Inspector',
    titleEn: 'Index Inspector',
    descJa: 'インデックスのスキーマ詳細表示。フィールド定義、ベクトル設定、セマンティック構成。',
    descEn: 'View index schema details. Field definitions, vector settings, semantic configurations.',
    action: 'openIndexInspector',
    guide: {
      stepsJa: 'Index Inspector の使い方',
      stepsEn: 'How to use Index Inspector',
      steps: [
        { icon: 'box-arrow-in-right', titleJa: '開く', titleEn: 'Open', descJa: 'インデックス名の横にある虫眼鏡アイコンをクリックするか、このカードから開きます。', descEn: 'Click the magnifier icon next to the index name, or open from this card.' },
        { icon: 'eye', titleJa: 'スキーマ確認', titleEn: 'View Schema', descJa: 'フィールド定義、ベクトルプロファイル、セマンティック構成が一覧表示されます。', descEn: 'Field definitions, vector profiles, and semantic configurations are displayed.' },
        { icon: 'clipboard', titleJa: 'コピー', titleEn: 'Copy', descJa: 'インデックス定義 JSON をクリップボードにコピーして再利用できます。', descEn: 'Copy the index definition JSON to clipboard for reuse.' },
      ],
      docsUrl: 'https://learn.microsoft.com/azure/search/search-what-is-an-index',
    },
  },

  // ── Experiment Management ────────────────────────────────────
  {
    id: 'experiment-management',
    icon: 'journal-bookmark',
    category: 'experiment',
    titleJa: '実験管理',
    titleEn: 'Experiment Management',
    descJa: 'クエリ実行結果を Run として保存。複数 Run の比較表示、ノート記録、エクスポート/インポート。',
    descEn: 'Save query results as Runs. Compare multiple runs side by side, add notes, export/import.',
    action: 'openExperimentManagement',
    guide: {
      stepsJa: '実験管理の使い方',
      stepsEn: 'How to use Experiment Management',
      steps: [
        { icon: 'journal-plus', titleJa: 'Experiment 作成', titleEn: 'Create Experiment', descJa: '左ペインの + ボタンで新しい Experiment を作成します。名前とタグで整理できます。', descEn: 'Create a new Experiment with the + button in the left pane. Organize with names and tags.' },
        { icon: 'play-circle', titleJa: 'クエリ実行', titleEn: 'Execute Query', descJa: 'Request Builder で検索を実行すると、結果が自動的に Run として保存されます。', descEn: 'Execute a search from Request Builder and results are automatically saved as a Run.' },
        { icon: 'journal-text', titleJa: 'ノート記録', titleEn: 'Add Notes', descJa: '実行前にノートを記録しておくと、Run にメモとして紐付けられます。', descEn: 'Record notes before execution to attach them as memos to the Run.' },
        { icon: 'layout-three-columns', titleJa: 'Run 比較', titleEn: 'Compare Runs', descJa: '左ペインで複数の Run を選択すると、結果を並べて比較できます（最大 10 件）。', descEn: 'Select multiple Runs in the left pane to compare results side by side (up to 10).' },
        { icon: 'download', titleJa: 'エクスポート', titleEn: 'Export', descJa: 'Run をJSON 形式でエクスポートし、別環境でインポートして共有できます。', descEn: 'Export Runs in JSON format and import in another environment to share.' },
      ],
      tipsJa: ['pinned Experiment はリスト上部に固定表示されます', 'Run のクエリテキストでフィルタリングして素早く目的の Run を見つけられます'],
      tipsEn: ['Pinned Experiments stay at the top of the list', 'Filter Runs by query text to quickly find what you need'],
    },
  },

  // ── Azure AI Search Features (not yet in RAGOps Studio) ──────
  {
    id: 'indexer-management',
    icon: 'arrow-repeat',
    category: 'azure',
    titleJa: 'Indexer 管理',
    titleEn: 'Indexer Management',
    descJa: 'データソースからのインデックス自動作成。スケジュール設定、実行状態の監視。',
    descEn: 'Auto-populate indexes from data sources. Schedule runs and monitor execution status.',
    disabled: true,
  },
  {
    id: 'data-source-management',
    icon: 'hdd-network',
    category: 'azure',
    titleJa: 'Data Source 管理',
    titleEn: 'Data Source Management',
    descJa: 'Azure Blob Storage、SQL Database、Cosmos DB などのデータソース接続の作成と管理。',
    descEn: 'Create and manage data source connections for Azure Blob Storage, SQL Database, Cosmos DB, etc.',
    disabled: true,
  },
  {
    id: 'knowledge-store',
    icon: 'archive',
    category: 'azure',
    titleJa: 'Knowledge Store',
    titleEn: 'Knowledge Store',
    descJa: 'AI エンリッチメントの出力を Azure Storage に永続化するプロジェクションの管理。',
    descEn: 'Manage projections to persist AI enrichment outputs to Azure Storage.',
    disabled: true,
  },
  {
    id: 'debug-sessions',
    icon: 'bug',
    category: 'azure',
    titleJa: 'デバッグセッション',
    titleEn: 'Debug Sessions',
    descJa: 'Azure Portal のデバッグセッション相当。スキルセットの段階的デバッグと出力確認。',
    descEn: 'Equivalent to Azure Portal debug sessions. Step-through skillset debugging with output preview.',
    disabled: true,
  },
  {
    id: 'semantic-configuration-builder',
    icon: 'stars',
    category: 'azure',
    titleJa: 'セマンティック構成ビルダー',
    titleEn: 'Semantic Configuration Builder',
    descJa: 'セマンティック検索のための構成 (title / content / keyword フィールド) を GUI で作成。',
    descEn: 'Build semantic configurations (title / content / keyword fields) via GUI.',
    disabled: true,
  },
  {
    id: 'alias-management',
    icon: 'signpost-split',
    category: 'azure',
    titleJa: 'インデックスエイリアス管理',
    titleEn: 'Index Alias Management',
    descJa: 'インデックスエイリアスの作成・更新・削除。ゼロダウンタイムのインデックス切り替え。',
    descEn: 'Create, update, and delete index aliases. Enable zero-downtime index swaps.',
    disabled: true,
  },
  {
    id: 'search-traffic-analytics',
    icon: 'graph-up',
    category: 'azure',
    titleJa: '検索トラフィック分析',
    titleEn: 'Search Traffic Analytics',
    descJa: 'クリックスルー率、検索クエリパターン、ユーザー行動の分析と可視化。',
    descEn: 'Analyze and visualize click-through rates, search query patterns, and user behavior.',
    disabled: true,
  },
]
