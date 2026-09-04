import type { JsonValue } from '../lib/aiSearchRest'
import type { SearchApiVersion } from '../lib/model'
import { getSearchApiCapabilities } from '../lib/searchApiCapabilities'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

export function normalizeMcpServerParameters(value: unknown): JsonValue {
  if (!isRecord(value) || !isJsonValue(value)) return {}
  const parameters = value as Record<string, JsonValue>
  if (!Array.isArray(parameters.tools)) return parameters

  const tools = parameters.tools.map((value) => {
    if (!isRecord(value) || !isJsonValue(value)) return value
    const tool = value as Record<string, JsonValue>
    const normalized: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(tool)) {
      if (key !== 'inclusionMode') normalized[key] = item
    }
    if (normalized.resultsProcessing !== 'rerank' && normalized.resultsProcessing !== 'none') {
      if (tool.inclusionMode === 'always') normalized.resultsProcessing = 'none'
      else if (tool.inclusionMode === 'reranked') normalized.resultsProcessing = 'rerank'
    }
    return normalized
  })

  return { ...parameters, tools }
}

export function serializeMcpServerParameters(
  value: unknown,
  apiVersion: SearchApiVersion | string | undefined,
): JsonValue {
  const normalized = normalizeMcpServerParameters(value)
  if (!isRecord(normalized) || !isJsonValue(normalized)) return {}
  const parameters = normalized as Record<string, JsonValue>
  if (!Array.isArray(parameters.tools)) return parameters

  const capabilities = getSearchApiCapabilities(apiVersion)
  const tools = parameters.tools.map((value) => {
    if (!isRecord(value) || !isJsonValue(value)) return value
    const tool = value as Record<string, JsonValue>
    const serialized: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(tool)) {
      if (key !== 'inclusionMode' && key !== 'resultsProcessing') serialized[key] = item
    }

    if (tool.resultsProcessing === 'rerank' || tool.resultsProcessing === 'none') {
      if (capabilities.mcpToolResultsProcessing) {
        serialized.resultsProcessing = tool.resultsProcessing
      } else {
        serialized.inclusionMode = tool.resultsProcessing === 'none' ? 'always' : 'reranked'
      }
    }
    return serialized
  })

  return { ...parameters, tools }
}

type McpServerKnowledgeSourceBodyOptions = {
  name: string
  description: string | null
  resultsProcessing: 'rerank' | 'none'
  mcpServerParameters: unknown
  apiVersion: SearchApiVersion | string | undefined
}

export function buildMcpServerKnowledgeSourceBody({
  name,
  description,
  resultsProcessing,
  mcpServerParameters,
  apiVersion,
}: McpServerKnowledgeSourceBodyOptions): JsonValue {
  const capabilities = getSearchApiCapabilities(apiVersion)
  return {
    name,
    kind: 'mcpServer',
    description,
    ...(capabilities.perSourceResultsProcessing ? { resultsProcessing } : {}),
    mcpServerParameters: serializeMcpServerParameters(mcpServerParameters, apiVersion),
  }
}