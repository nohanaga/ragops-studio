import { isJsonObject } from '../app/json'
import type { JsonValue } from '../lib/aiSearchRest'
import type { AgenticFormState, KnowledgeSourceParamItem, SearchFormState, TopicGraphSettings } from '../types'

export const NOVEMBER_AGENTIC_API = '2026-11-01-preview'
export const NOVEMBER_KB_MODELS = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol'] as const

export function buildDirectAgenticSearch(form: SearchFormState): JsonValue {
  if (!form.search.trim() || form.search.trim() === '*') throw new Error('Enter a natural-language query for Microsoft Retriever 1.')
  if (!Number.isInteger(form.top) || form.top < 1 || form.top > 1000) throw new Error('top must be an integer from 1 to 1000.')
  const runtime = form.agenticMaxRuntime
  if (typeof runtime === 'number' && (!Number.isInteger(runtime) || runtime < 1 || runtime > 2147483647)) {
    throw new Error('agenticOptions.maxRuntimeInSeconds must be a positive int32.')
  }
  return {
    search: form.search,
    queryType: 'agentic',
    top: form.top,
    ...(form.filter.trim() ? { filter: form.filter.trim() } : {}),
    ...(form.select.trim() ? { select: form.select.trim() } : {}),
    ...(form.searchFields.trim() ? { searchFields: form.searchFields.trim() } : {}),
    ...(form.agenticDebug ? { debug: form.agenticDebug } : {}),
    ...(typeof runtime === 'number' ? { agenticOptions: { maxRuntimeInSeconds: runtime } } : {}),
  }
}

export function readTopicGraph(value: JsonValue | undefined): TopicGraphSettings | undefined {
  if (value === undefined || !isJsonObject(value)) return
  if (value.kind !== 'balanced' && value.kind !== 'diverse' && value.kind !== 'none') return
  return {
    kind: value.kind,
    ...(typeof value.minDiversityPoolSize === 'number' ? { minDiversityPoolSize: value.minDiversityPoolSize } : {}),
    ...(typeof value.diversityFactor === 'number' ? { diversityFactor: value.diversityFactor } : {}),
  }
}

export function buildTopicGraph(settings: TopicGraphSettings): TopicGraphSettings {
  const { kind, minDiversityPoolSize, diversityFactor } = settings
  if (kind === 'none') return { kind }
  if (minDiversityPoolSize !== undefined && (!Number.isInteger(minDiversityPoolSize) || minDiversityPoolSize < 250 || minDiversityPoolSize > 10000)) {
    throw new Error('topicGraph.minDiversityPoolSize must be an integer from 250 to 10000.')
  }
  if (kind === 'diverse' && diversityFactor !== undefined && (!Number.isFinite(diversityFactor) || diversityFactor < 0 || diversityFactor > 1)) {
    throw new Error('topicGraph.diversityFactor must be between 0 and 1.')
  }
  return {
    kind,
    ...(minDiversityPoolSize !== undefined ? { minDiversityPoolSize } : {}),
    ...(kind === 'diverse' && diversityFactor !== undefined ? { diversityFactor } : {}),
  }
}

export function readGraphParameters(value: JsonValue | undefined): KnowledgeSourceParamItem['graphParameters'] {
  if (!isJsonObject(value)) return
  const provenance = isJsonObject(value.provenance) ? value.provenance : undefined
  const hydrateDocuments = isJsonObject(provenance?.hydrateDocuments) ? provenance.hydrateDocuments : undefined
  return {
    ...(typeof value.includeQuery === 'boolean' ? { includeQuery: value.includeQuery } : {}),
    ...(provenance?.kind === 'hydrate' ? { provenance: {
      kind: 'hydrate',
      ...(hydrateDocuments ? { hydrateDocuments: {
        ...(typeof hydrateDocuments.top === 'number' ? { top: hydrateDocuments.top } : {}),
        ...(typeof hydrateDocuments.select === 'string' ? { select: hydrateDocuments.select } : {}),
      } } : {}),
    } } : provenance?.kind === 'none' ? { provenance: { kind: 'none' } } : {}),
  }
}

export function readReasoningEffort(value: JsonValue | undefined): AgenticFormState['retrievalReasoningEffort'] | undefined {
  const kind = isJsonObject(value) ? value.kind : undefined
  return kind === 'minimal' || kind === 'low' || kind === 'medium' || kind === 'auto' ? kind : undefined
}

export type KnowledgeBaseToolInfo = { name: string; sources: string[]; reasoningEffort: AgenticFormState['retrievalReasoningEffort'] }

export function getKnowledgeBaseTools(value: JsonValue | undefined, baseEffort: JsonValue | undefined): KnowledgeBaseToolInfo[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((tool) => isJsonObject(tool) && typeof tool.name === 'string'
    ? [{
        name: tool.name,
        reasoningEffort: readReasoningEffort(tool.retrievalReasoningEffort) ?? readReasoningEffort(baseEffort) ?? 'minimal',
        sources: Array.isArray(tool.knowledgeSources) ? tool.knowledgeSources.flatMap((source) => isJsonObject(source) && typeof source.name === 'string' ? [source.name] : []) : [],
      }]
    : [])
}

export function validateKnowledgeBaseTools(tools: JsonValue[], sourceNames: string[]): void {
  const names = new Set<string>()
  for (const tool of tools) {
    if (!isJsonObject(tool) || typeof tool.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(tool.name) || names.has(tool.name)) {
      throw new Error('Each tool must have a unique name: 2–64 lowercase letters, digits or hyphens, with no leading or trailing hyphen.')
    }
    names.add(tool.name)
    if (typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 1024) {
      throw new Error(`Tool '${tool.name}' requires a description of 1–1024 characters.`)
    }
    const refs = Array.isArray(tool.knowledgeSources) ? tool.knowledgeSources : []
    const sources = new Set<string>()
    if (refs.length === 0 || refs.some((source) => {
      if (!isJsonObject(source) || typeof source.name !== 'string' || !sourceNames.includes(source.name) || sources.has(source.name)) return true
      sources.add(source.name)
      return false
    })) throw new Error(`Tool '${tool.name}' must reference unique knowledge sources that belong to the knowledge base.`)
    if (isJsonObject(tool.retrieveDefaults) && Object.values(tool.retrieveDefaults).some((value) =>
      typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2147483647,
    )) throw new Error(`The retrieve limits for '${tool.name}' must be positive int32 values.`)
  }
}

export function validatedCompatibleModel(params: Record<string, JsonValue>, headersText: string, mayReuseHeaders: boolean): Record<string, JsonValue> {
  const { uri, modelName, authIdentity } = params
  if (typeof uri !== 'string' || typeof modelName !== 'string' || !modelName.trim()) {
    throw new Error('An OpenAI-compatible connection requires a model profile and a full HTTPS endpoint URL.')
  }
  const endpoint = URL.canParse(uri) ? new URL(uri) : null
  if (!endpoint || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error('The OpenAI-compatible endpoint must use HTTPS, without URL credentials or a fragment.')
  }
  const audience = typeof params.managedIdentityAudience === 'string' ? params.managedIdentityAudience.trim() : ''
  const connection = { ...params }
  delete connection.headers
  delete connection.managedIdentityAudience
  delete connection.authIdentity
  if (audience) {
    if (headersText.trim()) throw new Error('Choose either authentication headers or a managed identity, not both.')
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(audience)) {
      throw new Error('managedIdentityAudience must be a bare application GUID.')
    }
    return { ...connection, managedIdentityAudience: audience, ...(authIdentity ? { authIdentity } : {}) }
  }
  if (authIdentity) throw new Error('A user-assigned identity requires managedIdentityAudience.')
  if (!headersText.trim()) {
    if (!mayReuseHeaders) throw new Error('Enter authentication headers or a managed identity audience for the OpenAI-compatible connection.')
    return connection
  }
  let headers: JsonValue
  try { headers = JSON.parse(headersText) } catch { throw new Error('Authentication headers must be a valid JSON object.') }
  if (!isJsonObject(headers) || Object.keys(headers).length === 0 || Object.entries(headers).some(([key, value]) =>
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value),
  )) throw new Error('Authentication headers must be a nonempty JSON object of valid header name/string value pairs.')
  return { ...connection, headers }
}
