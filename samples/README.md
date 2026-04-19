# Sample Datasets for Search Parameter AutoTuning

This directory contains sample JSONL datasets for the **Search Parameter AutoTuning** feature in RAGOps Studio.

## Files

| File | Description | Query Field | Answer Field | Rows |
|------|-------------|-------------|--------------|------|
| `autotuning-dataset-en.jsonl` | English evaluation dataset with document IDs | `query` | `expected_ids` | 20 |
| `autotuning-dataset-ja.jsonl` | Japanese evaluation dataset with document IDs | `query` | `expected_ids` | 20 |

## Dataset Format

Each JSONL file contains one JSON object per line. Required fields:

- **Query field** (string): The search query to evaluate (e.g., `query`)
- **Answer field** (string or string array): Ground truth relevant document IDs (e.g., `expected_ids`)

Additional fields like `category` or `query_id` are optional metadata and will be ignored by AutoTuning.

### Example: Document ID style

```json
{"query": "How to create a search index", "expected_ids": ["doc-010", "doc-011", "doc-012"]}
```

## Usage

1. Open **Search Parameter AutoTuning** in RAGOps Studio
2. Click **Upload JSONL** and select a dataset file
3. Map the **Query Field** and **Answer Field** in the UI
4. Set the **Result ID Field** to match the document key field in your search index
5. Configure parameter search space and run the optimization

## Customizing Datasets

Replace `expected_ids` values with actual document IDs from your Azure AI Search index. The IDs must match the values returned by the field specified as **Result ID Field** in AutoTuning settings.
