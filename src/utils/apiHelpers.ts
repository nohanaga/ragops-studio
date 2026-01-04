/**
 * Legacy request helpers.
 *
 * This module contains older helper functions for building request bodies.
 * Newer code paths typically use `src/utils/appRequestBodies.ts`.
 */

import type { JsonValue } from '../lib/aiSearchRest'
import type { Run } from '../lib/model'
import { translations, type Language } from '../lib/translations'
import type { LabMode, SearchFormState, AgenticFormState } from '../types'

type JsonObject = { [key: string]: JsonValue }

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function buildSearchBodyFromForm(mode: LabMode, s: SearchFormState, language: Language = 'ja'): JsonValue {
  const body: JsonObject = {
    search: s.search,
    queryType: s.queryType,
    top: s.top,
    skip: s.skip,
    count: s.count,
  }
  if (s.select.trim()) body.select = s.select.trim()
  if (s.filter.trim()) body.filter = s.filter.trim()
  if (s.orderby.trim()) body.orderby = s.orderby.trim()
  if (s.searchMode.trim()) body.searchMode = s.searchMode.trim()
  if (s.searchFields.trim()) body.searchFields = s.searchFields.trim()
  if (s.facets.trim()) body.facets = s.facets.trim().split(',').map((f) => f.trim()).filter((f) => f.length > 0)
  if (s.highlight.trim()) body.highlight = s.highlight.trim()
  if (s.highlightPreTag.trim()) body.highlightPreTag = s.highlightPreTag.trim()
  if (s.highlightPostTag.trim()) body.highlightPostTag = s.highlightPostTag.trim()
  if (s.scoringProfile.trim()) body.scoringProfile = s.scoringProfile.trim()
  if (s.scoringParameters.trim()) body.scoringParameters = s.scoringParameters.trim().split(',').map((p) => p.trim()).filter((p) => p.length > 0)
  if (s.queryRewrites.trim()) body.queryRewrites = s.queryRewrites.trim()
  if (s.debug) body.debug = s.debug
  if (s.semanticQuery.trim()) body.semanticQuery = s.semanticQuery.trim()
  if (typeof s.minimumCoverage === 'number') body.minimumCoverage = s.minimumCoverage
  if (s.scoringStatistics) body.scoringStatistics = s.scoringStatistics
  if (s.sessionId.trim()) body.sessionId = s.sessionId.trim()
  if (s.speller) body.speller = s.speller
  if (s.semanticErrorHandling) body.semanticErrorHandling = s.semanticErrorHandling
  if (typeof s.semanticMaxWaitInMilliseconds === 'number') body.semanticMaxWaitInMilliseconds = s.semanticMaxWaitInMilliseconds
  if (s.semanticFields.trim()) body.semanticFields = s.semanticFields.trim()
  if (s.vectorFilterMode) body.vectorFilterMode = s.vectorFilterMode
  if (typeof s.hybridMaxTextRecallSize === 'number' || s.hybridCountAndFacetMode) {
    body.hybridSearch = {
      ...(typeof s.hybridMaxTextRecallSize === 'number' ? { maxTextRecallSize: s.hybridMaxTextRecallSize } : {}),
      ...(s.hybridCountAndFacetMode ? { countAndFacetMode: s.hybridCountAndFacetMode } : {}),
    }
  }

  if (mode === 'semantic-vector' && s.queryType === 'semantic') {
    if (s.semanticConfiguration.trim()) body.semanticConfiguration = s.semanticConfiguration.trim()
    if (s.queryLanguage.trim()) body.queryLanguage = s.queryLanguage.trim()
    if (s.captions.trim()) body.captions = s.captions.trim()
    if (s.answers.trim()) body.answers = s.answers.trim()
  }

  if (mode === 'semantic-vector' && s.vectorEnabled) {
    const v: JsonObject = {
      kind: s.vectorKind,
      k: s.vectorK,
    }
    if (s.vectorFields.trim()) v.fields = s.vectorFields.trim()
    if (s.vectorKind === 'text') {
      if (s.vectorText.trim()) v.text = s.vectorText.trim()
      if (s.vectorQueryRewrites.trim()) v.queryRewrites = s.vectorQueryRewrites.trim()
    } else if (s.vectorKind === 'vector') {
      const nums = s.vector
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
        .map((x) => Number(x))
      if (nums.some((n) => Number.isNaN(n))) throw new Error(translations[language].vectorFormatError)
      v.vector = nums
    } else if (s.vectorKind === 'imageUrl') {
      if (s.vectorImageUrl.trim()) v.url = s.vectorImageUrl.trim()
    } else if (s.vectorKind === 'imageBinary') {
      if (s.vectorBase64Image.trim()) v.base64Image = s.vectorBase64Image.trim()
    }
    if (s.vectorExhaustive) v.exhaustive = true
    if (s.vectorWeight !== 1.0) v.weight = s.vectorWeight
    if ((s.vectorThresholdKind === 'vectorSimilarity' || s.vectorThresholdKind === 'searchScore') && s.vectorThresholdValue > 0) {
      v.threshold = {
        kind: s.vectorThresholdKind,
        value: s.vectorThresholdValue
      }
    }
    if (typeof s.vectorOversampling === 'number') v.oversampling = s.vectorOversampling
    if (typeof s.vectorPerDocumentVectorLimit === 'number') v.perDocumentVectorLimit = s.vectorPerDocumentVectorLimit
    if (s.vectorFilterOverride.trim()) v.filterOverride = s.vectorFilterOverride.trim()
    body.vectorQueries = [v]
  }

  return body as JsonValue
}

export function buildAgenticBodyFromForm(s: AgenticFormState): JsonValue {
  const knowledgeSourceParams = s.knowledgeSourceParams.map(ks => ({
    knowledgeSourceName: ks.knowledgeSourceName,
    kind: 'searchIndex',
    includeReferences: ks.includeReferences,
    includeReferenceSourceData: ks.includeReferenceSourceData,
    alwaysQuerySource: ks.alwaysQuerySource,
  }))
  
  return {
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: s.userMessage }],
      },
    ],
    includeActivity: s.includeActivity,
    outputMode: s.outputMode,
    maxRuntimeInSeconds: s.maxRuntimeInSeconds,
    maxOutputSize: s.maxOutputSize,
    retrievalReasoningEffort: { kind: s.retrievalReasoningEffort },
    knowledgeSourceParams: knowledgeSourceParams.length > 0 ? knowledgeSourceParams : undefined,
  } as JsonValue
}

export function inferRunType(body: JsonValue, mode: LabMode): Run['runType'] {
  if (mode === 'agentic') return 'agentic_retrieve'
  if (mode === 'analyze') return 'analyze'

  const obj = isJsonObject(body) ? body : null

  const queryType = obj && typeof obj.queryType === 'string' ? obj.queryType : undefined
  const hasVectorQueries = !!(obj && Array.isArray(obj.vectorQueries) && obj.vectorQueries.length > 0)
  const hasSearch = !!(obj && typeof obj.search === 'string' && obj.search.trim().length > 0)

  // semantic + vector = semantic_hybrid
  if (queryType === 'semantic' && hasVectorQueries) return 'semantic_hybrid'
  // semantic only
  if (queryType === 'semantic') return 'semantic'
  // simple/full query + vector = hybrid
  if (hasVectorQueries && hasSearch) return 'hybrid'
  // vector only
  if (hasVectorQueries) return 'vector'
  // query only (simple or full)
  return 'query'
}

export function validateRequest(mode: LabMode, body: JsonValue, language: Language = 'ja'): void {
  if (mode === 'agentic' || mode === 'analyze') return

  const obj = isJsonObject(body) ? body : null
  // Spec requirement: semantic empty query is not allowed
  if (obj?.queryType === 'semantic') {
    const s = typeof obj.search === 'string' ? obj.search.trim() : ''
    if (!s) throw new Error(translations[language].semanticSearchCannotBeEmpty)
  }

  const pre = typeof obj?.highlightPreTag === 'string' ? obj.highlightPreTag.trim() : ''
  const post = typeof obj?.highlightPostTag === 'string' ? obj.highlightPostTag.trim() : ''
  if ((pre.length > 0) !== (post.length > 0)) {
    throw new Error(translations[language].highlightTagsMustBeBothSet)
  }

  const sessionId = typeof obj?.sessionId === 'string' ? obj.sessionId.trim() : ''
  if (sessionId.startsWith('_')) {
    throw new Error(translations[language].sessionIdCannotStartWithUnderscore)
  }

  const waitMs = typeof obj?.semanticMaxWaitInMilliseconds === 'number' ? obj.semanticMaxWaitInMilliseconds : undefined
  if (typeof waitMs === 'number' && waitMs > 0 && waitMs < 700) {
    throw new Error(translations[language].semanticMaxWaitMustBeAtLeast700)
  }

  const hybridSearch: JsonValue = obj?.hybridSearch ?? null
  const maxTextRecallSize =
    (isJsonObject(hybridSearch) && typeof hybridSearch.maxTextRecallSize === 'number')
      ? hybridSearch.maxTextRecallSize
      : undefined
  if (typeof maxTextRecallSize === 'number' && (maxTextRecallSize < 1 || maxTextRecallSize > 10000)) {
    throw new Error(translations[language].hybridMaxTextRecallSizeRange)
  }

  const vectorQueries: JsonValue[] = (obj && Array.isArray(obj.vectorQueries)) ? obj.vectorQueries : []
  for (const vq of vectorQueries) {
    if (!isJsonObject(vq)) continue
    const oversampling = typeof vq.oversampling === 'number' ? vq.oversampling : undefined
    if (typeof oversampling === 'number' && oversampling < 1) {
      throw new Error(translations[language].vectorOversamplingMin1)
    }

    const perDoc = typeof vq.perDocumentVectorLimit === 'number' ? vq.perDocumentVectorLimit : undefined
    if (typeof perDoc === 'number' && perDoc < 0) {
      throw new Error(translations[language].vectorPerDocumentVectorLimitMin0)
    }
  }
}

export function safeJsonParse(text: string): JsonValue {
  const trimmed = text.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed) as JsonValue
  } catch (e) {
    console.warn('JSON parse error:', e)
    return {}
  }
}

export function parseJsonStrict(text: string): JsonValue {
  const trimmed = text.trim()
  if (!trimmed) return {}
  return JSON.parse(trimmed) as JsonValue
}

export function extractDocs(body: JsonValue): Array<Record<string, JsonValue>> {
  if (!isJsonObject(body)) return []
  const value = body.value
  if (Array.isArray(value)) {
    return value.filter((x): x is Record<string, JsonValue> => isJsonObject(x))
  }
  return []
}

export function extractAgenticResponse(body: JsonValue): { 
  response: JsonValue[] | null
  references: JsonValue[] | null
  activity: JsonValue[] | null
  extractedChunks: JsonValue[] | null
  groundingJsonText: string | null
} {
  if (!isJsonObject(body)) {
    return { response: null, references: null, activity: null, extractedChunks: null, groundingJsonText: null }
  }
  const anyBody = body
  
  // Extract response array
  const response = Array.isArray(anyBody.response) ? anyBody.response : null
  
  // Extract references array
  const references = Array.isArray(anyBody.references) ? anyBody.references : null
  
  // Extract activity array
  const activity = Array.isArray(anyBody.activity) ? anyBody.activity : null
  
  // Extract grounding chunks from response[0].content[0].text (which is a JSON string)
  let extractedChunks: JsonValue[] | null = null
  let groundingJsonText: string | null = null
  if (response && response.length > 0) {
    const firstResponse = response[0]
    // Check if content array exists (role check removed - not always present)
    if (isJsonObject(firstResponse) && Array.isArray(firstResponse.content) && firstResponse.content.length > 0) {
      const content = firstResponse.content[0]
      if (isJsonObject(content) && content.type === 'text' && typeof content.text === 'string') {
        try {
          groundingJsonText = content.text
          const parsed = JSON.parse(content.text) as unknown
          if (Array.isArray(parsed)) {
            extractedChunks = parsed as JsonValue[]
          }
        } catch {
          // Failed to parse JSON string
          groundingJsonText = null
        }
      }
    }
  }
  
  return { response, references, activity, extractedChunks, groundingJsonText }
}

export function pickPrimaryText(doc: Record<string, JsonValue>, candidatesStr?: string): string {
  const defaultCandidates = ['title', 'name', 'id', 'key', 'documentId', 'chunkId', 'path', 'url']
  const candidates = candidatesStr 
    ? candidatesStr.split(',').map(s => s.trim()).filter(Boolean)
    : defaultCandidates
  
  for (const k of candidates) {
    const v = doc[k]
    if (typeof v === 'string' && v.trim()) return v
    if (typeof v === 'number') return String(v)
  }
  return '(no title)'
}

export function pickFirstStringField(doc: Record<string, JsonValue>, candidatesStr?: string): string | undefined {
  if (candidatesStr) {
    const candidates = candidatesStr.split(',').map(s => s.trim()).filter(Boolean)
    for (const k of candidates) {
      const v = doc[k]
      if (typeof v === 'string' && v.trim()) return v
    }
  }
  
  const entry = Object.entries(doc).find(([, v]) => typeof v === 'string' && v.trim())
  return entry ? String(entry[1]) : undefined
}

export function buildCurlForRun(run: Run, requestBodyText: string, language: Language = 'ja'): string {
  const endpoint = run.context.endpoint?.trim() ?? ''
  const apiVersion = run.context.apiVersion
  const headers: string[] = []
  headers.push('-H "content-type: application/json"')
  headers.push('-H "x-ms-client-request-id: <CLIENT_REQUEST_ID>"')
  if (run.context.authType === 'apiKey') headers.push('-H "api-key: <API_KEY>"')
  if (run.context.authType === 'bearer') headers.push('-H "Authorization: Bearer <BEARER_TOKEN>"')
  headers.push('-H "x-ms-query-source-authorization: <QUERY_SOURCE_AUTHZ>"')

  let url = ''
  if (run.runType === 'agentic_retrieve') {
    const kb = run.context.knowledgeBaseName ?? '<knowledgeBaseName>'
    url = `${endpoint}/knowledgebases('${kb}')/retrieve?api-version=${apiVersion}`
  } else {
    const indexName = run.context.indexName ?? '<indexName>'
    url = `${endpoint}/indexes/${indexName}/docs/search?api-version=${apiVersion}`
  }

  const safeBody = requestBodyText.trim().length > 0 ? requestBodyText : '{}'
  return [
    'curl -X POST',
    `  "${url}"`,
    ...headers.map((h) => `  ${h}`),
    `  --data-binary @- << 'JSON'\n${safeBody}\nJSON`,
    '',
    '# NOTE:',
    `# - ${translations[language].curlNoteReplacePlaceholders}`,
  ].join('\n')
}

export function downloadText(filename: string, text: string, mime = 'application/json') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
