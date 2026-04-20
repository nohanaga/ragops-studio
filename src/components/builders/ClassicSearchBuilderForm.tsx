/**
 * Classic search request builder.
 *
 * Provides a form-first UX for composing `search` requests. The form writes into
 * `SearchFormState`, which can also be represented as JSON elsewhere.
 */

import { useRef, useState } from 'react'
import type React from 'react'

import Dropdown from 'bootstrap/js/dist/dropdown'

import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import type { LabMode, SearchFormState } from '../../types'
import { InfoTooltip } from '../InfoTooltip'

type TranslationKey = keyof typeof translations.ja

export type ClassicSearchBuilderFormProps = {
  t: (key: TranslationKey) => string
  language: Language

  labMode: LabMode
  setLabMode: React.Dispatch<React.SetStateAction<LabMode>>
  isPreviewApiVersion: boolean
  effectiveApiVersion: string

  searchForm: SearchFormState
  setSearchForm: React.Dispatch<React.SetStateAction<SearchFormState>>

  isLoadingRequestBuilderSchema: boolean
  requestBuilderVectorFieldNames: string[]

  setIsFilterBuilderOpen: React.Dispatch<React.SetStateAction<boolean>>

  onExecute: () => void
}

export function ClassicSearchBuilderForm(props: ClassicSearchBuilderFormProps) {
  const {
    t,
    language,
    labMode,
    setLabMode,
    isPreviewApiVersion,
    effectiveApiVersion,
    searchForm,
    setSearchForm,
    isLoadingRequestBuilderSchema,
    requestBuilderVectorFieldNames,
    setIsFilterBuilderOpen,
    onExecute,
  } = props

  const DEBUG_OPTIONS = ['queryRewrites', 'vector', 'innerHits', 'semantic', 'all'] as const

  const [debugFilterText, setDebugFilterText] = useState('')
  const debugFilterInputRef = useRef<HTMLInputElement | null>(null)
  const debugDropdownToggleRef = useRef<HTMLButtonElement | null>(null)

  const csvToList = (csv: string): string[] => {
    return csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  const toggleCsvSelection = (csv: string, value: string, orderedUniverse: readonly string[]): string => {
    const selected = new Set(csvToList(csv))
    if (selected.has(value)) {
      selected.delete(value)
    } else {
      selected.add(value)
    }
    return orderedUniverse.filter((v) => selected.has(v)).join(',')
  }

  const hideClosestBootstrapDropdown = (fromEl: HTMLElement | null) => {
    if (!fromEl) return
    const dropdownRoot = fromEl.closest('.dropdown')
    if (!dropdownRoot) return
    const toggle = dropdownRoot.querySelector('[data-bs-toggle="dropdown"]') as HTMLElement | null
    if (!toggle) return
    Dropdown.getOrCreateInstance(toggle).hide()
  }

  return (
    <div className="form">
      <label className="field field--full" data-guide-target="search-query">
        <span className="field__label">
          query
          <InfoTooltip tooltipKey="query" language={language} />
        </span>
        <input
          className="field__input"
          value={searchForm.search}
          onChange={(e) => setSearchForm((p) => ({ ...p, search: e.target.value }))}
          placeholder="*"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return

            // Avoid triggering while IME composition is active (Japanese/Korean/Chinese input).
            // React's KeyboardEvent exposes the native event.
            if ((e.nativeEvent as unknown as { isComposing?: boolean }).isComposing) return

            // Keep Enter behavior consistent with the Execute button.
            if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return

            e.preventDefault()
            onExecute()
          }}
        />
      </label>

      <label className="field query-type-field" data-guide-target="query-type">
        <span className="field__label">
          queryType
          <InfoTooltip tooltipKey="queryType" language={language} />
        </span>
        <select
          className="field__input"
          value={searchForm.queryType}
          onChange={(e) => {
            const next = e.target.value as SearchFormState['queryType']
            setSearchForm((p) => ({ ...p, queryType: next }))
            if (next === 'semantic') {
              setLabMode('semantic-vector')
            }
          }}
        >
          <option value="simple">simple</option>
          <option value="full">full (Lucene)</option>
          <option value="semantic">semantic</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">
          count
          <InfoTooltip tooltipKey="count" language={language} />
        </span>
        <select
          className="field__input"
          value={searchForm.count ? 'true' : 'false'}
          onChange={(e) => setSearchForm((p) => ({ ...p, count: e.target.value === 'true' }))}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">
          top
          <InfoTooltip tooltipKey="top" language={language} />
        </span>
        <input
          className="field__input"
          type="number"
          value={searchForm.top}
          onChange={(e) => setSearchForm((p) => ({ ...p, top: Number(e.target.value) }))}
          min={1}
          max={1000}
        />
      </label>

      <label className="field">
        <span className="field__label">
          skip
          <InfoTooltip tooltipKey="skip" language={language} />
        </span>
        <input
          className="field__input"
          type="number"
          value={searchForm.skip}
          onChange={(e) => setSearchForm((p) => ({ ...p, skip: Number(e.target.value) }))}
          min={0}
          max={100000}
        />
      </label>

      <label className="field">
        <span className="field__label">
          select
          <InfoTooltip tooltipKey="select" language={language} />
        </span>
        <input
          className="field__input"
          value={searchForm.select}
          onChange={(e) => setSearchForm((p) => ({ ...p, select: e.target.value }))}
          placeholder="title,content"
        />
      </label>

      <label className="field">
        <span className="field__label">
          searchFields
          <InfoTooltip tooltipKey="searchFields" language={language} />
        </span>
        <input
          className="field__input"
          value={searchForm.searchFields}
          onChange={(e) => setSearchForm((p) => ({ ...p, searchFields: e.target.value }))}
          placeholder="title,content"
        />
      </label>

      <label className="field">
        <span className="field__label">
          filter
          <InfoTooltip tooltipKey="filter" language={language} />
        </span>
        <div className="fieldRow">
          <input
            className="field__input fieldRow__grow"
            value={searchForm.filter}
            onChange={(e) => setSearchForm((p) => ({ ...p, filter: e.target.value }))}
            placeholder="category eq 'hotel'"
          />
          <button
            type="button"
            className="btn"
            onClick={() => setIsFilterBuilderOpen(true)}
            title="Open Filter Builder"
          >
            🛠️
          </button>
        </div>
      </label>

      <label className="field">
        <span className="field__label">
          facets
          <InfoTooltip tooltipKey="facets" language={language} />
        </span>
        <input
          className="field__input"
          value={searchForm.facets}
          onChange={(e) => setSearchForm((p) => ({ ...p, facets: e.target.value }))}
          placeholder="keyphrases,count:10"
        />
      </label>

      <label className="field">
        <span className="field__label">
          orderby
          <InfoTooltip tooltipKey="orderby" language={language} />
        </span>
        <input
          className="field__input"
          value={searchForm.orderby}
          onChange={(e) => setSearchForm((p) => ({ ...p, orderby: e.target.value }))}
          placeholder="@search.score() desc"
        />
      </label>

      <label className="field">
        <span className="field__label">
          searchMode
          <InfoTooltip tooltipKey="searchMode" language={language} />
        </span>
        <select
          className="field__input"
          value={searchForm.searchMode}
          onChange={(e) => setSearchForm((p) => ({ ...p, searchMode: e.target.value }))}
        >
          <option value="">(default)</option>
          <option value="any">any</option>
          <option value="all">all</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">
          scoringProfile
          <InfoTooltip tooltipKey="scoringProfile" language={language} />
        </span>
        <input
          className="field__input"
          value={searchForm.scoringProfile}
          onChange={(e) => setSearchForm((p) => ({ ...p, scoringProfile: e.target.value }))}
          placeholder="myProfile"
        />
      </label>

      <label className="field">
        <span className="field__label">
          scoringParameters
          <InfoTooltip tooltipKey="scoringParameters" language={language} />
        </span>
        <input
          className="field__input"
          value={searchForm.scoringParameters}
          onChange={(e) => setSearchForm((p) => ({ ...p, scoringParameters: e.target.value }))}
          placeholder="param1:value1,param2:value2"
        />
      </label>

      <label className="field">
        <span className="field__label">
          highlight
          <InfoTooltip tooltipKey="highlight" language={language} />
        </span>
        <input
          className="field__input"
          value={searchForm.highlight}
          onChange={(e) => setSearchForm((p) => ({ ...p, highlight: e.target.value }))}
          placeholder="title,content"
        />
      </label>

      <details className="advancedPanel">
        <summary className="advancedPanel__summary">
          {t('advanced')} <i className="bi bi-rocket-takeoff"></i>
        </summary>

        <div className="advancedPanel__content">
          {(() => {
            const parts: string[] = []
            const pushIfSet = (key: string, value: unknown) => {
              if (value === '' || value === undefined || value === null) return
              parts.push(`${key}=${String(value)}`)
            }

            pushIfSet('minimumCoverage', searchForm.minimumCoverage)
            pushIfSet('scoringStatistics', searchForm.scoringStatistics)
            pushIfSet('sessionId', searchForm.sessionId)
            pushIfSet('speller', searchForm.speller)

            // Semantic (advanced)
            pushIfSet('semanticErrorHandling', searchForm.semanticErrorHandling)
            pushIfSet('semanticMaxWaitInMilliseconds', searchForm.semanticMaxWaitInMilliseconds)
            if (isPreviewApiVersion) pushIfSet('semanticFields', searchForm.semanticFields)
            pushIfSet('semanticQuery', searchForm.semanticQuery)
            pushIfSet('queryRewrites', searchForm.queryRewrites)

            // Vector/Hybrid (advanced)
            pushIfSet('vectorFilterMode', searchForm.vectorFilterMode)
            if (isPreviewApiVersion) {
              pushIfSet('hybridSearch.maxTextRecallSize', searchForm.hybridMaxTextRecallSize)
              pushIfSet('hybridSearch.countAndFacetMode', searchForm.hybridCountAndFacetMode)
            }

            // Debug / Highlighting
            pushIfSet('debug', searchForm.debug)
            pushIfSet('highlightPreTag', searchForm.highlightPreTag)
            pushIfSet('highlightPostTag', searchForm.highlightPostTag)

            const summary = parts.length ? parts.join(' / ') : t('optionNone')
            return (
              <div className="requestSettingsSummary" title={parts.length ? parts.join(' / ') : ''}>
                {t('activeSettingsSummary')}: <span className="mono">{summary}</span>
              </div>
            )
          })()}

          <div className="form__metaTitle">{t('presets')}</div>
          <div className="actions actions--tight actions--wrap">
            <button
              type="button"
              className="btn btn--tab"
              onClick={() => {
                setLabMode('semantic-vector')
                setSearchForm((p) => ({
                  ...p,
                  queryType: 'semantic',
                  semanticConfiguration: p.semanticConfiguration || 'default',
                  queryLanguage: p.queryLanguage || 'ja-jp',
                  captions: p.captions || 'extractive',
                  answers: p.answers || 'extractive|count-3',
                }))
              }}
            >
              {t('presetSemantic')}
            </button>
            <button
              type="button"
              className="btn btn--tab"
              onClick={() => {
                setLabMode('query')
                setSearchForm((p) => ({ ...p, queryType: 'full' }))
              }}
            >
              {t('presetLucene')}
            </button>
            <button
              type="button"
              className="btn btn--tab"
              onClick={() => {
                setLabMode('semantic-vector')
                setSearchForm((p) => ({ ...p, vectorEnabled: true, vectorKind: 'text' }))
              }}
            >
              {t('presetVectorText')}
            </button>
            <button
              type="button"
              className="btn btn--tab"
              onClick={() => {
                setLabMode('semantic-vector')
                setSearchForm((p) => ({ ...p, vectorEnabled: true, vectorKind: 'vector' }))
              }}
            >
              {t('presetVectorVector')}
            </button>
            <button type="button" className="btn btn--tab" onClick={() => setSearchForm((p) => ({ ...p, vectorEnabled: false }))}>
              {t('presetVectorOff')}
            </button>
            <button
              type="button"
              className="btn btn--tab"
              onClick={() =>
                setSearchForm((p) => ({
                  ...p,
                  queryRewrites: '',
                  debug: '',
                  semanticQuery: '',
                  highlightPreTag: '',
                  highlightPostTag: '',
                  minimumCoverage: '',
                  scoringStatistics: '',
                  sessionId: '',
                  speller: '',
                  semanticErrorHandling: '',
                  semanticMaxWaitInMilliseconds: '',
                  semanticFields: '',
                  vectorFilterMode: '',
                  hybridMaxTextRecallSize: '',
                  hybridCountAndFacetMode: '',
                  vectorQueries: [],
                }))
              }
            >
              {t('presetClearAdvanced')}
            </button>
          </div>

          <div className="preview-info">
            <div className="preview-info__title">{t('preview')}</div>
            <div>
              {t('effectiveApiVersion')}: <span className="mono">{effectiveApiVersion || t('placeholderUnset')}</span>{' '}
              {isPreviewApiVersion ? '(preview)' : ''}
            </div>
            <div className="preview-info__note">{t('previewParamsNote')}</div>
          </div>

          <div className="form form--mt10">
            <div className="form__sectionTitle form__sectionTitle--tight">{t('advancedGroupRelevance')}</div>

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
                step={1}
                value={searchForm.minimumCoverage}
                onChange={(e) =>
                  setSearchForm((p) => ({
                    ...p,
                    minimumCoverage: e.target.value === '' ? '' : Number(e.target.value),
                  }))
                }
                placeholder={t('placeholderOmit')}
              />
            </label>

            <label className="field">
              <span className="field__label">
                scoringStatistics
                <InfoTooltip tooltipKey="scoringStatistics" language={language} />
              </span>
              <select
                className="field__input"
                value={searchForm.scoringStatistics}
                onChange={(e) =>
                  setSearchForm((p) => ({
                    ...p,
                    scoringStatistics: e.target.value as SearchFormState['scoringStatistics'],
                  }))
                }
              >
                <option value="">{t('optionDefault')}</option>
                <option value="local">local</option>
                <option value="global">global</option>
              </select>
            </label>

            <div className="form__sectionTitle">{t('advancedGroupSession')}</div>

            <label className="field field--full">
              <span className="field__label">
                sessionId
                <InfoTooltip tooltipKey="sessionId" language={language} />
              </span>
              <input
                className="field__input"
                value={searchForm.sessionId}
                onChange={(e) => setSearchForm((p) => ({ ...p, sessionId: e.target.value }))}
                placeholder={t('placeholderStickySessionId')}
              />
            </label>

            <label className="field">
              <span className="field__label">
                speller
                <InfoTooltip tooltipKey="speller" language={language} />
              </span>
              <select
                className="field__input"
                value={searchForm.speller}
                onChange={(e) => setSearchForm((p) => ({ ...p, speller: e.target.value as SearchFormState['speller'] }))}
              >
                <option value="">{t('optionDefault')}</option>
                <option value="none">none</option>
                <option value="lexicon">lexicon</option>
              </select>
            </label>

            <label className="field">
              <span className="field__label">queryLanguage</span>
              <input
                className="field__input"
                value={searchForm.queryLanguage}
                onChange={(e) => setSearchForm((p) => ({ ...p, queryLanguage: e.target.value }))}
                disabled={searchForm.queryType !== 'semantic' && searchForm.speller !== 'lexicon'}
              />
            </label>

            <div className="form__sectionTitle">{t('advancedGroupSemantic')}</div>

            <label className="field">
              <span className="field__label">
                semanticErrorHandling
                <InfoTooltip tooltipKey="semanticErrorHandling" language={language} />
              </span>
              <select
                className="field__input"
                value={searchForm.semanticErrorHandling}
                onChange={(e) =>
                  setSearchForm((p) => ({
                    ...p,
                    semanticErrorHandling: e.target.value as SearchFormState['semanticErrorHandling'],
                  }))
                }
                disabled={searchForm.queryType !== 'semantic'}
              >
                <option value="">{t('optionDefault')}</option>
                <option value="fail">fail</option>
                <option value="partial">partial</option>
              </select>
            </label>

            <label className="field">
              <span className="field__label">
                semanticMaxWaitInMilliseconds
                <InfoTooltip tooltipKey="semanticMaxWaitInMilliseconds" language={language} />
              </span>
              <input
                className="field__input"
                type="number"
                min={700}
                step={1}
                value={searchForm.semanticMaxWaitInMilliseconds}
                onChange={(e) =>
                  setSearchForm((p) => ({
                    ...p,
                    semanticMaxWaitInMilliseconds: e.target.value === '' ? '' : Number(e.target.value),
                  }))
                }
                placeholder={t('placeholderOmit')}
                disabled={searchForm.queryType !== 'semantic'}
              />
            </label>

            {isPreviewApiVersion && (
              <label className="field field--full">
                <span className="field__label">
                  semanticFields
                  <InfoTooltip tooltipKey="semanticFields" language={language} />
                </span>
                <input
                  className="field__input"
                  value={searchForm.semanticFields}
                  onChange={(e) => setSearchForm((p) => ({ ...p, semanticFields: e.target.value }))}
                  placeholder="title,content"
                  disabled={searchForm.queryType !== 'semantic'}
                />
              </label>
            )}

            <label className="field field--full">
              <span className="field__label">
                semanticQuery
                <InfoTooltip tooltipKey="semanticQuery" language={language} />
              </span>
              <input
                className="field__input"
                value={searchForm.semanticQuery}
                onChange={(e) => setSearchForm((p) => ({ ...p, semanticQuery: e.target.value }))}
                placeholder={t('placeholderSemanticRerankingQuery')}
                disabled={searchForm.queryType !== 'semantic'}
              />
            </label>

            <label className="field">
              <span className="field__label">
                queryRewrites
                <InfoTooltip tooltipKey="queryRewrites" language={language} />
              </span>
              <input
                className="field__input"
                value={searchForm.queryRewrites}
                onChange={(e) => setSearchForm((p) => ({ ...p, queryRewrites: e.target.value }))}
                placeholder="generative|count-5"
                disabled={searchForm.queryType !== 'semantic'}
              />
            </label>

            <div className="form__sectionTitle">{t('advancedGroupVectorHybrid')}</div>

            <label className="field">
              <span className="field__label">
                vectorFilterMode
                <InfoTooltip tooltipKey="vectorFilterMode" language={language} />
              </span>
              <select
                className="field__input"
                value={searchForm.vectorFilterMode}
                onChange={(e) =>
                  setSearchForm((p) => ({
                    ...p,
                    vectorFilterMode: e.target.value as SearchFormState['vectorFilterMode'],
                  }))
                }
                disabled={labMode !== 'semantic-vector' || !searchForm.vectorEnabled}
              >
                <option value="">{t('optionDefault')}</option>
                <option value="preFilter">preFilter</option>
                <option value="postFilter">postFilter</option>
                <option value="strictPostFilter">strictPostFilter</option>
              </select>
            </label>

            {isPreviewApiVersion && (
              <>
                <label className="field">
                  <span className="field__label">
                    hybridSearch.maxTextRecallSize
                    <InfoTooltip tooltipKey="hybridMaxTextRecallSize" language={language} />
                  </span>
                  <input
                    className="field__input"
                    type="number"
                    min={1}
                    max={10000}
                    step={1}
                    value={searchForm.hybridMaxTextRecallSize}
                    onChange={(e) =>
                      setSearchForm((p) => ({
                        ...p,
                        hybridMaxTextRecallSize: e.target.value === '' ? '' : Number(e.target.value),
                      }))
                    }
                    placeholder={t('placeholderOmit')}
                    disabled={labMode !== 'semantic-vector' || !searchForm.vectorEnabled}
                  />
                </label>

                <label className="field">
                  <span className="field__label">
                    hybridSearch.countAndFacetMode
                    <InfoTooltip tooltipKey="hybridCountAndFacetMode" language={language} />
                  </span>
                  <select
                    className="field__input"
                    value={searchForm.hybridCountAndFacetMode}
                    onChange={(e) =>
                      setSearchForm((p) => ({
                        ...p,
                        hybridCountAndFacetMode: e.target.value as SearchFormState['hybridCountAndFacetMode'],
                      }))
                    }
                    disabled={labMode !== 'semantic-vector' || !searchForm.vectorEnabled}
                  >
                    <option value="">{t('optionDefault')}</option>
                    <option value="countAllResults">countAllResults</option>
                    <option value="countRetrievableResults">countRetrievableResults</option>
                  </select>
                </label>
              </>
            )}

            <div className="form__sectionTitle">{t('advancedGroupDebug')}</div>

            <label className="field">
              <span className="field__label">
                debug
                <InfoTooltip tooltipKey="debug" language={language} />
              </span>
              <div className="dropdown analyzer-bs">
                <button
                  type="button"
                  className="field__input"
                  data-bs-toggle="dropdown"
                  data-bs-auto-close="outside"
                  data-bs-display="static"
                  ref={debugDropdownToggleRef}
                  onClick={() => {
                    setDebugFilterText('')
                    window.setTimeout(() => debugFilterInputRef.current?.focus(), 0)
                  }}
                >
                  <span className="dropdown-toggle__label">
                    {(() => {
                      const selected = csvToList(searchForm.debug)
                      return selected.length > 0 ? selected.join(', ') : '(none)'
                    })()}
                  </span>
                  <span className="dropdown-toggle__caret" aria-hidden="true" />
                </button>

                <div className="dropdown-menu dropdown-menu--left">
                  <div className="dropdown-menu__pad">
                    <input
                      ref={debugFilterInputRef}
                      className="field__input"
                      value={debugFilterText}
                      onChange={(e) => setDebugFilterText(e.target.value)}
                      placeholder="Filter…"
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          hideClosestBootstrapDropdown(e.currentTarget)
                        }
                      }}
                    />
                  </div>

                  {DEBUG_OPTIONS.filter((name) => {
                    const q = debugFilterText.trim().toLowerCase()
                    if (!q) return true
                    return name.toLowerCase().includes(q)
                  }).map((name) => {
                    const selected = csvToList(searchForm.debug).includes(name)
                    return (
                      <button
                        key={name}
                        type="button"
                        className={'dropdown-item dropdown-item--check' + (selected ? ' active' : '')}
                        onClick={() => {
                          setSearchForm((p) => ({
                            ...p,
                            debug: toggleCsvSelection(p.debug, name, DEBUG_OPTIONS),
                          }))
                        }}
                      >
                        <input className="dropdown-check" type="checkbox" checked={selected} readOnly />
                        <span className="dropdown-label">{name}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </label>

            <div className="form__sectionTitle">{t('advancedGroupHighlighting')}</div>

            <label className="field">
              <span className="field__label">
                highlightPreTag
                <InfoTooltip tooltipKey="highlightPreTag" language={language} />
              </span>
              <input
                className="field__input"
                value={searchForm.highlightPreTag}
                onChange={(e) => setSearchForm((p) => ({ ...p, highlightPreTag: e.target.value }))}
                placeholder="<em>"
              />
            </label>

            <label className="field">
              <span className="field__label">
                highlightPostTag
                <InfoTooltip tooltipKey="highlightPostTag" language={language} />
              </span>
              <input
                className="field__input"
                value={searchForm.highlightPostTag}
                onChange={(e) => setSearchForm((p) => ({ ...p, highlightPostTag: e.target.value }))}
                placeholder="</em>"
              />
            </label>
          </div>
        </div>
      </details>

      {labMode === 'semantic-vector' && searchForm.queryType === 'semantic' && (
        <div className="semantic-section">
          <label className="field">
            <span className="field__label">semanticConfiguration</span>
            <input
              className="field__input"
              value={searchForm.semanticConfiguration}
              onChange={(e) => setSearchForm((p) => ({ ...p, semanticConfiguration: e.target.value }))}
            />
          </label>
          <div className="semantic-section__triple">
            <label className="field">
              <span className="field__label">captions</span>
              <input
                className="field__input"
                value={searchForm.captions}
                onChange={(e) => setSearchForm((p) => ({ ...p, captions: e.target.value }))}
              />
            </label>
            <label className="field">
              <span className="field__label">answers</span>
              <input
                className="field__input"
                value={searchForm.answers}
                onChange={(e) => setSearchForm((p) => ({ ...p, answers: e.target.value }))}
              />
            </label>
          </div>
          <div className="field__hint">{t('semanticScoringProfilesBoostedHint')}</div>
          <div className="field__hint">{t('semanticScoringProfilesFunctionsOnlyHint')}</div>
        </div>
      )}

      {labMode === 'semantic-vector' && (
        <>
          <label className="field vector-queries-toggle" data-guide-target="vector-toggle">
            <span className="field__label">
              vectorQueries
              <InfoTooltip tooltipKey="vectorEnabled" language={language} />
            </span>
            <select
              className="field__input"
              value={searchForm.vectorEnabled ? 'on' : 'off'}
              onChange={(e) => setSearchForm((p) => ({ ...p, vectorEnabled: e.target.value === 'on' }))}
            >
              <option value="off">off</option>
              <option value="on">{t('presetVectorOnOneQuery')}</option>
            </select>
          </label>

          {searchForm.vectorEnabled && (
            <div className="vector-queries-section" data-guide-target="vector-section">
              <div className="form__sectionTitle form__sectionTitle--tight">{t('vectorGroupBasics')}</div>

              <div className="field__hint vector-queries-rrfHint">{t('vectorQueriesRrfHint')}</div>

              <div className="actions actions--tight actions--wrap vector-queries-addRow" data-guide-target="vector-add">
                <button
                  type="button"
                  className="btn btn--tab"
                  onClick={() =>
                    setSearchForm((p) => ({
                      ...p,
                      vectorQueries: [
                        ...p.vectorQueries,
                        {
                          vectorKind: p.vectorKind,
                          vectorText: p.vectorText,
                          vectorQueryRewrites: p.vectorQueryRewrites,
                          vector: p.vector,
                          vectorImageUrl: p.vectorImageUrl,
                          vectorBase64Image: p.vectorBase64Image,
                          vectorFields: p.vectorFields,
                          vectorK: p.vectorK,
                          vectorExhaustive: p.vectorExhaustive,
                          vectorWeight: p.vectorWeight,
                          vectorThresholdKind: p.vectorThresholdKind,
                          vectorThresholdValue: p.vectorThresholdValue,
                          vectorOversampling: p.vectorOversampling,
                          vectorPerDocumentVectorLimit: p.vectorPerDocumentVectorLimit,
                          vectorFilterOverride: p.vectorFilterOverride,
                        },
                      ],
                    }))
                  }
                >
                  <i className="bi bi-plus-circle icon--mr6" aria-hidden="true"></i>
                  {t('fqbAddCondition')}
                </button>
              </div>

              {searchForm.vectorQueries.length > 0 && (
                <div className="form vector-queries-list" data-guide-target="vector-list">
                  <div className="form__sectionTitle form__sectionTitle--tight">vectorQueries ({searchForm.vectorQueries.length})</div>
                  {searchForm.vectorQueries.map((q, i) => (
                    <div key={i} className="actions actions--tight actions--wrap">
                      <span className="mono">
                        #{i + 1} kind={q.vectorKind} k={q.vectorK} fields={q.vectorFields || '(unset)'}
                      </span>
                      <button
                        type="button"
                        className="btn btn--tab"
                        onClick={() =>
                          setSearchForm((p) => ({
                            ...p,
                            vectorQueries: p.vectorQueries.filter((_, idx) => idx !== i),
                          }))
                        }
                      >
                        <i className="bi bi-trash3 icon--mr6" aria-hidden="true"></i>
                        {t('remove')}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <label className="field" data-guide-target="vector-kind">
                <span className="field__label">
                  vector.kind
                  <InfoTooltip tooltipKey="vectorKind" language={language} />
                </span>
                <select
                  className="field__input"
                  value={searchForm.vectorKind}
                  onChange={(e) => setSearchForm((p) => ({ ...p, vectorKind: e.target.value as SearchFormState['vectorKind'] }))}
                >
                  <option value="text">text</option>
                  <option value="vector">vector</option>
                  <option value="imageUrl">imageUrl</option>
                  <option value="imageBinary">imageBinary</option>
                </select>
              </label>

              <label className="field" data-guide-target="vector-k">
                <span className="field__label">
                  vector.k
                  <InfoTooltip tooltipKey="vectorK" language={language} />
                </span>
                <input
                  className="field__input"
                  type="number"
                  value={searchForm.vectorK}
                  onChange={(e) => setSearchForm((p) => ({ ...p, vectorK: Number(e.target.value) }))}
                  min={1}
                  max={1000}
                />
              </label>

              <label className="field field--full" data-guide-target="vector-fields">
                <span className="field__label">
                  vector.fields
                  <InfoTooltip tooltipKey="vectorFields" language={language} />
                </span>
                {isLoadingRequestBuilderSchema ? (
                  <input className="field__input" value={String(t('loading')) + '...'} disabled />
                ) : requestBuilderVectorFieldNames.length > 0 && !searchForm.vectorFields.trim().includes(',') ? (
                  <select
                    className="field__input"
                    value={searchForm.vectorFields}
                    onChange={(e) => setSearchForm((p) => ({ ...p, vectorFields: e.target.value }))}
                  >
                    {requestBuilderVectorFieldNames.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="field__input"
                    value={searchForm.vectorFields}
                    onChange={(e) => setSearchForm((p) => ({ ...p, vectorFields: e.target.value }))}
                    placeholder="contentVector"
                  />
                )}
              </label>

              <div className="form__sectionTitle" data-guide-target="vector-input">{t('vectorGroupInput')}</div>

              {searchForm.vectorKind === 'text' ? (
                <label className="field field--full">
                  <span className="field__label">
                    vector.text
                    <InfoTooltip tooltipKey="vectorText" language={language} />
                  </span>
                  <input
                    className="field__input"
                    value={searchForm.vectorText}
                    onChange={(e) => setSearchForm((p) => ({ ...p, vectorText: e.target.value }))}
                    placeholder="..."
                  />
                </label>
              ) : searchForm.vectorKind === 'vector' ? (
                <label className="field field--full">
                  <span className="field__label">
                    vector (comma-separated numbers)
                    <InfoTooltip tooltipKey="vector" language={language} />
                  </span>
                  <textarea
                    className="field__textarea mono"
                    rows={4}
                    value={searchForm.vector}
                    onChange={(e) => setSearchForm((p) => ({ ...p, vector: e.target.value }))}
                    placeholder="0.12, -0.04, ..."
                  />
                </label>
              ) : searchForm.vectorKind === 'imageUrl' ? (
                <label className="field field--full">
                  <span className="field__label">
                    vector.url
                    <InfoTooltip tooltipKey="vectorImageUrl" language={language} />
                  </span>
                  <input
                    className="field__input"
                    value={searchForm.vectorImageUrl}
                    onChange={(e) => setSearchForm((p) => ({ ...p, vectorImageUrl: e.target.value }))}
                    placeholder="https://..."
                  />
                </label>
              ) : (
                <label className="field field--full">
                  <span className="field__label">
                    vector.base64Image
                    <InfoTooltip tooltipKey="vectorBase64Image" language={language} />
                  </span>
                  <textarea
                    className="field__textarea mono"
                    rows={4}
                    value={searchForm.vectorBase64Image}
                    onChange={(e) => setSearchForm((p) => ({ ...p, vectorBase64Image: e.target.value }))}
                    placeholder="(base64)"
                  />
                </label>
              )}

              <div className="form__sectionTitle">{t('vectorGroupThreshold')}</div>

              <label className="field">
                <span className="field__label">
                  vector.exhaustive
                  <InfoTooltip tooltipKey="vectorExhaustive" language={language} />
                </span>
                <select
                  className="field__input"
                  value={searchForm.vectorExhaustive ? 'true' : 'false'}
                  onChange={(e) => setSearchForm((p) => ({ ...p, vectorExhaustive: e.target.value === 'true' }))}
                >
                  <option value="false">false</option>
                  <option value="true">true</option>
                </select>
              </label>

              <label className="field">
                <span className="field__label">
                  vector.weight
                  <InfoTooltip tooltipKey="vectorWeight" language={language} />
                </span>
                <input
                  className="field__input"
                  type="number"
                  step="0.1"
                  value={searchForm.vectorWeight}
                  onChange={(e) => setSearchForm((p) => ({ ...p, vectorWeight: Number(e.target.value) }))}
                  min={0}
                  max={10}
                />
              </label>

              <label className="field">
                <span className="field__label">
                  threshold.kind
                  <InfoTooltip tooltipKey="vectorThresholdKind" language={language} />
                </span>
                <select
                  className="field__input"
                  value={searchForm.vectorThresholdKind}
                  onChange={(e) =>
                    setSearchForm((p) => ({
                      ...p,
                      vectorThresholdKind: e.target.value as SearchFormState['vectorThresholdKind'],
                    }))
                  }
                >
                  <option value="">{t('optionNone')}</option>
                  <option value="vectorSimilarity">vectorSimilarity</option>
                  <option value="searchScore">searchScore</option>
                </select>
              </label>

              <label className="field">
                <span className="field__label">
                  threshold.value
                  <InfoTooltip tooltipKey="vectorThresholdValue" language={language} />
                </span>
                <input
                  className="field__input"
                  type="number"
                  step="0.01"
                  value={searchForm.vectorThresholdValue}
                  onChange={(e) => setSearchForm((p) => ({ ...p, vectorThresholdValue: Number(e.target.value) }))}
                  min={0}
                  disabled={searchForm.vectorThresholdKind === ''}
                />
              </label>

              <div className="form__sectionTitle">{t('vectorGroupAdvanced')}</div>

              {searchForm.vectorKind === 'text' && (
                <label className="field field--full">
                  <span className="field__label">
                    vector.queryRewrites
                    <InfoTooltip tooltipKey="vectorQueryRewrites" language={language} />
                  </span>
                  <input
                    className="field__input"
                    value={searchForm.vectorQueryRewrites}
                    onChange={(e) => setSearchForm((p) => ({ ...p, vectorQueryRewrites: e.target.value }))}
                    placeholder={t('placeholderOptional')}
                  />
                </label>
              )}

              <label className="field">
                <span className="field__label">
                  vector.oversampling
                  <InfoTooltip tooltipKey="vectorOversampling" language={language} />
                </span>
                <input
                  className="field__input"
                  type="number"
                  step="1"
                  min={1}
                  value={searchForm.vectorOversampling}
                  onChange={(e) =>
                    setSearchForm((p) => ({
                      ...p,
                      vectorOversampling: e.target.value === '' ? '' : Number(e.target.value),
                    }))
                  }
                  placeholder={t('placeholderOptional')}
                />
              </label>

              <label className="field">
                <span className="field__label">
                  vector.perDocumentVectorLimit
                  <InfoTooltip tooltipKey="vectorPerDocumentVectorLimit" language={language} />
                </span>
                <input
                  className="field__input"
                  type="number"
                  step="1"
                  min={0}
                  value={searchForm.vectorPerDocumentVectorLimit}
                  onChange={(e) =>
                    setSearchForm((p) => ({
                      ...p,
                      vectorPerDocumentVectorLimit: e.target.value === '' ? '' : Number(e.target.value),
                    }))
                  }
                  placeholder={t('placeholderOptional')}
                />
              </label>

              <label className="field field--full">
                <span className="field__label">
                  vector.filterOverride
                  <InfoTooltip tooltipKey="vectorFilterOverride" language={language} />
                </span>
                <input
                  className="field__input"
                  value={searchForm.vectorFilterOverride}
                  onChange={(e) => setSearchForm((p) => ({ ...p, vectorFilterOverride: e.target.value }))}
                  placeholder={t('placeholderOptional')}
                />
              </label>
            </div>
          )}
        </>
      )}

    </div>
  )
}
