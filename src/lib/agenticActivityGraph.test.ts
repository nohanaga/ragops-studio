import { describe, expect, it } from 'vitest'
import type { JsonValue } from './aiSearchRest'
import type { LatestResponse } from '../types'
import { translations } from './translations'
import { buildActivityGraph, parseActivity, type ActivityItem } from './agenticActivityGraph'

const t = (key: keyof typeof translations.en) => translations.en[key]
function items(activity: JsonValue[]): ActivityItem[] {
  return activity.map(parseActivity).filter((item): item is ActivityItem => item !== null)
}
function response(overrides: Partial<LatestResponse> = {}): LatestResponse {
  return {
    at: undefined, requestId: 'request', url: '', status: 200, runType: 'agentic_retrieve',
    requestBody: { intents: [{ type: 'semantic', search: 'test' }], retrievalReasoningEffort: { kind: 'minimal' }, outputMode: 'extractiveData' },
    body: { response: [], references: [] }, responseFormat: 'json',
    ...overrides,
  }
}
const source = (id: number, startedAt?: string, completedAt?: string): Record<string, JsonValue> => ({
  id, type: 'searchIndex', knowledgeSourceName: `source-${id}`,
  ...(startedAt ? { startedAt } : {}), ...(completedAt ? { completedAt } : {}),
})

describe('agentic activity graph', () => {
  it('fans out observed overlapping source queries and joins before the next action', () => {
    const graph = buildActivityGraph({
      t, response: response(), items: items([
        { id: 0, type: 'modelQueryPlanning' },
        source(1, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.100Z'),
        source(2, '2026-10-22T00:00:00.050Z', '2026-10-22T00:00:00.150Z'),
        { id: 3, type: 'agenticReasoning' },
        { id: 4, type: 'modelAnswerSynthesis' },
      ]),
    })
    const links = graph.edges.map(({ source, target }) => `${source}->${target}`)
    expect(links).toEqual(expect.arrayContaining([
      'activity-0->activity-1', 'activity-0->activity-2',
      'activity-1->activity-3', 'activity-2->activity-3', 'activity-3->activity-4',
    ]))
    expect(links).not.toContain('activity-1->activity-2')
    expect(graph.nodes.find((node) => node.id === 'activity-1')?.subtitle).toBe('source-1')
    expect(graph.edges.filter((edge) => edge.source === 'activity-0').every((edge) => !edge.uncertain)).toBe(true)
  })

  it('keeps non-overlapping source queries in one logical fan-out without asserting concurrency', () => {
    const graph = buildActivityGraph({
      t, response: response(), items: items([
        source(1, '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00.100Z'),
        source(2, '2026-10-22T00:00:00.100Z', '2026-10-22T00:00:00.120Z'),
      ]),
    })
    expect(graph.edges.some((edge) => edge.source === 'activity-0' && edge.target === 'activity-1')).toBe(false)
    expect(graph.edges.filter((edge) => edge.source === 'config').map((edge) => edge.target)).toEqual(['activity-0', 'activity-1'])
    expect(graph.edges.filter((edge) => edge.source === 'config').every((edge) => edge.uncertain)).toBe(true)
    expect(graph.nodes.find((node) => node.id === 'activity-0')?.subtitle).toBe('source-1')
  })

  it('uses unconfirmed dashed branches when timing evidence is missing or invalid', () => {
    const activity = items([source(1), source(2, 'invalid', 'invalid')])
    const graph = buildActivityGraph({ t, response: response(), items: activity })
    expect(graph.nodes.find((node) => node.id === 'activity-0')?.subtitle).toBe('source-1')
    expect(graph.edges.filter((edge) => edge.source === 'config').every((edge) => edge.uncertain)).toBe(true)
  })

  it('keeps every action, repeated reasoning rounds, web summaries, and future types', () => {
    const activity = items([
      { id: 1, type: 'agenticReasoning' }, source(2),
      { id: 3, type: 'modelWebSummarization', inputTokens: 12 },
      { id: 4, type: 'modelQueryPlanning' }, source(5),
      { id: 6, type: 'agenticReasoning' }, { id: 7, type: 'futureActivity' },
      { id: 8, type: 'modelAnswerSynthesis' },
    ])
    const graph = buildActivityGraph({ t, response: response(), items: activity })
    expect(graph.nodes.filter((node) => node.item).map((node) => node.item?.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(graph.edges.some((edge) => edge.source === 'activity-1' && edge.target === 'activity-2')).toBe(true)
  })

  it('does not invent query planning for minimal, or auto evidence decisions', () => {
    for (const kind of ['minimal', 'auto']) {
      const graph = buildActivityGraph({
        t, items: items([source(1)]),
        response: response({ requestBody: { retrievalReasoningEffort: { kind } } }),
      })
      expect(graph.nodes.some((node) => node.title === 'modelQueryPlanning')).toBe(false)
      expect(graph.nodes.find((node) => node.id === 'config')?.status).toBe('configured')
      expect(graph.nodes.find((node) => node.id === 'config')?.subtitle).toContain(kind)
    }
  })

  it('keeps source controls distinct from executed arguments and excluded branches out of results', () => {
    const knowledgeSourceParams: JsonValue[] = [
      { knowledgeSourceName: 'excluded', neverQuerySource: true, failOnError: true },
      { knowledgeSourceName: 'source-1', alwaysQuerySource: true, resultsProcessing: 'none', queryHintOverrides: [] },
    ]
    const graph = buildActivityGraph({
      t, response: response({ requestBody: { knowledgeSourceParams } }),
      items: items([{
        ...source(1),
        searchIndexArguments: { search: 'executed', filter: 'status eq 1' },
        queryHintProcessing: { generatedFilter: 'category eq 2', generatedBoost: 'language:ja^2' },
      }]),
    })
    const excluded = graph.nodes.find((node) => node.kind === 'excluded')!
    expect(excluded.status).toBe('configured')
    expect(graph.edges.some((edge) => edge.source === excluded.id)).toBe(false)
    const executed = graph.nodes.find((node) => node.id === 'activity-0')!
    expect(executed.parameters).toEqual(knowledgeSourceParams[1])
    expect(executed.raw).toMatchObject({ queryHintProcessing: { generatedFilter: 'category eq 2' } })
    expect(executed.subtitle).toBe('source-1 · executed')
  })

  it.each(['ja', 'en'] as const)('keeps %s subtitles free of overlap and reranking annotations while retaining request details', (language) => {
    const param = { knowledgeSourceName: 'source-1', alwaysQuerySource: true, resultsProcessing: 'rerank' }
    const graph = buildActivityGraph({
      t: (key) => translations[language][key],
      response: response({ requestBody: { knowledgeSourceParams: [param] } }),
      items: items([
        { ...source(1, '2026-10-22T00:00:00Z', '2026-10-22T00:00:01Z'), searchIndexArguments: { search: 'products' } },
        source(2, '2026-10-22T00:00:00Z', '2026-10-22T00:00:01Z'),
      ]),
    })
    const node = graph.nodes.find((candidate) => candidate.id === 'activity-0')!
    expect(node.subtitle).toBe('source-1 · products')
    expect(node.parameters).toEqual(param)
    expect(graph.edges.filter((edge) => edge.source === 'config').every((edge) => !edge.uncertain)).toBe(true)
  })

  it('retains final messages, reference scores, citations and delivery format', () => {
    const body = {
      response: [{ role: 'assistant', content: [{ type: 'text', text: 'final answer' }] }],
      references: [{ id: '0', rerankerScore: 2.5, citationUrl: 'https://example.test/citation' }],
    }
    const graph = buildActivityGraph({ t, items: [], response: response({ body }) })
    expect(graph.nodes.find((node) => node.id === 'result')?.raw).toEqual(body.response)
    expect(graph.nodes.find((node) => node.id === 'references')?.raw).toEqual(body.references)
    expect(graph.nodes.find((node) => node.id === 'delivery')?.subtitle).toBe('JSON · HTTP 200')
    expect(graph.nodes.find((node) => node.id === 'unobserved')?.status).toBe('unknown')
  })

  it('updates SSE activities without new ids and preserves incomplete/error terminal states', () => {
    const activity = items([source(1)])
    const stream = response({
      responseFormat: 'sse',
      streamState: { eventCount: 2, lastEvent: 'activity.started', runningActivityIds: ['1'] },
    })
    const running = buildActivityGraph({ t, items: activity, response: stream, streaming: true })
    expect(running.nodes.find((node) => node.id === 'activity-0')?.status).toBe('running')
    const interrupted = buildActivityGraph({ t, items: activity, response: { ...stream, status: 0 }, streaming: false })
    expect(interrupted.nodes.find((node) => node.id === 'result')?.status).toBe('incomplete')
    expect(interrupted.nodes.find((node) => node.id === 'activity-0')?.status).toBe('incomplete')
    const done = buildActivityGraph({
      t, items: activity, response: { ...stream, streamState: { eventCount: 5, lastEvent: 'response.completed', runningActivityIds: [] } },
    })
    expect(done.nodes.find((node) => node.id === 'result')?.status).toBe('completed')
    expect(done.nodes.map((node) => node.id)).toEqual(running.nodes.map((node) => node.id))
    const error = buildActivityGraph({ t, items: activity, response: response({ status: 200, body: { error: { message: 'SSE failed' } } }) })
    expect(error.nodes.find((node) => node.id === 'result')?.status).toBe('error')
  })

  it('shows 206 partial success, source errors, and 502 failure without claiming success', () => {
    const partial = buildActivityGraph({
      t, response: response({ status: 206 }),
      items: items([{ id: 1, type: 'searchIndex', error: { message: 'source failed' } }]),
    })
    expect(partial.nodes.find((node) => node.id === 'result')?.status).toBe('warning')
    expect(partial.nodes.find((node) => node.item)?.status).toBe('error')
    const failed = buildActivityGraph({ t, items: [], response: response({ status: 502, body: { error: { message: 'failOnError' } } }) })
    expect(failed.nodes.find((node) => node.id === 'result')?.status).toBe('error')
  })

  it('does not invent transport or stored defaults for historical responses', () => {
    const graph = buildActivityGraph({ t, items: [], response: response({ requestBody: null, responseFormat: undefined }) })
    expect(graph.nodes.some((node) => node.id === 'config')).toBe(false)
    expect(graph.nodes.find((node) => node.id === 'delivery')?.subtitle).toContain('Unknown / not recorded')
  })

  it('parses nested and legacy models, MCP search arguments, and requested/billed efforts', () => {
    expect(parseActivity({
      type: 'agenticReasoning', id: 'a',
      model: { modelName: 'nested', deploymentId: 'deployment' },
      modelName: 'legacy',
      logicalReasoningEffort: { kind: 'auto' }, retrievalReasoningEffort: { kind: 'low' },
      mcpServerArguments: { search: 'tool query' },
    })).toMatchObject({
      modelName: 'nested', deploymentId: 'deployment', search: 'tool query',
      logicalReasoningEffort: 'auto', retrievalReasoningEffort: 'low',
    })
    expect(parseActivity({ type: 'modelAnswerSynthesis', modelName: 'legacy' })?.modelName).toBe('legacy')
    expect(parseActivity(null)).toBeNull()
  })
})
