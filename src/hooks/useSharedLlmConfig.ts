/**
 * Shared LLM configuration hook — named-profile edition.
 *
 * Manages an array of named LLM profiles persisted in AppSettings.llmProfiles.
 * Each feature selects a profile by ID; if none is explicitly chosen the
 * default profile is used.
 *
 * Provides migration from the legacy flat fields (llmProvider, openAiEndpoint, …)
 * on first access so existing users keep their settings.
 */

import { useCallback, useMemo, useRef } from 'react'
import { useSettings } from '../contexts'
import type { LlmProviderConfig, LlmProviderType } from '../lib/llmProvider'
import { PROVIDER_DEFAULTS, LOCAL_PROVIDERS } from '../lib/llmProvider'
import type { LlmAuth, LlmAuthMode } from '../lib/llmAuth'
import type { LlmModelProfile } from '../lib/model'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Resolved read-only snapshot of a single LLM profile with helpers. */
export interface ResolvedLlmProfile {
  id: string
  name: string
  provider: LlmProviderType
  endpoint: string
  authMode: LlmAuthMode
  apiKey: string
  bearerToken: string
  deployment: string
  apiVersion: string
  /** Max input tokens (user override or undefined). */
  maxInputTokens?: number
  /** Effective endpoint (auto-fills for OpenAI). */
  effectiveEndpoint: string
  /** Build a LlmProviderConfig ready for callLlmChat(). */
  buildLlmProviderConfig: () => LlmProviderConfig
  /** Build a LlmAuth object. */
  buildAuth: () => LlmAuth
}

export interface SharedLlmConfig {
  /** All named profiles. */
  profiles: LlmModelProfile[]
  /** ID of the default profile. */
  defaultProfileId: string

  /** Resolve a profile by ID (falls back to default → first → empty stub). */
  resolve: (profileId?: string) => ResolvedLlmProfile

  /** CRUD helpers — all persist to IndexedDB via patchSettings. */
  addProfile: (profile: LlmModelProfile) => void
  updateProfile: (profile: LlmModelProfile) => void
  deleteProfile: (id: string) => void
  setDefaultProfileId: (id: string) => void
}

export type { LlmModelProfile }

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateLlmProfileId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

// ---------------------------------------------------------------------------
// Migration helper — run once if legacy flat fields exist
// ---------------------------------------------------------------------------

function migrateLegacyFields(settings: {
  llmProvider?: LlmProviderType
  openAiEndpoint?: string
  openAiApiKey?: string
  openAiAuthMode?: 'apiKey' | 'bearer'
  openAiBearerToken?: string
  llmDeployment?: string
  llmApiVersion?: string
  llmProfiles?: LlmModelProfile[]
  defaultLlmProfileId?: string
}): { profiles: LlmModelProfile[]; defaultId: string } | null {
  if (settings.llmProfiles && settings.llmProfiles.length > 0) return null

  const hasLegacy =
    settings.llmProvider ||
    settings.openAiEndpoint ||
    settings.openAiApiKey ||
    settings.openAiBearerToken ||
    settings.llmDeployment
  if (!hasLegacy) return null

  const id = generateLlmProfileId()
  const profile: LlmModelProfile = {
    id,
    name: settings.llmDeployment || 'Default',
    provider: settings.llmProvider ?? 'azure-openai',
    endpoint: settings.openAiEndpoint ?? '',
    authMode: settings.openAiAuthMode ?? 'apiKey',
    apiKey: settings.openAiApiKey ?? '',
    bearerToken: settings.openAiBearerToken ?? '',
    deployment: settings.llmDeployment ?? '',
    apiVersion: settings.llmApiVersion ?? PROVIDER_DEFAULTS['azure-openai'].apiVersion,
  }
  return { profiles: [profile], defaultId: id }
}

// ---------------------------------------------------------------------------
// Resolve helper (pure)
// ---------------------------------------------------------------------------

function resolveProfile(
  profiles: LlmModelProfile[],
  defaultId: string,
  requestedId?: string,
): ResolvedLlmProfile {
  const p =
    (requestedId ? profiles.find((x) => x.id === requestedId) : undefined) ??
    profiles.find((x) => x.id === defaultId) ??
    profiles[0]

  const id = p?.id ?? ''
  const name = p?.name ?? ''
  const provider: LlmProviderType = p?.provider ?? 'azure-openai'
  const endpoint = p?.endpoint ?? ''
  const authMode: LlmAuthMode = p?.authMode ?? 'apiKey'
  const apiKey = p?.apiKey ?? ''
  const bearerToken = p?.bearerToken ?? ''
  const deployment = p?.deployment ?? ''
  const apiVersion = p?.apiVersion ?? PROVIDER_DEFAULTS['azure-openai'].apiVersion
  const maxInputTokens = p?.maxInputTokens

  const effectiveEndpoint = provider === 'openai'
    ? PROVIDER_DEFAULTS.openai.endpoint
    : LOCAL_PROVIDERS.has(provider) && !endpoint.trim()
      ? PROVIDER_DEFAULTS[provider].endpoint
      : endpoint

  const buildAuth = (): LlmAuth => {
    if (LOCAL_PROVIDERS.has(provider)) {
      return { mode: 'apiKey', apiKey: 'none' }
    }
    const effective = provider === 'openai' ? 'apiKey' : authMode
    return effective === 'bearer'
      ? { mode: 'bearer', bearerToken }
      : { mode: 'apiKey', apiKey }
  }

  const buildLlmProviderConfig = (): LlmProviderConfig => ({
    provider,
    endpoint: effectiveEndpoint,
    auth: buildAuth(),
    model: deployment,
    apiVersion: provider === 'azure-openai' ? apiVersion : '',
  })

  return {
    id,
    name,
    provider,
    endpoint,
    authMode,
    apiKey,
    bearerToken,
    deployment,
    apiVersion,
    maxInputTokens,
    effectiveEndpoint,
    buildLlmProviderConfig,
    buildAuth,
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSharedLlmConfig(): SharedLlmConfig {
  const { settings, patchSettings } = useSettings()
  const migratedRef = useRef(false)

  const profiles: LlmModelProfile[] = settings?.llmProfiles ?? []
  const defaultProfileId: string = settings?.defaultLlmProfileId ?? profiles[0]?.id ?? ''

  // One-time migration from legacy flat fields
  if (settings && !migratedRef.current) {
    const migration = migrateLegacyFields(settings)
    if (migration) {
      migratedRef.current = true
      void patchSettings({
        llmProfiles: migration.profiles,
        defaultLlmProfileId: migration.defaultId,
        llmProvider: undefined,
        openAiEndpoint: undefined,
        openAiApiKey: undefined,
        openAiAuthMode: undefined,
        openAiBearerToken: undefined,
        llmDeployment: undefined,
        llmApiVersion: undefined,
      })
    } else {
      migratedRef.current = true
    }
  }

  const resolve = useCallback(
    (profileId?: string) => resolveProfile(profiles, defaultProfileId, profileId),
    [profiles, defaultProfileId],
  )

  const addProfile = useCallback(
    (profile: LlmModelProfile) => {
      const next = [...profiles, profile]
      const patch: Record<string, unknown> = { llmProfiles: next }
      if (next.length === 1) patch.defaultLlmProfileId = profile.id
      void patchSettings(patch)
    },
    [profiles, patchSettings],
  )

  const updateProfile = useCallback(
    (profile: LlmModelProfile) => {
      const next = profiles.map((p) => (p.id === profile.id ? profile : p))
      void patchSettings({ llmProfiles: next })
    },
    [profiles, patchSettings],
  )

  const deleteProfile = useCallback(
    (id: string) => {
      const next = profiles.filter((p) => p.id !== id)
      const patch: Record<string, unknown> = { llmProfiles: next }
      if (defaultProfileId === id) {
        patch.defaultLlmProfileId = next[0]?.id ?? ''
      }
      void patchSettings(patch)
    },
    [profiles, defaultProfileId, patchSettings],
  )

  const setDefaultProfileId = useCallback(
    (id: string) => void patchSettings({ defaultLlmProfileId: id }),
    [patchSettings],
  )

  return useMemo(
    () => ({
      profiles,
      defaultProfileId,
      resolve,
      addProfile,
      updateProfile,
      deleteProfile,
      setDefaultProfileId,
    }),
    [profiles, defaultProfileId, resolve, addProfile, updateProfile, deleteProfile, setDefaultProfileId],
  )
}
