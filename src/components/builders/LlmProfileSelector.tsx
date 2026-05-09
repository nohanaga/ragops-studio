/**
 * LLM Profile Selector — dropdown for choosing a named LLM profile.
 *
 * Used inside each feature (Text to Vector, Eval Dataset Generator,
 * Index Cluster Visualizer) to let the user select which LLM profile to use.
 *
 * When `modelType` is specified, only profiles matching that category are shown.
 */

import type { ChangeEvent } from 'react'
import type { TranslationKey, Language } from '../../lib/translations'
import type { SharedLlmConfig } from '../../hooks/useSharedLlmConfig'
import type { LlmModelType } from '../../lib/model'

export interface LlmProfileSelectorProps {
  sharedLlm: SharedLlmConfig
  selectedProfileId: string
  onSelect: (profileId: string) => void
  t: (key: TranslationKey) => string
  language: Language
  disabled?: boolean
  onOpenSettings?: () => void
  /** When set, only profiles of this model type are shown. */
  modelType?: LlmModelType
}

export function LlmProfileSelector({
  sharedLlm,
  selectedProfileId,
  onSelect,
  t,
  disabled,
  onOpenSettings,
  modelType,
}: LlmProfileSelectorProps) {
  const profiles = modelType
    ? sharedLlm.profiles.filter((p) => (p.modelType ?? 'chat') === modelType)
    : sharedLlm.profiles
  const resolved = profiles.find((p) => p.id === selectedProfileId) ?? profiles[0]
  const hasProfiles = profiles.length > 0

  const label = modelType === 'embeddings' ? t('llmEmbeddingsProfileSelector') : t('llmProfileSelector')
  const noneLabel = modelType === 'embeddings' ? t('llmEmbeddingsProfileSelectorNone') : t('llmProfileSelectorNone')

  return (
    <div className="llmSelector">
      <div className="field">
        <span className="field__label">
          {label}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <select
            className="field__input"
            style={{ flex: 1 }}
            value={hasProfiles ? (resolved?.id || '') : ''}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => onSelect(e.target.value)}
            disabled={disabled || !hasProfiles}
          >
            {!hasProfiles && (
              <option value="">{noneLabel}</option>
            )}
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.deployment || '(unnamed)'}
              </option>
            ))}
          </select>
          {onOpenSettings && (
            <button
              type="button"
              className="btn btn--icon btn--xs"
              onClick={onOpenSettings}
              title={String(t('llmSettingsTitle'))}
            >
              <i className="bi bi-gear" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
