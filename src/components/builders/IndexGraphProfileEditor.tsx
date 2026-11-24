/**
 * Index Builder editors for the 2026-11-01-preview graph features.
 *
 * - GraphProfileEditor: `graphProfile` (edge-list graph index, role to field mappings)
 * - TopicGraphEditor: `vectorSearch.topicGraphProfiles` and the field-level `topicGraphProfile` link
 *
 * The editors only transform the index definition through the helpers in
 * lib/indexGraphProfiles.ts, so every other property of the definition is preserved.
 */

import { useState } from 'react'

import {
  GRAPH_PROFILE_KINDS,
  GRAPH_ROLE_COUNT,
  GRAPH_ROLE_GROUPS,
  GRAPH_ROLE_SPECS,
  TOPIC_GRAPH_KINDS,
  TOPIC_GRAPH_LIMITS,
  addGraphProfile,
  addTopicGraphProfile,
  applyGraphIndexTemplate,
  collectVectorFieldLinks,
  enableRequiredGraphAttributes,
  getGraphRoleCandidates,
  getTopLevelFieldTypes,
  getTopicGraphProfiles,
  graphValueTypeToEdm,
  readGraphProfile,
  removeGraphProfile,
  removeTopicGraphProfile,
  setFieldTopicGraphProfile,
  setGraphProfileKind,
  setGraphProvenanceIndexName,
  setGraphRoleField,
  suggestGraphFieldMappings,
  updateTopicGraphProfile,
  validateGraphProfile,
  validateTopicGraphProfiles,
  type GraphIssue,
  type GraphIssueCode,
  type GraphRoleGroup,
} from '../../lib/indexGraphProfiles'
import type { Language, TranslationKey } from '../../lib/translations'
import { InfoTooltip } from '../InfoTooltip'

type JsonRecord = Record<string, unknown>

type GraphEditorProps = {
  index: JsonRecord
  language: Language
  t: (key: TranslationKey) => string
  onChangeIndex: (nextIndex: JsonRecord) => void
  /** Names of the indexes that exist on the service. */
  indexNames: string[]
  /** True when the selected API version cannot send the 2026-11-01-preview schema. */
  readOnly: boolean
}

const ISSUE_MESSAGE_KEYS: Record<GraphIssueCode, TranslationKey> = {
  graphProfileInvalid: 'indexGraphIssueGraphProfileInvalid',
  graphKindMissing: 'indexGraphIssueGraphKindMissing',
  graphKindUnsupported: 'indexGraphIssueGraphKindUnsupported',
  graphFieldsMissing: 'indexGraphIssueGraphFieldsMissing',
  graphRoleUnmapped: 'indexGraphIssueGraphRoleUnmapped',
  graphFieldNotFound: 'indexGraphIssueGraphFieldNotFound',
  graphTypeMismatch: 'indexGraphIssueGraphTypeMismatch',
  graphAttributesDisabled: 'indexGraphIssueGraphAttributesDisabled',
  graphAssertionNotKey: 'indexGraphIssueGraphAssertionNotKey',
  graphNotRetrievable: 'indexGraphIssueGraphNotRetrievable',
  graphNormalizer: 'indexGraphIssueGraphNormalizer',
  graphDuplicateField: 'indexGraphIssueGraphDuplicateField',
  graphProvenanceUnknown: 'indexGraphIssueGraphProvenanceUnknown',
  topicProfileInvalid: 'indexGraphIssueTopicProfileInvalid',
  topicNameMissing: 'indexGraphIssueTopicNameMissing',
  topicNameDuplicate: 'indexGraphIssueTopicNameDuplicate',
  topicIndexMissing: 'indexGraphIssueTopicIndexMissing',
  topicIndexUnknown: 'indexGraphIssueTopicIndexUnknown',
  topicKindMissing: 'indexGraphIssueTopicKindMissing',
  topicKindInvalid: 'indexGraphIssueTopicKindInvalid',
  topicDiversityNotAllowed: 'indexGraphIssueTopicDiversityNotAllowed',
  topicDiversityRange: 'indexGraphIssueTopicDiversityRange',
  topicPoolNotAllowed: 'indexGraphIssueTopicPoolNotAllowed',
  topicPoolRange: 'indexGraphIssueTopicPoolRange',
  topicFieldNotVector: 'indexGraphIssueTopicFieldNotVector',
  topicFieldUnknownProfile: 'indexGraphIssueTopicFieldUnknownProfile',
  topicProfileUnused: 'indexGraphIssueTopicProfileUnused',
  topicProfileShared: 'indexGraphIssueTopicProfileShared',
  topicNoVectorizer: 'indexGraphIssueTopicNoVectorizer',
}

const GROUP_LABEL_KEYS: Record<GraphRoleGroup, TranslationKey> = {
  identity: 'indexBuilderGraphGroupIdentity',
  subject: 'indexBuilderGraphGroupSubject',
  predicate: 'indexBuilderGraphGroupPredicate',
  object: 'indexBuilderGraphGroupObject',
  confidence: 'indexBuilderGraphGroupConfidence',
  provenance: 'indexBuilderGraphGroupProvenance',
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function fillMessage(template: string, params: Record<string, string | number>): string {
  let text = template
  for (const [key, value] of Object.entries(params)) text = text.replaceAll(`{${key}}`, String(value))
  return text
}

function formatIssue(issue: GraphIssue, t: (key: TranslationKey) => string): string {
  return fillMessage(t(ISSUE_MESSAGE_KEYS[issue.code]), issue.params)
}

function RequiredMark({ language }: { language: Language }) {
  return <span className="ipbRequiredMark" title={language === 'ja' ? '必須' : 'Required'}>*</span>
}

function NovemberSchemaNotice({ t }: { t: (key: TranslationKey) => string }) {
  return <div className="notice notice--info" role="status">{t('indexBuilderNovemberSchemaRequired')}</div>
}

function IssueList({ issues, t }: { issues: GraphIssue[]; t: (key: TranslationKey) => string }) {
  return (
    <div className="indexSchemaImpactList" role="list">
      {issues.length === 0 ? (
        <div className="indexSchemaImpactItem indexSchemaImpactItem--safe" role="listitem">
          <i className="bi bi-check2-circle"></i>
          <span>{t('indexBuilderGraphChecksOk')}</span>
        </div>
      ) : issues.map((issue, position) => (
        <div
          key={`${issue.code}-${position}`}
          className={`indexSchemaImpactItem indexSchemaImpactItem--${issue.severity === 'error' ? 'rebuild' : 'review'}`}
          role="listitem"
        >
          <i className={`bi ${issue.severity === 'error' ? 'bi-exclamation-octagon' : 'bi-search'}`}></i>
          <span>{formatIssue(issue, t)}</span>
        </div>
      ))}
    </div>
  )
}

/** Text input that applies its value on blur or Enter, so that renames can update dependent references in one step. */
function CommitTextInput({ value, onCommit, disabled, ariaLabel }: {
  value: string
  onCommit: (value: string) => void
  disabled: boolean
  ariaLabel: string
}) {
  const [draft, setDraft] = useState({ source: value, text: value })
  if (draft.source !== value) setDraft({ source: value, text: value })

  const commit = () => {
    if (draft.text !== value) onCommit(draft.text)
  }

  return (
    <input
      className="field__input"
      value={draft.text}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => setDraft({ source: value, text: event.currentTarget.value })}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit()
      }}
    />
  )
}

export function GraphProfileEditor({ index, language, t, onChangeIndex, indexNames, readOnly }: GraphEditorProps) {
  const state = readGraphProfile(index)
  const ownIndexName = asString(index.name)
  const relatedIndexNames = indexNames.filter((name) => name !== ownIndexName)
  const issues = validateGraphProfile(index, { indexNames: relatedIndexNames })
  const fieldTypes = getTopLevelFieldTypes(index)
  const mappedCount = Object.keys(state.mappings).length
  const kindOptions: string[] = [...GRAPH_PROFILE_KINDS]
  if (state.kind && !kindOptions.includes(state.kind)) kindOptions.push(state.kind)

  return (
    <section className="indexSchemaConfigEditor__section">
      {readOnly ? <NovemberSchemaNotice t={t} /> : null}
      <div className="indexSchemaConfigEditor__guide">
        <div className="indexSchemaConfigEditor__subHeader">
          <span>
            {t('indexBuilderGraphProfileTitle')}
            <InfoTooltip tooltipKey="indexGraphProfile" language={language} />
          </span>
          {state.present ? (
            <span className="indexSchemaBadge indexSchemaBadge--configured">
              {fillMessage(t('indexBuilderGraphMappedCount'), { count: mappedCount, total: GRAPH_ROLE_COUNT })}
            </span>
          ) : null}
        </div>
        <div className="indexSchemaWorkbench__hint">{t('indexBuilderGraphProfileHint')}</div>
        <div className="indexSchemaConfigEditor__toolbar">
          {!state.present ? (
            <button type="button" className="btn btn--sm" disabled={readOnly} onClick={() => onChangeIndex(addGraphProfile(index))}>
              <i className="bi bi-plus-lg icon--mr6"></i>
              {t('indexBuilderGraphProfileAdd')}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--sm"
              disabled={readOnly}
              title={t('indexBuilderGraphAutoMapTitle')}
              onClick={() => onChangeIndex(suggestGraphFieldMappings(index))}
            >
              <i className="bi bi-magic icon--mr6"></i>
              {t('indexBuilderGraphAutoMap')}
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm"
            disabled={readOnly}
            title={t('indexBuilderGraphApplyTemplateTitle')}
            onClick={() => onChangeIndex(applyGraphIndexTemplate(index))}
          >
            <i className="bi bi-table icon--mr6"></i>
            {t('indexBuilderGraphApplyTemplate')}
          </button>
          {state.present ? (
            <>
              <button
                type="button"
                className="btn btn--sm"
                disabled={readOnly || mappedCount === 0}
                title={t('indexBuilderGraphEnableAttributesTitle')}
                onClick={() => onChangeIndex(enableRequiredGraphAttributes(index))}
              >
                <i className="bi bi-toggle-on icon--mr6"></i>
                {t('indexBuilderGraphEnableAttributes')}
              </button>
              <button type="button" className="btn btn--sm" disabled={readOnly} onClick={() => onChangeIndex(removeGraphProfile(index))}>
                <i className="bi bi-trash icon--mr6"></i>
                {t('indexBuilderGraphProfileRemove')}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {!state.present ? <div className="empty indexSchemaConfigEditor__empty">{t('indexBuilderGraphProfileNotSet')}</div> : (
        <>
          <div className="indexSchemaConfigEditor__card">
            <div className="indexSchemaConfigEditor__grid">
              <label className="field">
                <span className="field__label">
                  <span>kind</span>
                  <RequiredMark language={language} />
                  <InfoTooltip tooltipKey="indexGraphProfileKind" language={language} />
                </span>
                <select
                  className="field__input"
                  value={state.kind}
                  disabled={readOnly}
                  onChange={(event) => onChangeIndex(setGraphProfileKind(index, event.currentTarget.value))}
                >
                  {state.kind ? null : <option value="">{t('indexBuilderGraphNotSet')}</option>}
                  {kindOptions.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field__label">
                  <span>provenanceIndexName</span>
                  <InfoTooltip tooltipKey="indexGraphProvenanceIndexName" language={language} />
                </span>
                <input
                  className="field__input"
                  list="indexBuilderGraphProvenanceIndexes"
                  value={state.provenanceIndexName}
                  disabled={readOnly}
                  placeholder={t('indexBuilderGraphNotSet')}
                  onChange={(event) => onChangeIndex(setGraphProvenanceIndexName(index, event.currentTarget.value))}
                />
                <datalist id="indexBuilderGraphProvenanceIndexes">
                  {relatedIndexNames.map((name) => <option key={name} value={name} />)}
                </datalist>
              </label>
            </div>
          </div>

          <div className="indexSchemaConfigEditor__card">
            <div className="indexSchemaConfigEditor__subHeader">
              <span>{t('indexBuilderGraphMappings')}</span>
            </div>
            {GRAPH_ROLE_GROUPS.map((group) => (
              <div key={group} className="indexSchemaConfigEditor__nestedCard">
                <div className="indexSchemaConfigEditor__subHeader indexSchemaConfigEditor__subHeader--top">
                  <span>{t(GROUP_LABEL_KEYS[group])}</span>
                </div>
                <div className="indexSchemaConfigEditor__grid">
                  {GRAPH_ROLE_SPECS.filter((spec) => spec.group === group).map((spec) => {
                    const mapped = state.mappings[spec.role] ?? ''
                    const candidates = getGraphRoleCandidates(index, spec)
                    const mappedType = fieldTypes.get(mapped)
                    const requirement = [graphValueTypeToEdm(spec.valueType), spec.key ? 'key' : '', ...spec.attributes].filter(Boolean).join(' / ')
                    return (
                      <label key={spec.role} className="field">
                        <span className="field__label">
                          <span>{spec.role}</span>
                          <RequiredMark language={language} />
                          <span className="infoTooltip" title={spec.description[language]}>ⓘ</span>
                        </span>
                        <select
                          className="field__input"
                          value={mapped}
                          disabled={readOnly}
                          onChange={(event) => onChangeIndex(setGraphRoleField(index, spec.role, event.currentTarget.value))}
                        >
                          <option value="">{t('indexBuilderGraphUnassigned')}</option>
                          {candidates.map((name) => <option key={name} value={name}>{name}</option>)}
                          {mapped && !candidates.includes(mapped) ? (
                            <option value={mapped}>
                              {mappedType === undefined
                                ? fillMessage(t('indexBuilderGraphFieldMissingOption'), { name: mapped })
                                : `${mapped} (${mappedType || '-'})`}
                            </option>
                          ) : null}
                        </select>
                        <span className="field__hint">{requirement}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          <div className="indexSchemaConfigEditor__card">
            <div className="indexSchemaConfigEditor__subHeader">
              <span>{t('indexBuilderGraphChecks')}</span>
            </div>
            <IssueList issues={issues} t={t} />
          </div>
        </>
      )}
    </section>
  )
}

export function TopicGraphEditor({ index, language, t, onChangeIndex, indexNames, readOnly }: GraphEditorProps) {
  const ownIndexName = asString(index.name)
  const topicIndexNames = indexNames.filter((name) => name !== ownIndexName)
  const profiles = getTopicGraphProfiles(index)
  const profileNames = profiles.map((profile) => asString(profile.name)).filter(Boolean)
  const links = collectVectorFieldLinks(index)
  const issues = validateTopicGraphProfiles(index, { indexNames: topicIndexNames })
  const firstUnlinkedField = links.find((link) => !link.topicGraphProfile)

  return (
    <section className="indexSchemaConfigEditor__section">
      {readOnly ? <NovemberSchemaNotice t={t} /> : null}
      <div className="indexSchemaWorkbench__hint">{t('indexBuilderTopicGraphHint')}</div>

      <div className="indexSchemaConfigEditor__card">
        <div className="indexSchemaConfigEditor__subHeader">
          <span>{t('indexBuilderTopicGraphProfiles')}</span>
          <button
            type="button"
            className="btn btn--mini"
            disabled={readOnly}
            onClick={() => onChangeIndex(addTopicGraphProfile(index, firstUnlinkedField?.pathParts))}
          >
            <i className="bi bi-plus-lg icon--mr6"></i>
            {t('indexBuilderTopicGraphAdd')}
          </button>
        </div>
        {profiles.length === 0 ? <div className="empty indexSchemaConfigEditor__empty">{t('indexBuilderTopicGraphNone')}</div> : null}
        <div className="indexSchemaConfigEditor__nestedCards">
          {profiles.map((profile, profileIndex) => {
            const kind = asString(profile.defaultKind)
            const factor = typeof profile.defaultDiversityFactor === 'number' ? String(profile.defaultDiversityFactor) : ''
            const poolSize = typeof profile.defaultMinDiversityPoolSize === 'number' ? String(profile.defaultMinDiversityPoolSize) : ''
            const kindOptions: string[] = [...TOPIC_GRAPH_KINDS]
            if (kind && !kindOptions.includes(kind)) kindOptions.push(kind)
            return (
              <div key={`topic-graph-profile-${profileIndex}`} className="indexSchemaConfigEditor__nestedCard">
                <div className="indexSchemaConfigEditor__grid indexSchemaConfigEditor__grid--compact">
                  <label className="field">
                    <span className="field__label">
                      <span>name</span>
                      <RequiredMark language={language} />
                      <InfoTooltip tooltipKey="indexTopicGraphProfileName" language={language} />
                    </span>
                    <CommitTextInput
                      value={asString(profile.name)}
                      disabled={readOnly}
                      ariaLabel="name"
                      onCommit={(value) => onChangeIndex(updateTopicGraphProfile(index, profileIndex, { name: value }))}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">
                      <span>indexName</span>
                      <RequiredMark language={language} />
                      <InfoTooltip tooltipKey="indexTopicGraphIndexName" language={language} />
                    </span>
                    <input
                      className="field__input"
                      list="indexBuilderTopicGraphIndexes"
                      value={asString(profile.indexName)}
                      disabled={readOnly}
                      onChange={(event) => onChangeIndex(updateTopicGraphProfile(index, profileIndex, { indexName: event.currentTarget.value }))}
                    />
                  </label>
                  <label className="field">
                    <span className="field__label">
                      <span>defaultKind</span>
                      <RequiredMark language={language} />
                      <InfoTooltip tooltipKey="indexTopicGraphDefaultKind" language={language} />
                    </span>
                    <select
                      className="field__input"
                      value={kind}
                      disabled={readOnly}
                      onChange={(event) => onChangeIndex(updateTopicGraphProfile(index, profileIndex, { defaultKind: event.currentTarget.value }))}
                    >
                      {kind ? null : <option value="">{t('indexBuilderGraphNotSet')}</option>}
                      {kindOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  </label>
                  {kind === 'diverse' ? (
                    <label className="field">
                      <span className="field__label">
                        <span>defaultDiversityFactor</span>
                        <InfoTooltip tooltipKey="indexTopicGraphDefaultDiversityFactor" language={language} />
                      </span>
                      <input
                        className="field__input"
                        type="number"
                        min={TOPIC_GRAPH_LIMITS.diversityFactor.min}
                        max={TOPIC_GRAPH_LIMITS.diversityFactor.max}
                        step="any"
                        value={factor}
                        disabled={readOnly}
                        placeholder={String(TOPIC_GRAPH_LIMITS.diversityFactor.defaultValue)}
                        onChange={(event) => {
                          const text = event.currentTarget.value
                          onChangeIndex(updateTopicGraphProfile(index, profileIndex, { defaultDiversityFactor: text === '' ? undefined : Number(text) }))
                        }}
                      />
                    </label>
                  ) : null}
                  {kind === 'diverse' || kind === 'balanced' ? (
                    <label className="field">
                      <span className="field__label">
                        <span>defaultMinDiversityPoolSize</span>
                        <InfoTooltip tooltipKey="indexTopicGraphDefaultMinDiversityPoolSize" language={language} />
                      </span>
                      <input
                        className="field__input"
                        type="number"
                        min={TOPIC_GRAPH_LIMITS.minDiversityPoolSize.min}
                        max={TOPIC_GRAPH_LIMITS.minDiversityPoolSize.max}
                        step={1}
                        value={poolSize}
                        disabled={readOnly}
                        placeholder={String(TOPIC_GRAPH_LIMITS.minDiversityPoolSize.defaultValue)}
                        onChange={(event) => {
                          const text = event.currentTarget.value
                          onChangeIndex(updateTopicGraphProfile(index, profileIndex, { defaultMinDiversityPoolSize: text === '' ? undefined : Number(text) }))
                        }}
                      />
                    </label>
                  ) : null}
                </div>
                <button type="button" className="btn btn--mini" disabled={readOnly} onClick={() => onChangeIndex(removeTopicGraphProfile(index, profileIndex))}>
                  <i className="bi bi-trash icon--mr6"></i>
                  {t('indexBuilderRemoveItem')}
                </button>
              </div>
            )
          })}
        </div>
        <datalist id="indexBuilderTopicGraphIndexes">
          {topicIndexNames.map((name) => <option key={name} value={name} />)}
        </datalist>
      </div>

      <div className="indexSchemaConfigEditor__card">
        <div className="indexSchemaConfigEditor__subHeader">
          <span>
            {t('indexBuilderTopicGraphFieldLinks')}
            <InfoTooltip tooltipKey="indexFieldTopicGraphProfile" language={language} />
          </span>
        </div>
        {links.length === 0 ? <div className="empty indexSchemaConfigEditor__empty">{t('indexBuilderTopicGraphNoVectorFields')}</div> : null}
        <div className="indexSchemaConfigEditor__grid">
          {links.map((link) => (
            <label key={link.path} className="field">
              <span className="field__label">
                <span>{t('indexBuilderTopicGraphColumnField')}: {link.path}</span>
              </span>
              <select
                className="field__input"
                value={link.topicGraphProfile}
                disabled={readOnly}
                onChange={(event) => onChangeIndex(setFieldTopicGraphProfile(index, link.pathParts, event.currentTarget.value))}
              >
                <option value="">{t('indexBuilderTopicGraphNoLink')}</option>
                {profileNames.map((name) => <option key={name} value={name}>{name}</option>)}
                {link.topicGraphProfile && !profileNames.includes(link.topicGraphProfile) ? (
                  <option value={link.topicGraphProfile}>{fillMessage(t('indexBuilderTopicGraphUnknownOption'), { name: link.topicGraphProfile })}</option>
                ) : null}
              </select>
              <span className="field__hint">
                {[link.type, link.dimensions ? `${link.dimensions} dims` : '', link.vectorSearchProfile].filter(Boolean).join(' / ')}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="indexSchemaConfigEditor__card">
        <div className="indexSchemaConfigEditor__subHeader">
          <span>{t('indexBuilderGraphChecks')}</span>
        </div>
        <IssueList issues={issues} t={t} />
      </div>
    </section>
  )
}
