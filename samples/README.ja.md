# Search Parameter AutoTuning 用サンプルデータセット

このディレクトリには、RAGOps Studio の **Search Parameter AutoTuning** 機能で使用するサンプル JSONL データセットが含まれています。

## ファイル一覧

| ファイル | 説明 | クエリフィールド | 回答フィールド | 行数 |
|------|------|----------------|--------------|------|
| `autotuning-dataset-en.jsonl` | 英語版評価データセット（ドキュメントID形式） | `query` | `expected_ids` | 20 |
| `autotuning-dataset-ja.jsonl` | 日本語版評価データセット（ドキュメントID形式） | `query` | `expected_ids` | 20 |

## データセットフォーマット

各 JSONL ファイルは1行につき1つの JSON オブジェクトで構成されます。必須フィールド:

- **クエリフィールド** (string): 評価対象の検索クエリ（例: `query`）
- **回答フィールド** (string または string 配列): 正解となる関連ドキュメントID（例: `expected_ids`）

`category` や `query_id` などの追加フィールドはオプションのメタデータであり、AutoTuning では無視されます。

### 例: ドキュメントID形式

```json
{"query": "検索インデックスの作成方法", "expected_ids": ["doc-010", "doc-011", "doc-012"]}
```

## 使い方

1. RAGOps Studio で **Search Parameter AutoTuning** を開く
2. **Upload JSONL** をクリックしてデータセットファイルを選択
3. UI 上で **Query Field** と **Answer Field** をマッピング
4. **Result ID Field** を検索インデックスのドキュメントキーフィールドに合わせて設定
5. パラメータ探索空間を設定して最適化を実行

## データセットのカスタマイズ

`expected_ids` の値を、お使いの Azure AI Search インデックス内の実際のドキュメントIDに置き換えてください。ID は AutoTuning 設定の **Result ID Field** で指定したフィールドが返す値と一致する必要があります。
