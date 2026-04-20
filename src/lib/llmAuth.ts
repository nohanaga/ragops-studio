/**
 * Common LLM (Azure OpenAI / Cognitive Services) authentication helper.
 *
 * Mirrors the ConnectionProfile.authType pattern used by the AI Search REST
 * helpers (`apiKey` vs `bearer`) so that all LLM-calling features (Eval Dataset
 * Generator, Text to Vector, Vector Optimizer) share a single auth contract.
 *
 * Bearer tokens are expected to be obtained out-of-band by the user, e.g. via
 * `az account get-access-token --resource https://cognitiveservices.azure.com`.
 */

export type LlmAuthMode = 'apiKey' | 'bearer'

export interface LlmAuth {
  mode: LlmAuthMode
  apiKey?: string
  bearerToken?: string
}

/** AAD resource for Azure OpenAI / Cognitive Services data-plane operations. */
export const AOAI_AAD_RESOURCE = 'https://cognitiveservices.azure.com'

/**
 * Build the appropriate auth header(s) for an LLM HTTP call.
 * Throws when the selected mode lacks its credential.
 */
export function buildLlmAuthHeaders(auth: LlmAuth): Record<string, string> {
  if (auth.mode === 'bearer') {
    const t = (auth.bearerToken ?? '').trim()
    if (!t) throw new Error('Bearer token is required for Entra ID authentication')
    return { Authorization: t.startsWith('Bearer ') ? t : `Bearer ${t}` }
  }
  const k = (auth.apiKey ?? '').trim()
  if (!k) throw new Error('API key is required for API-key authentication')
  return { 'api-key': k }
}

/**
 * Build the Azure CLI command users can copy/paste to obtain a bearer token
 * scoped to the given resource (defaults to Cognitive Services / AOAI).
 */
export function buildAadCliCommand(resource: string = AOAI_AAD_RESOURCE): string {
  return `az account get-access-token --resource ${resource} --query accessToken -o tsv`
}

/**
 * Authentication failure raised by LLM helpers when the server returns a
 * 401/403. Callers can catch this to short-circuit pipelines and surface
 * actionable guidance (rather than spamming the same auth error per worker).
 */
export class LlmAuthError extends Error {
  readonly status: number
  readonly authMode: LlmAuthMode
  readonly responseText: string
  constructor(status: number, authMode: LlmAuthMode, responseText: string) {
    super(`LLM authentication failed (HTTP ${status})`)
    this.name = 'LlmAuthError'
    this.status = status
    this.authMode = authMode
    this.responseText = responseText
  }
}

/** Treat 401/403 as authentication-class failures. */
export function isLlmAuthStatus(status: number): boolean {
  return status === 401 || status === 403
}

/**
 * Build a user-facing, localized message explaining how to recover from an
 * LLM auth failure. For bearer auth the AAD CLI command is included so the
 * user can re-acquire an expired access token in one copy/paste.
 */
export function formatLlmAuthErrorMessage(
  err: LlmAuthError,
  lang: 'ja' | 'en',
): string {
  const cli = buildAadCliCommand()
  if (lang === 'ja') {
    if (err.authMode === 'bearer') {
      return (
        `Azure OpenAI の認証に失敗しました (HTTP ${err.status})。` +
        `Bearer トークンが期限切れか、スコープ・テナントが正しくない可能性があります。` +
        `次のコマンドで再取得し、貼り直してから再実行してください:\n${cli}`
      )
    }
    return (
      `Azure OpenAI の認証に失敗しました (HTTP ${err.status})。` +
      `API Key が正しいか、ローテーションされていないかを確認してください。`
    )
  }
  if (err.authMode === 'bearer') {
    return (
      `Azure OpenAI authentication failed (HTTP ${err.status}). ` +
      `Your bearer token may be expired or scoped to the wrong resource/tenant. ` +
      `Re-acquire one and paste it again before retrying:\n${cli}`
    )
  }
  return (
    `Azure OpenAI authentication failed (HTTP ${err.status}). ` +
    `Check that the API key is correct and has not been rotated.`
  )
}
