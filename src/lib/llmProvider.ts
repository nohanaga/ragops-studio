/**
 * Multi-provider LLM abstraction layer.
 *
 * Supports:
 * - `azure-openai`  : Azure OpenAI Service — deployment-based URL with api-version.
 * - `openai`        : OpenAI platform (api.openai.com).
 * - `foundry-local` : Microsoft Foundry Local — on-device inference via OpenAI-compatible REST.
 * - `lmstudio`      : LM Studio — local model hosting with OpenAI-compatible API.
 *
 * All providers share the Chat Completions response shape, allowing a single
 * parsing path. The provider difference is URL format, auth header,
 * and whether `model` appears in the request body.
 */

import type { LlmAuth, LlmAuthMode } from './llmAuth'
import { LlmAuthError, isLlmAuthStatus } from './llmAuth'

// ─── Types ──────────────────────────────────────────────────────────────────

export type LlmProviderType = 'azure-openai' | 'openai' | 'foundry-local' | 'lmstudio'

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
    case 'foundry-local':
    case 'lmstudio':
      return `${base}/v1/chat/completions`
  }
}

export function buildEmbeddingsUrl(config: LlmProviderConfig): string {
  const base = config.endpoint.replace(/\/+$/, '')
  switch (config.provider) {
    case 'azure-openai':
      return `${base}/openai/deployments/${encodeURIComponent(config.model)}/embeddings?api-version=${encodeURIComponent(config.apiVersion || '2024-10-21')}`
    case 'openai':
    case 'foundry-local':
    case 'lmstudio':
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
  // Local providers don't require authentication
  if (LOCAL_PROVIDERS.has(provider)) {
    const k = (auth.apiKey ?? '').trim() || 'none'
    return { Authorization: `Bearer ${k}` }
  }

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
    case 'foundry-local':
    case 'lmstudio':
      return { Authorization: `Bearer ${k}` }
  }
}

// ─── Harmony Token Utilities (gpt-oss models) ──────────────────────────────

/**
 * Regex to strip Harmony special tokens that leak from gpt-oss models
 * served via Foundry Local or older vLLM.
 *
 * Harmony format uses tokens like:
 *   <|start|>, <|end|>, <|return|>,
 *   <|channel|>analysis, <|channel|>commentary, <|channel|>final,
 *   <|message|>, <|call|>
 *
 * This regex removes them so the caller gets clean content.
 */
const HARMONY_TOKEN_RE =
  /<\|(?:start|end|return|call|channel|message)\|>(?:analysis|commentary|final|assistant)?/gi

/**
 * Remove Harmony special tokens from a model response string.
 * Returns the cleaned string, trimmed.
 */
export function stripHarmonyTokens(text: string): string {
  return text.replace(HARMONY_TOKEN_RE, '').trim()
}

// ─── JSON Extraction Utility ────────────────────────────────────────────────

/**
 * Extract a JSON object/array from a string that may contain surrounding prose.
 *
 * Small models (Phi-4, Mistral) often wrap JSON in markdown fences or
 * natural-language preamble. This helper finds the outermost `{…}` or `[…]`
 * and returns that substring, or the original string if nothing is found.
 */
export function extractJsonFromText(text: string): string {
  const trimmed = text.trim()

  // Fast path: already starts with { or [
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed

  // Strip markdown code fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch) {
    const inner = fenceMatch[1].trim()
    if (inner.startsWith('{') || inner.startsWith('[')) return inner
  }

  // Find first { or [ and match to last } or ]
  const objStart = trimmed.indexOf('{')
  const arrStart = trimmed.indexOf('[')
  const start = objStart >= 0 && (arrStart < 0 || objStart < arrStart) ? objStart : arrStart
  if (start < 0) return trimmed

  const open = trimmed[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let escape = false
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (escape) { escape = false; continue }
    if (ch === '\\') { escape = true; continue }
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === open) depth++
    else if (ch === close) { depth--; if (depth === 0) return trimmed.slice(start, i + 1) }
  }

  // Fallback: return from the first brace onward
  return trimmed.slice(start)
}

// ─── Request Body Builder ───────────────────────────────────────────────────

/**
 * JSON Schema descriptor for structured output.
 * Supported by Azure OpenAI, OpenAI, and LM Studio.
 * Not supported by Foundry Local (falls back to extractJsonFromText).
 */
export interface JsonSchemaResponseFormat {
  /** A short identifier for this schema (e.g. `"cluster_label"`). */
  name: string
  /** A valid JSON Schema object. */
  schema: Record<string, unknown>
  /** Enforce strict schema adherence. Defaults to `true`. */
  strict?: boolean
}

/** Providers that support `response_format: { type: 'json_schema' }`. */
const JSON_SCHEMA_PROVIDERS: ReadonlySet<LlmProviderType> = new Set([
  'azure-openai',
  'openai',
  'lmstudio',
])

type ChatTokenLimitParameter = 'max_tokens' | 'max_completion_tokens'

function preferredChatTokenLimitParameter(config: LlmProviderConfig): ChatTokenLimitParameter {
  if (LOCAL_PROVIDERS.has(config.provider)) return 'max_tokens'
  const model = config.model.trim().toLowerCase()
  if (/^(o1|o3|o4)(?:[-_.]|$)/.test(model) || /^gpt-5(?:[-_.]|$)/.test(model)) {
    return 'max_completion_tokens'
  }
  return 'max_tokens'
}

function isMaxTokensUnsupportedError(status: number, body: string): boolean {
  const text = body.toLowerCase()
  return status === 400 && text.includes('max_tokens') && text.includes('max_completion_tokens')
}

export function buildChatRequestBody(
  config: LlmProviderConfig,
  messages: Array<{ role: string; content: string }>,
  options: {
    temperature?: number
    maxTokens?: number
    jsonMode?: boolean
    jsonSchema?: JsonSchemaResponseFormat
    tokenLimitParameter?: ChatTokenLimitParameter
  } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages,
    temperature: options.temperature ?? 0.3,
  }

  // Azure OpenAI: model is encoded in the URL, not the body
  if (config.provider !== 'azure-openai') {
    body.model = config.model
  }

  // Explicit limit on completion length.
  // Local providers (LM Studio, Foundry Local) often default to a very low
  // value (e.g. ~100–300 tokens), which truncates structured JSON output.
  // Newer/reasoning OpenAI models reject max_tokens and require
  // max_completion_tokens. The parameter can be overridden by callLlmChat
  // after a server compatibility error, which matters for arbitrary Azure
  // deployment names that don't reveal the underlying model family.
  const tokenLimit = options.maxTokens && options.maxTokens > 0
    ? options.maxTokens
    : LOCAL_PROVIDERS.has(config.provider)
      ? DEFAULT_LOCAL_MAX_TOKENS
      : undefined
  if (tokenLimit) {
    const tokenLimitParameter = options.tokenLimitParameter ?? preferredChatTokenLimitParameter(config)
    body[tokenLimitParameter] = tokenLimit
  }

  // Structured output via JSON Schema — preferred when a schema is supplied.
  // LM Studio enforces the schema at the grammar/sampling level (llama.cpp /
  // Outlines), guaranteeing well-formed JSON without post-processing.
  if (options.jsonSchema && JSON_SCHEMA_PROVIDERS.has(config.provider)) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: options.jsonSchema.name,
        strict: options.jsonSchema.strict ?? true,
        schema: options.jsonSchema.schema,
      },
    }
  } else if (options.jsonMode && !LOCAL_PROVIDERS.has(config.provider)) {
    // Fallback: simple json_object mode for Azure OpenAI / OpenAI when no
    // explicit schema is provided. Local providers skip response_format
    // entirely; JSON extraction is handled by extractJsonFromText().
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

export interface LlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface CallLlmChatParams {
  config: LlmProviderConfig
  systemPrompt: string
  userPrompt: string
  /** Alternate user prompts to try when Azure/OpenAI content filtering rejects the prompt. */
  contentFilterRetryUserPrompts?: string[]
  signal?: AbortSignal
  /** When false, omit `response_format: json_object`. Defaults to true. */
  jsonMode?: boolean
  /** When supplied, use structured output with JSON Schema instead of plain json_object. */
  jsonSchema?: JsonSchemaResponseFormat
  /** Max completion tokens. Sent as the provider-compatible token limit parameter. */
  maxTokens?: number
  /** Called with token usage info when available in the response. */
  onUsage?: (usage: LlmUsage) => void
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string }
    finish_reason?: string
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

const MAX_CONTENT_FILTER_RETRIES = 3
const CONTENT_FILTER_RETRY_DELAY_MS = 1000

export class LlmContentFilterError extends Error {
  readonly status: number
  readonly responseText: string

  constructor(status: number, responseText: string) {
    super(`LLM prompt was blocked by content filtering (${status}): ${responseText.slice(0, 300)}`)
    this.name = 'LlmContentFilterError'
    this.status = status
    this.responseText = responseText
  }
}

function isContentFilterError(status: number, body: string): boolean {
  return (
    status === 400 &&
    (body.includes('content_filter') ||
      body.includes('content management policy') ||
      body.includes('content filtering'))
  )
}

export function isLlmContentFilterFailure(error: unknown): boolean {
  if (error instanceof LlmContentFilterError) return true
  const message = error instanceof Error ? error.message : String(error)
  return isContentFilterError(400, message) || message.includes('finish_reason: "content_filter"')
}

/**
 * Unified Chat Completions call supporting both providers.
 * Returns the raw assistant content string.
 *
 * When callers provide `contentFilterRetryUserPrompts`, retries content-filter
 * failures with those alternate prompts. Prompt-filter 400 responses require a
 * modified prompt; repeating the same prompt generally fails again.
 */
export async function callLlmChat(params: CallLlmChatParams): Promise<string> {
  const {
    config,
    systemPrompt,
    userPrompt,
    contentFilterRetryUserPrompts = [],
    signal,
    jsonMode = true,
    jsonSchema,
    maxTokens,
    onUsage,
  } = params

  if (!config.endpoint.trim()) throw new Error('LLM endpoint is required')
  if (!config.model.trim()) throw new Error('LLM model/deployment is required')
  if (config.provider === 'azure-openai' && !config.apiVersion?.trim()) {
    throw new Error('API version is required for Azure OpenAI')
  }

  const url = buildChatCompletionsUrl(config)
  const authHeaders = buildProviderAuthHeaders(config.auth, config.provider)
  const retryPrompts = contentFilterRetryUserPrompts
    .map((prompt) => prompt.trim())
    .filter((prompt) => prompt.length > 0 && prompt !== userPrompt.trim())
    .slice(0, MAX_CONTENT_FILTER_RETRIES)

  let lastErrorText = ''
  let tokenLimitParameter = preferredChatTokenLimitParameter(config)
  for (let attempt = 0; attempt <= retryPrompts.length; attempt++) {
    const temperature = 0.3 + attempt * 0.1
    const currentUserPrompt = attempt === 0 ? userPrompt : retryPrompts[attempt - 1]
    let retriedTokenLimitParameter = false

    for (;;) {
      const body = buildChatRequestBody(
        config,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: currentUserPrompt },
        ],
        { temperature, maxTokens, jsonMode, jsonSchema, tokenLimitParameter },
      )

      let res: Response
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          signal,
          body: JSON.stringify(body),
        })
      } catch (fetchErr) {
        // Network error or CORS preflight failure.
        // For local providers, give an actionable hint about CORS settings.
        if (LOCAL_PROVIDERS.has(config.provider)) {
          const label = LLM_PROVIDER_LABELS[config.provider]?.en ?? config.provider
          throw new Error(
            `Failed to connect to ${label} at ${config.endpoint}. ` +
            `Please verify: (1) the server is running, (2) the endpoint URL is correct, ` +
            `(3) CORS is enabled in the server settings. ` +
            `Original error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
          )
        }
        throw fetchErr
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => '')
        if (
          maxTokens &&
          tokenLimitParameter === 'max_tokens' &&
          !retriedTokenLimitParameter &&
          isMaxTokensUnsupportedError(res.status, errorText)
        ) {
          tokenLimitParameter = 'max_completion_tokens'
          retriedTokenLimitParameter = true
          continue
        }
        if (isLlmAuthStatus(res.status)) {
          throw new LlmAuthError(res.status, config.auth.mode, errorText.slice(0, 500))
        }
        if (isContentFilterError(res.status, errorText)) {
          lastErrorText = errorText
          if (attempt < retryPrompts.length) {
            await new Promise((r) => setTimeout(r, CONTENT_FILTER_RETRY_DELAY_MS * (attempt + 1)))
            break
          }
          throw new LlmContentFilterError(res.status, errorText)
        }
        throw new Error(`LLM request failed (${res.status}): ${errorText.slice(0, 300)}`)
      }

      const data = (await res.json()) as ChatCompletionResponse
      const choice = data?.choices?.[0]
      let content = choice?.message?.content ?? ''

      // Detect output truncation: if the model stopped because it hit the
      // token limit, the response is incomplete. This is a common issue with
      // local providers where the default completion limit is very low.
      const finishReason = choice?.finish_reason
      if (finishReason === 'content_filter') {
        lastErrorText = 'LLM completion was filtered (finish_reason: "content_filter").'
        if (attempt < retryPrompts.length) {
          await new Promise((r) => setTimeout(r, CONTENT_FILTER_RETRY_DELAY_MS * (attempt + 1)))
          break
        }
        throw new LlmContentFilterError(200, lastErrorText)
      }
      if (finishReason === 'length' && jsonMode) {
        const provider = LOCAL_PROVIDERS.has(config.provider)
          ? (LLM_PROVIDER_LABELS[config.provider]?.en ?? config.provider)
          : config.provider
        throw new Error(
          `LLM response was truncated (finish_reason: "length"). ` +
          `The output hit the completion token limit before completing the JSON. ` +
          `Provider: ${provider}. ` +
          `Increase "Context Length" in the server settings or reduce the input size.`,
        )
      }

      // Strip Harmony special tokens that may leak from gpt-oss models
      // served via Foundry Local or older vLLM.
      if (content && HARMONY_TOKEN_RE.test(content)) {
        HARMONY_TOKEN_RE.lastIndex = 0
        content = stripHarmonyTokens(content)
      }

      if (!content) {
        throw new Error('LLM returned an empty completion')
      }
      if (onUsage && data.usage) {
        onUsage({
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        })
      }
      return content
    }
  }

  throw new LlmContentFilterError(400, lastErrorText)
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

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        signal,
        body: JSON.stringify(body),
      })
    } catch (fetchErr) {
      if (LOCAL_PROVIDERS.has(config.provider)) {
        const label = LLM_PROVIDER_LABELS[config.provider]?.en ?? config.provider
        throw new Error(
          `Failed to connect to ${label} at ${config.endpoint}. ` +
          `Please verify: (1) the server is running, (2) the endpoint URL is correct, ` +
          `(3) CORS is enabled in the server settings. ` +
          `Original error: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`,
        )
      }
      throw fetchErr
    }

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
  'foundry-local': { endpoint: 'http://localhost:5272', apiVersion: '', authModes: ['apiKey'] },
  lmstudio: { endpoint: 'http://localhost:1234', apiVersion: '', authModes: ['apiKey'] },
}

export const LLM_PROVIDER_LABELS: Record<LlmProviderType, { ja: string; en: string }> = {
  'azure-openai': { ja: 'Azure OpenAI', en: 'Azure OpenAI' },
  openai: { ja: 'OpenAI', en: 'OpenAI' },
  'foundry-local': { ja: 'Foundry Local', en: 'Foundry Local' },
  lmstudio: { ja: 'LM Studio', en: 'LM Studio' },
}

/** Providers that skip auth entirely (local inference — no key needed). */
export const LOCAL_PROVIDERS: ReadonlySet<LlmProviderType> = new Set(['foundry-local', 'lmstudio'])

/**
 * Default max_tokens for local providers.
 * LM Studio and Foundry Local often default to a very small completion limit,
 * causing structured JSON output to be truncated. 4096 is generous enough for
 * the JSON responses used in this application.
 */
export const DEFAULT_LOCAL_MAX_TOKENS = 4096

/** Ordered list for UI dropdown. */
export const LLM_PROVIDER_OPTIONS: LlmProviderType[] = ['azure-openai', 'openai', 'foundry-local', 'lmstudio']

// ─── Model Context Window (Max Input Tokens) ───────────────────────────────

/**
 * Known model max input token limits.
 * Source: https://learn.microsoft.com/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure
 *
 * Keys are lowercase model name fragments for fuzzy matching.
 * Values are the max input tokens (not context window — output is excluded).
 */
export const MODEL_MAX_INPUT_TOKENS: Record<string, number> = {
  // GPT-5.5
  'gpt-5.5': 922_000,
  // GPT-5.4 series
  'gpt-5.4-mini': 272_000,
  'gpt-5.4-nano': 272_000,
  'gpt-5.4-pro': 1_050_000,
  'gpt-5.4': 1_050_000,
  // GPT-5.3
  'gpt-5.3-codex': 272_000,
  'gpt-5.3-chat': 111_616,
  // GPT-5.2
  'gpt-5.2-codex': 272_000,
  'gpt-5.2-chat': 111_616,
  'gpt-5.2': 272_000,
  // GPT-5.1
  'gpt-5.1-codex-max': 272_000,
  'gpt-5.1-codex-mini': 272_000,
  'gpt-5.1-codex': 272_000,
  'gpt-5.1-chat': 111_616,
  'gpt-5.1': 272_000,
  // GPT-5
  'gpt-5-pro': 272_000,
  'gpt-5-codex': 272_000,
  'gpt-5-chat': 128_000,
  'gpt-5-mini': 272_000,
  'gpt-5-nano': 272_000,
  'gpt-5': 272_000,
  // GPT-4.1 series (1M context, but limited to 300K for standard deployments)
  'gpt-4.1-mini': 300_000,
  'gpt-4.1-nano': 300_000,
  'gpt-4.1': 300_000,
  // o-series
  'codex-mini': 200_000,
  'o3-pro': 200_000,
  'o4-mini': 200_000,
  'o3-mini': 200_000,
  'o3': 200_000,
  'o1-mini': 128_000,
  'o1': 200_000,
  // GPT-4o series
  'gpt-4o-mini': 128_000,
  'gpt-4o': 128_000,
  // GPT-4 Turbo
  'gpt-4-turbo': 128_000,
  'gpt-4-32k': 32_768,
  'gpt-4': 8_192,
  // GPT-3.5
  'gpt-35-turbo': 16_385,
  'gpt-3.5-turbo': 16_385,
  // gpt-oss
  'gpt-oss': 131_072,
  // Local models (common defaults)
  'phi-4': 16_384,
  'phi-3.5-mini': 128_000,
  'phi-3': 128_000,
  'qwen2.5-0.5b': 32_768,
  'qwen2.5-7b': 131_072,
  'qwen2.5': 32_768,
  'deepseek-v3': 65_536,
  'deepseek-r1': 65_536,
  'mistral': 32_768,
  'llama-3': 128_000,
}

/** Default fallback when model is unknown. */
export const DEFAULT_MAX_INPUT_TOKENS = 128_000

/**
 * Guess max input tokens from a model/deployment name.
 * Matches the longest key that appears as a substring (case-insensitive).
 * Returns null if no match found.
 */
export function guessMaxInputTokens(model: string): number | null {
  if (!model) return null
  const lower = model.toLowerCase()
  let bestKey = ''
  let bestVal: number | null = null
  for (const [key, val] of Object.entries(MODEL_MAX_INPUT_TOKENS)) {
    if (lower.includes(key) && key.length > bestKey.length) {
      bestKey = key
      bestVal = val
    }
  }
  return bestVal
}

/**
 * Resolve the effective max input tokens for a profile.
 * Priority: explicit override > guessed from model name > default.
 */
export function resolveMaxInputTokens(model: string, override?: number): number {
  if (override && override > 0) return override
  return guessMaxInputTokens(model) ?? DEFAULT_MAX_INPUT_TOKENS
}
