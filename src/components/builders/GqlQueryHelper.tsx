import { useMemo } from 'react'
import { formatGqlMessage, type GqlVocabulary } from '../../lib/gqlAssist'
import {
  analyzeGql, explainGql, getGqlCompletions,
  type GqlCompletion, type GqlCompletionKind, type GqlDiagnostic, type GqlDiagnosticCode, type GqlExplainCode, type GqlPatternElement,
} from '../../lib/gqlSyntax'
import { translations, type Language, type TranslationKey } from '../../lib/translations'

const DIAGNOSTIC_KEYS: Record<GqlDiagnosticCode, TranslationKey> = {
  unterminatedString: 'kgGqlDiagUnterminatedString',
  unbalanced: 'kgGqlDiagUnbalanced',
  fullWidth: 'kgGqlDiagFullWidth',
  badOperator: 'kgGqlDiagBadOperator',
  missingMatch: 'kgGqlDiagMissingMatch',
  missingReturn: 'kgGqlDiagMissingReturn',
  unconstrained: 'kgGqlDiagUnconstrained',
  missingLimit: 'kgGqlDiagMissingLimit',
  unquotedLabel: 'kgGqlDiagUnquotedLabel',
  unknownNodeType: 'kgGqlDiagUnknownNodeType',
  unknownPredicate: 'kgGqlDiagUnknownPredicate',
}
const SEVERITIES: Array<{ severity: GqlDiagnostic['severity']; titleKey: TranslationKey }> = [
  { severity: 'error', titleKey: 'kgGqlSeverityError' },
  { severity: 'warning', titleKey: 'kgGqlSeverityWarning' },
  { severity: 'info', titleKey: 'kgGqlSeverityInfo' },
]
const EXPLAIN_KEYS: Record<GqlExplainCode, TranslationKey> = {
  matchNode: 'kgGqlExMatchNode',
  matchNodeAny: 'kgGqlExMatchNodeAny',
  matchEdge: 'kgGqlExMatchEdge',
  matchEdgeAny: 'kgGqlExMatchEdgeAny',
  matchFilter: 'kgGqlExMatchFilter',
  wherePredicate: 'kgGqlExWherePredicate',
  whereName: 'kgGqlExWhereName',
  whereCompare: 'kgGqlExWhereCompare',
  returnColumn: 'kgGqlExReturnColumn',
  returnColumnPlain: 'kgGqlExReturnColumnPlain',
  returnAggregate: 'kgGqlExReturnAggregate',
  returnDistinct: 'kgGqlExReturnDistinct',
  orderAsc: 'kgGqlExOrderAsc',
  orderDesc: 'kgGqlExOrderDesc',
  groupBy: 'kgGqlExGroupBy',
  limit: 'kgGqlExLimit',
  offset: 'kgGqlExOffset',
  other: 'kgGqlExOther',
}
const KIND_KEYS: Record<GqlCompletionKind, TranslationKey> = {
  keyword: 'kgGqlKindKeyword',
  nodeType: 'kgGqlKindNodeType',
  predicate: 'kgGqlKindPredicate',
  name: 'kgGqlKindName',
  property: 'kgGqlKindProperty',
  variable: 'kgGqlKindVariable',
  function: 'kgGqlKindFunction',
}

function elementLabel(element: GqlPatternElement): string {
  const named = `${element.variable}${element.label ? `:${element.label}` : ''}`
  return named || element.raw
}

function PatternDiagram({ pattern }: { pattern: GqlPatternElement[] }) {
  return <div className="kgGqlPattern" aria-hidden="true">
    {pattern.map((element, index) => element.kind === 'node'
      ? <span key={index} className="kgGqlPattern__node">{elementLabel(element) || '*'}</span>
      : <span key={index} className="kgGqlPattern__edge">
        {element.direction === 'in' && <i className="bi bi-arrow-left" />}
        {elementLabel(element) && <span className="kgGqlPattern__edgeLabel">{elementLabel(element)}</span>}
        {element.direction !== 'in' && <i className={`bi ${element.direction === 'out' ? 'bi-arrow-right' : 'bi-dash-lg'}`} />}
      </span>)}
  </div>
}

const translator = (language: Language) => (key: TranslationKey) => translations[language][key]

// 入力中の位置に応じた候補と、実行前の書き方のチェックを表示します。
export function GqlQueryCheck({ text, caret, vocabulary, language, onComplete }: {
  text: string
  caret: number
  vocabulary: GqlVocabulary
  language: Language
  onComplete: (from: number, to: number, insertText: string) => void
}) {
  const t = translator(language)
  const completions = useMemo(() => getGqlCompletions(text, caret, vocabulary), [text, caret, vocabulary])
  const diagnostics = useMemo(() => analyzeGql(text, vocabulary), [text, vocabulary])
  const diagnosticMessage = (diagnostic: GqlDiagnostic) => {
    const { suggestion, ...params } = diagnostic.params
    return formatGqlMessage(t(DIAGNOSTIC_KEYS[diagnostic.code]), {
      ...params,
      suggestion: suggestion ? formatGqlMessage(t('kgGqlDidYouMean'), { name: suggestion }) : '',
    }).trim()
  }
  const chip = (item: GqlCompletion, from: number, to: number) => <button type="button" key={`${item.kind}:${item.label}`}
    className={`kgGqlChip kgGqlChip--${item.kind}`} title={item.hintKey ? t(item.hintKey) : undefined}
    onMouseDown={(event) => event.preventDefault()} onClick={() => onComplete(from, to, item.insertText)}>
    {item.label}<span className="kgGqlChip__kind">{t(KIND_KEYS[item.kind])}{item.count !== undefined && ` · ${item.count.toLocaleString()}`}</span>
  </button>
  return <>
    {completions && <div className="kgGqlSuggest" role="group" aria-label={t('kgGqlCompletions')}>
      <span className="field__hint">{t('kgGqlCompletions')}:</span>
      <span className="kgGqlChips">{completions.items.map((item) => chip(item, completions.from, completions.to))}</span>
      <span className="field__hint">{t('kgGqlCompletionsHint')}</span>
    </div>}
    {text.trim() && <div className="kgGqlCheck" role="group" aria-label={t('kgGqlCheck')}>
      {diagnostics.length === 0
        ? <div className="notice notice--success" role="status">{t('kgGqlCheckOk')}</div>
        : SEVERITIES.map(({ severity, titleKey }) => {
          const group = diagnostics.filter((diagnostic) => diagnostic.severity === severity)
          return group.length > 0 && <div key={severity} className={`notice notice--${severity}`} role={severity === 'error' ? 'alert' : 'status'}>
            <div className="notice__title">{t(titleKey)}</div>
            <ul className="notice__list">{group.map((diagnostic, index) => <li key={`${diagnostic.code}:${index}`}>{diagnosticMessage(diagnostic)}</li>)}</ul>
          </div>
        })}
    </div>}
  </>
}

// 入力中のクエリを、節ごとの平易な説明とパターン図で表示します。
export function GqlQueryExplain({ text, language }: { text: string; language: Language }) {
  const t = translator(language)
  const explanation = useMemo(() => explainGql(text), [text])
  const explainItem = (code: GqlExplainCode, params: Record<string, string>) =>
    formatGqlMessage(t(EXPLAIN_KEYS[code]), { ...params, variable: params.variable || t('kgGqlUnnamed') })
  return <section className="kgGqlExplain" aria-label={t('kgGqlExplain')}>
    <h4 className="kgGqlLevel">{t('kgGqlExplain')}</h4>
    {!text.trim() && <p className="field__hint">{t('kgGqlExplainEmpty')}</p>}
    {explanation.leading && <p className="field__hint">{formatGqlMessage(t('kgGqlExplainLeading'), { text: explanation.leading })}</p>}
    {explanation.clauses.map((clause, index) => <div key={`${clause.keyword}:${index}`} className="kgGqlExplain__row">
      <span className="kgGqlToken kgGqlToken--keyword kgGqlExplain__keyword">{clause.keyword}</span>
      <div>
        {clause.keyword.endsWith('MATCH') && <p className="field__hint">{t('kgGqlExMatchIntro')}</p>}
        {clause.pattern.length > 0 && <PatternDiagram pattern={clause.pattern} />}
        <ul className="kgGqlExplain__items">
          {clause.items.map((item, itemIndex) => <li key={`${item.code}:${itemIndex}`}>{explainItem(item.code, item.params)}</li>)}
        </ul>
      </div>
    </div>)}
  </section>
}