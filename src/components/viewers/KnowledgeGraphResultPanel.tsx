import { useMemo, useState } from 'react'
import { isJsonObject, type JsonObject } from '../../app/json'
import { buildGraphResultView, type WorkbenchGraph } from '../../lib/knowledgeGraph'
import type { JsonValue } from '../../lib/aiSearchRest'
import { translations, type Language } from '../../lib/translations'
import type { ThemePreference } from '../../types'
import { GraphJsonEditor } from '../builders/GraphJsonEditor'
import { KnowledgeGraphCanvas } from './KnowledgeGraphCanvas'

type ResultTab = 'graph' | 'table' | 'evidence' | 'diagnostics' | 'json'

export function ResultTable({ rows, language, theme }: { rows: JsonObject[]; language: Language; theme: ThemePreference }) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row).filter((key) => !key.startsWith('@search.'))))]
  if (!rows.length) return <div className="kgInspector__empty">{translations[language].kgNoResultRows}</div>
  return <div className="xt__wrap kgResultTable"><table className="xt" style={{ minWidth: Math.max(320, columns.length * 130) }}>
    <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
    <tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => {
      const value = row[column]
      return <td key={column}>{typeof value === 'object' && value !== null
        ? <details><summary>{Array.isArray(value) ? `Array (${value.length})` : 'Object'}</summary><GraphJsonEditor value={JSON.stringify(value, null, 2)} language={language} theme={theme} readOnly height="180px" /></details>
        : <span>{value === undefined ? '' : value === null ? 'null' : String(value)}</span>}</td>
    })}</tr>)}</tbody>
  </table></div>
}

export function KnowledgeGraphResultPanel({ data, definition, evidence, evidenceWarning, language, theme }: {
  data: JsonValue
  definition: JsonValue | null
  evidence: JsonObject[]
  evidenceWarning: string | null
  language: Language
  theme: ThemePreference
}) {
  const t = (key: keyof typeof translations.ja) => translations[language][key]
  const [tab, setTab] = useState<ResultTab>('graph')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const view = useMemo(() => {
    try { return { result: buildGraphResultView(data, definition, evidence), error: null } }
    catch (e) { return { result: null, error: e instanceof Error ? e.message : String(e) } }
  }, [data, definition, evidence])
  const graph: WorkbenchGraph = useMemo(() => {
    const source = view.result?.graph ?? { nodes: [], edges: [] }
    return view.result?.representation === 'projection'
      ? { ...source, nodes: source.nodes.map((node) => ({ ...node, type: translations[language].kgResultValue })) }
      : source
  }, [view.result, language])
  const rows = view.result?.rows ?? []
  const currentTab = tab === 'graph' && !graph.edges.length ? 'table' : tab
  const response = isJsonObject(data) ? data : {}
  const diagnostics = Array.isArray(response['@search.graphDiagnostics']) ? response['@search.graphDiagnostics'].filter(isJsonObject) : []
  const documents = isJsonObject(response['@search.graphProvenanceDocuments']) ? response['@search.graphProvenanceDocuments'] : {}
  const evidenceRows = Object.entries(documents).map(([id, value]) => ({ id, ...(isJsonObject(value) ? value : { value }) }))
  const selected = [...graph.nodes, ...graph.edges].find((item) => item.id === selectedId)
  const tabs: Array<[ResultTab, keyof typeof translations.ja | 'JSON', string]> = [
    ['graph', 'kgResultGraph', 'bi-diagram-3'], ['table', 'kgResultTable', 'bi-table'],
    ['evidence', 'kgResultEvidence', 'bi-file-earmark-text'], ['diagnostics', 'kgResultDiagnostics', 'bi-activity'], ['json', 'JSON', 'bi-braces'],
  ]
  return <section className="kgResult">
    <div className="kgPanel__header"><h3 className="section__title">{t('kgResult')}</h3>
      <div className="actions"><span className="kgBadge">{rows.length} {t('kgResultRows')}</span><span className="kgBadge">{graph.nodes.length} {t('kgNodes')} / {graph.edges.length} {t('kgEdges')}</span></div>
    </div>
    <div className="actions kgInspector__tabs">{tabs.map(([value, label, icon]) => <button key={value} type="button"
      className={`btn btn--tab${currentTab === value ? ' btn--active' : ''}`} disabled={value === 'graph' && !graph.edges.length}
      aria-pressed={currentTab === value} onClick={() => setTab(value)}><i className={`bi ${icon} icon--mr6`} aria-hidden="true" />
      {label === 'JSON' ? label : t(label)}</button>)}</div>
    {view.error && <div className="notice notice--error" role="alert">{view.error}</div>}
    {evidenceWarning && <div className="notice notice--warning" role="alert">{evidenceWarning}</div>}
    {currentTab === 'graph' && <>
      <p className="field__hint">{view.result?.representation === 'evidence' ? t('kgResultEvidenceGraphHint') : t('kgResultProjectionHint')}</p>
      {view.result?.missingEvidence ? <div className="notice notice--warning">{t('kgResultMissingEvidence')} {view.result.missingEvidence}</div> : null}
      <KnowledgeGraphCanvas graph={graph} selectedId={selectedId} language={language} theme={theme}
        onSelect={(_, id) => setSelectedId(id)} onClearSelection={() => setSelectedId(null)} />
      {selected && <div className="kgResultSelected"><h4 className="section__subtitle">{t('kgSelected')}</h4><ResultTable rows={[selected.raw]} language={language} theme={theme} /></div>}
    </>}
    {currentTab === 'table' && <ResultTable rows={rows} language={language} theme={theme} />}
    {currentTab === 'evidence' && <>
      <p className="field__hint">{t('kgResultEvidenceHint')}</p>
      <ResultTable rows={evidenceRows} language={language} theme={theme} />
    </>}
    {currentTab === 'diagnostics' && <>
      <div className="kgDiagnostics">{diagnostics.map((diagnostic, index) => <div key={index}
        className={`notice notice--${diagnostic.severity === 'error' ? 'error' : diagnostic.severity === 'warning' ? 'warning' : 'info'}`}>
        <div className="notice__title">{String(diagnostic.code ?? '')} <span className="kgBadge">{String(diagnostic.phase ?? '')}</span></div>
        <div>{String(diagnostic.message ?? '')}</div>
        {Array.isArray(diagnostic.suggestions) && <ul>{diagnostic.suggestions.filter((value): value is string => typeof value === 'string').map((value, item) => <li key={item}>{value}</li>)}</ul>}
      </div>)}</div>
      {!diagnostics.length && <p className="field__hint">{t('kgNoDiagnostics')}</p>}
      {response['@search.graphStatistics'] !== undefined && <ResultTable rows={isJsonObject(response['@search.graphStatistics'])
        ? Object.entries(response['@search.graphStatistics']).map(([metric, value]) => ({ metric, value }))
        : [{ value: response['@search.graphStatistics'] }]} language={language} theme={theme} />}
    </>}
    {currentTab === 'json' && <GraphJsonEditor value={JSON.stringify(data, null, 2)} language={language} theme={theme} readOnly height="360px" />}
  </section>
}
