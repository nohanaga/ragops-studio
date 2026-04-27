/**
 * Resizable-column results table for the Eval Dataset Generator.
 *
 * Built natively (no extra dependency) around a `<colgroup>` whose `<col>` widths
 * are driven from React state. Each header cell carries a drag handle that
 * mutates the stored width on pointermove. Keeps wrap-text cells for content /
 * query previews so the user can actually read the ground truth excerpt.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'

import type { translations } from '../../lib/translations'
import type { GeneratedQAItem, TraceEvent } from '../../types'

type TranslationKey = keyof typeof translations.ja

export interface EdgResultsTableProps {
  t: (key: TranslationKey) => string
  items: GeneratedQAItem[]
  showRejected: boolean
  /** id → original content text (from the latest sampling pass). */
  docTextById: Record<string, string>
  enableRagasMode: boolean
  enableDifficultyEvolution: boolean
  enableHardNegativeMining: boolean
  enableStyleEvolution?: boolean
  enableTrace?: boolean
  enableRaftMode?: boolean
}

type ColDef = {
  key: string
  title: string
  width: number
  mono?: boolean
  wrap?: boolean
  render: (it: GeneratedQAItem, idx: number) => ReactNode
  /** Optional full-text tooltip (overrides the default rendered content as title). */
  titleFn?: (it: GeneratedQAItem) => string | undefined
}

const MIN_COL_WIDTH = 60
const MAX_COL_WIDTH = 1000

const CONTENT_PREVIEW_MAX_CHARS = 200

/** Best-effort content preview for the first expected_id (or source_doc_id). */
function previewFor(it: GeneratedQAItem, docTextById: Record<string, string>): string {
  const id = it.source_doc_id || it.expected_ids[0] || ''
  const text = id ? docTextById[id] : ''
  if (!text) return ''
  // Collapse whitespace to keep the cell readable when wrapped.
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length > CONTENT_PREVIEW_MAX_CHARS) {
    return collapsed.slice(0, CONTENT_PREVIEW_MAX_CHARS) + '…'
  }
  return collapsed
}

export function EdgResultsTable(props: EdgResultsTableProps) {
  const {
    t,
    items,
    showRejected,
    docTextById,
    enableRagasMode,
    enableDifficultyEvolution,
    enableHardNegativeMining,
    enableStyleEvolution,
    enableTrace,
    enableRaftMode,
  } = props

  const columns = useMemo<ColDef[]>(() => {
    const cols: ColDef[] = [
      {
        key: 'idx',
        title: '#',
        width: 48,
        mono: true,
        render: (_it, idx) => idx + 1,
      },
      {
        key: 'query',
        title: String(t('edgColQuery')),
        width: 320,
        wrap: true,
        render: (it) => it.query,
      },
      {
        key: 'expected_ids',
        title: String(t('edgColExpectedIds')),
        width: 140,
        mono: true,
        render: (it) => it.expected_ids.join(', '),
      },
      {
        key: 'content_preview',
        title: String(t('edgColContentPreview')),
        width: 240,
        wrap: true,
        render: (it) => previewFor(it, docTextById),
        titleFn: (it) => {
          const id = it.source_doc_id || it.expected_ids[0] || ''
          const text = id ? docTextById[id] : ''
          return text ? text.replace(/\s+/g, ' ').trim() : undefined
        },
      },
      {
        key: 'query_type',
        title: String(t('edgColType')),
        width: 110,
        mono: true,
        render: (it) => it.query_type ?? '',
      },
      {
        key: 'language',
        title: String(t('edgColLanguage')),
        width: 80,
        mono: true,
        render: (it) => it.language ?? '',
      },
    ]
    if (enableRagasMode) {
      cols.push(
        {
          key: 'query_shape',
          title: String(t('edgColShape')),
          width: 140,
          mono: true,
          render: (it) => it.query_shape ?? '',
        },
        {
          key: 'persona',
          title: String(t('edgColPersona')),
          width: 140,
          render: (it) => it.persona ?? '',
        },
        {
          key: 'style',
          title: String(t('edgColStyle')),
          width: 110,
          mono: true,
          render: (it) => it.style ?? '',
        },
      )
    }
    if (enableDifficultyEvolution) {
      cols.push({
        key: 'difficulty',
        title: String(t('edgColDifficulty')),
        width: 90,
        mono: true,
        render: (it) => it.difficulty ?? '',
      })
    }
    if (enableHardNegativeMining) {
      cols.push({
        key: 'hard_negative_ids',
        title: String(t('edgColHardNegatives')),
        width: 200,
        mono: true,
        render: (it) => (it.hard_negative_ids ?? []).join(', '),
      })
    }
    if (enableStyleEvolution) {
      cols.push({
        key: 'style_evolution_kind',
        title: String(t('edgColStyleEvolution')),
        width: 120,
        mono: true,
        render: (it) => {
          if (!it.style_evolution_kind) return ''
          const labelKey = STYLE_KIND_LABELS[it.style_evolution_kind]
          return labelKey ? t(labelKey) : it.style_evolution_kind
        },
      })
    }
    if (enableTrace) {
      cols.push({
        key: 'trace',
        title: String(t('edgColTrace')),
        width: 90,
        mono: true,
        render: (it) => (it.trace?.length ?? 0) > 0 ? `${it.trace!.length} steps` : '',
      })
    }
    if (enableRaftMode) {
      cols.push(
        {
          key: 'raft_cot_answer',
          title: String(t('edgColRaftCot')),
          width: 300,
          wrap: true,
          render: (it) => {
            const cot = it.raft_cot_answer
            if (!cot) return ''
            return cot.length > CONTENT_PREVIEW_MAX_CHARS
              ? cot.slice(0, CONTENT_PREVIEW_MAX_CHARS) + '…'
              : cot
          },
          titleFn: (it) => it.raft_cot_answer ?? undefined,
        },
        {
          key: 'raft_context',
          title: String(t('edgColRaftContext')),
          width: 180,
          mono: true,
          render: (it) => {
            const ctx = it.raft_context
            if (!ctx || ctx.length === 0) return ''
            const oracle = ctx.filter((c) => c.oracle).length
            const dist = ctx.filter((c) => !c.oracle).length
            return `oracle:${oracle} / dist:${dist}`
          },
          titleFn: (it) => {
            const ctx = it.raft_context
            if (!ctx || ctx.length === 0) return undefined
            return ctx.map((c) => `[${c.oracle ? 'ORACLE' : 'DIST'}] ${c.doc_id}: ${c.text.slice(0, 80)}`).join('\n')
          },
        },
      )
    }
    cols.push(
      {
        key: 'grounding_rank',
        title: String(t('edgColGroundingRank')),
        width: 110,
        mono: true,
        render: (it) => {
          if (typeof it.grounding_rank !== 'number') return ''
          return it.grounding_rank === 0 ? '—' : `#${it.grounding_rank}`
        },
      },
      {
        key: 'rejected',
        title: String(t('edgColRejected')),
        width: 130,
        mono: true,
        render: (it) => (it.rejected ? it.rejection_reason ?? 'yes' : ''),
      },
    )
    return cols
    // docTextById is intentionally a dependency because preview cells depend on it.
  }, [t, docTextById, enableRagasMode, enableDifficultyEvolution, enableHardNegativeMining, enableStyleEvolution, enableTrace, enableRaftMode])

  // Store user-resized widths. Columns without overrides use their default width.
  const [widths, setWidths] = useState<Record<string, number>>({})
  const effectiveWidths = useMemo(() => {
    const out: Record<string, number> = {}
    for (const c of columns) out[c.key] = widths[c.key] ?? c.width
    return out
  }, [columns, widths])

  const dragState = useRef<{
    key: string
    startX: number
    startWidth: number
  } | null>(null)
  const [activeResizer, setActiveResizer] = useState<string | null>(null)

  const tableRef = useRef<HTMLTableElement>(null)

  /** Double-click a resizer to auto-fit the column width to its content. */
  const onResizerDoubleClick = useCallback(
    (key: string) => () => {
      const table = tableRef.current
      if (!table) return
      const colIdx = columns.findIndex((c) => c.key === key)
      if (colIdx < 0) return
      // Measure the natural width of each cell in this column.
      let maxW = MIN_COL_WIDTH
      const cells = table.querySelectorAll<HTMLElement>(
        `thead th:nth-child(${colIdx + 1}), tbody td:nth-child(${colIdx + 1})`,
      )
      cells.forEach((cell) => {
        // Temporarily remove width constraints so scrollWidth reflects content.
        const prev = cell.style.width
        cell.style.width = 'auto'
        maxW = Math.max(maxW, cell.scrollWidth + 2)
        cell.style.width = prev
      })
      const fitted = Math.min(MAX_COL_WIDTH, maxW)
      setWidths((prev) => ({ ...prev, [key]: fitted }))
    },
    [columns],
  )

  const onResizerPointerDown = useCallback(
    (key: string) => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragState.current = {
        key,
        startX: e.clientX,
        startWidth: effectiveWidths[key] ?? MIN_COL_WIDTH,
      }
      setActiveResizer(key)
      const target = e.currentTarget
      target.setPointerCapture(e.pointerId)

      const onMove = (ev: PointerEvent) => {
        const s = dragState.current
        if (!s) return
        const delta = ev.clientX - s.startX
        const next = Math.max(MIN_COL_WIDTH, Math.min(MAX_COL_WIDTH, s.startWidth + delta))
        setWidths((prev) => (prev[s.key] === next ? prev : { ...prev, [s.key]: next }))
      }
      const onUp = () => {
        dragState.current = null
        setActiveResizer(null)
        target.removeEventListener('pointermove', onMove)
        target.removeEventListener('pointerup', onUp)
        target.removeEventListener('pointercancel', onUp)
      }
      target.addEventListener('pointermove', onMove)
      target.addEventListener('pointerup', onUp)
      target.addEventListener('pointercancel', onUp)
    },
    [effectiveWidths],
  )

  const rows = items.filter((it) => showRejected || !it.rejected)
  const [traceModalItem, setTraceModalItem] = useState<GeneratedQAItem | null>(null)

  return (
    <div className="edgResults__tableWrap">
      <table className="spvTable edgResults__table" ref={tableRef}>
        <colgroup>
            {columns.map((c) => (
            <col key={c.key} style={{ width: `${effectiveWidths[c.key]}px` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={c.mono ? 'edgMono' : undefined}
                title={c.title}
              >
                {c.title}
                <div
                  className={`edgColResizer${activeResizer === c.key ? ' edgColResizer--active' : ''}`}
                  onPointerDown={onResizerPointerDown(c.key)}
                  onDoubleClick={onResizerDoubleClick(c.key)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((it, idx) => (
            <tr
              key={idx}
              className={it.rejected ? 'edgResults__row--rejected' : undefined}
            >
              {columns.map((c) => {
                const classNames: string[] = []
                if (c.mono) classNames.push('edgMono')
                if (c.wrap) classNames.push('edgCell--wrap')
                const content = c.render(it, idx)
                const titleStr = c.titleFn
                  ? c.titleFn(it)
                  : typeof content === 'string' ? content : undefined
                // Trace column: render as clickable button
                if (c.key === 'trace' && (it.trace?.length ?? 0) > 0) {
                  return (
                    <td key={c.key} className="edgMono">
                      <button
                        type="button"
                        className="btn btn--xs edgTraceBtn"
                        onClick={() => setTraceModalItem(it)}
                      >
                        {it.trace!.length} steps
                      </button>
                    </td>
                  )
                }
                return (
                  <td
                    key={c.key}
                    className={classNames.length ? classNames.join(' ') : undefined}
                    title={titleStr}
                  >
                    {content}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Trace Modal */}
      {traceModalItem && (
        <TraceModal
          t={t}
          item={traceModalItem}
          onClose={() => setTraceModalItem(null)}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Trace Modal — vertical pipeline timeline                            */
/* ------------------------------------------------------------------ */

const PHASE_LABELS: Record<string, string> = {
  generation: 'edgTracePhaseGenerationLabel',
  'surface-dedup': 'edgTracePhaseSurfaceDedupLabel',
  grounding: 'edgTracePhaseGroundingLabel',
  'semantic-dedup': 'edgTracePhaseSemanticDedupLabel',
  'style-evolution': 'edgTracePhaseStyleEvolutionLabel',
  difficulty: 'edgTracePhaseDifficultyLabel',
  hardneg: 'edgTracePhaseHardnegLabel',
  relevance: 'edgTracePhaseRelevanceLabel',
}

const PHASE_DESC: Record<string, TranslationKey> = {
  generation: 'edgTracePhaseGenerationDesc',
  'surface-dedup': 'edgTracePhaseSurfaceDedupDesc',
  grounding: 'edgTracePhaseGroundingDesc',
  'semantic-dedup': 'edgTracePhaseSemanticDedupDesc',
  'style-evolution': 'edgTracePhaseStyleEvolutionDesc',
  difficulty: 'edgTracePhaseDifficultyDesc',
  hardneg: 'edgTracePhaseHardnegDesc',
  relevance: 'edgTracePhaseRelevanceDesc',
}

const ACTION_LABELS: Record<string, TranslationKey> = {
  created: 'edgTraceActionCreated',
  kept: 'edgTraceActionKept',
  rejected: 'edgTraceActionRejected',
  modified: 'edgTraceActionModified',
  enriched: 'edgTraceActionEnriched',
}

const STYLE_KIND_LABELS: Record<string, TranslationKey> = {
  keyword: 'edgSeKeyword',
  colloquial: 'edgSeColloquial',
  typo: 'edgSeTypo',
  abbreviated: 'edgSeAbbreviated',
  code_switch: 'edgSeCodeSwitch',
}

const TRACE_REASON_KEYS: Record<string, TranslationKey> = {
  unchanged: 'edgTraceReasonUnchanged',
  error: 'edgTraceReasonError',
  'surface-dup': 'edgTraceReasonSurfaceDup',
  'semantic-dup': 'edgTraceReasonSemanticDup',
  'no-candidate-ids': 'edgTraceReasonNoCandidateIds',
  grounding: 'edgTraceReasonGrounding',
}

const ACTION_ICONS: Record<string, string> = {
  created: '🟢',
  kept: '🔵',
  rejected: '🔴',
  modified: '🟠',
  enriched: '🟣',
}

function TraceModal(props: {
  t: (key: TranslationKey) => string
  item: GeneratedQAItem
  onClose: () => void
}) {
  const { t, item, onClose } = props
  const trace = item.trace ?? []

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content edgTraceModal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{t('edgTraceModalTitle')}</h2>
          <button type="button" className="btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* Query summary */}
          <div className="edgTraceModal__summary">
            <div className="edgTraceModal__queryLabel">{t('edgColQuery')}</div>
            <div className="edgTraceModal__queryText">{item.query}</div>
            {item.rejected && (
              <span className="edgTraceModal__rejected">
                {t('edgTraceRejected')}
                {item.rejection_reason ? ` (${formatTraceReason(t, item.rejection_reason)})` : ''}
              </span>
            )}
          </div>

          {/* Vertical pipeline */}
          <div className="edgTracePipeline">
            {trace.map((evt, i) => (
              <TraceStepCard key={i} t={t} evt={evt} isLast={i === trace.length - 1} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function formatTraceReason(t: (key: TranslationKey) => string, reason?: string): string {
  if (!reason) return ''
  const key = TRACE_REASON_KEYS[reason]
  if (key) return t(key)

  const negativesMined = reason.match(/^(\d+) negatives mined$/)
  if (negativesMined) return t('edgTraceReasonNegativesMined').replace('{count}', negativesMined[1])

  const grades = reason.match(/^(\d+) grades$/)
  if (grades) return t('edgTraceReasonGrades').replace('{count}', grades[1])

  return reason
}

function TraceStepCard(props: { t: (key: TranslationKey) => string; evt: TraceEvent; isLast: boolean }) {
  const { t, evt, isLast } = props
  const phaseLabelKey = PHASE_LABELS[evt.phase]
  const phaseLabel = phaseLabelKey ? t(phaseLabelKey as TranslationKey) : evt.phase
  const phaseDescKey = PHASE_DESC[evt.phase]
  const actionLabelKey = ACTION_LABELS[evt.action]
  const icon = ACTION_ICONS[evt.action] ?? '⚪'

  return (
    <div className="edgTraceNode">
      {/* Connector line */}
      <div className="edgTraceNode__rail">
        <div className={`edgTraceNode__dot edgTraceNode__dot--${evt.action}`}>{icon}</div>
        {!isLast && <div className="edgTraceNode__line" />}
      </div>

      {/* Card */}
      <div className={`edgTraceNode__card edgTraceNode__card--${evt.action}`}>
        <div className="edgTraceNode__header">
          <span className="edgTraceNode__phase">{phaseLabel}</span>
          <span className={`edgTraceNode__action edgTraceNode__action--${evt.action}`}>
            {actionLabelKey ? t(actionLabelKey) : evt.action}
          </span>
        </div>
        {phaseDescKey && (
          <div className="edgTraceNode__desc">{t(phaseDescKey)}</div>
        )}

        {/* Before → After diff */}
        {evt.detail?.before && evt.detail?.after && (
          <div className="edgTraceNode__diff">
            <div className="edgTraceNode__diffRow edgTraceNode__diffRow--del">
              <span className="edgTraceNode__diffLabel">{t('edgTraceBefore')}</span>
              <span>{evt.detail.before}</span>
            </div>
            <div className="edgTraceNode__diffArrow">↓</div>
            <div className="edgTraceNode__diffRow edgTraceNode__diffRow--ins">
              <span className="edgTraceNode__diffLabel">{t('edgTraceAfter')}</span>
              <span>{evt.detail.after}</span>
            </div>
          </div>
        )}

        {/* Reason */}
        {evt.detail?.reason && !evt.detail?.before && (
          <div className="edgTraceNode__reason">{formatTraceReason(t, evt.detail.reason)}</div>
        )}

        {/* Score */}
        {typeof evt.detail?.score === 'number' && (
          <div className="edgTraceNode__meta">{t('edgTraceScore')}: {evt.detail.score}</div>
        )}

        {/* Style kind badge */}
        {evt.detail?.styleKind && (
          <span className="edgTraceNode__badge">
            {STYLE_KIND_LABELS[evt.detail.styleKind]
              ? t(STYLE_KIND_LABELS[evt.detail.styleKind])
              : evt.detail.styleKind}
          </span>
        )}
      </div>
    </div>
  )
}
