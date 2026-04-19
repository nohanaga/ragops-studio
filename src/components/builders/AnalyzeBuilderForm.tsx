/**
 * Text analysis request builder form.
 *
 * Provides a UI to configure analyzers/tokenizers/filters and to preview
 * analysis results from the Analyze API.
 */

import type React from 'react'

import {
  ANALYZE_ANALYZERS,
  ANALYZE_CHAR_FILTERS,
  ANALYZE_TOKEN_FILTERS,
  ANALYZE_TOKENIZERS,
  ANALYZE_NORMALIZERS,
} from '../../lib/analyzeCatalog'
import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import type { AnalyzeFormState } from '../../types'
import { InfoTooltip } from '../InfoTooltip'

type TranslationKey = keyof typeof translations.ja

export type AnalyzeBuilderFormProps = {
  t: (key: TranslationKey) => string
  language: Language

  analyzeForm: AnalyzeFormState
  setAnalyzeForm: React.Dispatch<React.SetStateAction<AnalyzeFormState>>

  analyzerFilterText: string
  setAnalyzerFilterText: React.Dispatch<React.SetStateAction<string>>
  analyzerFilterInputRef: React.RefObject<HTMLInputElement | null>
  analyzerDropdownToggleRef: React.RefObject<HTMLButtonElement | null>
  analyzerDropdownMenuRef: React.RefObject<HTMLDivElement | null>

  tokenizerFilterText: string
  setTokenizerFilterText: React.Dispatch<React.SetStateAction<string>>
  tokenizerFilterInputRef: React.RefObject<HTMLInputElement | null>
  tokenizerDropdownToggleRef: React.RefObject<HTMLButtonElement | null>
  tokenizerDropdownMenuRef: React.RefObject<HTMLDivElement | null>

  normalizerFilterText: string
  setNormalizerFilterText: React.Dispatch<React.SetStateAction<string>>
  normalizerFilterInputRef: React.RefObject<HTMLInputElement | null>
  normalizerDropdownToggleRef: React.RefObject<HTMLButtonElement | null>
  normalizerDropdownMenuRef: React.RefObject<HTMLDivElement | null>

  charFilterText: string
  setCharFilterText: React.Dispatch<React.SetStateAction<string>>
  charFilterInputRef: React.RefObject<HTMLInputElement | null>
  charFilterDropdownToggleRef: React.RefObject<HTMLButtonElement | null>
  charFilterDropdownMenuRef: React.RefObject<HTMLDivElement | null>

  tokenFilterText: string
  setTokenFilterText: React.Dispatch<React.SetStateAction<string>>
  tokenFilterInputRef: React.RefObject<HTMLInputElement | null>
  tokenFilterDropdownToggleRef: React.RefObject<HTMLButtonElement | null>
  tokenFilterDropdownMenuRef: React.RefObject<HTMLDivElement | null>

  csvToList: (csv: string) => string[]
  toggleCsvSelection: (csv: string, value: string, orderedUniverse: readonly string[]) => string
  hideClosestBootstrapDropdown: (fromEl: HTMLElement | null) => void
}

export function AnalyzeBuilderForm(props: AnalyzeBuilderFormProps) {
  const {
    t,
    language,
    analyzeForm,
    setAnalyzeForm,
    analyzerFilterText,
    setAnalyzerFilterText,
    analyzerFilterInputRef,
    analyzerDropdownToggleRef,
    analyzerDropdownMenuRef,
    tokenizerFilterText,
    setTokenizerFilterText,
    tokenizerFilterInputRef,
    tokenizerDropdownToggleRef,
    tokenizerDropdownMenuRef,
    normalizerFilterText,
    setNormalizerFilterText,
    normalizerFilterInputRef,
    normalizerDropdownToggleRef,
    normalizerDropdownMenuRef,
    charFilterText,
    setCharFilterText,
    charFilterInputRef,
    charFilterDropdownToggleRef,
    charFilterDropdownMenuRef,
    tokenFilterText,
    setTokenFilterText,
    tokenFilterInputRef,
    tokenFilterDropdownToggleRef,
    tokenFilterDropdownMenuRef,
    csvToList,
    toggleCsvSelection,
    hideClosestBootstrapDropdown,
  } = props

  return (
    <div className="form">
      <label className="field field--full" data-guide-target="analyze-text">
        <span className="field__label">
          {t('textToAnalyze')}
          <InfoTooltip tooltipKey="textToAnalyzeTooltip" language={language} />
        </span>
        <textarea
          className="field__textarea"
          rows={4}
          value={analyzeForm.text}
          onChange={(e) => setAnalyzeForm((p) => ({ ...p, text: e.target.value }))}
          placeholder={t('analyzeTextPlaceholder')}
        />
      </label>

      <label className="field field--full" data-guide-target="analyze-analyzer">
        <span className="field__label">
          {t('analyzerName')}
          <InfoTooltip tooltipKey="analyzerNameTooltip" language={language} />
        </span>
        <div className="dropdown analyzer-bs">
          <button
            type="button"
            className="field__input"
            data-bs-toggle="dropdown"
            data-bs-auto-close="outside"
            data-bs-display="static"
            ref={analyzerDropdownToggleRef}
            onClick={() => {
              setAnalyzerFilterText('')
              window.setTimeout(() => analyzerFilterInputRef.current?.focus(), 0)
            }}
          >
            <span className="dropdown-toggle__label">{analyzeForm.analyzerName || '(none)'}</span>
            <span className="dropdown-toggle__caret" aria-hidden="true" />
          </button>
          <div className="dropdown-menu dropdown-menu--left" ref={analyzerDropdownMenuRef}>
            <div className="dropdown-menu__pad">
              <input
                ref={analyzerFilterInputRef}
                className="field__input"
                value={analyzerFilterText}
                onChange={(e) => setAnalyzerFilterText(e.target.value)}
                placeholder="Filter…"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    hideClosestBootstrapDropdown(e.currentTarget)
                  }
                }}
              />
            </div>
            <button
              type="button"
              className={'dropdown-item' + (!analyzeForm.analyzerName ? ' active' : '')}
              onClick={(e) => {
                setAnalyzeForm((p) => ({ ...p, analyzerName: '' }))
                setAnalyzerFilterText('')
                hideClosestBootstrapDropdown(e.currentTarget)
              }}
            >
              (none)
            </button>
            {ANALYZE_ANALYZERS.filter((name) => {
              const q = analyzerFilterText.trim().toLowerCase()
              if (!q) return true
              return name.toLowerCase().includes(q)
            }).map((name) => (
              <button
                key={name}
                type="button"
                className={'dropdown-item' + (analyzeForm.analyzerName === name ? ' active' : '')}
                onClick={(e) => {
                  setAnalyzeForm((p) => ({ ...p, analyzerName: name }))
                  setAnalyzerFilterText('')
                  hideClosestBootstrapDropdown(e.currentTarget)
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      </label>

      <div className="form__hintRow">{t('analyzeOrCustomChain')}</div>

      <label className="field">
        <span className="field__label">
          {t('tokenizerName')}
          <InfoTooltip tooltipKey="tokenizerNameTooltip" language={language} />
        </span>
        <div className="dropdown analyzer-bs">
          <button
            type="button"
            className="field__input"
            data-bs-toggle="dropdown"
            data-bs-auto-close="outside"
            data-bs-display="static"
            ref={tokenizerDropdownToggleRef}
            onClick={() => {
              setTokenizerFilterText('')
              window.setTimeout(() => tokenizerFilterInputRef.current?.focus(), 0)
            }}
          >
            <span className="dropdown-toggle__label">{analyzeForm.tokenizerName || '(none)'}</span>
            <span className="dropdown-toggle__caret" aria-hidden="true" />
          </button>
          <div className="dropdown-menu dropdown-menu--left" ref={tokenizerDropdownMenuRef}>
            <div className="dropdown-menu__pad">
              <input
                ref={tokenizerFilterInputRef}
                className="field__input"
                value={tokenizerFilterText}
                onChange={(e) => setTokenizerFilterText(e.target.value)}
                placeholder="Filter…"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    hideClosestBootstrapDropdown(e.currentTarget)
                  }
                }}
              />
            </div>
            <button
              type="button"
              className={'dropdown-item' + (!analyzeForm.tokenizerName ? ' active' : '')}
              onClick={(e) => {
                setAnalyzeForm((p) => ({ ...p, tokenizerName: '' }))
                setTokenizerFilterText('')
                hideClosestBootstrapDropdown(e.currentTarget)
              }}
            >
              (none)
            </button>
            {ANALYZE_TOKENIZERS.filter((name) => {
              const q = tokenizerFilterText.trim().toLowerCase()
              if (!q) return true
              return name.toLowerCase().includes(q)
            }).map((name) => (
              <button
                key={name}
                type="button"
                className={'dropdown-item' + (analyzeForm.tokenizerName === name ? ' active' : '')}
                onClick={(e) => {
                  setAnalyzeForm((p) => ({ ...p, tokenizerName: name }))
                  setTokenizerFilterText('')
                  hideClosestBootstrapDropdown(e.currentTarget)
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      </label>

      <label className="field">
        <span className="field__label">
          {t('normalizerName')}
          <InfoTooltip tooltipKey="normalizerNameTooltip" language={language} />
        </span>
        <div className="dropdown analyzer-bs">
          <button
            type="button"
            className="field__input"
            data-bs-toggle="dropdown"
            data-bs-auto-close="outside"
            data-bs-display="static"
            ref={normalizerDropdownToggleRef}
            onClick={() => {
              setNormalizerFilterText('')
              window.setTimeout(() => normalizerFilterInputRef.current?.focus(), 0)
            }}
          >
            <span className="dropdown-toggle__label">{analyzeForm.normalizerName || '(none)'}</span>
            <span className="dropdown-toggle__caret" aria-hidden="true" />
          </button>
          <div className="dropdown-menu dropdown-menu--left" ref={normalizerDropdownMenuRef}>
            <div className="dropdown-menu__pad">
              <input
                ref={normalizerFilterInputRef}
                className="field__input"
                value={normalizerFilterText}
                onChange={(e) => setNormalizerFilterText(e.target.value)}
                placeholder="Filter…"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    hideClosestBootstrapDropdown(e.currentTarget)
                  }
                }}
              />
            </div>
            <button
              type="button"
              className={'dropdown-item' + (!analyzeForm.normalizerName ? ' active' : '')}
              onClick={(e) => {
                setAnalyzeForm((p) => ({ ...p, normalizerName: '' }))
                setNormalizerFilterText('')
                hideClosestBootstrapDropdown(e.currentTarget)
              }}
            >
              (none)
            </button>
            {ANALYZE_NORMALIZERS.filter((name) => {
              const q = normalizerFilterText.trim().toLowerCase()
              if (!q) return true
              return name.toLowerCase().includes(q)
            }).map((name) => (
              <button
                key={name}
                type="button"
                className={'dropdown-item' + (analyzeForm.normalizerName === name ? ' active' : '')}
                onClick={(e) => {
                  setAnalyzeForm((p) => ({ ...p, normalizerName: name }))
                  setNormalizerFilterText('')
                  hideClosestBootstrapDropdown(e.currentTarget)
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
      </label>

      <label className="field field--full">
        <span className="field__label">
          {t('charFilters')}
          <InfoTooltip tooltipKey="charFiltersTooltip" language={language} />
        </span>
        <div className="dropdown analyzer-bs">
          <button
            type="button"
            className="field__input"
            data-bs-toggle="dropdown"
            data-bs-auto-close="outside"
            data-bs-display="static"
            ref={charFilterDropdownToggleRef}
            onClick={() => {
              setCharFilterText('')
              window.setTimeout(() => charFilterInputRef.current?.focus(), 0)
            }}
          >
            <span className="dropdown-toggle__label">
              {(() => {
                const selected = csvToList(analyzeForm.charFilters)
                return selected.length > 0 ? selected.join(', ') : '(none)'
              })()}
            </span>
            <span className="dropdown-toggle__caret" aria-hidden="true" />
          </button>
          <div className="dropdown-menu dropdown-menu--left" ref={charFilterDropdownMenuRef}>
            <div className="dropdown-menu__pad">
              <input
                ref={charFilterInputRef}
                className="field__input"
                value={charFilterText}
                onChange={(e) => setCharFilterText(e.target.value)}
                placeholder="Filter…"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    hideClosestBootstrapDropdown(e.currentTarget)
                  }
                }}
              />
            </div>
            {ANALYZE_CHAR_FILTERS.filter((name) => {
              const q = charFilterText.trim().toLowerCase()
              if (!q) return true
              return name.toLowerCase().includes(q)
            }).map((name) => {
              const selected = csvToList(analyzeForm.charFilters).includes(name)
              return (
                <button
                  key={name}
                  type="button"
                  className={'dropdown-item dropdown-item--check' + (selected ? ' active' : '')}
                  onClick={() => {
                    setAnalyzeForm((p) => ({
                      ...p,
                      charFilters: toggleCsvSelection(p.charFilters, name, ANALYZE_CHAR_FILTERS),
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

      <label className="field field--full">
        <span className="field__label">
          {t('tokenFilters')}
          <InfoTooltip tooltipKey="tokenFiltersTooltip" language={language} />
        </span>
        <div className="dropdown analyzer-bs">
          <button
            type="button"
            className="field__input"
            data-bs-toggle="dropdown"
            data-bs-auto-close="outside"
            data-bs-display="static"
            ref={tokenFilterDropdownToggleRef}
            onClick={() => {
              setTokenFilterText('')
              window.setTimeout(() => tokenFilterInputRef.current?.focus(), 0)
            }}
          >
            <span className="dropdown-toggle__label">
              {(() => {
                const selected = csvToList(analyzeForm.tokenFilters)
                return selected.length > 0 ? `${selected.length} selected` : '(none)'
              })()}
            </span>
            <span className="dropdown-toggle__caret" aria-hidden="true" />
          </button>
          <div className="dropdown-menu dropdown-menu--left" ref={tokenFilterDropdownMenuRef}>
            <div className="dropdown-menu__pad">
              <input
                ref={tokenFilterInputRef}
                className="field__input"
                value={tokenFilterText}
                onChange={(e) => setTokenFilterText(e.target.value)}
                placeholder="Filter…"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    hideClosestBootstrapDropdown(e.currentTarget)
                  }
                }}
              />
            </div>
            {ANALYZE_TOKEN_FILTERS.filter((name) => {
              const q = tokenFilterText.trim().toLowerCase()
              if (!q) return true
              return name.toLowerCase().includes(q)
            }).map((name) => {
              const selected = csvToList(analyzeForm.tokenFilters).includes(name)
              return (
                <button
                  key={name}
                  type="button"
                  className={'dropdown-item dropdown-item--check' + (selected ? ' active' : '')}
                  onClick={() => {
                    setAnalyzeForm((p) => ({
                      ...p,
                      tokenFilters: toggleCsvSelection(p.tokenFilters, name, ANALYZE_TOKEN_FILTERS),
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
    </div>
  )
}
