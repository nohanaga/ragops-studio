/**
 * Knowledge Base management tool.
 *
 * Provides CRUD operations for knowledge bases used by agentic retrieval.
 */

import { useCallback, useEffect, useState } from 'react'
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
}

export function KnowledgeBaseBuilder({ profile, language }: KnowledgeBaseBuilderProps) {
  const t = useCallback((key: keyof typeof translations.ja) => translations[language][key], [language])

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
      encryptionKey: isJsonValue(kb.encryptionKey) ? kb.encryptionKey : null,
      retrievalReasoningEffort:
        isRecord(kb.retrievalReasoningEffort)
          ? { kind: typeof kb.retrievalReasoningEffort.kind === 'string' ? kb.retrievalReasoningEffort.kind : 'low' }
          : { kind: 'low' },
    }
  }, [])
  
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedBase, setSelectedBase] = useState<KnowledgeBase | null>(null)
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
  })
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

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
      const body: JsonValue = {
        name: formData.name,
        description: formData.description || null,
        retrievalInstructions: formData.retrievalInstructions || null,
        answerInstructions: formData.answerInstructions || null,
        outputMode: formData.outputMode || 'answerSynthesis',
        knowledgeSources: formData.knowledgeSources || [],
        models: formData.models || [],
        encryptionKey: null,
        retrievalReasoningEffort: formData.retrievalReasoningEffort || { kind: 'low' },
      }
      const result = await createOrUpdateKnowledgeBase({
        profile,
        knowledgeBaseName: formData.name,
        body,
        language,
      })
      if (result.ok) {
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
        })
      } else {
        setMessage({ type: 'error', text: `${t('failed')}: ${result.error.message}` })
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
      const body: JsonValue = {
        name: formData.name,
        description: formData.description || null,
        retrievalInstructions: formData.retrievalInstructions || null,
        answerInstructions: formData.answerInstructions || null,
        outputMode: formData.outputMode || 'answerSynthesis',
        knowledgeSources: formData.knowledgeSources || [],
        models: formData.models || [],
        encryptionKey: null,
        retrievalReasoningEffort: formData.retrievalReasoningEffort || { kind: 'low' },
      }
      const result = await createOrUpdateKnowledgeBase({
        profile,
        knowledgeBaseName: formData.name,
        body,
        language,
      })
      if (result.ok) {
        setMessage({ type: 'success', text: `${t('updated')}: ${formData.name}` })
        await loadKnowledgeBases()
      } else {
        setMessage({ type: 'error', text: `${t('failed')}: ${result.error.message}` })
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
    setLoading(true)
    try {
      const result = await getKnowledgeBase({ profile, knowledgeBaseName: name, language })
      if (result.ok && result.response) {
        const base = normalizeKnowledgeBase(result.response)
        setSelectedBase(base)
        setFormData(base)
      }
    } catch (e) {
      console.error(e)
      setMessage({ type: 'error', text: `${t('failedToLoadBase')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }

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
            <div className="form">
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
              <label className="field">
                <span className="field__label">
                  {t('retrievalInstructions')}
                  <InfoTooltip tooltipKey="knowledgeBaseRetrievalInstructions" language={language} />
                </span>
                <textarea
                  className="field__textarea"
                  rows={3}
                  value={formData.retrievalInstructions || ''}
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
                  value={formData.answerInstructions || ''}
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
                  value={formData.outputMode || 'answerSynthesis'}
                  onChange={(e) => setFormData({ ...formData, outputMode: e.target.value })}
                >
                  <option value="answerSynthesis">Answer Synthesis</option>
                  <option value="extractiveData">Extractive Data</option>
                </select>
              </label>
              <label className="field">
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
                  value={formData.retrievalReasoningEffort?.kind || 'low'}
                  onChange={(e) => setFormData({ ...formData, retrievalReasoningEffort: { kind: e.target.value } })}
                >
                  <option value="minimal">{t('minimal')}</option>
                  <option value="low">{t('low')}</option>
                  <option value="medium">{t('medium')}</option>
                </select>
              </label>
            </div>
            <div className="actions builder__actions">
              {selectedBase ? (
                <button type="button" className="btn" onClick={handleUpdate} disabled={loading}>
                  <i className="bi bi-pencil icon--mr6"></i> {t('update')}
                </button>
              ) : (
                <button type="button" className="btn" onClick={handleCreate} disabled={loading}>
                  <i className="bi bi-pencil icon--mr6"></i> {t('create')}
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setSelectedBase(null)
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
