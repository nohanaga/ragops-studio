/**
 * Multi-provider LLM abstraction layer.
 *
 * Supports:
 * - `azure-openai` : Azure OpenAI Service — deployment-based URL with api-version.
 * - `openai`       : OpenAI platform (api.openai.com).
 *
 * Both share the Chat Completions response shape, allowing a single
 * parsing path. The provider difference is URL format, auth header,
 * and whether `model` appears in the request body.
 */

import type { LlmAuth, LlmAuthMode } from './llmAuth'
import { LlmAuthError, isLlmAuthStatus } from './llmAuth'

// ─── Types ──────────────────────────────────────────────────────────────────

export type LlmProviderType = 'azure-openai' | 'openai'

export interface LlmProviderConfig {
  provider: LlmProviderType
  /** Base endpoint URL (trailing slash stripped internally). */
  endpoint: string
  /** Authentication credentials. */
  auth: LlmAuth
  /** Model name (OpenAI) or deployment name (Azure OpenAI). */
  model: string
  /** API version — required for `azure-openai`. */
  apiVersion?: string
}

// ─── URL Builders ───────────────────────────────────────────────────────────

export function buildChatCompletionsUrl(config: LlmProviderConfig): string {
  const base = config.endpoint.replace(/\/+$/, '')
  switch (config.provider) {
    case 'azure-openai':
      return `${base}/openai/deployments/${encodeURIComponent(config.model)}/chat/completions?api-version=${encodeURIComponent(config.apiVersion || '2024-10-21')}`
    case 'openai':
      return `${base}/v1/chat/completions`
  }
}

export function buildEmbeddingsUrl(config: LlmProviderConfig): string {
  const base = config.endpoint.replace(/\/+$/, '')
  switch (config.provider) {
    case 'azure-openai':
      return `${base}/openai/deployments/${encodeURIComponent(config.model)}/embeddings?api-version=${encodeURIComponent(config.apiVersion || '2024-10-21')}`
    case 'openai':
      return `${base}/v1/embeddings`
  }
}

// ─── Auth Headers ───────────────────────────────────────────────────────────

/**
 * Build the appropriate auth header(s) for an LLM HTTP call.
 * Provider-aware: OpenAI platform sends API key as Bearer token;
 * Azure sends it via the `api-key` header.
 */
export function buildProviderAuthHeaders(
  auth: LlmAuth,
  provider: LlmProviderType,
): Record<string, string> {
  if (auth.mode === 'bearer') {
    const t = (auth.bearerToken ?? '').trim()
    if (!t) throw new Error('Bearer token is required for Entra ID authentication')
    return { Authorization: t.startsWith('Bearer ') ? t : `Bearer ${t}` }
  }

  const k = (auth.apiKey ?? '').trim()
  if (!k) throw new Error('API key is required for API-key authentication')

  switch (provider) {
    case 'azure-openai':
      return { 'api-key': k }
    case 'openai':
      return { Authorization: `Bearer ${k}` }
  }
}

// ─── Request Body Builder ───────────────────────────────────────────────────

export function buildChatRequestBody(
  config: LlmProviderConfig,
  messages: Array<{ role: string; content: string }>,
  options: { temperature?: number; jsonMode?: boolean } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages,
    temperature: options.temperature ?? 0.3,
  }

  // Azure OpenAI: model is encoded in the URL, not the body
  if (config.provider !== 'azure-openai') {
    body.model = config.model
  }

  if (options.jsonMode) {
    body.response_format = { type: 'json_object' }
  }

  return body
}

export function buildEmbeddingsRequestBody(
  config: LlmProviderConfig,
  inputs: string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = { input: inputs }

  if (config.provider !== 'azure-openai') {
    body.model = config.model
  }

  return body
}

// ─── Chat Completions Call ──────────────────────────────────────────────────

export interface CallLlmChatParams {
  config: LlmProviderConfig
  systemPrompt: string
  userPrompt: string
  signal?: AbortSignal
  /** When false, omit `response_format: json_object`. Defaults to true. */
  jsonMode?: boolean
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
}

const MAX_CONTENT_FILTER_RETRIES = 3
const CONTENT_FILTER_RETRY_DELAY_MS = 1000

function isContentFilterError(status: number, body: string): boolean {
  return (
    status === 400 &&
    (body.includes('content_filter') ||
      body.includes('content management policy') ||
      body.includes('content filtering'))
  )
}

/**
 * Unified Chat Completions call supporting both providers.
 * Returns the raw assistant content string.
 *
 * Retries up to 3 times on content-filter 400 responses with increasing
 * temperature to nudge the model past the filter.
 */
export async function callLlmChat(params: CallLlmChatParams): Promise<string> {
  const { config, systemPrompt, userPrompt, signal, jsonMode = true } = params

  if (!config.endpoint.trim()) throw new Error('LLM endpoint is required')
  if (!config.model.trim()) throw new Error('LLM model/deployment is required')
  if (config.provider === 'azure-openai' && !config.apiVersion?.trim()) {
    throw new Error('API version is required for Azure OpenAI')
  }

  const url = buildChatCompletionsUrl(config)
  const authHeaders = buildProviderAuthHeaders(config.auth, config.provider)

  let lastErrorText = ''
  for (let attempt = 0; attempt <= MAX_CONTENT_FILTER_RETRIES; attempt++) {
    const temperature = 0.3 + attempt * 0.15

    const body = buildChatRequestBody(
      config,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { temperature, jsonMode },
    )

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      signal,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      if (isLlmAuthStatus(res.status)) {
        throw new LlmAuthError(res.status, config.auth.mode, errorText.slice(0, 500))
      }
      if (isContentFilterError(res.status, errorText) && attempt < MAX_CONTENT_FILTER_RETRIES) {
        lastErrorText = errorText
        await new Promise((r) => setTimeout(r, CONTENT_FILTER_RETRY_DELAY_MS * (attempt + 1)))
        continue
      }
      throw new Error(`LLM request failed (${res.status}): ${errorText.slice(0, 300)}`)
    }

    const data = (await res.json()) as ChatCompletionResponse
    const content = data?.choices?.[0]?.message?.content ?? ''
    if (!content) {
      throw new Error('LLM returned an empty completion')
    }
    return content
  }

  throw new Error(
    `LLM content filter triggered after ${MAX_CONTENT_FILTER_RETRIES} retries: ${lastErrorText.slice(0, 300)}`,
  )
}

// ─── Embeddings Call ────────────────────────────────────────────────────────

export interface CallLlmEmbeddingsParams {
  config: LlmProviderConfig
  inputs: string[]
  signal?: AbortSignal
}

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[]; index?: number }>
}

const EMBED_BATCH_SIZE = 16

/**
 * Compute embeddings for an array of strings in batches.
 * Returns vectors in the same order as `inputs`.
 */
export async function callLlmEmbeddings(params: CallLlmEmbeddingsParams): Promise<number[][]> {
  const { config, inputs, signal } = params

  if (!config.endpoint.trim()) throw new Error('Embedding endpoint is required')
  if (!config.model.trim()) throw new Error('Embedding model/deployment is required')
  if (config.provider === 'azure-openai' && !config.apiVersion?.trim()) {
    throw new Error('API version is required for Azure OpenAI')
  }

  if (inputs.length === 0) return []

  const url = buildEmbeddingsUrl(config)
  const authHeaders = buildProviderAuthHeaders(config.auth, config.provider)

  const out: number[][] = new Array(inputs.length)
  for (let start = 0; start < inputs.length; start += EMBED_BATCH_SIZE) {
    if (signal?.aborted) throw new Error('aborted')
    const batch = inputs.slice(start, start + EMBED_BATCH_SIZE)
    const body = buildEmbeddingsRequestBody(config, batch)

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      signal,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      if (isLlmAuthStatus(res.status)) {
        throw new LlmAuthError(res.status, config.auth.mode, errorText.slice(0, 500))
      }
      throw new Error(`LLM embeddings failed (${res.status}): ${errorText.slice(0, 300)}`)
    }

    const data = (await res.json()) as EmbeddingsResponse
    const arr = Array.isArray(data?.data) ? data.data : []
    for (let i = 0; i < batch.length; i++) {
      const e = arr.find((x) => x?.index === i) ?? arr[i]
      const v = Array.isArray(e?.embedding) ? (e!.embedding as number[]) : []
      out[start + i] = v
    }
  }
  return out
}

// ─── Provider Defaults ──────────────────────────────────────────────────────

export const PROVIDER_DEFAULTS: Record<
  LlmProviderType,
  { endpoint: string; apiVersion: string; authModes: LlmAuthMode[] }
> = {
  'azure-openai': { endpoint: '', apiVersion: '2024-10-21', authModes: ['apiKey', 'bearer'] },
  openai: { endpoint: 'https://api.openai.com', apiVersion: '', authModes: ['apiKey'] },
}

export const LLM_PROVIDER_LABELS: Record<LlmProviderType, { ja: string; en: string }> = {
  'azure-openai': { ja: 'Azure OpenAI', en: 'Azure OpenAI' },
  openai: { ja: 'OpenAI', en: 'OpenAI' },
}

/** Ordered list for UI dropdown. */
export const LLM_PROVIDER_OPTIONS: LlmProviderType[] = ['azure-openai', 'openai']
