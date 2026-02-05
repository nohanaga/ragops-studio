/**
 * Skill Pipeline Builder - Enrichment Tree Preview.
 */

import { useEffect, useMemo, useState } from 'react'

import type { TranslationKey } from '../../lib/translations'
import type { SkillPipelineIndexerDefinition, SkillPipelineNode } from '../../contexts'
import { buildEnrichmentTreeModel, type EnrichmentTreeNode } from '../../utils/enrichmentTree'

export function SkillPipelineEnrichmentTreePreview(props: {
  t: (key: TranslationKey) => string
  nodes: SkillPipelineNode[]
  indexer: SkillPipelineIndexerDefinition | null
}) {
  const { t, nodes, indexer } = props

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
            background: isSelected ? 'var(--panel-3)' : 'transparent',
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

        <div className="kv kv--mb16">
          <div className="kv__row">
            <div className="kv__k">path</div>
            <div className="kv__v mono" style={{ textAlign: 'right' }}>
              {selectedPath}
            </div>
          </div>
          <div className="kv__row">
            <div className="kv__k">produced outputs</div>
            <div className="kv__v" style={{ textAlign: 'right' }}>
              {producedUnderSelection.length}
            </div>
          </div>
          <div className="kv__row">
            <div className="kv__k">referenced inputs</div>
            <div className="kv__v" style={{ textAlign: 'right' }}>
              {referencedUnderSelection.length}
            </div>
          </div>
          <div className="kv__row">
            <div className="kv__k">indexer outputFieldMappings</div>
            <div className="kv__v" style={{ textAlign: 'right' }}>
              {indexerUsageUnderSelection.length}
            </div>
          </div>
        </div>

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbEnrichmentTreeProducedBy')}
        </div>
        {producedUnderSelection.length === 0 ? (
          <div className="empty">(none)</div>
        ) : (
          <div className="kv kv--mb16">
            {producedUnderSelection.map((p, idx) => (
              <div key={`${p.path}|${p.skillId}|${idx}`} className="kv__row" style={{ alignItems: 'flex-start' }}>
                <div className="kv__k" title={p.path}>
                  <div className="mono" style={{ opacity: 0.9 }}>{p.path}</div>
                  <div style={{ opacity: 0.7, fontSize: 12 }}>{p.odataType || ''}</div>
                </div>
                <div className="kv__v" style={{ textAlign: 'right' }}>
                  <div className="mono" title={p.skillId}>{p.skillName}</div>
                  <div style={{ opacity: 0.7, fontSize: 12 }}>
                    {p.targetName ? `targetName: ${p.targetName}` : p.outputName ? `name: ${p.outputName}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbEnrichmentTreeReferencedBy')}
        </div>
        {referencedUnderSelection.length === 0 ? (
          <div className="empty">(none)</div>
        ) : (
          <div className="kv kv--mb16">
            {referencedUnderSelection.map((r, idx) => (
              <div key={`${r.source}|${r.skillId}|${idx}`} className="kv__row" style={{ alignItems: 'flex-start' }}>
                <div className="kv__k" title={r.source}>
                  <div className="mono" style={{ opacity: 0.9 }}>{r.source}</div>
                </div>
                <div className="kv__v" style={{ textAlign: 'right' }}>
                  <div className="mono" title={r.skillId}>{r.skillName}</div>
                  <div style={{ opacity: 0.7, fontSize: 12 }}>{r.inputName ? `input: ${r.inputName}` : ''}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbEnrichmentTreeIndexerUsage')}
        </div>
        {!indexer ? (
          <div className="empty">(no indexer loaded)</div>
        ) : indexerUsageUnderSelection.length === 0 ? (
          <div className="empty">(none)</div>
        ) : (
          <div className="kv kv--mb16">
            {indexerUsageUnderSelection.map((m, idx) => (
              <div key={`${m.sourceFieldName}|${m.targetFieldName}|${idx}`} className="kv__row" style={{ alignItems: 'flex-start' }}>
                <div className="kv__k" title={m.sourceFieldName}>
                  <div className="mono" style={{ opacity: 0.9 }}>{m.sourceFieldName}</div>
                </div>
                <div className="kv__v" style={{ textAlign: 'right' }}>
                  <div className="mono">{m.targetFieldName}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
