/**
 * Cloud Skill Runtime client.
 *
 * Communicates with a FastAPI-based Custom Skill Runtime deployed on
 * Azure Container Apps (or any HTTP endpoint that implements the
 * Custom Skill Interface).
 *
 * The runtime exposes:
 *   POST /simulate  — Execute a skill with test input
 *   POST /upload    — Upload skill code to Blob Storage
 *   GET  /health    — Health check
 *
 * In development mode, requests are routed through the Vite dev proxy
 * if the runtime URL matches the proxy allow-list.
 */

import type { SkillPayload } from './skillValidator'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillRuntimeConfig {
  /** Runtime base URL or full execute endpoint (e.g. https://...azurecontainerapps.io or https://.../execute) */
  runtimeUrl: string
  /** Optional API key for the runtime */
  apiKey?: string
}

export type SimulateRequest = {
  /** Python skill code to execute */
  skillCode: string
  /** Custom Skill Interface input payload */
  input: SkillPayload
  /** Optional timeout in seconds */
  timeout?: number
}

export type SimulateResponse = {
  /** Whether the execution succeeded */
  success: boolean
  /** Custom Skill Interface output payload (on success) */
  output?: SkillPayload
  /** Error message (on failure) */
  error?: string
  /** Execution time in milliseconds */
  executionTimeMs?: number
  /** stdout/stderr logs from the skill execution */
  logs?: string
}

export type HealthResponse = {
  status: 'ok' | 'error'
  version?: string
  activeSkill?: string | null
  storageConfigured?: boolean
}

export type DeploySkillRuntimeRequest = {
  skillCode: string
  skillName: string
  appName: string
  resourceGroup: string
  location: string
  storageAccountUrl: string
  storageContainer: string
}

export type DeploySkillRuntimeResponse = {
  success: boolean
  baseUrl?: string
  executeUrl?: string
  logs?: string
  error?: string
}

export type UploadSkillCodeResponse = {
  success: boolean
  message?: string
  error?: string
  executePath?: string
  skillPath?: string
  activeSkill?: string
  /** SHA-256 hash of the uploaded skill code. */
  codeHash?: string
}

export type DownloadSkillCodeResponse = {
  success: boolean
  skillName?: string
  skillCode?: string
  updatedAt?: string
  /** SHA-256 hash of the skill code stored in Blob. */
  codeHash?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
}

function resolveRuntimeBaseUrl(runtimeUrl: string): string {
  const normalized = normalizeUrl(runtimeUrl)
  if (!normalized) return normalized

  try {
    const parsed = new URL(normalized)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return normalized
  }
}

export function resolveRuntimeExecuteUrl(runtimeUrl: string): string {
  const normalized = normalizeUrl(runtimeUrl)
  if (!normalized) return normalized

  try {
    const parsed = new URL(normalized)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (!pathname || pathname === '') {
      parsed.pathname = '/execute'
      return parsed.toString().replace(/\/$/, '')
    }

    if (pathname === '/execute' || pathname.startsWith('/skills/')) {
      return parsed.toString().replace(/\/$/, '')
    }

    return parsed.toString().replace(/\/$/, '')
  } catch {
    if (normalized.endsWith('/execute') || normalized.includes('/skills/')) return normalized
    return `${normalized}/execute`
  }
}

function buildHeaders(config: SkillRuntimeConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (config.apiKey) {
    headers['x-api-key'] = config.apiKey
  }
  return headers
}

/**
 * Execute a skill against a Cloud Runtime.
 *
 * Sends the Python code + test input to POST /simulate and returns
 * the execution result.
 */
export async function simulateSkill(
  config: SkillRuntimeConfig,
  request: SimulateRequest,
): Promise<SimulateResponse> {
  const base = resolveRuntimeBaseUrl(config.runtimeUrl)
  const url = `${base}/simulate`

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify({
      skill_code: request.skillCode,
      input: request.input,
      timeout: request.timeout ?? 30,
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      success: false,
      error: `Runtime error (HTTP ${res.status}): ${text.slice(0, 500)}`,
    }
  }

  return (await res.json()) as SimulateResponse
}

/**
 * Execute the deployed runtime endpoint.
 *
 * If runtimeUrl is a base URL, `/execute` is appended.
 * If runtimeUrl already points to `/execute` or `/skills/{name}`, it is used as-is.
 */
export async function executeRemoteSkill(
  config: SkillRuntimeConfig,
  input: SkillPayload,
  skillsetName?: string,
): Promise<SimulateResponse> {
  let url = resolveRuntimeExecuteUrl(config.runtimeUrl)
  if (skillsetName) {
    try {
      const u = new URL(url)
      u.searchParams.set('skillset_name', skillsetName)
      url = u.toString()
    } catch {
      const stripped = url.replace(/([?&])skillset_name=[^&]*/g, '').replace(/\?$/, '')
      const sep = stripped.includes('?') ? '&' : '?'
      url = `${stripped}${sep}skillset_name=${encodeURIComponent(skillsetName)}`
    }
  }
  const startedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify(input),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return {
        success: false,
        error: `Runtime endpoint error (HTTP ${res.status}): ${text.slice(0, 500)}`,
      }
    }

    const output = (await res.json()) as SkillPayload
    const endedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now()

    return {
      success: true,
      output,
      executionTimeMs: Math.round((endedAt - startedAt) * 100) / 100,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error: msg,
    }
  }
}

/**
 * Check the health of the Cloud Runtime.
 */
export async function checkHealth(config: SkillRuntimeConfig): Promise<HealthResponse> {
  const base = resolveRuntimeBaseUrl(config.runtimeUrl)
  const url = `${base}/health`

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(config),
    })

    if (!res.ok) {
      return { status: 'error' }
    }

    return (await res.json()) as HealthResponse
  } catch {
    return { status: 'error' }
  }
}

/**
 * Download the deployed skill code from the runtime's Blob Storage.
 */
export async function downloadSkillCode(
  config: SkillRuntimeConfig,
  skillName: string,
  skillsetName?: string,
): Promise<DownloadSkillCodeResponse> {
  const base = resolveRuntimeBaseUrl(config.runtimeUrl)
  const encodedName = encodeURIComponent(skillName)
  const qs = skillsetName ? `?skillset_name=${encodeURIComponent(skillsetName)}` : ''
  const url = `${base}/skills/${encodedName}/code${qs}`

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(config),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { success: false, error: `Download failed (HTTP ${res.status}): ${text.slice(0, 500)}` }
    }

    const parsed = (await res.json()) as { skillName?: string; skillCode?: string; updatedAt?: string; codeHash?: string }
    if (!parsed.skillCode) {
      return { success: false, error: 'Runtime returned an empty skill code.' }
    }

    return {
      success: true,
      skillName: parsed.skillName,
      skillCode: parsed.skillCode,
      updatedAt: parsed.updatedAt,
      codeHash: parsed.codeHash,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

/**
 * Upload skill code to the runtime's Blob Storage.
 *
 * This is a convenience wrapper — the runtime handles the actual
 * Blob Storage write via its managed identity or connection string.
 */
export async function uploadSkillCode(
  config: SkillRuntimeConfig,
  params: {
    skillName: string
    skillCode: string
    skillsetName?: string
    requirementsTxt?: string
    metadata?: Record<string, unknown>
  },
): Promise<UploadSkillCodeResponse> {
  const base = resolveRuntimeBaseUrl(config.runtimeUrl)
  const url = `${base}/upload`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(config),
      body: JSON.stringify({
        skill_name: params.skillName,
        skill_code: params.skillCode,
        skillset_name: params.skillsetName || undefined,
        requirements_txt: params.requirementsTxt,
        metadata: params.metadata,
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { success: false, error: `Upload failed (HTTP ${res.status}): ${text.slice(0, 500)}` }
    }

    const parsed = (await res.json().catch(() => ({ success: true }))) as Partial<UploadSkillCodeResponse>
    return {
      success: parsed.success ?? true,
      message: parsed.message,
      error: parsed.error,
      executePath: parsed.executePath,
      skillPath: parsed.skillPath,
      activeSkill: parsed.activeSkill,
      codeHash: parsed.codeHash,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}

/**
 * Provision and deploy the local skill-runtime folder to Azure Container Apps.
 *
 * This is intentionally a local-dev-only path. It shells out to `az` through
 * the Vite dev server and returns the deployed endpoint.
 */
export async function deploySkillRuntimeToAca(
  request: DeploySkillRuntimeRequest,
): Promise<DeploySkillRuntimeResponse> {
  if (!import.meta.env.DEV) {
    return {
      success: false,
      error: 'ACA auto-deploy is only available while running the local Vite dev server.',
    }
  }

  try {
    const res = await fetch('/local-api/aca/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skillCode: request.skillCode,
        skillName: request.skillName,
        appName: request.appName,
        resourceGroup: request.resourceGroup,
        location: request.location,
        storageAccountUrl: request.storageAccountUrl,
        storageContainer: request.storageContainer,
      }),
    })

    const text = await res.text()
    const parsed = text ? JSON.parse(text) as DeploySkillRuntimeResponse : { success: false }
    if (!res.ok) return { success: false, error: parsed.error ?? `HTTP ${res.status}`, logs: parsed.logs }
    return parsed
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
