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
  perSourceResultsProcessing: true,
  mcpServerKnowledgeSources: true,
  mcpToolResultsProcessing: true,
}

export function getSearchApiCapabilities(apiVersion: SearchApiVersion | string | undefined): SearchApiCapabilities {
  if (apiVersion?.trim() === '2026-08-01-preview') return PREVIEW_2026_08_CAPABILITIES
  if (apiVersion?.trim() === '2026-05-01-preview') return PREVIEW_2026_05_CAPABILITIES
  if (apiVersion?.trim() === '2026-04-01') return STABLE_2026_04_CAPABILITIES
  return LEGACY_CAPABILITIES
}