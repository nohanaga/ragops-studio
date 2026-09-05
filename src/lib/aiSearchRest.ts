/**
 * Azure AI Search REST client.
 *
 * Provides typed helpers for calling the service APIs, including development
 * proxy routing, consistent error handling, and request-id propagation.
 */

import { v4 as uuidv4 } from 'uuid';
import type { ConnectionProfile, SearchApiVersion } from './model';
import { getSearchApiCapabilities } from './searchApiCapabilities';
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

function prepareCursorRequestUrl(profile: ConnectionProfile, nextLink: string): string {
  const serviceUrl = new URL(normalizeRawEndpoint(profile.endpoint));
  const resolved = new URL(nextLink, `${serviceUrl.origin}/`);
  if (resolved.origin !== serviceUrl.origin || resolved.username || resolved.password) {
    throw new Error('Azure AI Search returned an invalid cross-origin @odata.nextLink.');
  }
  if (!isUsingDevProxy(profile)) return resolved.toString();
  return `/api-proxy${resolved.pathname}${resolved.search}`;
}

async function collectCursorListPages(input: {
  profile: ConnectionProfile;
  initialUrl: string;
  language: Language;
  signal?: AbortSignal;
}): Promise<RestResult> {
  const clientRequestId = uuidv4();
  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, input.language),
  };
  const querySourceAuthorization = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (querySourceAuthorization) headers['x-ms-query-source-authorization'] = querySourceAuthorization;
  const values: JsonValue[] = [];
  const visited = new Set<string>();
  let nextLink: string | undefined = input.initialUrl;
  let isInitialRequest = true;
  let requestId = clientRequestId;
  let status = 200;

  while (nextLink) {
    if (visited.has(nextLink)) {
      return {
        ok: false,
        status: 0,
        requestId,
        clientRequestId,
        url: nextLink,
        error: { message: 'Azure AI Search returned a repeated @odata.nextLink.' },
      };
    }
    visited.add(nextLink);

    let url: string;
    try {
      url = isInitialRequest ? nextLink : prepareCursorRequestUrl(input.profile, nextLink);
      isInitialRequest = false;
    } catch (error) {
      return {
        ok: false,
        status: 0,
        requestId,
        clientRequestId,
        url: nextLink,
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }

    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers, signal: input.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        status: 0,
        requestId,
        clientRequestId,
        url,
        error: { message: makeNetworkErrorMessage(input.language, message) },
      };
    }

    status = res.status;
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
    if (Array.isArray(page.value)) values.push(...page.value);
    nextLink = typeof page['@odata.nextLink'] === 'string' && page['@odata.nextLink'].length > 0
      ? page['@odata.nextLink']
      : undefined;
  }

  const response: JsonValue = { value: values };
  return {
    ok: true,
    status,
    requestId,
    clientRequestId,
    url: input.initialUrl,
    response,
    responseText: JSON.stringify(response),
  };
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
  const selectedApiVersion = input.apiVersion.trim();
  const pagingApiVersion: SearchApiVersion = '2026-05-01-preview';
  const pageSize = 1000;

  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  if (getSearchApiCapabilities(selectedApiVersion).cursorList) {
    const url = `${endpoint}/indexes?api-version=${encodeURIComponent(selectedApiVersion)}&pageSize=${pageSize}`;
    return collectCursorListPages({
      profile: input.profile,
      initialUrl: url,
      language: lang,
    });
  }

  async function requestPage(url: string): Promise<{ res?: Response; parsed?: { json?: JsonValue; text?: string }; networkError?: RestResult }> {
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', headers });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { networkError: {
          ok: false,
          status: 0,
          requestId: clientRequestId,
          clientRequestId,
          url,
          error: { message: makeNetworkErrorMessage(lang, msg) },
        } };
    }
    return { res, parsed: await readJsonOrText(res) };
  }

  async function requestPaged(apiVersion: SearchApiVersion): Promise<RestResult> {
    const values: JsonValue[] = [];
    let skip = 0;
    let requestId = clientRequestId;
    let totalCount: number | undefined;
    const firstUrl = `${endpoint}/indexes?api-version=${encodeURIComponent(apiVersion)}&$top=${pageSize}&$skip=0&$count=true`;

    while (true) {
      const url = `${endpoint}/indexes?api-version=${encodeURIComponent(apiVersion)}&$top=${pageSize}&$skip=${skip}&$count=true`;
      const pageResult = await requestPage(url);
      if (pageResult.networkError) return pageResult.networkError;
      const res = pageResult.res!;
      const parsed = pageResult.parsed!;

      requestId = getServiceRequestId(res) ?? requestId;
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

  const supportsPaging = resolveSearchApiVersion(selectedApiVersion, pagingApiVersion) === selectedApiVersion;
  if (supportsPaging) return requestPaged(selectedApiVersion);

  const selectedUrl = `${endpoint}/indexes?api-version=${encodeURIComponent(selectedApiVersion)}`;
  const selectedResult = await requestPage(selectedUrl);
  if (selectedResult.networkError) return selectedResult.networkError;
  const selectedResponse = selectedResult.res!;
  const selectedParsed = selectedResult.parsed!;
  const requestId = getServiceRequestId(selectedResponse) ?? clientRequestId;

  if (selectedResponse.ok) {
    return {
      ok: true,
      status: selectedResponse.status,
      requestId,
      clientRequestId,
      url: selectedUrl,
      response: (selectedParsed.json ?? (selectedParsed.text as unknown as JsonValue)) ?? null,
      responseText: selectedParsed.text,
    };
  }

  const errorMessage = extractErrorMessage(selectedResponse.status, selectedParsed);
  const requiresServerlessPaging = selectedResponse.status === 400
    && errorMessage.toLowerCase().includes('serverless services cannot enumerate resources without paging');
  if (requiresServerlessPaging) return requestPaged(pagingApiVersion);

  return {
    ok: false,
    status: selectedResponse.status,
    requestId,
    clientRequestId,
    url: selectedUrl,
    error: {
      message: errorMessage,
      response: selectedParsed.json,
      responseText: selectedParsed.text,
    },
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

  if (getSearchApiCapabilities(input.apiVersion).cursorList) {
    return collectCursorListPages({
      profile: input.profile,
      initialUrl: `${url}&pageSize=1000`,
      language: lang,
    });
  }

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

export type AgenticStreamEvent = {
  event: string;
  data: JsonValue;
};

export function parseAgenticSseEvent(block: string): AgenticStreamEvent | null {
  let event = '';
  const dataLines: string[] = [];

  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    let value = separator >= 0 ? line.slice(separator + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (!event || dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) as JsonValue };
  } catch {
    return null;
  }
}

function getAgenticStreamErrorMessage(data: JsonValue): string | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const error = data.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && !Array.isArray(error) && typeof error.message === 'string') {
    return error.message;
  }
  return typeof data.message === 'string' ? data.message : undefined;
}

export async function agenticRetrieveStream(input: {
  profile: ConnectionProfile;
  knowledgeBaseName: string;
  body: JsonValue;
  language?: Language;
  signal?: AbortSignal;
  onEvent?: (event: AgenticStreamEvent) => void;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const kbName = input.knowledgeBaseName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!kbName) throw new Error(tr(lang, 'restErrorKnowledgeBaseNameUnset'));

  const clientRequestId = uuidv4();
  const apiVersion = resolveSearchApiVersion(input.profile.apiVersion, '2026-08-01-preview');
  const url = `${endpoint}/knowledgebases/${encodeURIComponent(kbName)}/retrieve?api-version=${encodeURIComponent(apiVersion)}`;
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
    'content-type': 'application/json',
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  if (isUsingDevProxy(input.profile)) headers['x-ais-idempotent'] = 'true';
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body ?? {}),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url,
      error: { message: makeNetworkErrorMessage(lang, message) },
    };
  }

  const requestId = getServiceRequestId(response) ?? clientRequestId;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!response.ok || !contentType.includes('text/event-stream')) {
    const parsed = await readJsonOrText(response);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        requestId,
        clientRequestId,
        url,
        error: {
          message: extractErrorMessage(response.status, parsed),
          response: parsed.json,
          responseText: parsed.text,
        },
      };
    }
    return {
      ok: true,
      status: response.status,
      requestId,
      clientRequestId,
      url,
      response: parsed.json ?? null,
      responseText: parsed.text,
    };
  }

  if (!response.body) {
    return {
      ok: false,
      status: 0,
      requestId,
      clientRequestId,
      url,
      error: { message: tr(lang, 'restAgenticStreamBodyMissing') },
    };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let boundary = buffer.match(/\r?\n\r?\n/);
      while (boundary?.index !== undefined) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const item = parseAgenticSseEvent(block);
        if (item) {
          input.onEvent?.(item);
          if (item.event === 'response.completed') {
            if (!item.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
              throw new Error(tr(lang, 'restAgenticStreamInvalidTerminal'));
            }
            const statusCode = typeof item.data.statusCode === 'number' ? item.data.statusCode : response.status;
            if (statusCode !== 200 && statusCode !== 206) {
              throw new Error(tr(lang, 'restAgenticStreamInvalidTerminal'));
            }
            return {
              ok: true,
              status: statusCode,
              requestId,
              clientRequestId,
              url,
              response: item.data.response ?? null,
            };
          }
          if (item.event === 'error') {
            return {
              ok: false,
              status: 500,
              requestId,
              clientRequestId,
              url,
              error: {
                message: getAgenticStreamErrorMessage(item.data) ?? tr(lang, 'restAgenticStreamFailed'),
                response: item.data,
              },
            };
          }
        }
        boundary = buffer.match(/\r?\n\r?\n/);
      }

      if (done) break;
    }

    const finalItem = parseAgenticSseEvent(buffer);
    if (finalItem) {
      input.onEvent?.(finalItem);
      if (finalItem.event === 'response.completed' && finalItem.data && typeof finalItem.data === 'object' && !Array.isArray(finalItem.data)) {
        const statusCode = typeof finalItem.data.statusCode === 'number' ? finalItem.data.statusCode : response.status;
        if (statusCode === 200 || statusCode === 206) {
          return {
            ok: true,
            status: statusCode,
            requestId,
            clientRequestId,
            url,
            response: finalItem.data.response ?? null,
          };
        }
      }
      if (finalItem.event === 'error') {
        return {
          ok: false,
          status: 500,
          requestId,
          clientRequestId,
          url,
          error: {
            message: getAgenticStreamErrorMessage(finalItem.data) ?? tr(lang, 'restAgenticStreamFailed'),
            response: finalItem.data,
          },
        };
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return {
      ok: false,
      status: 0,
      requestId,
      clientRequestId,
      url,
      error: { message: error instanceof Error ? error.message : String(error) },
    };
  } finally {
    reader.releaseLock();
  }

  return {
    ok: false,
    status: 0,
    requestId,
    clientRequestId,
    url,
    error: { message: tr(lang, 'restAgenticStreamIncomplete') },
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

export async function getCitationDocument(input: {
  profile: ConnectionProfile;
  citationUrl: string;
  language?: Language;
  signal?: AbortSignal;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const rawEndpoint = normalizeRawEndpoint(input.profile.endpoint);
  let endpointUrl: URL;
  let citationUrl: URL;
  try {
    endpointUrl = new URL(rawEndpoint);
    citationUrl = new URL(input.citationUrl);
  } catch {
    return {
      ok: false,
      status: 0,
      requestId: '',
      url: input.citationUrl,
      error: { message: tr(lang, 'restCitationUrlInvalid') },
    };
  }

  if (citationUrl.origin !== endpointUrl.origin) {
    return {
      ok: false,
      status: 0,
      requestId: '',
      url: input.citationUrl,
      error: { message: tr(lang, 'restCitationOriginMismatch') },
    };
  }

  const clientRequestId = uuidv4();
  const requestUrl = import.meta.env.DEV && isLikelyAzureAiSearchEndpoint(rawEndpoint)
    ? `/api-proxy${citationUrl.pathname}${citationUrl.search}`
    : input.citationUrl;
  const headers: Record<string, string> = {
    'x-ms-client-request-id': clientRequestId,
    ...makeAuthHeaders(input.profile, lang),
  };
  const qsa = getQuerySourceAuthorizationHeaderValue(input.profile);
  if (qsa) headers['x-ms-query-source-authorization'] = qsa;

  let response: Response;
  try {
    response = await fetch(requestUrl, { method: 'GET', headers, signal: input.signal });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      requestId: clientRequestId,
      clientRequestId,
      url: input.citationUrl,
      error: { message: makeNetworkErrorMessage(lang, message) },
    };
  }

  const requestId = getServiceRequestId(response) ?? clientRequestId;
  const parsed = await readJsonOrText(response);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      requestId,
      clientRequestId,
      url: input.citationUrl,
      error: {
        message: extractErrorMessage(response.status, parsed),
        response: parsed.json,
        responseText: parsed.text,
      },
    };
  }

  return {
    ok: true,
    status: response.status,
    requestId,
    clientRequestId,
    url: input.citationUrl,
    response: parsed.json ?? null,
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
  const collectionUrl = `${endpoint}/knowledgesources?api-version=${encodeURIComponent(apiVersion)}`;

  if (getSearchApiCapabilities(apiVersion).cursorList) {
    return collectCursorListPages({
      profile: input.profile,
      initialUrl: `${collectionUrl}&pageSize=1000`,
      language: lang,
    });
  }

  const url = `${collectionUrl}&$select=name,kind`;

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
  const collectionUrl = `${endpoint}/knowledgebases?api-version=${encodeURIComponent(apiVersion)}`;

  if (getSearchApiCapabilities(apiVersion).cursorList) {
    return collectCursorListPages({
      profile: input.profile,
      initialUrl: `${collectionUrl}&pageSize=1000`,
      language: lang,
    });
  }

  const url = `${collectionUrl}&$select=name`;

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

  if (getSearchApiCapabilities(apiVersion).cursorList) {
    return collectCursorListPages({
      profile: input.profile,
      initialUrl: `${url}&pageSize=1000`,
      language: lang,
    });
  }

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

  if (getSearchApiCapabilities(input.apiVersion).cursorList) {
    return collectCursorListPages({
      profile: input.profile,
      initialUrl: `${url}&pageSize=1000`,
      language: lang,
    });
  }

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

  if (getSearchApiCapabilities(input.apiVersion).cursorList) {
    return collectCursorListPages({
      profile: input.profile,
      initialUrl: `${url}&pageSize=1000`,
      language: lang,
    });
  }

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

  if (getSearchApiCapabilities(input.apiVersion).cursorList) {
    return collectCursorListPages({
      profile: input.profile,
      initialUrl: `${url}&pageSize=1000`,
      language: lang,
    });
  }

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
  allowIndexDowntime?: boolean;
  language?: Language;
  signal?: AbortSignal;
}): Promise<RestResult> {
  const lang = getLang(input.language);
  const endpoint = normalizeEndpoint(input.profile.endpoint);
  const idxName = input.indexName.trim();
  if (!endpoint) throw new Error(tr(lang, 'restErrorEndpointUnset'));
  if (!idxName) throw new Error(tr(lang, 'restErrorIndexNameUnset'));

  let requestId = uuidv4();
  const allowIndexDowntime = input.allowIndexDowntime === true ? '&allowIndexDowntime=true' : '';
  const url = `${endpoint}/indexes/${encodeURIComponent(idxName)}?api-version=${encodeURIComponent(input.apiVersion)}${allowIndexDowntime}`;

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
