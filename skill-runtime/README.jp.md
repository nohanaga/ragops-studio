# Skill Runtime

Azure AI Search 用の FastAPI ベース Custom Skill ランタイム。

[English version](README.md)

## 概要

軽量な Python Web サーバー（FastAPI, バージョン 0.3.0）で、以下の機能を提供します：
1. REST API 経由で Python スキルコード + テスト入力を受け取り、動的に実行
2. Azure Blob Storage からデプロイ済みのスキルコードをランタイム時にロード — コンテナの再ビルド不要
3. [Azure AI Search Custom Skill Interface](https://learn.microsoft.com/azure/search/cognitive-search-custom-skill-interface) 互換のエンドポイントを公開
4. スキルコードを Azure Blob Storage にパブリッシュし、アクティブスキルを切り替え
5. マルチスキルセット環境向けのスキルセット名前空間付き Blob パスをサポート

ランタイムは Microsoft 推奨の Azure SDK パターンを使用：
- `DefaultAzureCredential` による Blob アクセス（Azure ではマネージド ID、ローカルでは `az login`）
- Azure Container Apps のシステム割り当てマネージド ID
- Azure RBAC ロール **Storage Blob Data Contributor** によるアップロードと読み取り

コード変更はコンテナイメージを再ビルドせずに Blob Storage にライブパブリッシュされます。

## アーキテクチャ

```
RAGOps Studio (ブラウザ)
   │
   ├─ Local Run ───→ Pyodide (WASM, ブラウザ内 Python)
   │
   └─ Remote Run ──→ Skill Runtime (Azure Container Apps)
                        │
                        ├─ /simulate   アドホックコード実行
                        ├─ /execute    Blob 上のアクティブスキル実行
                        ├─ /upload     スキルコード → Blob Storage へパブリッシュ
                        │
                        └─ Azure Blob Storage
                             └─ skills/{skillset}/{skill}/skill_logic.py
```

## スキルモジュール規約

すべてのスキルは `process` 関数を定義する必要があります：

```python
def process(input: dict) -> dict:
    """1レコードを処理する。

    Args:
        input: レコードのデータ辞書（例: {"text": "hello world"}）

    Returns:
        エンリッチされたフィールドの辞書（ランタイムが入力とマージ）
    """
    return {"enrichedField": input.get("text", "").upper()}
```

## API エンドポイント

| メソッド | パス | 説明 |
|--------|------|-------------|
| GET | `/health` | ヘルスチェック — ステータス、バージョン、アクティブスキル名、ストレージ設定状態を返却 |
| POST | `/simulate` | アドホックな Python コードをテスト入力に対して実行（Blob Storage 不要） |
| POST | `/execute` | Blob Storage からロードしたアクティブスキルを実行 |
| POST | `/execute?skillset_name=...` | 特定のスキルセット名前空間のアクティブスキルを実行 |
| POST | `/skills/{skillName}` | Blob Storage から指定名のスキルをロードして実行 |
| POST | `/skills/{skillName}?skillset_name=...` | スキルセット名前空間下の指定名スキルを実行 |
| GET | `/skills/{skillName}/code` | デプロイ済みスキルコード + メタデータを Blob Storage からダウンロード |
| GET | `/skills/{skillName}/code?skillset_name=...` | スキルセット名前空間下のスキルコードをダウンロード |
| POST | `/upload` | スキルコードを Blob Storage にパブリッシュし、アクティブスキルを切り替え |

### POST /simulate

リクエストボディ：

```json
{
  "skill_code": "def process(input):\n    return {\"result\": input.get(\"text\", \"\").upper()}",
  "input": {
    "values": [
      { "recordId": "1", "data": { "text": "hello" } }
    ]
  },
  "timeout": 30
}
```

レスポンス：

```json
{
  "success": true,
  "output": {
    "values": [
      { "recordId": "1", "data": { "result": "HELLO" }, "errors": [], "warnings": [] }
    ]
  },
  "executionTimeMs": 12.34,
  "logs": ""
}
```

### POST /upload

リクエストボディ：

```json
{
  "skill_name": "my-custom-skill",
  "skill_code": "def process(input):\n    return {\"result\": input.get(\"text\", \"\").upper()}",
  "skillset_name": "my-skillset",
  "requirements_txt": "numpy\npandas",
  "metadata": { "description": "Uppercase transformer" }
}
```

レスポンス：

```json
{
  "success": true,
  "message": "Skill 'my-custom-skill' published to Blob Storage.",
  "executePath": "/execute",
  "skillPath": "/skills/my-custom-skill",
  "activeSkill": "my-custom-skill",
  "codeHash": "a1b2c3..."
}
```

## Blob レイアウト

設定された Blob コンテナ内に、スキルセット名前空間付きパス（`skillset_name` 指定時）でファイルを書き込みます：

```
{prefix}/
  {skillset-name}/
    active-skill.json          ← 現在アクティブなスキルを指すポインタ
    {skill-name}/
      skill_logic.py           ← ユーザーのスキルコード
      metadata.json            ← codeHash, updatedAt, skillName
      requirements.txt         ← オプションの Python 依存パッケージ
```

`skillset_name` を省略した場合はフラットパスにフォールバック：

```
{prefix}/
  active-skill.json
  {skill-name}/
    skill_logic.py
    metadata.json
    requirements.txt
```

## 必須環境変数

```text
SKILL_STORAGE_ACCOUNT_URL=https://<storage-account-name>.blob.core.windows.net
SKILL_STORAGE_CONTAINER=<blob-container-name>
SKILL_STORAGE_PREFIX=skills
```

ユーザー割り当てマネージド ID 使用時のオプション：

```text
SKILL_STORAGE_MANAGED_IDENTITY_CLIENT_ID=<managed-identity-client-id>
```

互換性のために代替の環境変数名もサポート：

| プライマリ | 代替名 |
|---------|------------|
| `SKILL_STORAGE_ACCOUNT_URL` | `AZURE_STORAGE_BLOB_URL`, `AZURE_STORAGEBLOB_RESOURCEENDPOINT` |
| `SKILL_STORAGE_CONTAINER` | `AZURE_STORAGE_BLOB_CONTAINER` |
| `SKILL_STORAGE_MANAGED_IDENTITY_CLIENT_ID` | `Managed_Identity_Client_ID` |

## ローカル開発

```bash
cd skill-runtime

python -m venv .venv
source .venv/bin/activate  # Linux/Mac
.venv\Scripts\activate     # Windows

pip install -r requirements.txt

# DefaultAzureCredential 用のローカル認証
az login

# Blob Storage の設定
export SKILL_STORAGE_ACCOUNT_URL=https://<storage-account-name>.blob.core.windows.net
export SKILL_STORAGE_CONTAINER=<blob-container-name>
# Windows の場合は 'export' の代わりに 'set' を使用

uvicorn main:app --reload --port 7071
```

`/simulate` エンドポイントは Blob Storage の設定なしで動作します — Azure リソースなしでスキルコードをローカルテストするのに便利です。

## Azure Container Apps へのデプロイ

### 自動デプロイ（推奨）

提供されているデプロイスクリプトでワンコマンドプロビジョニング：

```bash
# Bash (Linux/Mac/WSL)
chmod +x scripts/skill-runtime/deploy-aca.sh
./scripts/skill-runtime/deploy-aca.sh

# PowerShell (Windows)
.\scripts\skill-runtime\deploy-aca.ps1
```

スクリプトが自動的に以下を実行：
1. リソースグループの作成
2. ストレージアカウント + Blob コンテナの作成
3. `az containerapp up --source` で Container App をデプロイ
4. システム割り当てマネージド ID の有効化
5. Blob Storage 環境変数の設定
6. **Storage Blob Data Contributor** RBAC ロールの割り当て

オプション：

| フラグ (bash) | パラメータ (PS) | 説明 | デフォルト |
|-------------|----------------|-------------|---------|
| `-n` | `-AppName` | Container App 名 | `skill-runtime` |
| `-g` | `-ResourceGroup` | リソースグループ | `<AppName>-rg` |
| `-l` | `-Location` | Azure リージョン | `japaneast` |
| `-s` | `-StorageAccount` | ストレージアカウント名 | `<AppName>sa` |
| `-c` | `-StorageContainer` | Blob コンテナ名 | `skill-runtime` |
| `-p` | `-StoragePrefix` | Blob パスプレフィックス | `skills` |

### デプロイの更新

初回デプロイ後、インフラを再作成せずにランタイムコードの変更（main.py, requirements.txt, Dockerfile 等）をプッシュ：

```bash
# Bash
./scripts/skill-runtime/update-aca.sh

# PowerShell
.\scripts\skill-runtime\update-aca.ps1
```

### 手動デプロイ

```bash
az login

az containerapp up \
  --name skill-runtime \
  --source ./skill-runtime \
  --system-assigned \
  --env-vars \
    SKILL_STORAGE_ACCOUNT_URL=https://<storage-account-name>.blob.core.windows.net \
    SKILL_STORAGE_CONTAINER=<blob-container-name> \
    SKILL_STORAGE_PREFIX=skills \
  --ingress external \
  --target-port 8000
```

その後 RBAC ロールを割り当て：

```bash
PRINCIPAL_ID=$(az containerapp identity show \
  --name skill-runtime --resource-group <rg> \
  --query principalId --output tsv)

STORAGE_ID=$(az storage account show \
  --name <storage-account> --resource-group <rg> \
  --query id --output tsv)

az role assignment create \
  --assignee-object-id "$PRINCIPAL_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" \
  --scope "$STORAGE_ID"
```

## Custom Skill URI

デプロイ後、Azure AI Search の Custom Web API Skill URI として以下を設定：

```
https://<container-app-fqdn>/execute
```

名前付きスキルの場合：

```
https://<container-app-fqdn>/skills/<skill-name>
```

## プリインストール済み Python ライブラリ

Docker イメージには一般的なデータサイエンス・NLP ライブラリが含まれています：

| カテゴリ | ライブラリ |
|----------|-----------|
| コア | `numpy`, `pandas`, `scipy`, `scikit-learn` |
| 可視化 | `matplotlib`, `seaborn`, `plotly` |
| 統計 | `statsmodels` |
| Excel | `openpyxl`, `xlsxwriter` |
| NLP | `nltk`, `spacy`, `gensim`, `tiktoken` |
| テキスト処理 | `regex`, `rapidfuzz`, `chardet`, `beautifulsoup4`, `lxml` |
| AI | `openai` |
| テンプレート | `Jinja2` |

## ファイル構成

```
skill-runtime/
├── main.py              # FastAPI アプリケーション（全エンドポイント）
├── Dockerfile           # コンテナイメージ定義（Python 3.11-slim）
├── requirements.txt     # Python 依存パッケージ
├── skill-config.json    # ローカルのアクティブスキル設定
└── skills/              # ローカルスキルモジュール（開発用）
    ├── active_skill.py
    ├── custom-skill.py
    └── customwebapi1.py
```

## 参考リンク

- [Custom Skill Interface](https://learn.microsoft.com/azure/search/cognitive-search-custom-skill-interface)
- [Custom Web API Skill](https://learn.microsoft.com/azure/search/cognitive-search-custom-skill-web-api)
- [Azure Container Apps](https://learn.microsoft.com/azure/container-apps/overview)
