/**
 * Knowledge Base management tool.
 *
 * Provides CRUD operations for knowledge bases used by agentic retrieval.
 */

import { useCallback, useEffect, useId, useState } from 'react'
import type { ConnectionProfile } from '../../lib/model'
import type { KnowledgeBase } from '../../types'
import {
  listKnowledgeBases,
  getKnowledgeBase,
  createOrUpdateKnowledgeBase,
  deleteKnowledgeBase,
} from '../../lib/aiSearchRest'
import { InfoTooltip } from '../InfoTooltip'
import { translations, type Language } from '../../lib/translations'
import type { JsonValue } from '../../lib/aiSearchRest'
import { isJsonObject } from '../../app/json'
import { getSearchApiCapabilities } from '../../lib/searchApiCapabilities'
import { buildKnowledgeBaseBodyForApiVersion, isKnowledgeBaseModelKind, isMicrosoftRetriever1Only } from '../../utils/appRequestBodies'
import { NOVEMBER_KB_MODELS, validatedCompatibleModel } from '../../utils/agenticPreview'
import { KnowledgeBaseToolFields } from './KnowledgeBaseToolFields'

const SUPPORTED_MODEL_NAMES = [
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5.1',
  'gpt-5.2',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.5',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
] as const
const COMPATIBLE_LEGACY_MODEL_NAMES = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano'] as const

function modelParameters(model: JsonValue | undefined, key: string) {
  const value = isJsonObject(model) ? model[key] : undefined
  return isJsonObject(value) ? value : {}
}

function readString(value: JsonValue | undefined) {
  return typeof value === 'string' ? value : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isJsonValue)
  }
  return false
}

type KnowledgeBaseBuilderProps = {
  profile: ConnectionProfile | null
  onClose: () => void
  language: Language
  /** Selects the named knowledge base when `nonce` changes, for example from the dependency map. */
  focusRequest?: { name: string; nonce: number } | null
}

export function KnowledgeBaseBuilder({ profile, language, focusRequest }: KnowledgeBaseBuilderProps) {
  const t = useCallback((key: keyof typeof translations.ja) => translations[language][key], [language])
  const capabilities = getSearchApiCapabilities(profile?.apiVersion)
  const retrieverHintId = useId()

  const normalizeKnowledgeBase = useCallback((input: unknown): KnowledgeBase => {
    const kb: Record<string, unknown> = isRecord(input) ? input : {}
    const name = typeof kb.name === 'string' ? kb.name : ''
    const asNullableString = (v: unknown): string | null => (typeof v === 'string' ? v : null)
    const knowledgeSources = Array.isArray(kb.knowledgeSources)
      ? kb.knowledgeSources
          .map((x) => ({ name: isRecord(x) && typeof x.name === 'string' ? x.name : '' }))
          .filter((x) => x.name.trim().length > 0)
      : []

    return {
      name,
      description: asNullableString(kb.description),
      retrievalInstructions: asNullableString(kb.retrievalInstructions),
      answerInstructions: asNullableString(kb.answerInstructions),
      outputMode: (typeof kb.outputMode === 'string' ? kb.outputMode : null),
      knowledgeSources,
      models: (Array.isArray(kb.models) && kb.models.every(isJsonValue)) ? kb.models : [],
      tools: Array.isArray(kb.tools) && kb.tools.every(isJsonValue) ? kb.tools : undefined,
      encryptionKey: isJsonValue(kb.encryptionKey) ? kb.encryptionKey : null,
      retrievalReasoningEffort:
        isRecord(kb.retrievalReasoningEffort)
          ? { kind: typeof kb.retrievalReasoningEffort.kind === 'string' ? kb.retrievalReasoningEffort.kind : 'low' }
          : { kind: 'low' },
      retrieveDefaults: isRecord(kb.retrieveDefaults)
        ? {
            ...(typeof kb.retrieveDefaults.maxRuntimeInSeconds === 'number'
              ? { maxRuntimeInSeconds: kb.retrieveDefaults.maxRuntimeInSeconds }
              : {}),
            ...(typeof kb.retrieveDefaults.maxOutputDocuments === 'number'
              ? { maxOutputDocuments: kb.retrieveDefaults.maxOutputDocuments }
              : {}),
            ...(typeof kb.retrieveDefaults.maxOutputSizeInTokens === 'number'
              ? { maxOutputSizeInTokens: kb.retrieveDefaults.maxOutputSizeInTokens }
              : {}),
          }
        : undefined,
    }
  }, [])
  
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedBase, setSelectedBase] = useState<KnowledgeBase | null>(null)
  const [selectedEndpoint, setSelectedEndpoint] = useState('')
  const [compatibleHeaders, setCompatibleHeaders] = useState('')
  const [formData, setFormData] = useState<Partial<KnowledgeBase>>({
    name: '',
    description: null,
    retrievalInstructions: null,
    answerInstructions: null,
    outputMode: 'answerSynthesis',
    knowledgeSources: [],
    models: [],
    encryptionKey: null,
    retrievalReasoningEffort: { kind: 'low' },
    retrieveDefaults: undefined,
  })
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  useEffect(() => {
    setFormData((previous) => {
      const outputMode = capabilities.agenticResponseSynthesis ? previous.outputMode : 'extractiveData'
      const currentEffort = previous.retrievalReasoningEffort?.kind
      const effortKind = !capabilities.agenticResponseSynthesis
        ? 'minimal'
        : currentEffort === 'auto' && !capabilities.reasoningAuto
          ? 'low'
          : currentEffort
      if (outputMode === previous.outputMode && effortKind === currentEffort) return previous
      return {
        ...previous,
        outputMode,
        retrievalReasoningEffort: { kind: effortKind || 'low' },
      }
    })
  }, [capabilities.agenticResponseSynthesis, capabilities.reasoningAuto])

  const models = formData.models ?? []
  const hasRetriever = models.some((model) => isKnowledgeBaseModelKind(model, 'microsoftRetriever1'))
  const retrieverOnly = isMicrosoftRetriever1Only(models)
  const requiresRetrieverPreview = hasRetriever && !capabilities.microsoftRetriever1
  const canConfigureReasoningAndOutput = capabilities.agenticResponseSynthesis && !retrieverOnly
  const azureOpenAIModel = models.find((model) => isKnowledgeBaseModelKind(model, 'azureOpenAI'))
  const compatibleIndex = models.findIndex((model) => isKnowledgeBaseModelKind(model, 'openAICompatible'))
  const compatible = compatibleIndex >= 0
  const compatibleParams = modelParameters(models[compatibleIndex], 'openAICompatibleParameters')
  const compatibleModelName = readString(compatibleParams.modelName)
  const audience = readString(compatibleParams.managedIdentityAudience)
  const identity = isJsonObject(compatibleParams.authIdentity) ? compatibleParams.authIdentity : undefined
  const modelNames: readonly string[] = capabilities.novemberAgentic ? [...SUPPORTED_MODEL_NAMES, ...NOVEMBER_KB_MODELS] : SUPPORTED_MODEL_NAMES
  const compatibleModelNames: readonly string[] = [...COMPATIBLE_LEGACY_MODEL_NAMES, ...modelNames]
  const azureOpenAIParameters = isRecord(azureOpenAIModel) && isRecord(azureOpenAIModel.azureOpenAIParameters)
    ? azureOpenAIModel.azureOpenAIParameters
    : {}
  const modelName = typeof azureOpenAIParameters.modelName === 'string' ? azureOpenAIParameters.modelName : ''
  const deploymentId = typeof azureOpenAIParameters.deploymentId === 'string' ? azureOpenAIParameters.deploymentId : ''
  const resourceUri = typeof azureOpenAIParameters.resourceUri === 'string' ? azureOpenAIParameters.resourceUri : ''

  function setMicrosoftRetriever1(enabled: boolean) {
    setFormData((previous) => {
      const otherModels = (previous.models ?? []).filter((model) => !isKnowledgeBaseModelKind(model, 'microsoftRetriever1'))
      return { ...previous, models: enabled ? [...otherModels, { kind: 'microsoftRetriever1' }] : otherModels }
    })
  }

  function switchCompatibleModel(enabled: boolean) {
    setCompatibleHeaders('')
    setFormData((previous) => {
      const next = [...(previous.models ?? [])]
      const oldIndex = next.findIndex((model) => isKnowledgeBaseModelKind(model, enabled ? 'azureOpenAI' : 'openAICompatible'))
      if (enabled) {
        next[oldIndex < 0 ? next.length : oldIndex] = {
          kind: 'openAICompatible',
          openAICompatibleParameters: { uri: '', modelName: 'gpt-6-sol' },
        }
      } else if (oldIndex >= 0) {
        next.splice(oldIndex, 1)
      }
      return { ...previous, models: next }
    })
  }

  function updateCompatibleModel(patch: Record<string, JsonValue>) {
    setFormData((previous) => ({
      ...previous,
      models: previous.models?.map((model, i) => i === compatibleIndex && isJsonObject(model)
        ? { ...model, openAICompatibleParameters: { ...compatibleParams, ...patch } }
        : model),
    }))
  }

  function buildBody(updating: boolean): JsonValue {
    if (!compatible || !capabilities.novemberAgentic) {
      return buildKnowledgeBaseBodyForApiVersion(formData, profile?.apiVersion, language)
    }
    const original = selectedBase?.models[compatibleIndex]
    const originalParams = modelParameters(original, 'openAICompatibleParameters')
    const mayReuseHeaders = updating && !!profile && selectedEndpoint === profile.endpoint && selectedBase?.name === formData.name
      && original !== undefined && isKnowledgeBaseModelKind(original, 'openAICompatible')
      && originalParams.uri === compatibleParams.uri && originalParams.modelName === compatibleParams.modelName
      && !originalParams.managedIdentityAudience && !originalParams.authIdentity
    const params = validatedCompatibleModel(compatibleParams, compatibleHeaders, mayReuseHeaders)
    return buildKnowledgeBaseBodyForApiVersion({
      ...formData,
      models: models.map((model, i) => i === compatibleIndex && isJsonObject(model) ? { ...model, openAICompatibleParameters: params } : model),
    }, profile?.apiVersion, language)
  }

  function updateAzureOpenAIModel(patch: Record<string, string> | null) {
    setFormData((previous) => {
      const nextModels = [...(previous.models ?? [])]
      const index = nextModels.findIndex((model) => isKnowledgeBaseModelKind(model, 'azureOpenAI'))
      if (!patch) return { ...previous, models: nextModels.filter((model) => !isKnowledgeBaseModelKind(model, 'azureOpenAI')) }

      const original = nextModels[index]
      const model = original !== undefined && isJsonObject(original) ? original : {}
      const parameters = model.azureOpenAIParameters
      nextModels[index < 0 ? nextModels.length : index] = {
        ...model,
        kind: 'azureOpenAI',
        azureOpenAIParameters: { ...(parameters !== undefined && isJsonObject(parameters) ? parameters : {}), ...patch },
      }
      return { ...previous, models: nextModels }
    })
  }

  const loadKnowledgeBases = useCallback(async () => {
    if (!profile) return
    setLoading(true)
    try {
      const result = await listKnowledgeBases({ profile, language })
      if (result.ok && result.response) {
        const resp = result.response as JsonValue
        const value = (isRecord(resp) ? (resp as Record<string, unknown>).value : undefined)
        const raw = Array.isArray(value) ? value : []
        const items = raw.map(normalizeKnowledgeBase).filter((kb) => kb.name.trim().length > 0)
        setKnowledgeBases(items)
      }
    } catch (e) {
      console.error(e)
      setMessage({ type: 'error', text: `${t('failedToLoad')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }, [profile, language, normalizeKnowledgeBase, t])

  useEffect(() => {
    if (!profile) return
    void loadKnowledgeBases()
  }, [profile, loadKnowledgeBases])

  const handleCreate = async () => {
    if (!profile || !formData.name) {
      setMessage({ type: 'error', text: t('nameRequired') })
      return
    }
    setLoading(true)
    try {
      const body = buildBody(false)
      const result = await createOrUpdateKnowledgeBase({
        profile,
        knowledgeBaseName: formData.name,
        body,
        language,
      })
      if (result.ok) {
        setCompatibleHeaders('')
        setMessage({ type: 'success', text: `${t('created')}: ${formData.name}` })
        await loadKnowledgeBases()
        setFormData({
          name: '',
          description: null,
          retrievalInstructions: null,
          answerInstructions: null,
          outputMode: 'answerSynthesis',
          knowledgeSources: [],
          models: [],
          encryptionKey: null,
          retrievalReasoningEffort: { kind: 'low' },
          retrieveDefaults: undefined,
        })
      } else {
        setMessage({ type: 'error', text: compatibleHeaders ? `${t('compatibleSaveFailed')} (HTTP ${result.status})` : `${t('failed')}: ${result.error.message}` })
      }
    } catch (e) {
      setMessage({ type: 'error', text: `${t('error')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }

  const handleUpdate = async () => {
    if (!profile || !selectedBase || !formData.name) return
    setLoading(true)
    try {
      const body = buildBody(true)
      const result = await createOrUpdateKnowledgeBase({
        profile,
        knowledgeBaseName: formData.name,
        body,
        language,
      })
      if (result.ok) {
        setCompatibleHeaders('')
        setSelectedBase(normalizeKnowledgeBase(formData))
        setSelectedEndpoint(profile.endpoint)
        setMessage({ type: 'success', text: `${t('updated')}: ${formData.name}` })
        await loadKnowledgeBases()
      } else {
        setMessage({ type: 'error', text: compatibleHeaders ? `${t('compatibleSaveFailed')} (HTTP ${result.status})` : `${t('failed')}: ${result.error.message}` })
      }
    } catch (e) {
      setMessage({ type: 'error', text: `${t('error')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (name: string) => {
    if (!profile || !confirm(`${t('confirmDelete')} "${name}"?`)) return
    setLoading(true)
    try {
      const result = await deleteKnowledgeBase({ profile, knowledgeBaseName: name, language })
      if (result.ok) {
        setMessage({ type: 'success', text: `${t('deleted')}: ${name}` })
        await loadKnowledgeBases()
        if (selectedBase?.name === name) {
          setSelectedBase(null)
          setCompatibleHeaders('')
          setFormData({
            name: '',
            description: null,
            retrievalInstructions: null,
            answerInstructions: null,
            outputMode: 'answerSynthesis',
            knowledgeSources: [],
            models: [],
            encryptionKey: null,
            retrievalReasoningEffort: { kind: 'low' },
            retrieveDefaults: undefined,
          })
        }
      } else {
        setMessage({ type: 'error', text: `${t('failed')}: ${result.error.message}` })
      }
    } catch (e) {
      setMessage({ type: 'error', text: `${t('error')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }

  const handleSelectBase = async (name: string) => {
    if (!profile) return
    setCompatibleHeaders('')
    setLoading(true)
    try {
      const result = await getKnowledgeBase({ profile, knowledgeBaseName: name, language })
      if (result.ok && result.response) {
        const base = normalizeKnowledgeBase(result.response)
        setSelectedBase(base)
        setSelectedEndpoint(profile.endpoint)
        setFormData(base)
      }
    } catch (e) {
      console.error(e)
      setMessage({ type: 'error', text: `${t('failedToLoadBase')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }

  const focusNonce = focusRequest?.nonce
  useEffect(() => {
    if (!profile || !focusRequest) return
    void handleSelectBase(focusRequest.name)
    // Only a new request (nonce) selects a knowledge base; later renders must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, focusNonce])

  return (
    <div className="pane__centerContent">
      <div className="section">
        <div className="section__title">{t('knowledgeBaseBuilder')}</div>
        {message && (
          <div className={`notice notice--${message.type} builder__notice`}>
            {message.text}
          </div>
        )}
        <div className="builder__grid">
          <div>
            <div className="builder__sidebarTitle">{t('knowledgeBases')} ({knowledgeBases.length})</div>
            <button type="button" className="btn builder__refreshBtn" onClick={loadKnowledgeBases} disabled={loading}>
              <i className="bi bi-arrow-clockwise"></i> {t('refresh')}
            </button>
            <div className="builder__listBox">
              {knowledgeBases.map((kb) => (
                <div key={kb.name} className="builder-list-item">
                  <button
                    type="button"
                    className={`btn builder-list-item__btn ${selectedBase?.name === kb.name ? 'builder-list-item__btn--active' : ''}`}
                    onClick={() => handleSelectBase(kb.name)}
                    disabled={loading}
                  >
                    {kb.name}
                  </button>
                  <button
                    type="button"
                    className="btn builder-list-item__delete"
                    onClick={() => handleDelete(kb.name)}
                    disabled={loading}
                  >
                    <i className="bi bi-trash3"></i>
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="builder__editorTitle">
              {selectedBase ? `${t('edit')}: ${selectedBase.name}` : t('createNew')}
            </div>
            <div className="form" data-guide-target="knowledge-base-form">
              <label className="field">
                <span className="field__label">
                  {t('name')} *
                  <InfoTooltip tooltipKey="knowledgeBaseName" language={language} />
                </span>
                <input
                  className="field__input"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  disabled={!!selectedBase}
                />
              </label>
              <label className="field">
                <span className="field__label">
                  {t('description')}
                  <InfoTooltip tooltipKey="knowledgeBaseDescription" language={language} />
                </span>
                <textarea
                  className="field__textarea"
                  rows={2}
                  value={formData.description || ''}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </label>
              <div className="field field--full" data-guide-target="knowledge-base-retriever">
                <span className="field__label">
                  <label>
                    <input
                      type="checkbox"
                      checked={hasRetriever}
                      disabled={!capabilities.microsoftRetriever1}
                      aria-describedby={retrieverHintId}
                      onChange={(e) => setMicrosoftRetriever1(e.target.checked)}
                    />
                    {' '}{t('knowledgeBaseMicrosoftRetriever1')}
                  </label>
                  <InfoTooltip tooltipKey="knowledgeBaseMicrosoftRetriever1" language={language} />
                </span>
                <span className="field__hint" id={retrieverHintId}>{t(capabilities.microsoftRetriever1
                  ? 'knowledgeBaseMicrosoftRetriever1Hint'
                  : 'knowledgeBaseMicrosoftRetriever1Preview')}</span>
              </div>
              <label className="field">
                <span className="field__label">
                  {t('retrievalInstructions')}
                  <InfoTooltip tooltipKey="knowledgeBaseRetrievalInstructions" language={language} />
                </span>
                <textarea
                  className="field__textarea"
                  rows={3}
                  value={formData.retrievalInstructions || ''}
                  disabled={!capabilities.agenticResponseSynthesis}
                  onChange={(e) => setFormData({ ...formData, retrievalInstructions: e.target.value })}
                  placeholder={t('retrievalInstructionsPlaceholder')}
                />
              </label>
              <label className="field">
                <span className="field__label">
                  {t('answerInstructions')}
                  <InfoTooltip tooltipKey="knowledgeBaseAnswerInstructions" language={language} />
                </span>
                <textarea
                  className="field__textarea"
                  rows={2}
                  value={retrieverOnly ? '' : formData.answerInstructions || ''}
                  disabled={!canConfigureReasoningAndOutput}
                  onChange={(e) => setFormData({ ...formData, answerInstructions: e.target.value })}
                  placeholder={t('answerInstructionsPlaceholder')}
                />
              </label>
              <label className="field">
                <span className="field__label">
                  {t('outputMode')}
                  <InfoTooltip tooltipKey="outputMode" language={language} />
                </span>
                <select
                  className="field__input"
                  value={canConfigureReasoningAndOutput ? formData.outputMode || 'answerSynthesis' : 'extractiveData'}
                  disabled={!canConfigureReasoningAndOutput}
                  onChange={(e) => setFormData({ ...formData, outputMode: e.target.value })}
                >
                  <option value="answerSynthesis">Answer Synthesis</option>
                  <option value="extractiveData">Extractive Data</option>
                </select>
              </label>
              <label className="field" data-guide-target="knowledge-base-sources">
                <span className="field__label">
                  {t('knowledgeSourcesComma')}
                  <InfoTooltip tooltipKey="knowledgeBaseKnowledgeSources" language={language} />
                </span>
                <input
                  className="field__input"
                  value={formData.knowledgeSources?.map(ks => ks.name).join(',') || ''}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      knowledgeSources: e.target.value.split(',').filter(s => s.trim()).map(name => ({ name: name.trim() })),
                    })
                  }
                  placeholder={t('knowledgeSourcesPlaceholder')}
                />
              </label>
              <label className="field">
                <span className="field__label">
                  {t('retrievalReasoningEffortLabel')}
                  <InfoTooltip tooltipKey="retrievalReasoningEffort" language={language} />
                </span>
                <select
                  className="field__input"
                  value={!canConfigureReasoningAndOutput
                    ? 'minimal'
                    : formData.retrievalReasoningEffort?.kind === 'auto' && !capabilities.reasoningAuto
                      ? 'low'
                      : formData.retrievalReasoningEffort?.kind || 'low'}
                  disabled={!canConfigureReasoningAndOutput}
                  onChange={(e) => setFormData({ ...formData, retrievalReasoningEffort: { kind: e.target.value } })}
                >
                  <option value="minimal">{t('minimal')}</option>
                  <option value="low">{t('low')}</option>
                  <option value="medium">{t('medium')}</option>
                  <option value="auto" disabled={!capabilities.reasoningAuto}>auto</option>
                </select>
              </label>
              {(capabilities.novemberAgentic || compatible) && <label className="field field--full">
                <span className="field__label">
                  {t('knowledgeBaseModelProvider')}
                  <InfoTooltip tooltipKey="knowledgeBaseModelProvider" language={language} />
                </span>
                <select className="field__input" value={compatible ? 'compatible' : 'azure'} disabled={!capabilities.novemberAgentic}
                  onChange={(event) => switchCompatibleModel(event.target.value === 'compatible')}>
                  <option value="azure">Azure OpenAI</option>
                  <option value="compatible">{t('openAICompatibleModel')}</option>
                </select>
              </label>}
              {compatible ? <>
                <label className="field">
                  <span className="field__label">
                    {t('compatibleModelProfile')}
                    <InfoTooltip tooltipKey="compatibleModelProfile" language={language} />
                  </span>
                  <select className="field__input" value={compatibleModelName} disabled={!capabilities.novemberAgentic}
                    onChange={(event) => {
                      setCompatibleHeaders('')
                      updateCompatibleModel({ modelName: event.target.value })
                    }}>
                    {compatibleModelNames.map((name) => <option key={name}>{name}</option>)}
                    {!compatibleModelNames.includes(compatibleModelName) && <option value={compatibleModelName}>{compatibleModelName}</option>}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">
                    uri
                    <InfoTooltip tooltipKey="compatibleModelUri" language={language} />
                  </span>
                  <input className="field__input" type="url" value={readString(compatibleParams.uri)} disabled={!capabilities.novemberAgentic}
                    onChange={(event) => {
                      setCompatibleHeaders('')
                      updateCompatibleModel({ uri: event.target.value })
                    }} placeholder="https://gateway.example.com/v1/responses" />
                  <span className="field__hint">{t(NOVEMBER_KB_MODELS.some((name) => name === compatibleModelName) ? 'compatibleResponsesHint' : 'compatibleChatHint')}</span>
                </label>
                <label className="field">
                  <span className="field__label">
                    managedIdentityAudience
                    <InfoTooltip tooltipKey="compatibleManagedIdentityAudience" language={language} />
                  </span>
                  <input className="field__input" value={audience} disabled={!capabilities.novemberAgentic}
                    onChange={(event) => {
                      const value = event.target.value
                      setCompatibleHeaders('')
                      updateCompatibleModel({ managedIdentityAudience: value, ...(value ? {} : { authIdentity: null }) })
                    }} />
                </label>
                <label className="field">
                  <span className="field__label">
                    userAssignedIdentity
                    <InfoTooltip tooltipKey="compatibleUserAssignedIdentity" language={language} />
                  </span>
                  <input className="field__input" value={readString(identity?.userAssignedIdentity)} disabled={!capabilities.novemberAgentic || !audience.trim()}
                    onChange={(event) => updateCompatibleModel({ authIdentity: event.target.value ? {
                      '@odata.type': '#Microsoft.Azure.Search.DataUserAssignedIdentity',
                      userAssignedIdentity: event.target.value,
                    } : null })} />
                </label>
                <label className="field field--full">
                  <span className="field__label">
                    {t('compatibleAuthenticationHeaders')}
                    <InfoTooltip tooltipKey="compatibleAuthenticationHeaders" language={language} />
                  </span>
                  <input className="field__input" type="password" autoComplete="off" spellCheck={false} value={compatibleHeaders}
                    disabled={!capabilities.novemberAgentic || !!audience.trim()} onChange={(event) => setCompatibleHeaders(event.target.value)} />
                  <span className="field__hint">{t('compatibleHeadersHint')}</span>
                </label>
              </> : <>
              <label className="field">
                <span className="field__label">
                  {t('knowledgeBaseModelName')}
                  <InfoTooltip tooltipKey="knowledgeBaseModelName" language={language} />
                </span>
                <select
                  className="field__input"
                  value={modelName}
                  disabled={!capabilities.retrieveDefaults}
                  onChange={(e) => {
                    if (!e.target.value) {
                      updateAzureOpenAIModel(null)
                      return
                    }
                    updateAzureOpenAIModel({
                      modelName: e.target.value,
                      deploymentId: deploymentId || e.target.value,
                    })
                  }}
                >
                  <option value="">{t('optionNone')}</option>
                  {modelNames.map((name) => <option key={name} value={name}>{name}</option>)}
                  {modelName && !modelNames.includes(modelName) && (
                    <option value={modelName}>{modelName}</option>
                  )}
                </select>
              </label>
              <label className="field">
                <span className="field__label">
                  resourceUri
                  <InfoTooltip tooltipKey="knowledgeBaseModelResourceUri" language={language} />
                </span>
                <input
                  className="field__input"
                  value={resourceUri}
                  disabled={!capabilities.retrieveDefaults || !modelName}
                  onChange={(e) => updateAzureOpenAIModel({ resourceUri: e.target.value })}
                  placeholder="https://{resource}.openai.azure.com"
                />
              </label>
              <label className="field">
                <span className="field__label">
                  deploymentId
                  <InfoTooltip tooltipKey="knowledgeBaseModelDeploymentId" language={language} />
                </span>
                <input
                  className="field__input"
                  value={deploymentId}
                  disabled={!capabilities.retrieveDefaults || !modelName}
                  onChange={(e) => updateAzureOpenAIModel({ deploymentId: e.target.value })}
                />
              </label>
              </>}
              {capabilities.novemberAgentic && <KnowledgeBaseToolFields
                tools={formData.tools ?? []} sources={(formData.knowledgeSources ?? []).map(({ name }) => name)} t={t} language={language}
                onChange={(tools) => setFormData((previous) => ({ ...previous, tools }))}
              />}
              <div className="field field--full">
                <span className="field__label">
                  {t('retrieveDefaults')}
                  <InfoTooltip tooltipKey="retrieveDefaults" language={language} />
                </span>
                <div className="form">
                  {(['maxRuntimeInSeconds', 'maxOutputDocuments', 'maxOutputSizeInTokens'] as const).map((key) => (
                    <label className="field" key={key}>
                      <span className="field__label">
                        {key}
                        <InfoTooltip tooltipKey={key === 'maxOutputDocuments' ? 'retrieveMaxOutputDocuments' : key} language={language} />
                      </span>
                      <input
                        className="field__input"
                        type="number"
                        min={1}
                        value={formData.retrieveDefaults?.[key] ?? ''}
                        disabled={!capabilities.retrieveDefaults}
                        onChange={(e) => setFormData({
                          ...formData,
                          retrieveDefaults: {
                            ...formData.retrieveDefaults,
                            [key]: e.target.value === '' ? undefined : Number(e.target.value),
                          },
                        })}
                      />
                    </label>
                  ))}
                </div>
              </div>
              {!capabilities.retrieveDefaults && (
                <div className="notice notice--info field--full">{t('agenticAugustPreviewRequired')}</div>
              )}
            </div>
            <div className="actions builder__actions" data-guide-target="knowledge-base-actions">
              {selectedBase ? (
                <button type="button" className="btn" onClick={handleUpdate} disabled={loading || requiresRetrieverPreview}>
                  <i className="bi bi-pencil icon--mr6"></i> {t('update')}
                </button>
              ) : (
                <button type="button" className="btn" onClick={handleCreate} disabled={loading || requiresRetrieverPreview}>
                  <i className="bi bi-pencil icon--mr6"></i> {t('create')}
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSelectedBase(null)
                  setCompatibleHeaders('')
                  setFormData({
                    name: '',
                    description: null,
                    retrievalInstructions: null,
                    answerInstructions: null,
                    outputMode: 'answerSynthesis',
                    knowledgeSources: [],
                    models: [],
                    encryptionKey: null,
                    retrievalReasoningEffort: { kind: 'low' },
                  })
                }}
              >
                <i className="bi bi-plus-circle icon--mr6"></i> {t('new')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
