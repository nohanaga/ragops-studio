import { useId, useMemo, useState, type ReactNode } from 'react'
import {
  activityStatusKeys, buildActivityGraph,
  type ActivityGraphStatus, type ActivityItem, type ActivityTranslator,
} from '../../lib/agenticActivityGraph'
import { buildActivityTiming, type ActivityTimingRow } from '../../lib/agenticActivityTiming'
import type { Language, TranslationKey } from '../../lib/translations'
import type { LatestResponse } from '../../types'
import { AgenticActivityDetails } from './AgenticActivityDetails'

type TraceKind = 'planning' | 'source' | 'reasoning' | 'synthesis' | 'model' | 'action'
const presentations: Record<TraceKind, { label: TranslationKey; icon: string }> = {
  planning: { label: 'actTracePlanning', icon: 'bi-diagram-3' },
  source: { label: 'actTraceSource', icon: 'bi-search' },
  reasoning: { label: 'actTraceReasoning', icon: 'bi-cpu' },
  synthesis: { label: 'actTraceSynthesis', icon: 'bi-chat-dots' },
  model: { label: 'actTraceModel', icon: 'bi-stars' },
  action: { label: 'actTraceAction', icon: 'bi-lightning' },
}
const statusIcons: Record<ActivityGraphStatus, string> = {
  completed: 'bi-check-circle',
  running: 'bi-arrow-repeat spin',
  error: 'bi-x-circle',
  warning: 'bi-exclamation-triangle',
  incomplete: 'bi-dash-circle',
  unknown: 'bi-question-circle',
  configured: 'bi-info-circle',
}

function traceKind(item: ActivityItem): TraceKind {
  if (item.type === 'modelQueryPlanning') return 'planning'
  if (item.type === 'agenticReasoning') return 'reasoning'
  if (item.type === 'modelAnswerSynthesis') return 'synthesis'
  if (item.type.startsWith('model')) return 'model'
  if (item.knowledgeSourceName || ['searchIndex', 'web', 'azureBlob', 'indexedSharePoint', 'mcpServer'].includes(item.type)) return 'source'
  return 'action'
}

export function AgenticActivityTrace({ items, response, streaming, t, language, renderActivity }: {
  items: ActivityItem[]
  response?: LatestResponse
  streaming?: boolean
  t: ActivityTranslator
  language: Language
  renderActivity: (item: ActivityItem) => ReactNode
}) {
  const traceId = useId()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const timing = useMemo(() => buildActivityTiming(items), [items])
  const nodes = useMemo(() => buildActivityGraph({ items, response, streaming, t }).nodes.filter((node) => node.item), [items, response, streaming, t])
  const duration = (value: number | null) => {
    if (value === null) return t('actGraphUnknown')
    return value < 1000
      ? `${value.toLocaleString(language, { maximumFractionDigits: 1 })} ms`
      : `${(value / 1000).toLocaleString(language, { maximumFractionDigits: 2 })} s`
  }

  function renderRow(row: ActivityTimingRow) {
    const node = nodes.find((candidate) => candidate.id === row.id)
    const anchor = row.startMs ?? row.endMs
    const offset = !row.invalidTimes && anchor !== null && timing.originMs !== null ? anchor - timing.originMs : null
    const scale = Math.max(1, timing.spanMs)
    const kind = traceKind(row.item)
    const presentation = presentations[kind]
    const status = node?.status ?? 'unknown'
    const statusLabel = t(activityStatusKeys[status])
    const expanded = expandedId === row.id
    const detailsId = `${traceId}-${row.id}`
    const label = `${row.item.type} #${row.item.id}${row.item.knowledgeSourceName ? ` · ${row.item.knowledgeSourceName}` : ''}`
    const title = `${label} · startedAt: ${row.item.startedAt ?? t('actGraphUnknown')} · completedAt: ${row.item.completedAt ?? t('actGraphUnknown')} · ${t('actTraceDuration')}: ${duration(row.durationMs)}${offset !== null ? ` · ${t('actTraceOffset')}: ${duration(offset)}` : ''}${row.overlaps ? ` · ${t('actGraphObservedParallel')}` : ''}`
    return (
      <div
        className={`actTrace__item actTrace__item--${kind}${expanded ? ' actTrace__item--expanded' : ''}`}
        key={row.id}
        role="listitem"
        data-activity-id={row.id}
      >
        <div className="actTrace__row">
          <button
            type="button"
            className="actTrace__label"
            title={title}
            onClick={() => setExpandedId(expanded ? null : row.id)}
            aria-label={`${t(expanded ? 'actTraceCollapse' : 'actTraceExpand')}: ${label} · ${statusLabel}`}
            aria-expanded={expanded}
            aria-controls={detailsId}
          >
            <i className={`bi ${expanded ? 'bi-chevron-down' : 'bi-chevron-right'} actTrace__chevron`} aria-hidden="true" />
            <span className="actTrace__badge"><i className={`bi ${presentation.icon}`} aria-hidden="true" /> {t(presentation.label)}</span>
            <span className="actTrace__name">
              <span className="actTrace__type mono">{row.item.type}</span>
              <span className="actTrace__meta">{row.item.knowledgeSourceName ?? row.item.modelName ?? `#${row.item.id}`}</span>
            </span>
            <span className={`actTrace__status actTrace__status--${status}`} role="img" aria-label={statusLabel} title={statusLabel}>
              <i className={`bi ${statusIcons[status]}`} aria-hidden="true" />
            </span>
            {row.overlaps && <i className="bi bi-intersect actTrace__parallel" role="img" aria-label={t('actGraphObservedParallel')} title={t('actGraphObservedParallel')} />}
          </button>
          <div className="actTrace__track">
            {offset !== null ? (
              <button
                type="button"
                className={`actTrace__bar${row.durationMs === null ? ' actTrace__bar--point' : ''}${row.overlaps ? ' actTrace__bar--parallel' : ''} actTrace__bar--${status}`}
                style={{ left: `${(offset / scale) * 100}%`, width: `${((row.durationMs ?? 0) / scale) * 100}%` }}
                aria-label={title}
                aria-pressed={expanded}
                aria-controls={detailsId}
                title={title}
                onClick={() => setExpandedId(row.id)}
              />
            ) : (
              <span className="actTrace__unknown" title={t(row.invalidTimes ? 'actTraceInvalidTimes' : 'actTraceUnplacedNote')}>
                <i className={`bi ${row.invalidTimes ? 'bi-exclamation-triangle' : 'bi-dash-circle'}`} aria-hidden="true" /> {t('actTraceUnrecorded')}
              </span>
            )}
          </div>
          <span className="actTrace__duration mono">{row.durationMs === null ? t('actTraceUnrecorded') : duration(row.durationMs)}</span>
        </div>
        <div id={detailsId} className="actTrace__details" hidden={!expanded}>
          {expanded && node && (
            <AgenticActivityDetails
              nodes={[node]}
              selectedId={row.id}
              onSelect={setExpandedId}
              t={t}
              language={language}
              renderActivity={renderActivity}
              inline
            />
          )}
        </div>
      </div>
    )
  }

  if (items.length === 0) return <div className="notice notice--info">{t('actGraphNoActivity')}</div>

  return (
    <div className="actTrace">
      <div className="actTrace__header">
        <div className="actTrace__intro">
          <h4><i className="bi bi-activity" aria-hidden="true" /> {t('actTraceTitle')}</h4>
          {timing.originMs !== null && <span className="actTrace__origin mono">{t('actTraceOrigin')}: {new Date(timing.originMs).toISOString()}</span>}
        </div>
        <div className="actTrace__summary">
          <span className="actTrace__metric">{t('actTimelineSteps')} <strong>{items.length}</strong></span>
          <span className="actTrace__metric">{t('actTraceSpan')} <strong>{duration(timing.originMs === null ? null : timing.spanMs)}</strong></span>
          <span className="actTrace__metric">{t('actTraceWork')} <strong>{duration(timing.rows.some((row) => row.durationMs !== null) ? timing.workMs : null)}</strong></span>
          {timing.unplacedRows.length > 0 && <span className="actTrace__metric" title={t('actTraceUnplacedNote')}>{t('actTraceUnplacedCount')} <strong>{timing.unplacedRows.length}</strong></span>}
        </div>
      </div>
      <details className="actTrace__help">
        <summary><i className="bi bi-info-circle" aria-hidden="true" /> {t('actTraceAbout')}</summary>
        <p>{t('actTraceEvidence')}</p>
      </details>
      {timing.rows.some((row) => row.invalidTimes) && <div className="notice notice--warning" role="alert">{t('actTraceInvalidTimes')}</div>}
      {timing.originMs === null && <div className="notice notice--info">{t('actTraceNoTimes')}</div>}
      <div className="actTrace__chart" aria-label={t('actTraceView')}>
        <div className="actTrace__body">
          <div className="actTrace__axis">
            <span>{t('actTraceAction')}</span>
            <div className="actTrace__ticks" aria-hidden="true">
              {timing.originMs !== null && (timing.spanMs > 0 ? [0, 0.25, 0.5, 0.75, 1] : [0]).map((fraction) => (
                <span key={fraction} style={{ left: `${fraction * 100}%`, transform: fraction === 0 ? undefined : fraction === 1 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
                  {duration(fraction * timing.spanMs)}
                </span>
              ))}
            </div>
            <span className="actTrace__durationHeading">{t('actTraceDuration')}</span>
          </div>
          <div className="actTrace__items" role="list" aria-label={t('actTraceTitle')}>{timing.rows.map(renderRow)}</div>
        </div>
      </div>
    </div>
  )
}
