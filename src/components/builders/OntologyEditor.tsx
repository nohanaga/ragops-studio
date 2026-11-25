import { useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { parseOntology, type WorkbenchGraph } from '../../lib/knowledgeGraph'
import { requireObject } from '../../lib/knowledgeGraph'
import { translations, type Language } from '../../lib/translations'
import type { JsonValue } from '../../lib/aiSearchRest'
import type { ThemePreference } from '../../types'
import { downloadText } from '../../utils/apiHelpers'
import { GraphJsonEditor } from './GraphJsonEditor'
import { GraphWorkspace } from './GraphWorkspace'
import { KnowledgeGraphCanvas } from '../viewers/KnowledgeGraphCanvas'
import { InfoTooltip } from '../InfoTooltip'

export function OntologyEditor({ value, onChange, onOpenPlayground, language, theme }: {
  value: string
  onChange: (value: string) => void
  onOpenPlayground: () => void
  language: Language
  theme: ThemePreference
}) {
  const t = (key: keyof typeof translations.ja) => translations[language][key]
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [inspectorTab, setInspectorTab] = useState<'selection' | 'json'>('json')
  const [entryDraft, setEntryDraft] = useState('')
  const [entryBaseline, setEntryBaseline] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [domain, setDomain] = useState('')
  const [range, setRange] = useState('')
  const parsed = useMemo(() => {
    try { return { ontology: parseOntology(value), error: null } }
    catch (e) { return { ontology: null, error: e instanceof Error ? e.message : String(e) } }
  }, [value])
  const graph: WorkbenchGraph = parsed.ontology?.graph ?? { nodes: [], edges: [] }
  function edit(action: () => void) {
    setError(null)
    try { action() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  function commit(entries: JsonValue[]) {
    if (!parsed.ontology) throw new Error(parsed.error ?? t('kgInvalid'))
    const text = JSON.stringify({ ...parsed.ontology.document, '@graph': entries }, null, 2)
    parseOntology(text)
    onChange(text)
  }
  function select(raw: JsonValue) {
    const entry = requireObject(raw, 'Ontology entry')
    setSelectedId(String(entry['@id']))
    setEntryDraft(JSON.stringify(entry, null, 2))
    setEntryBaseline(JSON.stringify(entry))
    setInspectorTab('selection')
  }
  return (
    <div className="pane__centerContent kgWorkbench">
      <header className="section kgHeader">
        <div className="kgHeader__heading">
          <h2 className="section__title"><i className="bi bi-bezier2 icon--mr6" />{t('ontologyEditor')}</h2>
          <div className="app__hint">{t('kgOntologyHint')}</div>
        </div>
        <div className="actions" data-guide-target="oe-actions">
        <button className="btn btn--secondary" onClick={onOpenPlayground} data-guide-target="oe-open-playground"><i className="bi bi-diagram-3 icon--mr6" />{t('knowledgeGraphPlayground')}</button>
        <label className="btn btn--secondary"><i className="bi bi-upload icon--mr6" />{t('kgImport')}
          <input type="file" accept=".json,.jsonld,application/json" hidden onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void file.text().then((text) => edit(() => { parseOntology(text); onChange(text); setSelectedId(null) }))
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
          }} />
        </label>
        <button className="btn btn--secondary" disabled={!parsed.ontology} onClick={() => downloadText('ontology.jsonld', value)}><i className="bi bi-download icon--mr6" />{t('kgExport')}</button>
        </div>
      </header>
      {(error || parsed.error) && <div className="notice notice--error" role="alert">{error || parsed.error}</div>}
      <section className="section kgPanel">
        <div className="kgPanel__header"><h3 className="section__title"><i className="bi bi-plus-circle icon--mr6" />{t('kgOntologyStructure')} <InfoTooltip tooltipKey="ontologyEntityTypes" language={language} /></h3><a className="kgDocsLink" href="https://learn.microsoft.com/azure/search/agentic-knowledge-source-how-to-entity-graph#prepare-content-and-an-ontology" target="_blank" rel="noreferrer">{t('kgDocs')} <i className="bi bi-box-arrow-up-right" /></a></div>
        <p className="field__hint">{t('kgOntologyTypesGuide')}</p>
        <p className="field__hint">{t('kgOntologyRelationsGuide')} <InfoTooltip tooltipKey="ontologyRelationships" language={language} /></p>
        <p className="field__hint"><code>Person &rarr; worksFor &rarr; Organization</code> · {t('kgOntologyExampleHint')}</p>
        {!graph.nodes.length && <p className="field__hint">{t('kgOntologyAddTypesFirst')}</p>}
        <div className="form" data-guide-target="oe-relation-form">
        <label className="field"><span className="field__label">{t('kgDomain')} <InfoTooltip tooltipKey="ontologyDomain" language={language} /></span><select className="field__input" aria-label={t('kgDomain')} value={domain} onChange={(e) => setDomain(e.target.value)}>
          <option value="">{t('kgSelect')}</option>
          {graph.nodes.map((node) => <option key={node.id} value={String(node.raw['@id'])}>{node.label}{node.label !== node.raw['@id'] ? ` (${String(node.raw['@id'])})` : ''}</option>)}
        </select><span className="field__hint">{t('kgDomainHint')}</span></label>
        <label className="field"><span className="field__label">{t('kgRange')} <InfoTooltip tooltipKey="ontologyRange" language={language} /></span><select className="field__input" aria-label={t('kgRange')} value={range} onChange={(e) => setRange(e.target.value)}>
          <option value="">{t('kgSelect')}</option>
          {graph.nodes.map((node) => <option key={node.id} value={String(node.raw['@id'])}>{node.label}{node.label !== node.raw['@id'] ? ` (${String(node.raw['@id'])})` : ''}</option>)}
        </select><span className="field__hint">{t('kgRangeHint')}</span></label>
        </div>
        <div className="actions" data-guide-target="oe-structure-actions">
        <button className="btn btn--primary" disabled={!parsed.ontology} onClick={() => edit(() => {
          const entry = { '@id': `https://example.org/ontology#Class-${uuidv4()}`, '@type': 'http://www.w3.org/2002/07/owl#Class' }
          commit([...(parsed.ontology?.entries ?? []), entry])
          select(entry)
        })}><i className="bi bi-plus-lg icon--mr6" />{t('kgAddClass')}</button>
        <button className="btn btn--secondary" disabled={!parsed.ontology || !domain || !range} onClick={() => edit(() => {
          const entry = {
            '@id': `https://example.org/ontology#Relation-${uuidv4()}`, '@type': 'http://www.w3.org/2002/07/owl#ObjectProperty',
            'http://www.w3.org/2000/01/rdf-schema#domain': { '@id': domain },
            'http://www.w3.org/2000/01/rdf-schema#range': { '@id': range },
          }
          commit([...(parsed.ontology?.entries ?? []), entry])
          select(entry)
        })}><i className="bi bi-bezier2 icon--mr6" />{t('kgAddRelation')}</button>
        </div>
      </section>
      <GraphWorkspace language={language}>
        <section className="section kgPanel kgCanvasPanel" data-guide-target="oe-map">
          <div className="kgPanel__header"><h3 className="section__title"><i className="bi bi-diagram-2 icon--mr6" />{t('kgOntologyMap')}</h3><span className="kgBadge">JSON-LD</span></div>
          <KnowledgeGraphCanvas graph={graph} selectedId={[...graph.nodes, ...graph.edges].find((item) => item.raw['@id'] === selectedId)?.id ?? null} language={language} theme={theme} onClearSelection={() => setSelectedId(null)} onSelect={(kind, id) => {
            const item = (kind === 'node' ? graph.nodes : graph.edges).find((item) => item.id === id)
            if (item) select(item.raw)
          }} />
          <details className="kgAdvanced">
            <summary className="section__subtitle">{t('kgDefinitions')} <span className="kgCount">{parsed.ontology?.entries.length ?? 0}</span></summary>
            <div className="kgList">
              {parsed.ontology?.entries.map((entry) => <button key={String(entry['@id'])} className={`kgListItem${selectedId === entry['@id'] ? ' kgListItem--active' : ''}`}
                aria-pressed={selectedId === entry['@id']} onClick={() => select(entry)}><i className="bi bi-braces" /><span>{String(entry['@id'])}</span></button>)}
            </div>
          </details>
        </section>
        <aside className="section kgPanel kgInspector" data-guide-target="oe-inspector">
          <div className="kgPanel__header"><h3 className="section__title"><i className="bi bi-braces icon--mr6" />{t('kgInspector')}</h3><span className="kgBadge">{t('kgLocalDraft')}</span></div>
          <div className="actions kgInspector__tabs">
            <button className={`btn btn--tab${inspectorTab === 'selection' ? ' btn--active' : ''}`} onClick={() => setInspectorTab('selection')} aria-pressed={inspectorTab === 'selection'}>{t('kgSelectionTab')}</button>
            <button className={`btn btn--tab${inspectorTab === 'json' ? ' btn--active' : ''}`} onClick={() => setInspectorTab('json')} aria-pressed={inspectorTab === 'json'}>JSON-LD</button>
          </div>
          <div hidden={inspectorTab !== 'selection'}>
          {selectedId ? <section>
            <div className="kgInspector__caption" title={selectedId}>{t('kgSelected')} · {selectedId}</div>
            <p className="field__hint">{t('kgOntologyEntryGuide')}</p>
            <GraphJsonEditor value={entryDraft} onChange={setEntryDraft} language={language} theme={theme} height="auto" />
            <div className="actions">
              <button className="btn btn--primary btn--sm" disabled={!parsed.ontology} onClick={() => edit(() => {
                if (JSON.stringify(parsed.ontology?.entries.find((item) => item['@id'] === selectedId)) !== entryBaseline) throw new Error(t('kgSelectAgain'))
                const entry = requireObject(JSON.parse(entryDraft) as JsonValue, 'Ontology entry')
                commit((parsed.ontology?.entries ?? []).map((item) => item['@id'] === selectedId ? entry : item))
                select(entry)
              })}>{t('kgUpdateDraft')}</button>
              <button className="btn btn--danger-text btn--sm" disabled={!parsed.ontology} onClick={() => edit(() => {
                if (JSON.stringify(parsed.ontology?.entries.find((item) => item['@id'] === selectedId)) !== entryBaseline) throw new Error(t('kgSelectAgain'))
                commit((parsed.ontology?.entries ?? []).filter((entry) => entry['@id'] !== selectedId))
                setSelectedId(null)
              })}>{t('kgDelete')}</button>
            </div>
          </section> : <div className="kgInspector__empty"><i className="bi bi-cursor" /><span>{t('kgSelectHint')}</span></div>}
          </div>
        <section hidden={inspectorTab !== 'json'}>
          <div className="kgInspector__caption">{t('kgOntologyDocument')}</div>
          <GraphJsonEditor value={value} onChange={(text) => { onChange(text); setSelectedId(null) }} language={language} theme={theme} height="430px" />
        </section>
        </aside>
      </GraphWorkspace>
    </div>
  )
}
