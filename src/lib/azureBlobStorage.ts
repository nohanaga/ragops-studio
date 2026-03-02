/**
 * Azure Blob Storage REST client.
 *
 * Provides helpers for generating Account SAS tokens and reading blob objects
 * from Azure Blob Storage.  Used by the Debug Runner to fetch Knowledge Store
 * projection data after an indexer run.
 *
 * Authentication uses Account SAS generated client-side via the Web Crypto API
 * (HMAC-SHA256).  In development mode requests are routed through the Vite dev
 * proxy (`/api-proxy`) to avoid CORS issues.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StorageConnectionInfo {
  accountName: string
  accountKey: string
  endpointSuffix: string
}

// ---------------------------------------------------------------------------
// Connection string parsing
// ---------------------------------------------------------------------------

/**
 * Parse an Azure Storage connection string into its component parts.
 *
 * Expected format:
 *   DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net
 */
export function parseStorageConnectionString(connectionString: string): StorageConnectionInfo | null {
  const parts: Record<string, string> = {}
  for (const segment of connectionString.split(';')) {
    const idx = segment.indexOf('=')
    if (idx < 1) continue
    const key = segment.slice(0, idx).trim()
    const value = segment.slice(idx + 1).trim()
    if (key) parts[key] = value
  }

  const accountName = parts['AccountName']
  const accountKey = parts['AccountKey']
  const endpointSuffix = parts['EndpointSuffix'] || 'core.windows.net'

  if (!accountName || !accountKey) return null
  return { accountName, accountKey, endpointSuffix }
}

// ---------------------------------------------------------------------------
// Account SAS generation (Web Crypto API – HMAC-SHA256)
// ---------------------------------------------------------------------------

function formatUtcIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Generate an **Account SAS** token for Azure Blob Storage.
 *
 * Uses version 2022-11-02 by default.  The returned string is a URL query
 * string (without leading `?`) that can be appended to any request URL.
 *
 * @see https://learn.microsoft.com/rest/api/storageservices/create-account-sas
 */
export async function generateAccountSas(params: {
  accountName: string
  accountKey: string
  permissions?: string
  services?: string
  resourceTypes?: string
  expiryMinutes?: number
  version?: string
}): Promise<string> {
  const {
    accountName,
    accountKey,
    permissions = 'rl',
    services = 'b',
    resourceTypes = 'sco',
    expiryMinutes = 60,
    version = '2022-11-02',
  } = params

  const now = new Date()
  // 5 min in the past to accommodate clock skew.
  const start = new Date(now.getTime() - 5 * 60 * 1000)
  const expiry = new Date(now.getTime() + expiryMinutes * 60 * 1000)

  const sv = version
  const ss = services
  const srt = resourceTypes
  const sp = permissions
  const st = formatUtcIso(start)
  const se = formatUtcIso(expiry)
  const spr = 'https'

  // StringToSign for Account SAS (version >= 2020-12-06):
  //   accountname + "\n" + sp + "\n" + ss + "\n" + srt + "\n" +
  //   st + "\n" + se + "\n" + sip + "\n" + spr + "\n" + sv + "\n" +
  //   ses + "\n"
  //
  // Each field is followed by "\n" (including the last one), so the string
  // ends with a trailing newline.
  const stringToSign =
    accountName + '\n' +
    sp + '\n' +
    ss + '\n' +
    srt + '\n' +
    st + '\n' +
    se + '\n' +
    '' + '\n' +   // signedIP  – empty = any
    spr + '\n' +
    sv + '\n' +
    '' + '\n'     // signedEncryptionScope – empty (trailing \n required)

  // Decode base64 AccountKey to raw bytes.
  const keyBytes = Uint8Array.from(atob(accountKey), (c) => c.charCodeAt(0))

  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])

  const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(stringToSign))

  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))

  const qs = new URLSearchParams({ sv, ss, srt, sp, se, st, spr, sig })
  return qs.toString()
}

// ---------------------------------------------------------------------------
// Blob endpoint helper
// ---------------------------------------------------------------------------

export function getBlobEndpoint(accountName: string, endpointSuffix: string): string {
  return `https://${accountName}.blob.${endpointSuffix}`
}

// ---------------------------------------------------------------------------
// Dev-proxy-aware fetch
// ---------------------------------------------------------------------------

function isLikelyBlobStorageEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return host.endsWith('.blob.core.windows.net')
  } catch {
    return false
  }
}

/**
 * Fetch wrapper that routes Azure Blob Storage requests through the Vite dev
 * proxy in development mode (analogous to `aiSearchRest.ts`).
 */
async function blobFetch(url: string, init?: RequestInit): Promise<Response> {
  if (import.meta.env.DEV && isLikelyBlobStorageEndpoint(url)) {
    const parsed = new URL(url)
    const proxyUrl = `/api-proxy${parsed.pathname}${parsed.search}`
    const headers = new Headers(init?.headers)
    headers.set('x-ais-proxy-target', parsed.origin)
    // Mark as idempotent so the proxy can retry on transient errors.
    headers.set('x-ais-idempotent', '1')
    return fetch(proxyUrl, { ...init, headers })
  }
  return fetch(url, init)
}

// ---------------------------------------------------------------------------
// List blobs in a container
// ---------------------------------------------------------------------------

export interface BlobInfo {
  name: string
  contentLength: number
  resourceType: string
}

/**
 * List blobs in a container using the Azure Blob Storage REST API.
 *
 * Returns metadata about each blob so callers can distinguish real content
 * blobs from directory markers (ResourceType=directory, Content-Length=0)
 * that Knowledge Store creates for object projections.
 *
 * @see https://learn.microsoft.com/rest/api/storageservices/list-blobs
 */
export async function listContainerBlobs(params: {
  blobEndpoint: string
  containerName: string
  sasToken: string
  prefix?: string
}): Promise<BlobInfo[]> {
  const { blobEndpoint, containerName, sasToken, prefix } = params
  let url = `${blobEndpoint}/${encodeURIComponent(containerName)}?restype=container&comp=list&${sasToken}`
  if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`

  const res = await blobFetch(url, {
    method: 'GET',
    headers: { 'x-ms-version': '2022-11-02' },
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`List blobs failed (${res.status}): ${errText}`)
  }

  const xml = await res.text()
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const blobEls = doc.getElementsByTagName('Blob')
  const blobs: BlobInfo[] = []
  for (let i = 0; i < blobEls.length; i++) {
    const el = blobEls[i]
    const nameEl = el.getElementsByTagName('Name')[0]
    const name = nameEl?.textContent ?? ''
    if (!name) continue

    const clEl = el.getElementsByTagName('Content-Length')[0]
    const contentLength = parseInt(clEl?.textContent ?? '0', 10) || 0

    const rtEl = el.getElementsByTagName('ResourceType')[0]
    const resourceType = (rtEl?.textContent ?? '').toLowerCase()

    blobs.push({ name, contentLength, resourceType })
  }
  return blobs
}

/**
 * Find the first content blob (non-directory, non-empty) in a Knowledge Store
 * projection container.
 *
 * Knowledge Store object projections structure blobs as:
 *   {base64-encoded-key}/           ← directory marker (Content-Length: 0)
 *   {base64-encoded-key}/{guid}.json ← actual JSON content
 *
 * This helper lists all blobs, filters out directory markers, and returns the
 * first real content blob.  If only directory markers exist, it re-lists using
 * each directory name as a prefix to discover child blobs.
 */
export async function findFirstContentBlob(params: {
  blobEndpoint: string
  containerName: string
  sasToken: string
}): Promise<{ name: string; contentLength: number } | null> {
  const { blobEndpoint, containerName, sasToken } = params

  const allBlobs = await listContainerBlobs({ blobEndpoint, containerName, sasToken })

  // Filter to real content blobs (not directory markers).
  const contentBlobs = allBlobs.filter(
    (b) => b.resourceType !== 'directory' && b.contentLength > 0,
  )

  if (contentBlobs.length > 0) {
    return contentBlobs[0]
  }

  // Only directory markers found — look inside each directory.
  const dirBlobs = allBlobs.filter((b) => b.resourceType === 'directory' || b.contentLength === 0)
  for (const dir of dirBlobs) {
    const prefix = dir.name.endsWith('/') ? dir.name : `${dir.name}/`
    const children = await listContainerBlobs({ blobEndpoint, containerName, sasToken, prefix })
    const childContent = children.filter(
      (b) => b.resourceType !== 'directory' && b.contentLength > 0,
    )
    if (childContent.length > 0) {
      return childContent[0]
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Read a blob as JSON
// ---------------------------------------------------------------------------

/**
 * Download a single blob and parse it as JSON.
 *
 * The blob is expected to be a Knowledge Store object projection (a JSON
 * document representing the enriched `/document` node).
 */
export async function readBlobAsJson(params: {
  blobEndpoint: string
  containerName: string
  blobName: string
  sasToken: string
}): Promise<unknown> {
  const { blobEndpoint, containerName, blobName, sasToken } = params
  // Encode each path segment of the blob name individually so that '/' separators
  // are preserved while special characters (spaces, unicode, etc.) are escaped.
  const encodedBlobPath = blobName
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  const url = `${blobEndpoint}/${encodeURIComponent(containerName)}/${encodedBlobPath}?${sasToken}`

  const res = await blobFetch(url, {
    method: 'GET',
    headers: { 'x-ms-version': '2022-11-02' },
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Read blob failed (${res.status}): ${errText}`)
  }

  // Read as text first so we can give a meaningful error on empty / non-JSON
  // responses instead of the unhelpful "Unexpected end of JSON input".
  const text = await res.text()
  if (!text.trim()) {
    throw new Error('Read blob returned an empty response body.')
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(
      `Read blob returned non-JSON content (${text.length} bytes). First 200 chars: ${text.slice(0, 200)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Delete a container (best-effort cleanup)
// ---------------------------------------------------------------------------

/**
 * Delete a blob container.  Used during debug cleanup to remove the Knowledge
 * Store projection container.
 */
export async function deleteContainer(params: {
  blobEndpoint: string
  containerName: string
  sasToken: string
}): Promise<void> {
  const { blobEndpoint, containerName, sasToken } = params
  // Account SAS with delete permission on containers needs srt=c and sp includes 'd'.
  // If the SAS lacks those permissions the delete is best-effort; we catch
  // errors silently so cleanup doesn't break.
  const url = `${blobEndpoint}/${encodeURIComponent(containerName)}?restype=container&${sasToken}`

  const res = await blobFetch(url, {
    method: 'DELETE',
    headers: { 'x-ms-version': '2022-11-02' },
  })

  if (!res.ok && res.status !== 404) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Delete container failed (${res.status}): ${errText}`)
  }
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

type IsRecord = (v: unknown) => v is Record<string, unknown>
const isRecord: IsRecord = (v): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Walk a projection JSON blob and extract values at enrichment-tree paths.
 *
 * Given a list of `ExtractedOutput` descriptors (as produced by
 * `extractSkillOutputs` in the Debug Runner), look up each one's value inside
 * the projected blob and return a synthetic search-result document whose keys
 * are the target field names.
 *
 * This allows the Enrichment Tree preview to display the projection data using
 * the same logic it already uses for index-fetched documents.
 *
 * @param projectionJson  The raw JSON blob from the Knowledge Store object projection.
 * @param outputs         Array of `{ sourcePath, fieldName }` pairs.
 * @returns A synthetic search-result payload (`{ value: [ doc ] }`) that the
 *          `onFetchedDocs` callback can consume directly.
 */
export function mapProjectionToSearchResult(
  projectionJson: unknown,
  outputs: ReadonlyArray<{ sourcePath: string; fieldName: string; enrichmentPath?: string }>,
): { value: Array<Record<string, unknown>>; '@odata.count': number; _ragops_field_mappings?: Record<string, string> } {
  const doc: Record<string, unknown> = {}
  const mappings: Record<string, string> = {}

  if (!isRecord(projectionJson)) {
    return { 'value': [doc], '@odata.count': 1, '_ragops_field_mappings': mappings }
  }

  for (const { sourcePath, fieldName, enrichmentPath } of outputs) {
    const value = getValueAtEnrichmentPath(projectionJson, sourcePath)
    if (value !== undefined) {
      doc[fieldName] = value
    }
    mappings[sourcePath] = fieldName
    // When the blob path (sourcePath) differs from the original enrichment
    // tree path, register the enrichment path as well so the Enrichment Tree
    // can locate the fetched value by its canonical path.
    if (enrichmentPath && enrichmentPath !== sourcePath) {
      mappings[enrichmentPath] = fieldName
    }
  }

  // Always include `content` so the Enrichment Tree content-fallback works.
  if ('content' in projectionJson && !('content' in doc)) {
    doc['content'] = projectionJson['content']
  }
  // Only add the default content mapping when no output already claimed this path.
  if (!mappings['/document/content']) {
    mappings['/document/content'] = 'content'
  }

  return { 'value': [doc], '@odata.count': 1, '_ragops_field_mappings': mappings }
}

// /**
//  * Resolve a value from a projection JSON blob given an enrichment-tree path
//  * like `/document/organizations` or `/document/pages/*/chunk`.
//  *
//  * Path segments:
//  * - Regular segments are looked up as object keys.
//  * - `*` segments iterate all elements of an array, collecting the values from
//  *   the remaining sub-path for each element.
//  */

function getValueAtEnrichmentPath(root: Record<string, unknown>, path: string): unknown {
  // Strip the "/document" or "/document/" prefix.
  const stripped = path.replace(/^\/document\/?/, '')
  if (!stripped) return root

  const segments = stripped.split('/')
  return walkSegments(root, segments, 0)
}

function walkSegments(current: unknown, segments: string[], idx: number): unknown {
  if (idx >= segments.length) return current

  const seg = segments[idx]

  if (seg === '*') {
    // Wildcard: current must be an array.  Collect the remaining sub-path
    // from every element.
    if (!Array.isArray(current)) return undefined
    const remaining = segments.slice(idx + 1)
    if (remaining.length === 0) return current
    const collected = current
      .map((item) => walkSegments(item, remaining, 0))
      .filter((v) => v !== undefined)
    return collected.length > 0 ? collected : undefined
  }

  if (isRecord(current)) {
    return walkSegments(current[seg], segments, idx + 1)
  }

  return undefined
}
