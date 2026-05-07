# Eval Dataset Generator — LLM による評価データセット自動生成

> **GRADE** (**G**rounded **R**AG **A**ssessment **D**ataset **E**ngine)

Azure AI Search インデックス内の実ドキュメントから Azure OpenAI を使って評価データセットを自動生成する機能です。生成されるデータセットは **Search Parameter AutoTuning** 互換の JSONL 形式であり、生成からパラメータ最適化まで一気通貫で実行できます。さらに、**RAFT（LLM ファインチューニング）** 用データセットや **HyDE（ベクトル検索評価）** 用仮説パッセージも同一パイプラインから出力可能です。

---

## 目次

- [なぜ評価データセットが必要なのか](#なぜ評価データセットが必要なのか)
- [なぜ GRADE か — 合成クエリ生成の三大欠陥と設計原則](#なぜ-grade-か--合成クエリ生成の三大欠陥と設計原則)
- [アーキテクチャ概要](#アーキテクチャ概要)
- [Index Structure Detection + Adaptive Sampling](#index-structure-detection--adaptive-sampling)
- [2つの生成モード：Classic と Ragas](#2つの生成モードclassic-と-ragas)
- [GRADE パイプライン（13段階品質パイプライン）](#grade-パイプライン13段階品質パイプライン)
- [Style Evolution（SNS モード）](#style-evolutionsns-モード)
- [RAFT データセット生成](#raft-データセット生成)
- [HyDE 仮説パッセージ生成](#hyde-仮説パッセージ生成)
- [Judge LLM と Eval Tracing](#judge-llm-と-eval-tracing)
- [JSONL 出力スキーマ](#jsonl-出力スキーマ)
- [並行制御とキャンセル](#並行制御とキャンセル)
- [永続化レイヤー](#永続化レイヤー)
- [工学的基盤：採用した先行研究と手法の解説](#工学的基盤採用した先行研究と手法の解説)
- [合成評価データセットの限界と緩和策](#合成評価データセットの限界と緩和策)
- [実運用での使い方](#実運用での使い方)
- [参考文献](#参考文献)

---

## なぜ評価データセットが必要なのか

RAG システムの検索品質を定量的に評価するには、「どのクエリに対して、どのドキュメントが返されるべきか」を定義した**評価データセット**が不可欠です。しかし、この評価データセットを人手で作成するのは非常にコストが高く、検索対象のドキュメントが数千〜数万件に及ぶ場合には現実的ではありません。

Eval Dataset Generator は、Azure AI Search インデックス内の**実ドキュメント**から Azure OpenAI を使って評価データセットを自動生成する機能です。「LLM に質問を投げてクエリを返すだけ」の機能ではなく、**生成後の品質フィルター、難化、実トラフィック近似、学習向け拡張、評価向けメタデータ付与まで含む多段階パイプライン**です。

---

## なぜ GRADE か — 合成クエリ生成の三大欠陥と設計原則

既存の合成クエリ生成ツールの多くは「文書 → LLM → 質問リスト」で止まります。しかしそれだけでは、**生成したデータで何かを評価したとき、その結論は信頼できるのか？**という問いに答えられません。GRADE が 13 段のパイプラインを持つのは、この問いに対する工学的な回答です。

### 合成クエリの三大欠陥を構造で潰す

| 欠陥 | 起きること | GRADE パイプライン上の対策 |
|---|---|---|
| **Self-fulfilling bias** | 生成元 doc が必ず検索上位に来る前提で評価が甘くなる | Step ⑤ Round-trip Consistency: 現行設定で実際に top-k に入らないクエリを棄却 |
| **Distribution shift** | LLM 生成文はきれいすぎて実ユーザーと乖離 | Step ⑧ Style Evolution（SNS mode）: keyword / typo / colloquial / code-switch で実トラフィックに近似 |
| **Homogeneity** | 同じ言い回しが何度も出て多様性がない | Step ④ Surface Dedup + Step ⑥ Semantic Dedup: 表層・意味の二重フィルターで圧縮 |

### 評価用途と学習用途を 1 本のパイプラインで兼ねる

通常、検索評価データセットと fine-tuning 用データセットは**別々の工程**で作ります。GRADE はパイプラインの前半（Step ⓪〜⑩）で検索評価用の JSONL を仕上げつつ、後半のオプション（Step ⑪ RAFT / Step ⑫ HyDE）で学習用素材も同時に生成します。

| 用途 | 出力フィールド |
|---|---|
| 検索評価 | `query` + `expected_ids` + `hard_negative_ids` + `relevance_grades` |
| RAFT fine-tuning | `question` + `context[oracle + distractors]` + `cot_answer` |
| HyDE ベクトル検索 | `query` + `hyde_hypothesis`（vectorText 入力として即座に利用可能） |

### 段階的 ON/OFF で費用対効果を制御できる

すべてのステップを有効にすれば最大品質のデータセットが得られますが、トークンコストもそのぶん膨らみます。GRADE は**各段を独立に ON/OFF 可能**に設計されています。

```text
最小構成（LLM 1回/doc）:
  Sampling → Generation → Surface Dedup → Export

推奨構成（信頼性重視）:
  + Adaptive Sampling + Grounding + Semantic Dedup + Relevance Grading

最大構成（学習データ兼用）:
  + Ragas mode + Difficulty + SNS + Hard Negative + RAFT + HyDE
```

最小構成なら LLM コールはドキュメント数ぶんだけで済み、残りはすべてローカル計算か Search REST API です。「とりあえず 10 件で試す → 品質を確認 → 本番用に 100 件で全段 ON」という段階的スケールアップが無理なく可能です。

---

## アーキテクチャ概要

Eval Dataset Generator は、以下のレイヤーで構成されています。

```mermaid
block-beta
  columns 7
  UI["EvalDatasetGenerator.tsx\n（UI コンポーネント）"]:7
  Hook["useEvalDatasetGeneration.ts\n（パイプラインオーケストレーション）"]:7
  Detect["Detection\n.ts"]:1
  Sampling["Sampling\n.ts"]:1
  Generator["Generator\n.ts"]:1
  Grounding["Grounding\n.ts"]:1
  StyleEvol["StyleEvol\n.ts"]:1
  Ragas["Ragas\n.ts"]:1
  Entities["Entities\n.ts"]:1
  Prompts["evalDatasetPrompts.ts（プロンプト構築：Classic / Ragas / Evol / RAFT / HyDE）"]:7
  Auth["llmAuth.ts（Generation LLM + Judge LLM 認証）"]:7
  Storage["永続化: localStorage / IndexedDB + EdgResultsTable（Trace ビュー）"]:7

  style UI fill:#4a9eff,color:#fff
  style Hook fill:#6c5ce7,color:#fff
  style Detect fill:#a29bfe,color:#fff
  style StyleEvol fill:#fd79a8,color:#fff
  style Prompts fill:#00b894,color:#fff
  style Auth fill:#fdcb6e,color:#333
  style Storage fill:#636e72,color:#fff
```

### モジュール一覧

| モジュール | 役割 |
|---|---|
| `evalDatasetSampling.ts` | Index Structure Detection + Adaptive Sampling（構造検出 → 最適サンプリング） |
| `evalDatasetGenerator.ts` | Azure OpenAI Chat Completions 呼び出し、JSON パース、表層重複排除、JSONL 変換、RAFT CoT 生成、HyDE 仮説生成 |
| `evalDatasetPrompts.ts` | Classic / Ragas / Evol-Instruct / RAFT / HyDE 各モードのシステム/ユーザープロンプト構築 |
| `evalDatasetGrounding.ts` | Round-trip Consistency フィルター、Hard Negative Mining、Distractor 取得 |
| `evalDatasetEmbeddings.ts` | Azure OpenAI Embeddings によるセマンティック重複排除 |
| `evalDatasetRagas.ts` | Ragas 4象限シナリオプランニングと Multi-hop ペアリング |
| `evalDatasetEntities.ts` | LLM ベースのエンティティ抽出（Entity-KG） |
| `evalDatasetStyleEvolution.ts` | Style Evolution（SNS モード）— 5 種の表層劣化 |

---

## Index Structure Detection + Adaptive Sampling

### なぜ適応的サンプリングが必要なのか

Azure AI Search のインデックスには大きく分けて**2つの構造パターン**があります。

```mermaid
flowchart TD
  subgraph "Chunked（親子構造）"
    direction TB
    P1["📄 Source Document A"]
    C1["chunk-1\n(段落1)"]
    C2["chunk-2\n(段落2)"]
    C3["chunk-3\n(段落3)"]
    P1 --> C1
    P1 --> C2
    P1 --> C3
  end

  subgraph "Independent（独立構造）"
    direction TB
    D1["📄 Document 1"]
    D2["📄 Document 2"]
    D3["📄 Document 3"]
    D4["📄 Document 4"]
  end

  style P1 fill:#6c5ce7,color:#fff
  style D1 fill:#00b894,color:#fff
  style D2 fill:#00b894,color:#fff
  style D3 fill:#00b894,color:#fff
  style D4 fill:#00b894,color:#fff
```

**Chunked インデックス**（RAG で最も一般的）では、1つのソースドキュメントが複数のチャンクに分割されてインデックスに格納されています。シンプルな `search=*&top=N` サンプリングでは、**同じソースドキュメントの異なるチャンクを重複サンプリングしてしまう**問題がありました。

**Independent インデックス**では各ドキュメントが独立した単位ですが、`search=*&top=N` は常にインデックスの先頭から N 件を返すため、**インデックス全体から均一にサンプリングできない**問題がありました。

### 検出アルゴリズム

Index Structure Detection は **LLM 呼び出し 0 回**で動作し、GET（スキーマ取得）+ POST（ファセットプローブ）の最大 2 API コールで完了します。

```mermaid
flowchart TD
    START["検出開始"]
    SCHEMA["① GET index definition\n（スキーマ取得）"]
    SCAN["② フィールド名をヒューリスティックリストと照合"]
    FOUND{"parent 候補\nフィールドあり？"}
    FACET["③ Facet Query\n`search=*, top:0, facets:[field,count:0]`"]
    RATIO{"distinct 値 < doc 数？"}
    CHUNKED["✅ chunked\n`type: 'chunked'`\n`parentField: 'xxx'`\n`parentCount: N`"]
    INDEPENDENT["✅ independent\n`type: 'independent'`"]
    UNKNOWN["⚠️ unknown\n（フォールバック）"]

    START --> SCHEMA --> SCAN --> FOUND
    FOUND -->|Yes| FACET
    FOUND -->|No| INDEPENDENT
    FACET --> RATIO
    RATIO -->|"Yes (chunks/source > 1)"| CHUNKED
    RATIO -->|"No (1:1)"| INDEPENDENT
    FACET -.->|"Error"| UNKNOWN

    style CHUNKED fill:#6c5ce7,color:#fff
    style INDEPENDENT fill:#00b894,color:#fff
    style UNKNOWN fill:#636e72,color:#fff
```

ヒューリスティックリスト（優先順位順）:

```typescript
const PARENT_FIELD_HEURISTICS: string[] = [
  'parent_id', 'parent_key', 'parentId', 'parentKey',
  'metadata_storage_path', 'metadata_storage_name',
  'source_url', 'source_uri', 'sourceUrl', 'source',
  'title', 'document_title', 'file_name', 'fileName',
]
```

検出結果は以下の型で返されます。

```typescript
interface IndexStructureInfo {
  type: 'chunked' | 'independent' | 'unknown'
  parentField?: string      // チャンクのグループ化に使用するフィールド
  parentCount?: number      // distinct なソース数
  documentCount: number     // インデックス内の総ドキュメント数
  reason: string            // UI ツールチップ表示用の検出根拠
}
```

### 3 つのサンプリング戦略

検出結果に基づき、`sampleDocsAdaptive()` が最適なサンプリング戦略を自動選択します。

```mermaid
flowchart TD
    DETECT["Index Structure\nDetection"]
    SWITCH{"type ?"}
    CHUNKED["Chunked 戦略\n1. Facet → source 値一覧取得\n2. ランダムに N 個選択\n3. 各 source から最長チャンク 1 件取得"]
    INDEP["Independent 戦略\n1. $count で総数取得\n2. $skip オフセットを分散配置\n（ランダムジッター付き）\n3. 各オフセットから 1 件取得"]
    SIMPLE["Simple 戦略\nsearch=*&top=N\n（フォールバック）"]

    DETECT --> SWITCH
    SWITCH -->|chunked| CHUNKED
    SWITCH -->|independent| INDEP
    SWITCH -->|unknown| SIMPLE

    style CHUNKED fill:#6c5ce7,color:#fff
    style INDEP fill:#00b894,color:#fff
    style SIMPLE fill:#636e72,color:#fff
```

**Chunked 戦略の詳細**:

```mermaid
sequenceDiagram
    participant EDAG as Eval Dataset Generator
    participant Search as Azure AI Search

    EDAG->>Search: Facet Query<br/>facets: ["parent_id,count:500"]
    Search-->>EDAG: 500 source values + counts

    Note over EDAG: Fisher-Yates Shuffle → N 個選択

    loop 選択された各 source（並行度 5）
        EDAG->>Search: $filter: parent_id eq 'source_X'<br/>$top: 50, $select: [key, content]
        Search-->>EDAG: チャンク一覧
        Note over EDAG: 最長チャンクを代表として選択<br/>残りのチャンク ID を siblingIds に記録
    end
```

**最長チャンクを選ぶ理由**: 長いチャンクはより多くの情報を含み、LLM がより質の高いクエリを生成できます。短すぎるチャンク（ヘッダーのみ、目次のみ等）を避けることで、生成品質が安定します。

**Independent 戦略**: `$skip` オフセットを分散配置（stride = total / sampleSize）し、ランダムジッターを加えてインデックス全体から均一にサンプリングします。`$skip` は Azure AI Search の制限（100,000）にキャップされます。

### Sibling-Aware Grounding

Chunked インデックスでは、サンプリング時に各ドキュメントに `siblingIds`（同じ source に属する他のチャンク ID の配列）を付与します。Round-trip Consistency チェック時に候補 ID を兄弟チャンクまで拡張することで、「正解は同じソースの別チャンクに含まれている」ケースでの False Negative 棄却を防ぎます。

---

## 2つの生成モード：Classic と Ragas

### Classic モード

最もシンプルな生成モードです。インデックスから N 件のドキュメントをサンプリングし、各ドキュメントに対して Azure OpenAI で M 件のクエリを生成します。

```
ドキュメント D1 → クエリ Q1-1, Q1-2, ..., Q1-M
ドキュメント D2 → クエリ Q2-1, Q2-2, ..., Q2-M
  ...
ドキュメント DN → クエリ QN-1, QN-2, ..., QN-M
```

プロンプトは **InPars/Promptagator スタイル**を採用しています。ドキュメントのテキストを最大 4,000 文字でトランケートし、`response_format: { type: 'json_object' }` で Azure OpenAI に JSON 形式の出力を強制します。温度は `0.3` に設定し、多様性と一貫性のバランスを取っています。

### Ragas モード

[Ragas](https://docs.ragas.io/) の評価体系に着想を得た高度な生成モードです。クエリを**4象限**に分類し、直交軸として **Persona・Style・Length** を組み合わせることで、現実世界の多様なクエリ分布を模倣します。

```
                   Specific（事実検索）       Abstract（合成・比較）
                 ┌────────────────────┬────────────────────────────┐
  Single-Hop     │ single_specific    │ single_abstract            │
  （単一文書）    │ "X とは何ですか？"  │ "X はどう発展しましたか？"   │
                 ├────────────────────┼────────────────────────────┤
  Multi-Hop      │ multi_specific     │ multi_abstract             │
  （複数文書横断）│ "A と B の違いは？" │ "A, B, C の進化をまとめて" │
                 └────────────────────┴────────────────────────────┘
```

各象限への割当数は **Largest-Remainder 法**（最大剰余法）で決定します。これはユーザーが指定した百分率分布（デフォルト: `single_specific: 50%`, `single_abstract: 20%`, `multi_specific: 20%`, `multi_abstract: 10%`）を整数に変換する際に、端数の切り捨てで生じる誤差を最小化する手法です。

```typescript
// 概念的な実装
function distributionToCounts(distribution, totalQueries) {
  const exact = Object.entries(distribution).map(([k, pct]) => ({
    key: k, count: totalQueries * pct / 100
  }));
  // 1. floor で整数部分を割当て
  const floored = exact.map(e => ({ ...e, int: Math.floor(e.count) }));
  // 2. 残余を降順ソートし、1ずつ加算して合計を一致させる
  const remainder = totalQueries - sum(floored.map(e => e.int));
  const sorted = floored.sort((a, b) => frac(b.count) - frac(a.count));
  for (let i = 0; i < remainder; i++) sorted[i].int += 1;
  return sorted;
}
```

**Multi-hop ペアリング**では、ドキュメント間の **Token Jaccard 類似度**（NFKC 正規化 + Unicode 句読点分割）を計算し、一定の類似度範囲内（閾値〜0.95）にあるドキュメントペアを見つけます。Entity-KG を有効化した場合は、LLM で抽出した固有名詞のエンティティ集合間の Jaccard に置き換えることで、より意味的に適切なペアリングが可能になります。

**Same-source pair exclusion**: Adaptive Sampling でチャンクインデックスが検出された場合、`parentId` が同じドキュメント同士のペアリングは**自動的に除外**されます。同一ソース由来のチャンク 2 本で「cross-document question」を作っても評価として意味がないためです。

---

## GRADE パイプライン（13段階品質パイプライン）

Eval Dataset Generator の最大の特徴は、生成されたクエリに対して**13段階の品質パイプライン（GRADE）**を逐次適用する点です。各ステージはオプトインで有効化でき、任意の組み合わせで利用できます。

```mermaid
flowchart TD
  S0["⓪ Index Structure\nDetection"]
  S1["① Adaptive\nSampling"]
  S2["② Scenario\nPlanning"]
  S3["③ クエリ生成\n(LLM)"]
  S4["④ 表層重複排除\n(Jaccard)"]
  S5["⑤ Round-trip\nConsistency"]
  S6["⑥ セマンティック\n重複排除"]
  S7["⑦ Difficulty\nEvolution"]
  S8["⑧ Style\nEvolution"]
  S9["⑨ Hard Negative\nMining"]
  S10["⑩ Relevance\nGrading"]
  S11["⑪ RAFT\n(CoT Answer)"]
  S12["⑫ HyDE\n(Hypothesis)"]
  DONE["✅ 完了"]

  S0 --> S1 --> S2 --> S3 --> S4 --> S5 --> S6
  S6 --> S7 --> S8 --> S9 --> S10 --> S11 --> S12 --> DONE

  style S0 fill:#a29bfe,color:#fff
  style S1 fill:#0984e3,color:#fff
  style S2 fill:#6c5ce7,color:#fff
  style S3 fill:#6c5ce7,color:#fff
  style S4 fill:#00b894,color:#fff
  style S5 fill:#e17055,color:#fff
  style S6 fill:#00b894,color:#fff
  style S7 fill:#fdcb6e,color:#333
  style S8 fill:#fd79a8,color:#fff
  style S9 fill:#e17055,color:#fff
  style S10 fill:#0984e3,color:#fff
  style S11 fill:#00cec9,color:#fff
  style S12 fill:#6c5ce7,color:#fff
  style DONE fill:#2d3436,color:#fff
```

> **凡例**: 🟣 構造検出/生成 / 🔵 サンプリング/メタデータ付与 / 🟢 重複排除系 / 🔴 検索検証系 / 🟡 難化系 / 🩷 表層劣化系 / 🩵 拡張データセット生成

| # | ステップ | 何をするか | 引用技術名 | コスト源 | 必須/任意 |
|---|---|---|---|---|---|
| ⓪ | Index Structure Detection | スキーマ + facet でインデックス構造を自動判定 | — (独自) | Search REST ×2 | 任意（デフォルト ON） |
| ① | Document Sampling | 判定結果に応じた Adaptive Sampling で多様性を確保 | — (独自) | Search REST | 必須 |
| ② | Scenario Planning | 4象限 × Persona × Style × Length に割当て | Ragas, RAGEval | ローカル計算 | Ragas mode 時のみ |
| ③ | Query Generation | Azure OpenAI JSON mode でクエリ合成 | InPars, RAGEval | LLM（生成） | 必須 |
| ④ | Surface Dedup | Token Jaccard ≥ 0.85 を除外 | — (Jaccard) | ローカル計算 | 常時有効 |
| ⑤ | Round-trip Consistency | 再検索で expected_ids が top-k に入るか検証 | Promptagator | Search REST | 任意 |
| ⑥ | Semantic Dedup | Embedding cosine で意味重複を除外 | — (Embedding cosine) | Embeddings API | 任意 |
| ⑦ | Difficulty Evolution | Evol-Instruct 風に harder variant へ書き換え | Evol-Instruct | LLM（Judge） | 任意 |
| ⑧ | Style Evolution (SNS) | 実ユーザー風の表層崩しを適用 | — (独自) | LLM（Judge） | 任意 |
| ⑨ | Hard Negative Mining | top-k の非正解 doc id を hard_negative_ids に格納 | DPR | Search REST | 任意 |
| ⑩ | Relevance Grading | NDCG/XDCG 互換の relevance_grades を付与 | TREC / NDCG | ローカル計算 | 任意 |
| ⑪ | RAFT mode | oracle + distractor で CoT 回答を生成 | RAFT | LLM（Judge）+ Search REST | 任意 |
| ⑫ | HyDE mode | 仮想回答 passage をベクトル検索入力用に生成 | HyDE | LLM（Judge） | 任意 |

### Stage ③: Query Generation — Content Filter リトライ

Azure OpenAI の Content Filter が 400 で発火した場合、現行コードは最大 3 回まで自動リトライします。リトライごとに `temperature` を段階的に引き上げ、異なる生成パターンを試行することで Content Filter の発火を回避できる可能性を高めます。

```text
attempt 0: temperature = 0.30
attempt 1: temperature = 0.45  (delay: 1s)
attempt 2: temperature = 0.60  (delay: 2s)
attempt 3: temperature = 0.75  (delay: 3s)
```

3 回超過しても解消しなければ例外として伝搬しますが、パイプライン全体は当該ドキュメントをスキップして次へ進みます。

### Stage ④: Surface Dedup（表層重複排除）

生成されたクエリ間の**トークンレベル Jaccard 類似度**を計算し、閾値 0.85 以上の重複を除去します。

```
Jaccard(A, B) = |A ∩ B| / |A ∪ B|
```

テキストは NFKC 正規化後に Unicode の句読点で分割してトークン化します。Greedy Forward Scan アルゴリズムにより、先着のクエリを優先して保持します。

### Stage ⑤: Round-trip Consistency（Promptagator + Sibling-Aware）

[Dai et al., ICLR 2023](https://arxiv.org/abs/2209.11755) の Promptagator 手法に着想を得たフィルターです。生成されたクエリで**実際のインデックスを再検索**し、元のソースドキュメントが top-k 結果に含まれるかを検証します。

Chunked インデックスの場合は、候補 ID を `siblingIds` まで拡張し、同じソースの兄弟チャンクが検索結果に含まれていれば grounded と判定します。Multi-hop クエリの場合は、`expected_ids` のいずれかが top-k 内にあれば grounded と判定します。

```
クエリ "Azure のセマンティック検索とは？"
  → search API で再検索
  → source doc (+ siblings) が top-10 に含まれる？
    → Yes: grounding_rank = 3 (grounded)
    → No:  rejected = true, rejection_reason = 'grounding'
```

### Stage ⑥: Semantic Dedup（セマンティック重複排除）

Stage ④ の Jaccard では検出できない**パラフレーズ重複**を排除するために、Azure OpenAI Embeddings API でクエリをベクトル化し、**コサイン類似度**で重複を検出します。

```
cosine(a, b) = dot(a, b) / (‖a‖ · ‖b‖)
```

バッチサイズ 16 で Embeddings API を呼び出し、閾値（デフォルト 0.92）以上のペアを重複として除去します。

### Stage ⑦: Difficulty Evolution（Evol-Instruct）

[WizardLM の Evol-Instruct](https://arxiv.org/abs/2304.12244) 手法に基づき、生成済みのクエリを LLM で**より難しいバリアント**に書き換えます。具体的には、パラフレーズ・否定表現・集約・一段階の抽象化・同義語置換といった戦略を適用します。

```
easy: "Azure AI Search のセマンティックランカーとは？"
  ↓ Evol-Instruct LLM rewrite
hard: "セマンティックランカーを無効化した場合、ハイブリッド検索の精度にどのような影響があるか？"
```

書き換えに失敗した場合は元のクエリ（`difficulty: 'easy'`）をそのまま保持する**グレースフルデグレード**設計です。

### Stage ⑨: Hard Negative Mining（DPR スタイル）

[DPR（Dense Passage Retrieval）](https://arxiv.org/abs/2004.04906)の対比学習から着想を得ています。各クエリで top-k 検索を実行し、`expected_ids` に**含まれない**上位 k 件を `hard_negative_ids` として記録します。

```json
{
  "query": "ベクトル検索の設定方法",
  "expected_ids": ["doc-020"],
  "hard_negative_ids": ["doc-055", "doc-033"]
}
```

### Stage ⑩: Relevance Grading（NDCG 互換）

各ドキュメントに**段階的な関連度スコア**を自動付与します。このステージは LLM を使わず、**ローカル計算のみ**で実行されます。

| ドキュメント | スコア | 説明 |
|---|---|---|
| `source_doc_id`（Primary Anchor） | 3 | 最も関連度が高い |
| 残りの `expected_ids`（Secondary） | 2 | 副次的に関連 |
| `hard_negative_ids` | 0 | 関連性なし |

このスコアは **NDCG（Normalized Discounted Cumulative Gain）** および **XDCG** で直接利用可能な形式であり、Azure AI Foundry の Document Retrieval Evaluator や TREC 系の評価器にそのまま入力できます。

### Domain Schema 注入（RAGEval）

オプションとして、ドメイン固有の**エンティティ・関係・制約**をプロンプトに注入できます。これにより、生成されるクエリの事実性とスキーマ整合性が向上します。

```typescript
interface DomainSchema {
  entities?: string    // 例: "Azure AI Search, セマンティックランカー, HNSW"
  relations?: string   // 例: "セマンティックランカーはハイブリッド検索を強化する"
  constraints?: string // 例: "API バージョンは 2024-07-01 以降が必要"
}
```

---

## Style Evolution（SNS モード）

### なぜクエリの表層劣化が必要なのか

LLM が生成するクエリは**文法的に完璧で、語彙が整いすぎている**という根本的な問題があります。現実のユーザーは以下のような「乱雑な」クエリを入力します。

| 実ユーザーの検索 | LLM が生成する検索 |
|---|---|
| `azure 検索 ベクトル 設定` | `Azure AI Search でベクトル検索を設定する方法は？` |
| `セマンティックランカーってなに` | `セマンティックランカーの機能と用途を説明してください` |
| `hnsw パラメタ efSearch` | `HNSW アルゴリズムの efSearch パラメータの最適値はいくつですか？` |
| `AI serch hybrit search` | `Azure AI Search でハイブリッド検索を実行するにはどうすればよいですか？` |

検索エンジンが**整形されたクエリでしか評価されない**と、実トラフィックでの品質劣化を見逃すリスクがあります。Style Evolution は、品質パイプラインの Stage ⑧ で LLM 生成クエリを**意図的に「劣化」**させ、実ユーザーの表層パターンを再現します。

### 5 種類の劣化パターン

```mermaid
mindmap
  root((Style Evolution<br/>SNS モード))
    keyword
      助詞・接続詞を除去
      名詞のみのキーワード列
      "ベクトル検索 設定 方法"
    colloquial
      口語・SNS 風
      「〜って何」「〜わからん」
      文法崩れ・省略
    typo
      隣接キー置換
      文字欠落
      文字重複
    abbreviated
      主語省略
      冗長な文脈語を削除
      最小限の入力
    code_switch
      日英混在
      専門用語を他言語で表記
      "semantic rankerって何"
```

| Kind | 説明 | 入力例 | 出力例 |
|---|---|---|---|
| `keyword` | 助詞・接続詞を除去してキーワード列に | `ベクトル検索の設定方法は？` | `ベクトル検索 設定 方法` |
| `colloquial` | SNS・口語形式に変換 | `セマンティック検索とは何ですか？` | `セマンティック検索ってなに` |
| `typo` | 1〜2 箇所のリアルなタイポを挿入 | `hybrid search configuration` | `hybrit search configration` |
| `abbreviated` | 主語・文脈語を省略して最小化 | `Azure AI Search でフィルターを使う方法` | `フィルター 使い方` |
| `code_switch` | 日英をミックスした表現に | `HNSW のパラメータ設定` | `HNSW parameter設定` |

### 実装アーキテクチャ

```mermaid
sequenceDiagram
    participant Hook as useEvalDatasetGeneration
    participant SE as evalDatasetStyleEvolution
    participant LLM as Azure OpenAI (Judge LLM)

    Hook->>SE: degradeQuery({ query, language, allowedKinds })
    SE->>SE: pickKind(allowedKinds)<br/>ランダムに 1 種選択
    SE->>SE: buildStyleDevolSystemPrompt(kind, language)
    SE->>LLM: System Prompt + Query
    LLM-->>SE: 劣化後クエリ（テキスト直接）
    SE->>SE: Strip quotes, normalize NFC
    SE-->>Hook: { degraded, kind }
```

**設計上のポイント**:

- **JSON mode を使わない**: 出力は純テキスト（`jsonMode: false`）。JSON ラッパーを要求すると表層劣化の「自然さ」が失われるため
- **Judge LLM を使用**: 生成 LLM とは別のデプロイメントで実行可能（コスト/品質分離）
- **ランダム選択**: `allowedKinds` 配列からランダムに 1 種を選択。空の場合は全 5 種から均等サンプリング
- **グレースフルデグレード**: 劣化結果が元クエリと NFC 正規化後に同一の場合、`style_evolution_kind` は記録されない

---

## RAFT データセット生成

### RAFT とは何か

**論文**: Zhang, T. et al., *"RAFT: Adapting Language Model to Domain Specific RAG"*, 2024 (arXiv:2403.10131)

RAFT は、RAG システムにおいて**ドメイン固有の正確な回答を生成できるように LLM をファインチューニング**するための訓練データ形式です。核となるアイデアは、LLM に「正解の文書（Oracle）」と「紛らわしいが不正解な文書（Distractor）」を同時に提示し、**正解文書を自ら見つけ出して引用しながら回答する能力**を学習させることです。

```mermaid
flowchart TD
    subgraph "RAFT 学習データの構造"
        Q["Question\n'ベクトル検索の設定方法は？'"]
        CTX["Context (5 docs)"]
        D1["Doc 1 ❌ Distractor\n(インデックス作成の話)"]
        D2["Doc 2 ❌ Distractor\n(スコアリングの話)"]
        D3["Doc 3 ✅ Oracle\n(ベクトル検索の設定手順)"]
        D4["Doc 4 ❌ Distractor\n(セマンティックの話)"]
        D5["Doc 5 ❌ Distractor\n(フィルターの話)"]
        ANS["CoT Answer\n##Reason: Doc 3 contains...\n##begin_quote## ... ##end_quote##\n<ANSWER>: ..."]

        Q --> CTX
        CTX --> D1
        CTX --> D2
        CTX --> D3
        CTX --> D4
        CTX --> D5
        Q --> ANS
        D3 -.->|"引用"| ANS
    end

    style D3 fill:#00b894,color:#fff
    style D1 fill:#d63031,color:#fff
    style D2 fill:#d63031,color:#fff
    style D4 fill:#d63031,color:#fff
    style D5 fill:#d63031,color:#fff
```

### Chain-of-Thought 回答生成

RAFT モードでは、以下のプロンプト設計で CoT 回答を生成します。

**システムプロンプトの要件**:
- 複数のドキュメントを受け取り、1つだけがオラクル（正解）
- ステップバイステップの推論を提示
- 引用部分を `##begin_quote##` / `##end_quote##` で囲む
- 最終回答は `<ANSWER>:` プレフィックス付き
- ディストラクターの情報を根拠にしてはいけない

**重要な設計判断**: Oracle ドキュメントは Distractor の中に **Fisher-Yates Shuffle** でランダムに配置されます。これにより、モデルが「常に N 番目の文書が正解」という位置バイアスを学習することを防ぎます。

### Oracle + Distractor コンテキスト構築

```mermaid
sequenceDiagram
    participant Hook as useEvalDatasetGeneration
    participant Ground as evalDatasetGrounding
    participant Search as Azure AI Search
    participant LLM as Azure OpenAI (Judge LLM)

    Note over Hook: Stage ⑪: RAFT（各 kept item に対して）

    Hook->>Hook: oracleText = docTextById[source_doc_id]

    Hook->>Ground: fetchDistractorDocs({<br/>  query, expectedIds,<br/>  count: raftDistractorCount<br/>})
    Ground->>Search: search=query, top=count+len(expectedIds)<br/>$select=[keyField, contentFields]
    Search-->>Ground: 検索結果
    Ground->>Ground: expectedIds を除外<br/>→ 上位 N 件を Distractor として返却
    Ground-->>Hook: distractors: [{id, text}, ...]

    Hook->>LLM: buildRaftAnswerPrompt({<br/>  question, oracleDoc,<br/>  distractorDocs<br/>})
    LLM-->>Hook: { "cot_answer": "##Reason: ... <ANSWER>: ..." }

    Hook->>Hook: item.raft_cot_answer = cotAnswer<br/>item.raft_context = [oracle, ...distractors]
```

**Distractor の選定基準**: クエリで実際の検索を実行し、`expected_ids` に含まれない上位結果を Distractor として使います。これは Hard Negative Mining と同じ原理 — 「検索エンジンが返しやすいが正解ではない文書」こそが、最も有効な Distractor です。

**トランケーション戦略**: 各ドキュメントのテキストは `MAX_CHUNK_CHARS / (1 + distractorCount)` で均等にバジェットを割り当て、コンテキストウィンドウ内に収まるようにします。

### RAFT JSONL 出力スキーマ

```json
{
  "question": "ベクトル検索の設定方法は？",
  "context": [
    { "doc_id": "doc-020", "text": "ベクトル検索を設定するには...", "oracle": true },
    { "doc_id": "doc-055", "text": "スコアリングプロファイルは...", "oracle": false },
    { "doc_id": "doc-033", "text": "インデックス作成時に...", "oracle": false },
    { "doc_id": "doc-041", "text": "セマンティック構成の...", "oracle": false },
    { "doc_id": "doc-072", "text": "フィルター式の構文...", "oracle": false }
  ],
  "cot_answer": "##Reason: The question asks about vector search configuration. Looking at the documents, Document 1 (doc-020) contains the relevant setup instructions. ##begin_quote## ベクトル検索を設定するには... ##end_quote## <ANSWER>: ベクトル検索を設定するには、vectorSearch セクションで algorithms と profiles を定義し...",
  "expected_ids": ["doc-020"],
  "query_type": "how-to",
  "language": "ja",
  "source_doc_id": "doc-020",
  "generation_model": "gpt-5.4-mini",
  "provenance": "synthetic",
  "generated_at": "2026-04-27T14:00:00.000Z",
  "generated_against_index": "my-rag-index",
  "generation_run_id": "edg-abc-456"
}
```

---

## HyDE 仮説パッセージ生成

### HyDE の理論的背景

**論文**: Gao, L. et al., *"Precise Zero-Shot Dense Retrieval without Relevance Labels (HyDE)"*, ACL 2023

従来のベクトル検索では、ユーザーのクエリをそのまま埋め込みベクトルに変換して検索します。しかし、クエリ（短い質問文）とドキュメント（長い説明文）は**埋め込み空間上で異なる分布**に位置するため、類似度が低くなることがあります。

HyDE は、クエリに対する「**仮想的な回答文書**」を LLM で生成し、その仮説パッセージを埋め込みベクトルに変換して検索する手法です。仮説パッセージはドキュメントと同じ形式・語彙を持つため、ベクトル空間上でのアライメントが改善されます。

```mermaid
flowchart LR
    subgraph "従来のベクトル検索"
        Q1["クエリ\n'HNSW の設定方法'"]
        E1["Embed(クエリ)"]
        S1["Vector Search"]
        R1["検索結果"]
        Q1 --> E1 --> S1 --> R1
    end

    subgraph "HyDE ベクトル検索"
        Q2["クエリ\n'HNSW の設定方法'"]
        LLM2["LLM 仮説生成"]
        H2["仮説パッセージ\n'HNSW は近似最近傍\n探索アルゴリズムで...'"]
        E2["Embed(仮説)"]
        S2["Vector Search"]
        R2["検索結果\n（改善）"]
        Q2 --> LLM2 --> H2 --> E2 --> S2 --> R2
    end

    style H2 fill:#6c5ce7,color:#fff
    style R2 fill:#00b894,color:#fff
```

### 仮説パッセージ生成

パイプラインの最終段階（Stage ⑫）で各 kept アイテムに対して仮説パッセージを生成します。

**プロンプト設計**:
- 100〜200 語程度の自然な文章を生成
- 具体的で情報豊富な内容
- ベクトル検索でマッチしやすい表現を使用
- JSON mode: `{ "hypothesis": string }`

生成された仮説パッセージは以下のフィールドに格納されます。

```json
{
  "query": "HNSW のパラメータ設定方法",
  "hyde_hypothesis": "HNSW (Hierarchical Navigable Small World) は Azure AI Search で使用される近似最近傍探索アルゴリズムです。主要なパラメータには m (各ノードの最大接続数、推奨値4-10)、efConstruction (構築時の探索幅、推奨値400-1000)、efSearch (検索時の探索幅、推奨値500-1000) があります...",
  "hyde_model": "gpt-5.4",
  "hyde_generated_at": "2026-04-27T16:00:00.000Z"
}
```

### AutoTuning との統合

生成された HyDE 仮説パッセージは、Search Parameter AutoTuning の**評価実行時**に活用されます。AutoTuning に新たに追加された **HyDE Eval モード** では、以下の 2 つの適用戦略を選択できます。

| 適用モード | 動作 | 推奨シーン |
|---|---|---|
| `vectorTextOnly` | 仮説パッセージを `vectorText` として使用、`search` は元クエリのまま | ハイブリッド検索の評価 |
| `replaceQueryAndVectorText` | 仮説パッセージで `search` と `vectorText` の両方を置換 | 純粋なベクトル検索の評価 |

```mermaid
flowchart TD
    DATASET["評価データセット\n(hyde_hypothesis 付き)"]
    MODE{"HyDE 適用モード"}
    VTO["vectorTextOnly\nhyde_hypothesis → vectorText\nquery はそのまま"]
    REPLACE["replaceQueryAndVectorText\nhyde_hypothesis → query + vectorText\n元クエリを完全置換"]
    
    DATASET --> MODE
    MODE -->|vectorTextOnly| VTO
    MODE -->|replaceQueryAndVectorText| REPLACE
    
    VTO --> EVAL["AutoTuning 評価実行"]
    REPLACE --> EVAL
    
    style VTO fill:#00b894,color:#fff
    style REPLACE fill:#6c5ce7,color:#fff
```

これにより、「HyDE を使った場合と使わない場合で Recall@k がどう変わるか」を AutoTuning で自動的に A/B 比較できます。

---

## Judge LLM と Eval Tracing

### Judge LLM — 品質フィルター専用デプロイメント

**生成用 LLM** と**品質フィルター用 LLM（Judge LLM）** を分離するオプションです。

```mermaid
flowchart LR
    subgraph "Generation LLM"
        G["gpt-5.4-mini\n(高速・低コスト)"]
    end

    subgraph "Judge LLM"
        J["gpt-5.4\n(高精度・推論力)"]
    end

    GEN["② クエリ生成"] --> G
    DIFF["⑥ Difficulty Evolution"] --> J
    SE["⑦ Style Evolution"] --> J
    RAFT["⑩ RAFT CoT Answer"] --> J
    HYDE["⑪ HyDE Hypothesis"] --> J

    style G fill:#00b894,color:#fff
    style J fill:#e17055,color:#fff
```

| 設定 | 用途 | 推奨モデル |
|---|---|---|
| `llmDeployment` | クエリ生成（Stage ②） | gpt-5.4-mini（高速・低コスト） |
| `judgeLlmDeployment` | 品質フィルター・難化・RAFT・HyDE（Stage ⑥⑦⑩⑪） | gpt-5.4（高精度） |

**分離のメリット**:
- **コスト最適化**: 大量生成には廉価なモデル、品質評価には高精度モデルを使い分け
- **レートリミット分散**: 2 つのデプロイメントに負荷を分散
- **品質向上**: 難化や CoT 回答生成は推論力の高いモデルの方が質が良い

`judgeLlmDeployment` が未設定の場合は `llmDeployment` にフォールバックするため、完全な後方互換性を維持しています。

### Eval Tracing — クエリ変換トレース

`enableTrace: true` を設定すると、各クエリアイテムがパイプラインの**各ステップでどのように変換（または棄却）されたか**をイベントログとして記録します。

```typescript
interface TraceEvent {
  step: number       // 1-based パイプラインステップ番号
  phase: 'generation' | 'surface-dedup' | 'grounding' | 'semantic-dedup' 
       | 'difficulty' | 'style-evolution' | 'hardneg' | 'relevance'
  action: 'created' | 'kept' | 'rejected' | 'modified' | 'enriched'
  timestamp: string  // ISO 8601
  detail?: {
    before?: string              // 変更前のクエリテキスト
    after?: string               // 変更後のクエリテキスト
    reason?: string              // 棄却理由 or アクション理由
    score?: number               // Jaccard / cosine / grounding rank
    styleKind?: StyleEvolutionKind  // Style Evolution で適用された種別
  }
}
```

**ライフサイクル可視化の例**:

```mermaid
flowchart TD
    subgraph "あるクエリの TraceEvent 配列"
        T1["step:1 | generation | created\nafter: 'セマンティック検索とは？'"]
        T2["step:2 | surface-dedup | kept"]
        T3["step:3 | grounding | kept\nscore: 2 (rank=2)"]
        T4["step:4 | semantic-dedup | kept"]
        T5["step:5 | difficulty | modified\nbefore: 'セマンティック検索とは？'\nafter: 'セマンティック検索を無効化した場合の影響は？'"]
        T6["step:6 | style-evolution | modified\nbefore: '...無効化した場合の影響は？'\nafter: 'セマンティック検索 無効化 影響'\nstyleKind: keyword"]
        T7["step:7 | hardneg | enriched\nreason: '3 negatives mined'"]
        T8["step:8 | relevance | enriched\nreason: '4 grades'"]
    end

    T1 --> T2 --> T3 --> T4 --> T5 --> T6 --> T7 --> T8

    style T1 fill:#6c5ce7,color:#fff
    style T5 fill:#fdcb6e,color:#333
    style T6 fill:#fd79a8,color:#fff
    style T7 fill:#e17055,color:#fff
```
#### Query Transformation Trace Result
<img src="./images/screenshot34_jp.png" width="800" />

トレースの活用シーン:
- **パイプラインのデバッグ**: 特定のクエリがどのステップで棄却されたか即座に特定
- **品質フィルターの効果測定**: 各ステージの reject 率や modification 率を集計
- **再現性の確保**: 同一設定での再実行時にトレースを比較し、LLM の非決定性の影響を把握
- **JSONL エクスポート**: `trace` フィールドが JSONL に含まれるため、下流の分析パイプラインでも利用可能

---

## JSONL 出力スキーマ

生成されるデータセットは以下の JSONL 形式です。`rejected` なアイテムはエクスポート時に自動的にフィルタリングされます。

```json
{
  "query": "Azure AI Search のセマンティックランカーは何のために使うのか？",
  "expected_ids": ["doc-123"],
  "query_type": "factoid",
  "language": "ja",
  "source_doc_id": "doc-123",
  "generation_model": "gpt-5.4-mini",
  "provenance": "synthetic",
  "generated_at": "2026-04-21T10:00:00.000Z",
  "generated_against_index": "my-index",
  "generation_run_id": "edg-abc-123",
  "grounding_rank": 1,
  "grounding_top_k": 10,
  "query_shape": "single_specific",
  "persona": "developer",
  "style": "web_search",
  "length": "short",
  "difficulty": "hard",
  "style_evolution_kind": "keyword",
  "hard_negative_ids": ["doc-456", "doc-789"],
  "relevance_grades": { "doc-123": 3, "doc-456": 0, "doc-789": 0 },
  "hyde_hypothesis": "セマンティックランカーは Azure AI Search の機能で...",
  "hyde_model": "gpt-5.4",
  "hyde_generated_at": "2026-04-21T10:05:00.000Z",
  "trace": [
    { "step": 1, "phase": "generation", "action": "created", "timestamp": "...", "detail": { "after": "..." } },
    { "step": 6, "phase": "style-evolution", "action": "modified", "timestamp": "...", "detail": { "styleKind": "keyword" } }
  ]
}
```

### 3 つのエクスポート形式

| 形式 | 用途 | エクスポート関数 |
|---|---|---|
| AutoTuning 互換 JSONL | 検索パラメータ最適化 | `toJsonl()` |
| RAFT JSONL | LLM ファインチューニング | `toRaftJsonl()` |
| HyDE 付き JSONL | ベクトル検索 A/B 評価 | `toJsonl()`（`hyde_*` フィールド含む） |

---

## 並行制御とキャンセル

パイプライン全体は `useEvalDatasetGeneration` React Hook で管理されます。

- **並行度制御**: 生成・難化・Style Evolution・RAFT・HyDE は `CONCURRENCY=3`、Grounding・Hard Negative Mining は `GROUNDING_CONCURRENCY=4` で並行実行
- **ワーカーパターン**: 共有カーソル + 非同期ワーカープールの Producer-Consumer パターンを採用。`cursor++` で次タスクを取得し、`Promise.all(workers)` で全ワーカーの完了を待機
- **キャンセル**: `AbortController` ベース。`cancel()` 呼び出しで `controller.abort()` が発火し、全 fetch リクエストとワーカーが `AbortError` で即座に停止
- **プログレス**: `EdgPhase` 型で各フェーズの進捗をリアルタイム表示

```typescript
type EdgPhase =
  | 'idle'
  | 'detecting'    // ⓪ Index Structure Detection
  | 'sampling'     // ① Adaptive Sampling
  | 'generating'   // ③ Query Generation
  | 'grounding'    // ⑤ Round-trip Consistency
  | 'embedding'    // ⑥ Semantic Dedup
  | 'difficulty'   // ⑦ Difficulty Evolution
  | 'styleevol'    // ⑧ Style Evolution
  | 'hardneg'      // ⑨ Hard Negative Mining
  | 'raft'         // ⑪ RAFT
  | 'hyde'         // ⑫ HyDE
  | 'done'
```

- **認証エラー**: HTTP 401/403 は `LlmAuthError` として即座にパイプライン全体を停止（レートリミットなどの一時的なエラーとは区別）

---

## 永続化レイヤー

| レイヤー | ストレージ | キー | 内容 |
|---|---|---|---|
| データセット | `localStorage` | `ragops.evalDatasets.v1` | 生成済みデータセットの CRUD 操作（id, title, updatedAt, indexName, itemCount, items[]） |
| フォーム設定 | IndexedDB | `AppSettings.evalDatasetFormJson` | 全フォームフィールドの自動保存（300ms debounce）。API Key や Bearer Token を含む |

フォーム設定は IndexedDB に保存されるため、ブラウザを閉じても設定が保持されます。レガシーの `localStorage` からの自動移行にも対応しています。

---

## 工学的基盤：採用した先行研究と手法の解説

Eval Dataset Generator は「プロンプトを 1 本書いて LLM に投げるだけ」の単純な実装ではなく、**情報検索（IR）と自然言語処理（NLP）の最新研究で学術的に有効性が報告された手法**を工学的に組み合わせて設計されています。

```mermaid
mindmap
  root((Eval Dataset<br/>Generator))
    生成
      InPars / Promptagator<br/>Few-shot プロンプティング
      Ragas<br/>4象限シナリオ生成
      RAGEval<br/>Schema-based 生成
    品質フィルター
      Promptagator<br/>Round-trip Consistency
      Evol-Instruct<br/>Difficulty Evolution
      DPR<br/>Hard Negative Mining
    多様性
      Ragas KG<br/>Knowledge Graph ペアリング
      Entity-KG<br/>LLM エンティティ抽出
      Largest-Remainder 法<br/>層化サンプリング
      Style Evolution<br/>SNS モード表層劣化
    評価互換
      NDCG / XDCG<br/>Relevance Grades
      ARES<br/>PPI 統計補正（将来実装予定）
    拡張データセット
      RAFT<br/>Oracle + Distractor CoT
      HyDE<br/>Hypothetical Document Embeddings
    適応基盤
      Index Structure Detection<br/>Schema Heuristics
      Adaptive Sampling<br/>Stratified Extraction
```

### InPars / Promptagator — Few-shot によるクエリ生成

**論文**: Bonifacio et al., *"InPars: Data Augmentation for Information Retrieval using Large Language Models"*, SIGIR 2022 / Dai et al., *"Promptagator: Few-shot Dense Retrieval From 8 Examples"*, ICLR 2023

**課題**: IR モデルの学習には大量の「クエリ ↔ 関連ドキュメント」ペアが必要ですが、人手で作るのは高コストです。

**解決策**: LLM にドキュメントを見せて「このドキュメントに対してユーザーが検索しそうなクエリ」を生成させます。InPars の研究では、few-shot 例を加えることで**生成クエリの検索適合率が 20〜40% 向上**することが示されています。

**GRADE での適用**: Stage ③ Query Generation（Few-shot プロンプティング）および Stage ⑤ Round-trip Consistency Filter。詳細は各ステージの説明を参照してください。

### Ragas — 4象限シナリオによるクエリ多様性

**出典**: [Ragas Testset Generation](https://docs.ragas.io/en/stable/concepts/test_data_generation/rag/)

クエリを **Specific ↔ Abstract** × **Single-Hop ↔ Multi-Hop** の 4 象限に分類し、Persona / Style / Length の直交軸を掛け合わせることで、現実世界のクエリ分布を模倣します。

**GRADE での適用**: Stage ② Scenario Planning。詳細は「2つの生成モード：Classic と Ragas」セクションを参照してください。

### Evol-Instruct — クエリの難化

**論文**: Xu et al., *"WizardLM: Empowering Large Language Models to Follow Complex Instructions"*, arXiv:2304.12244, 2023

パラフレーズ・否定表現・集約・抽象化の戦略でクエリを難化します。難化は元ドキュメントで回答可能な範囲に制約され、失敗時は元のクエリを保持するグレースフルデグレード設計です。

**GRADE での適用**: Stage ⑦ Difficulty Evolution。詳細は該当ステージの説明を参照してください。

### DPR — Hard Negative Mining

**論文**: Karpukhin et al., *"Dense Passage Retrieval for Open-Domain Question Answering"*, EMNLP 2020

DPR の対比学習から着想を得て、クエリの top-k 検索結果のうち `expected_ids` に含まれないドキュメントを Hard Negative として記録します。Hard Negative を評価データセットに含めることで、NDCG などのランキング評価指標がより鋭敏になります。

**GRADE での適用**: Stage ⑨ Hard Negative Mining。詳細は該当ステージの説明を参照してください。

### RAGEval — Domain Schema による生成品質向上

**論文**: Zhu et al., *"RAGEval: Scenario Specific RAG Evaluation Dataset Generation Framework"*, 2024 (arXiv:2408.01262)

ドメインの**エンティティ・関係・制約**を構造化したスキーマをプロンプトに注入することで、生成されるクエリの事実性とスキーマ整合性を向上させます。

### Entity-KG — 軽量ナレッジグラフによる Multi-hop ペアリング

**出典**: Ragas Knowledge Graph + RAGOps Studio 独自実装

```mermaid
flowchart TD
    subgraph "デフォルト（軽量）"
        D1["Doc A のトークン集合"]
        D2["Doc B のトークン集合"]
        TJ["Token Jaccard\n|A∩B| / |A∪B|"]
        D1 --> TJ
        D2 --> TJ
    end

    subgraph "Entity-KG（opt-in）"
        E1["Doc A → LLM エンティティ抽出\n{Azure, HNSW, ベクトル検索}"]
        E2["Doc B → LLM エンティティ抽出\n{Azure, セマンティック検索, BM25}"]
        EJ["Entity Jaccard\n{Azure} / {Azure, HNSW, ベクトル, セマンティック, BM25}"]
        E1 --> EJ
        E2 --> EJ
    end

    TJ -->|"類似度 ∈ [閾値, 0.95)"| PAIR["Multi-hop ペア確定"]
    EJ -->|"類似度 ∈ [閾値, 0.95)"| PAIR

    style PAIR fill:#6c5ce7,color:#fff
```

### ARES / PPI — 統計的バイアス補正（未実装・設計参考）

**論文**: Saad-Falcon et al., *"ARES: An Automated Evaluation Framework for RAG Systems"*, NAACL 2024

> **注**: 本機能は現行バージョンでは未実装です。将来の拡張として設計上の参考文献に含めています。

```mermaid
flowchart LR
    HUMAN["少数の人手ラベル\n(高信頼・高コスト)"]
    SYNTH["大量の合成ラベル\n(低信頼・低コスト)"]
    PPI["PPI\n(Prediction-Powered\nInference)"]
    RESULT["バイアス補正済み\n推定値 + 95% CI"]

    HUMAN --> PPI
    SYNTH --> PPI
    PPI --> RESULT

    style HUMAN fill:#00b894,color:#fff
    style SYNTH fill:#fdcb6e,color:#333
    style PPI fill:#6c5ce7,color:#fff
    style RESULT fill:#0984e3,color:#fff
```

### 手法の全体マップ

```mermaid
flowchart TB
    subgraph "⓪① 構造検出 & サンプリング"
        A0["Index Structure Heuristics\n(Schema + Facet)"]
        A1["Adaptive Sampling\n(Chunked / Independent / Simple)"]
    end

    subgraph "②③ 生成フェーズ"
        B1["InPars / Promptagator\n(Few-shot プロンプティング)"]
        B2["Ragas\n(4象限シナリオ生成)"]
        B3["RAGEval\n(Domain Schema 注入)"]
    end

    subgraph "④⑤⑥ フィルターフェーズ"
        C1["Promptagator\n(Round-trip Consistency\n+ Sibling-Aware)"]
        C2["Jaccard / Cosine\n(2段階重複排除)"]
    end

    subgraph "⑦⑧ 変換フェーズ"
        D1["Evol-Instruct\n(Difficulty Evolution)"]
        D2["Style Evolution\n(SNS モード 5 種)"]
    end

    subgraph "⑨⑩ 拡張フェーズ"
        E1["DPR\n(Hard Negative Mining)"]
        E2["NDCG / XDCG\n(Relevance Grading)"]
    end

    subgraph "⑪⑫ データセット拡張フェーズ"
        F1["RAFT\n(Oracle + Distractor CoT)"]
        F2["HyDE\n(Hypothetical Document\nEmbeddings)"]
    end

    subgraph "横断的"
        G1["Judge LLM\n(Deployment Separation)"]
        G2["Eval Tracing\n(Pipeline Observability)"]
        G3["ARES / PPI\n(統計的バイアス補正)\n※未実装・将来拡張"]
    end

    A0 --> A1 --> B1
    B1 --> C1
    B2 --> C1
    B3 --> C1
    C1 --> C2 --> D1 --> D2 --> E1 --> E2 --> F1 --> F2
    G1 -.->|"使用先"| D1
    G1 -.->|"使用先"| D2
    G1 -.->|"使用先"| F1
    G1 -.->|"使用先"| F2

    style A0 fill:#a29bfe,color:#fff
    style A1 fill:#a29bfe,color:#fff
    style B1 fill:#6c5ce7,color:#fff
    style B2 fill:#6c5ce7,color:#fff
    style B3 fill:#6c5ce7,color:#fff
    style C1 fill:#e17055,color:#fff
    style C2 fill:#00b894,color:#fff
    style D1 fill:#fdcb6e,color:#333
    style D2 fill:#fd79a8,color:#fff
    style E1 fill:#e17055,color:#fff
    style E2 fill:#0984e3,color:#fff
    style F1 fill:#00cec9,color:#fff
    style F2 fill:#6c5ce7,color:#fff
    style G1 fill:#fdcb6e,color:#333
    style G2 fill:#636e72,color:#fff
    style G3 fill:#0984e3,color:#fff
```

---

## 合成評価データセットの限界と緩和策

合成評価データセットは強力なツールですが、**無批判に使うと「自作自演評価」に陥る**リスクがあります。

```mermaid
flowchart TD
    subgraph "既知のリスク"
        R1["Source Leakage\n出題元バイアス"]
        R2["Distribution Shift\nクエリ分布の乖離"]
        R3["Difficulty 偏り\n簡単すぎるクエリ"]
        R4["False Negative\n正解の見逃し"]
        R5["過信リスク\n数値の誤った権威化"]
    end

    subgraph "RAGOps Studio の緩和策"
        M1["Round-trip Consistency\n+ Sibling-Aware Grounding\n+ Relevance Grades"]
        M2["Ragas 4象限\n+ Persona/Style/Length\n+ Style Evolution (SNS)"]
        M3["Evol-Instruct 難化\n+ query_type 多様化"]
        M4["expected_ids 配列\n+ siblingIds\n+ PPI 統計補正（将来実装予定）"]
        M5["provenance: synthetic 明記\n+ UI 警告バナー\n+ Eval Tracing"]
    end

    R1 --> M1
    R2 --> M2
    R3 --> M3
    R4 --> M4
    R5 --> M5
```

| リスク | 内容 | 緩和策 |
|---|---|---|
| **Source Leakage** | チャンクからクエリを生成 → そのチャンクが検索に引っかかれば正解、という循環 | Round-trip Consistency + Sibling-Aware Grounding + `relevance_grades` で段階的評価 |
| **Distribution Shift** | LLM のクエリは語彙・構文が整いすぎて、実ユーザーの曖昧・口語・誤字混じりのクエリを再現しない | Ragas 4象限 × Persona × Style × Length + **Style Evolution（SNS モード）** で実トラフィックを再現 |
| **Difficulty 偏り** | factoid 型の簡単なクエリばかり量産される | Evol-Instruct による難化、4 種の `query_type` 強制分散、multi-hop 横断クエリ生成 |
| **False Negative** | 生成元チャンク以外のドキュメントでも正答可能なケースを誤って不正解と判定する | `expected_ids` を配列設計 + `siblingIds` 拡張 + PPI で人手ラベルとの統計的結合（将来実装予定） |
| **過信リスク** | 合成データのスコアを「本番品質」として意思決定に使ってしまう | `provenance: 'synthetic'` + UI 警告バナー + **Eval Tracing** で判断根拠を透明化 |

> **⚠️ 重要**: 合成評価データセットは、パラメータの A/B 比較や回帰検知には非常に有効ですが、**本番環境の絶対的な品質スコアの代替にはなりません**。本番品質の正確な測定には、少数でも人手でレビューした正解データとの併用を推奨します。

---

## 実運用での使い方

現行実装に合わせるなら、次の順で使うのが安全です。

```text
1. まずは少量サンプル（10件）で生成する
2. Grounding と Trace を ON にして挙動を見る
3. 実データに近づけたいなら SNS mode を追加する
4. 重複が多いなら Semantic Dedup を有効にする
5. 学習再利用まで見据えるなら Hard Negative と relevance_grades を ON にする
6. RAFT と HyDE は評価品質の確認後に追加する
```

このツールは**本番品質の絶対スコアを出す装置**ではなく、**構成比較、回帰検知、初期データ整備を高速化する装置**として使うのが正しい位置づけです。

### Save / Load / AutoTuning 連携

| 機能 | 説明 |
|---|---|
| **Save / Load** | 生成したデータセットを `ragops.evalDatasets.v1` キーで localStorage に保存。あとで同じデータセットを UI から再ロード可能 |
| **Send to AutoTuning** | ダウンロードと再アップロードを挟まずに AutoTuning へ直接渡せる |
| **RAFT / HyDE エクスポート** | 通常の評価 JSONL に加えて、fine-tuning 用データや HyDE vectorText 用素材も同時に出力 |

### コーパスドリフトへの注意

インデックスが更新された後の合成データセットはすぐ古くなります。`generated_against_index` と `generated_at` フィールドを確認し、インデックス更新後はデータセットの再生成を検討してください。

---

## 参考文献

| # | 論文 / プロジェクト | 年 | 会議 | 本機能での活用 |
|---|---|---|---|---|
| 1 | Bonifacio, L. et al. **InPars: Data Augmentation for Information Retrieval using Large Language Models** | 2022 | SIGIR | Few-shot プロンプティングによるクエリ生成 |
| 2 | Dai, Z. et al. **Promptagator: Few-shot Dense Retrieval From 8 Examples** | 2023 | ICLR | Round-trip Consistency Filter |
| 3 | Xu, C. et al. **WizardLM: Empowering Large Language Models to Follow Complex Instructions (Evol-Instruct)** | 2023 | arXiv:2304.12244 | Difficulty Evolution（クエリ難化） |
| 4 | Karpukhin, V. et al. **Dense Passage Retrieval for Open-Domain Question Answering (DPR)** | 2020 | EMNLP | Hard Negative Mining |
| 5 | Zhu, K. et al. **RAGEval: Scenario Specific RAG Evaluation Dataset Generation Framework** | 2024 | arXiv:2408.01262 | Domain Schema 注入 |
| 6 | Saad-Falcon, J. et al. **ARES: An Automated Evaluation Framework for RAG Systems** | 2024 | NAACL | PPI 統計的バイアス補正（設計参考・未実装） |
| 7 | Gao, L. et al. **Precise Zero-Shot Dense Retrieval without Relevance Labels (HyDE)** | 2023 | ACL | HyDE 仮説パッセージ生成 + AutoTuning 統合 |
| 8 | Zhang, T. et al. **RAFT: Adapting Language Model to Domain Specific RAG** | 2024 | arXiv:2403.10131 | RAFT データセット生成（Oracle + Distractor CoT） |
| 9 | Wei, J. et al. **Chain-of-Thought Prompting Elicits Reasoning in Large Language Models** | 2022 | NeurIPS | RAFT の CoT 回答形式の基盤 |
| 10 | **Ragas Testset Generation** | 2024- | OSS | 4象限タクソノミー、Persona/Style/Length |
| 11 | **Azure AI Foundry RAG Evaluators** | 2024- | Microsoft Learn | NDCG / XDCG 互換 `relevance_grades` |
| 12 | **Azure AI Search Indexer: Document Chunking** | 2024- | Microsoft Learn | Index Structure Detection のヒューリスティック設計 |
