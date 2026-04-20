<p align="center">
  <img src="./public/icon.png" alt="RAGOps Studio — for Azure AI Search" width="240" height="240">
</p>

# RAGOps Studio — for Azure AI Search

**RAGOps, from query to quality.**

Azure AI Search の高度な機能を学習・実験できる Web ベースの開発ツールです。

![RAGOps Studio — for Azure AI Search](https://img.shields.io/badge/Azure-AI%20Search-0078D4?style=flat-square&logo=microsoft-azure)
![React](https://img.shields.io/badge/React-19.2-61DAFB?style=flat-square&logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=flat-square&logo=typescript)
![Vite](https://img.shields.io/badge/Vite-7.2-646CFF?style=flat-square&logo=vite)

> 📦 RAGOps Studio Series
>
> - RAGOps Studio — for Azure AI Search（this repo）: React/TypeScript ベースで検索インデックスの観測・比較・改善を行うワークベンチ（Series #1）
> - [RAGOps Studio — for Document Intelligence / Content Understanding](https://github.com/nohanaga/ragops-studio-for-di-cu/blob/main/README.ja.md): Azure AI Document Intelligence / Content Understanding を用いて文書解析レイヤーを改善するワークベンチ（Series #2）
>
> - English: [README.md](README.md) | [FEATURES.md](FEATURES.md)

![](./docs/images/screenshot1_jp.jpg)

> **📖 RAGOps Studio の詳しい紹介は [Qiita](https://qiita.com/nohanaga/items/f5d6ec340f238c8220be) をご覧ください**

## 特徴

- 🔍 **4つの検索モード**: クラシック検索、セマンティック&ベクトル検索、エージェント検索（Knowledge Retrieval API）、テキスト分析
- 🛠️ **ビルダーツール**: インデックス、ナレッジソース、ナレッジベース、シノニムマップ、スキルセット（ビジュアルパイプラインビルダー）の作成・管理
- 🧩 **スキルパイプラインビルダー**: ビルトインスキルテンプレート、エンリッチメントツリープレビュー、デバッグランナー付きのビジュアル DAG エディター
- 📝 **Custom Skill LiveEditor**: Custom Skill のブラウザ統合 Python IDE—ローカル実行（Pyodide/WASM）、クラウドデプロイ（Azure Container Apps）、Blob Storage 同期対応
- 🧬 **Eval Dataset Generator**: Azure OpenAI を使用してインデックス内の実ドキュメントから AutoTuning 互換 JSONL 評価データセットを自動生成。多段階品質フィルター（Round-trip Consistency、意味的重複排除、Difficulty Evolution、Hard Negative Mining）対応
- 🎯 **検索パラメータ自動チューニング**: 評価データセットを使用して検索パラメータを自動最適化
- 🧪 **実験管理**: クエリ履歴の保存、結果の比較、エクスポート/インポート
- 🎨 **多機能UI**: 6つのテーマ、日英対応、3ペインレイアウト、リサイズ可能なパネル
- 🧭 **Feature Portal**: カード形式の機能ディレクトリ付きインタラクティブなウェルカム画面。UI 要素ハイライト付きのステップバイステップガイドと、実際に操作しながら学べる Companion モードを搭載
- 💾 **オフライン対応**: IndexedDB でブラウザ内にデータ保存

## セットアップ

### 必要要件
- Node.js 18以降
- Azure AI Search サービス

### インストール

```bash
# リポジトリのクローン
git clone https://github.com/nohanaga/ragops-studio.git
cd ragops-studio

# 依存パッケージのインストール
npm install
```

### 開発サーバーの起動

```bash
npm run dev
```

ブラウザで `http://localhost:5173` を開きます。

### ビルド

```bash
npm run build
```

ビルド成果物は `dist/` ディレクトリに出力されます。

### Skill Runtime（オプション）

**Custom Skill LiveEditor** のリモート実行およびクラウドデプロイ機能を使用するには、Skill Runtime（Azure Container Apps 上にデプロイする FastAPI ベースの Python バックエンド）のセットアップが必要です。

セットアップとデプロイ手順は [skill-runtime/README.jp.md](skill-runtime/README.jp.md) を参照してください。

## 使い方

1. **接続設定**: ヘッダーの「Settings」から Azure AI Search のエンドポイントと API キーを設定
2. **モード選択**: Query / Semantic-Vector / Agentic / Analyze のいずれかを選択
3. **クエリ作成**: フォームまたは JSON で検索条件を入力
4. **実行**: 「Run」ボタン（Enter）で実行
5. **結果確認**: 中央ペインで結果を確認、右ペインで JSON を参照

詳細な機能説明は [FEATURES.jp.md](FEATURES.jp.md) を参照してください。

## 主なコマンド

```bash
# 開発サーバー
npm run dev

# プロダクションビルド
npm run build

# リント
npm run lint

# テスト
npm run test

# プレビュー（ビルド後）
npm run preview

# シノニムマップ生成
npm run gen:synonymmap
```

## 技術スタック

- **React 19.2** - UI フレームワーク
- **TypeScript 5.9** - 型安全な開発
- **Vite 7.2** - 高速ビルドツール
- **Bootstrap 5.3** - UI コンポーネント
- **CodeMirror 6** - コードエディター
- **ReactFlow (@xyflow/react)** - フローチャート可視化
- **dagre** - グラフ自動レイアウト
- **Pyodide** - WebAssembly によるブラウザ内 Python 実行
- **IndexedDB (idb)** - クライアントサイドデータベース

## プロジェクト構造

```
ragops-studio/
├── src/
│   ├── components/     # React コンポーネント
│   ├── hooks/          # カスタムフック
│   ├── lib/            # コアロジック（API, DB, 翻訳）
│   ├── types/          # TypeScript 型定義
│   ├── utils/          # ユーティリティ関数
│   └── App.tsx         # メインコンポーネント
├── public/             # 静的ファイル
├── skill-runtime/     # クラウド Skill Runtime（FastAPI + Python）
├── scripts/            # ビルドスクリプト
└── package.json        # npm 設定
```


## セキュリティ / CORS に関する注意

- 本アプリは主に **ローカルでの学習・開発用途** を想定しています。接続設定（API キー / Bearer トークンなど）はブラウザ側で扱われます。
- **API キー等の資格情報をエンドユーザーのブラウザに配布する形での公開運用は推奨されません。** 公開/本番運用を行う場合は、資格情報を **サーバー側** に置き、バックエンド/プロキシ経由で Azure AI Search を呼び出してください。
- Azure AI Search の CORS は制限があります。Microsoft のドキュメントでは、**セキュリティ上の理由により CORS をサポートするのはクエリ API のみ**（インデックスの `corsOptions` で設定）とされています。
- `npm run dev` には、ローカル開発時の CORS 回避のための開発プロキシが含まれます。一方 `npm run preview` はビルド成果物を配信するため、バックエンド/プロキシが無い場合はブラウザから直接リクエストされ CORS で失敗します。


## ライセンス

このプロジェクトは [LICENSE](LICENSE) ファイルに基づいてライセンスされています。


これは個人的なプロジェクトであり、マイクロソフトの公式製品ではありません。本プロジェクトはコミュニティ主導で開発されており、現状のまま提供されます。マイクロソフトを含む開発者は、本ソフトウェアの使用に起因するいかなる問題についても責任を負わず、公式なサポートは提供されません。

## 関連リンク

- [Azure AI Search ドキュメント](https://learn.microsoft.com/azure/search/)
- [Azure AI Search REST API リファレンス](https://learn.microsoft.com/rest/api/searchservice/)
- [詳細な機能ガイド](FEATURES.jp.md)
- [Skill Runtime（Custom Skill バックエンド）](skill-runtime/README.jp.md)

---

**RAGOps, from query to quality.**
