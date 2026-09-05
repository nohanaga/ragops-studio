import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Language } from '../../lib/translations'
import type { JsonValue } from '../../lib/aiSearchRest'
import type { AppSettings } from '../../lib/model'
import type { ResultView } from '../../types'
import { isJsonObject } from '../../app/json'
import { downloadText, extractAgenticResponse, extractDocs, isTableComparableRunType, pickFirstStringField, pickPrimaryText } from '../../utils'
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
  score?: number
  rerankerScore?: number
  rerankerBoostedScore?: number
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
    title: '検索結果の表比較',
    agenticTitle: 'Agentic Retrieval 表比較',
    description: '実行ごとの検索結果を同じ順位で横に揃え、文書の順位変化を比較します。スコア尺度は検索モードごとに異なります。',
    agenticDescription: '実行ごとの Grounding Data を同じ順位で横に揃えて比較します。',
    cardView: 'カード表示に戻る',
    csvExport: 'CSV 出力',
    rank: '順位',
    resultCount: '{count} 件',
    noResult: '該当なし',
    untitled: 'タイトルなし',
    refId: '文書 ID / 参照 ID',
    latency: 'レイテンシー',
    score: 'スコア',
    rerankerScore: 'リランカースコア',
    boostedScore: 'ブースト後スコア',
    details: '選択した結果',
    closeDetails: '詳細を閉じる',
    content: '本文',
    terms: 'Terms',
    raw: 'RAW RESULT',
    resizeColumn: '列幅を変更',
    baseline: '基準',
    matchSummary: '文書の対応順位',
    clearMatch: '対応表示を解除',
    sameRank: '同順位',
    outOfRange: '圏外',
    empty: '比較できる検索結果が 2 件以上ありません。',
  },
  en: {
    title: 'Search result table comparison',
    agenticTitle: 'Agentic Retrieval table comparison',
    description: 'Align ranked results from each run and compare document movement. Score scales differ between search modes.',
    agenticDescription: 'Compare Grounding Data from each run at the same rank.',
    cardView: 'Back to card view',
    csvExport: 'Export CSV',
    rank: 'Rank',
    resultCount: '{count} results',
    noResult: 'No result',
    untitled: 'Untitled',
    refId: 'Document / reference ID',
    latency: 'Latency',
    score: 'Score',
    rerankerScore: 'Reranker score',
    boostedScore: 'Boosted score',
    details: 'Selected result',
    closeDetails: 'Close details',
    content: 'Content',
    terms: 'Terms',
    raw: 'RAW RESULT',
    resizeColumn: 'Resize column',
    baseline: 'Baseline',
    matchSummary: 'Matching document ranks',
    clearMatch: 'Clear document matches',
    sameRank: 'Same rank',
    outOfRange: 'Not ranked',
    empty: 'Select at least two comparable search results.',
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

function extractAgenticComparisonItems(body: JsonValue): ComparisonItem[] {
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

function extractSearchComparisonItems(
  body: JsonValue,
  displayTitleFields?: string,
  displayTextFields?: string,
): ComparisonItem[] {
  return extractDocs(body).map((doc, index) => {
    const stableIds = collectStableIds(doc)
    const urls = Object.entries(doc)
      .filter(([fieldName, fieldValue]) => /url|uri/i.test(fieldName) && typeof fieldValue === 'string' && fieldValue.trim())
      .map(([, fieldValue]) => normalizeCitationUrl(String(fieldValue)))
    const content = pickFirstStringField(doc, displayTextFields) ?? ''
    const normalizedContent = normalizeFingerprintValue(content)

    return {
      rank: index + 1,
      refId: stableIds[0] ?? String(index + 1),
      title: pickPrimaryText(doc, displayTitleFields),
      content,
      terms: '',
      stableIds,
      urls,
      fingerprint: normalizedContent.length >= 20 ? normalizedContent : '',
      score: typeof doc['@search.score'] === 'number' ? doc['@search.score'] : undefined,
      rerankerScore: typeof doc['@search.rerankerScore'] === 'number' ? doc['@search.rerankerScore'] : undefined,
      rerankerBoostedScore: typeof doc['@search.rerankerBoostedScore'] === 'number' ? doc['@search.rerankerBoostedScore'] : undefined,
      raw: doc,
    }
  })
}

function extractComparisonItems(view: ResultView, settings: AppSettings | null): ComparisonItem[] {
  if (!view.response) return []
  if (view.runType === 'agentic_retrieve') return extractAgenticComparisonItems(view.response.body)
  return extractSearchComparisonItems(
    view.response.body,
    settings?.displayTitleFields,
    settings?.displayTextFields,
  )
}

function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4)
}

function escapeCsvCell(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function buildComparisonCsv(columns: ComparisonColumn[]): string {
  const header = [
    'runLabel',
    'runType',
    'runId',
    'executedAt',
    'latencyMs',
    'rank',
    'resultId',
    'title',
    'content',
    'terms',
    'searchScore',
    'rerankerScore',
    'rerankerBoostedScore',
    'rawJson',
  ]
  const rows: Array<Array<string | number | undefined>> = [header]

  for (const column of columns) {
    const response = column.view.response
    const items: Array<ComparisonItem | undefined> = column.items.length > 0 ? column.items : [undefined]
    for (const item of items) {
      rows.push([
        column.view.label,
        column.view.runType ?? '',
        column.view.runId ?? '',
        response?.at ?? '',
        response?.latencyMs,
        item?.rank,
        item?.refId ?? '',
        item?.title ?? '',
        item?.content ?? '',
        item?.terms ?? '',
        item?.score,
        item?.rerankerScore,
        item?.rerankerBoostedScore,
        item ? JSON.stringify(item.raw) : '',
      ])
    }
  }

  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')
}

export function SearchComparisonTable({
  views,
  language,
  settings,
  onClose,
  onSelectView,
}: {
  views: ResultView[]
  language: Language
  settings: AppSettings | null
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
    .filter((view) => isTableComparableRunType(view.runType) && view.response)
    .map((view) => ({ view, items: extractComparisonItems(view, settings) })), [settings, views])
  const isAgenticOnly = columns.length > 0 && columns.every((column) => column.view.runType === 'agentic_retrieve')
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

  const exportCsv = useCallback(() => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    downloadText(
      `search-comparison-${timestamp}.csv`,
      `\uFEFF${buildComparisonCsv(columns)}`,
      'text/csv;charset=utf-8',
    )
  }, [columns])

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
    <section className="agenticComparison" aria-labelledby="search-comparison-title">
      <header className="agenticComparison__toolbar">
        <div className="agenticComparison__heading">
          <div className="agenticComparison__titleRow">
            <i className="bi bi-table" aria-hidden="true" />
            <h2 id="search-comparison-title">{isAgenticOnly ? text.agenticTitle : text.title}</h2>
            <span className="agenticComparison__runCount">{columns.length}</span>
          </div>
          <p>{isAgenticOnly ? text.agenticDescription : text.description}</p>
        </div>
        <div className="agenticComparison__toolbarActions">
          <button type="button" className="btn" onClick={exportCsv} disabled={columns.length < 2}>
            <i className="bi bi-download icon--mr6" aria-hidden="true" />
            {text.csvExport}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            <i className="bi bi-grid-3x2-gap icon--mr6" aria-hidden="true" />
            {text.cardView}
          </button>
        </div>
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
                                {typeof item.rerankerBoostedScore === 'number' && (
                                  <span className="agenticComparison__cellMeta">{text.boostedScore}: {formatScore(item.rerankerBoostedScore)}</span>
                                )}
                                {typeof item.rerankerScore === 'number' && (
                                  <span className="agenticComparison__cellMeta">{text.rerankerScore}: {formatScore(item.rerankerScore)}</span>
                                )}
                                {typeof item.score === 'number' && (
                                  <span className="agenticComparison__cellMeta">{text.score}: {formatScore(item.score)}</span>
                                )}
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
                {typeof selected.item.rerankerBoostedScore === 'number' && (
                  <div>
                    <div className="agenticComparison__detailsLabel">{text.boostedScore}</div>
                    <div>{formatScore(selected.item.rerankerBoostedScore)}</div>
                  </div>
                )}
                {typeof selected.item.rerankerScore === 'number' && (
                  <div>
                    <div className="agenticComparison__detailsLabel">{text.rerankerScore}</div>
                    <div>{formatScore(selected.item.rerankerScore)}</div>
                  </div>
                )}
                {typeof selected.item.score === 'number' && (
                  <div>
                    <div className="agenticComparison__detailsLabel">{text.score}</div>
                    <div>{formatScore(selected.item.score)}</div>
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