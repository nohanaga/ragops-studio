import { describe, expect, it } from 'vitest'

import type { AgenticFormState, SearchFormState } from '../types'
import { buildAgenticBodyFromForm, buildAutocompleteBodyFromForm, buildKnowledgeBaseBodyForApiVersion, buildSearchBodyFromForm, buildSuggestBodyFromForm } from './appRequestBodies'

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

function makeAgenticForm(kind: string): AgenticFormState {
  return {
    userMessage: 'What changed?',
    includeActivity: true,
    outputMode: 'answerSynthesis',
    maxRuntimeInSeconds: 30,
    maxOutputSize: 5000,
    retrievalReasoningEffort: 'low',
    streamResponse: true,
    knowledgeSourceParams: [{
      knowledgeSourceName: 'ks-web-646',
      kind,
      includeReferences: false,
      includeReferenceSourceData: false,
      alwaysQuerySource: false,
      neverQuerySource: false,
      resultsProcessing: 'rerank',
      maxOutputDocuments: '',
      queryHintOverrides: '',
    }],
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

  it('emits common web knowledge source parameters without search-index-only query hints', () => {
    const form = makeAgenticForm('web')
    form.knowledgeSourceParams[0] = {
      ...form.knowledgeSourceParams[0],
      includeReferences: true,
      includeReferenceSourceData: true,
      neverQuerySource: true,
      resultsProcessing: 'none',
      maxOutputDocuments: 8,
      queryHintOverrides: '{"filters": []}',
    }
    const body = asRecord(buildAgenticBodyFromForm(form, '2026-08-01-preview'))
    const params = body.knowledgeSourceParams as Array<Record<string, unknown>>

    expect(params).toHaveLength(1)
    expect(params[0]).toMatchObject({
      knowledgeSourceName: 'ks-web-646',
      kind: 'web',
      includeReferences: true,
      includeReferenceSourceData: true,
      alwaysQuerySource: false,
      neverQuerySource: true,
      resultsProcessing: 'none',
      maxOutputDocuments: 8,
    })
    expect(params[0].queryHintOverrides).toBeUndefined()
  })

  it('keeps the 2025-11 preview request contract and excludes August-only fields', () => {
    const form = makeAgenticForm('searchIndex')
    form.knowledgeSourceParams[0] = {
      ...form.knowledgeSourceParams[0],
      alwaysQuerySource: true,
      neverQuerySource: true,
      resultsProcessing: 'none',
      maxOutputDocuments: 8,
      queryHintOverrides: '{"filters": []}',
    }

    const body = asRecord(buildAgenticBodyFromForm(form, '2025-11-01-preview'))
    const params = body.knowledgeSourceParams as Array<Record<string, unknown>>

    expect(body.messages).toBeDefined()
    expect(body.intents).toBeUndefined()
    expect(body.maxOutputSize).toBe(5000)
    expect(body.maxOutputSizeInTokens).toBeUndefined()
    expect(params[0].alwaysQuerySource).toBe(true)
    expect(params[0].neverQuerySource).toBeUndefined()
    expect(params[0].resultsProcessing).toBeUndefined()
    expect(params[0].maxOutputDocuments).toBe(8)
    expect(params[0].queryHintOverrides).toBeUndefined()
  })

  it('uses intents for minimal reasoning in the 2025-11 preview contract', () => {
    const form = makeAgenticForm('searchIndex')
    form.retrievalReasoningEffort = 'minimal'

    const body = asRecord(buildAgenticBodyFromForm(form, '2025-11-01-preview'))

    expect(body.intents).toEqual([{ type: 'semantic', search: 'What changed?' }])
    expect(body.messages).toBeUndefined()
  })

  it('keeps the 2026-05 preview request contract without August-only fields', () => {
    const form = makeAgenticForm('searchIndex')
    form.knowledgeSourceParams[0].neverQuerySource = true
    form.knowledgeSourceParams[0].resultsProcessing = 'none'
    form.knowledgeSourceParams[0].maxOutputDocuments = 8
    form.knowledgeSourceParams[0].queryHintOverrides = '{"filters": []}'

    const body = asRecord(buildAgenticBodyFromForm(form, '2026-05-01-preview'))
    const params = body.knowledgeSourceParams as Array<Record<string, unknown>>

    expect(body.messages).toBeDefined()
    expect(body.maxOutputSize).toBe(5000)
    expect(body.outputMode).toBe('answerSynthesis')
    expect(params[0].neverQuerySource).toBeUndefined()
    expect(params[0].resultsProcessing).toBeUndefined()
    expect(params[0].maxOutputDocuments).toBe(8)
    expect(params[0].queryHintOverrides).toBeUndefined()
  })

  it('uses the extractive-only 2026-04 request contract', () => {
    const form = makeAgenticForm('searchIndex')
    form.knowledgeSourceParams[0].alwaysQuerySource = true

    const body = asRecord(buildAgenticBodyFromForm(form, '2026-04-01'))
    const params = body.knowledgeSourceParams as Array<Record<string, unknown>>

    expect(body.intents).toEqual([{ type: 'semantic', search: 'What changed?' }])
    expect(body.messages).toBeUndefined()
    expect(body.maxOutputSizeInTokens).toBe(5000)
    expect(body.maxOutputSize).toBeUndefined()
    expect(body.outputMode).toBeUndefined()
    expect(body.retrievalReasoningEffort).toBeUndefined()
    expect(params[0].alwaysQuerySource).toBeUndefined()
  })

  it('removes response-generation settings from a 2026-04 knowledge base body', () => {
    const body = asRecord(buildKnowledgeBaseBodyForApiVersion({
      name: 'kb-stable',
      description: 'Stable KB',
      retrievalInstructions: 'Plan carefully',
      answerInstructions: 'Answer briefly',
      outputMode: 'answerSynthesis',
      knowledgeSources: [{ name: 'ks-index' }],
      models: [],
      encryptionKey: null,
      retrievalReasoningEffort: { kind: 'medium' },
      retrieveDefaults: { maxRuntimeInSeconds: 60 },
    }, '2026-04-01'))

    expect(body).toEqual({
      name: 'kb-stable',
      description: 'Stable KB',
      knowledgeSources: [{ name: 'ks-index' }],
      models: [],
      encryptionKey: null,
    })
  })

  it('keeps preview knowledge base settings but gates retrieve defaults to August', () => {
    const form = {
      name: 'kb-preview',
      description: null,
      retrievalInstructions: null,
      answerInstructions: null,
      outputMode: 'answerSynthesis',
      knowledgeSources: [{ name: 'ks-index' }],
      models: [],
      encryptionKey: null,
      retrievalReasoningEffort: { kind: 'low' },
      retrieveDefaults: { maxRuntimeInSeconds: 60 },
    }

    const legacyBody = asRecord(buildKnowledgeBaseBodyForApiVersion(form, '2025-11-01-preview'))
    const augustBody = asRecord(buildKnowledgeBaseBodyForApiVersion(form, '2026-08-01-preview'))

    expect(legacyBody.outputMode).toBe('answerSynthesis')
    expect(legacyBody.retrievalReasoningEffort).toEqual({ kind: 'low' })
    expect(legacyBody.retrieveDefaults).toBeUndefined()
    expect(augustBody.retrieveDefaults).toEqual({ maxRuntimeInSeconds: 60 })
  })

  it('rejects an agentic request when a knowledge source kind is unresolved', () => {
    expect(() => buildAgenticBodyFromForm(makeAgenticForm(''), '2026-08-01-preview'))
      .toThrow("Knowledge source kind could not be resolved for 'ks-web-646'.")
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid maxOutputDocuments value %s',
    (maxOutputDocuments) => {
      const form = makeAgenticForm('searchIndex')
      form.knowledgeSourceParams[0].maxOutputDocuments = maxOutputDocuments

      expect(() => buildAgenticBodyFromForm(form, '2026-08-01-preview'))
        .toThrow("maxOutputDocuments must be a positive integer for 'ks-web-646'.")
    },
  )

  it('rejects conflicting source inclusion flags when both are supported', () => {
    const form = makeAgenticForm('searchIndex')
    form.knowledgeSourceParams[0].alwaysQuerySource = true
    form.knowledgeSourceParams[0].neverQuerySource = true

    expect(() => buildAgenticBodyFromForm(form, '2026-08-01-preview'))
      .toThrow("alwaysQuerySource and neverQuerySource cannot both be true for 'ks-web-646'.")
  })
})
