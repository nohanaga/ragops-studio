import { useEffect, useId, useMemo, useState, type Dispatch, type SetStateAction } from 'react'

import { isJsonObject } from '../../app/json'
import { autocompleteDocuments, suggestDocuments, type JsonValue } from '../../lib/aiSearchRest'
import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import { translations, type Language } from '../../lib/translations'
import type { AutocompleteFormState, SuggestFormState } from '../../types'
import { buildAutocompleteBodyFromForm, buildSuggestBodyFromForm } from '../../utils/appRequestBodies'
import { InfoTooltip } from '../InfoTooltip'
import { JsonViewer } from '../viewers/JsonViewer'

type TranslationKey = keyof typeof translations.ja

type LiveResult =
  | { status: 'idle'; message: string }
  | { status: 'pending'; message: string }
  | { status: 'success'; requestId: string; elapsedMs: number; serviceElapsedMs?: number; url: string; response: JsonValue }
  | { status: 'error'; message: string; requestId?: string; statusCode?: number; response?: JsonValue; responseText?: string }

type CommonProps = {
  t: (key: TranslationKey) => string
  language: Language
  activeProfile: ConnectionProfile | null
  indexName: string
  apiVersion: SearchApiVersion
  suggesterNameOptions: string[]
  searchableFieldNames: string[]
}

export type TypeaheadBuilderFormProps = CommonProps & (
  | {
      mode: 'autocomplete'
      form: AutocompleteFormState
      setForm: Dispatch<SetStateAction<AutocompleteFormState>>
    }
  | {
      mode: 'suggest'
      form: SuggestFormState
      setForm: Dispatch<SetStateAction<SuggestFormState>>
    }
)

function getValueItems(response: JsonValue): JsonValue[] {
  if (!isJsonObject(response)) return []
  return Array.isArray(response.value) ? response.value : []
}

function readString(record: JsonValue, key: string): string {
  if (!isJsonObject(record)) return ''
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function renderSuggestionTitle(mode: 'autocomplete' | 'suggest', item: JsonValue): string {
  if (mode === 'autocomplete') {
    return readString(item, 'text') || readString(item, 'queryPlusText') || '(empty)'
  }
  return readString(item, '@search.text') || readString(item, 'text') || '(empty)'
}

export function TypeaheadBuilderForm(props: TypeaheadBuilderFormProps) {
  const {
    t,
    language,
    mode,
    activeProfile,
    indexName,
    apiVersion,
    form,
    suggesterNameOptions,
    searchableFieldNames,
  } = props

  const suggesterListId = useId()
  const fieldListId = useId()
  const suggestForm = mode === 'suggest' ? form : null
  const autocompleteForm = mode === 'autocomplete' ? form : null
  const modeLabel = mode === 'autocomplete' ? t('autocomplete') : t('suggest')
  const searchableFieldHint = useMemo(() => searchableFieldNames.slice(0, 6).join(', '), [searchableFieldNames])
  const [liveResult, setLiveResult] = useState<LiveResult>(() => ({
    status: 'idle',
    message: t('typeaheadRealtimeConfigure'),
  }))

  const liveRequirementMessage = (() => {
    if (!form.liveTest) return t('typeaheadRealtimeDisabled')
    if (!activeProfile) return t('profileNotInitialized')
    if (!indexName.trim()) return t('searchIndexNameRequired')
    if (!form.search.trim()) return t('typeaheadSearchRequired')
    if (!form.suggesterName.trim()) return t('suggesterNameRequired')
    return ''
  })()
  const displayedLiveResult: LiveResult = liveRequirementMessage
    ? { status: 'idle', message: liveRequirementMessage }
    : liveResult
  const liveItems = displayedLiveResult.status === 'success' ? getValueItems(displayedLiveResult.response) : []

  function patchForm(patch: Partial<AutocompleteFormState> | Partial<SuggestFormState>) {
    if (props.mode === 'autocomplete') {
      props.setForm((previous) => ({ ...previous, ...(patch as Partial<AutocompleteFormState>) }))
      return
    }
    props.setForm((previous) => ({ ...previous, ...(patch as Partial<SuggestFormState>) }))
  }

  useEffect(() => {
    if (liveRequirementMessage || !activeProfile) return

    const resolvedIndexName = indexName.trim()
    if (!resolvedIndexName) return

    const profile = activeProfile
    const abortController = new AbortController()
    const timer = window.setTimeout(() => {
      ;(async () => {
        setLiveResult({ status: 'pending', message: t('typeaheadRealtimeTesting') })
        const startedAt = performance.now()
        const body = mode === 'autocomplete'
          ? buildAutocompleteBodyFromForm(form as AutocompleteFormState)
          : buildSuggestBodyFromForm(form as SuggestFormState)
        const result = mode === 'autocomplete'
          ? await autocompleteDocuments({
              profile,
              indexName: resolvedIndexName,
              apiVersion,
              body,
              language,
              signal: abortController.signal,
            })
          : await suggestDocuments({
              profile,
              indexName: resolvedIndexName,
              apiVersion,
              body,
              language,
              signal: abortController.signal,
            })

        if (abortController.signal.aborted) return

        if (result.ok) {
          setLiveResult({
            status: 'success',
            requestId: result.requestId,
            elapsedMs: Math.round(performance.now() - startedAt),
            serviceElapsedMs: result.elapsedTimeMs,
            url: result.url,
            response: result.response,
          })
        } else {
          setLiveResult({
            status: 'error',
            message: result.error.message,
            requestId: result.requestId,
            statusCode: result.status,
            response: result.error.response,
            responseText: result.error.responseText,
          })
        }
      })().catch((error) => {
        if (abortController.signal.aborted) return
        setLiveResult({ status: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    }, 350)

    return () => {
      window.clearTimeout(timer)
      abortController.abort()
    }
  }, [activeProfile, apiVersion, form, indexName, language, liveRequirementMessage, mode, t])

  return (
    <div className="form" data-guide-target={`typeahead-${mode}`}>
      <label className="field field--full" data-guide-target="typeahead-search">
        <span className="field__label">
          {t('typeaheadSearch')}
          <InfoTooltip tooltipKey="typeaheadSearchTooltip" language={language} />
        </span>
        <input
          className="field__input"
          value={form.search}
          onChange={(event) => patchForm({ search: event.target.value })}
          placeholder={t('typeaheadSearchPlaceholder')}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field__label">
          {t('suggesterName')}
          <InfoTooltip tooltipKey="suggesterNameTooltip" language={language} />
        </span>
        <input
          className="field__input"
          list={suggesterListId}
          value={form.suggesterName}
          onChange={(event) => patchForm({ suggesterName: event.target.value })}
          placeholder={t('suggesterNamePlaceholder')}
          autoComplete="off"
        />
        <datalist id={suggesterListId}>
          {suggesterNameOptions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </label>

      <label className="field">
        <span className="field__label">
          {t('top')}
          <InfoTooltip tooltipKey="top" language={language} />
        </span>
        <input
          className="field__input"
          type="number"
          min={1}
          value={form.top}
          onChange={(event) => {
            const next = Number(event.target.value)
            patchForm({ top: Number.isFinite(next) && next > 0 ? next : 1 })
          }}
        />
      </label>

      {autocompleteForm ? (
        <label className="field">
          <span className="field__label">
            {t('autocompleteMode')}
            <InfoTooltip tooltipKey="autocompleteModeTooltip" language={language} />
          </span>
          <select
            className="field__input"
            value={autocompleteForm.autocompleteMode}
            onChange={(event) => patchForm({ autocompleteMode: event.target.value as AutocompleteFormState['autocompleteMode'] })}
          >
            <option value="oneTerm">oneTerm</option>
            <option value="twoTerms">twoTerms</option>
            <option value="oneTermWithContext">oneTermWithContext</option>
          </select>
        </label>
      ) : null}

      <label className="field">
        <span className="field__label">
          {t('searchFields')}
          <InfoTooltip tooltipKey="searchFields" language={language} />
        </span>
        <input
          className="field__input"
          list={fieldListId}
          value={form.searchFields}
          onChange={(event) => patchForm({ searchFields: event.target.value })}
          placeholder={searchableFieldHint || t('placeholderOptional')}
          autoComplete="off"
        />
        <datalist id={fieldListId}>
          {searchableFieldNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </label>

      <label className="field">
        <span className="field__label">
          minimumCoverage
          <InfoTooltip tooltipKey="minimumCoverage" language={language} />
        </span>
        <input
          className="field__input"
          type="number"
          min={0}
          max={100}
          value={form.minimumCoverage}
          onChange={(event) => {
            const raw = event.target.value
            patchForm({ minimumCoverage: raw.trim() ? Number(raw) : '' })
          }}
          placeholder={t('placeholderOptional')}
        />
      </label>

      <label className="field field--full">
        <span className="field__label">
          {t('filter')}
          <InfoTooltip tooltipKey="filter" language={language} />
        </span>
        <input
          className="field__input"
          value={form.filter}
          onChange={(event) => patchForm({ filter: event.target.value })}
          placeholder="category eq 'news'"
        />
      </label>

      {suggestForm ? (
        <>
          <label className="field">
            <span className="field__label">
              {t('select')}
              <InfoTooltip tooltipKey="select" language={language} />
            </span>
            <input
              className="field__input"
              value={suggestForm.select}
              onChange={(event) => patchForm({ select: event.target.value })}
              placeholder="title,content"
            />
          </label>

          <label className="field">
            <span className="field__label">
              {t('orderby')}
              <InfoTooltip tooltipKey="orderby" language={language} />
            </span>
            <input
              className="field__input"
              value={suggestForm.orderby}
              onChange={(event) => patchForm({ orderby: event.target.value })}
              placeholder="rating desc"
            />
          </label>

          <label className="field">
            <span className="field__label">
              highlightPreTag
              <InfoTooltip tooltipKey="highlightPreTag" language={language} />
            </span>
            <input
              className="field__input"
              value={suggestForm.highlightPreTag}
              onChange={(event) => patchForm({ highlightPreTag: event.target.value })}
            />
          </label>

          <label className="field">
            <span className="field__label">
              highlightPostTag
              <InfoTooltip tooltipKey="highlightPostTag" language={language} />
            </span>
            <input
              className="field__input"
              value={suggestForm.highlightPostTag}
              onChange={(event) => patchForm({ highlightPostTag: event.target.value })}
            />
          </label>
        </>
      ) : null}

      <div className="field field--full typeaheadOptions">
        <label className="edgCheckboxLabel">
          <input
            type="checkbox"
            checked={form.useFuzzyMatching}
            onChange={(event) => patchForm({ useFuzzyMatching: event.target.checked })}
          />
          <span>{t('useFuzzyMatching')}</span>
          <InfoTooltip tooltipKey="useFuzzyMatchingTooltip" language={language} />
        </label>
        <label className="edgCheckboxLabel">
          <input
            type="checkbox"
            checked={form.liveTest}
            onChange={(event) => patchForm({ liveTest: event.target.checked })}
          />
          <span>{t('typeaheadLiveTest')}</span>
          <InfoTooltip tooltipKey="typeaheadLiveTestTooltip" language={language} />
        </label>
      </div>

      <div className="typeaheadLive field--full" aria-live="polite">
        <div className="typeaheadLive__header">
          <div className="typeaheadLive__title">
            <i className="bi bi-lightning-charge icon--mr6"></i>
            {modeLabel} {t('typeaheadRealtimeTest')}
          </div>
          <span className={`typeaheadLive__status typeaheadLive__status--${displayedLiveResult.status}`}>
            {displayedLiveResult.status}
          </span>
        </div>

        {displayedLiveResult.status === 'idle' || displayedLiveResult.status === 'pending' ? (
          <div className="typeaheadLive__message">{displayedLiveResult.message}</div>
        ) : null}

        {displayedLiveResult.status === 'error' ? (
          <div className="typeaheadLive__error">
            <div>{displayedLiveResult.statusCode ? `HTTP ${displayedLiveResult.statusCode}: ` : ''}{displayedLiveResult.message}</div>
            {displayedLiveResult.requestId ? <div className="mono typeaheadLive__metaLine">requestId: {displayedLiveResult.requestId}</div> : null}
            {displayedLiveResult.responseText ? <pre className="mono resultCard__pre">{displayedLiveResult.responseText}</pre> : null}
          </div>
        ) : null}

        {displayedLiveResult.status === 'success' ? (
          <>
            <div className="typeaheadLive__meta">
              <span>{t('typeaheadRealtimeResultCount').replace('{count}', String(liveItems.length))}</span>
              <span className="mono">client {displayedLiveResult.elapsedMs} ms</span>
              {displayedLiveResult.serviceElapsedMs !== undefined ? (
                <span className="mono">elapsed-time {displayedLiveResult.serviceElapsedMs} ms</span>
              ) : null}
              <span className="mono">requestId {displayedLiveResult.requestId}</span>
            </div>
            {liveItems.length === 0 ? (
              <div className="empty">{t('typeaheadRealtimeNoResults')}</div>
            ) : (
              <div className="typeaheadLive__list">
                {liveItems.map((item, idx) => {
                  const title = renderSuggestionTitle(mode, item)
                  const queryPlusText = readString(item, 'queryPlusText')
                  return (
                    <div key={idx} className="typeaheadLive__item">
                      <div className="typeaheadLive__itemTop">
                        <span className="typeaheadLive__itemIndex">#{idx + 1}</span>
                        <span className="typeaheadLive__itemTitle">{title}</span>
                      </div>
                      {queryPlusText && queryPlusText !== title ? (
                        <div className="typeaheadLive__itemSub">
                          {t('typeaheadQueryPlusText')}: <span className="mono">{queryPlusText}</span>
                        </div>
                      ) : null}
                      <details className="resultCard__details resultCard__details--mt8">
                        <summary className="resultCard__summary">RAW</summary>
                        <div className="mono jsonViewer__body rawJsonViewer">
                          <JsonViewer data={item} initialOpenDepth={2} hideRootObjectToggle collapseArraysByDefault t={t} />
                        </div>
                      </details>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
