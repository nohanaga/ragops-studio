/**
 * Agentic (knowledge retrieval) request builder form.
 *
 * Collects the user message and related parameters used to call the agentic
 * retrieval endpoints.
 */

import type React from 'react'
import { useEffect } from 'react'

import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import { getSearchApiCapabilities } from '../../lib/searchApiCapabilities'
import type { AgenticFormState, KnowledgeSourceInfo, KnowledgeSourceParamItem } from '../../types'
import { InfoTooltip } from '../InfoTooltip'

type TranslationKey = keyof typeof translations.ja

export type AgenticBuilderFormProps = {
  t: (key: TranslationKey) => string
  language: Language

  agenticForm: AgenticFormState
  setAgenticForm: React.Dispatch<React.SetStateAction<AgenticFormState>>

  availableKnowledgeSources: KnowledgeSourceInfo[]
  effectiveApiVersion: string
}

export function AgenticBuilderForm(props: AgenticBuilderFormProps) {
  const { t, language, agenticForm, setAgenticForm, availableKnowledgeSources, effectiveApiVersion } = props
  const capabilities = getSearchApiCapabilities(effectiveApiVersion)

  useEffect(() => {
    setAgenticForm((previous) => {
      const streamResponse = capabilities.agenticStreaming ? previous.streamResponse : false
      const outputMode = capabilities.agenticResponseSynthesis ? previous.outputMode : 'extractiveData'
      const retrievalReasoningEffort = !capabilities.agenticResponseSynthesis
        ? 'minimal'
        : previous.retrievalReasoningEffort === 'auto' && !capabilities.reasoningAuto
          ? 'low'
          : previous.retrievalReasoningEffort

      if (
        streamResponse === previous.streamResponse
        && outputMode === previous.outputMode
        && retrievalReasoningEffort === previous.retrievalReasoningEffort
      ) {
        return previous
      }
      return { ...previous, streamResponse, outputMode, retrievalReasoningEffort }
    })
  }, [
    capabilities.agenticResponseSynthesis,
    capabilities.agenticStreaming,
    capabilities.reasoningAuto,
    setAgenticForm,
  ])

  function updateSourceParam(sourceName: string, patch: Partial<KnowledgeSourceParamItem>) {
    setAgenticForm((previous) => ({
      ...previous,
      knowledgeSourceParams: previous.knowledgeSourceParams.map((param) =>
        param.knowledgeSourceName === sourceName ? { ...param, ...patch } : param,
      ),
    }))
  }

  return (
    <div className="form">
      <label className="field field--full" data-guide-target="agentic-messages">
        <span className="field__label">
          user message
          <InfoTooltip tooltipKey="userMessage" language={language} />
        </span>
        <textarea
          className="field__textarea"
          rows={4}
          value={agenticForm.userMessage}
          onChange={(e) => setAgenticForm((p) => ({ ...p, userMessage: e.target.value }))}
          placeholder="..."
        />
      </label>

      <label className="field">
        <span className="field__label">
          includeActivity
          <InfoTooltip tooltipKey="includeActivity" language={language} />
        </span>
        <select
          className="field__input"
          value={agenticForm.includeActivity ? 'true' : 'false'}
          onChange={(e) => setAgenticForm((p) => ({ ...p, includeActivity: e.target.value === 'true' }))}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">
          {t('streamResponse')}
          <InfoTooltip tooltipKey="streamResponse" language={language} />
        </span>
        <select
          className="field__input"
          value={capabilities.agenticStreaming && agenticForm.streamResponse ? 'true' : 'false'}
          disabled={!capabilities.agenticStreaming}
          onChange={(e) => setAgenticForm((p) => ({ ...p, streamResponse: e.target.value === 'true' }))}
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">
          outputMode
          <InfoTooltip tooltipKey="outputMode" language={language} />
        </span>
        <select
          className="field__input"
          value={capabilities.agenticResponseSynthesis ? agenticForm.outputMode : 'extractiveData'}
          disabled={!capabilities.agenticResponseSynthesis}
          onChange={(e) => setAgenticForm((p) => ({ ...p, outputMode: e.target.value as AgenticFormState['outputMode'] }))}
        >
          <option value="extractiveData">extractiveData</option>
          <option value="answerSynthesis">answerSynthesis</option>
        </select>
      </label>

      <label className="field">
        <span className="field__label">
          maxRuntimeInSeconds
          <InfoTooltip tooltipKey="maxRuntimeInSeconds" language={language} />
        </span>
        <input
          className="field__input"
          type="number"
          value={agenticForm.maxRuntimeInSeconds}
          onChange={(e) => setAgenticForm((p) => ({ ...p, maxRuntimeInSeconds: Number(e.target.value) }))}
          min={1}
          max={600}
        />
      </label>

      <label className="field">
        <span className="field__label">
          {capabilities.agenticResponseSynthesis ? 'maxOutputSize' : 'maxOutputSizeInTokens'}
          <InfoTooltip tooltipKey="maxOutputSize" language={language} />
        </span>
        <input
          className="field__input"
          type="number"
          value={agenticForm.maxOutputSize}
          onChange={(e) => setAgenticForm((p) => ({ ...p, maxOutputSize: Number(e.target.value) }))}
          min={1000}
          max={1000000}
        />
      </label>

      <label className="field field--full">
        <span className="field__label">
          retrievalReasoningEffort.kind
          <InfoTooltip tooltipKey="retrievalReasoningEffort" language={language} />
        </span>
        <select
          className="field__input"
          value={capabilities.agenticResponseSynthesis ? agenticForm.retrievalReasoningEffort : 'minimal'}
          disabled={!capabilities.agenticResponseSynthesis}
          onChange={(e) =>
            setAgenticForm((p) => ({
              ...p,
              retrievalReasoningEffort: e.target.value as AgenticFormState['retrievalReasoningEffort'],
            }))
          }
        >
          <option value="minimal">minimal</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="auto" disabled={!capabilities.reasoningAuto}>auto</option>
        </select>
      </label>

      {!capabilities.agenticStreaming && (
        <div className="notice notice--info field--full">{t('agenticAugustPreviewRequired')}</div>
      )}

      {/* Knowledge Source Params */}
      <div className="agenticKs">
        <div className="agenticKs__title">{t('knowledgeSourceParams')}</div>
        <div className="agenticKs__desc">
          <div className="agenticKs__descItem">{t('knowledgeSourceParamsDesc1')}</div>
          <div className="agenticKs__descItem">{t('knowledgeSourceParamsDesc2')}</div>
          <div>{t('knowledgeSourceParamsDesc3')}</div>
        </div>

        {availableKnowledgeSources.length === 0 && (
          <div className="agenticKs__empty">{t('noKnowledgeSources')}</div>
        )}

        {availableKnowledgeSources.map((sourceInfo) => {
          const sourceName = sourceInfo.name
          const sourceKind = sourceInfo.kind
          const existingParam = agenticForm.knowledgeSourceParams.find((p) => p.knowledgeSourceName === sourceName)
          const hasRequestOverrides = !!existingParam
          const supportsQueryHints = sourceKind === 'searchIndex'

          return (
            <div key={sourceName} className={'agenticKsItem' + (hasRequestOverrides ? ' agenticKsItem--overridden' : '')}>
              <div className="agenticKsItem__header">
                <div className="agenticKsItem__identity">
                  <span className="agenticKsItem__name">{sourceName}</span>
                  <span className="agenticKsItem__kind">{sourceKind}</span>
                </div>
                <label className="agenticKsItem__override">
                  <input
                    type="checkbox"
                    checked={hasRequestOverrides}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setAgenticForm((p) => ({
                          ...p,
                          knowledgeSourceParams: [
                            ...p.knowledgeSourceParams,
                            {
                              knowledgeSourceName: sourceName,
                              kind: sourceKind,
                              includeReferences: true,
                              includeReferenceSourceData: false,
                              alwaysQuerySource: false,
                              neverQuerySource: false,
                              resultsProcessing: 'rerank',
                              maxOutputDocuments: '',
                              queryHintOverrides: '',
                            },
                          ],
                        }))
                      } else {
                        setAgenticForm((p) => ({
                          ...p,
                          knowledgeSourceParams: p.knowledgeSourceParams.filter(
                            (param) => param.knowledgeSourceName !== sourceName,
                          ),
                        }))
                      }
                    }}
                    className="agenticKsItem__checkbox"
                  />
                  <span>{t('knowledgeSourceRequestOverride')}</span>
                </label>
              </div>

              {hasRequestOverrides && existingParam && (
                <div className="agenticKsItem__options">
                  <label className="agenticKsOption">
                    <input
                      type="checkbox"
                      checked={existingParam.includeReferences}
                      onChange={(e) => {
                        setAgenticForm((p) => ({
                          ...p,
                          knowledgeSourceParams: p.knowledgeSourceParams.map((param) =>
                            param.knowledgeSourceName === sourceName
                              ? { ...param, includeReferences: e.target.checked }
                              : param,
                          ),
                        }))
                      }}
                      className="agenticKsOption__checkbox"
                    />
                    includeReferences
                    <InfoTooltip tooltipKey="includeReferences" language={language} />
                  </label>

                  <label className="agenticKsOption">
                    <input
                      type="checkbox"
                      checked={existingParam.includeReferenceSourceData}
                      onChange={(e) => {
                        setAgenticForm((p) => ({
                          ...p,
                          knowledgeSourceParams: p.knowledgeSourceParams.map((param) =>
                            param.knowledgeSourceName === sourceName
                              ? { ...param, includeReferenceSourceData: e.target.checked }
                              : param,
                          ),
                        }))
                      }}
                      className="agenticKsOption__checkbox"
                    />
                    includeReferenceSourceData
                    <InfoTooltip tooltipKey="includeReferenceSourceData" language={language} />
                  </label>

                  <label className="agenticKsOption">
                    <input
                      type="checkbox"
                      checked={existingParam.alwaysQuerySource}
                      disabled={!capabilities.alwaysQuerySource}
                      onChange={(e) => {
                        updateSourceParam(sourceName, {
                          alwaysQuerySource: e.target.checked,
                          ...(e.target.checked ? { neverQuerySource: false } : {}),
                        })
                      }}
                      className="agenticKsOption__checkbox"
                    />
                    alwaysQuerySource
                    <InfoTooltip tooltipKey="alwaysQuerySource" language={language} />
                  </label>

                  <label className="agenticKsOption">
                    <input
                      type="checkbox"
                      checked={existingParam.neverQuerySource}
                      disabled={!capabilities.perSourceResultsProcessing}
                      onChange={(e) => updateSourceParam(sourceName, {
                        neverQuerySource: e.target.checked,
                        ...(e.target.checked ? { alwaysQuerySource: false } : {}),
                      })}
                      className="agenticKsOption__checkbox"
                    />
                    {t('neverQuerySource')}
                    <InfoTooltip tooltipKey="neverQuerySource" language={language} />
                  </label>

                  <label className="agenticKsOption agenticKsOption--field">
                    <span>
                      {t('resultsProcessing')}
                      <InfoTooltip tooltipKey="resultsProcessing" language={language} />
                    </span>
                    <select
                      className="field__input"
                      value={existingParam.resultsProcessing}
                      disabled={!capabilities.perSourceResultsProcessing}
                      onChange={(e) => updateSourceParam(sourceName, {
                        resultsProcessing: e.target.value as KnowledgeSourceParamItem['resultsProcessing'],
                      })}
                    >
                      <option value="rerank">rerank</option>
                      <option value="none">none</option>
                    </select>
                  </label>

                  <label className="agenticKsOption agenticKsOption--field">
                    <span>
                      {t('maxOutputDocuments')}
                      <InfoTooltip tooltipKey="maxOutputDocuments" language={language} />
                    </span>
                    <input
                      className="field__input"
                      type="number"
                      min={1}
                      value={existingParam.maxOutputDocuments}
                      disabled={!capabilities.perSourceResultsProcessing}
                      onChange={(e) => updateSourceParam(sourceName, {
                        maxOutputDocuments: e.target.value === '' ? '' : Number(e.target.value),
                      })}
                    />
                  </label>

                  {supportsQueryHints && (
                    <label className="agenticKsOption agenticKsOption--field agenticKsOption--wide">
                      <span>
                        {t('queryHintOverrides')}
                        <InfoTooltip tooltipKey="queryHintOverrides" language={language} />
                      </span>
                      <textarea
                        className="field__textarea mono"
                        rows={4}
                        value={existingParam.queryHintOverrides}
                        disabled={!capabilities.queryHints}
                        onChange={(e) => updateSourceParam(sourceName, { queryHintOverrides: e.target.value })}
                        placeholder={'{\n  "filters": [],\n  "boosts": []\n}'}
                      />
                    </label>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
