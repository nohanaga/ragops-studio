import { describe, expect, it } from 'vitest'

import type { SearchFormState } from '../types'
import { buildAutocompleteBodyFromForm, buildSearchBodyFromForm, buildSuggestBodyFromForm } from './appRequestBodies'

function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return v as Record<string, unknown>
}

function makeBaseForm(): SearchFormState {
  return {
    search: '',
    queryType: 'simple',
    top: 10,
    skip: 0,
    count: false,
    select: '',
    filter: '',
    orderby: '',
    searchMode: '',
    searchFields: '',
    facets: '',
    highlight: '',
    scoringProfile: '',
    scoringParameters: '',
    queryRewrites: '',
    debug: '',
    semanticQuery: '',
    highlightPreTag: '',
    highlightPostTag: '',
    minimumCoverage: '',
    scoringStatistics: '',
    sessionId: '',
    speller: '',
    semanticErrorHandling: '',
    semanticMaxWaitInMilliseconds: '',
    semanticFields: '',
    vectorFilterMode: '',
    hybridMaxTextRecallSize: '',
    hybridCountAndFacetMode: '',
    semanticConfiguration: '',
    queryLanguage: '',
    captions: '',
    answers: '',
    vectorEnabled: false,
    vectorQueries: [],
    vectorKind: 'text',
    vectorText: '',
    vectorQueryRewrites: '',
    vector: '',
    vectorImageUrl: '',
    vectorBase64Image: '',
    vectorFields: '',
    vectorK: 3,
    vectorExhaustive: false,
    vectorWeight: 1.0,
    vectorThresholdKind: '',
    vectorThresholdValue: 0,
    vectorOversampling: '',
    vectorPerDocumentVectorLimit: '',
    vectorFilterOverride: '',
  }
}

describe('utils/appRequestBodies', () => {
  it('parses facets input and keeps option tokens attached', () => {
    const s = makeBaseForm()
    s.facets = 'category,count:10,sort:count, author'

    const body = asRecord(buildSearchBodyFromForm('query', s, 'ja', false))
    expect(body.facets).toEqual(['category,count:10,sort:count', 'author'])
  })

  it('emits queryLanguage only when needed', () => {
    const s1 = makeBaseForm()
    s1.queryLanguage = 'en-us'
    const b1 = asRecord(buildSearchBodyFromForm('query', s1, 'ja', false))
    expect(b1.queryLanguage).toBeUndefined()

    const s2 = makeBaseForm()
    s2.queryLanguage = 'en-us'
    s2.speller = 'lexicon'
    const b2 = asRecord(buildSearchBodyFromForm('query', s2, 'ja', false))
    expect(b2.queryLanguage).toBe('en-us')

    const s3 = makeBaseForm()
    s3.queryType = 'semantic'
    s3.queryLanguage = 'en-us'
    const b3 = asRecord(buildSearchBodyFromForm('semantic-vector', s3, 'ja', false))
    expect(b3.queryLanguage).toBe('en-us')
  })

  it('includes semanticFields only for preview api versions', () => {
    const s = makeBaseForm()
    s.semanticFields = 'title,content'

    const notPreview = asRecord(buildSearchBodyFromForm('query', s, 'ja', false))
    expect(notPreview.semanticFields).toBeUndefined()

    const preview = asRecord(buildSearchBodyFromForm('query', s, 'ja', true))
    expect(preview.semanticFields).toBe('title,content')
  })

  it('builds autocomplete and suggest request bodies', () => {
    const autocomplete = asRecord(buildAutocompleteBodyFromForm({
      search: 'lap',
      suggesterName: 'sg',
      autocompleteMode: 'oneTermWithContext',
      searchFields: 'title, content',
      filter: "category eq 'pc'",
      top: 5,
      minimumCoverage: 80,
      useFuzzyMatching: true,
      liveTest: true,
    }))

    expect(autocomplete).toMatchObject({
      search: 'lap',
      suggesterName: 'sg',
      autocompleteMode: 'oneTermWithContext',
      searchFields: 'title,content',
      filter: "category eq 'pc'",
      top: 5,
      minimumCoverage: 80,
      useFuzzyMatching: true,
    })

    const suggest = asRecord(buildSuggestBodyFromForm({
      search: 'lap',
      suggesterName: 'sg',
      searchFields: 'title',
      select: 'title,url',
      filter: '',
      orderby: 'rating desc',
      top: 3,
      minimumCoverage: '',
      useFuzzyMatching: false,
      highlightPreTag: '<em>',
      highlightPostTag: '</em>',
      liveTest: true,
    }))

    expect(suggest).toMatchObject({
      search: 'lap',
      suggesterName: 'sg',
      searchFields: 'title',
      select: 'title,url',
      orderby: 'rating desc',
      top: 3,
      highlightPreTag: '<em>',
      highlightPostTag: '</em>',
    })
    expect(suggest.useFuzzyMatching).toBeUndefined()
  })
})
