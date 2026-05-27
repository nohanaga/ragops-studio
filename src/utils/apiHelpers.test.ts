import { describe, expect, it } from 'vitest'

import { translations } from '../lib/translations'
import { inferRunType, validateRequest } from './apiHelpers'

describe('utils/apiHelpers', () => {
  describe('inferRunType', () => {
    it('returns agentic/analyze for those modes', () => {
      expect(inferRunType({}, 'agentic')).toBe('agentic_retrieve')
      expect(inferRunType({}, 'analyze')).toBe('analyze')
      expect(inferRunType({}, 'autocomplete')).toBe('autocomplete')
      expect(inferRunType({}, 'suggest')).toBe('suggest')
    })

    it('infers semantic_hybrid / semantic / hybrid / vector / query', () => {
      expect(inferRunType({ queryType: 'semantic', vectorQueries: [{}] }, 'semantic-vector')).toBe('semantic_hybrid')
      expect(inferRunType({ queryType: 'semantic' }, 'semantic-vector')).toBe('semantic')
      expect(inferRunType({ search: 'hi', vectorQueries: [{}] }, 'semantic-vector')).toBe('hybrid')
      expect(inferRunType({ vectorQueries: [{}] }, 'semantic-vector')).toBe('vector')
      expect(inferRunType({ search: 'hi' }, 'query')).toBe('query')
    })
  })

  describe('validateRequest', () => {
    const ja = translations.ja

    it('rejects semantic empty search', () => {
      expect(() => validateRequest('semantic-vector', { queryType: 'semantic', search: '   ' }, 'ja')).toThrow(
        ja.semanticSearchCannotBeEmpty,
      )
    })

    it('requires highlightPreTag and highlightPostTag together', () => {
      expect(() => validateRequest('query', { highlightPreTag: '<b>' }, 'ja')).toThrow(ja.highlightTagsMustBeBothSet)
      expect(() => validateRequest('query', { highlightPostTag: '</b>' }, 'ja')).toThrow(ja.highlightTagsMustBeBothSet)
    })

    it('rejects sessionId starting with underscore', () => {
      expect(() => validateRequest('query', { sessionId: '_bad' }, 'ja')).toThrow(ja.sessionIdCannotStartWithUnderscore)
    })

    it('enforces semanticMaxWaitInMilliseconds >= 700 when set', () => {
      expect(() => validateRequest('query', { semanticMaxWaitInMilliseconds: 699 }, 'ja')).toThrow(
        ja.semanticMaxWaitMustBeAtLeast700,
      )
    })

    it('enforces hybridSearch.maxTextRecallSize range', () => {
      expect(() => validateRequest('query', { hybridSearch: { maxTextRecallSize: 0 } }, 'ja')).toThrow(
        ja.hybridMaxTextRecallSizeRange,
      )
      expect(() => validateRequest('query', { hybridSearch: { maxTextRecallSize: 10001 } }, 'ja')).toThrow(
        ja.hybridMaxTextRecallSizeRange,
      )
    })

    it('validates vectorQueries oversampling/perDocumentVectorLimit', () => {
      expect(() => validateRequest('query', { vectorQueries: [{ oversampling: 0 }] }, 'ja')).toThrow(ja.vectorOversamplingMin1)
      expect(() => validateRequest('query', { vectorQueries: [{ perDocumentVectorLimit: -1 }] }, 'ja')).toThrow(
        ja.vectorPerDocumentVectorLimitMin0,
      )
    })

    it('requires search and suggesterName for typeahead APIs', () => {
      expect(() => validateRequest('autocomplete', { suggesterName: 'sg' }, 'ja')).toThrow(ja.typeaheadSearchRequired)
      expect(() => validateRequest('suggest', { search: 'lap' }, 'ja')).toThrow(ja.suggesterNameRequired)
      expect(() => validateRequest('suggest', { search: 'lap', suggesterName: 'sg' }, 'ja')).not.toThrow()
    })
  })
})
