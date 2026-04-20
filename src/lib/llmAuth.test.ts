import { describe, expect, it } from 'vitest'

import { AOAI_AAD_RESOURCE, buildAadCliCommand, buildLlmAuthHeaders } from './llmAuth'

describe('buildLlmAuthHeaders', () => {
  it('returns api-key header in apiKey mode', () => {
    expect(buildLlmAuthHeaders({ mode: 'apiKey', apiKey: 'k' })).toEqual({ 'api-key': 'k' })
  })

  it('returns Bearer header in bearer mode and adds Bearer prefix when missing', () => {
    expect(buildLlmAuthHeaders({ mode: 'bearer', bearerToken: 'abc.def' })).toEqual({
      Authorization: 'Bearer abc.def',
    })
  })

  it('preserves an existing Bearer prefix', () => {
    expect(buildLlmAuthHeaders({ mode: 'bearer', bearerToken: 'Bearer xyz' })).toEqual({
      Authorization: 'Bearer xyz',
    })
  })

  it('throws when api-key is empty', () => {
    expect(() => buildLlmAuthHeaders({ mode: 'apiKey', apiKey: '   ' })).toThrow()
  })

  it('throws when bearer token is empty', () => {
    expect(() => buildLlmAuthHeaders({ mode: 'bearer', bearerToken: '' })).toThrow()
  })
})

describe('buildAadCliCommand', () => {
  it('defaults to the AOAI cognitive services resource', () => {
    expect(buildAadCliCommand()).toContain(AOAI_AAD_RESOURCE)
    expect(buildAadCliCommand()).toContain('--query accessToken')
  })

  it('honors a custom resource', () => {
    expect(buildAadCliCommand('https://example.com')).toContain('--resource https://example.com')
  })
})
