/**
 * Agentic (knowledge retrieval) request builder form.
 *
 * Collects the user message and related parameters used to call the agentic
 * retrieval endpoints.
 */

import type React from 'react'

import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import type { AgenticFormState } from '../../types'
import { InfoTooltip } from '../InfoTooltip'

type TranslationKey = keyof typeof translations.ja

export type AgenticBuilderFormProps = {
  t: (key: TranslationKey) => string
  language: Language

  agenticForm: AgenticFormState
  setAgenticForm: React.Dispatch<React.SetStateAction<AgenticFormState>>

  availableKnowledgeSources: string[]
}

export function AgenticBuilderForm(props: AgenticBuilderFormProps) {
  const { t, language, agenticForm, setAgenticForm, availableKnowledgeSources } = props

  return (
    <div className="form">
      <label className="field field--full">
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
          outputMode
          <InfoTooltip tooltipKey="outputMode" language={language} />
        </span>
        <select
          className="field__input"
          value={agenticForm.outputMode}
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
          maxOutputSize
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
          value={agenticForm.retrievalReasoningEffort}
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
        </select>
      </label>

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

        {availableKnowledgeSources.map((sourceName) => {
          const existingParam = agenticForm.knowledgeSourceParams.find((p) => p.knowledgeSourceName === sourceName)
          const isSelected = !!existingParam

          return (
            <div key={sourceName} className={'agenticKsItem' + (isSelected ? ' agenticKsItem--selected' : '')}>
              <label className="agenticKsItem__header">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setAgenticForm((p) => ({
                        ...p,
                        knowledgeSourceParams: [
                          ...p.knowledgeSourceParams,
                          {
                            knowledgeSourceName: sourceName,
                            includeReferences: true,
                            includeReferenceSourceData: false,
                            alwaysQuerySource: false,
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
                <span className="agenticKsItem__name">{sourceName}</span>
              </label>

              {isSelected && existingParam && (
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
                      onChange={(e) => {
                        setAgenticForm((p) => ({
                          ...p,
                          knowledgeSourceParams: p.knowledgeSourceParams.map((param) =>
                            param.knowledgeSourceName === sourceName
                              ? { ...param, alwaysQuerySource: e.target.checked }
                              : param,
                          ),
                        }))
                      }}
                      className="agenticKsOption__checkbox"
                    />
                    alwaysQuerySource
                    <InfoTooltip tooltipKey="alwaysQuerySource" language={language} />
                  </label>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
