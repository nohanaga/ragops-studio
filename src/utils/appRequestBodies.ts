/**
 * Request body builders.
 *
 * Converts UI form state into Azure AI Search REST request JSON payloads.
 * This is used to keep the form-based builder and JSON-based editor consistent.
 */

import type { JsonValue } from '../lib/aiSearchRest'
import type { SearchApiVersion } from '../lib/model'
import { isJsonObject } from '../app/json'
import { getSearchApiCapabilities } from '../lib/searchApiCapabilities'
import { translations, type Language } from '../lib/translations'
import { buildDirectAgenticSearch, buildTopicGraph, NOVEMBER_AGENTIC_API, NOVEMBER_KB_MODELS, validateKnowledgeBaseTools } from './agenticPreview'
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
  apiVersion?: SearchApiVersion,
): JsonValue {
  if (s.queryType === 'agentic') {
    if (!getSearchApiCapabilities(apiVersion).novemberAgentic) throw new Error(`Direct agentic search requires ${NOVEMBER_AGENTIC_API}.`)
    return buildDirectAgenticSearch(s)
  }
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

export function buildAgenticBodyFromForm(s: AgenticFormState, apiVersion?: SearchApiVersion, language: Language = 'en'): JsonValue {
  const capabilities = getSearchApiCapabilities(apiVersion)
  const toolName = s.toolName?.trim()
  const useToolDefaults = !!toolName && s.useToolDefaults !== false
  if (!capabilities.novemberAgentic && s.knowledgeSourceParams.some((source) => source.filterAddOn?.trim())) {
    throw new Error(translations[language].novemberSourceFilterRequired)
  }
  if (!capabilities.novemberAgentic && (toolName || s.knowledgeSourceParams.some((source) => source.topicGraph || source.graphParameters))) {
    throw new Error(`Named tools and graph retrieval settings require ${NOVEMBER_AGENTIC_API}.`)
  }
  if (!useToolDefaults && s.retrievalReasoningEffort === 'auto' && !capabilities.reasoningAuto) {
    throw new Error('retrievalReasoningEffort=auto requires API version 2026-08-01-preview.')
  }

  const knowledgeSourceParams = s.knowledgeSourceParams.map((ks) => {
    const kind = ks.kind.trim()
    if (!kind) {
      throw new Error(`Knowledge source kind could not be resolved for '${ks.knowledgeSourceName}'. Reload the knowledge base and try again.`)
    }
    const base: Record<string, JsonValue> = {
      knowledgeSourceName: ks.knowledgeSourceName,
      kind,
      includeReferences: ks.includeReferences,
      includeReferenceSourceData: ks.includeReferenceSourceData,
    }
    if ((kind === 'searchIndex' || kind === 'azureBlob') && ks.topicGraph) base.topicGraph = buildTopicGraph(ks.topicGraph)
    if (capabilities.novemberAgentic && (kind === 'searchIndex' || kind === 'azureBlob') && ks.filterAddOn?.trim()) base.filterAddOn = ks.filterAddOn.trim()
    if (kind === 'azureBlob' && ks.graphParameters) {
      const top = ks.graphParameters.provenance?.hydrateDocuments?.top
      if (top !== undefined && (!Number.isInteger(top) || top < 1 || top > 100)) {
        throw new Error('graphParameters.provenance.hydrateDocuments.top must be an integer from 1 to 100.')
      }
      base.graphParameters = ks.graphParameters
    }
    if (typeof ks.maxOutputDocuments === 'number') {
      if (!Number.isFinite(ks.maxOutputDocuments) || !Number.isInteger(ks.maxOutputDocuments) || ks.maxOutputDocuments < 1) {
        throw new Error(`maxOutputDocuments must be a positive integer for '${ks.knowledgeSourceName}'.`)
      }
      base.maxOutputDocuments = ks.maxOutputDocuments
    }
    if (capabilities.alwaysQuerySource && capabilities.perSourceResultsProcessing
      && ks.alwaysQuerySource && ks.neverQuerySource) {
      throw new Error(`alwaysQuerySource and neverQuerySource cannot both be true for '${ks.knowledgeSourceName}'.`)
    }
    if (capabilities.alwaysQuerySource && typeof ks.alwaysQuerySource === 'boolean') base.alwaysQuerySource = ks.alwaysQuerySource
    if (capabilities.perSourceResultsProcessing) {
      if (ks.neverQuerySource) base.neverQuerySource = true
      if (ks.resultsProcessing) base.resultsProcessing = ks.resultsProcessing
      const queryHintOverrides = kind === 'searchIndex' && typeof ks.queryHintOverrides === 'string'
        ? ks.queryHintOverrides.trim()
        : ''
      if (queryHintOverrides) {
        const parsed = JSON.parse(queryHintOverrides) as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('queryHintOverrides must be a JSON object.')
        }
        base.queryHintOverrides = parsed as Record<string, JsonValue>
      }
    }
    return base
  })

  const body: Record<string, JsonValue> = {
    includeActivity: s.includeActivity,
  }
  if (toolName) body.toolName = toolName
  if (!useToolDefaults) body.maxRuntimeInSeconds = s.maxRuntimeInSeconds
  if (knowledgeSourceParams.length > 0) body.knowledgeSourceParams = knowledgeSourceParams

  if (!capabilities.agenticResponseSynthesis || s.retrievalReasoningEffort === 'minimal') {
    body.intents = [{ type: 'semantic', search: s.userMessage }]
  } else {
    body.messages = [{
      role: 'user',
      content: [{ type: 'text', text: s.userMessage }],
    }]
  }

  if (!capabilities.agenticResponseSynthesis) {
    body.maxOutputSizeInTokens = s.maxOutputSize
    return body
  }

  if (useToolDefaults) return body
  body.outputMode = s.outputMode
  if (capabilities.novemberAgentic && typeof s.maxOutputSizeInTokens === 'number') {
    body.maxOutputSizeInTokens = s.maxOutputSizeInTokens
  } else {
    body.maxOutputSize = s.maxOutputSize
  }
  if (capabilities.novemberAgentic && typeof s.maxOutputDocuments === 'number') body.maxOutputDocuments = s.maxOutputDocuments
  for (const key of ['maxOutputDocuments', 'maxOutputSizeInTokens'] as const) {
    const value = body[key]
    if (typeof value === 'number' && (!Number.isInteger(value) || value < 1 || value > 2147483647)) {
      throw new Error(`${key} must be a positive int32.`)
    }
  }
  body.retrievalReasoningEffort = { kind: s.retrievalReasoningEffort }
  return body
}

export function isKnowledgeBaseModelKind(model: JsonValue, kind: string): boolean {
  return isJsonObject(model) && model.kind === kind
}

export function isMicrosoftRetriever1Only(models: JsonValue[]): boolean {
  return models.length > 0 && models.every((model) => isKnowledgeBaseModelKind(model, 'microsoftRetriever1'))
}

export function buildKnowledgeBaseBodyForApiVersion(
  s: Partial<KnowledgeBase>,
  apiVersion?: SearchApiVersion,
  language: Language = 'en',
): JsonValue {
  const capabilities = getSearchApiCapabilities(apiVersion)
  const models = s.models ?? []
  if (!capabilities.microsoftRetriever1 && models.some((model) => isKnowledgeBaseModelKind(model, 'microsoftRetriever1'))) {
    throw new Error(translations[language].knowledgeBaseMicrosoftRetriever1Preview)
  }
  const retrieverOnly = isMicrosoftRetriever1Only(models)
  const hasNovemberModels = models.some((model) => {
    if (!isJsonObject(model)) return false
    if (model.kind === 'openAICompatible') return true
    const params = model.azureOpenAIParameters
    return params !== undefined && isJsonObject(params) && NOVEMBER_KB_MODELS.some((name) => name === params.modelName)
  })
  if (!capabilities.novemberAgentic && (hasNovemberModels || s.tools?.length)) {
    throw new Error(`Named tools and GPT-6 / OpenAI-compatible models require ${NOVEMBER_AGENTIC_API}.`)
  }
  if (capabilities.novemberAgentic && s.tools) validateKnowledgeBaseTools(s.tools, (s.knowledgeSources ?? []).map(({ name }) => name))
  const base: Record<string, JsonValue> = {
    name: s.name || '',
    description: s.description || null,
    knowledgeSources: s.knowledgeSources || [],
    models,
    ...(capabilities.novemberAgentic && s.tools !== undefined ? { tools: s.tools } : {}),
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
  const retrievalReasoningEffort = retrieverOnly
    ? { kind: 'minimal' }
    : s.retrievalReasoningEffort?.kind === 'auto' && !capabilities.reasoningAuto
      ? { kind: 'low' }
      : s.retrievalReasoningEffort || { kind: 'low' }

  return {
    ...base,
    retrievalInstructions: s.retrievalInstructions || null,
    answerInstructions: retrieverOnly ? null : s.answerInstructions || null,
    outputMode: retrieverOnly ? 'extractiveData' : s.outputMode || 'answerSynthesis',
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
