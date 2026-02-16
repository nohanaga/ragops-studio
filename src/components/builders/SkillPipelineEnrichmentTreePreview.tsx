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
  return raw.filter((x): x is Record<string, unknown> => isRecord(x))
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
function ExpandableValue(props: { value: unknown }) {
  const [open, setOpen] = useState(false)
  const full = stringifyFull(props.value)
  const truncatable = full.length > TRUNCATE_LEN
  const toggle = useCallback(() => setOpen((v) => !v), [])

  if (!truncatable) return <>{full}</>

  return (
    <>
      <span>{open ? full : `${full.slice(0, TRUNCATE_LEN)}…`}</span>
      <button type="button" className="xt__expandBtn" onClick={toggle} title={open ? 'Collapse' : 'Expand'}>
        <i className={open ? 'bi bi-chevron-up' : 'bi bi-chevron-down'} />
        {open ? ' Collapse' : ' Expand'}
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

  const model = useMemo(() => buildEnrichmentTreeModel({ nodes, indexer, docRoot: '/document' }), [nodes, indexer])

  const [selectedPath, setSelectedPath] = useState<string>('/document')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/document']))

  useEffect(() => {
    // Ensure selection always exists under /document.
    if (!selectedPath || !selectedPath.startsWith('/document')) setSelectedPath('/document')
    // Seed expansion on first render.
    setExpanded((prev) => (prev.size ? prev : new Set(['/document'])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model.root.path])

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
  }, [fetchedDocRows, indexerUsageUnderSelection, selectedPath])

  /* ── Column definitions ── */
  const summaryCols: XTableCol[] = useMemo(() => [
    { key: 'prop', label: 'Property', width: '40%' },
    { key: 'val', label: 'Value' },
  ], [])

  const producedCols: XTableCol[] = useMemo(() => [
    { key: 'path', label: 'Path', width: '45%' },
    { key: 'skill', label: 'Skill' },
  ], [])

  const referencedCols: XTableCol[] = useMemo(() => [
    { key: 'source', label: 'Source', width: '45%' },
    { key: 'skill', label: 'Skill' },
  ], [])

  const indexerCols: XTableCol[] = useMemo(() => [
    { key: 'source', label: 'Source Field', width: '50%' },
    { key: 'target', label: 'Target Field' },
  ], [])

  const fetchedCols: XTableCol[] = useMemo(() => [
    { key: 'source', label: 'Source Field', width: '40%' },
    { key: 'value', label: 'Value' },
  ], [])

  /* ── Row data ── */
  const summaryTableRows = useMemo<XTableRow[]>(
    () => [
      { id: 'path', cells: { prop: { text: 'path' }, val: { text: <span className="mono">{selectedPath}</span> } } },
      { id: 'produced', cells: { prop: { text: 'produced outputs' }, val: { text: String(producedUnderSelection.length) } } },
      { id: 'referenced', cells: { prop: { text: 'referenced inputs' }, val: { text: String(referencedUnderSelection.length) } } },
      { id: 'indexer', cells: { prop: { text: 'indexer outputFieldMappings' }, val: { text: String(indexerUsageUnderSelection.length) } } },
    ],
    [selectedPath, producedUnderSelection.length, referencedUnderSelection.length, indexerUsageUnderSelection.length],
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
            sub: p.targetName ? `targetName: ${p.targetName}` : p.outputName ? `name: ${p.outputName}` : undefined,
          },
        },
      })),
    [producedUnderSelection],
  )

  const referencedTableRows = useMemo<XTableRow[]>(
    () =>
      referencedUnderSelection.map((r, i) => ({
        id: `${r.source}|${i}`,
        cells: {
          source: { text: <span className="mono">{r.source}</span> },
          skill: {
            text: <span className="mono" title={r.skillId}>{r.skillName}</span>,
            sub: r.inputName ? `input: ${r.inputName}` : undefined,
          },
        },
      })),
    [referencedUnderSelection],
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

  const fetchedTableRows = useMemo<XTableRow[]>(
    () =>
      fetchedValuesUnderSelection.map((item, i) => ({
        id: `${item.sourceFieldName}|${item.targetFieldName}|${item.docNumber}|${i}`,
        cells: {
          source: {
            text: <span className="mono">{item.sourceFieldName}</span>,
            sub: `doc #${item.docNumber}`,
          },
          value: { text: <ExpandableValue value={item.value} /> },
        },
      })),
    [fetchedValuesUnderSelection],
  )

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
            aria-label={hasChildren ? (isExpanded ? 'collapse' : 'expand') : 'leaf'}
            title={hasChildren ? (isExpanded ? 'collapse' : 'expand') : ''}
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
            <span title="produced by a skill output" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
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

        <XTable cols={summaryCols} rows={summaryTableRows} emptyText="(none)" />

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbEnrichmentTreeProducedBy')}
        </div>
        <XTable cols={producedCols} rows={producedTableRows} emptyText="(none)" />

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbEnrichmentTreeReferencedBy')}
        </div>
        <XTable cols={referencedCols} rows={referencedTableRows} emptyText="(none)" />

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbEnrichmentTreeIndexerUsage')}
        </div>
        {!indexer ? <div className="xt__empty">(no indexer loaded)</div> : <XTable cols={indexerCols} rows={indexerTableRows} emptyText="(none)" />}

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbEnrichmentTreeFetchedValues')}
        </div>
        {fetchedDocRows.length === 0 ? (
          <div className="xt__empty">{t('spbEnrichmentTreeNoFetchedDocs')}</div>
        ) : (
          <XTable cols={fetchedCols} rows={fetchedTableRows} emptyText={t('spbEnrichmentTreeNoFetchedValues')} />
        )}
      </div>
    </div>
  )
}
