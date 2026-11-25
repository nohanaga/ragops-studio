import { isJsonObject } from '../app/json'
import type { JsonValue } from '../lib/aiSearchRest'
import type { TopicGraphSettings } from '../types'
import { readTopicGraph } from './agenticPreview'

export function getAgenticComparisonSources(requestBody: JsonValue, activity: JsonValue[] | null) {
  const topicSettings = new Map<string, TopicGraphSettings | undefined>()
  const sourceByActivity = new Map<string, string>()
  for (const step of activity ?? []) {
    if (!isJsonObject(step) || typeof step.knowledgeSourceName !== 'string' || !step.knowledgeSourceName) continue
    const name = step.knowledgeSourceName
    if (typeof step.id === 'number' || typeof step.id === 'string') sourceByActivity.set(String(step.id), name)
    if (step.type === 'searchIndex' || step.type === 'azureBlob') topicSettings.set(name, undefined)
  }
  const overrides = isJsonObject(requestBody) && Array.isArray(requestBody.knowledgeSourceParams) ? requestBody.knowledgeSourceParams : []
  for (const param of overrides) {
    if (!isJsonObject(param) || typeof param.knowledgeSourceName !== 'string' || !param.knowledgeSourceName) continue
    const graph = readTopicGraph(param.topicGraph)
    if (graph || param.kind === 'searchIndex' || param.kind === 'azureBlob') topicSettings.set(param.knowledgeSourceName, graph)
  }
  return { topicSettings, sourceByActivity }
}

/**
 * The retrieval reasoning effort of a run. The `agenticReasoning` activity in the response holds the value the service
 * applied, so it takes precedence over the request, which may omit the setting and inherit the knowledge base default.
 */
export function getAgenticReasoningEffort(requestBody: JsonValue, activity: JsonValue[] | null): string | undefined {
  const kindOf = (value: JsonValue | undefined) => isJsonObject(value) && typeof value.kind === 'string' && value.kind ? value.kind : undefined
  for (const step of activity ?? []) {
    if (!isJsonObject(step) || step.type !== 'agenticReasoning') continue
    const applied = kindOf(step.retrievalReasoningEffort)
    if (applied) return applied
  }
  return isJsonObject(requestBody) ? kindOf(requestBody.retrievalReasoningEffort) : undefined
}

export function getAgenticDocumentIdentity(ref: Record<string, JsonValue> | null, sourceByActivity: ReadonlyMap<string, string>): string | undefined {
  if (!ref) return
  const { activitySource, docKey, blobUrl, knowledgeSourceName } = ref
  const source = typeof knowledgeSourceName === 'string' && knowledgeSourceName
    ? knowledgeSourceName
    : typeof activitySource === 'number' || typeof activitySource === 'string' ? sourceByActivity.get(String(activitySource)) : undefined
  if (!source) return
  if ((typeof docKey === 'string' && docKey.length > 0) || typeof docKey === 'number') return JSON.stringify([source, 'key', String(docKey)])
  if (ref.type === 'azureBlob' && typeof blobUrl === 'string' && blobUrl.trim()) return JSON.stringify([source, 'blob', blobUrl.trim()])
}

/** The index document key of a result identified by getAgenticDocumentIdentity, when it belongs to `sourceName`. */
export function getDocumentKeyForSource(identity: string | undefined, sourceName: string): string | undefined {
  if (!identity) return
  try {
    const parts: unknown = JSON.parse(identity)
    if (Array.isArray(parts) && parts.length === 3 && parts[0] === sourceName && parts[1] === 'key' && typeof parts[2] === 'string') return parts[2]
  } catch {
    // Not an identity created from a document key.
  }
}

export function getTopDocuments<T extends { documentIdentity?: string }>(items: readonly T[], limit: number) {
  const documents = new Map<string, T>()
  const window = items.slice(0, limit)
  let unidentified = 0
  for (const item of window) {
    if (!item.documentIdentity) unidentified++
    else if (!documents.has(item.documentIdentity)) documents.set(item.documentIdentity, item)
  }
  return { documents, unidentified, returned: window.length }
}

export function compareTopDocuments<T>(baseline: ReadonlyMap<string, T>, candidate: ReadonlyMap<string, T>) {
  const added = [...candidate].flatMap(([key, item]) => baseline.has(key) ? [] : [item])
  const dropped = [...baseline].flatMap(([key, item]) => candidate.has(key) ? [] : [item])
  return { common: candidate.size - added.length, added, dropped }
}
