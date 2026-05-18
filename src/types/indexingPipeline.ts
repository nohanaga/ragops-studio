import type { JsonValue } from '../lib/aiSearchRest'

export type IndexingPipelineResourceKind = 'dataSource' | 'index' | 'indexer'

export type IndexingPipelineEditorTab =
  | 'overview'
  | 'source'
  | 'index'
  | 'indexer'
  | 'rawJson'

export type IndexingPipelineJsonDraft = {
  text: string
  baselineText: string
  loadedName?: string
  loadedAt?: string
}

export type IndexingPipelineDraft = {
  version: 1
  updatedAt: string
  activeTab: IndexingPipelineEditorTab
  dataSource: IndexingPipelineJsonDraft
  index: IndexingPipelineJsonDraft
  indexer: IndexingPipelineJsonDraft
}

export type IndexingPipelineIssueSeverity = 'error' | 'warning' | 'info'

export type IndexingPipelineValidationIssue = {
  id: string
  severity: IndexingPipelineIssueSeverity
  resource: IndexingPipelineResourceKind | 'pipeline'
  message: string
}

export type ParsedIndexingPipelineDraft = {
  dataSource: JsonValue | null
  index: JsonValue | null
  indexer: JsonValue | null
}
