import { describe, expect, it } from 'vitest'

import {
  AOAI_AAD_RESOURCE,
  buildAadCliCommand,
  buildLlmAuthHeaders,
  formatLlmAuthErrorMessage,
  isLlmAuthStatus,
  LlmAuthError,
} from './llmAuth'

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

describe('isLlmAuthStatus', () => {
  it('treats 401 and 403 as auth failures', () => {
    expect(isLlmAuthStatus(401)).toBe(true)
    expect(isLlmAuthStatus(403)).toBe(true)
  })

  it('rejects other status codes', () => {
    expect(isLlmAuthStatus(200)).toBe(false)
    expect(isLlmAuthStatus(429)).toBe(false)
    expect(isLlmAuthStatus(500)).toBe(false)
  })
})

describe('formatLlmAuthErrorMessage', () => {
  it('includes the AAD CLI command for bearer mode (en)', () => {
    const err = new LlmAuthError(401, 'bearer', 'Unauthorized')
    const msg = formatLlmAuthErrorMessage(err, 'en')
    expect(msg).toContain('401')
    expect(msg).toContain('bearer token')
    expect(msg).toContain(buildAadCliCommand())
  })

  it('includes the AAD CLI command for bearer mode (ja)', () => {
    const err = new LlmAuthError(401, 'bearer', 'Unauthorized')
    const msg = formatLlmAuthErrorMessage(err, 'ja')
    expect(msg).toContain('401')
    expect(msg).toContain('Bearer')
    expect(msg).toContain(buildAadCliCommand())
  })

  it('hints the user to verify the API key for apiKey mode', () => {
    const err = new LlmAuthError(403, 'apiKey', 'Forbidden')
    expect(formatLlmAuthErrorMessage(err, 'en')).toMatch(/API key/i)
    expect(formatLlmAuthErrorMessage(err, 'ja')).toContain('API Key')
  })
})
