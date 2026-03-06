/**
 * Main builder tab pane.
 *
 * Composes connection settings, mode-specific request builders, and the JSON
 * request editor into a single cohesive workflow.
 */

import type React from 'react'

import type { AppSettings, ConnectionProfile } from '../../lib/model'
import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import type { AgenticFormState, AnalyzeFormState, BuilderMode, KnowledgeSourceInfo, LabMode, SearchFormState, UiLogEntry } from '../../types'
import { AgenticBuilderForm } from './AgenticBuilderForm'
import { AnalyzeBuilderForm } from './AnalyzeBuilderForm'
import { BuilderActions } from './BuilderActions'
import { BuilderConnectionSection } from './BuilderConnectionSection'
import { BuilderErrorNotice } from './BuilderErrorNotice'
import { ClassicSearchBuilderForm } from './ClassicSearchBuilderForm'
import { RequestJsonEditor } from '../viewers/RequestJsonEditor'

type TranslationKey = keyof typeof translations.ja

export type BuilderTabPaneProps = {
  t: (key: TranslationKey) => string
  language: Language

  // Connection
  activeProfile: ConnectionProfile | null
  patchActiveProfile: (patch: Partial<ConnectionProfile>) => void
  openJwtDecoder: (token: string) => void

  settings: AppSettings | null
  patchSettings: (patch: Partial<AppSettings>) => void

  // Request builder top-level
  labMode: LabMode
  setLabMode: React.Dispatch<React.SetStateAction<LabMode>>
  builderMode: BuilderMode
  setBuilderMode: React.Dispatch<React.SetStateAction<BuilderMode>>

  // Index selection + helpers
  effectiveApiVersion: string
  isPreviewApiVersion: boolean
  indexName: string
  setIndexName: React.Dispatch<React.SetStateAction<string>>
  indexFilterText: string
  setIndexFilterText: React.Dispatch<React.SetStateAction<string>>
  filteredIndexNameOptions: string[]
  openIndexInspector: (name?: string) => void
  onOpenIndexBuilderTab: () => void

  indexDropdownToggleRef: React.RefObject<HTMLButtonElement | null>
  indexDropdownMenuRef: React.RefObject<HTMLDivElement | null>
  indexFilterInputRef: React.RefObject<HTMLInputElement | null>
  hideClosestBootstrapDropdown: (fromEl: HTMLElement | null) => void

  // KB selection (agentic)
  knowledgeBaseName: string
  setKnowledgeBaseName: React.Dispatch<React.SetStateAction<string>>
  knowledgeBaseNamesLoading: boolean
  knowledgeBaseNamesError: string | null
  knowledgeBaseNameOptions: string[]

  availableKnowledgeSources: KnowledgeSourceInfo[]

  // Forms
  searchForm: SearchFormState
  setSearchForm: React.Dispatch<React.SetStateAction<SearchFormState>>
  agenticForm: AgenticFormState
  setAgenticForm: React.Dispatch<React.SetStateAction<AgenticFormState>>
  analyzeForm: AnalyzeFormState
  setAnalyzeForm: React.Dispatch<React.SetStateAction<AnalyzeFormState>>

  // Request Builder schema helpers
  isLoadingRequestBuilderSchema: boolean
  requestBuilderVectorFieldNames: string[]

  // Filter Builder modal opener
  setIsFilterBuilderOpen: React.Dispatch<React.SetStateAction<boolean>>

  // Analyzer dropdown filters + refs
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

  // JSON builder mode
  requestJson: string
  setRequestJson: React.Dispatch<React.SetStateAction<string>>
  runNote: string
  setRunNote: React.Dispatch<React.SetStateAction<string>>

  // Errors + log
  uiError: string | null
  uiLog: UiLogEntry | null
  setUiError: React.Dispatch<React.SetStateAction<string | null>>
  setUiLog: React.Dispatch<React.SetStateAction<UiLogEntry | null>>
  copyToClipboard: (text: string) => Promise<void>

  // Actions
  isExecuting: boolean
  onExecute: () => void
  onExecuteAllModes: () => void
  onClearAll: () => void

  buildRequestBuilderActiveSummary: () => string
}

export function BuilderTabPane(props: BuilderTabPaneProps) {
  const {
    t,
    language,
    activeProfile,
    patchActiveProfile,
    openJwtDecoder,
    settings,
    patchSettings,
    labMode,
    setLabMode,
    builderMode,
    setBuilderMode,
    effectiveApiVersion,
    indexName,
    setIndexName,
    indexFilterText,
    setIndexFilterText,
    filteredIndexNameOptions,
    openIndexInspector,
    onOpenIndexBuilderTab,
    indexDropdownToggleRef,
    indexDropdownMenuRef,
    indexFilterInputRef,
    hideClosestBootstrapDropdown,
    knowledgeBaseName,
    setKnowledgeBaseName,
    knowledgeBaseNamesLoading,
    knowledgeBaseNamesError,
    knowledgeBaseNameOptions,
    buildRequestBuilderActiveSummary,
    isPreviewApiVersion,
    availableKnowledgeSources,
    searchForm,
    setSearchForm,
    agenticForm,
    setAgenticForm,
    analyzeForm,
    setAnalyzeForm,
    isLoadingRequestBuilderSchema,
    requestBuilderVectorFieldNames,
    setIsFilterBuilderOpen,
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
    requestJson,
    setRequestJson,
    runNote,
    setRunNote,
    uiError,
    uiLog,
    setUiError,
    setUiLog,
    copyToClipboard,
    isExecuting,
    onExecute,
    onExecuteAllModes,
    onClearAll,
  } = props

  return (
    <>
      <BuilderConnectionSection
        t={t}
        language={language}
        activeProfile={activeProfile}
        patchActiveProfile={patchActiveProfile}
        openJwtDecoder={openJwtDecoder}
        settings={settings}
        patchSettings={patchSettings}
      />

      <div className="section">
        <div className="section__title">{t('requestBuilder')}</div>

        <div className="actions actions--mb10">
          <button
            type="button"
            className={'btn btn--tab ' + (labMode === 'query' ? 'btn--active' : '')}
            onClick={() => setLabMode('query')}
          >
            {t('query')}
          </button>
          <button
            type="button"
            className={'btn btn--tab ' + (labMode === 'semantic-vector' ? 'btn--active' : '')}
            onClick={() => setLabMode('semantic-vector')}
          >
            {t('semanticVector')}
          </button>
          <button
            type="button"
            className={'btn btn--tab ' + (labMode === 'agentic' ? 'btn--active' : '')}
            onClick={() => setLabMode('agentic')}
          >
            {t('agentic')}
          </button>
          <button
            type="button"
            className={'btn btn--tab ' + (labMode === 'analyze' ? 'btn--active' : '')}
            onClick={() => setLabMode('analyze')}
          >
            Analyze
          </button>
        </div>

        <div className="form form--compact">
          {labMode !== 'agentic' && labMode !== 'analyze' ? (
            <label className="field">
              <span className="field__label">{t('indexName')}</span>
              <div className="list-editor__inputRow">
                <div className="dropdown analyzer-bs">
                  <button
                    ref={indexDropdownToggleRef}
                    type="button"
                    className="field__input"
                    data-bs-toggle="dropdown"
                    data-bs-auto-close="outside"
                    data-bs-display="static"
                    aria-haspopup="true"
                  >
                    <span className="dropdown-toggle__label">{indexName || '(none)'}</span>
                    <span className="dropdown-toggle__caret" aria-hidden="true" />
                  </button>
                  <div ref={indexDropdownMenuRef} className="dropdown-menu dropdown-menu--left">
                    <div className="dropdown-menu__pad">
                      <input
                        ref={indexFilterInputRef}
                        type="text"
                        className="field__input"
                        placeholder="Filter…"
                        value={indexFilterText}
                        onChange={(e) => setIndexFilterText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            hideClosestBootstrapDropdown(e.currentTarget)
                          }
                        }}
                      />
                    </div>
                    {filteredIndexNameOptions.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className={`dropdown-item ${name === indexName ? 'active' : ''}`}
                        onClick={(e) => {
                          setIndexName(name)
                          setIndexFilterText('')
                          hideClosestBootstrapDropdown(e.currentTarget)
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="actions">
                  <button
                    type="button"
                    className="btn btn--xs"
                    onClick={() => openIndexInspector(indexName)}
                    disabled={!activeProfile || !effectiveApiVersion.trim() || !indexName.trim()}
                    title="Inspect index definition"
                  >
                    <i className="bi bi-eye icon--mr6"></i>
                    {t('indexInspector')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--xs"
                    onClick={onOpenIndexBuilderTab}
                    disabled={!activeProfile || !effectiveApiVersion.trim()}
                    title="Open Index Builder"
                  >
                    <i className="bi bi-folder2-open icon--mr6"></i>
                    {t('indexBuilder')}
                  </button>
                </div>
              </div>
            </label>
          ) : labMode === 'agentic' ? (
            <label className="field">
              <span className="field__label">{t('knowledgeBaseName')}</span>
              <select
                className="field__input"
                value={knowledgeBaseName}
                onChange={(e) => setKnowledgeBaseName(e.target.value)}
                disabled={!activeProfile || knowledgeBaseNamesLoading}
              >
                <option value="">{t('placeholderUnset')}</option>
                {knowledgeBaseNamesLoading ? (
                  <option value="" disabled>
                    {t('loading')}…
                  </option>
                ) : null}
                {knowledgeBaseNameOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              {knowledgeBaseNamesError ? (
                <div className="form__hintRow">
                  {t('error')}: {knowledgeBaseNamesError}
                </div>
              ) : null}
            </label>
          ) : (
            <label className="field">
              <span className="field__label">{t('indexName')}</span>
              <div className="list-editor__inputRow">
                <div className="dropdown analyzer-bs">
                  <button
                    ref={indexDropdownToggleRef}
                    type="button"
                    className="field__input"
                    data-bs-toggle="dropdown"
                    data-bs-auto-close="outside"
                    data-bs-display="static"
                    aria-haspopup="true"
                  >
                    <span className="dropdown-toggle__label">{indexName || '(none)'}</span>
                    <span className="dropdown-toggle__caret" aria-hidden="true" />
                  </button>
                  <div ref={indexDropdownMenuRef} className="dropdown-menu dropdown-menu--left">
                    <div className="dropdown-menu__pad">
                      <input
                        ref={indexFilterInputRef}
                        type="text"
                        className="field__input"
                        placeholder="Filter…"
                        value={indexFilterText}
                        onChange={(e) => setIndexFilterText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            hideClosestBootstrapDropdown(e.currentTarget)
                          }
                        }}
                      />
                    </div>
                    {filteredIndexNameOptions.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className={`dropdown-item ${name === indexName ? 'active' : ''}`}
                        onClick={(e) => {
                          setIndexName(name)
                          setIndexFilterText('')
                          hideClosestBootstrapDropdown(e.currentTarget)
                        }}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="actions">
                  <button
                    type="button"
                    className="btn btn--xs"
                    onClick={() => openIndexInspector(indexName)}
                    disabled={!activeProfile || !effectiveApiVersion.trim() || !indexName.trim()}
                    title="Inspect index definition"
                  >
                    <i className="bi bi-eye icon--mr6"></i>
                    {t('indexInspector')}
                  </button>
                  <button
                    type="button"
                    className="btn btn--xs"
                    onClick={onOpenIndexBuilderTab}
                    disabled={!activeProfile || !effectiveApiVersion.trim()}
                    title="Open Index Builder"
                  >
                    <i className="bi bi-folder2-open icon--mr6"></i>
                    {t('indexBuilder')}
                  </button>
                </div>
              </div>
            </label>
          )}
        </div>

        <div className="actions actions--mt10 actions--mb10">
          <button
            type="button"
            className={'btn btn--tab ' + (builderMode === 'form' ? 'btn--active' : '')}
            onClick={() => setBuilderMode('form')}
          >
            {t('form')}
          </button>
          <button
            type="button"
            className={'btn btn--tab ' + (builderMode === 'json' ? 'btn--active' : '')}
            onClick={() => setBuilderMode('json')}
          >
            {t('json')}
          </button>
        </div>

        {labMode !== 'agentic' && labMode !== 'analyze' && (
          <div className="requestBuilderActiveSummary">
            {t('requestBuilderActiveSummary')}: <span className="mono">{buildRequestBuilderActiveSummary()}</span>
          </div>
        )}

        {builderMode === 'form' && labMode !== 'agentic' && labMode !== 'analyze' && (
        <ClassicSearchBuilderForm
          t={t}
          language={language}
          labMode={labMode}
          setLabMode={setLabMode}
          isPreviewApiVersion={isPreviewApiVersion}
          effectiveApiVersion={effectiveApiVersion}
          searchForm={searchForm}
          setSearchForm={setSearchForm}
          isLoadingRequestBuilderSchema={isLoadingRequestBuilderSchema}
          requestBuilderVectorFieldNames={requestBuilderVectorFieldNames}
          setIsFilterBuilderOpen={setIsFilterBuilderOpen}
          onExecute={onExecute}
        />
        )}

        {builderMode === 'form' && labMode === 'agentic' && (
        <AgenticBuilderForm
          t={t}
          language={language}
          agenticForm={agenticForm}
          setAgenticForm={setAgenticForm}
          availableKnowledgeSources={availableKnowledgeSources}
        />
        )}

        {builderMode === 'form' && labMode === 'analyze' && (
        <AnalyzeBuilderForm
          t={t}
          language={language}
          analyzeForm={analyzeForm}
          setAnalyzeForm={setAnalyzeForm}
          analyzerFilterText={analyzerFilterText}
          setAnalyzerFilterText={setAnalyzerFilterText}
          analyzerFilterInputRef={analyzerFilterInputRef}
          analyzerDropdownToggleRef={analyzerDropdownToggleRef}
          analyzerDropdownMenuRef={analyzerDropdownMenuRef}
          tokenizerFilterText={tokenizerFilterText}
          setTokenizerFilterText={setTokenizerFilterText}
          tokenizerFilterInputRef={tokenizerFilterInputRef}
          tokenizerDropdownToggleRef={tokenizerDropdownToggleRef}
          tokenizerDropdownMenuRef={tokenizerDropdownMenuRef}
          normalizerFilterText={normalizerFilterText}
          setNormalizerFilterText={setNormalizerFilterText}
          normalizerFilterInputRef={normalizerFilterInputRef}
          normalizerDropdownToggleRef={normalizerDropdownToggleRef}
          normalizerDropdownMenuRef={normalizerDropdownMenuRef}
          charFilterText={charFilterText}
          setCharFilterText={setCharFilterText}
          charFilterInputRef={charFilterInputRef}
          charFilterDropdownToggleRef={charFilterDropdownToggleRef}
          charFilterDropdownMenuRef={charFilterDropdownMenuRef}
          tokenFilterText={tokenFilterText}
          setTokenFilterText={setTokenFilterText}
          tokenFilterInputRef={tokenFilterInputRef}
          tokenFilterDropdownToggleRef={tokenFilterDropdownToggleRef}
          tokenFilterDropdownMenuRef={tokenFilterDropdownMenuRef}
          csvToList={csvToList}
          toggleCsvSelection={toggleCsvSelection}
          hideClosestBootstrapDropdown={hideClosestBootstrapDropdown}
        />
        )}

        {builderMode === 'json' && (
          <RequestJsonEditor requestJson={requestJson} setRequestJson={setRequestJson} />
        )}

        <details className="advancedPanel">
          <summary className="advancedPanel__summary">
            {t('experimentNote')} <i className="bi bi-journal-text"></i>
          </summary>

          <div className="advancedPanel__content">
            <div className="field__hint">{t('experimentNoteHint')}</div>
            <label className="field field--full">
              <span className="field__label">{t('experimentNote')}</span>
              <textarea
                className="field__textarea"
                rows={4}
                value={runNote}
                onChange={(e) => setRunNote(e.target.value)}
                placeholder={t('experimentNotePlaceholder')}
              />
            </label>
          </div>
        </details>

        <BuilderErrorNotice
        t={t}
        uiError={uiError}
        uiLog={uiLog}
        setUiError={setUiError}
        setUiLog={setUiLog}
        copyToClipboard={copyToClipboard}
        />

        <BuilderActions
        t={t}
        builderMode={builderMode}
        labMode={labMode}
        isExecuting={isExecuting}
        onExecute={onExecute}
        onExecuteAllModes={onExecuteAllModes}
        onClearAll={onClearAll}
        />
      </div>

    </>
  )
}
