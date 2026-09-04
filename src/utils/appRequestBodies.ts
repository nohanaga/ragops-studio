/**
 * Request body builders.
 *
 * Converts UI form state into Azure AI Search REST request JSON payloads.
 * This is used to keep the form-based builder and JSON-based editor consistent.
 */

import type { JsonValue } from '../lib/aiSearchRest'
import type { SearchApiVersion } from '../lib/model'
import { getSearchApiCapabilities } from '../lib/searchApiCapabilities'
import { translations, type Language } from '../lib/translations'
import type { LabMode, SearchFormState, AgenticFormState, AnalyzeFormState, AutocompleteFormState, SuggestFormState, KnowledgeBase } from '../types'

function csvToArray(raw: string): string[] {
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
}

function parseFacetsInput(raw: string): string[] {
  const input = raw.trim()
  if (!input) return []

  const tokens = input
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)

  const isFacetOptionToken = (t: string): boolean =>
    /^\s*(count|sort|values|interval|timeoffset|includeTermFilter|excludeTermFilter|metric|precisionThreshold|default)\s*:/i.test(t)

  const facets: string[] = []
  let current = ''
  for (const token of tokens) {
    if (!current) {
      current = token
      continue
    }
    if (isFacetOptionToken(token)) {
      current = `${current},${token}`
      continue
    }
    facets.push(current)
    current = token
  }
  if (current) facets.push(current)
  return facets
}

export function buildSearchBodyFromForm(
  mode: LabMode,
  s: SearchFormState,
  language: Language,
  isPreviewApiVersion: boolean,
): JsonValue {
  const toVectorQuery = (d: SearchFormState['vectorQueries'][number]): Record<string, unknown> => {
    const v: Record<string, unknown> = {
      kind: d.vectorKind,
      k: d.vectorK,
    }

    if (d.vectorFields.trim()) v.fields = d.vectorFields.trim()
    if (d.vectorKind === 'text') {
      if (d.vectorText.trim()) v.text = d.vectorText.trim()
      if (d.vectorQueryRewrites.trim()) v.queryRewrites = d.vectorQueryRewrites.trim()
    } else if (d.vectorKind === 'vector') {
      const nums = d.vector
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x.length > 0)
        .map((x) => Number(x))
      if (nums.some((n) => Number.isNaN(n))) throw new Error(translations[language]['vectorFormatError'])
      v.vector = nums
    } else if (d.vectorKind === 'imageUrl') {
      if (d.vectorImageUrl.trim()) v.url = d.vectorImageUrl.trim()
    } else if (d.vectorKind === 'imageBinary') {
      if (d.vectorBase64Image.trim()) v.base64Image = d.vectorBase64Image.trim()
    }

    if (d.vectorExhaustive) v.exhaustive = true
    if (d.vectorWeight !== 1.0) v.weight = d.vectorWeight
    if ((d.vectorThresholdKind === 'vectorSimilarity' || d.vectorThresholdKind === 'searchScore') && d.vectorThresholdValue > 0) {
      v.threshold = {
        kind: d.vectorThresholdKind,
        value: d.vectorThresholdValue,
      }
    }
    if (typeof d.vectorOversampling === 'number') v.oversampling = d.vectorOversampling
    if (typeof d.vectorPerDocumentVectorLimit === 'number') v.perDocumentVectorLimit = d.vectorPerDocumentVectorLimit
    if (d.vectorFilterOverride.trim()) v.filterOverride = d.vectorFilterOverride.trim()

    return v
  }

  const toVectorDraftFromForm = (form: SearchFormState): SearchFormState['vectorQueries'][number] => ({
    vectorKind: form.vectorKind,
    vectorText: form.vectorText,
    vectorQueryRewrites: form.vectorQueryRewrites,
    vector: form.vector,
    vectorImageUrl: form.vectorImageUrl,
    vectorBase64Image: form.vectorBase64Image,
    vectorFields: form.vectorFields,
    vectorK: form.vectorK,
    vectorExhaustive: form.vectorExhaustive,
    vectorWeight: form.vectorWeight,
    vectorThresholdKind: form.vectorThresholdKind,
    vectorThresholdValue: form.vectorThresholdValue,
    vectorOversampling: form.vectorOversampling,
    vectorPerDocumentVectorLimit: form.vectorPerDocumentVectorLimit,
    vectorFilterOverride: form.vectorFilterOverride,
  })

  const body: Record<string, unknown> = {
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
  if (s.facets.trim()) body.facets = parseFacetsInput(s.facets)
  if (s.highlight.trim()) body.highlight = s.highlight.trim()
  if (s.highlightPreTag.trim()) body.highlightPreTag = s.highlightPreTag.trim()
  if (s.highlightPostTag.trim()) body.highlightPostTag = s.highlightPostTag.trim()
  if (s.scoringProfile.trim()) body.scoringProfile = s.scoringProfile.trim()
  if (s.scoringParameters.trim()) body.scoringParameters = s.scoringParameters.trim().split(',').map((p) => p.trim()).filter((p) => p.length > 0)

  if (s.queryRewrites.trim()) body.queryRewrites = s.queryRewrites.trim()
  if (s.debug.trim()) body.debug = s.debug.trim()
  if (s.semanticQuery.trim()) body.semanticQuery = s.semanticQuery.trim()
  if (typeof s.minimumCoverage === 'number') body.minimumCoverage = s.minimumCoverage
  if (s.scoringStatistics) body.scoringStatistics = s.scoringStatistics
  if (s.sessionId.trim()) body.sessionId = s.sessionId.trim()
  if (s.speller) body.speller = s.speller
  if (s.semanticErrorHandling) body.semanticErrorHandling = s.semanticErrorHandling
  if (typeof s.semanticMaxWaitInMilliseconds === 'number') body.semanticMaxWaitInMilliseconds = s.semanticMaxWaitInMilliseconds
  if (isPreviewApiVersion && s.semanticFields.trim()) body.semanticFields = s.semanticFields.trim()

  // `queryLanguage` is required when using speller (lexicon) and also used for semantic queryType.
  // Send it when either condition is true.
  const queryLanguage = s.queryLanguage.trim()
  if (queryLanguage && (s.speller === 'lexicon' || (mode === 'semantic-vector' && s.queryType === 'semantic'))) {
    body.queryLanguage = queryLanguage
  }

  if (mode === 'semantic-vector' && s.queryType === 'semantic') {
    if (s.semanticConfiguration.trim()) body.semanticConfiguration = s.semanticConfiguration.trim()
    if (s.captions.trim()) body.captions = s.captions.trim()
    if (s.answers.trim()) body.answers = s.answers.trim()
  }

  if (mode === 'semantic-vector' && s.vectorEnabled) {
    if (s.vectorFilterMode) body.vectorFilterMode = s.vectorFilterMode
    if (isPreviewApiVersion && (typeof s.hybridMaxTextRecallSize === 'number' || s.hybridCountAndFacetMode)) {
      body.hybridSearch = {
        ...(typeof s.hybridMaxTextRecallSize === 'number' ? { maxTextRecallSize: s.hybridMaxTextRecallSize } : {}),
        ...(s.hybridCountAndFacetMode ? { countAndFacetMode: s.hybridCountAndFacetMode } : {}),
      }
    }
  }

  if (mode === 'semantic-vector' && s.vectorEnabled) {
    const drafts = Array.isArray(s.vectorQueries) ? s.vectorQueries : []
    const effectiveDrafts = drafts.length > 0 ? drafts : [toVectorDraftFromForm(s)]
    body.vectorQueries = effectiveDrafts.map((d) => toVectorQuery(d))
  }

  return body as JsonValue
}

export function buildAgenticBodyFromForm(s: AgenticFormState, apiVersion?: SearchApiVersion): JsonValue {
  const capabilities = getSearchApiCapabilities(apiVersion)
  if (s.retrievalReasoningEffort === 'auto' && !capabilities.reasoningAuto) {
    throw new Error('retrievalReasoningEffort=auto requires API version 2026-08-01-preview.')
  }

  const knowledgeSourceParams = s.knowledgeSourceParams.map((ks) => {
    const kind = ks.kind.trim()
    if (!kind) {
      throw new Error(`Knowledge source kind could not be resolved for '${ks.knowledgeSourceName}'. Reload the knowledge base and try again.`)
    }
    const base: Record<string, unknown> = {
      knowledgeSourceName: ks.knowledgeSourceName,
      kind,
      includeReferences: ks.includeReferences,
      includeReferenceSourceData: ks.includeReferenceSourceData,
    }
    if (capabilities.alwaysQuerySource) base.alwaysQuerySource = ks.alwaysQuerySource
    if (typeof ks.maxOutputDocuments === 'number') base.maxOutputDocuments = ks.maxOutputDocuments
    if (capabilities.perSourceResultsProcessing) {
      if (ks.neverQuerySource) base.neverQuerySource = true
      base.resultsProcessing = ks.resultsProcessing === 'none' ? 'none' : 'rerank'
      const queryHintOverrides = kind === 'searchIndex' && typeof ks.queryHintOverrides === 'string'
        ? ks.queryHintOverrides.trim()
        : ''
      if (queryHintOverrides) {
        const parsed = JSON.parse(queryHintOverrides) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('queryHintOverrides must be a JSON object.')
        }
        base.queryHintOverrides = parsed
      }
    }
    return base
  })

  const queryInput = !capabilities.agenticResponseSynthesis || s.retrievalReasoningEffort === 'minimal'
    ? {
        intents: [{ type: 'semantic', search: s.userMessage }],
      }
    : {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: s.userMessage }],
          },
        ],
      }

  if (!capabilities.agenticResponseSynthesis) {
    return {
      ...queryInput,
      includeActivity: s.includeActivity,
      maxRuntimeInSeconds: s.maxRuntimeInSeconds,
      maxOutputSizeInTokens: s.maxOutputSize,
      knowledgeSourceParams: knowledgeSourceParams.length > 0 ? knowledgeSourceParams : undefined,
    } as JsonValue
  }

  return {
    ...queryInput,
    includeActivity: s.includeActivity,
    outputMode: s.outputMode,
    maxRuntimeInSeconds: s.maxRuntimeInSeconds,
    maxOutputSize: s.maxOutputSize,
    retrievalReasoningEffort: { kind: s.retrievalReasoningEffort },
    knowledgeSourceParams: knowledgeSourceParams.length > 0 ? knowledgeSourceParams : undefined,
  } as JsonValue
}

export function buildKnowledgeBaseBodyForApiVersion(
  s: Partial<KnowledgeBase>,
  apiVersion?: SearchApiVersion,
): JsonValue {
  const capabilities = getSearchApiCapabilities(apiVersion)
  const base: Record<string, JsonValue> = {
    name: s.name || '',
    description: s.description || null,
    knowledgeSources: s.knowledgeSources || [],
    models: s.models || [],
    encryptionKey: s.encryptionKey ?? null,
  }

  if (!capabilities.agenticResponseSynthesis) return base

  const retrieveDefaults = capabilities.retrieveDefaults && s.retrieveDefaults
    ? {
        ...(typeof s.retrieveDefaults.maxRuntimeInSeconds === 'number'
          ? { maxRuntimeInSeconds: s.retrieveDefaults.maxRuntimeInSeconds }
          : {}),
        ...(typeof s.retrieveDefaults.maxOutputDocuments === 'number'
          ? { maxOutputDocuments: s.retrieveDefaults.maxOutputDocuments }
          : {}),
        ...(typeof s.retrieveDefaults.maxOutputSizeInTokens === 'number'
          ? { maxOutputSizeInTokens: s.retrieveDefaults.maxOutputSizeInTokens }
          : {}),
      }
    : undefined
  const retrievalReasoningEffort = s.retrievalReasoningEffort?.kind === 'auto' && !capabilities.reasoningAuto
    ? { kind: 'low' }
    : s.retrievalReasoningEffort || { kind: 'low' }

  return {
    ...base,
    retrievalInstructions: s.retrievalInstructions || null,
    answerInstructions: s.answerInstructions || null,
    outputMode: s.outputMode || 'answerSynthesis',
    retrievalReasoningEffort,
    ...(retrieveDefaults && Object.keys(retrieveDefaults).length > 0 ? { retrieveDefaults } : {}),
  } as JsonValue
}

export function buildAnalyzeBodyFromForm(s: AnalyzeFormState): JsonValue {
  const body: Record<string, unknown> = {
    text: s.text,
  }

  if (s.analyzerName.trim()) {
    body.analyzer = s.analyzerName.trim()
  } else {
    if (s.tokenizerName.trim()) body.tokenizer = s.tokenizerName.trim()
    if (s.normalizerName.trim()) body.normalizer = s.normalizerName.trim()

    const charFilters = s.charFilters.split(',').map((f) => f.trim()).filter((f) => f.length > 0)
    if (charFilters.length > 0) body.charFilters = charFilters

    const tokenFilters = s.tokenFilters.split(',').map((f) => f.trim()).filter((f) => f.length > 0)
    if (tokenFilters.length > 0) body.tokenFilters = tokenFilters
  }

  return body as JsonValue
}

export function buildAutocompleteBodyFromForm(s: AutocompleteFormState): JsonValue {
  const body: Record<string, unknown> = {
    search: s.search,
    suggesterName: s.suggesterName,
    autocompleteMode: s.autocompleteMode,
    top: s.top,
  }

  const searchFields = csvToArray(s.searchFields)
  if (searchFields.length > 0) body.searchFields = searchFields.join(',')
  if (s.filter.trim()) body.filter = s.filter.trim()
  if (typeof s.minimumCoverage === 'number') body.minimumCoverage = s.minimumCoverage
  if (s.useFuzzyMatching) body.useFuzzyMatching = true

  return body as JsonValue
}

export function buildSuggestBodyFromForm(s: SuggestFormState): JsonValue {
  const body: Record<string, unknown> = {
    search: s.search,
    suggesterName: s.suggesterName,
    top: s.top,
  }

  const searchFields = csvToArray(s.searchFields)
  if (searchFields.length > 0) body.searchFields = searchFields.join(',')
  if (s.select.trim()) body.select = s.select.trim()
  if (s.filter.trim()) body.filter = s.filter.trim()
  if (s.orderby.trim()) body.orderby = s.orderby.trim()
  if (typeof s.minimumCoverage === 'number') body.minimumCoverage = s.minimumCoverage
  if (s.useFuzzyMatching) body.useFuzzyMatching = true
  if (s.highlightPreTag.trim()) body.highlightPreTag = s.highlightPreTag
  if (s.highlightPostTag.trim()) body.highlightPostTag = s.highlightPostTag

  return body as JsonValue
}
