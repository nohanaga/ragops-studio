/**
 * Azure AI Search REST client.
 *
 * Provides typed helpers for calling the service APIs, including development
 * proxy routing, consistent error handling, and request-id propagation.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ConnectionProfile, SearchApiVersion } from './model';
import { translations, type Language } from './translations';

type TranslationKey = keyof typeof translations.ja;

function getLang(language?: Language): Language {
  return language ?? 'ja';
}

function tr(language: Language, key: TranslationKey): string {
  return translations[language][key];
}

export function resolveSearchApiVersion(
  configuredVersion: SearchApiVersion | undefined,
  minimumVersion: SearchApiVersion,
): SearchApiVersion {
  const configured = configuredVersion?.trim();
  const configuredDate = configured?.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
  const minimumDate = minimumVersion.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];

  if (!configured || !configuredDate || !minimumDate || configuredDate < minimumDate) {
    return minimumVersion;
  }

  return configured;
}

function makeNetworkErrorMessage(language: Language, rawMessage: string): string {
  const hint = rawMessage === 'Failed to fetch' ? tr(language, 'restNetworkErrorCorsHint') : '';
  return `${tr(language, 'restNetworkErrorPrefix')}: ${rawMessage}${hint}`;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RestResult =
  | {
      ok: true;
      status: number;
      /** Service request id (from response headers when available); falls back to clientRequestId. */
      requestId: string;
      /** Client-generated request id sent as `x-ms-client-request-id`. */
      clientRequestId?: string;
      url: string;
      response: JsonValue;
      responseText?: string;
      elapsedTimeMs?: number;
    }
  | {
      ok: false;
      status: number;
      /** Service request id (from response headers when available); falls back to clientRequestId. */
      requestId: string;
      /** Client-generated request id sent as `x-ms-client-request-id`. */
      clientRequestId?: string;
      url: string;
      error: {
        message: string;
        response?: JsonValue;
        responseText?: string;
      };
      elapsedTimeMs?: number;
    };

function getServiceRequestId(res: Response): string | undefined {
  // Azure services commonly return `request-id`; some environments may use `x-ms-request-id`.
  return res.headers.get('request-id') ?? res.headers.get('x-ms-request-id') ?? undefined;
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  const normalized = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
  
  // In development, route through the proxy.
  if (import.meta.env.DEV && isLikelyAzureAiSearchEndpoint(normalized)) {
    return '/api-proxy';
  }
  
  return normalized;
}

function isLikelyAzureAiSearchEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    const host = u.hostname.toLowerCase();
    return host.endsWith('.search.windows.net') || host.endsWith('.search.azure.com');
  } catch {
    return false;
  }
}

function getDevProxyTarget(endpoint: string): string | null {
  if (!import.meta.env.DEV) return null;
  if (!isLikelyAzureAiSearchEndpoint(endpoint)) return null;
  try {
    const u = new URL(endpoint);
    // Origin only (exclude path/query).
    return u.origin;
  } catch {
    return null;
  }
}

function normalizeRawEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function getQuerySourceAuthorizationHeaderValue(profile: ConnectionProfile): string | null {
  const value = profile.querySourceAuthorization?.trim();
  if (!value) return null;
  // Backward compatibility: if the flag is missing in existing data,
  // send the header when a value is present (legacy behavior).
  if (profile.useQuerySourceAuthorization === false) return null;
  return value;
}

function makeAuthHeaders(
  profile: ConnectionProfile,
  language?: Language,
  options?: { useDevProxy?: boolean }
): Record<string, string> {
  const useDevProxy = options?.useDevProxy ?? true;
  const proxyTarget = useDevProxy ? getDevProxyTarget(profile.endpoint) : null;
  const lang = getLang(language);

  if (profile.authType === 'apiKey') {
    if (!profile.apiKey) throw new Error(tr(lang, 'restErrorApiKeyUnset'));
    return proxyTarget ? { 'api-key': profile.apiKey, 'x-ais-proxy-target': proxyTarget } : { 'api-key': profile.apiKey };
  }

  if (profile.authType === 'bearer') {
    if (!profile.bearerToken) throw new Error(tr(lang, 'restErrorBearerTokenUnset'));
    const token = profile.bearerToken.trim();
    const auth = { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}` };
    return proxyTarget ? { ...auth, 'x-ais-proxy-target': proxyTarget } : auth;
  }

  throw new Error(tr(lang, 'restErrorAuthTypeUnsupported'));
}

function isUsingDevProxy(profile: ConnectionProfile): boolean {
  return getDevProxyTarget(profile.endpoint) !== null;
}

async function readJsonOrText(res: Response): Promise<{ json?: JsonValue; text?: string }> {
  const contentType = res.headers.get('content-type') ?? '';
  const raw = await res.text();

  if (raw.length === 0) return {};
  if (contentType.includes('application/json')) {
    try {
      return { json: JSON.parse(raw) as JsonValue, text: raw };
    } catch {
      return { text: raw };
    }
  }

  try {
    return { json: JSON.parse(raw) as JsonValue, text: raw };
  } catch {
    return { text: raw };
  }
}

function extractErrorMessage(status: number, parsed: { json?: JsonValue; text?: string }): string {
  let baseMsg = `HTTP ${status}`;
  
  if (parsed.json && typeof parsed.json === 'object' && parsed.json !== null) {
    const errObj = parsed.json as Record<string, JsonValue>;
    if (errObj.error && typeof errObj.error === 'object') {
      const errorDetail = errObj.error as Record<string, JsonValue>;
      if (typeof errorDetail.message === 'string') {
        baseMsg += `: ${errorDetail.message}`;
      } else if (typeof errorDetail.code === 'string') {
        baseMsg += `: ${errorDetail.code}`;
      }
    } else if (typeof errObj.message === 'string') {
      baseMsg += `: ${errObj.message}`;
    }
  } else if (parsed.text && parsed.text.length < 500) {
    baseMsg += `: ${parsed.text}`;
  }
  
  return baseMsg;
}

export async function searchDocuments(input: {
  profile: ConnectionProfile;
  indexName: string;
  apiVersion: SearchApiVersion;
  body: JsonValue;
  language?: Language;
  signal?: AbortSignal;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const directEndpoint = normalizeRawEndpoint(input.profile.endpoint);
  const indexName = input.indexName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!indexName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  const clientRequestId = uuidv4();
  const url = `${endpoint}/indexes/${encodeURIComponent(indexName)}/docs/search?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  // Dev proxy can safely retry idempotent operations on transient 502/timeout.
  if (isUsingDevProxy(input.profile)) headers['x-ais-idempotent'] = 'true';
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  const fallbackUrl = `${directEndpoint}/indexes/${encodeURIComponent(indexName)}/docs/search?api-version=${encodeURIComponent(input.apiVersion)}`;
  const fallbackHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang, { useDevProxy: false }),
  };
  if (qsa) fallbackHeaders['x-ms-query-source-authorization'] = qsa;

  let res: Response;
  let resultUrl = url;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body ?? {}),
      signal: input.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    // In some debug-runner environments, `/api-proxy` is not reachable.
    // Fall back once to the direct endpoint when the proxy path fails at network level.
    if (isUsingDevProxy(input.profile)) {
      try {
        res = await fetch(fallbackUrl, {
          method: 'POST',
          headers: fallbackHeaders,
          body: JSON.stringify(input.body ?? {}),
          signal: input.signal,
        });
        resultUrl = fallbackUrl;
      } catch (fallbackError) {
        const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        return {
          ok: false,
          status: 0,
          requestId: clientRequestId,
          clientRequestId,
          url: fallbackUrl,
          error: {
            message: makeNetworkErrorMessage(lang, fallbackMsg),
          },
        };
      }
    } else {
      return {
        ok: false,
        status: 0,
        requestId: clientRequestId,
        clientRequestId,
        url,
        error: {
          message: makeNetworkErrorMessage(lang, msg),
        },
      };
    }
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;

  const parsed = await readJsonOrText(res);
  const elapsedTimeHeader = res.headers.get('elapsed-time');
  const elapsedTimeMs = elapsedTimeHeader ? parseFloat(elapsedTimeHeader) : undefined;

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url: resultUrl,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
      elapsedTimeMs,
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url: resultUrl,
    response: (parsed.json ?? (parsed.text as unknown as JsonValue)) ?? null,
    responseText: parsed.text,
    elapsedTimeMs,
  };
}

async function postIndexDocumentsOperation(input: {
  profile: ConnectionProfile;
  indexName: string;
  apiVersion: SearchApiVersion;
  body: JsonValue;
  language?: Language;
  signal?: AbortSignal;
  operation: 'autocomplete' | 'suggest';
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const directEndpoint = normalizeRawEndpoint(input.profile.endpoint);
  const indexName = input.indexName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!indexName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  const clientRequestId = uuidv4();
  const url = `${endpoint}/indexes/${encodeURIComponent(indexName)}/docs/${input.operation}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  if (isUsingDevProxy(input.profile)) headers['x-ais-idempotent'] = 'true';
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  const fallbackUrl = `${directEndpoint}/indexes/${encodeURIComponent(indexName)}/docs/${input.operation}?api-version=${encodeURIComponent(input.apiVersion)}`;
  const fallbackHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang, { useDevProxy: false }),
  };
  if (qsa) fallbackHeaders['x-ms-query-source-authorization'] = qsa;

  let res: Response;
  let resultUrl = url;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body ?? {}),
      signal: input.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    if (isUsingDevProxy(input.profile)) {
      try {
        res = await fetch(fallbackUrl, {
          method: 'POST',
          headers: fallbackHeaders,
          body: JSON.stringify(input.body ?? {}),
          signal: input.signal,
        });
        resultUrl = fallbackUrl;
      } catch (fallbackError) {
        const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        return {
          ok: false,
          status: 0,
          requestId: clientRequestId,
          clientRequestId,
          url: fallbackUrl,
          error: {
            message: makeNetworkErrorMessage(lang, fallbackMsg),
          },
        };
      }
    } else {
      return {
        ok: false,
        status: 0,
        requestId: clientRequestId,
        clientRequestId,
        url,
        error: {
          message: makeNetworkErrorMessage(lang, msg),
        },
      };
    }
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;
  const parsed = await readJsonOrText(res);
  const elapsedTimeHeader = res.headers.get('elapsed-time');
  const elapsedTimeMs = elapsedTimeHeader ? parseFloat(elapsedTimeHeader) : undefined;

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url: resultUrl,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
      elapsedTimeMs,
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url: resultUrl,
    response: (parsed.json ?? (parsed.text as unknown as JsonValue)) ?? null,
    responseText: parsed.text,
    elapsedTimeMs,
  };
}

export async function autocompleteDocuments(input: {
  profile: ConnectionProfile;
  indexName: string;
  apiVersion: SearchApiVersion;
  body: JsonValue;
  language?: Language;
  signal?: AbortSignal;
}): Promise<RestResult> {
  return postIndexDocumentsOperation({ ...input, operation: 'autocomplete' });
}

export async function suggestDocuments(input: {
  profile: ConnectionProfile;
  indexName: string;
  apiVersion: SearchApiVersion;
  body: JsonValue;
  language?: Language;
  signal?: AbortSignal;
}): Promise<RestResult> {
  return postIndexDocumentsOperation({ ...input, operation: 'suggest' });
}

export async function analyzeIndex(input: {
  profile: ConnectionProfile;
  indexName: string;
  apiVersion: SearchApiVersion;
  body: JsonValue;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const indexName = input.indexName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!indexName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  const clientRequestId = uuidv4();
  const url = `${endpoint}/indexes/${encodeURIComponent(indexName)}/analyze?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  if (isUsingDevProxy(input.profile)) headers['x-ais-idempotent'] = 'true';

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body ?? {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: {
        message: makeNetworkErrorMessage(lang, msg),
      },
    };
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;

  const parsed = await readJsonOrText(res);
  const elapsedTimeHeader = res.headers.get('elapsed-time');
  const elapsedTimeMs = elapsedTimeHeader ? parseFloat(elapsedTimeHeader) : undefined;

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
      elapsedTimeMs,
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url,
    response: (parsed.json ?? (parsed.text as unknown as JsonValue)) ?? null,
    responseText: parsed.text,
    elapsedTimeMs,
  };
}

export async function listIndexes(input: {
  profile: ConnectionProfile;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));

  const clientRequestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.apiVersion, '2026-05-01-preview');
  const pageSize = 1000;
  const firstUrl = `${endpoint}/indexes?api-version=${encodeURIComponent(apiVersion)}&$top=${pageSize}&$skip=0&$count=true`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  const values: JsonValue[] = [];
  let skip = 0;
  let requestId = clientRequestId;
  let totalCount: number | undefined;

  while (true) {
    const url = `${endpoint}/indexes?api-version=${encodeURIComponent(apiVersion)}&$top=${pageSize}&$skip=${skip}&$count=true`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        status: 0,
        requestId,
        clientRequestId,
        url,
        error: { message: makeNetworkErrorMessage(lang, msg) },
      };
    }

    requestId = getServiceRequestId(res) ?? requestId;
    const parsed = await readJsonOrText(res);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        requestId,
        clientRequestId,
        url,
        error: {
          message: extractErrorMessage(res.status, parsed),
          response: parsed.json,
          responseText: parsed.text,
        },
      };
    }

    const page = parsed.json && typeof parsed.json === 'object' && !Array.isArray(parsed.json)
      ? parsed.json as Record<string, JsonValue>
      : {};
    const pageValues = Array.isArray(page.value) ? page.value : [];
    values.push(...pageValues);
    if (typeof page['@odata.count'] === 'number') totalCount = page['@odata.count'];

    if (pageValues.length < pageSize || (totalCount !== undefined && values.length >= totalCount)) break;
    skip += pageValues.length;
  }

  const response: Record<string, JsonValue> = { value: values };
  if (totalCount !== undefined) response['@odata.count'] = totalCount;

  return {
    ok: true,
    status: 200,
    requestId,
    clientRequestId,
    url: firstUrl,
    response,
    responseText: JSON.stringify(response),
  };
}

export async function getIndexDefinition(input: {
  profile: ConnectionProfile;
  indexName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
  signal?: AbortSignal;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const indexName = input.indexName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!indexName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  const clientRequestId = uuidv4();
  const url = `${endpoint}/indexes/${encodeURIComponent(indexName)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers, signal: input.signal });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url,
    response: (parsed.json ?? (parsed.text as unknown as JsonValue)) ?? null,
    responseText: parsed.text,
  };
}

export async function getIndexStatistics(input: {
  profile: ConnectionProfile;
  indexName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const indexName = input.indexName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!indexName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  const requestId = uuidv4();
  const url = `${endpoint}/indexes/${encodeURIComponent(indexName)}/stats?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: (parsed.json ?? (parsed.text as unknown as JsonValue)) ?? null,
    responseText: parsed.text,
  };
}

export async function listAliases(input: {
  profile: ConnectionProfile;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));

  let requestId = uuidv4();
  const url = `${endpoint}/aliases?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function getAliasDefinition(input: {
  profile: ConnectionProfile;
  aliasName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const aliasName = input.aliasName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!aliasName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  let requestId = uuidv4();
  const url = `${endpoint}/aliases/${encodeURIComponent(aliasName)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function agenticRetrieve(input: {
  profile: ConnectionProfile;
  knowledgeBaseName: string;
  body: JsonValue;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const kbName = input.knowledgeBaseName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!kbName) throw new Error(tr(lang, 'restErrorKnowledgeBaseNameUnset'));

  const clientRequestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2025-11-01-preview');
  const url = `${endpoint}/knowledgebases/${encodeURIComponent(kbName)}/retrieve?api-version=${encodeURIComponent(apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  if (isUsingDevProxy(input.profile)) headers['x-ais-idempotent'] = 'true';
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body ?? {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: {
        message: makeNetworkErrorMessage(lang, msg),
      },
    };
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;

  const parsed = await readJsonOrText(res);

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url,
      error: {
        message: `HTTP ${res.status}`,
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url,
    response: (parsed.json ?? (parsed.text as unknown as JsonValue)) ?? null,
    responseText: parsed.text,
  };
}

export async function getKnowledgeBase(input: {
  profile: ConnectionProfile;
  knowledgeBaseName: string;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const kbName = input.knowledgeBaseName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!kbName) throw new Error(tr(lang, 'restErrorKnowledgeBaseNameUnset'));

  const clientRequestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2025-11-01-preview');
  const url = `${endpoint}/knowledgebases/${encodeURIComponent(kbName)}?api-version=${encodeURIComponent(apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: {
        message: makeNetworkErrorMessage(lang, msg),
      },
    };
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;

  const parsed = await readJsonOrText(res);

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url,
    response: (parsed.json ?? (parsed.text as unknown as JsonValue)) ?? null,
    responseText: parsed.text,
  };
}

// Knowledge Source CRUD operations
export async function listKnowledgeSources(input: {
  profile: ConnectionProfile;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));

  let requestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2025-11-01-preview');
  const url = `${endpoint}/knowledgesources?api-version=${encodeURIComponent(apiVersion)}&$select=name,kind`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function getKnowledgeSource(input: {
  profile: ConnectionProfile;
  knowledgeSourceName: string;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const ksName = input.knowledgeSourceName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!ksName) throw new Error(tr(lang, 'restErrorKnowledgeSourceNameUnset'));

  let requestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2025-11-01-preview');
  const url = `${endpoint}/knowledgesources/${encodeURIComponent(ksName)}?api-version=${encodeURIComponent(apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function createOrUpdateKnowledgeSource(input: {
  profile: ConnectionProfile;
  knowledgeSourceName: string;
  body: JsonValue;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const ksName = input.knowledgeSourceName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!ksName) throw new Error(tr(lang, 'restErrorKnowledgeSourceNameUnset'));

  let requestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2025-11-01-preview');
  const url = `${endpoint}/knowledgesources/${encodeURIComponent(ksName)}?api-version=${encodeURIComponent(apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(input.body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function deleteKnowledgeSource(input: {
  profile: ConnectionProfile;
  knowledgeSourceName: string;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const ksName = input.knowledgeSourceName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!ksName) throw new Error(tr(lang, 'restErrorKnowledgeSourceNameUnset'));

  let requestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2025-11-01-preview');
  const url = `${endpoint}/knowledgesources/${encodeURIComponent(ksName)}?api-version=${encodeURIComponent(apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'DELETE', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

// Knowledge Base CRUD operations
export async function listKnowledgeBases(input: {
  profile: ConnectionProfile;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));

  const clientRequestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2025-11-01-preview');
  const url = `${endpoint}/knowledgebases?api-version=${encodeURIComponent(apiVersion)}&$select=name`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function createOrUpdateKnowledgeBase(input: {
  profile: ConnectionProfile;
  knowledgeBaseName: string;
  body: JsonValue;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const kbName = input.knowledgeBaseName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!kbName) throw new Error(tr(lang, 'restErrorKnowledgeBaseNameUnset'));

  let requestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2025-11-01-preview');
  const url = `${endpoint}/knowledgebases/${encodeURIComponent(kbName)}?api-version=${encodeURIComponent(apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(input.body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function deleteKnowledgeBase(input: {
  profile: ConnectionProfile;
  knowledgeBaseName: string;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const kbName = input.knowledgeBaseName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!kbName) throw new Error(tr(lang, 'restErrorKnowledgeBaseNameUnset'));

  let requestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2025-11-01-preview');
  const url = `${endpoint}/knowledgebases/${encodeURIComponent(kbName)}?api-version=${encodeURIComponent(apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'DELETE', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

// Synonym Map operations
export async function listSynonymMaps(input: {
  profile: ConnectionProfile;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));

  let requestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2024-07-01');
  const url = `${endpoint}/synonymmaps?api-version=${encodeURIComponent(apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function getSynonymMap(input: {
  profile: ConnectionProfile;
  synonymMapName: string;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const mapName = input.synonymMapName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!mapName) throw new Error(tr(lang, 'restErrorSynonymMapNameUnset'));

  let requestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2024-07-01');
  const url = `${endpoint}/synonymmaps/${encodeURIComponent(mapName)}?api-version=${encodeURIComponent(apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function createOrUpdateSynonymMap(input: {
  profile: ConnectionProfile;
  synonymMapName: string;
  body: JsonValue;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const mapName = input.synonymMapName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!mapName) throw new Error(tr(lang, 'restErrorSynonymMapNameUnset'));

  let requestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2024-07-01');
  const url = `${endpoint}/synonymmaps/${encodeURIComponent(mapName)}?api-version=${encodeURIComponent(apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(input.body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function deleteSynonymMap(input: {
  profile: ConnectionProfile;
  synonymMapName: string;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const mapName = input.synonymMapName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!mapName) throw new Error(tr(lang, 'restErrorSynonymMapNameUnset'));

  let requestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2024-07-01');
  const url = `${endpoint}/synonymmaps/${encodeURIComponent(mapName)}?api-version=${encodeURIComponent(apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'DELETE', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

// Data source operations
export async function listDataSources(input: {
  profile: ConnectionProfile;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));

  const clientRequestId = uuidv4();
  const url = `${endpoint}/datasources?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;
  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url,
    response: (parsed.json ?? (parsed.text as unknown as JsonValue)) ?? null,
    responseText: parsed.text,
  };
}

export async function getDataSourceDefinition(input: {
  profile: ConnectionProfile;
  dataSourceName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const name = input.dataSourceName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!name) throw new Error('dataSourceName is required');

  const clientRequestId = uuidv4();
  const url = `${endpoint}/datasources/${encodeURIComponent(name)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;
  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url,
    response: (parsed.json ?? (parsed.text as unknown as JsonValue)) ?? null,
    responseText: parsed.text,
  };
}

export async function createOrUpdateDataSource(input: {
  profile: ConnectionProfile;
  dataSourceName: string;
  apiVersion: SearchApiVersion;
  body: JsonValue;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const dsName = input.dataSourceName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!dsName) throw new Error('dataSourceName is required');

  let requestId = uuidv4();
  const url = `${endpoint}/datasources/${encodeURIComponent(dsName)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(input.body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function deleteDataSource(input: {
  profile: ConnectionProfile;
  dataSourceName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const dsName = input.dataSourceName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!dsName) throw new Error('dataSourceName is required');

  let requestId = uuidv4();
  const url = `${endpoint}/datasources/${encodeURIComponent(dsName)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'DELETE', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

// Indexer operations
export async function listIndexers(input: {
  profile: ConnectionProfile;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));

  const clientRequestId = uuidv4();
  const url = `${endpoint}/indexers?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;
  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url,
    response: (parsed.json ?? (parsed.text as unknown as JsonValue)) ?? null,
    responseText: parsed.text,
  };
}

export async function getIndexerDefinition(input: {
  profile: ConnectionProfile;
  indexerName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const name = input.indexerName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!name) throw new Error('indexerName is required');

  const clientRequestId = uuidv4();
  const url = `${endpoint}/indexers/${encodeURIComponent(name)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;
  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url,
    response: (parsed.json ?? (parsed.text as unknown as JsonValue)) ?? null,
    responseText: parsed.text,
  };
}

export async function createOrUpdateIndexer(input: {
  profile: ConnectionProfile;
  indexerName: string;
  apiVersion: SearchApiVersion;
  body: JsonValue;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const name = input.indexerName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!name) throw new Error('indexerName is required');

  let requestId = uuidv4();
  const url = `${endpoint}/indexers/${encodeURIComponent(name)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(input.body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function deleteIndexer(input: {
  profile: ConnectionProfile;
  indexerName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const name = input.indexerName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!name) throw new Error('indexerName is required');

  let requestId = uuidv4();
  const url = `${endpoint}/indexers/${encodeURIComponent(name)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'DELETE', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function runIndexer(input: {
  profile: ConnectionProfile;
  indexerName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const name = input.indexerName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!name) throw new Error('indexerName is required');

  const clientRequestId = uuidv4();
  const url = `${endpoint}/indexers/${encodeURIComponent(name)}/run?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  // Safe to retry POST /run with the dev proxy on transient failures.
  if (isUsingDevProxy(input.profile)) headers['x-ais-idempotent'] = 'true';

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;
  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function resetIndexer(input: {
  profile: ConnectionProfile;
  indexerName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const name = input.indexerName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!name) throw new Error('indexerName is required');

  const clientRequestId = uuidv4();
  const url = `${endpoint}/indexers/${encodeURIComponent(name)}/reset?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  const requestId = getServiceRequestId(res) ?? clientRequestId;
  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      clientRequestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    clientRequestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function getIndexerStatus(input: {
  profile: ConnectionProfile;
  indexerName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const name = input.indexerName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!name) throw new Error('indexerName is required');

  let requestId = uuidv4();
  const url = `${endpoint}/indexers/${encodeURIComponent(name)}/status?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

// Skillset operations
export async function listSkillsets(input: {
  profile: ConnectionProfile;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));

  let requestId = uuidv4();
  const url = `${endpoint}/skillsets?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function getSkillset(input: {
  profile: ConnectionProfile;
  skillsetName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const name = input.skillsetName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!name) throw new Error(tr(lang, 'restErrorSkillsetNameUnset'));

  let requestId = uuidv4();
  const url = `${endpoint}/skillsets/${encodeURIComponent(name)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function createOrUpdateSkillset(input: {
  profile: ConnectionProfile;
  skillsetName: string;
  apiVersion: SearchApiVersion;
  body: JsonValue;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const name = input.skillsetName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!name) throw new Error(tr(lang, 'restErrorSkillsetNameUnset'));

  let requestId = uuidv4();
  const url = `${endpoint}/skillsets/${encodeURIComponent(name)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(input.body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function deleteSkillset(input: {
  profile: ConnectionProfile;
  skillsetName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const name = input.skillsetName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!name) throw new Error(tr(lang, 'restErrorSkillsetNameUnset'));

  let requestId = uuidv4();
  const url = `${endpoint}/skillsets/${encodeURIComponent(name)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'DELETE', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}


export async function createOrUpdateIndex(input: {
  profile: ConnectionProfile;
  indexName: string;
  apiVersion: SearchApiVersion;
  body: JsonValue;
  language?: Language;
  signal?: AbortSignal;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const idxName = input.indexName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!idxName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  let requestId = uuidv4();
  const url = `${endpoint}/indexes/${encodeURIComponent(idxName)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(input.body),
      signal: input.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

/**
 * Upload, merge, or delete documents in an index via the Index Documents REST API.
 * POST https://[service].search.windows.net/indexes/[index]/docs/index?api-version=...
 */
export async function indexDocuments(input: {
  profile: ConnectionProfile;
  indexName: string;
  apiVersion: SearchApiVersion;
  body: JsonValue;
  language?: Language;
  signal?: AbortSignal;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const idxName = input.indexName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!idxName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  let requestId = uuidv4();
  const url = `${endpoint}/indexes/${encodeURIComponent(idxName)}/docs/index?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body),
      signal: input.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function deleteIndex(input: {
  profile: ConnectionProfile;
  indexName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const idxName = input.indexName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!idxName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  let requestId = uuidv4();
  const url = `${endpoint}/indexes/${encodeURIComponent(idxName)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'DELETE', headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function createOrUpdateAlias(input: {
  profile: ConnectionProfile;
  aliasName: string;
  apiVersion: SearchApiVersion;
  body: JsonValue;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const aliasName = input.aliasName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!aliasName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  let requestId = uuidv4();
  const url = `${endpoint}/aliases/${encodeURIComponent(aliasName)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify(input.body),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}

export async function deleteAlias(input: {
  profile: ConnectionProfile;
  aliasName: string;
  apiVersion: SearchApiVersion;
  language?: Language;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const aliasName = input.aliasName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!aliasName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  let requestId = uuidv4();
  const url = `${endpoint}/aliases/${encodeURIComponent(aliasName)}?api-version=${encodeURIComponent(input.apiVersion)}`;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': requestId,
    ...makeAuthHeaders(input.profile, lang),
  };

  let res: Response;
  try {
    res = await fetch(url, { method: 'DELETE', headers });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      requestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, msg) },
    };
  }

  requestId = getServiceRequestId(res) ?? requestId;

  const parsed = await readJsonOrText(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      requestId,
      url,
      error: {
        message: extractErrorMessage(res.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: res.status,
    requestId,
    url,
    response: parsed.json ?? null,
    responseText: parsed.text,
  };
}
