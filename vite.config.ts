/**
 * Vite configuration.
 *
 * Includes a development proxy to Azure AI Search endpoints to avoid CORS issues
 * and to support enterprise proxy environments.
 */

import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fetch as undiciFetch, ProxyAgent } from 'undici'

/**
 * Allow-list for proxy targets.
 *
 * The dev proxy intentionally restricts upstream hosts to Azure AI Search
 * domains to avoid turning the dev server into an open proxy.
 */
const AIS_ALLOWED_HOST_SUFFIXES = ['.search.windows.net', '.search.azure.com']

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
  plugins: [react(), aiSearchDynamicProxyPlugin()],

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

          // Let Rollup decide for everything else.
          return undefined
        },
      },
    },
  },
})
