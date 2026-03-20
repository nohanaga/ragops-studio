/**
 * Index-specific diff helper.
 *
 * Thin wrapper around the generic `computeResourceDiff` configured for Azure
 * AI Search index definitions.  Named arrays matched by name:
 *   - `fields[]`
 *   - `scoringProfiles[]`
 *   - `suggesters[]`
 *   - `analyzers[]`
 *   - `tokenizers[]`
 *   - `tokenFilters[]`
 *   - `charFilters[]`
 */

import { computeResourceDiff, type ResourceDiffConfig, type ResourceDiffResult } from './skillsetDiff'

const INDEX_DIFF_CONFIG: ResourceDiffConfig = {
  namedArrays: [
    { field: 'fields', label: 'field' },
    { field: 'scoringProfiles', label: 'scoring profile' },
    { field: 'suggesters', label: 'suggester' },
    { field: 'analyzers', label: 'analyzer' },
    { field: 'tokenizers', label: 'tokenizer' },
    { field: 'tokenFilters', label: 'token filter' },
    { field: 'charFilters', label: 'char filter' },
  ],
}

/**
 * Compute a semantic diff between two index definitions.
 *
 * @param before - The index definition currently on the service (or `{}` for new).
 * @param after  - The candidate index definition from the editor.
 */
export function computeIndexDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ResourceDiffResult {
  return computeResourceDiff(before, after, INDEX_DIFF_CONFIG)
}
