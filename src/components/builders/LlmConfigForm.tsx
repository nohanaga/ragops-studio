/**
 * LLM profile editor form.
 *
 * Renders provider / endpoint / auth / deployment / apiVersion inputs
 * for a single LlmModelProfile. Used inside the LLM Settings Modal.
 */

import type { ChangeEvent } from 'react'
import type { LlmModelProfile } from '../../lib/model'
import type { TranslationKey } from '../../lib/translations'
import type { LlmProviderType } from '../../lib/llmProvider'
import { LLM_PROVIDER_LABELS, LLM_PROVIDER_OPTIONS, PROVIDER_DEFAULTS, LOCAL_PROVIDERS, guessMaxInputTokens } from '../../lib/llmProvider'
import type { Language } from '../../lib/translations'

export interface LlmConfigFormProps {
  profile: LlmModelProfile
  onChange: (updated: LlmModelProfile) => void
  language: Language
  t: (key: TranslationKey) => string
  disabled?: boolean
  /** Hide deployment field. */
  hideDeployment?: boolean
  /** Hide apiVersion field. */
  hideApiVersion?: boolean
}

export function LlmConfigForm({ profile, onChange, language, t, disabled = false, hideDeployment, hideApiVersion }: LlmConfigFormProps) {
  const patch = (partial: Partial<LlmModelProfile>) => onChange({ ...profile, ...partial })

  const isLocal = LOCAL_PROVIDERS.has(profile.provider)

  return (
    <div className="formGrid">
      <label className="field">
        <span className="field__label">{t('edgLlmProviderLabel')}</span>
        <select
          className="field__input"
          value={profile.provider}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => {
            const v = e.target.value as LlmProviderType
            const updates: Partial<LlmModelProfile> = { provider: v }
            if (v === 'openai' && !profile.endpoint.trim()) {
              updates.endpoint = PROVIDER_DEFAULTS.openai.endpoint
            }
            if (LOCAL_PROVIDERS.has(v) && !profile.endpoint.trim()) {
              updates.endpoint = PROVIDER_DEFAULTS[v].endpoint
            }
            if ((v === 'openai' || LOCAL_PROVIDERS.has(v)) && profile.authMode === 'bearer') {
              updates.authMode = 'apiKey'
            }
            patch(updates)
          }}
          disabled={disabled}
        >
          {LLM_PROVIDER_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {LLM_PROVIDER_LABELS[p][language]}
            </option>
          ))}
        </select>
      </label>

      {profile.provider !== 'openai' && (
        <label className="field">
          <span className="field__label">{t('edgLlmEndpointLabel')}</span>
          <input
            className="field__input"
            value={profile.endpoint}
            onChange={(e) => patch({ endpoint: e.target.value })}
            placeholder={isLocal ? PROVIDER_DEFAULTS[profile.provider].endpoint : 'https://YOUR-RESOURCE.openai.azure.com'}
            disabled={disabled}
          />
        </label>
      )}

      {!isLocal && profile.provider !== 'openai' && (
        <label className="field">
          <span className="field__label">{t('llmAuthModeLabel')}</span>
          <select
            className="field__input"
            value={profile.authMode}
            onChange={(e: ChangeEvent<HTMLSelectElement>) =>
              patch({ authMode: e.target.value === 'bearer' ? 'bearer' : 'apiKey' })
            }
            disabled={disabled}
          >
            <option value="apiKey">apiKey</option>
            <option value="bearer">bearer (Entra ID)</option>
          </select>
        </label>
      )}

      {!isLocal && ((profile.provider === 'openai' || profile.authMode === 'apiKey') ? (
        <label className="field">
          <span className="field__label">{t('edgLlmApiKeyLabel')}</span>
          <input
            type="password"
            className="field__input"
            value={profile.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value })}
            disabled={disabled}
          />
        </label>
      ) : (
        <label className="field">
          <span className="field__label">{t('llmBearerTokenLabel')}</span>
          <input
            type="password"
            className="field__input"
            value={profile.bearerToken}
            onChange={(e) => patch({ bearerToken: e.target.value })}
            placeholder={String(t('llmBearerTokenPlaceholder'))}
            disabled={disabled}
          />
        </label>
      ))}

      {!hideDeployment && (
        <label className="field">
          <span className="field__label">{t('edgLlmDeploymentLabel')}</span>
          <input
            className="field__input"
            value={profile.deployment}
            onChange={(e) => patch({ deployment: e.target.value })}
            placeholder={isLocal ? (profile.provider === 'foundry-local' ? 'phi-3.5-mini' : 'loaded-model-name') : 'gpt-5.4-mini'}
            disabled={disabled}
          />
        </label>
      )}

      {!hideApiVersion && profile.provider === 'azure-openai' && (
        <label className="field">
          <span className="field__label">{t('edgLlmApiVersionLabel')}</span>
          <input
            className="field__input"
            value={profile.apiVersion}
            onChange={(e) => patch({ apiVersion: e.target.value })}
            placeholder={PROVIDER_DEFAULTS['azure-openai'].apiVersion}
            disabled={disabled}
          />
        </label>
      )}

      <label className="field">
        <span className="field__label">{t('llmMaxInputTokensLabel')}</span>
        <input
          type="number"
          className="field__input"
          value={profile.maxInputTokens || ''}
          onChange={(e) => patch({ maxInputTokens: e.target.value ? Number(e.target.value) : undefined })}
          placeholder={String(guessMaxInputTokens(profile.deployment) ?? 128000)}
          disabled={disabled}
        />
        <span className="field__hint">{t('llmMaxInputTokensHint')}</span>
      </label>
    </div>
  )
}
