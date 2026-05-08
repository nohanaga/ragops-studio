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

  it('foundry-local: uses /v1/chat/completions', () => {
    const url = buildChatCompletionsUrl(
      cfg({ provider: 'foundry-local', endpoint: 'http://localhost:5272' }),
    )
    expect(url).toBe('http://localhost:5272/v1/chat/completions')
  })

  it('lmstudio: uses /v1/chat/completions', () => {
    const url = buildChatCompletionsUrl(
      cfg({ provider: 'lmstudio', endpoint: 'http://localhost:1234' }),
    )
    expect(url).toBe('http://localhost:1234/v1/chat/completions')
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

  it('lmstudio: uses /v1/embeddings', () => {
    const url = buildEmbeddingsUrl(
      cfg({ provider: 'lmstudio', endpoint: 'http://localhost:1234', model: 'nomic-embed-text' }),
    )
    expect(url).toBe('http://localhost:1234/v1/embeddings')
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

  it('foundry-local: uses Bearer with dummy key when apiKey is empty', () => {
    expect(
      buildProviderAuthHeaders({ mode: 'apiKey', apiKey: '' }, 'foundry-local'),
    ).toEqual({ Authorization: 'Bearer none' })
  })

  it('lmstudio: uses Bearer with dummy key when apiKey is empty', () => {
    expect(
      buildProviderAuthHeaders({ mode: 'apiKey', apiKey: '' }, 'lmstudio'),
    ).toEqual({ Authorization: 'Bearer none' })
  })

  it('foundry-local: passes through user-provided key', () => {
    expect(
      buildProviderAuthHeaders({ mode: 'apiKey', apiKey: 'my-key' }, 'foundry-local'),
    ).toEqual({ Authorization: 'Bearer my-key' })
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

  it('foundry-local: includes model field', () => {
    const body = buildChatRequestBody(cfg({ provider: 'foundry-local', model: 'phi-3.5-mini' }), msgs)
    expect(body.model).toBe('phi-3.5-mini')
  })

  it('lmstudio: includes model field', () => {
    const body = buildChatRequestBody(cfg({ provider: 'lmstudio', model: 'qwen2.5' }), msgs)
    expect(body.model).toBe('qwen2.5')
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

  it('lmstudio: includes model', () => {
    const body = buildEmbeddingsRequestBody(cfg({ provider: 'lmstudio', model: 'nomic-embed' }), inputs)
    expect(body.model).toBe('nomic-embed')
  })
})

// ─── guessMaxInputTokens / resolveMaxInputTokens ────────────────────────────

import { guessMaxInputTokens, resolveMaxInputTokens, DEFAULT_MAX_INPUT_TOKENS } from './llmProvider'

describe('guessMaxInputTokens', () => {
  it('matches exact model name', () => {
    expect(guessMaxInputTokens('gpt-4o')).toBe(128_000)
  })
  it('matches deployment name containing model', () => {
    expect(guessMaxInputTokens('my-gpt-4o-deployment')).toBe(128_000)
  })
  it('matches gpt-4.1', () => {
    expect(guessMaxInputTokens('gpt-4.1')).toBe(300_000)
  })
  it('matches gpt-4.1-mini over gpt-4.1', () => {
    expect(guessMaxInputTokens('gpt-4.1-mini')).toBe(300_000)
  })
  it('matches o3', () => {
    expect(guessMaxInputTokens('o3')).toBe(200_000)
  })
  it('returns null for unknown models', () => {
    expect(guessMaxInputTokens('totally-unknown-model')).toBeNull()
  })
  it('returns null for empty string', () => {
    expect(guessMaxInputTokens('')).toBeNull()
  })
})

describe('resolveMaxInputTokens', () => {
  it('uses explicit override when provided', () => {
    expect(resolveMaxInputTokens('gpt-4o', 50_000)).toBe(50_000)
  })
  it('uses guessed value when no override', () => {
    expect(resolveMaxInputTokens('gpt-4o')).toBe(128_000)
  })
  it('falls back to default for unknown model and no override', () => {
    expect(resolveMaxInputTokens('unknown')).toBe(DEFAULT_MAX_INPUT_TOKENS)
  })
  it('ignores zero override', () => {
    expect(resolveMaxInputTokens('gpt-4o', 0)).toBe(128_000)
  })
})
