import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Language } from '../../lib/translations'
import type { JsonValue } from '../../lib/aiSearchRest'
import type { ResultView } from '../../types'
import { isJsonObject } from '../../app/json'
import { extractAgenticResponse } from '../../utils'
import { formatLocalDateTime } from '../../utils/helpers'

type ComparisonItem = {
  rank: number
  refId: string
  title: string
  content: string
  terms: string
  stableIds: string[]
  urls: string[]
  fingerprint: string
  raw: JsonValue
}

type ComparisonColumn = {
  view: ResultView
  items: ComparisonItem[]
}

type SelectedItem = {
  column: ComparisonColumn
  item: ComparisonItem
}

type ColumnMatch = {
  column: ComparisonColumn
  item: ComparisonItem | null
}

const RANK_COLUMN_WIDTH = 64
const MIN_RESULT_COLUMN_WIDTH = 150
const MAX_RESULT_COLUMN_WIDTH = 520
const FALLBACK_RESULT_COLUMN_WIDTH = 220

const copy = {
  ja: {
    title: 'Agentic Retrieval 表比較',
    description: '実行ごとの Grounding Data を同じ順位で横に揃えて比較します。',
    cardView: 'カード表示に戻る',
    rank: '順位',
    resultCount: '{count} 件',
    noResult: '該当なし',
    untitled: 'タイトルなし',
    refId: '参照 ID',
    latency: 'レイテンシー',
    details: '選択した結果',
    closeDetails: '詳細を閉じる',
    content: '本文',
    terms: 'Terms',
    raw: 'RAW CHUNK',
    resizeColumn: '列幅を変更',
    baseline: '基準',
    matchSummary: '文書の対応順位',
    clearMatch: '対応表示を解除',
    sameRank: '同順位',
    outOfRange: '圏外',
    empty: '比較できる Agentic Retrieval の結果が 2 件以上ありません。',
  },
  en: {
    title: 'Agentic Retrieval table comparison',
    description: 'Compare Grounding Data from each run at the same rank.',
    cardView: 'Back to card view',
    rank: 'Rank',
    resultCount: '{count} results',
    noResult: 'No result',
    untitled: 'Untitled',
    refId: 'Reference ID',
    latency: 'Latency',
    details: 'Selected result',
    closeDetails: 'Close details',
    content: 'Content',
    terms: 'Terms',
    raw: 'RAW CHUNK',
    resizeColumn: 'Resize column',
    baseline: 'Baseline',
    matchSummary: 'Matching document ranks',
    clearMatch: 'Clear document matches',
    sameRank: 'Same rank',
    outOfRange: 'Not ranked',
    empty: 'Select at least two Agentic Retrieval results to compare.',
  },
} as const

function truncateLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
}

function getDisplayTitle(item: ComparisonItem, untitled: string): string {
  const title = item.title.trim()
  if (title && title !== '(no title)') return title
  return truncateLine(item.content, 90) || `${untitled} (${item.refId})`
}

function normalizeIdentityValue(value: string): string {
  return value.trim()
}

function normalizeFingerprintValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function normalizeCitationUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin.toLocaleLowerCase()}${decodeURIComponent(url.pathname).replace(/\/$/, '')}`
  } catch {
    return value.trim()
  }
}

function collectStableIds(value: Record<string, JsonValue> | null): string[] {
  if (!value) return []
  const identifiers = new Set<string>()
  for (const [fieldName, fieldValue] of Object.entries(value)) {
    const normalizedFieldName = fieldName.replace(/[^a-z0-9]/gi, '').toLocaleLowerCase()
    const isIdentityField = normalizedFieldName !== 'refid' && (normalizedFieldName === 'key'
      || normalizedFieldName.endsWith('id')
      || normalizedFieldName === 'filename'
      || normalizedFieldName === 'filepath'
      || normalizedFieldName === 'path')
    if (!isIdentityField || (typeof fieldValue !== 'string' && typeof fieldValue !== 'number')) continue
    const normalizedValue = normalizeIdentityValue(String(fieldValue))
    if (normalizedValue) identifiers.add(normalizedValue)
  }
  return [...identifiers]
}

function hasSharedValue(left: string[], right: string[]): boolean {
  if (left.length === 0 || right.length === 0) return false
  const rightValues = new Set(right)
  return left.some((value) => rightValues.has(value))
}

function isSameDocument(left: ComparisonItem, right: ComparisonItem): boolean {
  if (hasSharedValue(left.stableIds, right.stableIds)) return true
  if (hasSharedValue(left.urls, right.urls)) return true
  return left.fingerprint.length > 0 && left.fingerprint === right.fingerprint
}

function getRankDeltaLabel(baselineRank: number, matchedRank: number, sameRank: string): string {
  const delta = matchedRank - baselineRank
  if (delta === 0) return sameRank
  return delta < 0 ? `↑${Math.abs(delta)}` : `↓${delta}`
}

function extractComparisonItems(body: JsonValue): ComparisonItem[] {
  const { extractedChunks, references } = extractAgenticResponse(body)
  if (!extractedChunks) return []

  const referencesById = new Map<string, Record<string, JsonValue>>()
  for (const referenceValue of references ?? []) {
    if (!isJsonObject(referenceValue)) continue
    const referenceId = referenceValue.id
    if (typeof referenceId !== 'string' && typeof referenceId !== 'number') continue
    referencesById.set(String(referenceId), referenceValue)
  }

  return extractedChunks.map((chunk, index) => {
    const value = isJsonObject(chunk) ? chunk : null
    const rawRefId = value?.ref_id
    const hasRefId = typeof rawRefId === 'string' || typeof rawRefId === 'number'
    const refId = hasRefId
      ? String(rawRefId)
      : String(index + 1)
    const reference = hasRefId ? referencesById.get(refId) ?? null : null
    const sourceData = reference && isJsonObject(reference.sourceData) ? reference.sourceData : null
    const docKey = reference?.docKey
    const stableIds = new Set([
      ...collectStableIds(value),
      ...collectStableIds(sourceData),
    ])
    if (typeof docKey === 'string' || typeof docKey === 'number') {
      const normalizedDocKey = normalizeIdentityValue(String(docKey))
      if (normalizedDocKey) stableIds.add(normalizedDocKey)
    }
    const urls = new Set<string>()
    const citationUrl = reference?.citationUrl
    if (typeof citationUrl === 'string' && citationUrl.trim()) urls.add(normalizeCitationUrl(citationUrl))
    for (const source of [value, sourceData]) {
      if (!source) continue
      for (const [fieldName, fieldValue] of Object.entries(source)) {
        if (!/url|uri/i.test(fieldName) || typeof fieldValue !== 'string' || !fieldValue.trim()) continue
        urls.add(normalizeCitationUrl(fieldValue))
      }
    }
    const title = value && typeof value.title === 'string' ? value.title : ''
    const content = value && typeof value.content === 'string' ? value.content : ''
    const normalizedContent = normalizeFingerprintValue(content)
    const fingerprint = normalizedContent.length >= 20
      ? normalizedContent
      : ''

    return {
      rank: index + 1,
      refId,
      title,
      content,
      terms: value && typeof value.terms === 'string' ? value.terms : '',
      stableIds: [...stableIds],
      urls: [...urls],
      fingerprint,
      raw: chunk,
    }
  })
}

export function AgenticComparisonTable({
  views,
  language,
  onClose,
  onSelectView,
}: {
  views: ResultView[]
  language: Language
  onClose: () => void
  onSelectView: (viewId: ResultView['id']) => void
}) {
  const text = copy[language]
  const [selected, setSelected] = useState<SelectedItem | null>(null)
  const [trackedSelection, setTrackedSelection] = useState<SelectedItem | null>(null)
  const [tableWidth, setTableWidth] = useState(0)
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({})
  const [activeResizer, setActiveResizer] = useState<string | null>(null)
  const tableWrapRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<{ columnId: string; startX: number; startWidth: number } | null>(null)
  const columns: ComparisonColumn[] = useMemo(() => views
    .filter((view) => view.runType === 'agentic_retrieve' && view.response)
    .map((view) => ({ view, items: extractComparisonItems(view.response!.body) })), [views])
  const rowCount = Math.max(0, ...columns.map((column) => column.items.length))
  const automaticColumnWidth = columns.length > 0 && tableWidth > RANK_COLUMN_WIDTH
    ? Math.max(
        MIN_RESULT_COLUMN_WIDTH,
        Math.min(MAX_RESULT_COLUMN_WIDTH, Math.floor((tableWidth - RANK_COLUMN_WIDTH) / columns.length)),
      )
    : FALLBACK_RESULT_COLUMN_WIDTH
  const effectiveColumnWidths = useMemo(
    () => Object.fromEntries(columns.map((column) => [
      column.view.id,
      columnWidths[column.view.id] ?? automaticColumnWidth,
    ])),
    [automaticColumnWidth, columnWidths, columns],
  )
  const effectiveTableWidth = RANK_COLUMN_WIDTH + columns.reduce(
    (total, column) => total + effectiveColumnWidths[column.view.id],
    0,
  )
  const columnMatches = useMemo<ColumnMatch[]>(() => {
    if (!trackedSelection) return []
    return columns.map((column) => ({
      column,
      item: column.view.id === trackedSelection.column.view.id
        ? trackedSelection.item
        : column.items.find((item) => isSameDocument(trackedSelection.item, item)) ?? null,
    }))
  }, [columns, trackedSelection])

  useEffect(() => {
    const tableWrap = tableWrapRef.current
    if (!tableWrap) return

    const updateWidth = () => setTableWidth(tableWrap.clientWidth)
    updateWidth()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(updateWidth)
    observer.observe(tableWrap)
    return () => observer.disconnect()
  }, [columns.length])

  const resetColumnWidth = useCallback((columnId: string) => {
    setColumnWidths((current) => {
      const next = { ...current }
      delete next[columnId]
      return next
    })
  }, [])

  const startColumnResize = useCallback((columnId: string) => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragState.current = {
      columnId,
      startX: event.clientX,
      startWidth: effectiveColumnWidths[columnId] ?? automaticColumnWidth,
    }
    setActiveResizer(columnId)

    const target = event.currentTarget
    target.setPointerCapture(event.pointerId)
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      const drag = dragState.current
      if (!drag) return
      const width = Math.max(
        MIN_RESULT_COLUMN_WIDTH,
        Math.min(MAX_RESULT_COLUMN_WIDTH, drag.startWidth + pointerEvent.clientX - drag.startX),
      )
      setColumnWidths((current) => current[drag.columnId] === width
        ? current
        : { ...current, [drag.columnId]: width })
    }
    const stopResize = () => {
      dragState.current = null
      setActiveResizer(null)
      target.removeEventListener('pointermove', handlePointerMove)
      target.removeEventListener('pointerup', stopResize)
      target.removeEventListener('pointercancel', stopResize)
    }
    target.addEventListener('pointermove', handlePointerMove)
    target.addEventListener('pointerup', stopResize)
    target.addEventListener('pointercancel', stopResize)
  }, [automaticColumnWidth, effectiveColumnWidths])

  return (
    <section className="agenticComparison" aria-labelledby="agentic-comparison-title">
      <header className="agenticComparison__toolbar">
        <div className="agenticComparison__heading">
          <div className="agenticComparison__titleRow">
            <i className="bi bi-table" aria-hidden="true" />
            <h2 id="agentic-comparison-title">{text.title}</h2>
            <span className="agenticComparison__runCount">{columns.length}</span>
          </div>
          <p>{text.description}</p>
        </div>
        <button type="button" className="btn" onClick={onClose}>
          <i className="bi bi-grid-3x2-gap icon--mr6" aria-hidden="true" />
          {text.cardView}
        </button>
      </header>

      {columns.length < 2 ? (
        <div className="notice notice--info" role="status">{text.empty}</div>
      ) : (
        <>
          {trackedSelection && (
            <div className="agenticComparison__matchSummary" role="status" aria-live="polite">
              <div className="agenticComparison__matchSummaryHeader">
                <div>
                  <div className="agenticComparison__matchSummaryLabel">{text.matchSummary}</div>
                  <div className="agenticComparison__matchSummaryTitle">{getDisplayTitle(trackedSelection.item, text.untitled)}</div>
                </div>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() => setTrackedSelection(null)}
                  title={text.clearMatch}
                  aria-label={text.clearMatch}
                >
                  <i className="bi bi-x-lg" aria-hidden="true" />
                </button>
              </div>
              <div className="agenticComparison__matchRanks">
                {columnMatches.map(({ column, item }) => (
                  <div
                    key={column.view.id}
                    className={`agenticComparison__matchRank${item ? '' : ' agenticComparison__matchRank--missing'}`}
                  >
                    <span className="agenticComparison__matchRun">{column.view.label}</span>
                    <strong>{item ? `#${item.rank}` : text.outOfRange}</strong>
                    {item && (
                      <span>{column.view.id === trackedSelection.column.view.id
                        ? text.baseline
                        : getRankDeltaLabel(trackedSelection.item.rank, item.rank, text.sameRank)}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div ref={tableWrapRef} className="agenticComparison__tableWrap">
            <table className="agenticComparison__table" style={{ width: effectiveTableWidth }}>
              <colgroup>
                <col style={{ width: RANK_COLUMN_WIDTH }} />
                {columns.map((column) => (
                  <col key={column.view.id} style={{ width: effectiveColumnWidths[column.view.id] }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th scope="col" className="agenticComparison__rankHeader">{text.rank}</th>
                  {columns.map((column) => {
                    const response = column.view.response!
                    return (
                      <th scope="col" key={column.view.id} className="agenticComparison__columnHeader">
                        <div className="agenticComparison__runHeader">
                          <div className="agenticComparison__runTitleRow">
                            <div className="agenticComparison__runTitle">{column.view.label}</div>
                            {trackedSelection?.column.view.id === column.view.id && (
                              <span className="agenticComparison__baselineBadge">{text.baseline}</span>
                            )}
                          </div>
                          <div className="agenticComparison__runMeta">
                            {response.at && <span>{formatLocalDateTime(response.at)}</span>}
                            {typeof response.latencyMs === 'number' && (
                              <span>{text.latency}: {response.latencyMs.toFixed(0)} ms</span>
                            )}
                            <span>{text.resultCount.replace('{count}', String(column.items.length))}</span>
                          </div>
                        </div>
                        <div
                          className={`agenticComparison__resizer${activeResizer === column.view.id ? ' agenticComparison__resizer--active' : ''}`}
                          onPointerDown={startColumnResize(column.view.id)}
                          onDoubleClick={() => resetColumnWidth(column.view.id)}
                          role="separator"
                          aria-orientation="vertical"
                          aria-label={`${text.resizeColumn}: ${column.view.label}`}
                          title={text.resizeColumn}
                        />
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: rowCount }, (_, rowIndex) => (
                  <tr key={rowIndex}>
                    <th scope="row" className="agenticComparison__rank">#{rowIndex + 1}</th>
                    {columns.map((column) => {
                      const item = column.items[rowIndex]
                      const isSelected = selected?.column.view.id === column.view.id && selected.item.rank === item?.rank
                      const isBaselineSource = Boolean(
                        trackedSelection
                        && column.view.id === trackedSelection.column.view.id
                        && item?.rank === trackedSelection.item.rank,
                      )
                      const isDocumentMatch = Boolean(
                        trackedSelection
                        && item
                        && (isBaselineSource || isSameDocument(trackedSelection.item, item)),
                      )
                      const cellClassName = [
                        isSelected ? 'agenticComparison__cell--selected' : '',
                        isBaselineSource ? 'agenticComparison__cell--baseline' : '',
                        isDocumentMatch && !isBaselineSource ? 'agenticComparison__cell--match' : '',
                        trackedSelection && !isDocumentMatch ? 'agenticComparison__cell--unmatched' : '',
                      ].filter(Boolean).join(' ') || undefined
                      return (
                        <td key={column.view.id} className={cellClassName}>
                          {item ? (
                            <button
                              type="button"
                              className="agenticComparison__cellButton"
                              onClick={() => {
                                setSelected({ column, item })
                                setTrackedSelection((current) => (
                                  current?.column.view.id === column.view.id && current.item.rank === item.rank
                                    ? null
                                    : { column, item }
                                ))
                                onSelectView(column.view.id)
                              }}
                              aria-pressed={isSelected}
                            >
                              <span className="agenticComparison__cellTitle">{getDisplayTitle(item, text.untitled)}</span>
                              <span className="agenticComparison__cellFooter">
                                <span className="agenticComparison__cellMeta">{text.refId}: {item.refId}</span>
                                {isDocumentMatch && trackedSelection && (
                                  <span className="agenticComparison__rankDelta">
                                    {isBaselineSource
                                      ? text.baseline
                                      : getRankDeltaLabel(trackedSelection.item.rank, item.rank, text.sameRank)}
                                  </span>
                                )}
                              </span>
                            </button>
                          ) : (
                            <span className="agenticComparison__emptyCell">{text.noResult}</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected && (
            <aside className="agenticComparison__details" aria-labelledby="agentic-comparison-details-title">
              <div className="agenticComparison__detailsHeader">
                <div>
                  <div className="agenticComparison__detailsEyebrow">{selected.column.view.label} · #{selected.item.rank}</div>
                  <h3 id="agentic-comparison-details-title">{getDisplayTitle(selected.item, text.untitled)}</h3>
                </div>
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() => setSelected(null)}
                  title={text.closeDetails}
                  aria-label={text.closeDetails}
                >
                  <i className="bi bi-x-lg" aria-hidden="true" />
                </button>
              </div>
              <div className="agenticComparison__detailsGrid">
                <div>
                  <div className="agenticComparison__detailsLabel">{text.refId}</div>
                  <div className="mono">{selected.item.refId}</div>
                </div>
                {selected.item.terms && (
                  <div>
                    <div className="agenticComparison__detailsLabel">{text.terms}</div>
                    <div>{selected.item.terms}</div>
                  </div>
                )}
                <div className="agenticComparison__detailsContent">
                  <div className="agenticComparison__detailsLabel">{text.content}</div>
                  <div>{selected.item.content || text.noResult}</div>
                </div>
              </div>
              <details className="agenticComparison__raw">
                <summary className="resultCard__summary">{text.raw}</summary>
                <pre className="notice__pre">{JSON.stringify(selected.item.raw, null, 2)}</pre>
              </details>
            </aside>
          )}
        </>
      )}
    </section>
  )
}