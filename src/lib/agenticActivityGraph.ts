import type { JsonValue } from './aiSearchRest'
import type { LatestResponse } from '../types'
import type { TranslationKey } from './translations'
import { buildActivityTiming } from './agenticActivityTiming'

export type ActivityTranslator = (key: TranslationKey) => string

export function isActivityObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface ActivityItem {
  type: string
  id: number | string
  raw: Record<string, JsonValue>
  elapsedMs?: number
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  count?: number
  knowledgeSourceName?: string
  search?: string
  logicalReasoningEffort?: string
  retrievalReasoningEffort?: string
  queryTime?: string
  startedAt?: string
  completedAt?: string
  modelName?: string
  deploymentId?: string
}

export function parseActivity(raw: JsonValue): ActivityItem | null {
  if (!isActivityObject(raw)) return null
  const model = isActivityObject(raw.model) ? raw.model : raw
  const effort = (value: JsonValue | undefined) => isActivityObject(value) && typeof value.kind === 'string' ? value.kind : undefined
  const number = (key: string) => typeof raw[key] === 'number' ? raw[key] : undefined
  const text = (key: string) => typeof raw[key] === 'string' ? raw[key] : undefined
  const args = Object.entries(raw).find(([key, value]) => key.endsWith('Arguments') && isActivityObject(value) && typeof value.search === 'string')?.[1]
  return {
    type: text('type') ?? '',
    id: typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : 0,
    raw,
    elapsedMs: number('elapsedMs'),
    inputTokens: number('inputTokens'),
    outputTokens: number('outputTokens'),
    reasoningTokens: number('reasoningTokens'),
    count: number('count'),
    knowledgeSourceName: text('knowledgeSourceName'),
    search: isActivityObject(args) && typeof args.search === 'string' ? args.search : undefined,
    logicalReasoningEffort: effort(raw.logicalReasoningEffort),
    retrievalReasoningEffort: effort(raw.retrievalReasoningEffort),
    queryTime: text('queryTime'),
    startedAt: text('startedAt'),
    completedAt: text('completedAt'),
    modelName: typeof model.modelName === 'string' ? model.modelName : text('modelName'),
    deploymentId: typeof model.deploymentId === 'string' ? model.deploymentId : text('deploymentId'),
  }
}

export function typeCategory(type: string): 'planning' | 'source' | 'reasoning' | 'synthesis' {
  if (type === 'modelQueryPlanning') return 'planning'
  if (type === 'agenticReasoning') return 'reasoning'
  if (type === 'modelAnswerSynthesis') return 'synthesis'
  return 'source'
}

const sourceTypes = new Set(['searchIndex', 'web', 'indexedSharePoint', 'azureBlob', 'mcpServer', 'remoteSharePoint', 'indexedOneLake', 'remoteOneLake'])

export type ActivityGraphStatus = 'running' | 'completed' | 'error' | 'warning' | 'unknown' | 'configured' | 'incomplete'
export const activityStatusKeys: Record<ActivityGraphStatus, TranslationKey> = {
  running: 'agenticActivityRunning',
  completed: 'agenticActivityCompleted',
  error: 'actGraphError',
  warning: 'actGraphPartial',
  unknown: 'actGraphUnknown',
  configured: 'actGraphRequested',
  incomplete: 'actGraphIncomplete',
}
export type ActivityGraphNode = {
  id: string
  kind: 'request' | 'config' | 'activity' | 'merge' | 'result' | 'delivery' | 'excluded'
  title: string
  subtitle: string
  status: ActivityGraphStatus
  raw: JsonValue
  item?: ActivityItem
  parameters?: JsonValue
  textBlocks?: { label?: string; text: string }[]
}
export type ActivityGraphEdge = { id: string; source: string; target: string; uncertain: boolean }
export type ActivityGraph = { nodes: ActivityGraphNode[]; edges: ActivityGraphEdge[] }

function messageTextBlocks(messages: JsonValue | undefined): NonNullable<ActivityGraphNode['textBlocks']> {
  if (!Array.isArray(messages)) return []
  return messages.filter(isActivityObject).flatMap((message) => {
    const label = typeof message.role === 'string' ? message.role : undefined
    const content = typeof message.content === 'string'
      ? [message.content]
      : Array.isArray(message.content)
        ? message.content.flatMap((part) => (
          isActivityObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []
        ))
        : []
    return content.filter((text) => text.trim().length > 0).map((text) => ({ label, text }))
  })
}

export function buildActivityGraph({
  items, response, streaming = false, t,
}: {
  items: ActivityItem[]
  response?: LatestResponse
  streaming?: boolean
  t: ActivityTranslator
}): ActivityGraph {
  const nodes: ActivityGraphNode[] = []
  const edges: ActivityGraphEdge[] = []
  const request = isActivityObject(response?.requestBody) ? response.requestBody : null
  const body = isActivityObject(response?.body) ? response.body : null
  const sourceParams = Array.isArray(request?.knowledgeSourceParams) ? request.knowledgeSourceParams.filter(isActivityObject) : []
  const running = new Set(response?.streamState?.runningActivityIds)
  const failed = Boolean(body?.error) || (response !== undefined && response.status >= 400)
  const incomplete = response?.status === 0 || (!streaming && response?.responseFormat === 'sse' && response.streamState?.lastEvent !== 'response.completed')
  const outcome: ActivityGraphStatus = streaming ? 'running' : failed ? 'error' : incomplete ? 'incomplete' : response?.status === 206 ? 'warning' : response ? 'completed' : 'unknown'
  const add = (node: ActivityGraphNode) => { nodes.push(node); return node.id }
  const connect = (sources: string[], target: string, uncertain = false) => {
    sources.forEach((source) => edges.push({ id: `${source}->${target}`, source, target, uncertain }))
  }

  let previous = [add({
    id: 'request', kind: 'request', title: t('actGraphRequest'),
    subtitle: request ? ['messages', 'intents'].filter((key) => Array.isArray(request[key])).join(' / ') || t('actGraphRequested') : t('actGraphUnknown'),
    status: request ? 'completed' : 'unknown', raw: request,
    textBlocks: [
      ...messageTextBlocks(request?.messages),
      ...(Array.isArray(request?.intents) ? request.intents.filter(isActivityObject).flatMap((intent) => (
        typeof intent.search === 'string' && intent.search.trim().length > 0
          ? [{ label: typeof intent.type === 'string' ? `intents · ${intent.type}` : 'intents', text: intent.search }]
          : []
      )) : []),
    ],
  })]
  if (request) {
    const options = Object.fromEntries(Object.entries(request).filter(([key]) => !['messages', 'intents', 'knowledgeSourceParams'].includes(key)))
    const effort = isActivityObject(request.retrievalReasoningEffort) ? request.retrievalReasoningEffort.kind : undefined
    const id = add({
      id: 'config', kind: 'config', title: t('actGraphSettings'),
      subtitle: typeof effort === 'string' ? `${t('actTimelineLogicalEffort')}: ${effort}` : t('actGraphRequested'),
      status: 'configured', raw: options, parameters: options,
    })
    connect(previous, id)
    previous = [id]
    sourceParams.filter((param) => param.neverQuerySource === true).forEach((param, index) => {
      const excluded = add({
        id: `excluded-${index}`, kind: 'excluded', title: String(param.knowledgeSourceName ?? t('actGraphUnknown')),
        subtitle: t('actGraphExcluded'), status: 'configured', raw: param, parameters: param,
      })
      connect([id], excluded, true)
    })
  }

  const addActivity = (item: ActivityItem, index: number) => {
    const parameters = sourceParams.find((param) => param.knowledgeSourceName === item.knowledgeSourceName)
    const id = add({
      id: `activity-${index}`, kind: 'activity', title: item.type || t('actGraphUnknown'),
      subtitle: [item.knowledgeSourceName, item.search].filter(Boolean).join(' · '),
      status: item.raw.error ? 'error' : item.raw.warning ? 'warning' : running.has(String(item.id)) ? streaming ? 'running' : 'incomplete' : outcome === 'unknown' ? 'unknown' : 'completed',
      raw: item.raw, item, parameters,
    })
    return id
  }
  for (let i = 0; i < items.length;) {
    const item = items[i]
    if (!sourceTypes.has(item.type)) {
      const id = addActivity(item, i)
      connect(previous, id)
      previous = [id]
      i += 1
      continue
    }
    const run: ActivityItem[] = []
    const start = i
    while (i < items.length && sourceTypes.has(items[i].type)) run.push(items[i++])
    const sourceTiming = buildActivityTiming(run)
    const observedParallel = new Set(sourceTiming.rows.filter((row) => row.overlaps).map((row) => row.item))
    const ids = run.map((source, index) => {
      const observed = observedParallel.has(source)
      const id = addActivity(source, start + index)
      connect(previous, id, run.length > 1 && !observed)
      return id
    })
    previous = ids
  }
  if (items.length === 0) {
    const id = add({
      id: 'unobserved', kind: 'activity', title: t('actGraphNoActivity'), subtitle: t('actGraphUnknown'),
      status: 'unknown', raw: null,
    })
    connect(previous, id, true)
    previous = [id]
  }
  const references = Array.isArray(body?.references) ? body.references : null
  const merge = add({
    id: 'references', kind: 'merge', title: t('actGraphReferences'),
    subtitle: references ? `${t('actGraphReferenceCount')}: ${references.length}` : t('actGraphUnknown'),
    status: references ? streaming ? 'running' : outcome : 'unknown',
    raw: references,
    parameters: request ? Object.fromEntries(Object.entries(request).filter(([key]) => ['maxRuntimeInSeconds', 'maxOutputSizeInTokens', 'maxOutputDocuments'].includes(key))) : undefined,
  })
  connect(previous, merge)
  const result = add({
    id: 'result', kind: 'result', title: t('actGraphResult'),
    subtitle: typeof request?.outputMode === 'string' ? request.outputMode : t('actGraphUnknown'),
    status: outcome, raw: body?.error ?? body?.response ?? null,
    textBlocks: messageTextBlocks(body?.response),
  })
  connect([merge], result)
  const delivery = add({
    id: 'delivery', kind: 'delivery', title: t('actGraphDelivery'),
    subtitle: `${response?.responseFormat?.toUpperCase() ?? t('actGraphUnknown')}${response ? ` · ${response.responseFormat === 'sse' ? t('actGraphResponseStatus') : 'HTTP'} ${response.status}` : ''}`,
    status: outcome,
    raw: response ? { status: response.status, responseFormat: response.responseFormat ?? null, streamState: response.streamState ? { ...response.streamState } : null, error: body?.error ?? null } : null,
  })
  connect([result], delivery)
  return { nodes, edges }
}
