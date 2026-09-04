/**
 * AgenticActivityTimeline – Hierarchical flow visualisation for agentic retrieval activity.
 *
 * Renders a vertical timeline that groups activity items into "rounds":
 *   modelQueryPlanning  →  source searches (parallel)  →  agenticReasoning  →  modelAnswerSynthesis
 *
 * Each step shows type badge, key metrics (tokens / count / elapsed), and
 * an expandable RAW JSON detail.
 */

import React, { useState } from 'react'
import type { TranslationKey } from '../../lib/translations'
import type { JsonValue } from '../../lib/aiSearchRest'
import { JsonViewer } from './JsonViewer'
import { JSON_VIEWER_MAX_STRING_LENGTH } from '../../app/constants'

type TFunction = (key: TranslationKey) => string

/* ── helpers ────────────────────────────────────────────────── */

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type ActivityType =
  | 'modelQueryPlanning'
  | 'searchIndex'
  | 'web'
  | 'indexedSharePoint'
  | 'azureBlob'
  | 'modelWebSummarization'
  | 'agenticReasoning'
  | 'modelAnswerSynthesis'
  | string

interface ActivityItem {
  type: ActivityType
  id: number | string
  raw: Record<string, JsonValue>

  /* optional fields pulled for display */
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
  modelName?: string
  deploymentId?: string
}

/** Classify a type string into a visual category. */
function typeCategory(type: string): 'planning' | 'source' | 'reasoning' | 'synthesis' | 'unknown' {
  if (type === 'modelQueryPlanning') return 'planning'
  if (type === 'agenticReasoning') return 'reasoning'
  if (type === 'modelAnswerSynthesis') return 'synthesis'
  if (['searchIndex', 'web', 'indexedSharePoint', 'azureBlob', 'modelWebSummarization'].includes(type)) return 'source'
  // Treat unknown knowledge-source types as source
  if (type !== 'modelQueryPlanning' && type !== 'agenticReasoning' && type !== 'modelAnswerSynthesis') return 'source'
  return 'unknown'
}

type Round = {
  planning: ActivityItem | null
  sources: ActivityItem[]
}

/** Group sequential activity items into "rounds" of planning + sources. */
function buildRounds(items: ActivityItem[]): {
  rounds: Round[]
  reasoning: ActivityItem | null
  synthesis: ActivityItem | null
} {
  const rounds: Round[] = []
  let currentRound: Round | null = null
  let reasoning: ActivityItem | null = null
  let synthesis: ActivityItem | null = null

  for (const item of items) {
    const cat = typeCategory(item.type)

    if (cat === 'planning') {
      // A new planning step always starts a new round.
      currentRound = { planning: item, sources: [] }
      rounds.push(currentRound)
    } else if (cat === 'source') {
      if (!currentRound) {
        currentRound = { planning: null, sources: [] }
        rounds.push(currentRound)
      }
      currentRound.sources.push(item)
    } else if (cat === 'reasoning') {
      reasoning = item
      currentRound = null // subsequent sources would be a new round
    } else if (cat === 'synthesis') {
      synthesis = item
    }
  }

  return { rounds, reasoning, synthesis }
}

function parseActivity(raw: JsonValue): ActivityItem | null {
  if (!isJsonObject(raw)) return null
  const type = typeof raw.type === 'string' ? raw.type : ''
  const id = typeof raw.id === 'number' ? raw.id : typeof raw.id === 'string' ? raw.id : 0

  const elapsedMs = typeof raw.elapsedMs === 'number' ? raw.elapsedMs : undefined
  const inputTokens = typeof raw.inputTokens === 'number' ? raw.inputTokens : undefined
  const outputTokens = typeof raw.outputTokens === 'number' ? raw.outputTokens : undefined
  const reasoningTokens = typeof raw.reasoningTokens === 'number' ? raw.reasoningTokens : undefined
  const count = typeof raw.count === 'number' ? raw.count : undefined
  const knowledgeSourceName = typeof raw.knowledgeSourceName === 'string' ? raw.knowledgeSourceName : undefined

  const retrievalReasoningEffortObj = isJsonObject(raw.retrievalReasoningEffort) ? raw.retrievalReasoningEffort : null
  const retrievalReasoningEffort = typeof retrievalReasoningEffortObj?.kind === 'string' ? retrievalReasoningEffortObj.kind : undefined
  const logicalReasoningEffortObj = isJsonObject(raw.logicalReasoningEffort) ? raw.logicalReasoningEffort : null
  const logicalReasoningEffort = typeof logicalReasoningEffortObj?.kind === 'string' ? logicalReasoningEffortObj.kind : undefined

  // Extract search string from various argument objects
  let search: string | undefined
  for (const argKey of ['searchIndexArguments', 'webArguments', 'indexedSharePointArguments', 'azureBlobArguments']) {
    const args = isJsonObject(raw[argKey]) ? raw[argKey] : null
    if (args && typeof args.search === 'string') { search = args.search; break }
  }

  const queryTime = typeof raw.queryTime === 'string' ? raw.queryTime : undefined
  const model = isJsonObject(raw.model) ? raw.model : null
  const modelName = typeof model?.modelName === 'string'
    ? model.modelName
    : typeof raw.modelName === 'string' ? raw.modelName : undefined
  const deploymentId = typeof model?.deploymentId === 'string'
    ? model.deploymentId
    : typeof raw.deploymentId === 'string' ? raw.deploymentId : undefined

  return { type, id, raw: raw as Record<string, JsonValue>, elapsedMs, inputTokens, outputTokens, reasoningTokens, count, knowledgeSourceName, search, logicalReasoningEffort, retrievalReasoningEffort, queryTime, modelName, deploymentId }
}

/* ── badge colours ──────────────────────────────────────────── */

const badgeStyle: Record<string, { bg: string; color: string; icon: string }> = {
  modelQueryPlanning:  { bg: '#dbedff', color: '#0366d6', icon: 'bi-diagram-3' },
  searchIndex:         { bg: '#dcffe4', color: '#22863a', icon: 'bi-search' },
  web:                 { bg: '#fff3cd', color: '#856404', icon: 'bi-globe' },
  modelWebSummarization:{ bg: '#fff1e6', color: '#9a4a00', icon: 'bi-file-text' },
  indexedSharePoint:   { bg: '#e8daef', color: '#6f42c1', icon: 'bi-file-earmark-richtext' },
  azureBlob:           { bg: '#d1ecf1', color: '#0c5460', icon: 'bi-cloud' },
  mcpServer:           { bg: '#e2f2ef', color: '#146c5a', icon: 'bi-plugin' },
  agenticReasoning:    { bg: '#f5f0ff', color: '#6f42c1', icon: 'bi-cpu' },
  modelAnswerSynthesis:{ bg: '#ffeef0', color: '#cb2431', icon: 'bi-chat-dots' },
}
const defaultBadge = { bg: '#f1f1f1', color: '#586069', icon: 'bi-question-circle' }

function TypeBadge({ type }: { type: string }) {
  const s = badgeStyle[type] ?? defaultBadge
  return (
    <span
      className="actTimeline__badge"
      style={{ background: s.bg, color: s.color }}
    >
      <i className={`bi ${s.icon}`} style={{ marginRight: 4, fontSize: 11 }} />
      {type}
    </span>
  )
}

/* ── Metric pills ───────────────────────────────────────────── */

function MetricPill({ label, value, unit }: { label: string; value: number | string; unit?: string }) {
  return (
    <span className="actTimeline__metric">
      <span className="actTimeline__metricLabel">{label}</span>
      <span className="actTimeline__metricValue">{typeof value === 'number' ? value.toLocaleString() : value}{unit ? ` ${unit}` : ''}</span>
    </span>
  )
}

/* ── Step card ──────────────────────────────────────────────── */

function StepCard({ item, t, indent, status }: {
  item: ActivityItem
  t: TFunction
  indent?: boolean
  status?: 'running' | 'completed'
}) {
  const [rawOpen, setRawOpen] = useState(false)

  return (
    <div className={'actTimeline__step' + (indent ? ' actTimeline__step--indent' : '')}>
      <div className="actTimeline__stepHeader">
        <TypeBadge type={item.type} />
        <span className="actTimeline__stepId">id: {item.id}</span>
        {status && (
          <span className={`actTimeline__status actTimeline__status--${status}`}>
            <i className={`bi ${status === 'running' ? 'bi-arrow-repeat spin' : 'bi-check-circle-fill'}`} aria-hidden="true"></i>
            {status === 'running' ? t('agenticActivityRunning') : t('agenticActivityCompleted')}
          </span>
        )}
      </div>

      <div className="actTimeline__metrics">
        {item.elapsedMs !== undefined && <MetricPill label={t('actTimelineElapsed')} value={item.elapsedMs} unit="ms" />}
        {item.inputTokens !== undefined && <MetricPill label={t('actTimelineInputTokens')} value={item.inputTokens} />}
        {item.outputTokens !== undefined && <MetricPill label={t('actTimelineOutputTokens')} value={item.outputTokens} />}
        {item.reasoningTokens !== undefined && <MetricPill label={t('actTimelineReasoningTokens')} value={item.reasoningTokens} />}
        {item.count !== undefined && <MetricPill label={t('actTimelineHits')} value={item.count} />}
        {item.logicalReasoningEffort && <MetricPill label={t('actTimelineLogicalEffort')} value={item.logicalReasoningEffort} />}
        {item.retrievalReasoningEffort && <MetricPill label={t('actTimelineRetrievalEffort')} value={item.retrievalReasoningEffort} />}
        {item.modelName && <MetricPill label="model" value={item.modelName} />}
        {item.deploymentId && <MetricPill label="deployment" value={item.deploymentId} />}
      </div>

      {item.knowledgeSourceName && (
        <div className="actTimeline__ksName">
          <i className="bi bi-database" style={{ marginRight: 4, fontSize: 11 }} />
          {item.knowledgeSourceName}
        </div>
      )}
      {item.search && (
        <div className="actTimeline__query">
          <i className="bi bi-search" style={{ marginRight: 4, fontSize: 11 }} />
          <code>{item.search}</code>
        </div>
      )}

      <details className="resultCard__details" open={rawOpen} onToggle={(e) => setRawOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="resultCard__summary">
          <span className="resultCard__summaryIcon">▶</span>
          <span className="resultCard__summaryText">RAW ACTIVITY</span>
        </summary>
        {rawOpen && (
          <div className="mono jsonViewer__body rawJsonViewer">
            <JsonViewer
              data={item.raw as unknown as JsonValue}
              initialOpenDepth={2}
              maxStringLength={JSON_VIEWER_MAX_STRING_LENGTH}
              hideRootObjectToggle
              collapseArraysByDefault
              t={t}
            />
          </div>
        )}
      </details>
    </div>
  )
}

/* ── Parallel lane (for concurrent source queries) ──────────── */

function ParallelLane({ sources, t, getStatus }: {
  sources: ActivityItem[]
  t: TFunction
  getStatus: (item: ActivityItem) => 'running' | 'completed' | undefined
}) {
  if (sources.length === 0) return null
  const isMultiple = sources.length > 1

  return (
    <div className="actTimeline__parallel">
      {isMultiple && (
        <div className="actTimeline__parallelLabel">
          <i className="bi bi-arrows-expand" style={{ marginRight: 4 }} />
          {t('actTimelineParallel')} ({sources.length})
        </div>
      )}
      <div className={isMultiple ? 'actTimeline__parallelGrid' : ''}>
        {sources.map((src) => (
          <StepCard key={String(src.id)} item={src} t={t} indent={isMultiple} status={getStatus(src)} />
        ))}
      </div>
    </div>
  )
}

/* ── Main component ─────────────────────────────────────────── */

export interface AgenticActivityTimelineProps {
  activity: JsonValue[]
  t: TFunction
  runningActivityIds?: string[]
}

export function AgenticActivityTimeline({ activity, t, runningActivityIds }: AgenticActivityTimelineProps) {
  const items = activity.map(parseActivity).filter((x): x is ActivityItem => x !== null)
  const runningActivityIdSet = new Set(runningActivityIds)
  const getStatus = (item: ActivityItem): 'running' | 'completed' | undefined => (
    runningActivityIds === undefined
      ? undefined
      : runningActivityIdSet.has(String(item.id)) ? 'running' : 'completed'
  )

  if (items.length === 0) return null

  const { rounds, reasoning, synthesis } = buildRounds(items)

  // Calculate totals
  const totalElapsed = items.reduce((sum, i) => sum + (i.elapsedMs ?? 0), 0)
  const totalInputTokens = items.reduce((sum, i) => sum + (i.inputTokens ?? 0), 0)
  const totalOutputTokens = items.reduce((sum, i) => sum + (i.outputTokens ?? 0), 0)
  const totalReasoningTokens = items.reduce((sum, i) => sum + (i.reasoningTokens ?? 0), 0)

  return (
    <div className="actTimeline">
      {/* Summary bar */}
      <div className="actTimeline__summary">
        <span className="actTimeline__summaryTitle">
          <i className="bi bi-activity" style={{ marginRight: 4 }} />
          {t('actTimelineTitle')}
        </span>
        <div className="actTimeline__summaryMetrics">
          <MetricPill label={t('actTimelineSteps')} value={items.length} />
          {totalElapsed > 0 && <MetricPill label={t('actTimelineTotalElapsed')} value={totalElapsed} unit="ms" />}
          {totalInputTokens > 0 && <MetricPill label={t('actTimelineInputTokens')} value={totalInputTokens} />}
          {totalOutputTokens > 0 && <MetricPill label={t('actTimelineOutputTokens')} value={totalOutputTokens} />}
          {totalReasoningTokens > 0 && <MetricPill label={t('actTimelineReasoningTokens')} value={totalReasoningTokens} />}
        </div>
      </div>

      {/* Timeline */}
      <div className="actTimeline__flow">
        {rounds.map((round, ri) => (
          <React.Fragment key={ri}>
            {/* Round header (if multiple rounds) */}
            {rounds.length > 1 && (
              <div className="actTimeline__roundLabel">
                {t('actTimelineRound')} {ri + 1}
              </div>
            )}

            {/* Planning step */}
            {round.planning && <StepCard item={round.planning} t={t} status={getStatus(round.planning)} />}

            {/* Connector arrow */}
            {round.planning && round.sources.length > 0 && <div className="actTimeline__arrow">↓</div>}

            {/* Source queries (parallel lane) */}
            <ParallelLane sources={round.sources} t={t} getStatus={getStatus} />

            {/* Connector to next round or to reasoning */}
            {ri < rounds.length - 1 && <div className="actTimeline__arrow">↓</div>}
          </React.Fragment>
        ))}

        {/* Reasoning */}
        {reasoning && (
          <>
            <div className="actTimeline__arrow">↓</div>
            <StepCard item={reasoning} t={t} status={getStatus(reasoning)} />
          </>
        )}

        {/* Synthesis */}
        {synthesis && (
          <>
            <div className="actTimeline__arrow">↓</div>
            <StepCard item={synthesis} t={t} status={getStatus(synthesis)} />
          </>
        )}
      </div>
    </div>
  )
}
