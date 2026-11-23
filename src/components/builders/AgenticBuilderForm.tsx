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
import { TopicGraphFields } from './TopicGraphFields'
import type { KnowledgeBaseToolInfo } from '../../utils/agenticPreview'

type TranslationKey = keyof typeof translations.ja

export type AgenticBuilderFormProps = {
  t: (key: TranslationKey) => string
  language: Language

  agenticForm: AgenticFormState
  setAgenticForm: React.Dispatch<React.SetStateAction<AgenticFormState>>

  availableKnowledgeSources: KnowledgeSourceInfo[]
  availableKnowledgeTools?: KnowledgeBaseToolInfo[]
  effectiveApiVersion: string
}

export function AgenticBuilderForm(props: AgenticBuilderFormProps) {
  const { t, language, agenticForm, setAgenticForm, availableKnowledgeSources, availableKnowledgeTools = [], effectiveApiVersion } = props
  const capabilities = getSearchApiCapabilities(effectiveApiVersion)
  const activeTool = availableKnowledgeTools.find((tool) => tool.name === agenticForm.toolName)
  const visibleSources = agenticForm.toolName
    ? availableKnowledgeSources.filter((source) => activeTool?.sources.includes(source.name) || (!activeTool && agenticForm.knowledgeSourceParams.some((param) => param.knowledgeSourceName === source.name)))
    : availableKnowledgeSources
  const inheritToolDefaults = !!agenticForm.toolName && agenticForm.useToolDefaults !== false
  const useSeparateTokenLimit = capabilities.novemberAgentic

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

  const outputSizeField = (
    <label className="field">
      <span className="field__label">
        {capabilities.agenticResponseSynthesis ? 'maxOutputSize' : 'maxOutputSizeInTokens'}
        <InfoTooltip tooltipKey="maxOutputSize" language={language} />
      </span>
      <input
        className="field__input"
        type="number"
        min={1000}
        max={1000000}
        value={agenticForm.maxOutputSize}
        disabled={inheritToolDefaults}
        onChange={(e) => setAgenticForm((p) => ({ ...p, maxOutputSize: Number(e.target.value) }))}
      />
    </label>
  )

  return (
    <div className="form form--agentic">
      {capabilities.novemberAgentic && <>
        <label className="field">
          <span className="field__label">
            {t('knowledgeBaseTool')}
            <InfoTooltip tooltipKey="knowledgeBaseToolName" language={language} />
          </span>
          <select className="field__input" value={agenticForm.toolName ?? ''} onChange={(event) => {
            const toolName = event.target.value
            const tool = availableKnowledgeTools.find(({ name }) => name === toolName)
            setAgenticForm((previous) => ({
              ...previous, toolName, useToolDefaults: true, knowledgeSourceParams: [],
              ...(tool ? { retrievalReasoningEffort: tool.reasoningEffort } : {}),
            }))
          }}>
            <option value="">{t('knowledgeBaseWide')}</option>
            {availableKnowledgeTools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name}</option>)}
            {agenticForm.toolName && !activeTool && <option value={agenticForm.toolName}>{agenticForm.toolName}</option>}
          </select>
        </label>
        {agenticForm.toolName && <label className="field">
          <span className="field__label">
            <input type="checkbox" checked={inheritToolDefaults} onChange={(event) => {
              const checked = event.target.checked
              setAgenticForm((previous) => ({
                ...previous, useToolDefaults: checked,
                ...(checked && activeTool ? { retrievalReasoningEffort: activeTool.reasoningEffort } : {}),
              }))
            }} />
            {' '}{t('knowledgeBaseToolDefaults')}
            <InfoTooltip tooltipKey="knowledgeBaseToolDefaults" language={language} />
          </span>
        </label>}
      </>}
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
          disabled={!capabilities.agenticResponseSynthesis || inheritToolDefaults}
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
          disabled={inheritToolDefaults}
          onChange={(e) => setAgenticForm((p) => ({ ...p, maxRuntimeInSeconds: Number(e.target.value) }))}
          min={1}
          max={600}
        />
      </label>

      <div className="form field--full agenticReasoningFields">
        <label className="field">
          <span className="field__label">
            retrievalReasoningEffort.kind
            <InfoTooltip tooltipKey="retrievalReasoningEffort" language={language} />
          </span>
          <select
            className="field__input"
            value={capabilities.agenticResponseSynthesis ? agenticForm.retrievalReasoningEffort : 'minimal'}
            disabled={!capabilities.agenticResponseSynthesis || inheritToolDefaults}
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
        {useSeparateTokenLimit ? (
          <label className="field">
            <span className="field__label">
              maxOutputSizeInTokens
              <InfoTooltip tooltipKey="maxOutputSizeInTokens" language={language} />
            </span>
            <input
              className="field__input"
              type="number"
              min={1}
              max={2147483647}
              value={agenticForm.maxOutputSizeInTokens ?? ''}
              disabled={inheritToolDefaults}
              onChange={(event) => {
                const value = event.target.value
                setAgenticForm((p) => ({ ...p, maxOutputSizeInTokens: value === '' ? '' : Number(value) }))
              }}
            />
          </label>
        ) : outputSizeField}
      </div>

      {useSeparateTokenLimit && <>
        {outputSizeField}
        <label className="field">
          <span className="field__label">
            maxOutputDocuments
            <InfoTooltip tooltipKey="retrieveMaxOutputDocuments" language={language} />
          </span>
          <input className="field__input" type="number" min={1} max={2147483647} value={agenticForm.maxOutputDocuments ?? ''}
            disabled={inheritToolDefaults} onChange={(event) => {
              const value = event.target.value
              setAgenticForm((p) => ({ ...p, maxOutputDocuments: value === '' ? '' : Number(value) }))
            }} />
        </label>
      </>}

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

        {visibleSources.length === 0 && (
          <div className="agenticKs__empty">{t('noKnowledgeSources')}</div>
        )}

        {visibleSources.map((sourceInfo) => {
          const sourceName = sourceInfo.name
          const sourceKind = sourceInfo.kind
          const existingParam = agenticForm.knowledgeSourceParams.find((p) => p.knowledgeSourceName === sourceName)
          const hasRequestOverrides = !!existingParam
          const supportsQueryHints = sourceKind === 'searchIndex'
          const supportsIndexOverrides = capabilities.novemberAgentic && (sourceKind === 'searchIndex' || sourceKind === 'azureBlob')
          const supportsEntityGraph = capabilities.novemberAgentic && sourceKind === 'azureBlob'

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
                              alwaysQuerySource: capabilities.novemberAgentic ? undefined : false,
                              neverQuerySource: false,
                              resultsProcessing: capabilities.novemberAgentic ? '' : 'rerank',
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
                  <div className="agenticKsItem__groups">
                    <fieldset className="agenticKsGroup">
                      <legend>{t('knowledgeSourceReferenceSettings')}</legend>
                      <div className="agenticKsGroup__checks">
                        {(['includeReferences', 'includeReferenceSourceData'] as const).map((key) => (
                          <label className="agenticKsOption" key={key}>
                            <input
                              type="checkbox"
                              checked={existingParam[key]}
                              onChange={(e) => updateSourceParam(sourceName, { [key]: e.target.checked })}
                            />
                            <span>{t(key)}<InfoTooltip tooltipKey={key} language={language} /></span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    <fieldset className="agenticKsGroup">
                      <legend>{t('knowledgeSourceRetrievalSettings')}</legend>
                      <div className="agenticKsGroup__checks agenticKsGroup__checks--inline">
                        <label className="agenticKsOption">
                          <input
                            type="checkbox"
                            checked={existingParam.alwaysQuerySource ?? false}
                            disabled={!capabilities.alwaysQuerySource}
                            onChange={(e) => updateSourceParam(sourceName, {
                              alwaysQuerySource: e.target.checked,
                              ...(e.target.checked ? { neverQuerySource: false } : {}),
                            })}
                          />
                          <span>{t('alwaysQuerySource')}<InfoTooltip tooltipKey="alwaysQuerySource" language={language} /></span>
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
                          />
                          <span>{t('neverQuerySource')}<InfoTooltip tooltipKey="neverQuerySource" language={language} /></span>
                        </label>
                      </div>
                      <div className="agenticKsGroup__fields">
                        <label className="field">
                          <span className="field__label">
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
                            {capabilities.novemberAgentic && <option value="">{t('inheritDefaults')}</option>}
                            <option value="rerank">rerank</option>
                            <option value="none">none</option>
                          </select>
                        </label>
                        <label className="field">
                          <span className="field__label">
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
                        {supportsIndexOverrides && (
                          <label className="field field--full">
                            <span className="field__label">
                              filterAddOn
                              <InfoTooltip tooltipKey="knowledgeSourceFilterAddOn" language={language} />
                            </span>
                            <input className="field__input" value={existingParam.filterAddOn ?? ''} onChange={(e) => updateSourceParam(sourceName, {
                              filterAddOn: e.target.value,
                            })} />
                          </label>
                        )}
                        {supportsQueryHints && (
                          <label className="field field--full">
                            <span className="field__label">
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
                    </fieldset>
                  </div>
                  {supportsIndexOverrides && (
                    <div className="agenticKsItem__groups agenticKsItem__groups--graphs">
                      <fieldset className="agenticKsGroup agenticKsGroup--topic">
                        <legend>{t('knowledgeSourceTopicGraphSettings')}</legend>
                        <div className="agenticKsGroup__fields">
                          <TopicGraphFields
                            t={t}
                            language={language}
                            value={existingParam.topicGraph}
                            onChange={(topicGraph) => updateSourceParam(sourceName, { topicGraph })}
                          />
                        </div>
                      </fieldset>
                      {supportsEntityGraph && (
                        <fieldset className="agenticKsGroup">
                          <legend>{t('knowledgeSourceEntityGraphSettings')}</legend>
                          <div className="agenticKsGroup__checks">
                            <label className="agenticKsOption">
                              <input type="checkbox" checked={existingParam.graphParameters?.includeQuery ?? false} onChange={(event) => updateSourceParam(sourceName, {
                                graphParameters: { ...existingParam.graphParameters, includeQuery: event.target.checked },
                                ...(event.target.checked ? { includeReferences: true, includeReferenceSourceData: true } : {}),
                              })} />
                              <span>
                                {t('actGraphSearchGql')} (includeQuery)
                                <InfoTooltip tooltipKey="graphIncludeQuery" language={language} />
                              </span>
                            </label>
                            <label className="agenticKsOption">
                              <input type="checkbox" checked={existingParam.graphParameters?.provenance?.kind === 'hydrate'} onChange={(event) => updateSourceParam(sourceName, {
                                graphParameters: { ...existingParam.graphParameters, provenance: { kind: event.target.checked ? 'hydrate' : 'none' } },
                                ...(event.target.checked ? { includeReferences: true, includeReferenceSourceData: true } : {}),
                              })} />
                              <span>
                                {t('graphHydrateSources')}
                                <InfoTooltip tooltipKey="graphHydrateSources" language={language} />
                              </span>
                            </label>
                          </div>
                          {existingParam.graphParameters?.provenance?.kind === 'hydrate' && (
                            <div className="agenticKsGroup__fields agenticKsGroup__fields--dependent">
                              {(['select', 'top'] as const).map((field) => <label className="field" key={field}>
                                <span className="field__label">
                                  hydrateDocuments.{field}
                                  <InfoTooltip tooltipKey={field === 'top' ? 'graphHydrateTop' : 'graphHydrateSelect'} language={language} />
                                </span>
                                <input className="field__input" type={field === 'top' ? 'number' : 'text'} min={1} max={100}
                                  value={existingParam.graphParameters?.provenance?.hydrateDocuments?.[field] ?? ''}
                                  onChange={(event) => {
                                    const value = event.target.value
                                    updateSourceParam(sourceName, { graphParameters: {
                                      ...existingParam.graphParameters,
                                      provenance: { kind: 'hydrate', hydrateDocuments: {
                                        ...existingParam.graphParameters?.provenance?.hydrateDocuments,
                                        ...(field === 'top' ? { top: value === '' ? undefined : Number(value) } : { select: value }),
                                      } },
                                    } })
                                  }} />
                              </label>)}
                            </div>
                          )}
                        </fieldset>
                      )}
                    </div>
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
