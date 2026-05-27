// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createDefaultIndexingPipelineDraft,
  createEmptyIndexingPipelineDraft,
  deleteIndexingPipelineDraft,
  getIndexingPipelineDraft,
  listIndexingPipelineDrafts,
  loadIndexingPipelineCurrentDraftId,
  loadIndexingPipelineDraft,
  saveIndexingPipelineDraft,
  upsertIndexingPipelineDraft,
} from './persistedIndexingPipeline'

describe('app/persistedIndexingPipeline', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('creates an empty no-load draft for startup', () => {
    const empty = createEmptyIndexingPipelineDraft()
    expect(JSON.parse(empty.dataSource.text)).toEqual({})
    expect(JSON.parse(empty.index.text)).toEqual({})
    expect(JSON.parse(empty.indexer.text)).toEqual({})

    const template = createDefaultIndexingPipelineDraft()
    expect(JSON.parse(template.indexer.text).name).toBe('sample-indexer')
  })

  it('persists multiple drafts and redacts data source secrets', () => {
    const draft = createDefaultIndexingPipelineDraft()
    const dataSource = JSON.parse(draft.dataSource.text) as Record<string, unknown>
    dataSource.credentials = { connectionString: 'AccountKey=secret-value' }
    const dataSourceText = JSON.stringify(dataSource, null, 2)

    upsertIndexingPipelineDraft({
      id: 'pipeline-1',
      title: 'Blob ingest pipeline',
      updatedAt: 0,
      draft: {
        ...draft,
        dataSource: {
          ...draft.dataSource,
          text: dataSourceText,
          baselineText: dataSourceText,
        },
      },
    })

    const items = listIndexingPipelineDrafts()
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Blob ingest pipeline')
    expect(loadIndexingPipelineCurrentDraftId()).toBeNull()
    expect(JSON.parse(loadIndexingPipelineDraft().indexer.text)).toEqual({})

    const loaded = getIndexingPipelineDraft('pipeline-1')
    expect(loaded).not.toBeNull()
    const storedDataSource = JSON.parse(loaded!.draft.dataSource.text) as { credentials: { connectionString: string } }
    expect(storedDataSource.credentials.connectionString).toBe('<redacted>')
  })

  it('migrates the legacy current draft into the local draft library without auto-loading it', () => {
    const draft = createDefaultIndexingPipelineDraft()
    const indexer = JSON.parse(draft.indexer.text) as Record<string, unknown>
    indexer.name = 'legacy-indexer'

    saveIndexingPipelineDraft({
      ...draft,
      indexer: {
        ...draft.indexer,
        text: JSON.stringify(indexer, null, 2),
      },
    })

    const items = listIndexingPipelineDrafts()
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('legacy-current')
    expect(items[0].title).toBe('legacy-indexer -> sample-index')
    expect(loadIndexingPipelineCurrentDraftId()).toBeNull()
    expect(JSON.parse(loadIndexingPipelineDraft().indexer.text)).toEqual({})
  })

  it('removes a saved draft and clears the current draft id', () => {
    const draft = createDefaultIndexingPipelineDraft()
    const indexer = JSON.parse(draft.indexer.text) as Record<string, unknown>
    indexer.name = 'deleted-indexer'
    upsertIndexingPipelineDraft({
      id: 'pipeline-1',
      title: 'Pipeline 1',
      updatedAt: 0,
      draft: {
        ...draft,
        indexer: {
          ...draft.indexer,
          text: JSON.stringify(indexer, null, 2),
        },
      },
    })

    deleteIndexingPipelineDraft('pipeline-1')

    expect(listIndexingPipelineDrafts()).toEqual([])
    expect(loadIndexingPipelineCurrentDraftId()).toBeNull()
    expect(JSON.parse(loadIndexingPipelineDraft().indexer.text)).toEqual({})
  })
})
