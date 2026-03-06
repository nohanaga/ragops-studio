// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'

import { clamp, extractQueryString, getBrowserLanguage } from './helpers'

describe('utils/helpers', () => {
  it('getBrowserLanguage returns ja for ja-*', () => {
    Object.defineProperty(navigator, 'language', { value: 'ja-JP', configurable: true })
    expect(getBrowserLanguage()).toBe('ja')
  })

  it('getBrowserLanguage returns en for non-ja', () => {
    Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
    expect(getBrowserLanguage()).toBe('en')
  })

  it('extractQueryString prefers search when present', () => {
    expect(extractQueryString({ search: '  hello  ' })).toBe('  hello  ')
  })

  it('extractQueryString returns vector text when search missing', () => {
    expect(extractQueryString({ vectorQueries: [{ kind: 'text', text: 'hi' }] })).toBe('hi')
  })

  it('extractQueryString returns vector numeric preview when kind=vector', () => {
    const s = extractQueryString({ vectorQueries: [{ kind: 'vector', vector: [0.1, 0.2, 0.3, 0.4] }] })
    expect(s).toBe('[0.100, 0.200, 0.300, ...]')
  })

  it('extractQueryString returns analyze text when present', () => {
    expect(extractQueryString({ text: 'analyze me' })).toBe('analyze me')
  })

  it('extractQueryString returns agentic message content when present', () => {
    expect(
      extractQueryString({
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'agentic prompt text' }],
          },
        ],
      }),
    ).toBe('agentic prompt text')
  })

  it('extractQueryString returns empty for unknown shapes', () => {
    expect(extractQueryString(null)).toBe('')
    expect(extractQueryString({})).toBe('')
  })

  it('clamp bounds values', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(999, 0, 10)).toBe(10)
  })
})
