import type { LabMode, SearchFormState } from '../types'
import { DEFAULT_SEARCH_FORM } from './defaults'
import type { TranslationKey } from '../lib/translations'

type TFunction = (key: TranslationKey) => string

export function buildRequestBuilderActiveSummary(params: {
  t: TFunction
  labMode: LabMode
  indexName: string
  searchForm: SearchFormState
  isPreviewApiVersion: boolean
}): string {
  const { t, labMode, indexName, searchForm, isPreviewApiVersion } = params

  // Only applicable to classic search request builder (query / semantic-vector).
  if (labMode === 'agentic' || labMode === 'analyze') return ''

  const parts: string[] = []

  const push = (key: string, value: unknown) => {
    if (value === '' || value === undefined || value === null) return

    // Avoid dumping full vectors in summary (too long/noisy)
    if (key === 'vector.vector' && typeof value === 'string') {
      const items = value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      if (items.length === 0) return
      const first = items[0]
      const shown = items.length > 1 ? `${first}, …` : first
      parts.push(`${key}=${shown}`)
      return
    }

    parts.push(`${key}=${String(value)}`)
  }

  const pushIfDiff = (key: string, value: unknown, defaultValue: unknown) => {
    if (value === defaultValue) return
    push(key, value)
  }

  // Context
  pushIfDiff('indexName', indexName, 'v3_large')

  // Core
  pushIfDiff('query', searchForm.search, DEFAULT_SEARCH_FORM.search)
  pushIfDiff('queryType', searchForm.queryType, DEFAULT_SEARCH_FORM.queryType)
  pushIfDiff('count', searchForm.count, DEFAULT_SEARCH_FORM.count)
  pushIfDiff('top', searchForm.top, DEFAULT_SEARCH_FORM.top)
  pushIfDiff('skip', searchForm.skip, DEFAULT_SEARCH_FORM.skip)
  pushIfDiff('select', searchForm.select, DEFAULT_SEARCH_FORM.select)
  pushIfDiff('searchFields', searchForm.searchFields, DEFAULT_SEARCH_FORM.searchFields)
  pushIfDiff('filter', searchForm.filter, DEFAULT_SEARCH_FORM.filter)
  pushIfDiff('facets', searchForm.facets, DEFAULT_SEARCH_FORM.facets)
  pushIfDiff('orderby', searchForm.orderby, DEFAULT_SEARCH_FORM.orderby)
  pushIfDiff('searchMode', searchForm.searchMode, DEFAULT_SEARCH_FORM.searchMode)
  pushIfDiff('scoringProfile', searchForm.scoringProfile, DEFAULT_SEARCH_FORM.scoringProfile)
  pushIfDiff('scoringParameters', searchForm.scoringParameters, DEFAULT_SEARCH_FORM.scoringParameters)
  pushIfDiff('highlight', searchForm.highlight, DEFAULT_SEARCH_FORM.highlight)

  // Advanced (common)
  pushIfDiff('minimumCoverage', searchForm.minimumCoverage, DEFAULT_SEARCH_FORM.minimumCoverage)
  pushIfDiff('scoringStatistics', searchForm.scoringStatistics, DEFAULT_SEARCH_FORM.scoringStatistics)
  pushIfDiff('sessionId', searchForm.sessionId, DEFAULT_SEARCH_FORM.sessionId)
  pushIfDiff('speller', searchForm.speller, DEFAULT_SEARCH_FORM.speller)
  pushIfDiff('semanticErrorHandling', searchForm.semanticErrorHandling, DEFAULT_SEARCH_FORM.semanticErrorHandling)
  pushIfDiff(
    'semanticMaxWaitInMilliseconds',
    searchForm.semanticMaxWaitInMilliseconds,
    DEFAULT_SEARCH_FORM.semanticMaxWaitInMilliseconds,
  )
  if (isPreviewApiVersion) pushIfDiff('semanticFields', searchForm.semanticFields, DEFAULT_SEARCH_FORM.semanticFields)
  pushIfDiff('semanticQuery', searchForm.semanticQuery, DEFAULT_SEARCH_FORM.semanticQuery)
  pushIfDiff('queryRewrites', searchForm.queryRewrites, DEFAULT_SEARCH_FORM.queryRewrites)
  pushIfDiff('debug', searchForm.debug, DEFAULT_SEARCH_FORM.debug)
  pushIfDiff('highlightPreTag', searchForm.highlightPreTag, DEFAULT_SEARCH_FORM.highlightPreTag)
  pushIfDiff('highlightPostTag', searchForm.highlightPostTag, DEFAULT_SEARCH_FORM.highlightPostTag)

  // Semantic/vector extras
  if (labMode === 'semantic-vector') {
    pushIfDiff('vectorEnabled', searchForm.vectorEnabled, DEFAULT_SEARCH_FORM.vectorEnabled)

    if (searchForm.queryType === 'semantic') {
      pushIfDiff('semanticConfiguration', searchForm.semanticConfiguration, DEFAULT_SEARCH_FORM.semanticConfiguration)
      pushIfDiff('captions', searchForm.captions, DEFAULT_SEARCH_FORM.captions)
      pushIfDiff('answers', searchForm.answers, DEFAULT_SEARCH_FORM.answers)
    }

    // queryLanguage is also required when using speller=lexicon
    if (searchForm.queryType === 'semantic' || searchForm.speller === 'lexicon') {
      pushIfDiff('queryLanguage', searchForm.queryLanguage, DEFAULT_SEARCH_FORM.queryLanguage)
    }

    if (searchForm.vectorEnabled) {
      pushIfDiff('vectorFilterMode', searchForm.vectorFilterMode, DEFAULT_SEARCH_FORM.vectorFilterMode)
      if (isPreviewApiVersion) {
        pushIfDiff(
          'hybridSearch.maxTextRecallSize',
          searchForm.hybridMaxTextRecallSize,
          DEFAULT_SEARCH_FORM.hybridMaxTextRecallSize,
        )
        pushIfDiff(
          'hybridSearch.countAndFacetMode',
          searchForm.hybridCountAndFacetMode,
          DEFAULT_SEARCH_FORM.hybridCountAndFacetMode,
        )
      }

      pushIfDiff('vector.kind', searchForm.vectorKind, DEFAULT_SEARCH_FORM.vectorKind)
      pushIfDiff('vector.k', searchForm.vectorK, DEFAULT_SEARCH_FORM.vectorK)
      pushIfDiff('vector.fields', searchForm.vectorFields, DEFAULT_SEARCH_FORM.vectorFields)
      pushIfDiff('vector.exhaustive', searchForm.vectorExhaustive, DEFAULT_SEARCH_FORM.vectorExhaustive)
      pushIfDiff('vector.weight', searchForm.vectorWeight, DEFAULT_SEARCH_FORM.vectorWeight)
      pushIfDiff('vector.threshold.kind', searchForm.vectorThresholdKind, DEFAULT_SEARCH_FORM.vectorThresholdKind)
      pushIfDiff('vector.threshold.value', searchForm.vectorThresholdValue, DEFAULT_SEARCH_FORM.vectorThresholdValue)
      pushIfDiff('vector.oversampling', searchForm.vectorOversampling, DEFAULT_SEARCH_FORM.vectorOversampling)
      pushIfDiff(
        'vector.perDocumentVectorLimit',
        searchForm.vectorPerDocumentVectorLimit,
        DEFAULT_SEARCH_FORM.vectorPerDocumentVectorLimit,
      )
      pushIfDiff('vector.filterOverride', searchForm.vectorFilterOverride, DEFAULT_SEARCH_FORM.vectorFilterOverride)
      pushIfDiff('vector.text', searchForm.vectorText, DEFAULT_SEARCH_FORM.vectorText)
      pushIfDiff('vector.queryRewrites', searchForm.vectorQueryRewrites, DEFAULT_SEARCH_FORM.vectorQueryRewrites)
      pushIfDiff('vector.vector', searchForm.vector, DEFAULT_SEARCH_FORM.vector)
      pushIfDiff('vector.imageUrl', searchForm.vectorImageUrl, DEFAULT_SEARCH_FORM.vectorImageUrl)
      pushIfDiff('vector.base64Image', searchForm.vectorBase64Image, DEFAULT_SEARCH_FORM.vectorBase64Image)
    }
  }

  return parts.length ? parts.join(' / ') : t('optionNone')
}
