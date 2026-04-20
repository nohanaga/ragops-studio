/**
 * Resizable-column results table for the Eval Dataset Generator.
 *
 * Built natively (no extra dependency) around a `<colgroup>` whose `<col>` widths
 * are driven from React state. Each header cell carries a drag handle that
 * mutates the stored width on pointermove. Keeps wrap-text cells for content /
 * query previews so the user can actually read the ground truth excerpt.
 */

import { useCallback, useMemo, useRef, useState } from 'react'

import type { translations } from '../../lib/translations'
import type { GeneratedQAItem } from '../../types'

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
}

type ColDef = {
  key: string
  title: string
  width: number
  mono?: boolean
  wrap?: boolean
  render: (it: GeneratedQAItem, idx: number) => React.ReactNode
}

const MIN_COL_WIDTH = 60
const MAX_COL_WIDTH = 1000

/** Best-effort content preview for the first expected_id (or source_doc_id). */
function previewFor(it: GeneratedQAItem, docTextById: Record<string, string>): string {
  const id = it.source_doc_id || it.expected_ids[0] || ''
  const text = id ? docTextById[id] : ''
  if (!text) return ''
  // Collapse whitespace to keep the cell readable when wrapped.
  return text.replace(/\s+/g, ' ').trim()
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
        width: 200,
        mono: true,
        render: (it) => it.expected_ids.join(', '),
      },
      {
        key: 'content_preview',
        title: String(t('edgColContentPreview')),
        width: 360,
        wrap: true,
        render: (it) => previewFor(it, docTextById),
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
  }, [t, docTextById, enableRagasMode, enableDifficultyEvolution, enableHardNegativeMining])

  // Store per-column widths so columns can be resized.
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const out: Record<string, number> = {}
    for (const c of columns) out[c.key] = c.width
    return out
  })

  // Keep `widths` in sync when columns change visibility (Ragas/Difficulty toggles).
  // We only add new keys to avoid clobbering the user's chosen widths.
  if (columns.some((c) => widths[c.key] === undefined)) {
    const next = { ...widths }
    for (const c of columns) if (next[c.key] === undefined) next[c.key] = c.width
    setWidths(next)
  }

  const dragState = useRef<{
    key: string
    startX: number
    startWidth: number
  } | null>(null)
  const [activeResizer, setActiveResizer] = useState<string | null>(null)

  const onResizerPointerDown = useCallback(
    (key: string) => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragState.current = {
        key,
        startX: e.clientX,
        startWidth: widths[key] ?? MIN_COL_WIDTH,
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
    [widths],
  )

  const rows = items.filter((it) => showRejected || !it.rejected)

  return (
    <div className="edgResults__tableWrap">
      <table className="spvTable edgResults__table">
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={{ width: `${widths[c.key] ?? c.width}px` }} />
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
                const titleStr = typeof content === 'string' ? content : undefined
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
    </div>
  )
}
