/**
 * LLM Settings Modal.
 *
 * Manages named LLM model profiles (CRUD + default selection).
 * Opened from the gear icon in the application header.
 */

import { useState } from 'react'
import type { TranslationKey, Language } from '../../lib/translations'
import type { SharedLlmConfig } from '../../hooks/useSharedLlmConfig'
import { generateLlmProfileId } from '../../hooks/useSharedLlmConfig'
import type { LlmModelProfile } from '../../lib/model'
import { PROVIDER_DEFAULTS } from '../../lib/llmProvider'
import { LlmConfigForm } from '../builders/LlmConfigForm'
import { buildAadCliCommand } from '../../lib/llmAuth'

export interface LlmSettingsModalProps {
  open: boolean
  onClose: () => void
  t: (key: TranslationKey) => string
  language: Language
  sharedLlm: SharedLlmConfig
}

export function LlmSettingsModal({ open, onClose, t, language, sharedLlm }: LlmSettingsModalProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [cliCopied, setCliCopied] = useState(false)

  if (!open) return null

  function handleAdd() {
    const id = generateLlmProfileId()
    const profile: LlmModelProfile = {
      id,
      name: '',
      provider: 'azure-openai',
      endpoint: '',
      authMode: 'apiKey',
      apiKey: '',
      bearerToken: '',
      deployment: '',
      apiVersion: PROVIDER_DEFAULTS['azure-openai'].apiVersion,
    }
    sharedLlm.addProfile(profile)
    setExpandedId(id)
  }

  function handleDelete(id: string) {
    if (!window.confirm(String(t('llmProfileDeleteConfirm')))) return
    sharedLlm.deleteProfile(id)
    if (expandedId === id) setExpandedId(null)
  }

  async function onCopyCliCommand() {
    try {
      await navigator.clipboard.writeText(buildAadCliCommand())
      setCliCopied(true)
      window.setTimeout(() => setCliCopied(false), 1500)
    } catch { /* ignore */ }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content--lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <i className="bi bi-gear"></i> {t('llmSettingsTitle')}
          </h2>
          <button type="button" className="btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="field__hint" style={{ marginBottom: 12 }}>{t('llmSettingsDesc')}</p>

          {sharedLlm.profiles.length === 0 && (
            <div className="field__hint" style={{ textAlign: 'center', padding: '24px 0' }}>
              {t('llmProfileNone')}
            </div>
          )}

          <div className="llmProfiles">
            {sharedLlm.profiles.map((profile) => {
              const isExpanded = expandedId === profile.id
              const isDefault = profile.id === sharedLlm.defaultProfileId
              return (
                <div key={profile.id} className="llmProfile">
                  <div
                    className="llmProfile__header"
                    onClick={() => setExpandedId(isExpanded ? null : profile.id)}
                  >
                    <i className={`bi ${isExpanded ? 'bi-chevron-down' : 'bi-chevron-right'} llmProfile__chevron`} />
                    <span className="llmProfile__name">
                      {profile.name || profile.deployment || '(unnamed)'}
                    </span>
                    <span className="llmProfile__provider">{profile.provider}</span>
                    <span className="llmProfile__modelType">
                      {(profile.modelType ?? 'chat') === 'embeddings' ? 'Embeddings' : 'Chat'}
                    </span>
                    {isDefault && (
                      <span className="llmProfile__badge">{t('llmProfileDefault')}</span>
                    )}
                    <span className="llmProfile__spacer" />
                    {!isDefault && (
                      <button
                        type="button"
                        className="btn btn--xs"
                        onClick={(e) => { e.stopPropagation(); sharedLlm.setDefaultProfileId(profile.id) }}
                        title={String(t('llmProfileSetDefault'))}
                      >
                        <i className="bi bi-star" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn--xs btn--danger"
                      onClick={(e) => { e.stopPropagation(); handleDelete(profile.id) }}
                      title={String(t('llmProfileDelete'))}
                    >
                      <i className="bi bi-trash" />
                    </button>
                  </div>

                  {isExpanded && (
                    <div className="llmProfile__body">
                      <label className="field field--mb12">
                        <span className="field__label">{t('llmProfileName')}</span>
                        <input
                          className="field__input"
                          value={profile.name}
                          onChange={(e) => sharedLlm.updateProfile({ ...profile, name: e.target.value })}
                          placeholder={String(t('llmProfileNamePlaceholder'))}
                        />
                      </label>
                      <LlmConfigForm
                        profile={profile}
                        onChange={(updated) => sharedLlm.updateProfile(updated)}
                        language={language}
                        t={t}
                      />
                      {profile.authMode === 'bearer' && profile.provider === 'azure-openai' && (
                        <div className="field__hint" style={{ marginTop: 8 }}>
                          <div>{t('aadCliHelperDesc')}</div>
                          <div className="aadCliHelper">
                            <code className="aadCliHelper__code">{buildAadCliCommand()}</code>
                            <button
                              type="button"
                              className="btn btn--icon"
                              onClick={() => void onCopyCliCommand()}
                              title={String(t('aadCliCopy'))}
                            >
                              <i className={cliCopied ? 'bi bi-check2' : 'bi bi-clipboard'} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn btn--primary" onClick={handleAdd}>
              <i className="bi bi-plus-lg icon--mr6" />{t('llmProfileAdd')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
