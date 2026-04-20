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
