/**
 * Skill Pipeline Builder - Enrichment Tree Preview.
 */

import { useEffect, useMemo, useState, useCallback, type ReactNode } from 'react'

import type { TranslationKey } from '../../lib/translations'
import type { SkillPipelineIndexerDefinition, SkillPipelineNode } from '../../contexts'
import type { JsonValue } from '../../lib/aiSearchRest'
import { buildEnrichmentTreeModel, type EnrichmentTreeNode } from '../../utils/enrichmentTree'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function getFetchedDocsRows(input: JsonValue | null | undefined): Record<string, unknown>[] {
  if (!input || !isRecord(input)) return []
  const raw = input['value']
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).filter((x): x is Record<string, unknown> => isRecord(x))
}

const TRUNCATE_LEN = 240

function stringifyFull(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    const asJson = JSON.stringify(value, null, 2)
    if (typeof asJson === 'string') return asJson
  } catch {
    // ignore
  }
  return String(value)
}

/** Renders a value that can be expanded when truncated. */
function ExpandableValue(props: { value: unknown; collapseLabel?: string; expandLabel?: string }) {
  const [open, setOpen] = useState(false)
  const full = stringifyFull(props.value)
  const truncatable = full.length > TRUNCATE_LEN
  const toggle = useCallback(() => setOpen((v) => !v), [])

  if (!truncatable) return <>{full}</>

  return (
    <>
      <span>{open ? full : `${full.slice(0, TRUNCATE_LEN)}…`}</span>
      <button type="button" className="xt__expandBtn" onClick={toggle} title={open ? (props.collapseLabel ?? 'Collapse') : (props.expandLabel ?? 'Expand')}>
        <i className={open ? 'bi bi-chevron-up' : 'bi bi-chevron-down'} />
        {open ? ` ${props.collapseLabel ?? 'Collapse'}` : ` ${props.expandLabel ?? 'Expand'}`}
      </button>
    </>
  )
}

type XTableCol = {
  key: string
  label: string
  /** CSS width hint, e.g. '45%' */
  width?: string
}

type XTableRow = {
  /** Unique key for React */
  id: string
  cells: Record<string, { text: ReactNode; sub?: ReactNode }>
}

function XTable(props: { cols: XTableCol[]; rows: XTableRow[]; emptyText: string }) {
  const { cols, rows, emptyText } = props
  if (rows.length === 0) return <div className="xt__empty">{emptyText}</div>
  return (
    <div className="xt__wrap">
      <table className="xt">
        <colgroup>
          {cols.map((c) => (
            <col key={c.key} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {cols.map((c) => {
                const cell = row.cells[c.key]
                return (
                  <td key={c.key} tabIndex={0}>
                    {cell?.text ?? ''}
                    {cell?.sub ? <span className="xt__sub">{cell.sub}</span> : null}
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

export function SkillPipelineEnrichmentTreePreview(props: {
  t: (key: TranslationKey) => string
  nodes: SkillPipelineNode[]
  indexer: SkillPipelineIndexerDefinition | null
  fetchedDocs?: JsonValue | null
}) {
  const { t, nodes, indexer, fetchedDocs } = props

  const format = (key: TranslationKey, params: Record<string, string | number>): string => {
    let text: string = String(t(key) ?? '')
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
    return text
  }

  const model = useMemo(() => buildEnrichmentTreeModel({ nodes, indexer, docRoot: '/document' }), [nodes, indexer])

  const [selectedPath, setSelectedPath] = useState<string>('/document')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/document']))

  // Pagination for Fetched Values table.
  const FETCHED_PAGE_SIZE = 20
  const [fetchedPage, setFetchedPage] = useState(1)

  useEffect(() => {
    // Ensure selection always exists under /document.
    if (!selectedPath || !selectedPath.startsWith('/document')) setSelectedPath('/document')
    // Seed expansion on first render.
    setExpanded((prev) => (prev.size ? prev : new Set(['/document'])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.root.path])

  // Reset fetched-values page when the selected path changes.
  useEffect(() => {
    setFetchedPage(1)
  }, [selectedPath])

  const producedUnderSelection = useMemo(() => {
    const p = selectedPath
    return model.produced.filter((x) => x.path === p || x.path.startsWith(`${p}/`))
  }, [model.produced, selectedPath])

  const referencedUnderSelection = useMemo(() => {
    const p = selectedPath
    return model.references.filter((x) => x.source === p || x.source.startsWith(`${p}/`) || x.source.startsWith(`${p}/*`))
  }, [model.references, selectedPath])

  const indexerUsageUnderSelection = useMemo(() => {
    const p = selectedPath
    return model.indexerUsages.filter(
      (x) => x.sourceFieldName === p || x.sourceFieldName.startsWith(`${p}/`) || x.sourceFieldName.startsWith(`${p}/*`),
    )
  }, [model.indexerUsages, selectedPath])

  const fetchedDocRows = useMemo(() => getFetchedDocsRows(fetchedDocs), [fetchedDocs])

  /** Extract _ragops_field_mappings from the fetched docs payload (if present).
   *  This maps enrichment-tree source paths → field names in the synthetic doc. */
  const ragopsFieldMappings = useMemo(() => {
    const map = new Map<string, string>()
    if (!fetchedDocs || !isRecord(fetchedDocs)) return map
    const raw = (fetchedDocs as Record<string, unknown>)['_ragops_field_mappings']
    if (!raw || !isRecord(raw)) return map
    for (const [path, fieldName] of Object.entries(raw)) {
      if (typeof fieldName === 'string' && fieldName.trim()) map.set(path, fieldName)
    }
    return map
  }, [fetchedDocs])

  const fetchedValuesUnderSelection = useMemo(() => {
    if (fetchedDocRows.length === 0) return [] as Array<{
      sourceFieldName: string
      targetFieldName: string
      docNumber: number
      value: unknown
    }>

    const out: Array<{ sourceFieldName: string; targetFieldName: string; docNumber: number; value: unknown }> = []
    const seen = new Set<string>()

    const pushUnique = (item: { sourceFieldName: string; targetFieldName: string; docNumber: number; value: unknown }) => {
      const key = `${item.sourceFieldName}|${item.targetFieldName}|${item.docNumber}`
      if (seen.has(key)) return
      seen.add(key)
      out.push(item)
    }

    const matchesSelection = (sourcePath: string): boolean => {
      return sourcePath === selectedPath ||
        sourcePath.startsWith(`${selectedPath}/`) ||
        sourcePath.startsWith(`${selectedPath}/*`)
    }

    for (const m of indexerUsageUnderSelection) {
      const target = String(m.targetFieldName || '').trim()
      if (!target) continue
      for (let i = 0; i < fetchedDocRows.length; i++) {
        const row = fetchedDocRows[i]
        if (!(target in row)) continue
        pushUnique({
          sourceFieldName: m.sourceFieldName,
          targetFieldName: target,
          docNumber: i + 1,
          value: row[target],
        })
      }
    }

    // Use _ragops_field_mappings as a fallback to find values by enrichment-tree
    // path.  This is essential when the debug runner's auto-generated field names
    // differ from the user's indexer outputFieldMappings.
    for (const [sourcePath, fieldName] of ragopsFieldMappings) {
      if (!matchesSelection(sourcePath)) continue
      for (let i = 0; i < fetchedDocRows.length; i++) {
        const row = fetchedDocRows[i]
        if (!(fieldName in row)) continue
        pushUnique({
          sourceFieldName: sourcePath,
          targetFieldName: fieldName,
          docNumber: i + 1,
          value: row[fieldName],
        })
      }
    }

    // Fallback: show the retrieved index `content` field as values under /document/content.
    // This helps debugging even when content is not explicitly mapped via outputFieldMappings.
    const includeContent =
      selectedPath === '/document' ||
      selectedPath === '/document/content' ||
      selectedPath.startsWith('/document/content/')

    if (includeContent) {
      for (let i = 0; i < fetchedDocRows.length; i++) {
        const row = fetchedDocRows[i]
        if (!('content' in row)) continue
        pushUnique({
          sourceFieldName: '/document/content',
          targetFieldName: 'content',
          docNumber: i + 1,
          value: row['content'],
        })
      }
    }

    return out
  }, [fetchedDocRows, indexerUsageUnderSelection, ragopsFieldMappings, selectedPath])

  /* ── Column definitions ── */
  const summaryCols: XTableCol[] = useMemo(() => [
    { key: 'prop', label: t('spbEtColProperty'), width: '40%' },
    { key: 'val', label: t('spbEtColValue') },
  ], [t])

  const producedCols: XTableCol[] = useMemo(() => [
    { key: 'path', label: t('spbEtColPath'), width: '45%' },
    { key: 'skill', label: t('spbEtColSkill') },
  ], [t])

  const referencedCols: XTableCol[] = useMemo(() => [
    { key: 'source', label: t('spbEtColSource'), width: '45%' },
    { key: 'skill', label: t('spbEtColSkill') },
  ], [t])

  const indexerCols: XTableCol[] = useMemo(() => [
    { key: 'source', label: t('spbEtColSourceField'), width: '50%' },
    { key: 'target', label: t('spbEtColTargetField') },
  ], [t])

  const fetchedCols: XTableCol[] = useMemo(() => [
    { key: 'source', label: t('spbEtColSourceField'), width: '40%' },
    { key: 'value', label: t('spbEtColValue') },
  ], [t])

  /* ── Row data ── */
  const summaryTableRows = useMemo<XTableRow[]>(
    () => [
      { id: 'path', cells: { prop: { text: t('spbEtSummaryPath') }, val: { text: <span className="mono">{selectedPath}</span> } } },
      { id: 'produced', cells: { prop: { text: t('spbEtSummaryProducedOutputs') }, val: { text: String(producedUnderSelection.length) } } },
      { id: 'referenced', cells: { prop: { text: t('spbEtSummaryReferencedInputs') }, val: { text: String(referencedUnderSelection.length) } } },
      { id: 'indexer', cells: { prop: { text: t('spbEtSummaryIndexerOutputFieldMappings') }, val: { text: String(indexerUsageUnderSelection.length) } } },
    ],
    [t, selectedPath, producedUnderSelection.length, referencedUnderSelection.length, indexerUsageUnderSelection.length],
  )

  const producedTableRows = useMemo<XTableRow[]>(
    () =>
      producedUnderSelection.map((p, i) => ({
        id: `${p.path}|${i}`,
        cells: {
          path: {
            text: <span className="mono">{p.path}</span>,
            sub: p.odataType || undefined,
          },
          skill: {
            text: <span className="mono" title={p.skillId}>{p.skillName}</span>,
            sub: p.targetName ? format('spbEtSubTargetName', { name: p.targetName }) : p.outputName ? format('spbEtSubOutputName', { name: p.outputName }) : undefined,
          },
        },
      })),
    [producedUnderSelection, t],
  )

  const referencedTableRows = useMemo<XTableRow[]>(
    () =>
      referencedUnderSelection.map((r, i) => ({
        id: `${r.source}|${i}`,
        cells: {
          source: { text: <span className="mono">{r.source}</span> },
          skill: {
            text: <span className="mono" title={r.skillId}>{r.skillName}</span>,
            sub: r.inputName ? format('spbEtSubInputName', { name: r.inputName }) : undefined,
          },
        },
      })),
    [referencedUnderSelection, t],
  )

  const indexerTableRows = useMemo<XTableRow[]>(
    () =>
      indexerUsageUnderSelection.map((m, i) => ({
        id: `${m.sourceFieldName}|${i}`,
        cells: {
          source: { text: <span className="mono">{m.sourceFieldName}</span> },
          target: { text: <span className="mono">{m.targetFieldName}</span> },
        },
      })),
    [indexerUsageUnderSelection],
  )

  const fetchedTableRows = useMemo<XTableRow[]>(() => {
    const rows: XTableRow[] = []

    /** Recursively flatten nested arrays/objects into individual display rows. */
    const addValueRows = (
      item: { sourceFieldName: string; targetFieldName: string; docNumber: number },
      value: unknown,
      indexPath: string,
    ) => {
      const idBase = `${item.sourceFieldName}|${item.targetFieldName}|${item.docNumber}`

      if (Array.isArray(value)) {
        if (value.length === 0) {
          rows.push({
            id: `${idBase}|${indexPath}|empty`,
            cells: {
              source: {
                text: <span className="mono">{item.sourceFieldName}</span>,
                sub: `doc #${item.docNumber}${indexPath ? ` ${indexPath}` : ''}`,
              },
              value: { text: <span className="text-muted">{t('spbEtEmptyArray')}</span> },
            },
          })
          return
        }
        for (let j = 0; j < value.length; j++) {
          const childPath = indexPath ? `${indexPath}[${j}]` : `[${j}]`
          const child = value[j]
          // If the child is an array or an object with nested arrays, recurse.
          if (Array.isArray(child) || (isRecord(child) && Object.values(child).some((v) => Array.isArray(v)))) {
            addValueRows(item, child, childPath)
          } else {
            rows.push({
              id: `${idBase}|${childPath}`,
              cells: {
                source: {
                  text: <span className="mono">{item.sourceFieldName}</span>,
                  sub: `doc #${item.docNumber} ${childPath}`,
                },
                value: { text: <ExpandableValue value={child} collapseLabel={t('spbEtCollapse')} expandLabel={t('spbEtExpand')} /> },
              },
            })
          }
        }
        return
      }

      if (isRecord(value)) {
        // Object with potential sub-array properties → expand each property.
        const entries = Object.entries(value)
        for (const [key, subValue] of entries) {
          const subPath = indexPath ? `${indexPath}.${key}` : `.${key}`
          if (Array.isArray(subValue)) {
            addValueRows(item, subValue, subPath)
          } else {
            rows.push({
              id: `${idBase}|${subPath}`,
              cells: {
                source: {
                  text: <span className="mono">{item.sourceFieldName}</span>,
                  sub: `doc #${item.docNumber} ${subPath}`,
                },
                value: { text: <ExpandableValue value={subValue} collapseLabel={t('spbEtCollapse')} expandLabel={t('spbEtExpand')} /> },
              },
            })
          }
        }
        return
      }

      // Scalar value
      rows.push({
        id: `${idBase}|${indexPath || 'scalar'}`,
        cells: {
          source: {
            text: <span className="mono">{item.sourceFieldName}</span>,
            sub: indexPath ? `doc #${item.docNumber} ${indexPath}` : `doc #${item.docNumber}`,
          },
          value: { text: <ExpandableValue value={value} collapseLabel={t('spbEtCollapse')} expandLabel={t('spbEtExpand')} /> },
        },
      })
    }

    for (let i = 0; i < fetchedValuesUnderSelection.length; i++) {
      const item = fetchedValuesUnderSelection[i]
      addValueRows(item, item.value, '')
    }
    return rows
  }, [fetchedValuesUnderSelection, t])

  const fetchedTotalPages = Math.max(1, Math.ceil(fetchedTableRows.length / FETCHED_PAGE_SIZE))
  const fetchedPagedRows = useMemo(() => {
    const start = (fetchedPage - 1) * FETCHED_PAGE_SIZE
    return fetchedTableRows.slice(start, start + FETCHED_PAGE_SIZE)
  }, [fetchedTableRows, fetchedPage, FETCHED_PAGE_SIZE])

  const toggleExpand = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const renderNode = (n: EnrichmentTreeNode, depth: number) => {
    const isExpanded = expanded.has(n.path)
    const hasChildren = n.children.length > 0
    const isSelected = selectedPath === n.path
    const isProduced = model.producedPathSet.has(n.path)

    return (
      <div key={n.path} style={{ paddingLeft: depth * 14 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '4px 6px',
            borderRadius: 6,
            background: isSelected ? 'color-mix(in srgb, var(--accent) 12%, var(--panel))' : 'transparent',
          }}
        >
          <button
            type="button"
            className="btn btn--icon"
            aria-label={hasChildren ? (isExpanded ? t('spbEtCollapse') : t('spbEtExpand')) : t('spbEtLeaf')}
            title={hasChildren ? (isExpanded ? t('spbEtCollapse') : t('spbEtExpand')) : ''}
            onClick={() => (hasChildren ? toggleExpand(n.path) : null)}
            style={{
              width: 22,
              height: 22,
              opacity: hasChildren ? 1 : 0.35,
              pointerEvents: hasChildren ? 'auto' : 'none',
            }}
          >
            <i className={hasChildren ? (isExpanded ? 'bi bi-chevron-down' : 'bi bi-chevron-right') : 'bi bi-dot'} />
          </button>

          <button
            type="button"
            className="btn btn--tab"
            onClick={() => setSelectedPath(n.path)}
            title={n.path}
            style={{
              flex: 1,
              textAlign: 'left',
              padding: '4px 8px',
              background: 'transparent',
            }}
          >
            <span className="mono mono--ellipsesSm">{n.segment}</span>
          </button>

          {isProduced ? (
            <span title={t('spbEtProducedBySkill')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <i className="bi bi-stars" style={{ color: 'var(--accent)' }} />
            </span>
          ) : null}
        </div>

        {hasChildren && isExpanded ? n.children.map((c) => renderNode(c, depth + 1)) : null}
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', gap: 10 }}>
      <div
        style={{
          width: '42%',
          minWidth: 320,
          height: '100%',
          overflow: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--panel-2)',
          padding: 10,
        }}
      >
        <div className="section__title" style={{ marginTop: 0 }}>
          {t('spbEnrichmentTreeTitle')}
        </div>
        <div className="section__hint" style={{ marginBottom: 8 }}>
          {t('spbEnrichmentTreeHint')}
        </div>

        {renderNode(model.root, 0)}
      </div>

      <div
        style={{
          flex: 1,
          height: '100%',
          overflow: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--panel-2)',
          padding: 10,
        }}
      >
        <div className="section__title" style={{ marginTop: 0 }}>
          {t('spbEnrichmentTreeDetails')}
        </div>

        <XTable cols={summaryCols} rows={summaryTableRows} emptyText={t('spbNone')} />

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbEnrichmentTreeProducedBy')}
        </div>
        <XTable cols={producedCols} rows={producedTableRows} emptyText={t('spbNone')} />

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbEnrichmentTreeReferencedBy')}
        </div>
        <XTable cols={referencedCols} rows={referencedTableRows} emptyText={t('spbNone')} />

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbEnrichmentTreeIndexerUsage')}
        </div>
        {!indexer ? <div className="xt__empty">{t('spbEtNoIndexerLoaded')}</div> : <XTable cols={indexerCols} rows={indexerTableRows} emptyText={t('spbNone')} />}

        <div className="section__title" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>{t('spbEnrichmentTreeFetchedValues')}</span>
          {fetchedTableRows.length > FETCHED_PAGE_SIZE && (
            <span className="text-muted" style={{ fontSize: '0.85em', fontWeight: 400 }}>
              {format('spbEtRows', { n: fetchedTableRows.length })}
            </span>
          )}
        </div>
        {fetchedDocRows.length === 0 ? (
          <div className="xt__empty">{t('spbEnrichmentTreeNoFetchedDocs')}</div>
        ) : (
          <>
            <XTable cols={fetchedCols} rows={fetchedPagedRows} emptyText={t('spbEnrichmentTreeNoFetchedValues')} />
            {fetchedTotalPages > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={fetchedPage <= 1}
                  onClick={() => setFetchedPage((p) => Math.max(1, p - 1))}
                  title={t('spbEtPreviousPage')}
                >
                  <i className="bi bi-chevron-left" />
                </button>
                <span style={{ fontSize: '0.85em' }}>
                  {fetchedPage} / {fetchedTotalPages}
                </span>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={fetchedPage >= fetchedTotalPages}
                  onClick={() => setFetchedPage((p) => Math.min(fetchedTotalPages, p + 1))}
                  title={t('spbEtNextPage')}
                >
                  <i className="bi bi-chevron-right" />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
