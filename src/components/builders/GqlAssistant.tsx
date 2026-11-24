import { useId, useMemo, useState } from 'react'
import {
  buildGqlFromBuilder, buildGqlTemplates, formatGqlMessage, gqlFromNameQuery, gqlTypedRelationQuery, isSafeGqlEntityName,
  isSafeGqlPattern, GQL_BUILDER_MAX_LIMIT, type GqlTemplate, type GqlTemplateLevel, type GqlVocabulary,
} from '../../lib/gqlAssist'
import type { GraphProvenanceKind } from '../../lib/knowledgeGraph'
import { translations, type Language, type TranslationKey } from '../../lib/translations'

export type GqlApplyRequest = { gql: string; title: string; provenance?: GraphProvenanceKind; run: boolean }

type Tab = 'templates' | 'builder' | 'map' | 'syntax'

const TABS: Array<{ id: Tab; labelKey: TranslationKey; icon: string }> = [
  { id: 'templates', labelKey: 'kgGqlTabTemplates', icon: 'bi-collection' },
  { id: 'builder', labelKey: 'kgGqlTabBuilder', icon: 'bi-ui-checks-grid' },
  { id: 'map', labelKey: 'kgGqlTabMap', icon: 'bi-compass' },
  { id: 'syntax', labelKey: 'kgGqlTabSyntax', icon: 'bi-book' },
]
const LEVEL_KEYS: Record<GqlTemplateLevel, TranslationKey> = {
  1: 'kgGqlLevel1',
  2: 'kgGqlLevel2',
  3: 'kgGqlLevel3',
  4: 'kgGqlLevel4',
}
const CLAUSE_GUIDE: Array<{ keyword: string; descriptionKey: TranslationKey; example: string }> = [
  { keyword: 'MATCH', descriptionKey: 'kgGqlClauseMatch', example: 'MATCH (a:Person)-[r]->(b)' },
  { keyword: 'WHERE', descriptionKey: 'kgGqlClauseWhere', example: "WHERE r.predicate = 'worksFor'" },
  { keyword: 'RETURN', descriptionKey: 'kgGqlClauseReturn', example: 'RETURN a.name AS person, b.name AS target' },
  { keyword: 'ORDER BY', descriptionKey: 'kgGqlClauseOrderBy', example: 'ORDER BY person DESC' },
  { keyword: 'GROUP BY', descriptionKey: 'kgGqlClauseGroupBy', example: 'RETURN b.name AS target, count(*) AS total GROUP BY b.name' },
  { keyword: 'LIMIT', descriptionKey: 'kgGqlClauseLimit', example: 'LIMIT 10' },
]
const PITFALL_KEYS: TranslationKey[] = [
  'kgGqlPitfallQuote', 'kgGqlPitfallEquals', 'kgGqlPitfallLabel', 'kgGqlPitfallBacktick', 'kgGqlPitfallScope', 'kgGqlPitfallEmpty',
]
// 構文の解説用に色分けして表示する、固定のサンプルクエリです。
const ANATOMY: Array<{ role: 'keyword' | 'node' | 'edge' | 'string' | 'plain'; text: string }> = [
  { role: 'keyword', text: 'MATCH' }, { role: 'plain', text: ' ' },
  { role: 'node', text: '(a:Person)' }, { role: 'edge', text: '-[r]->' }, { role: 'node', text: '(b:Organization)' },
  { role: 'plain', text: '\n' }, { role: 'keyword', text: 'WHERE' }, { role: 'plain', text: " r.predicate = " }, { role: 'string', text: "'worksFor'" },
  { role: 'plain', text: '\n' }, { role: 'keyword', text: 'RETURN' }, { role: 'plain', text: ' a.name ' }, { role: 'keyword', text: 'AS' },
  { role: 'plain', text: ' person, b.name ' }, { role: 'keyword', text: 'AS' }, { role: 'plain', text: ' organization\n' },
  { role: 'keyword', text: 'LIMIT' }, { role: 'plain', text: ' 10' },
]
const LEGEND: Array<{ role: 'keyword' | 'node' | 'edge' | 'string'; key: TranslationKey }> = [
  { role: 'keyword', key: 'kgGqlLegendKeyword' }, { role: 'node', key: 'kgGqlLegendNode' },
  { role: 'edge', key: 'kgGqlLegendEdge' }, { role: 'string', key: 'kgGqlLegendString' },
]
const MAX_DATALIST_ENTRIES = 30

type Translate = (key: TranslationKey) => string

function TemplateCard({ template, t, canRun, onApply }: {
  template: GqlTemplate
  t: Translate
  canRun: boolean
  onApply: (request: GqlApplyRequest) => void
}) {
  const title = t(template.titleKey)
  const apply = (run: boolean) => onApply({ gql: template.gql, title, provenance: template.provenance, run })
  return <article className="kgGqlCard">
    <span className="kgGqlCard__level">{t(LEVEL_KEYS[template.level])}</span>
    <div className="kgGqlCard__head">
      <h5 className="kgGqlCard__title">{title}</h5>
      <span className={`kgBadge${template.sample ? ' kgBadge--sample' : ''}`}>{t(template.sample ? 'kgGqlSampleBadge' : 'kgGqlGeneratedBadge')}</span>
    </div>
    <p>{t(template.descriptionKey)}</p>
    <pre className="kgGqlCode" aria-label={title}>{template.gql}</pre>
    {template.provenance && <span className="field__hint">{formatGqlMessage(t('kgGqlProvenanceNote'), { kind: template.provenance })}</span>}
    <div className="kgGqlCard__actions">
      <button type="button" className="btn btn--secondary btn--sm" onClick={() => apply(false)}>
        <i className="bi bi-box-arrow-in-down icon--mr6" aria-hidden="true" />{t('kgGqlInsert')}
      </button>
      <button type="button" className="btn btn--primary btn--sm" disabled={!canRun} onClick={() => apply(true)}>
        <i className="bi bi-play-fill icon--mr6" aria-hidden="true" />{t('kgGqlInsertRun')}
      </button>
    </div>
  </article>
}

function TemplatesTab({ vocabulary, t, canRun, onApply }: {
  vocabulary: GqlVocabulary
  t: Translate
  canRun: boolean
  onApply: (request: GqlApplyRequest) => void
}) {
  const templates = useMemo(() => buildGqlTemplates(vocabulary), [vocabulary])
  const general = templates.filter((template) => template.group === 'general')
  const topic = templates.filter((template) => template.group === 'topic')
  const card = (template: GqlTemplate) => <TemplateCard key={template.id} template={template} t={t} canRun={canRun} onApply={onApply} />
  return <>
    <p className="field__hint">{t('kgGqlTemplatesHint')}</p>
    {!vocabulary.loaded && <p className="field__hint">{t('kgGqlTemplatesSampleHint')}</p>}
    <div className="kgGqlCards">{general.map(card)}</div>
    {topic.length > 0 && <section>
      <h4 className="kgGqlLevel">{t('kgGqlTopicGroup')}</h4>
      <p className="field__hint">{t('kgGqlTopicGroupHint')}</p>
      <div className="kgGqlCards">{topic.map(card)}</div>
    </section>}
  </>
}

function BuilderTab({ vocabulary, t, canRun, onApply }: {
  vocabulary: GqlVocabulary
  t: Translate
  canRun: boolean
  onApply: (request: GqlApplyRequest) => void
}) {
  const id = useId()
  const [startType, setStartType] = useState('')
  const [predicate, setPredicate] = useState('')
  const [endType, setEndType] = useState('')
  const [startName, setStartName] = useState('')
  const [endName, setEndName] = useState('')
  const [includeIds, setIncludeIds] = useState(false)
  const [orderByName, setOrderByName] = useState(true)
  const [limit, setLimit] = useState('25')
  const built = buildGqlFromBuilder({ startType, predicate, endType, startName, endName, includeIds, orderByName, limit: Number(limit) })
  const title = t('kgGqlTabBuilder')
  const names = vocabulary.entities.slice(0, MAX_DATALIST_ENTRIES)
  const text = (key: TranslationKey, value: string, onChange: (value: string) => void, list: string) =>
    <label className="field"><span className="field__label">{t(key)}</span>
      <input className="field__input" list={`${id}-${list}`} value={value} placeholder={t('kgGqlBuilderAny')} onChange={(event) => onChange(event.target.value)} />
    </label>
  return <>
    <p className="field__hint">{t('kgGqlBuilderHint')}</p>
    <div className="form kgGqlBuilderForm">
      {text('kgGqlBuilderStartType', startType, setStartType, 'types')}
      {text('kgGqlBuilderPredicate', predicate, setPredicate, 'predicates')}
      {text('kgGqlBuilderEndType', endType, setEndType, 'types')}
      {text('kgGqlBuilderStartName', startName, setStartName, 'names')}
      {text('kgGqlBuilderEndName', endName, setEndName, 'names')}
      <label className="field"><span className="field__label">{t('kgGqlBuilderLimit')}</span>
        <input className="field__input" type="number" min={1} max={GQL_BUILDER_MAX_LIMIT} value={limit} onChange={(event) => setLimit(event.target.value)} />
      </label>
    </div>
    <datalist id={`${id}-types`}>{vocabulary.nodeTypes.map((item) => <option key={item.name} value={item.name} />)}</datalist>
    <datalist id={`${id}-predicates`}>{vocabulary.predicates.map((item) => <option key={item.name} value={item.name} />)}</datalist>
    <datalist id={`${id}-names`}>{names.map((item) => <option key={`${item.type}:${item.name}`} value={item.name} />)}</datalist>
    <div className="kgGqlOptions">
      <label className="kgGqlOptions__item"><input type="checkbox" checked={includeIds} onChange={(event) => setIncludeIds(event.target.checked)} /> {t('kgGqlBuilderIncludeIds')}</label>
      <label className="kgGqlOptions__item"><input type="checkbox" checked={orderByName} onChange={(event) => setOrderByName(event.target.checked)} /> {t('kgGqlBuilderOrder')}</label>
    </div>
    <h4 className="kgGqlLevel">{t('kgGqlBuilderPreview')}</h4>
    {built.ok
      ? <>
        <pre className="kgGqlCode" aria-label={t('kgGqlBuilderPreview')}>{built.gql}</pre>
        {!built.constrained && <div className="notice notice--warning" role="status">{t('kgGqlBuilderUnconstrained')}</div>}
      </>
      : <div className="notice notice--error" role="alert">{t(built.error === 'limit' ? 'kgGqlBuilderLimitError' : 'kgGqlBuilderUnsafe')}</div>}
    <div className="actions">
      <button type="button" className="btn btn--secondary btn--sm" disabled={!built.ok}
        onClick={() => built.ok && onApply({ gql: built.gql, title, run: false })}>
        <i className="bi bi-box-arrow-in-down icon--mr6" aria-hidden="true" />{t('kgGqlInsert')}
      </button>
      <button type="button" className="btn btn--primary btn--sm" disabled={!built.ok || !canRun}
        onClick={() => built.ok && onApply({ gql: built.gql, title, run: true })}>
        <i className="bi bi-play-fill icon--mr6" aria-hidden="true" />{t('kgGqlInsertRun')}
      </button>
    </div>
  </>
}

function MapTab({ vocabulary, t, onApply }: { vocabulary: GqlVocabulary; t: Translate; onApply: (request: GqlApplyRequest) => void }) {
  if (!vocabulary.loaded) return <p className="field__hint">{t('kgGqlMapEmpty')}</p>
  const count = (value: number) => formatGqlMessage(t('kgGqlMapCount'), { count: value.toLocaleString() })
  return <>
    <p className="field__hint">{t('kgGqlMapHint')}</p>
    <p className="field__hint">{t('kgGqlMapScope')}</p>
    <h4 className="kgGqlLevel">{t('kgGqlMapPatterns')}</h4>
    <div className="kgList">
      {vocabulary.patterns.map((pattern) => {
        const title = `${pattern.subjectType} ${pattern.predicate} ${pattern.objectType}`
        return <button type="button" key={title} className="kgListItem" disabled={!isSafeGqlPattern(pattern)}
          onClick={() => onApply({ gql: gqlTypedRelationQuery(pattern), title, run: false })}>
          <span>{pattern.subjectType}</span>
          <span className="kgListItem__relation">{pattern.predicate} <i className="bi bi-arrow-right" aria-hidden="true" /></span>
          <span>{pattern.objectType}</span>
          <span className="kgCount">{count(pattern.count)}</span>
        </button>
      })}
    </div>
    <h4 className="kgGqlLevel">{t('kgGqlMapEntities')}</h4>
    <p className="field__hint">{t('kgGqlMapEntitiesHint')}</p>
    <div className="kgList">
      {vocabulary.entities.map((entity) => <button type="button" key={`${entity.type}:${entity.name}`} className="kgListItem"
        disabled={!isSafeGqlEntityName(entity.name)}
        onClick={() => onApply({ gql: gqlFromNameQuery(entity.name), title: entity.name, run: false })}>
        <span>{entity.name}</span>
        <span className="kgListItem__relation">{entity.type}</span>
        <span className="kgCount">{count(entity.degree)}</span>
      </button>)}
    </div>
    <h4 className="kgGqlLevel">{t('kgGqlMapTypes')}</h4>
    <div className="kgGqlChips">{vocabulary.nodeTypes.map((item) => <span key={item.name} className="kgBadge">{item.name} · {count(item.count)}</span>)}</div>
    <h4 className="kgGqlLevel">{t('kgGqlMapPredicates')}</h4>
    <div className="kgGqlChips">{vocabulary.predicates.map((item) => <span key={item.name} className="kgBadge">{item.name} · {count(item.count)}</span>)}</div>
  </>
}

function SyntaxTab({ t }: { t: Translate }) {
  return <>
    <h4 className="kgGqlLevel">{t('kgGqlSyntaxAnatomy')}</h4>
    <p className="field__hint">{t('kgGqlSyntaxAnatomyHint')}</p>
    <pre className="kgGqlCode" aria-label={t('kgGqlSyntaxAnatomy')}>
      {ANATOMY.map((part, index) => <span key={index} className={`kgGqlToken kgGqlToken--${part.role}`}>{part.text}</span>)}
    </pre>
    <ul className="kgGqlLegend">
      {LEGEND.map(({ role, key }) => <li key={role}><span className={`kgGqlToken kgGqlToken--${role} kgGqlLegend__swatch`} aria-hidden="true">■</span> {t(key)}</li>)}
    </ul>
    <h4 className="kgGqlLevel">{t('kgGqlSyntaxClauses')}</h4>
    <div className="kgGqlClauseGuide">
      {CLAUSE_GUIDE.map((clause) => <div key={clause.keyword} className="kgGqlClauseGuide__row">
        <span className="kgGqlToken kgGqlToken--keyword kgGqlClauseGuide__keyword">{clause.keyword}</span>
        <div><span className="field__hint">{t(clause.descriptionKey)}</span><code className="kgGqlClauseGuide__example">{clause.example}</code></div>
      </div>)}
    </div>
    <h4 className="kgGqlLevel">{t('kgGqlSyntaxPitfalls')}</h4>
    <ul className="kgGqlPitfalls">{PITFALL_KEYS.map((key) => <li key={key}>{t(key)}</li>)}</ul>
    <p className="field__hint">{t('kgGqlSyntaxSource')}</p>
    <p className="field__hint">
      <a href="https://learn.microsoft.com/azure/search/agentic-knowledge-source-how-to-entity-graph#query-the-graph-directly-with-gql" target="_blank" rel="noreferrer">
        <i className="bi bi-box-arrow-up-right" /> Azure AI Search
      </a>
      {' · '}
      <a href="https://learn.microsoft.com/fabric/graph/gql-language-guide" target="_blank" rel="noreferrer">
        <i className="bi bi-box-arrow-up-right" /> {t('kgGqlSyntaxGeneralGuide')}
      </a>
    </p>
  </>
}

export function GqlAssistant({ language, vocabulary, canRun, onApply }: {
  language: Language
  vocabulary: GqlVocabulary
  canRun: boolean
  onApply: (request: GqlApplyRequest) => void
}) {
  const t: Translate = (key) => translations[language][key]
  const id = useId()
  const [tab, setTab] = useState<Tab>('templates')
  return <div className="kgGqlAssistant">
    <div className="tabs kgGqlTabs" role="tablist" aria-label={t('kgGqlTabs')}>
      {TABS.map((item) => <button key={item.id} type="button" role="tab" id={`${id}-tab-${item.id}`} aria-selected={tab === item.id}
        aria-controls={`${id}-panel`} className={`btn btn--tab${tab === item.id ? ' btn--active' : ''}`} onClick={() => setTab(item.id)}>
        <i className={`bi ${item.icon} icon--mr6`} aria-hidden="true" />{t(item.labelKey)}
      </button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`}>
      {tab === 'templates' && <TemplatesTab vocabulary={vocabulary} t={t} canRun={canRun} onApply={onApply} />}
      {tab === 'builder' && <BuilderTab vocabulary={vocabulary} t={t} canRun={canRun} onApply={onApply} />}
      {tab === 'map' && <MapTab vocabulary={vocabulary} t={t} onApply={onApply} />}
      {tab === 'syntax' && <SyntaxTab t={t} />}
    </div>
  </div>
}
