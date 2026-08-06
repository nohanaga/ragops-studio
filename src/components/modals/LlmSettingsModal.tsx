/**
 * LLM Settings Modal.
 *
 * Manages named LLM model profiles (CRUD + default selection).
 * Opened from the gear icon in the application header.
 */

import { useEffect, useState } from 'react'
import type { TranslationKey, Language } from '../../lib/translations'
import type { SharedLlmConfig } from '../../hooks/useSharedLlmConfig'
import { generateLlmProfileId } from '../../hooks/useSharedLlmConfig'
import type { LlmModelProfile } from '../../lib/model'
import { PROVIDER_DEFAULTS } from '../../lib/llmProvider'
import { LlmConfigForm } from '../builders/LlmConfigForm'
import { buildAadCliCommand } from '../../lib/llmAuth'
import type { AppSettings, ConnectionProfile } from '../../lib/model'
import { sanitizeEndpoint } from '../../utils'
import { InfoTooltip } from '../InfoTooltip'

export interface LlmSettingsModalProps {
  open: boolean
  onClose: () => void
  t: (key: TranslationKey) => string
  language: Language
  sharedLlm: SharedLlmConfig
  settings: AppSettings | null
  activeProfile: ConnectionProfile | null
  patchActiveProfile: (patch: Partial<ConnectionProfile>) => void
  patchSettings: (patch: Partial<AppSettings>) => void
  openJwtDecoder: (token: string) => void
}

export function LlmSettingsModal({ open, onClose, t, language, sharedLlm, settings, activeProfile, patchActiveProfile, patchSettings, openJwtDecoder }: LlmSettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'search' | 'llm'>('search')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [cliCopied, setCliCopied] = useState(false)

  useEffect(() => {
    if (!open) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

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

  function handleAddSearchProfile() {
    if (!settings) return
    const baseId = 'search'
    let suffix = Object.keys(settings.profiles).length + 1
    let profileId = `${baseId}-${suffix}`
    while (settings.profiles[profileId]) {
      suffix += 1
      profileId = `${baseId}-${suffix}`
    }
    patchSettings({
      profiles: {
        ...settings.profiles,
        [profileId]: {
          name: t('searchConnectionNewName'),
          endpoint: '',
          apiVersion: '2026-04-01',
          authType: 'apiKey',
        },
      },
      activeProfileId: profileId,
    })
  }

  function handleDeleteSearchProfile() {
    if (!settings || Object.keys(settings.profiles).length <= 1) return
    if (!window.confirm(String(t('searchConnectionDeleteConfirm')))) return
    const profiles = { ...settings.profiles }
    delete profiles[settings.activeProfileId]
    patchSettings({ profiles, activeProfileId: Object.keys(profiles)[0] })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content modal-content--lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <i className="bi bi-gear"></i> {t('appSettingsTitle')}
          </h2>
          <button type="button" className="btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="actions actions--mb10">
            <button type="button" className={`btn btn--tab ${activeTab === 'search' ? 'btn--active' : ''}`} onClick={() => setActiveTab('search')}>
              <i className="bi bi-search icon--mr6" />{t('searchConnection')}
            </button>
            <button type="button" className={`btn btn--tab ${activeTab === 'llm' ? 'btn--active' : ''}`} onClick={() => setActiveTab('llm')}>
              <i className="bi bi-cpu icon--mr6" />{t('llmSettingsTitle')}
            </button>
          </div>

          {activeTab === 'search' && settings && (
            <div className="form">
              <label className="field field--full">
                <span className="field__label">{t('searchConnectionProfile')}</span>
                <select className="field__input" value={settings.activeProfileId} onChange={(event) => patchSettings({ activeProfileId: event.target.value })}>
                  {Object.entries(settings.profiles).map(([profileId, profile]) => (
                    <option key={profileId} value={profileId}>{profile.name || profileId}</option>
                  ))}
                </select>
              </label>
              <div className="actions actions--tight actions--wrap actions--mb10 field--full">
                <button type="button" className="btn btn--primary" onClick={handleAddSearchProfile}><i className="bi bi-plus-lg icon--mr6" />{t('searchConnectionAdd')}</button>
                <button type="button" className="btn btn--danger-text" onClick={handleDeleteSearchProfile} disabled={Object.keys(settings.profiles).length <= 1}><i className="bi bi-trash icon--mr6" />{t('searchConnectionDelete')}</button>
              </div>
              <label className="field">
                <span className="field__label">{t('searchConnectionName')}</span>
                <input className="field__input" value={activeProfile?.name ?? ''} onChange={(event) => patchActiveProfile({ name: event.target.value })} placeholder={t('searchConnectionNamePlaceholder')} />
              </label>
              <label className="field">
                <span className="field__label">{t('endpoint')}</span>
                <input className="field__input" value={activeProfile?.endpoint ?? ''} onChange={(event) => patchActiveProfile({ endpoint: sanitizeEndpoint(event.target.value) })} placeholder="https://{service}.search.windows.net" />
              </label>
              <label className="field">
                <span className="field__label">{t('apiVersion')}</span>
                <select className="field__input" value={activeProfile?.apiVersion ?? ''} onChange={(event) => patchActiveProfile({ apiVersion: event.target.value })}>
                  {['2026-04-01', '2025-11-01-preview', '2025-09-01', '2025-05-01-preview', '2025-03-01-preview', '2024-11-01-preview', '2024-09-01-preview', '2024-07-01', '2024-05-01-preview', '2023-11-01'].map((version) => <option key={version} value={version}>{version}</option>)}
                </select>
              </label>
              <label className="field">
                <span className="field__label">{t('authType')}</span>
                <select className="field__input" value={activeProfile?.authType ?? 'apiKey'} onChange={(event) => patchActiveProfile({ authType: event.target.value as 'apiKey' | 'bearer' })}>
                  <option value="apiKey">API Key</option><option value="bearer">Bearer (Entra ID)</option>
                </select>
              </label>
              {activeProfile?.authType === 'apiKey' ? (
                <label className="field">
                  <span className="field__label">
                    {t('apiKey')}
                    <span className="infoTooltip infoTooltip--danger" title={String(t('secretSecurityTooltip'))}>⚠️</span>
                  </span>
                  <input
                    className="field__input"
                    type="password"
                    value={activeProfile.apiKey ?? ''}
                    onChange={(event) => patchActiveProfile({ apiKey: event.target.value })}
                    placeholder={t('placeholderSaved')}
                  />
                </label>
              ) : (
                <label className="field">
                  <span className="field__label">
                    {t('bearerToken')}
                    <span className="infoTooltip infoTooltip--danger" title={String(t('secretSecurityTooltip'))}>⚠️</span>
                  </span>
                  <div className="list-editor__inputRow">
                    <input
                      className="field__input"
                      type="password"
                      value={activeProfile?.bearerToken ?? ''}
                      onChange={(event) => patchActiveProfile({ bearerToken: event.target.value })}
                      placeholder="Bearer ..."
                    />
                    <button
                      type="button"
                      className="btn btn--icon"
                      onClick={() => openJwtDecoder(activeProfile?.bearerToken ?? '')}
                      disabled={!activeProfile?.bearerToken?.trim()}
                      title={t('jwtDecodeTitle')}
                    >
                      <i className="bi bi-eye" />
                    </button>
                  </div>
                </label>
              )}
              <label className="field">
                <span className="field__label">{t('querySourceAuth')}<InfoTooltip tooltipKey="xMsQuerySourceAuthorization" language={language} /></span>
                <label className="agenticKsOption"><input className="agenticKsOption__checkbox" type="checkbox" checked={Boolean(activeProfile?.useQuerySourceAuthorization ?? activeProfile?.querySourceAuthorization?.trim())} onChange={(event) => patchActiveProfile({ useQuerySourceAuthorization: event.target.checked })} /><span>{t('useQuerySourceAuth')}</span></label>
                <div className="list-editor__inputRow"><input className="field__input" type="password" value={activeProfile?.querySourceAuthorization ?? ''} onChange={(event) => patchActiveProfile({ querySourceAuthorization: event.target.value })} placeholder={t('placeholderOptional')} /><button type="button" className="btn btn--icon" onClick={() => openJwtDecoder(activeProfile?.querySourceAuthorization ?? '')} disabled={!activeProfile?.querySourceAuthorization?.trim()} title={t('jwtDecodeTitle')}><i className="bi bi-eye" /></button></div>
              </label>
              <label className="field"><span className="field__label">{t('displayTitleFields')}</span><input className="field__input" value={settings.displayTitleFields ?? 'title,name,id,key,documentId,chunkId,path,url,metadata_storage_name'} onChange={(event) => patchSettings({ displayTitleFields: event.target.value })} /></label>
              <label className="field"><span className="field__label">{t('displayTextFields')}</span><input className="field__input" value={settings.displayTextFields ?? 'text,content,description,chunk'} onChange={(event) => patchSettings({ displayTextFields: event.target.value })} /></label>
            </div>
          )}

          {activeTab === 'llm' && <>
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
          </>}
        </div>
      </div>
    </div>
  )
}
