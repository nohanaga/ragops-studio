import { describe, expect, it } from 'vitest'
import { createDefaultIndexingPipelineDraft } from '../app/persistedIndexingPipeline'
import { validateIndexingPipelineDraft } from './indexingPipelineValidation'

function draftWithUserAssignedManagedIdentity() {
  const draft = createDefaultIndexingPipelineDraft()
  const dataSource = JSON.parse(draft.dataSource.text) as Record<string, unknown>
  dataSource.credentials = {
    connectionString: 'ResourceId=/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/account;',
  }
  dataSource.identity = {
    '@odata.type': '#Microsoft.Azure.Search.DataUserAssignedIdentity',
    userAssignedIdentity: '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/search-indexer-mi',
  }
  return {
    ...draft,
    dataSource: {
      ...draft.dataSource,
      text: JSON.stringify(dataSource, null, 2),
    },
  }
}

describe('validateIndexingPipelineDraft', () => {
  it('blocks user-assigned data source managed identity before API version 2026-04-01', () => {
    const issues = validateIndexingPipelineDraft({
      draft: draftWithUserAssignedManagedIdentity(),
      apiVersion: '2025-11-01-preview',
      language: 'en',
    })

    expect(issues).toContainEqual(expect.objectContaining({
      id: 'dataSource:userAssignedIdentityApiVersion',
      severity: 'error',
    }))
  })

  it('allows user-assigned data source managed identity on API version 2026-04-01', () => {
    const issues = validateIndexingPipelineDraft({
      draft: draftWithUserAssignedManagedIdentity(),
      apiVersion: '2026-04-01',
      language: 'en',
    })

    expect(issues).not.toContainEqual(expect.objectContaining({
      id: 'dataSource:userAssignedIdentityApiVersion',
    }))
  })
})
