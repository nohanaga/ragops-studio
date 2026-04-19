/**
 * Knowledge Source management tool.
 *
 * Provides CRUD operations for knowledge sources used by agentic retrieval.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ConnectionProfile } from '../../lib/model'
import type { KnowledgeSource } from '../../types'
import {
  listKnowledgeSources,
  getKnowledgeSource,
  createOrUpdateKnowledgeSource,
  deleteKnowledgeSource,
} from '../../lib/aiSearchRest'
import { InfoTooltip } from '../InfoTooltip'
import { translations, type Language } from '../../lib/translations'
import type { JsonValue } from '../../lib/aiSearchRest'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

type KnowledgeSourceBuilderProps = {
  profile: ConnectionProfile | null
  onClose: () => void
  language: Language
}

export function KnowledgeSourceBuilder({ profile, language }: KnowledgeSourceBuilderProps) {
  const t = useCallback((key: keyof typeof translations.ja) => translations[language][key], [language])

  const defaultSearchIndexParameters: KnowledgeSource['searchIndexParameters'] = {
    searchIndexName: '',
    semanticConfigurationName: null,
    sourceDataFields: [],
    searchFields: [],
  }

  const normalizeSearchIndexParameters = useCallback((input: unknown): KnowledgeSource['searchIndexParameters'] => {
    const p: Record<string, unknown> = isRecord(input) ? input : {}
    const toNameArray = (value: unknown): Array<{ name: string }> => {
      if (!Array.isArray(value)) return []
      return value
        .map((x) => ({ name: isRecord(x) && typeof x.name === 'string' ? x.name : '' }))
        .filter((x) => x.name.trim().length > 0)
    }

    return {
      searchIndexName: typeof p.searchIndexName === 'string' ? p.searchIndexName : '',
      semanticConfigurationName: typeof p.semanticConfigurationName === 'string' ? p.semanticConfigurationName : null,
      sourceDataFields: toNameArray(p.sourceDataFields),
      searchFields: toNameArray(p.searchFields),
    }
  }, [])

  const normalizeKnowledgeSource = useCallback((input: unknown): KnowledgeSource => {
    const ks: Record<string, unknown> = isRecord(input) ? input : {}
    return {
      name: typeof ks.name === 'string' ? ks.name : '',
      kind: 'searchIndex',
      description: typeof ks.description === 'string' ? ks.description : null,
      searchIndexParameters: normalizeSearchIndexParameters(ks.searchIndexParameters),
    }
  }, [normalizeSearchIndexParameters])
  
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSource[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedSource, setSelectedSource] = useState<KnowledgeSource | null>(null)
  const [formData, setFormData] = useState<Partial<KnowledgeSource>>({
    name: '',
    kind: 'searchIndex',
    description: null,
    searchIndexParameters: {
      searchIndexName: '',
      semanticConfigurationName: null,
      sourceDataFields: [],
      searchFields: [],
    },
  })
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const loadKnowledgeSources = useCallback(async () => {
    if (!profile) return
    setLoading(true)
    try {
      const result = await listKnowledgeSources({ profile, language })
      if (result.ok && result.response) {
        const resp = result.response as JsonValue
        const value = (isRecord(resp) ? (resp as Record<string, unknown>).value : undefined)
        const raw = Array.isArray(value) ? value : []
        const items = raw.map(normalizeKnowledgeSource).filter((ks) => ks.name.trim().length > 0)
        setKnowledgeSources(items)
      }
    } catch (e) {
      console.error(e)
      setMessage({ type: 'error', text: `${t('failedToLoad')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }, [profile, language, normalizeKnowledgeSource, t])

  useEffect(() => {
    if (!profile) return
    void loadKnowledgeSources()
  }, [profile, loadKnowledgeSources])

  const handleCreate = async () => {
    if (!profile || !formData.name) {
      setMessage({ type: 'error', text: t('nameRequired') })
      return
    }
    setLoading(true)
    try {
      const normalizedParams = normalizeSearchIndexParameters(formData.searchIndexParameters)
      const body: JsonValue = {
        name: formData.name,
        kind: 'searchIndex',
        description: formData.description || null,
        searchIndexParameters: normalizedParams,
      }
      const result = await createOrUpdateKnowledgeSource({
        profile,
        knowledgeSourceName: formData.name,
        body,
        language,
      })
      if (result.ok) {
        setMessage({ type: 'success', text: `${t('created')}: ${formData.name}` })
        await loadKnowledgeSources()
        setFormData({
          name: '',
          kind: 'searchIndex',
          description: null,
          searchIndexParameters: {
            searchIndexName: '',
            semanticConfigurationName: null,
            sourceDataFields: [],
            searchFields: [],
          },
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
    if (!profile || !selectedSource || !formData.name) return
    setLoading(true)
    try {
      const normalizedParams = normalizeSearchIndexParameters(formData.searchIndexParameters)
      const body: JsonValue = {
        name: formData.name,
        kind: 'searchIndex',
        description: formData.description || null,
        searchIndexParameters: normalizedParams,
      }
      const result = await createOrUpdateKnowledgeSource({
        profile,
        knowledgeSourceName: formData.name,
        body,
        language,
      })
      if (result.ok) {
        setMessage({ type: 'success', text: `${t('updated')}: ${formData.name}` })
        await loadKnowledgeSources()
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
      const result = await deleteKnowledgeSource({ profile, knowledgeSourceName: name, language })
      if (result.ok) {
        setMessage({ type: 'success', text: `${t('deleted')}: ${name}` })
        await loadKnowledgeSources()
        if (selectedSource?.name === name) {
          setSelectedSource(null)
          setFormData({
            name: '',
            kind: 'searchIndex',
            description: null,
            searchIndexParameters: {
              searchIndexName: '',
              semanticConfigurationName: null,
              sourceDataFields: [],
              searchFields: [],
            },
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

  const handleSelectSource = async (name: string) => {
    if (!profile) return
    setLoading(true)
    try {
      const result = await getKnowledgeSource({ profile, knowledgeSourceName: name, language })
      if (result.ok && result.response) {
        const source = normalizeKnowledgeSource(result.response)
        setSelectedSource(source)
        setFormData(source)
      }
    } catch (e) {
      console.error(e)
      setMessage({ type: 'error', text: `${t('failedToLoadSource')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="pane__centerContent">
      <div className="section">
        <div className="section__title">{t('knowledgeSourceBuilder')}</div>
        {message && (
          <div className={`notice notice--${message.type} builder__notice`}>
            {message.text}
          </div>
        )}
        <div className="builder__grid">
          <div>
            <div className="builder__sidebarTitle">{t('knowledgeSources2')} ({knowledgeSources.length})</div>
            <button type="button" className="btn builder__refreshBtn" onClick={loadKnowledgeSources} disabled={loading}>
              <i className="bi bi-arrow-clockwise"></i> {t('refresh')}
            </button>
            <div className="builder__listBox">
              {knowledgeSources.map((ks) => (
                <div key={ks.name} className="builder-list-item">
                  <button
                    type="button"
                    className={`btn builder-list-item__btn ${selectedSource?.name === ks.name ? 'builder-list-item__btn--active' : ''}`}
                    onClick={() => handleSelectSource(ks.name)}
                  >
                    {ks.name}
                  </button>
                  <button
                    type="button"
                    className="btn builder-list-item__delete"
                    onClick={() => handleDelete(ks.name)}
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
              {selectedSource ? `${t('edit')}: ${selectedSource.name}` : t('createNew')}
            </div>
            <div className="form" data-guide-target="knowledge-source-form">
              <label className="field">
                <span className="field__label">
                  {t('name')} *
                  <InfoTooltip tooltipKey="knowledgeSourceName" language={language} />
                </span>
                <input
                  className="field__input"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  disabled={!!selectedSource}
                />
              </label>
              <label className="field">
                <span className="field__label">
                  {t('description')}
                  <InfoTooltip tooltipKey="knowledgeSourceDescription" language={language} />
                </span>
                <input
                  className="field__input"
                  value={formData.description || ''}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="field__label">
                  {t('searchIndexName')} *
                  <InfoTooltip tooltipKey="knowledgeSourceSearchIndexName" language={language} />
                </span>
                <input
                  className="field__input"
                  value={formData.searchIndexParameters?.searchIndexName || ''}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      searchIndexParameters: {
                        ...(formData.searchIndexParameters ?? defaultSearchIndexParameters),
                        searchIndexName: e.target.value,
                      },
                    })
                  }
                />
              </label>
              <label className="field">
                <span className="field__label">
                  {t('semanticConfigurationName')}
                  <InfoTooltip tooltipKey="knowledgeSourceSemanticConfigurationName" language={language} />
                </span>
                <input
                  className="field__input"
                  value={formData.searchIndexParameters?.semanticConfigurationName || ''}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      searchIndexParameters: {
                        ...(formData.searchIndexParameters ?? defaultSearchIndexParameters),
                        semanticConfigurationName: e.target.value || null,
                      },
                    })
                  }
                />
              </label>
              <label className="field" data-guide-target="knowledge-source-fields">
                <span className="field__label">
                  {t('sourceDataFields')}
                  <InfoTooltip tooltipKey="knowledgeSourceSourceDataFields" language={language} />
                </span>
                <input
                  className="field__input"
                  value={formData.searchIndexParameters?.sourceDataFields?.map(f => f.name).join(',') || ''}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      searchIndexParameters: {
                        ...(formData.searchIndexParameters ?? defaultSearchIndexParameters),
                        sourceDataFields: e.target.value.split(',').filter(s => s.trim()).map(name => ({ name: name.trim() })),
                      },
                    })
                  }
                  placeholder={t('sourceDataFieldsPlaceholder')}
                />
              </label>
              <label className="field">
                <span className="field__label">
                  {t('searchFieldsLabel')}
                  <InfoTooltip tooltipKey="knowledgeSourceSearchFields" language={language} />
                </span>
                <input
                  className="field__input"
                  value={formData.searchIndexParameters?.searchFields?.map(f => f.name).join(',') || ''}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      searchIndexParameters: {
                        ...(formData.searchIndexParameters ?? defaultSearchIndexParameters),
                        searchFields: e.target.value.split(',').filter(s => s.trim()).map(name => ({ name: name.trim() })),
                      },
                    })
                  }
                  placeholder={t('searchFieldsPlaceholder')}
                />
              </label>
            </div>
            <div className="actions builder__actions" data-guide-target="knowledge-source-actions">
              {selectedSource ? (
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
                  setSelectedSource(null)
                  setFormData({
                    name: '',
                    kind: 'searchIndex',
                    description: null,
                    searchIndexParameters: {
                      searchIndexName: '',
                      semanticConfigurationName: null,
                      sourceDataFields: [],
                      searchFields: [],
                    },
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
