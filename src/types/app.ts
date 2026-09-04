/**
 * Application-level shared types.
 *
 * Defines UI modes, form state models, and data structures exchanged between
 * components, persistence, and REST execution.
 */

import type { Run, RunType } from '../lib/model'
import type { JsonValue } from '../lib/aiSearchRest'

export type LabMode = 'query' | 'semantic-vector' | 'agentic' | 'analyze' | 'autocomplete' | 'suggest'
export type ThemePreference = 'system' | 'dark' | 'light' | 'midnight' | 'forest' | 'solarized'
export type CenterTab =
  | 'portal'
  | 'builder'
  | 'latest'
  | `run:${string}`
  | 'qps-tester'
  | 'auto-tuning'
  | 'search-pipeline-visualizer'
  | 'vector-optimizer'
  | 'knowledge-source-builder'
  | 'knowledge-base-builder'
  | 'synonym-map-builder'
  | 'index-builder'
  | 'indexing-pipeline-builder'
  | 'skill-pipeline-builder'
  | 'skill-editor'
  | 'eval-dataset-generator'
  | 'index-visualizer'

export type ResultView = {
  id: 'latest' | `run:${string}`
  label: string
  response: LatestResponse | null
  runType: RunType | null
  runId?: string
  indexName?: string
  apiVersion?: string
}

export type UiLogEntry = {
  level?: 'error' | 'info' | 'warning'
  message: string
  timestamp: string
  at?: string
  title?: string
  detail?: string
}

export type PaneSizes = {
  leftPx: number
  rightPx: number
  experimentsHeightPx: number
}

export type BuilderMode = 'form' | 'json'

export type SearchFormState = {
  search: string
  queryType: 'simple' | 'full' | 'semantic'
  top: number
  skip: number
  count: boolean
  select: string
  filter: string
  orderby: string
  searchMode: string
  searchFields: string
  facets: string
  highlight: string
  scoringProfile: string
  scoringParameters: string
  // advanced
  queryRewrites: string
  // Docs allow multiple values separated by '|', and newer values like 'semantic'/'all'.
  // Keep this as a free-form string so the UI can pass through any supported values.
  debug: string
  semanticQuery: string
  highlightPreTag: string
  highlightPostTag: string
  minimumCoverage: number | ''
  scoringStatistics: '' | 'local' | 'global'
  sessionId: string
  speller: '' | 'none' | 'lexicon'
  semanticErrorHandling: '' | 'partial' | 'fail'
  semanticMaxWaitInMilliseconds: number | ''
  semanticFields: string
  vectorFilterMode: '' | 'preFilter' | 'postFilter' | 'strictPostFilter'
  hybridMaxTextRecallSize: number | ''
  hybridCountAndFacetMode: '' | 'countAllResults' | 'countRetrievableResults'
  // semantic extras 
  semanticConfiguration: string
  queryLanguage: string
  captions: string
  answers: string
  // vector (single query;)
  vectorEnabled: boolean
  // Built vectorQueries (added from the base vector settings via UI)
  vectorQueries: Array<{
    vectorKind: 'text' | 'vector' | 'imageUrl' | 'imageBinary'
    vectorText: string
    vectorQueryRewrites: string
    vector: string
    vectorImageUrl: string
    vectorBase64Image: string
    vectorFields: string
    vectorK: number
    vectorExhaustive: boolean
    vectorWeight: number
    vectorThresholdKind: 'vectorSimilarity' | 'searchScore' | ''
    vectorThresholdValue: number
    vectorOversampling: number | ''
    vectorPerDocumentVectorLimit: number | ''
    vectorFilterOverride: string
  }>
  vectorKind: 'text' | 'vector' | 'imageUrl' | 'imageBinary'
  vectorText: string
  vectorQueryRewrites: string
  vector: string
  vectorImageUrl: string
  vectorBase64Image: string
  vectorFields: string
  vectorK: number
  vectorExhaustive: boolean
  vectorWeight: number
  vectorThresholdKind: 'vectorSimilarity' | 'searchScore' | ''
  vectorThresholdValue: number
  vectorOversampling: number | ''
  vectorPerDocumentVectorLimit: number | ''
  vectorFilterOverride: string
}

export type KnowledgeSourceParamItem = {
  knowledgeSourceName: string
  kind: string
  includeReferences: boolean
  includeReferenceSourceData: boolean
  alwaysQuerySource: boolean
  neverQuerySource: boolean
  resultsProcessing: 'rerank' | 'none'
  maxOutputDocuments: number | ''
  queryHintOverrides: string
}

/** Lightweight info about a knowledge source inside a knowledge base. */
export type KnowledgeSourceInfo = {
  name: string
  kind: string
}

export type AgenticFormState = {
  userMessage: string
  includeActivity: boolean
  outputMode: string
  maxRuntimeInSeconds: number
  maxOutputSize: number
  retrievalReasoningEffort: 'low' | 'medium' | 'minimal' | 'auto'
  streamResponse: boolean
  knowledgeSourceParams: KnowledgeSourceParamItem[]
}

export type AnalyzeFormState = {
  text: string
  analyzerName: string
  tokenizerName: string
  normalizerName: string
  charFilters: string
  tokenFilters: string
}

export type AutocompleteFormState = {
  search: string
  suggesterName: string
  autocompleteMode: 'oneTerm' | 'twoTerms' | 'oneTermWithContext'
  searchFields: string
  filter: string
  top: number
  minimumCoverage: number | ''
  useFuzzyMatching: boolean
  liveTest: boolean
}

export type SuggestFormState = {
  search: string
  suggesterName: string
  searchFields: string
  select: string
  filter: string
  orderby: string
  top: number
  minimumCoverage: number | ''
  useFuzzyMatching: boolean
  highlightPreTag: string
  highlightPostTag: string
  liveTest: boolean
}

type KnowledgeSourceBase = {
  name: string
  description: string | null
}

export type SearchIndexKnowledgeSource = KnowledgeSourceBase & {
  kind: 'searchIndex'
  searchIndexParameters: {
    searchIndexName: string
    semanticConfigurationName: string | null
    sourceDataFields: Array<{ name: string }>
    searchFields: Array<{ name: string }>
    queryHints?: JsonValue
  }
}

export type McpServerKnowledgeSource = KnowledgeSourceBase & {
  kind: 'mcpServer'
  resultsProcessing: 'rerank' | 'none'
  mcpServerParameters: JsonValue
}

export type KnowledgeSource = SearchIndexKnowledgeSource | McpServerKnowledgeSource

export type KnowledgeBase = {
  name: string
  description: string | null
  retrievalInstructions: string | null
  answerInstructions: string | null
  outputMode: string | null
  knowledgeSources: Array<{ name: string }>
  models: JsonValue[]
  encryptionKey: JsonValue | null
  retrievalReasoningEffort: { kind: string }
  retrieveDefaults?: {
    maxRuntimeInSeconds?: number
    maxOutputDocuments?: number
    maxOutputSizeInTokens?: number
  }
}

export type SynonymMap = {
  name: string
  format: 'solr'
  synonyms: string
  '@odata.etag'?: string
}

export type LatestResponse = {
  at: string | undefined
  /** Internal run identifier (IndexedDB). */
  runId?: string
  /** Service request id (for support/tracing). May be empty for restored historical runs. */
  requestId: string
  /** Client-generated request id (x-ms-client-request-id) used to correlate client logs. */
  clientRequestId?: string
  url: string
  status: number
  body: JsonValue
  requestBody: JsonValue
  runType: Run['runType']
  latencyMs?: number
  elapsedTimeMs?: number
  streamState?: {
    eventCount: number
    lastEvent: string
    runningActivityIds: string[]
  }
}
