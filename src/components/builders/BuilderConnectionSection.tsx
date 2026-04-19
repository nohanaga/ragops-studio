/**
 * Connection settings section for all builders.
 *
 * Manages endpoint, API version, and auth inputs, plus helper actions like
 * opening the JWT decoder.
 */

import type { AppSettings, ConnectionProfile } from '../../lib/model'
import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import { sanitizeEndpoint } from '../../utils'
import { InfoTooltip } from '../InfoTooltip'

type TranslationKey = keyof typeof translations.ja

export type BuilderConnectionSectionProps = {
  t: (key: TranslationKey) => string
  language: Language

  activeProfile: ConnectionProfile | null
  patchActiveProfile: (patch: Partial<ConnectionProfile>) => void
  openJwtDecoder: (token: string) => void

  settings: AppSettings | null
  patchSettings: (patch: Partial<AppSettings>) => void
}

export function BuilderConnectionSection(props: BuilderConnectionSectionProps) {
  const { t, language, activeProfile, patchActiveProfile, openJwtDecoder, settings, patchSettings } = props

  return (
    <div className="section section--connection" data-guide-target="connection-section">
      <details>
        <summary className="section__title">
          <i className="bi bi-plug icon--mr6"></i>
          {t('connection')}
        </summary>

        <div className="form">
          <label className="field">
            <span className="field__label">{t('endpoint')}</span>
            <input
              className="field__input"
              value={activeProfile?.endpoint ?? ''}
              onChange={(e) => patchActiveProfile({ endpoint: sanitizeEndpoint(e.target.value) })}
              placeholder="https://{service}.search.windows.net"
            />
          </label>

          <label className="field">
            <span className="field__label">{t('apiVersion')}</span>
            <select
              className="field__input"
              value={activeProfile?.apiVersion ?? ''}
              onChange={(e) => patchActiveProfile({ apiVersion: e.target.value })}
            >
              <option value="2025-11-01-preview">2025-11-01-preview</option>
              <option value="2025-09-01">2025-09-01</option>
              <option value="2025-05-01-preview">2025-05-01-preview</option>
              <option value="2025-03-01-preview">2025-03-01-preview</option>
              <option value="2024-11-01-preview">2024-11-01-preview</option>
              <option value="2024-09-01-preview">2024-09-01-preview</option>
              <option value="2024-07-01">2024-07-01</option>
              <option value="2024-05-01-preview">2024-05-01-preview</option>
              <option value="2023-11-01">2023-11-01</option>
            </select>
          </label>

          <label className="field">
            <span className="field__label">{t('authType')}</span>
            <select
              className="field__input"
              value={activeProfile?.authType ?? 'apiKey'}
              onChange={(e) => {
                const value = e.target.value
                if (value === 'apiKey' || value === 'bearer') {
                  patchActiveProfile({ authType: value })
                }
              }}
            >
              <option value="apiKey">apiKey</option>
              <option value="bearer">bearer</option>
            </select>
          </label>

          {activeProfile?.authType === 'apiKey' && (
            <label className="field">
              <span className="field__label">
                {t('apiKey')}
                <span className="infoTooltip infoTooltip--danger" title={String(t('secretSecurityTooltip'))}>
                  ⚠️
                </span>
              </span>
              <input
                className="field__input"
                type="password"
                value={activeProfile.apiKey ?? ''}
                onChange={(e) => patchActiveProfile({ apiKey: e.target.value })}
                placeholder={t('placeholderSaved')}
              />
            </label>
          )}

          {activeProfile?.authType === 'bearer' && (
            <label className="field">
              <span className="field__label">
                {t('bearerToken')}
                <span className="infoTooltip infoTooltip--danger" title={String(t('secretSecurityTooltip'))}>
                  ⚠️
                </span>
              </span>
              <div className="list-editor__inputRow">
                <input
                  className="field__input"
                  type="password"
                  value={activeProfile.bearerToken ?? ''}
                  onChange={(e) => patchActiveProfile({ bearerToken: e.target.value })}
                  placeholder="Bearer ..."
                />
                <button
                  type="button"
                  className="btn btn--icon"
                  onClick={() => openJwtDecoder(activeProfile.bearerToken ?? '')}
                  disabled={!activeProfile?.bearerToken?.trim()}
                  title={t('jwtDecodeTitle')}
                >
                  <i className="bi bi-eye"></i>
                </button>
              </div>
            </label>
          )}
        </div>

        <div className="form form--compact">
          <label className="field">
            <span className="field__label">
              {t('querySourceAuth')}
              <InfoTooltip tooltipKey="xMsQuerySourceAuthorization" language={language} />
              <span className="infoTooltip infoTooltip--danger" title={String(t('secretSecurityTooltip'))}>
                ⚠️
              </span>
            </span>
            <label className="agenticKsOption">
              <input
                className="agenticKsOption__checkbox"
                type="checkbox"
                checked={Boolean(
                  activeProfile?.useQuerySourceAuthorization ??
                    Boolean(activeProfile?.querySourceAuthorization?.trim())
                )}
                onChange={(e) => patchActiveProfile({ useQuerySourceAuthorization: e.target.checked })}
              />
              <span>{t('useQuerySourceAuth')}</span>
            </label>
          </label>

          <label className="field">
            <div className="list-editor__inputRow">
              <input
                className="field__input"
                type="password"
                value={activeProfile?.querySourceAuthorization ?? ''}
                onChange={(e) => patchActiveProfile({ querySourceAuthorization: e.target.value })}
                placeholder={t('placeholderOptional')}
              />
              <button
                type="button"
                className="btn btn--icon"
                onClick={() => openJwtDecoder(activeProfile?.querySourceAuthorization ?? '')}
                disabled={!activeProfile?.querySourceAuthorization?.trim()}
                title={t('jwtDecodeTitle')}
              >
                <i className="bi bi-eye"></i>
              </button>
            </div>
          </label>
        </div>

        <div className="form">
          <label className="field">
            <span className="field__label">{t('displayTitleFields')}</span>
            <input
              className="field__input"
              value={settings?.displayTitleFields ?? 'title,name,id,key,documentId,chunkId,path,url,metadata_storage_name'}
              onChange={(e) => patchSettings({ displayTitleFields: e.target.value })}
              placeholder="title,name,id,key,..."
            />
          </label>

          <label className="field">
            <span className="field__label">{t('displayTextFields')}</span>
            <input
              className="field__input"
              value={settings?.displayTextFields ?? 'text,content,description,chunk'}
              onChange={(e) => patchSettings({ displayTextFields: e.target.value })}
              placeholder="text,content,description,..."
            />
          </label>

          <div className="form__hintRow">{t('displayFieldsPriorityHint')}</div>
        </div>
      </details>
    </div>
  )
}
