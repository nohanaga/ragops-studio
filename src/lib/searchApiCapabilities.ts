import type { SearchApiVersion } from './model'

export type SearchApiCapabilities = {
  cursorList: boolean
  agenticStreaming: boolean
  agenticResponseSynthesis: boolean
  alwaysQuerySource: boolean
  citationUrl: boolean
  reasoningAuto: boolean
  queryHints: boolean
  retrieveDefaults: boolean
  microsoftRetriever1: boolean
  novemberAgentic: boolean
  /** Index schema additions: graphProfile, topicGraphProfiles, topicGraphProfile, openAICompatible vectorizer, random scoring. */
  novemberIndexSchema: boolean
  perSourceResultsProcessing: boolean
  mcpServerKnowledgeSources: boolean
  mcpToolResultsProcessing: boolean
}

const LEGACY_CAPABILITIES: SearchApiCapabilities = {
  cursorList: false,
  agenticStreaming: false,
  agenticResponseSynthesis: true,
  alwaysQuerySource: true,
  citationUrl: false,
  reasoningAuto: false,
  queryHints: false,
  retrieveDefaults: false,
  microsoftRetriever1: false,
  novemberAgentic: false,
  novemberIndexSchema: false,
  perSourceResultsProcessing: false,
  mcpServerKnowledgeSources: false,
  mcpToolResultsProcessing: false,
}

const STABLE_2026_04_CAPABILITIES: SearchApiCapabilities = {
  ...LEGACY_CAPABILITIES,
  agenticResponseSynthesis: false,
  alwaysQuerySource: false,
}

const PREVIEW_2026_05_CAPABILITIES: SearchApiCapabilities = {
  ...LEGACY_CAPABILITIES,
  mcpServerKnowledgeSources: true,
}

const PREVIEW_2026_08_CAPABILITIES: SearchApiCapabilities = {
  cursorList: true,
  agenticStreaming: true,
  agenticResponseSynthesis: true,
  alwaysQuerySource: true,
  citationUrl: true,
  reasoningAuto: true,
  queryHints: true,
  retrieveDefaults: true,
  microsoftRetriever1: false,
  novemberAgentic: false,
  novemberIndexSchema: false,
  perSourceResultsProcessing: true,
  mcpServerKnowledgeSources: true,
  mcpToolResultsProcessing: true,
}

const PREVIEW_2026_11_CAPABILITIES: SearchApiCapabilities = {
  ...PREVIEW_2026_08_CAPABILITIES,
  microsoftRetriever1: true,
  novemberAgentic: true,
  novemberIndexSchema: true,
}

export function getSearchApiCapabilities(apiVersion: SearchApiVersion | string | undefined): SearchApiCapabilities {
  if (apiVersion?.trim() === '2026-11-01-preview') return PREVIEW_2026_11_CAPABILITIES
  if (apiVersion?.trim() === '2026-08-01-preview') return PREVIEW_2026_08_CAPABILITIES
  if (apiVersion?.trim() === '2026-05-01-preview') return PREVIEW_2026_05_CAPABILITIES
  if (apiVersion?.trim() === '2026-04-01') return STABLE_2026_04_CAPABILITIES
  return LEGACY_CAPABILITIES
}