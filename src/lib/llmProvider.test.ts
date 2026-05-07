import { describe, expect, it } from 'vitest'

import {
  buildChatCompletionsUrl,
  buildChatRequestBody,
  buildEmbeddingsRequestBody,
  buildEmbeddingsUrl,
  buildProviderAuthHeaders,
  type LlmProviderConfig,
} from './llmProvider'

// ─── helpers ────────────────────────────────────────────────────────────────

function cfg(overrides: Partial<LlmProviderConfig> = {}): LlmProviderConfig {
  return {
    provider: 'azure-openai',
    endpoint: 'https://my.openai.azure.com',
    auth: { mode: 'apiKey', apiKey: 'key123' },
    model: 'gpt-4o',
    apiVersion: '2024-10-21',
    ...overrides,
  }
}

// ─── buildChatCompletionsUrl ────────────────────────────────────────────────

describe('buildChatCompletionsUrl', () => {
  it('azure-openai: uses deployment-based URL with api-version', () => {
    const url = buildChatCompletionsUrl(cfg())
    expect(url).toBe(
      'https://my.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21',
    )
  })

  it('azure-openai: encodes special chars in deployment name', () => {
    const url = buildChatCompletionsUrl(cfg({ model: 'my model/v2' }))
    expect(url).toContain('my%20model%2Fv2')
  })

  it('openai: uses /v1/chat/completions', () => {
    const url = buildChatCompletionsUrl(
      cfg({ provider: 'openai', endpoint: 'https://api.openai.com' }),
    )
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('strips trailing slashes from endpoint', () => {
    const url = buildChatCompletionsUrl(
      cfg({ provider: 'openai', endpoint: 'https://api.openai.com/' }),
    )
    expect(url).toBe('https://api.openai.com/v1/chat/completions')
  })
})

// ─── buildEmbeddingsUrl ─────────────────────────────────────────────────────

describe('buildEmbeddingsUrl', () => {
  it('azure-openai: uses deployment-based URL with api-version', () => {
    const url = buildEmbeddingsUrl(cfg({ model: 'text-embedding-3-large' }))
    expect(url).toBe(
      'https://my.openai.azure.com/openai/deployments/text-embedding-3-large/embeddings?api-version=2024-10-21',
    )
  })

  it('openai: uses /v1/embeddings', () => {
    const url = buildEmbeddingsUrl(
      cfg({ provider: 'openai', endpoint: 'https://api.openai.com', model: 'text-embedding-3-small' }),
    )
    expect(url).toBe('https://api.openai.com/v1/embeddings')
  })
})

// ─── buildProviderAuthHeaders ───────────────────────────────────────────────

describe('buildProviderAuthHeaders', () => {
  it('azure-openai apiKey → api-key header', () => {
    expect(buildProviderAuthHeaders({ mode: 'apiKey', apiKey: 'abc' }, 'azure-openai')).toEqual({
      'api-key': 'abc',
    })
  })

  it('openai apiKey → Bearer header', () => {
    expect(buildProviderAuthHeaders({ mode: 'apiKey', apiKey: 'sk-xxx' }, 'openai')).toEqual({
      Authorization: 'Bearer sk-xxx',
    })
  })

  it('bearer mode → Authorization header with prefix added', () => {
    expect(
      buildProviderAuthHeaders({ mode: 'bearer', bearerToken: 'tok' }, 'azure-openai'),
    ).toEqual({ Authorization: 'Bearer tok' })
  })

  it('bearer mode preserves existing Bearer prefix', () => {
    expect(
      buildProviderAuthHeaders({ mode: 'bearer', bearerToken: 'Bearer tok' }, 'azure-openai'),
    ).toEqual({ Authorization: 'Bearer tok' })
  })

  it('throws when apiKey is empty', () => {
    expect(() => buildProviderAuthHeaders({ mode: 'apiKey', apiKey: '' }, 'azure-openai')).toThrow()
  })

  it('throws when bearer token is empty', () => {
    expect(() =>
      buildProviderAuthHeaders({ mode: 'bearer', bearerToken: '  ' }, 'openai'),
    ).toThrow()
  })
})

// ─── buildChatRequestBody ───────────────────────────────────────────────────

describe('buildChatRequestBody', () => {
  const msgs = [{ role: 'user', content: 'hello' }]

  it('azure-openai: omits model (it is in the URL)', () => {
    const body = buildChatRequestBody(cfg(), msgs)
    expect(body).not.toHaveProperty('model')
    expect(body.messages).toEqual(msgs)
    expect(body.temperature).toBe(0.3)
  })

  it('openai: includes model field', () => {
    const body = buildChatRequestBody(cfg({ provider: 'openai' }), msgs)
    expect(body.model).toBe('gpt-4o')
  })

  it('jsonMode adds response_format', () => {
    const body = buildChatRequestBody(cfg(), msgs, { jsonMode: true })
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('without jsonMode omits response_format', () => {
    const body = buildChatRequestBody(cfg(), msgs, { jsonMode: false })
    expect(body).not.toHaveProperty('response_format')
  })
})

// ─── buildEmbeddingsRequestBody ─────────────────────────────────────────────

describe('buildEmbeddingsRequestBody', () => {
  const inputs = ['a', 'b']

  it('azure-openai: omits model (it is in the URL)', () => {
    const body = buildEmbeddingsRequestBody(cfg(), inputs)
    expect(body).not.toHaveProperty('model')
    expect(body.input).toEqual(inputs)
  })

  it('openai: includes model', () => {
    const body = buildEmbeddingsRequestBody(cfg({ provider: 'openai' }), inputs)
    expect(body.model).toBe('gpt-4o')
  })
})
