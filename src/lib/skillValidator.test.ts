import { describe, it, expect } from 'vitest'
import {
  validateRequest,
  validateResponse,
  validateSkillDefinition,
  isValidRequest,
  isValidResponse,
  extractRecordIds,
  buildSampleRequest,
  buildSampleResponse,
} from './skillValidator'

describe('skillValidator', () => {
  // ========================================================================
  // validateRequest
  // ========================================================================
  describe('validateRequest', () => {
    it('accepts a valid request', () => {
      const body = {
        values: [{ recordId: '1', data: { text: 'hello' } }],
      }
      const errors = validateRequest(body)
      expect(errors.filter((e) => e.severity === 'error')).toHaveLength(0)
    })

    it('rejects non-object body', () => {
      const errors = validateRequest('not an object')
      expect(errors).toHaveLength(1)
      expect(errors[0].severity).toBe('error')
    })

    it('rejects missing values array', () => {
      const errors = validateRequest({ notValues: [] })
      expect(errors).toHaveLength(1)
      expect(errors[0].message).toContain('`values` must be an array')
    })

    it('warns on empty values array', () => {
      const errors = validateRequest({ values: [] })
      expect(errors).toHaveLength(1)
      expect(errors[0].severity).toBe('warning')
    })

    it('rejects record without recordId', () => {
      const errors = validateRequest({ values: [{ data: {} }] })
      expect(errors.some((e) => e.message.includes('recordId'))).toBe(true)
    })

    it('rejects record with empty recordId', () => {
      const errors = validateRequest({ values: [{ recordId: '', data: {} }] })
      expect(errors.some((e) => e.message.includes('recordId'))).toBe(true)
    })

    it('rejects record without data', () => {
      const errors = validateRequest({ values: [{ recordId: '1' }] })
      expect(errors.some((e) => e.message.includes('data'))).toBe(true)
    })

    it('detects duplicate recordIds', () => {
      const body = {
        values: [
          { recordId: '1', data: {} },
          { recordId: '1', data: {} },
        ],
      }
      const errors = validateRequest(body)
      expect(errors.some((e) => e.message.includes('Duplicate'))).toBe(true)
    })

    it('rejects non-object record items', () => {
      const errors = validateRequest({ values: ['not-object'] })
      expect(errors.some((e) => e.message.includes('must be a JSON object'))).toBe(true)
    })
  })

  // ========================================================================
  // validateResponse
  // ========================================================================
  describe('validateResponse', () => {
    it('accepts a valid response', () => {
      const body = {
        values: [{ recordId: '1', data: { result: 42 }, errors: [], warnings: [] }],
      }
      const errors = validateResponse(body)
      expect(errors.filter((e) => e.severity === 'error')).toHaveLength(0)
    })

    it('rejects non-object body', () => {
      const errors = validateResponse(null)
      expect(errors[0].severity).toBe('error')
    })

    it('rejects missing values', () => {
      const errors = validateResponse({ foo: 1 })
      expect(errors[0].message).toContain('`values` must be an array')
    })

    it('validates errors array items', () => {
      const body = {
        values: [{ recordId: '1', data: {}, errors: [{ noMessage: true }] }],
      }
      const results = validateResponse(body)
      expect(results.some((r) => r.message.includes('should have a "message"'))).toBe(true)
    })

    it('validates warnings array items', () => {
      const body = {
        values: [{ recordId: '1', data: {}, warnings: [42] }],
      }
      const results = validateResponse(body)
      expect(results.some((r) => r.message.includes('should have a "message"'))).toBe(true)
    })

    it('detects missing recordIds from request', () => {
      const body = {
        values: [{ recordId: '2', data: {} }],
      }
      const results = validateResponse(body, { requestRecordIds: ['1'] })
      expect(results.some((r) => r.message.includes('missing'))).toBe(true)
    })

    it('detects unexpected recordIds in response', () => {
      const body = {
        values: [{ recordId: '1', data: {} }, { recordId: '99', data: {} }],
      }
      const results = validateResponse(body, { requestRecordIds: ['1'] })
      expect(results.some((r) => r.message.includes('unexpected'))).toBe(true)
    })

    it('warns when response size exceeds limit', () => {
      const body = { values: [{ recordId: '1', data: {} }] }
      const results = validateResponse(body, { rawBytes: 200 * 1024 * 1024 })
      expect(results.some((r) => r.message.includes('150 MB'))).toBe(true)
    })
  })

  // ========================================================================
  // validateSkillDefinition
  // ========================================================================
  describe('validateSkillDefinition', () => {
    it('accepts a valid skill definition', () => {
      const skill = {
        '@odata.type': '#Microsoft.Skills.Custom.WebApiSkill',
        uri: 'https://example.com/api/skill',
        timeout: 'PT60S',
        batchSize: 100,
        degreeOfParallelism: 5,
      }
      const errors = validateSkillDefinition(skill)
      expect(errors.filter((e) => e.severity === 'error')).toHaveLength(0)
    })

    it('rejects non-HTTPS uri', () => {
      const skill = { uri: 'http://example.com/api/skill' }
      const errors = validateSkillDefinition(skill)
      expect(errors.some((e) => e.message.includes('HTTPS'))).toBe(true)
    })

    it('rejects timeout exceeding 230s', () => {
      const skill = { timeout: 'PT300S' }
      const errors = validateSkillDefinition(skill)
      expect(errors.some((e) => e.message.includes('230'))).toBe(true)
    })

    it('rejects timeout less than 1s', () => {
      const skill = { timeout: 'PT0S' }
      const errors = validateSkillDefinition(skill)
      expect(errors.some((e) => e.message.includes('at least 1'))).toBe(true)
    })

    it('rejects batchSize < 1', () => {
      const errors = validateSkillDefinition({ batchSize: 0 })
      expect(errors.some((e) => e.message.includes('batchSize'))).toBe(true)
    })

    it('rejects degreeOfParallelism out of range', () => {
      const errors1 = validateSkillDefinition({ degreeOfParallelism: 0 })
      expect(errors1.some((e) => e.message.includes('degreeOfParallelism'))).toBe(true)

      const errors2 = validateSkillDefinition({ degreeOfParallelism: 11 })
      expect(errors2.some((e) => e.message.includes('degreeOfParallelism'))).toBe(true)
    })

    it('rejects invalid httpMethod', () => {
      const errors = validateSkillDefinition({ httpMethod: 'GET' })
      expect(errors.some((e) => e.message.includes('httpMethod'))).toBe(true)
    })

    it('accepts valid httpMethod PUT', () => {
      const errors = validateSkillDefinition({ httpMethod: 'PUT' })
      expect(errors.filter((e) => e.severity === 'error')).toHaveLength(0)
    })
  })

  // ========================================================================
  // Quick helpers
  // ========================================================================
  describe('isValidRequest', () => {
    it('returns true for valid request', () => {
      expect(isValidRequest({ values: [{ recordId: '1', data: {} }] })).toBe(true)
    })
    it('returns false for invalid request', () => {
      expect(isValidRequest({ values: [{ noId: true }] })).toBe(false)
    })
  })

  describe('isValidResponse', () => {
    it('returns true for valid response', () => {
      expect(isValidResponse({ values: [{ recordId: '1', data: {} }] })).toBe(true)
    })
    it('returns false for invalid response', () => {
      expect(isValidResponse('hello')).toBe(false)
    })
  })

  describe('extractRecordIds', () => {
    it('extracts ids from valid request', () => {
      const body = { values: [{ recordId: 'a', data: {} }, { recordId: 'b', data: {} }] }
      expect(extractRecordIds(body)).toEqual(['a', 'b'])
    })
    it('returns [] for invalid body', () => {
      expect(extractRecordIds(null)).toEqual([])
    })
  })

  describe('buildSampleRequest', () => {
    it('produces a valid request', () => {
      expect(isValidRequest(buildSampleRequest())).toBe(true)
    })

    it('uses the unified text-only sample payload', () => {
      const sample = buildSampleRequest()
      expect(sample.values[0]?.data).toMatchObject({
        text: 'Azure AI Search custom skill sample text for local testing.',
      })
      expect(Object.keys(sample.values[0]?.data ?? {})).toEqual(['text'])
    })
  })

  describe('buildSampleResponse', () => {
    it('produces a valid response', () => {
      expect(isValidResponse(buildSampleResponse())).toBe(true)
    })
  })
})
