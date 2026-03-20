# Skill Runtime

FastAPI-based Custom Skill Runtime for Azure AI Search.

[日本語版](README.jp.md)

## Overview

This is a lightweight Python web server (FastAPI, version 0.3.0) that:
1. Accepts Python skill code + test input via REST API and executes it dynamically
2. Loads deployed skill code from Azure Blob Storage at runtime — no container rebuild needed
3. Exposes an endpoint compatible with the [Azure AI Search Custom Skill Interface](https://learn.microsoft.com/azure/search/cognitive-search-custom-skill-interface)
4. Publishes skill code to Azure Blob Storage and switches the active skill
5. Supports skillset-namespaced Blob paths for multi-skillset environments

The runtime uses Microsoft-recommended Azure SDK patterns for Blob access:
- `DefaultAzureCredential` for Blob access (Managed Identity in Azure, `az login` locally)
- Azure Container Apps system-assigned managed identity
- Azure RBAC role **Storage Blob Data Contributor** for uploads and reads

Code changes are live-published to Blob Storage without rebuilding the container image.

## Architecture

```
RAGOps Studio (Browser)
   │
   ├─ Local Run ───→ Pyodide (WASM, in-browser Python)
   │
   └─ Remote Run ──→ Skill Runtime (Azure Container Apps)
                        │
                        ├─ /simulate   Execute ad-hoc code
                        ├─ /execute    Execute active Blob-backed skill
                        ├─ /upload     Publish skill code → Blob Storage
                        │
                        └─ Azure Blob Storage
                             └─ skills/{skillset}/{skill}/skill_logic.py
```

## Skill Module Contract

Every skill must define a `process` function:

```python
def process(input: dict) -> dict:
    """Process a single record.

    Args:
        input: The record's data dictionary (e.g., {"text": "hello world"})

    Returns:
        A dictionary of enriched fields (merged with input by the runtime).
    """
    return {"enrichedField": input.get("text", "").upper()}
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check — returns status, version, active skill name, storage config state |
| POST | `/simulate` | Execute ad-hoc Python code against test input (no Blob Storage required) |
| POST | `/execute` | Execute the active skill loaded from Blob Storage |
| POST | `/execute?skillset_name=...` | Execute the active skill for a specific skillset namespace |
| POST | `/skills/{skillName}` | Execute a named skill loaded from Blob Storage |
| POST | `/skills/{skillName}?skillset_name=...` | Execute a named skill under a skillset namespace |
| GET | `/skills/{skillName}/code` | Download deployed skill code + metadata from Blob Storage |
| GET | `/skills/{skillName}/code?skillset_name=...` | Download skill code under a skillset namespace |
| POST | `/upload` | Publish skill code to Blob Storage and switch the active skill |

### POST /simulate

Request body:

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

Response:

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

Request body:

```json
{
  "skill_name": "my-custom-skill",
  "skill_code": "def process(input):\n    return {\"result\": input.get(\"text\", \"\").upper()}",
  "skillset_name": "my-skillset",
  "requirements_txt": "numpy\npandas",
  "metadata": { "description": "Uppercase transformer" }
}
```

Response:

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

## Blob Layout

Inside the configured blob container, the runtime writes files under a skillset-namespaced path (when `skillset_name` is provided):

```
{prefix}/
  {skillset-name}/
    active-skill.json          ← points to the currently active skill
    {skill-name}/
      skill_logic.py           ← user skill code
      metadata.json            ← codeHash, updatedAt, skillName
      requirements.txt         ← optional Python dependencies
```

When `skillset_name` is omitted, falls back to a flat path:

```
{prefix}/
  active-skill.json
  {skill-name}/
    skill_logic.py
    metadata.json
    requirements.txt
```

## Required Environment Variables

```text
SKILL_STORAGE_ACCOUNT_URL=https://<storage-account-name>.blob.core.windows.net
SKILL_STORAGE_CONTAINER=<blob-container-name>
SKILL_STORAGE_PREFIX=skills
```

Optional when using a user-assigned managed identity:

```text
SKILL_STORAGE_MANAGED_IDENTITY_CLIENT_ID=<managed-identity-client-id>
```

The runtime also supports alternative environment variable names for compatibility:

| Primary | Alternative |
|---------|------------|
| `SKILL_STORAGE_ACCOUNT_URL` | `AZURE_STORAGE_BLOB_URL`, `AZURE_STORAGEBLOB_RESOURCEENDPOINT` |
| `SKILL_STORAGE_CONTAINER` | `AZURE_STORAGE_BLOB_CONTAINER` |
| `SKILL_STORAGE_MANAGED_IDENTITY_CLIENT_ID` | `Managed_Identity_Client_ID` |

## Local Development

```bash
cd skill-runtime

python -m venv .venv
source .venv/bin/activate  # Linux/Mac
.venv\Scripts\activate     # Windows

pip install -r requirements.txt

# Authenticate locally for DefaultAzureCredential
az login

# Configure Blob Storage
export SKILL_STORAGE_ACCOUNT_URL=https://<storage-account-name>.blob.core.windows.net
export SKILL_STORAGE_CONTAINER=<blob-container-name>
# Windows: use 'set' instead of 'export'

uvicorn main:app --reload --port 7071
```

The `/simulate` endpoint works without Blob Storage configuration — useful for testing skill code locally without any Azure resources.

## Deploy to Azure Container Apps

### Automated Deployment (Recommended)

Use the provided deploy scripts for one-command provisioning:

```bash
# Bash (Linux/Mac/WSL)
chmod +x scripts/skill-runtime/deploy-aca.sh
./scripts/skill-runtime/deploy-aca.sh

# PowerShell (Windows)
.\scripts\skill-runtime\deploy-aca.ps1
```

The scripts automatically:
1. Create a Resource Group
2. Create a Storage Account + Blob container
3. Deploy the Container App with `az containerapp up --source`
4. Enable system-assigned managed identity
5. Set Blob Storage environment variables
6. Assign **Storage Blob Data Contributor** RBAC role

Options:

| Flag (bash) | Parameter (PS) | Description | Default |
|-------------|----------------|-------------|---------|
| `-n` | `-AppName` | Container App name | `skill-runtime` |
| `-g` | `-ResourceGroup` | Resource Group | `<AppName>-rg` |
| `-l` | `-Location` | Azure region | `japaneast` |
| `-s` | `-StorageAccount` | Storage Account name | `<AppName>sa` |
| `-c` | `-StorageContainer` | Blob container name | `skill-runtime` |
| `-p` | `-StoragePrefix` | Blob path prefix | `skills` |

### Update Deployment

After the initial deploy, push runtime code changes (main.py, requirements.txt, Dockerfile, etc.) without recreating infrastructure:

```bash
# Bash
./scripts/skill-runtime/update-aca.sh

# PowerShell
.\scripts\skill-runtime\update-aca.ps1
```

### Manual Deployment

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

Then assign the RBAC role:

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

After deployment, set the following as the Custom Web API Skill URI in Azure AI Search:

```
https://<container-app-fqdn>/execute
```

Or for named skills:

```
https://<container-app-fqdn>/skills/<skill-name>
```

## Pre-installed Python Libraries

The Docker image includes commonly used data science and NLP libraries:

| Category | Libraries |
|----------|-----------|
| Core | `numpy`, `pandas`, `scipy`, `scikit-learn` |
| Visualization | `matplotlib`, `seaborn`, `plotly` |
| Statistics | `statsmodels` |
| Excel | `openpyxl`, `xlsxwriter` |
| NLP | `nltk`, `spacy`, `gensim`, `tiktoken` |
| Text Processing | `regex`, `rapidfuzz`, `chardet`, `beautifulsoup4`, `lxml` |
| AI | `openai` |
| Templating | `Jinja2` |

## File Structure

```
skill-runtime/
├── main.py              # FastAPI application (all endpoints)
├── Dockerfile           # Container image definition (Python 3.11-slim)
├── requirements.txt     # Python dependencies
├── skill-config.json    # Local active skill configuration
└── skills/              # Local skill modules (for development)
    ├── active_skill.py
    ├── custom-skill.py
    └── customwebapi1.py
```

## References

- [Custom Skill Interface](https://learn.microsoft.com/azure/search/cognitive-search-custom-skill-interface)
- [Custom Web API Skill](https://learn.microsoft.com/azure/search/cognitive-search-custom-skill-web-api)
- [Azure Container Apps](https://learn.microsoft.com/azure/container-apps/overview)
