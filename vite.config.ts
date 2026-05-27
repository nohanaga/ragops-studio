/**
 * Vite configuration.
 *
 * Includes a development proxy to Azure AI Search endpoints to avoid CORS issues,
 * support enterprise proxy environments, and expose a local-only ACA deployment
 * endpoint for the Custom Skill LiveEditor.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

/**
 * Allow-list for proxy targets.
 *
 * The dev proxy intentionally restricts upstream hosts to Azure AI Search
 * domains **and** Azure Blob Storage (for Knowledge Store projection reads)
 * to avoid turning the dev server into an open proxy.
 */
const AIS_ALLOWED_HOST_SUFFIXES = ['.search.windows.net', '.search.azure.com', '.blob.core.windows.net']

/**
 * Reads a proxy URL from common environment variable names.
 *
 * This supports corporate/enterprise environments where outbound traffic must
 * go through an HTTP(S) proxy.
 */
function getEnvProxyUrl(): string | null {
  const v =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    null
  return v ? String(v).trim() : null
}

/**
 * Returns the per-request timeout for the dev proxy.
 *
 * Defaults to 90s, but can be tuned for slow networks/services.
 */
function getTimeoutMs(): number {
  const n = Number(process.env.AIS_DEV_PROXY_TIMEOUT_MS ?? 90_000)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 90_000
}

/**
 * Interprets a request header value as a boolean-like flag.
 *
 * Used to support both single and multi-value headers.
 */
function isTruthyHeaderValue(v: unknown): boolean {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    return s === '1' || s === 'true' || s === 'yes'
  }
  if (Array.isArray(v)) return v.some((x) => isTruthyHeaderValue(x))
  return false
}

/**
 * Detects timeout-like errors emitted by undici/fetch.
 *
 * We map these to 504 to distinguish from other proxy errors.
 */
function isTimeoutLikeError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const name = String((e as { name?: unknown }).name ?? '')
  // undici/fetch can surface timeouts as AbortError/TimeoutError (or similar)
  return name === 'AbortError' || name === 'TimeoutError'
}

async function readRequestBody(req: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) {
    chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c))
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)
}

function sendJson(res: { statusCode: number; setHeader: (name: string, value: string) => void; end: (chunk?: string | Buffer) => void }, statusCode: number, body: unknown): void {
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function normalizeAzureName(input: string, fallback: string, maxLength: number): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

async function runCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true,
      shell: false,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (err) => {
      reject(err)
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(
        new Error(
          [
            `${command} ${args.join(' ')} failed with exit code ${String(code)}`,
            stderr.trim(),
            stdout.trim(),
          ]
            .filter(Boolean)
            .join('\n\n'),
        ),
      )
    })
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function extractStorageAccountName(storageAccountUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(storageAccountUrl)
  } catch {
    throw new Error('storageAccountUrl must be a valid Blob Storage account URL.')
  }

  const [accountName] = parsed.hostname.toLowerCase().split('.')
  if (!accountName) {
    throw new Error('Could not infer the storage account name from storageAccountUrl.')
  }

  return accountName
}

async function lookupStorageAccountResourceId(storageAccountName: string, cwd: string): Promise<string> {
  const result = await runCommand(
    'az',
    [
      'resource',
      'list',
      '--name',
      storageAccountName,
      '--resource-type',
      'Microsoft.Storage/storageAccounts',
      '--query',
      '[0].id',
      '--output',
      'tsv',
    ],
    cwd,
  )

  const resourceId = result.stdout.trim()
  if (!resourceId) {
    throw new Error(`Could not find a storage account resource for ${storageAccountName}.`)
  }

  return resourceId
}

function isRoleAssignmentExistsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes('roleassignmentexists') || normalized.includes('role assignment already exists')
}

async function ensureStorageBlobContributorRole(params: {
  principalId: string
  scope: string
  cwd: string
  logs: string[]
}) {
  const { principalId, scope, cwd, logs } = params

  try {
    await runCommand(
      'az',
      [
        'role',
        'assignment',
        'create',
        '--assignee-object-id',
        principalId,
        '--assignee-principal-type',
        'ServicePrincipal',
        '--role',
        'Storage Blob Data Contributor',
        '--scope',
        scope,
        '--output',
        'none',
      ],
      cwd,
    )
    logs.push('Granted Storage Blob Data Contributor to the Container App managed identity.')
  } catch (error) {
    if (isRoleAssignmentExistsError(error)) {
      logs.push('Storage Blob Data Contributor role assignment already exists.')
      return
    }
    throw error
  }
}

async function publishSkillToRuntime(params: {
  baseUrl: string
  skillName: string
  skillCode: string
  logs: string[]
}) {
  const { baseUrl, skillName, skillCode, logs } = params
  const proxyUrl = getEnvProxyUrl()
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  let lastError = ''

  for (let attempt = 1; attempt <= 12; attempt += 1) {
    logs.push(`Publishing current Skill Code to Blob via runtime (attempt ${attempt}/12)...`)

    try {
      const res = await undiciFetch(`${baseUrl}/upload`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          skill_name: skillName,
          skill_code: skillCode,
          metadata: {
            provisionedVia: 'aca-local-deploy',
          },
        }),
        dispatcher,
      })

      const text = await res.text()
      if (res.ok) {
        if (text.trim()) logs.push(text.trim())
        return
      }

      lastError = `HTTP ${res.status}: ${text.slice(0, 500)}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }

    if (attempt < 12) {
      logs.push(`Runtime is not ready for publish yet: ${lastError}`)
      await delay(10_000)
    }
  }

  throw new Error(
    `Skill publish failed after waiting for runtime readiness and RBAC propagation. ${lastError}`,
  )
}

function acaLocalDeployPlugin(): Plugin {
  return {
    name: 'aca-local-deploy',
    configureServer(server) {
      server.middlewares.use('/local-api/aca/deploy', async (req, res) => {
        if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
          sendJson(res, 405, { success: false, error: 'Method not allowed' })
          return
        }

        try {
          const rawBody = await readRequestBody(req as AsyncIterable<Uint8Array | string>)
          const payload = JSON.parse(rawBody.toString('utf8') || '{}') as {
            skillCode?: string
            skillName?: string
            appName?: string
            resourceGroup?: string
            location?: string
            storageAccountUrl?: string
            storageContainer?: string
          }

          if (!payload.skillCode?.trim()) {
            sendJson(res, 400, { success: false, error: 'skillCode is required' })
            return
          }

          if (!payload.storageAccountUrl?.trim() || !payload.storageContainer?.trim()) {
            sendJson(res, 400, { success: false, error: 'storageAccountUrl and storageContainer are required' })
            return
          }

          const repoRoot = process.cwd()
          const skillRuntimeDir = path.resolve(repoRoot, 'skill-runtime')
          const skillName = normalizeAzureName(payload.skillName ?? '', 'custom-skill', 40)
          const appName = normalizeAzureName(payload.appName ?? '', 'skill-runtime', 32)
          const resourceGroup = normalizeAzureName(payload.resourceGroup ?? '', `${appName}-rg`, 64)
          const location = String(payload.location ?? 'eastus').trim().toLowerCase() || 'eastus'
          const storageAccountUrl = payload.storageAccountUrl.trim()
          const storageContainer = normalizeAzureName(payload.storageContainer ?? '', 'skill-runtime', 63)
          const storageAccountName = extractStorageAccountName(storageAccountUrl)

          const logs: string[] = []
          logs.push('Checking Azure CLI login...')
          await runCommand('az', ['account', 'show', '--output', 'none'], repoRoot)

          try {
            logs.push('Ensuring Azure Container Apps CLI support...')
            const ext = await runCommand('az', ['extension', 'add', '--name', 'containerapp', '--upgrade', '--only-show-errors'], repoRoot)
            if (ext.stdout.trim()) logs.push(ext.stdout.trim())
            if (ext.stderr.trim()) logs.push(ext.stderr.trim())
          } catch (err) {
            logs.push(err instanceof Error ? err.message : String(err))
          }

          logs.push(`Creating resource group ${resourceGroup} in ${location}...`)
          await runCommand('az', ['group', 'create', '--name', resourceGroup, '--location', location, '--output', 'none'], repoRoot)

          logs.push(`Deploying ${appName} with az containerapp up --source skill-runtime ...`)
          const deploy = await runCommand(
            'az',
            [
              'containerapp',
              'up',
              '--name',
              appName,
              '--resource-group',
              resourceGroup,
              '--location',
              location,
              '--ingress',
              'external',
              '--target-port',
              '8000',
              '--system-assigned',
              '--env-vars',
              `SKILL_STORAGE_ACCOUNT_URL=${storageAccountUrl}`,
              `SKILL_STORAGE_CONTAINER=${storageContainer}`,
              'SKILL_STORAGE_PREFIX=skills',
              '--source',
              skillRuntimeDir,
              '--output',
              'json',
            ],
            repoRoot,
          )
          if (deploy.stdout.trim()) logs.push(deploy.stdout.trim())
          if (deploy.stderr.trim()) logs.push(deploy.stderr.trim())

          const show = await runCommand(
            'az',
            [
              'containerapp',
              'show',
              '--name',
              appName,
              '--resource-group',
              resourceGroup,
              '--query',
              'properties.configuration.ingress.fqdn',
              '--output',
              'tsv',
            ],
            repoRoot,
          )

          const fqdn = show.stdout.trim()
          if (!fqdn) {
            throw new Error('Container App FQDN was not returned by az containerapp show.')
          }

          const baseUrl = `https://${fqdn}`

          logs.push('Resolving the Container App managed identity principal ID...')
          const principal = await runCommand(
            'az',
            [
              'containerapp',
              'identity',
              'show',
              '--name',
              appName,
              '--resource-group',
              resourceGroup,
              '--query',
              'principalId',
              '--output',
              'tsv',
            ],
            repoRoot,
          )
          const principalId = principal.stdout.trim()
          if (!principalId) {
            throw new Error('Container App managed identity principalId was not returned.')
          }

          logs.push(`Looking up the storage account resource ID for ${storageAccountName}...`)
          const storageAccountId = await lookupStorageAccountResourceId(storageAccountName, repoRoot)

          logs.push('Ensuring Storage Blob Data Contributor role assignment on the storage account...')
          await ensureStorageBlobContributorRole({
            principalId,
            scope: storageAccountId,
            cwd: repoRoot,
            logs,
          })

          await publishSkillToRuntime({
            baseUrl,
            skillName,
            skillCode: payload.skillCode,
            logs,
          })

          sendJson(res, 200, {
            success: true,
            baseUrl,
            executeUrl: `${baseUrl}/execute`,
            logs: logs.join('\n\n'),
          })
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e)
          server.config.logger.error(`[aca-local-deploy] ${detail}`)
          sendJson(res, 500, { success: false, error: detail })
        }
      })
    },
  }
}

/**
 * Vite dev-server plugin that forwards Azure AI Search calls.
 *
 * The browser UI calls `src/lib/aiSearchRest.ts`, which rewrites the endpoint
 * to `/api-proxy` during development. The client supplies the real upstream
 * origin via a header so this middleware can enforce an allow-list.
 */
function aiSearchDynamicProxyPlugin(): Plugin {
  const proxyUrl = getEnvProxyUrl()
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined
  const timeoutMs = getTimeoutMs()

  return {
    name: 'ai-search-dynamic-proxy',
    configureServer(server) {
      // Mount at /api-proxy so req.url is already rewritten to the upstream path.
      server.middlewares.use('/api-proxy', async (req, res) => {
        try {
          // The client specifies the true upstream URL via header.
          // We validate and allow-list it before forwarding.
          const target = String(req.headers['x-ais-proxy-target'] ?? '').trim()
          if (!target) {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: { message: 'Missing header: x-ais-proxy-target' } }))
            return
          }

          let targetUrl: URL
          try {
            targetUrl = new URL(target)
          } catch {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: { message: 'Invalid x-ais-proxy-target URL' } }))
            return
          }

          const host = targetUrl.hostname.toLowerCase()
          const allowed = AIS_ALLOWED_HOST_SUFFIXES.some((s) => host.endsWith(s))
          if (targetUrl.protocol !== 'https:' || !allowed) {
            // Security: only forward to allowed https origins.
            res.statusCode = 403
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: { message: 'x-ais-proxy-target is not an allowed Azure AI Search host' } }))
            return
          }

          // Preserve the original path/query under /api-proxy.
          const upstream = new URL(req.url ?? '/', targetUrl.origin)

          const method = String(req.method ?? 'GET').toUpperCase()
          let body: Buffer | undefined
          if (method !== 'GET' && method !== 'HEAD') {
            // Read request body from the Node stream and forward it as bytes.
            const chunks: Buffer[] = []
            for await (const c of req as unknown as AsyncIterable<Uint8Array | string>) {
              chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c))
            }
            body = chunks.length ? Buffer.concat(chunks) : undefined
          }

          // Retry policy is opt-in to avoid repeating non-idempotent operations.
          const isIdempotent = isTruthyHeaderValue(req.headers['x-ais-idempotent'])

          // Forward most headers as-is, but strip hop-by-hop and dev-only headers.
          const headers = new Headers()
          for (const [k, v] of Object.entries(req.headers)) {
            if (!v) continue
            const key = k.toLowerCase()
            if (key === 'host') continue
            if (key === 'origin') continue
            if (key === 'referer') continue
            if (key === 'content-length') continue
            if (key === 'x-ais-proxy-target') continue
            if (Array.isArray(v)) headers.set(k, v.join(','))
            else headers.set(k, String(v))
          }

          // One retry for explicitly-idempotent requests.
          const maxAttempts = isIdempotent ? 2 : 1
          let upstreamRes: Response | null = null
          let lastError: unknown = null

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              upstreamRes = await undiciFetch(upstream.toString(), {
                method,
                headers,
                body,
                dispatcher,
                signal: AbortSignal.timeout(timeoutMs),
              })

              // Only retry on transient 502 when the client explicitly marked it safe.
              if (isIdempotent && upstreamRes.status === 502 && attempt < maxAttempts) {
                await upstreamRes.body?.cancel()
                await new Promise((r) => setTimeout(r, 250))
                continue
              }

              break
            } catch (e) {
              lastError = e
              if (isIdempotent && isTimeoutLikeError(e) && attempt < maxAttempts) {
                await new Promise((r) => setTimeout(r, 250))
                continue
              }
              throw e
            }
          }

          if (!upstreamRes) {
            const detail = lastError instanceof Error ? lastError.message : String(lastError)
            throw new Error(detail)
          }

          // Forward status and headers back to the browser.
          res.statusCode = upstreamRes.status
          upstreamRes.headers.forEach((value: string, key: string) => {
            const k = key.toLowerCase()
            // Node fetch may transparently decompress, so do not forward encoding/length
            if (k === 'transfer-encoding') return
            if (k === 'content-encoding') return
            if (k === 'content-length') return
            if (k === 'connection') return
            res.setHeader(key, value)
          })

          // Materialize the body so we can close the upstream response cleanly.
          const buf = Buffer.from(await upstreamRes.arrayBuffer())
          res.end(buf)
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e)
          const isTimeout = isTimeoutLikeError(e)
          
          // Distinguish between timeout (504) and other proxy errors (502).
          res.statusCode = isTimeout ? 504 : 502
          const errorType = isTimeout ? 'Gateway Timeout' : 'Bad Gateway'
          
          server.config.logger.error(`[ai-search-proxy] ${errorType}: ${detail}`)
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              error: {
                message: errorType,
                detail,
                type: isTimeout ? 'timeout' : 'proxy_error',
                envProxyEnabled: !!proxyUrl,
                hint: isTimeout
                  ? 'Request timed out. Consider increasing AIS_DEV_PROXY_TIMEOUT_MS environment variable.'
                  : 'Set HTTPS_PROXY/HTTP_PROXY/ALL_PROXY (and optionally NO_PROXY) in your shell before running Vite.',
              },
            })
          )
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // React fast-refresh + JSX transform.
  plugins: [react(), aiSearchDynamicProxyPlugin(), acaLocalDeployPlugin()],

  // Build-time chunking.
  // NOTE: Be conservative with manual chunking to avoid circular chunk dependencies
  // (which can surface as "Cannot access 'x' before initialization" in production builds).
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined

          // Keep a couple of heavy deps in their own chunks.
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/')
          ) {
            return 'react-vendor'
          }

          if (
            id.includes('/node_modules/bootstrap/') ||
            id.includes('/node_modules/@popperjs/core/')
          ) {
            return 'bootstrap'
          }

          // CodeMirror family (lazy-loaded with SkillPipelineBuilder / SkillCodeEditor / IndexBuilder)
          if (
            id.includes('/@codemirror/') ||
            id.includes('/@uiw/') ||
            id.includes('/@lezer/')
          ) {
            return 'codemirror'
          }

          // React Flow + Dagre (SkillPipelineBuilder only)
          if (id.includes('/@xyflow/') || id.includes('/dagre/')) {
            return 'xyflow'
          }

          // Diff library (PublishDiffModal only)
          if (id.includes('/node_modules/diff/')) {
            return 'diff-vendor'
          }

          // DOMPurify (ResultViewPanel, HTML preview)
          if (id.includes('/dompurify/')) {
            return 'dompurify'
          }

          // Let Rollup decide for everything else.
          return undefined
        },
      },
    },
  },
})
