import { useEffect, useEffectEvent, useId, useMemo, useRef, useState } from 'react'
import type { ConnectionProfile } from '../../lib/model'
import {
  createOrUpdateKnowledgeSource, getIndexDefinition, getKnowledgeSource, indexDocuments,
  listIndexes, listKnowledgeSources, queryKnowledgeGraph, searchDocuments, type JsonValue, type RestResult,
} from '../../lib/aiSearchRest'
import {
  buildGraphDocumentBatch, buildGraphProvenanceRequest, buildGraphStarterQuery, buildKnowledgeGraph, buildOntologySourceUpdate, buildTopicTitleRows, getManagedGraphOwner, graphMappings, graphProvenanceIndexName, graphResultEvidenceIds,
  classifyGraphIndexes, graphSourceIndex, isGraphBlobSource, type GraphIndexKind, type GraphIndexResource, type GraphProvenanceKind,
  KNOWLEDGE_GRAPH_API_VERSION, parseDocumentArray, parseOntology, requireObject, responseDocuments,
} from '../../lib/knowledgeGraph'
import { buildGqlVocabulary, EMPTY_GQL_VOCABULARY } from '../../lib/gqlAssist'
import { translations, type Language } from '../../lib/translations'
import type { ThemePreference } from '../../types'
import type { JsonObject } from '../../app/json'
import { isJsonObject } from '../../app/json'
import { downloadText } from '../../utils/apiHelpers'
import { getIndexKeyFieldName } from '../../utils/indexClone'
import { GraphDocumentDialog, GraphDocumentEditor } from './GraphDocumentEditor'
import { GraphJsonEditor } from './GraphJsonEditor'
import { GqlAssistant, type GqlApplyRequest } from './GqlAssistant'
import { GqlQueryCheck, GqlQueryExplain } from './GqlQueryHelper'
import { GraphWorkspace } from './GraphWorkspace'
import { KnowledgeGraphCanvas } from '../viewers/KnowledgeGraphCanvas'
import { KnowledgeGraphResultPanel, ResultTable } from '../viewers/KnowledgeGraphResultPanel'
import { JsonViewer } from '../viewers/JsonViewer'
import { serializeODataFilter, type ODataFilterExpr } from '../../lib/odataFilter'
import { InfoTooltip } from '../InfoTooltip'

const GQL_GUIDE_OPEN_STORAGE_KEY = 'ragops.knowledgeGraphPlayground.guideOpen'

function unwrap(result: RestResult): JsonValue {
  if (!result.ok) throw new Error(`${result.error.message} (${result.requestId})`)
  return result.response
}

function GraphSelectionDetails({ record, definition, language, theme }: {
  record: JsonObject
  definition: JsonValue
  language: Language
  theme: ThemePreference
}) {
  const t = (key: keyof typeof translations.ja) => translations[language][key]
  const [showJson, setShowJson] = useState(false)
  const mappings = graphMappings(definition)
  const coreFields = new Set([
    mappings.subjectField, mappings.predicateField, mappings.objectField, ...Object.values(mappings),
  ].filter((field): field is string => typeof field === 'string' && Object.hasOwn(record, field)))
  const groups = [
    { label: t('spbSkillEditorCore'), fields: [...coreFields] },
    { label: t('kgOtherFields'), fields: Object.keys(record).filter((key) => !coreFields.has(key)) },
  ]

  return <section className="skillEditor">
    <h4 className="kgInspector__caption">{t('kgSelected')}</h4>
    <table className="seGrid kgSelectionGrid" aria-label={t('kgSelected')}>
      <colgroup><col className="seGrid__colKey" /><col /></colgroup>
      {groups.filter(({ fields }) => fields.length > 0).map(({ label, fields }) => <tbody key={label}>
        <tr className="seGrid__sectionRow"><td colSpan={2}><div className="seGrid__sectionInner">{label}</div></td></tr>
        {fields.map((key) => <tr key={key}>
          <td className="seGrid__key" role="rowheader">{key}</td>
          <td className="seGrid__val"><div className="kgSelectionGrid__value">
            {typeof record[key] === 'object' && record[key] !== null
              ? <JsonViewer data={record[key]} t={t} initialOpenDepth={-1} collapseArraysByDefault />
              : String(record[key])}
          </div></td>
        </tr>)}
      </tbody>)}
    </table>
    <div className="skillEditor__jsonToggle">
      <button type="button" className="btn btn--sm btn--ghost" aria-expanded={showJson} onClick={() => setShowJson((visible) => !visible)}>
        <span aria-hidden="true">{showJson ? '▾' : '▸'}</span> {t('kgSelectedJson')}
      </button>
    </div>
    {showJson && <GraphJsonEditor value={JSON.stringify(record, null, 2)} language={language} theme={theme} readOnly height="auto" />}
  </section>
}

export function KnowledgeGraphPlayground({ active = true, profile, language, theme, ontologyJson, onOntologyChange, onOpenOntology }: {
  active?: boolean
  profile: ConnectionProfile | null
  language: Language
  theme: ThemePreference
  ontologyJson: string
  onOntologyChange: (value: string) => void
  onOpenOntology: () => void
}) {
  const t = (key: keyof typeof translations.ja) => translations[language][key]
  const [indexes, setIndexes] = useState<GraphIndexResource[]>([])
  const [sources, setSources] = useState<JsonObject[]>([])
  const [indexName, setIndexName] = useState('')
  const [loadedIndexName, setLoadedIndexName] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [kind, setKind] = useState<GraphIndexKind>('entity')
  const [titlePredicate, setTitlePredicate] = useState('')
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(100)
  const [definition, setDefinition] = useState<JsonValue | null>(null)
  const [baseline, setBaseline] = useState<JsonObject[]>([])
  const [draft, setDraft] = useState('[]')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showInspector, setShowInspector] = useState(true)
  const inspectorId = useId()
  const editHintId = useId()
  const [editingDocuments, setEditingDocuments] = useState(false)
  const [query, setQuery] = useState({ text: '', automatic: true })
  const [provenance, setProvenance] = useState<GraphProvenanceKind>('ids')
  const [caret, setCaret] = useState(0)
  const [guideOpen, setGuideOpen] = useState(() => {
    try {
      const saved = window.localStorage.getItem(GQL_GUIDE_OPEN_STORAGE_KEY)
      if (saved === 'false') return false
      if (saved !== null && saved !== 'true') console.warn('Invalid GQL guide visibility preference')
    } catch (error) {
      console.warn('Failed to restore GQL guide visibility', error)
    }
    return true
  })
  const [applied, setApplied] = useState<{ title: string; previous: { text: string; automatic: boolean }; previousProvenance: GraphProvenanceKind } | null>(null)
  const queryTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const guideId = useId()
  const [result, setResult] = useState<JsonValue | null>(null)
  const [resultRequestId, setResultRequestId] = useState('')
  const [resultEvidence, setResultEvidence] = useState<JsonObject[]>([])
  const [evidenceWarning, setEvidenceWarning] = useState<string | null>(null)
  const [queryError, setQueryError] = useState<{ message: string; response?: JsonValue } | null>(null)
  const [source, setSource] = useState<JsonObject | null>(null)
  const [pending, setPending] = useState<{ kind: 'documents' | 'ontology'; body: JsonObject } | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const resourcesRequestedOnOpen = useRef(false)
  const visualizationPanelRef = useRef<HTMLElement | null>(null)
  const [inspectorHeight, setInspectorHeight] = useState<number>()
  const canAutoLoad = active && !!profile?.endpoint.trim() && profile.apiVersion === KNOWLEDGE_GRAPH_API_VERSION
  const loadResourcesOnOpen = useEffectEvent(() => {
    if (!controllerRef.current && !resourcesRequestedOnOpen.current) void loadResources()
  })
  useEffect(() => () => controllerRef.current?.abort(), [])
  useEffect(() => {
    if (!canAutoLoad) {
      resourcesRequestedOnOpen.current = false
      return
    }
    if (busy || resourcesRequestedOnOpen.current) return
    // Wait for the tab to commit before starting the request (including Strict Mode's effect replay).
    const timer = window.setTimeout(() => loadResourcesOnOpen(), 0)
    return () => window.clearTimeout(timer)
  }, [canAutoLoad, busy])
  useEffect(() => {
    const panel = visualizationPanelRef.current
    if (!panel) return
    const observer = new ResizeObserver(() => {
      const height = panel.getBoundingClientRect().height
      if (height > 0) setInspectorHeight(height)
    })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])
  const parsed = useMemo(() => {
    try {
      const documents = parseDocumentArray(draft)
      return { documents, graph: definition ? buildKnowledgeGraph(definition, documents) : { nodes: [], edges: [] }, error: null }
    } catch (e) { return { documents: [], graph: { nodes: [], edges: [] }, error: e instanceof Error ? e.message : String(e) } }
  }, [definition, draft])
  const selectedItem = parsed.graph.nodes.find((node) => node.id === selectedId) ?? parsed.graph.edges.find((edge) => edge.id === selectedId)
  // GQL は Azure 上のデータを検索するため、編集中の草案ではなく取得時点の文書から入力候補を作ります。
  const gqlVocabulary = useMemo(() => {
    if (!definition || !loadedIndexName) return EMPTY_GQL_VOCABULARY
    try {
      return buildGqlVocabulary(buildKnowledgeGraph(definition, baseline), graphProvenanceIndexName(definition) !== undefined)
    } catch { return EMPTY_GQL_VOCABULARY }
  }, [definition, baseline, loadedIndexName])
  const dirty = draft !== JSON.stringify(baseline, null, 2)
  const owner = getManagedGraphOwner(sources, loadedIndexName)
  const documentReview = pending?.kind === 'documents' ? pending.body : null
  const documentReviewRows = useMemo(() => {
    if (!definition || !documentReview || !Array.isArray(documentReview.value)) return []
    const key = getIndexKeyFieldName(definition)
    const mappings = graphMappings(definition)
    const previous = new Map(baseline.map((record) => [record[key], record]))
    const relation = (record?: JsonObject) => record
      ? [mappings.subjectField, mappings.predicateField, mappings.objectField].map((field) => String(record[String(field)])).join(' → ')
      : ''
    const labels = translations[language]
    return documentReview.value.filter(isJsonObject).map((record) => {
      const prior = previous.get(record[key])
      const deleting = record['@search.action'] === 'delete'
      return {
        [labels.kgDocumentOperation]: deleting ? labels.delete : prior ? labels.kgDocumentUpdate : labels.kgDocumentAdd,
        [labels.kgDocumentId]: record[key],
        [labels.kgDocumentBefore]: relation(prior),
        [labels.kgDocumentAfter]: deleting ? '' : relation(record),
      }
    })
  }, [definition, baseline, documentReview, language])
  const filteredIndexes = indexes.filter((index) => index.kind === kind)
  const loadedKind = indexes.find((index) => index.name === loadedIndexName)?.kind ?? 'unclassified'
  const predicates = [...new Set(parsed.graph.edges.map((edge) => edge.label))]
  const selectedTitlePredicate = predicates.includes(titlePredicate)
    ? titlePredicate : predicates.find((predicate) => predicate.toLowerCase() === 'title') ?? ''
  const topicTitles = useMemo(() => {
    try {
      return { rows: definition && loadedKind === 'topic' && selectedTitlePredicate
        ? buildTopicTitleRows(definition, parsed.documents, selectedTitlePredicate) : [], error: null }
    } catch (e) { return { rows: [], error: e instanceof Error ? e.message : String(e) } }
  }, [definition, loadedKind, parsed.documents, selectedTitlePredicate])
  const ontologySources = sources.filter(isGraphBlobSource)
  const selectedSource = ontologySources.find((item) => item.name === sourceName)
  const ontologyGraphIndex = selectedSource ? graphSourceIndex(selectedSource) : undefined
  const kindLabel = (value: GraphIndexKind) => t(value === 'entity' ? 'kgEntity' : value === 'topic' ? 'kgTopic' : 'kgUnclassified')
  const selectedDefinition = loadedIndexName === indexName && isJsonObject(definition)
    ? definition : indexes.find((index) => index.name === indexName)?.definition
  const filterFields = selectedDefinition && Array.isArray(selectedDefinition.fields)
    ? selectedDefinition.fields.filter(isJsonObject).filter((field) => field.filterable === true && typeof field.name === 'string').map((field) => String(field.name)) : []
  let filterExample = t('kgFilterPlaceholder')
  if (selectedDefinition && isJsonObject(selectedDefinition.graphProfile ?? null)
    && isJsonObject(selectedDefinition.graphProfile.fields ?? null)) {
    const field = selectedDefinition.graphProfile.fields.predicateField
    if (typeof field === 'string' && field) {
      const value = loadedIndexName === indexName ? baseline[0]?.[field] : undefined
      filterExample = serializeODataFilter({
        kind: 'compare', op: 'eq', left: { kind: 'path', value: field },
        right: { kind: 'stringLiteral', value: typeof value === 'string' ? value : t('kgFilterExampleValue') },
      })
    }
  }
  async function run(action: (connection: ConnectionProfile, signal: AbortSignal) => Promise<void>, errorTarget: 'notice' | 'query' = 'notice') {
    setNotice(null)
    const reportError = (message: string) => {
      if (errorTarget === 'query') setQueryError({ message })
      else setNotice({ error: true, text: message })
    }
    if (!profile || profile.apiVersion !== KNOWLEDGE_GRAPH_API_VERSION) {
      reportError(t('kgNeedVersion'))
      return
    }
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setBusy(true)
    try { await action(profile, controller.signal) }
    catch (e) {
      if (!controller.signal.aborted) reportError(e instanceof Error ? e.message : String(e))
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null
        if (!controller.signal.aborted) setBusy(false)
      }
    }
  }
  async function loadResources() {
    await run(async (connection, signal) => {
      resourcesRequestedOnOpen.current = true
      const [indexResult, sourceResult] = await Promise.all([
        listIndexes({ profile: connection, apiVersion: connection.apiVersion, language, signal }),
        listKnowledgeSources({ profile: connection, language, signal }),
      ])
      signal.throwIfAborted()
      const sourceItems = responseDocuments(unwrap(sourceResult))
      const resources = classifyGraphIndexes(responseDocuments(unwrap(indexResult)), sourceItems)
      setIndexes(resources)
      setSources(sourceItems)
      if (!indexes.length && !indexName && !resources.some((index) => index.kind === kind)) {
        const available = resources[0]?.kind
        if (available) setKind(available)
      }
    })
  }
  async function loadGraph(targetIndexName = indexName) {
    await run(async (connection, signal) => {
      if (dirty) throw new Error(t('kgDiscardFirst'))
      if (!targetIndexName) throw new Error(t('kgSelectIndex'))
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error(t('kgLimitError'))
      setIndexName(targetIndexName)
      const index = unwrap(await getIndexDefinition({ profile: connection, apiVersion: connection.apiVersion, indexName: targetIndexName, language }))
      signal.throwIfAborted()
      const documents = responseDocuments(unwrap(await searchDocuments({
        profile: connection, apiVersion: connection.apiVersion, indexName: targetIndexName, language, signal,
        body: { search: '*', top: limit, ...(filter.trim() ? { filter } : {}) },
      })))
      const graph = buildKnowledgeGraph(index, documents)
      signal.throwIfAborted()
      setDefinition(index)
      setLoadedIndexName(targetIndexName)
      if (targetIndexName !== loadedIndexName) {
        const relatedSource = sources.find((item) => graphSourceIndex(item) === targetIndexName)
        setSourceName(typeof relatedSource?.name === 'string' ? relatedSource.name : '')
        setSource(null)
      }
      setBaseline(documents)
      setDraft(JSON.stringify(documents, null, 2))
      setSelectedId(null)
      setPending(null)
      setResult(null)
      setResultEvidence([])
      setEvidenceWarning(null)
      setQueryError(null)
      try {
        const starter = buildGraphStarterQuery(graph)
        setQuery((current) => current.automatic || !current.text.trim() ? { text: starter, automatic: true } : current)
      } catch (e) {
        setQuery((current) => current.automatic ? { text: '', automatic: true } : current)
        setQueryError({ message: e instanceof Error ? e.message : String(e) })
      }
    })
  }
  async function runQuery(override?: { text: string; provenance: GraphProvenanceKind }) {
    setQueryError(null)
    setResult(null)
    setResultEvidence([])
    setEvidenceWarning(null)
    const gql = override?.text ?? query.text
    const requestedProvenance = buildGraphProvenanceRequest(override?.provenance ?? provenance)
    await run(async (connection, signal) => {
      const response = await queryKnowledgeGraph({
        profile: connection, indexName: loadedIndexName, language, signal,
        body: { gql, includeStatistics: true, includeDiagnostics: true, ...(requestedProvenance ? { provenance: requestedProvenance } : {}), ...(filter.trim() ? { filter } : {}) },
      })
      signal.throwIfAborted()
      if (!response.ok) {
        setQueryError({
          message: `${response.error.message} (${response.requestId})`,
          response: response.error.response ?? response.error.responseText,
        })
        return
      }
      const ids = graphResultEvidenceIds(response.response)
      const evidence: JsonObject[] = []
      if (ids.length && definition) {
        try {
          const key = graphMappings(definition).assertionIdField
          if (typeof key !== 'string' || !key) throw new Error('Missing graph assertion ID field.')
          for (let offset = 0; offset < ids.length; offset += 32) {
            const group = ids.slice(offset, offset + 32)
            const expressions: ODataFilterExpr[] = group.map((id) => ({
              kind: 'compare', op: 'eq', left: { kind: 'path', value: key }, right: { kind: 'stringLiteral', value: id },
            }))
            const filter = serializeODataFilter(expressions.reduce((left, right) => ({ kind: 'or', left, right })))
            evidence.push(...responseDocuments(unwrap(await searchDocuments({
              profile: connection, apiVersion: connection.apiVersion, indexName: loadedIndexName, language, signal,
              body: { search: '*', top: group.length, filter },
            }))))
            signal.throwIfAborted()
          }
        } catch (e) {
          signal.throwIfAborted()
          setEvidenceWarning(`${t('kgResultEvidenceFailed')}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      setResultEvidence(evidence)
      setResultRequestId(response.requestId)
      setResult(response.response)
    }, 'query')
  }
  function toggleGuide() {
    const open = !guideOpen
    setGuideOpen(open)
    try {
      window.localStorage.setItem(GQL_GUIDE_OPEN_STORAGE_KEY, String(open))
    } catch (error) {
      console.warn('Failed to save GQL guide visibility', error)
    }
  }

  function applyGql(request: GqlApplyRequest) {
    const nextProvenance = request.provenance ?? provenance
    setApplied({ title: request.title, previous: query, previousProvenance: provenance })
    setQuery({ text: request.gql, automatic: false })
    setProvenance(nextProvenance)
    setQueryError(null)
    setCaret(request.gql.length)
    if (request.run) void runQuery({ text: request.gql, provenance: nextProvenance })
  }
  function undoApplied() {
    if (!applied) return
    setQuery(applied.previous)
    setProvenance(applied.previousProvenance)
    setCaret(applied.previous.text.length)
    setQueryError(null)
    setApplied(null)
  }
  function applyCompletion(from: number, to: number, insertText: string) {
    const position = from + insertText.length
    setQuery({ text: query.text.slice(0, from) + insertText + query.text.slice(to), automatic: false })
    setCaret(position)
    setApplied(null)
    setQueryError(null)
    window.requestAnimationFrame(() => {
      const area = queryTextareaRef.current
      if (!area) return
      area.focus()
      area.setSelectionRange(position, position)
    })
  }
  async function readOntology() {
    await run(async (connection, signal) => {
      if (!sourceName) throw new Error(t('kgSelectSource'))
      const source = requireObject(unwrap(await getKnowledgeSource({ profile: connection, knowledgeSourceName: sourceName, language })), 'Knowledge source')
      const parameters = requireObject(source.azureBlobParameters ?? null, 'azureBlobParameters')
      const extraction = requireObject(parameters.graphExtraction ?? null, 'graphExtraction')
      const ontology = requireObject(extraction.ontology ?? null, 'ontology')
      if (typeof ontology.value !== 'string') throw new Error(t('kgNoOntology'))
      parseOntology(ontology.value)
      signal.throwIfAborted()
      setSource(source)
      onOntologyChange(JSON.stringify(JSON.parse(ontology.value) as JsonValue, null, 2))
      setPending(null)
      setNotice({ error: false, text: t('kgOntologyReadDone') })
    })
  }
  async function reviewDocuments() {
    await run(async (connection, signal) => {
      if (!definition) throw new Error(t('kgSelectIndex'))
      if (parsed.error) throw new Error(parsed.error)
      const sources = responseDocuments(unwrap(await listKnowledgeSources({ profile: connection, language, signal })))
      signal.throwIfAborted()
      setSources(sources)
      const owner = getManagedGraphOwner(sources, loadedIndexName)
      if (owner) throw new Error(`${t('kgManaged')} (${owner})`)
      const body = buildGraphDocumentBatch(definition, baseline, parsed.documents)
      if (Array.isArray(body.value) && body.value.length === 0) throw new Error(t('kgNoChanges'))
      setPending({ kind: 'documents', body })
    })
  }
  async function reviewOntology() {
    await run(async (connection, signal) => {
      if (!source || source.name !== sourceName) throw new Error(t('kgReadOntologyFirst'))
      const fresh = requireObject(unwrap(await getKnowledgeSource({ profile: connection, knowledgeSourceName: sourceName, language })), 'Knowledge source')
      const originalOntology = requireObject(requireObject(source.azureBlobParameters ?? null, 'azureBlobParameters').graphExtraction ?? null, 'graphExtraction').ontology
      const freshOntology = requireObject(requireObject(fresh.azureBlobParameters ?? null, 'azureBlobParameters').graphExtraction ?? null, 'graphExtraction').ontology
      if (JSON.stringify(originalOntology) !== JSON.stringify(freshOntology)) throw new Error(t('kgConflict'))
      const body = buildOntologySourceUpdate(fresh, ontologyJson)
      signal.throwIfAborted()
      setPending({ kind: 'ontology', body })
    })
  }
  async function confirmSave() {
    if (!pending) return
    await run(async (connection, signal) => {
      setResultEvidence([])
      setEvidenceWarning(null)
      setResultRequestId('')
      if (pending.kind === 'documents') {
        const sources = responseDocuments(unwrap(await listKnowledgeSources({ profile: connection, language, signal })))
        signal.throwIfAborted()
        setSources(sources)
        if (getManagedGraphOwner(sources, loadedIndexName)) throw new Error(t('kgManaged'))
        const response = unwrap(await indexDocuments({ profile: connection, apiVersion: connection.apiVersion, indexName: loadedIndexName, body: pending.body, language, signal }))
        signal.throwIfAborted()
        setResult(response)
        const items = responseDocuments(response)
        if (!Array.isArray(pending.body.value) || items.length !== pending.body.value.length
          || items.some((item) => item.status !== true && item.succeeded !== true)) {
          throw new Error(t('kgPartialSave'))
        }
        signal.throwIfAborted()
        setBaseline(parsed.documents)
        setDraft(JSON.stringify(parsed.documents, null, 2))
      } else {
        const fresh = requireObject(unwrap(await getKnowledgeSource({ profile: connection, knowledgeSourceName: sourceName, language })), 'Knowledge source')
        if (JSON.stringify(buildOntologySourceUpdate(fresh, ontologyJson)) !== JSON.stringify(pending.body)) throw new Error(t('kgConflict'))
        signal.throwIfAborted()
        const response = unwrap(await createOrUpdateKnowledgeSource({ profile: connection, knowledgeSourceName: sourceName, body: pending.body, language }))
        signal.throwIfAborted()
        setSource(requireObject(response, 'Knowledge source'))
        setResult(response)
      }
      setNotice({ error: false, text: pending.kind === 'ontology' ? t('kgOntologySaved') : t('kgSaved') })
      setPending(null)
    })
  }
  return (
    <div className="pane__centerContent kgWorkbench">
      <header className="section kgHeader">
        <div className="kgHeader__heading">
          <h2 className="section__title"><i className="bi bi-diagram-3 icon--mr6" />{t('knowledgeGraphPlayground')}</h2>
          <div className="app__hint">{t('kgHint')}</div>
        </div>
        <div className="actions">
        <span className="kgBadge">2026-11-01-preview</span>
        <button className="btn btn--secondary" onClick={onOpenOntology}><i className="bi bi-bezier2 icon--mr6" />{t('ontologyEditor')}</button>
        {busy && <button className="btn btn--secondary" onClick={() => {
          controllerRef.current?.abort(); setBusy(false); setNotice({ error: true, text: t('kgCanceled') })
        }}>{t('kgCancel')}</button>}
        </div>
      </header>
      {notice && !documentReview && <div className={`notice notice--${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</div>}
      <section className="section kgPanel">
        <div className="kgPanel__header"><h3 className="section__title"><i className="bi bi-sliders icon--mr6" />{t('kgResourceSettings')}</h3>
          <a className="kgDocsLink" href="https://learn.microsoft.com/azure/search/knowledge-graph-features-overview" target="_blank" rel="noreferrer"><i className="bi bi-box-arrow-up-right" /> {t('kgDocs')}</a>
        </div>
      <div className="form">
        <label className="field"><span className="field__label">{t('kgKind')} <InfoTooltip tooltipKey="graphIndexKind" language={language} /></span>
          <select className="field__input" aria-label={t('kgKind')} value={kind} disabled={busy} onChange={(e) => {
            const value: GraphIndexKind = e.target.value === 'topic' ? 'topic' : e.target.value === 'unclassified' ? 'unclassified' : 'entity'
            setKind(value)
            if (indexes.find((index) => index.name === indexName)?.kind !== value) setIndexName('')
          }}>
            {(['entity', 'topic', 'unclassified'] as const).map((value) => <option key={value} value={value}>{kindLabel(value)} ({indexes.filter((index) => index.kind === value).length})</option>)}
          </select>
          <span className="field__hint">{t('kgKindFilterHint')}</span>
        </label>
        <div className="field">
          <span className="field__label">{t('kgIndex')}</span>
          <div className="indexSelectControl">
            <select className="field__input" aria-label={t('kgIndex')} value={indexName} disabled={busy} onChange={(e) => {
              const name = e.target.value
              if (name) void loadGraph(name)
              else setIndexName('')
            }}>
              <option value="">{t('kgSelect')}</option>
              {filteredIndexes.map((index) => <option key={index.name} value={index.name}>{index.name}</option>)}
            </select>
            <button type="button" className="btn btn--icon indexSelectReloadBtn" disabled={busy}
              aria-label={t('kgRefresh')} title={t('kgRefresh')} onClick={() => void loadResources()}>
              <i className={`bi ${busy ? 'bi-arrow-repeat spin' : 'bi-arrow-clockwise'}`} aria-hidden="true" />
            </button>
          </div>
          {indexes.length > 0 && !filteredIndexes.length && <span className="field__hint">{t('kgNoKindIndexes')}</span>}
        </div>
        <label className="field"><span className="field__label">{t('kgFilter')} <InfoTooltip tooltipKey="graphODataFilter" language={language} /></span>
          <input className="field__input" aria-label={t('kgFilter')} value={filter} placeholder={filterExample} onChange={(e) => setFilter(e.target.value)} />
          <span className="field__hint">{t('kgFilterExampleLabel')} <code>{filterExample}</code></span>
          <span className="field__hint">{t('kgFilterFieldsHint')}{filterFields.length ? `: ${filterFields.join(', ')}` : ''}</span>
        </label>
        <label className="field"><span className="field__label">{t('kgLimit')}</span><input className="field__input" type="number" min={1} max={1000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} /></label>
      </div>
        <div className="actions">
          <button className="btn btn--primary" disabled={busy || !indexName} onClick={() => void loadGraph()}><i className="bi bi-play-fill icon--mr6" />{t('kgLoad')}</button>
        </div>
        <details className="kgAdvanced">
          <summary className="section__subtitle"><i className="bi bi-bezier2 icon--mr6" />{t('kgOntologyConnection')}</summary>
          <p className="field__hint">{t('kgOntologyConnectionHint')} <a href="https://learn.microsoft.com/azure/search/agentic-knowledge-source-how-to-entity-graph#prepare-content-and-an-ontology" target="_blank" rel="noreferrer">{t('kgDocs')}</a></p>
          {loadedKind === 'topic' && loadedIndexName && <p className="field__hint">{t('kgTopicOntologyHint')}</p>}
          <div className="kgSourceRow">
        <label className="field"><span className="field__label">{t('kgSource')} <InfoTooltip tooltipKey="graphOntologySource" language={language} /></span><select className="field__input" aria-label={t('kgSource')} disabled={busy || !ontologySources.length} value={sourceName} onChange={(e) => { setSourceName(e.target.value); setSource(null); setPending(null) }}>
          <option value="">{t('kgSelect')}</option>
          {ontologySources.map((source) => <option key={String(source.name)} value={String(source.name)}>{String(source.name)}</option>)}
        </select></label>
          <div className="actions">
            <button className="btn btn--secondary" disabled={busy || !sourceName} onClick={() => void readOntology()}><i className="bi bi-cloud-arrow-down icon--mr6" />{t('kgReadOntology')}</button>
            <button className="btn btn--secondary" disabled={busy || !source} onClick={() => void reviewOntology()}>{t('kgReviewOntology')}</button>
          </div>
          </div>
          {!ontologySources.length && <p className="field__hint">{t('kgNoOntologySources')}</p>}
          {sourceName && <p className="field__hint">{t('kgOntologyTargetIndex')}: <strong>{ontologyGraphIndex ?? t('kgUnknownIndex')}</strong>
            {ontologyGraphIndex && loadedIndexName && ontologyGraphIndex !== loadedIndexName && <> · {t('kgOntologyDifferentGraph')}</>}
          </p>}
          <div className="field__hint"><strong>{t('kgReadAction')}:</strong> {t('kgOntologyReadImpact')}</div>
          <div className="field__hint"><strong>{t('kgApplyAction')}:</strong> {t('kgOntologyApplyImpact')}</div>
        </details>
      </section>
      {parsed.error && <div className="notice notice--error" role="alert">{parsed.error}</div>}
      <GraphWorkspace language={language} showInspector={showInspector}>
        <section className="section kgPanel kgCanvasPanel" ref={visualizationPanelRef}>
          <div className="kgPanel__header">
            <h3 className="section__title"><i className="bi bi-diagram-2 icon--mr6" />{t('kgVisualization')}</h3>
            <span className="kgBadge">{loadedIndexName ? `${loadedIndexName} · ${kindLabel(loadedKind)}` : kindLabel(kind)}</span>
            <button type="button" className="btn btn--secondary btn--sm" aria-controls={inspectorId} aria-expanded={showInspector} onClick={() => setShowInspector((visible) => !visible)}>
              <i className="bi bi-layout-sidebar-reverse icon--mr6" aria-hidden="true" />{t(showInspector ? 'kgHideInspector' : 'kgShowInspector')}
            </button>
          </div>
          <div className="kgGraphEditBar">
            <p id={editHintId} className="field__hint">
              {dirty && <strong className="kgBadge">{t('kgDocumentPreviewActive')}</strong>}
              {owner ? t('kgSaveManagedHint') : dirty ? t('kgEditLocalOnly')
                : definition ? t('kgEditEntryHint') : t('kgEditLoadFirst')}
            </p>
            <div className="actions">
              <button type="button" className="btn btn--secondary btn--sm" aria-haspopup="dialog" aria-describedby={editHintId}
                disabled={!definition || busy || !!pending} onClick={() => setEditingDocuments(true)}>
                <i className="bi bi-pencil-square icon--mr6" aria-hidden="true" />{t('kgEditDocuments')}
              </button>
              {dirty && <>
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy || !!pending} onClick={() => {
                  setDraft(JSON.stringify(baseline, null, 2)); setSelectedId(null); setNotice(null)
                }}>{t('kgDiscard')}</button>
                {!owner && <button type="button" className="btn btn--primary btn--sm" aria-haspopup="dialog"
                  disabled={busy || !!pending || !!parsed.error} onClick={() => void reviewDocuments()}>
                  <i className="bi bi-cloud-arrow-up icon--mr6" aria-hidden="true" />{t('kgReviewSave')}
                </button>}
              </>}
            </div>
          </div>
          <KnowledgeGraphCanvas graph={parsed.graph} selectedId={selectedId} language={language} theme={theme}
            onClearSelection={() => setSelectedId(null)} onSelect={(_, id) => setSelectedId(id)} />
          <div className="kgCanvasHint"><i className="bi bi-info-circle" /><span>{loadedKind === 'topic' ? t('kgTopicHint') : t('kgPartial')}</span></div>
          {loadedKind === 'topic' && <section className="kgAdvanced kgTopics">
            <h4 className="section__subtitle">{t('kgTopicList')} <span className="kgCount">{topicTitles.rows.length}</span></h4>
            <p className="field__hint">{t('kgTopicListHint')}</p>
            <label className="field"><span className="field__label">{t('kgTopicTitlePredicate')} <InfoTooltip tooltipKey="graphTopicTitlePredicate" language={language} /></span>
              <select className="field__input" aria-label={t('kgTopicTitlePredicate')} value={selectedTitlePredicate} onChange={(event) => setTitlePredicate(event.target.value)}>
                <option value="">{t('kgSelect')}</option>
                {predicates.map((predicate) => <option key={predicate} value={predicate}>{predicate}</option>)}
              </select>
            </label>
            {topicTitles.error && <div className="notice notice--error" role="alert">{t('kgTopicTitleInvalid')} {topicTitles.error}</div>}
            <ResultTable rows={topicTitles.rows.map((row) => ({ [t('kgTopicTitle')]: row.title, [t('kgTopicId')]: row.id, [t('kgGraphName')]: row.graph }))}
              language={language} theme={theme} />
          </section>}
          <details className="kgAdvanced kgRelations">
            <summary className="section__subtitle">{t('kgRelationships')} <span className="kgCount">{parsed.graph.edges.length}</span></summary>
            <div className="kgList">
              {parsed.graph.edges.map((edge) => <button key={edge.id} className={`kgListItem${selectedId === edge.id ? ' kgListItem--active' : ''}`} aria-pressed={selectedId === edge.id} onClick={() => setSelectedId(edge.id)}>
                <span>{parsed.graph.nodes.find((node) => node.id === edge.source)?.label}</span><span className="kgListItem__relation">{edge.label} <i className="bi bi-arrow-right" aria-hidden="true" /></span><span>{parsed.graph.nodes.find((node) => node.id === edge.target)?.label}</span>
              </button>)}
            </div>
          </details>
        </section>
        <aside id={inspectorId} hidden={!showInspector} className="section kgPanel kgInspector kgInspector--matched" style={{ height: inspectorHeight }}>
          <div className="kgPanel__header"><h3 className="section__title"><i className="bi bi-list-ul icon--mr6" />{t('kgInspector')}</h3><span className="kgBadge">{t('kgReadOnly')}</span></div>
          {selectedItem && definition
            ? <GraphSelectionDetails key={selectedItem.id} record={selectedItem.raw} definition={definition} language={language} theme={theme} />
            : <div className="kgInspector__empty"><i className="bi bi-cursor" /><span>{t('kgInspectSelectionHint')}</span></div>}
        </aside>
      </GraphWorkspace>
      {editingDocuments && definition !== null && <GraphDocumentEditor definition={definition} indexName={loadedIndexName} baseline={baseline} draft={draft}
        initialRecord={selectedItem ? parsed.documents.indexOf(selectedItem.raw) : 0} owner={owner} language={language} theme={theme}
        onDismiss={() => setEditingDocuments(false)}
        onPreview={(value) => { setDraft(value); setNotice(null); setEditingDocuments(false) }} />}
      {documentReview && <GraphDocumentDialog title={t('kgReviewSave')} description={t('kgSaveWarning')} language={language} busy={busy}
        onDismiss={() => { setPending(null); setNotice(null) }} footer={<>
          {busy && <span role="status" className="field__hint">{t('kgDocumentSaving')}</span>}
          <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => { setPending(null); setNotice(null) }}>{t('kgCancel')}</button>
          <button type="button" className="btn btn--primary" disabled={busy || !!owner} onClick={() => void confirmSave()}>
            {t('kgConfirmSave')}
          </button>
        </>}>
        <div className="actions"><span className="kgBadge">{t('kgIndex')}: <strong>{loadedIndexName}</strong></span>
          <span className="kgBadge">{documentReviewRows.length.toLocaleString(language)} {t('kgDocumentUnit')}</span></div>
        {notice?.error && <div className="notice notice--error" role="alert">{notice.text}</div>}
        <ResultTable rows={documentReviewRows} language={language} theme={theme} />
        <details className="kgAdvanced">
          <summary className="section__subtitle">{t('kgDocumentPayload')}</summary>
          <GraphJsonEditor value={JSON.stringify(documentReview, null, 2)} language={language} theme={theme} readOnly height="220px" />
        </details>
      </GraphDocumentDialog>}
      {pending?.kind === 'ontology' && <section className="section kgPanel kgConfirmation">
        <h3 className="section__title"><i className="bi bi-cloud-arrow-up icon--mr6" />{t('kgReviewOntology')}</h3>
        <p className="field__hint">{t('kgSource')}: <strong>{sourceName}</strong></p>
        <p className="app__hint">{t('kgOntologyApplyImpact')}</p>
        <GraphJsonEditor value={JSON.stringify(pending.body, null, 2)} language={language} theme={theme} readOnly height="240px" />
        <div className="actions">
          <button className="btn btn--primary" disabled={busy} onClick={() => void confirmSave()}>{t('kgConfirmSave')}</button>
          <button className="btn btn--secondary" disabled={busy} onClick={() => setPending(null)}>{t('kgCancel')}</button>
        </div>
      </section>}
      <section className="section kgPanel kgQuerySection">
        <div className="kgPanel__header"><h3 className="section__title"><i className="bi bi-terminal icon--mr6" />{t('kgQuery')}</h3><span className="kgBadge">GQL</span>
          <button type="button" className="btn btn--secondary btn--sm" aria-expanded={guideOpen} aria-controls={guideId} onClick={toggleGuide}>
            <i className="bi bi-mortarboard icon--mr6" aria-hidden="true" />{t(guideOpen ? 'kgGqlGuideHide' : 'kgGqlGuideShow')}
          </button>
        </div>
        <p className="field__hint">{t('kgQueryConstraintHint')} <a href="https://learn.microsoft.com/azure/search/agentic-knowledge-source-how-to-entity-graph#query-the-graph-directly-with-gql" target="_blank" rel="noreferrer">{t('kgDocs')}</a></p>
        <div id={guideId} className="kgGqlGuide" hidden={!guideOpen}>
          <h4 className="kgGqlGuide__title"><i className="bi bi-mortarboard icon--mr6" aria-hidden="true" />{t('kgGqlGuide')}</h4>
          <p className="field__hint">{t('kgGqlGuideHint')}</p>
          <GqlAssistant language={language} vocabulary={gqlVocabulary} canRun={!busy && !!loadedIndexName} onApply={applyGql} />
        </div>
        {applied && <div className="notice notice--info kgGqlApplied" role="status">
          <div>{t('kgGqlApplied').replace('{title}', applied.title)}</div>
          <div className="notice__actions"><button type="button" className="btn btn--ghost btn--sm" onClick={undoApplied}>
            <i className="bi bi-arrow-counterclockwise icon--mr6" aria-hidden="true" />{t('kgGqlUndo')}
          </button></div>
        </div>}
        <div className="field__label kgGqlLabel">GQL <span aria-hidden="true">*</span> <InfoTooltip tooltipKey="graphGql" language={language} /></div>
        <textarea ref={queryTextareaRef} className="field__textarea" aria-label="GQL" required spellCheck={false} rows={6} value={query.text} placeholder={t('kgQueryPlaceholder')}
          onChange={(e) => { setQuery({ text: e.target.value, automatic: false }); setCaret(e.target.selectionStart); setApplied(null); setQueryError(null) }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)} />
        <GqlQueryCheck text={query.text} caret={caret} vocabulary={gqlVocabulary} language={language} onComplete={applyCompletion} />
        {queryError && <div className="notice notice--error kgQueryError" role="alert">
          <div className="notice__title">{t('kgQueryError')}</div>
          <div>{queryError.message}</div>
          {queryError.response !== undefined && <details>
            <summary>{t('kgErrorDetails')}</summary>
            <GraphJsonEditor value={JSON.stringify(queryError.response, null, 2)} language={language} theme={theme} readOnly height="240px" />
          </details>}
        </div>}
        <div className="kgQueryActions">
          <label className="field"><span className="field__label">{t('kgProvenance')} <InfoTooltip tooltipKey="graphProvenance" language={language} /></span><select className="field__input" value={provenance} onChange={(e) => setProvenance(e.target.value === 'hydrate' ? 'hydrate' : e.target.value === 'ids' ? 'ids' : 'none')}>
            <option value="none">none</option><option value="ids">ids</option><option value="hydrate">hydrate</option>
          </select></label>
          <button className="btn btn--primary" disabled={busy || !loadedIndexName || !query.text.trim()} onClick={() => void runQuery()}><i className="bi bi-play-fill icon--mr6" />{t('kgRunQuery')}</button>
        </div>
        {guideOpen && <GqlQueryExplain text={query.text} language={language} />}
        {result !== null && <KnowledgeGraphResultPanel key={resultRequestId} data={result} definition={definition}
          evidence={resultEvidence} evidenceWarning={evidenceWarning} language={language} theme={theme} />}
      </section>
    </div>
  )
}
