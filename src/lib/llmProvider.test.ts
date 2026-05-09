import { describe, expect, it } from 'vitest'

import {
  buildChatCompletionsUrl,
  buildChatRequestBody,
  buildEmbeddingsRequestBody,
  buildEmbeddingsUrl,
  buildProviderAuthHeaders,
  DEFAULT_LOCAL_MAX_TOKENS,
  type JsonSchemaResponseFormat,
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

  it('jsonMode adds response_format for openai', () => {
    const body = buildChatRequestBody(cfg({ provider: 'openai' }), msgs, { jsonMode: true })
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('jsonMode omits response_format for lmstudio (no schema)', () => {
    const body = buildChatRequestBody(cfg({ provider: 'lmstudio' }), msgs, { jsonMode: true })
    expect(body).not.toHaveProperty('response_format')
  })

  it('jsonMode omits response_format for foundry-local (unsupported)', () => {
    const body = buildChatRequestBody(cfg({ provider: 'foundry-local' }), msgs, { jsonMode: true })
    expect(body).not.toHaveProperty('response_format')
  })

  // ─── jsonSchema structured output ─────────────────────────────────────────

  const testSchema: JsonSchemaResponseFormat = {
    name: 'test_output',
    schema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
  }

  it('jsonSchema: azure-openai uses json_schema response_format', () => {
    const body = buildChatRequestBody(cfg(), msgs, { jsonMode: true, jsonSchema: testSchema })
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'test_output', strict: true, schema: testSchema.schema },
    })
  })

  it('jsonSchema: openai uses json_schema response_format', () => {
    const body = buildChatRequestBody(cfg({ provider: 'openai' }), msgs, { jsonMode: true, jsonSchema: testSchema })
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'test_output', strict: true, schema: testSchema.schema },
    })
  })

  it('jsonSchema: lmstudio uses json_schema response_format', () => {
    const body = buildChatRequestBody(cfg({ provider: 'lmstudio' }), msgs, { jsonMode: true, jsonSchema: testSchema })
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'test_output', strict: true, schema: testSchema.schema },
    })
  })

  it('jsonSchema: foundry-local still omits response_format', () => {
    const body = buildChatRequestBody(cfg({ provider: 'foundry-local' }), msgs, { jsonMode: true, jsonSchema: testSchema })
    expect(body).not.toHaveProperty('response_format')
  })

  it('jsonSchema without jsonMode still applies json_schema', () => {
    const body = buildChatRequestBody(cfg(), msgs, { jsonSchema: testSchema })
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'test_output', strict: true, schema: testSchema.schema },
    })
  })

  it('jsonSchema respects strict: false', () => {
    const relaxed = { ...testSchema, strict: false }
    const body = buildChatRequestBody(cfg(), msgs, { jsonSchema: relaxed })
    expect((body.response_format as Record<string, unknown>)).toEqual({
      type: 'json_schema',
      json_schema: { name: 'test_output', strict: false, schema: testSchema.schema },
    })
  })

  it('without jsonMode omits response_format', () => {
    const body = buildChatRequestBody(cfg(), msgs, { jsonMode: false })
    expect(body).not.toHaveProperty('response_format')
  })

  // ─── max_tokens ───────────────────────────────────────────────────────────

  it('azure-openai: omits max_tokens by default', () => {
    const body = buildChatRequestBody(cfg(), msgs)
    expect(body).not.toHaveProperty('max_tokens')
  })

  it('explicit maxTokens sets max_tokens for any provider', () => {
    const body = buildChatRequestBody(cfg(), msgs, { maxTokens: 2048 })
    expect(body.max_tokens).toBe(2048)
  })

  it('lmstudio: auto-sets max_tokens to DEFAULT_LOCAL_MAX_TOKENS', () => {
    const body = buildChatRequestBody(cfg({ provider: 'lmstudio' }), msgs)
    expect(body.max_tokens).toBe(DEFAULT_LOCAL_MAX_TOKENS)
  })

  it('foundry-local: auto-sets max_tokens to DEFAULT_LOCAL_MAX_TOKENS', () => {
    const body = buildChatRequestBody(cfg({ provider: 'foundry-local' }), msgs)
    expect(body.max_tokens).toBe(DEFAULT_LOCAL_MAX_TOKENS)
  })

  it('lmstudio: explicit maxTokens overrides default', () => {
    const body = buildChatRequestBody(cfg({ provider: 'lmstudio' }), msgs, { maxTokens: 8192 })
    expect(body.max_tokens).toBe(8192)
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

import { guessMaxInputTokens, resolveMaxInputTokens, DEFAULT_MAX_INPUT_TOKENS, stripHarmonyTokens, extractJsonFromText } from './llmProvider'

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

// ─── stripHarmonyTokens ─────────────────────────────────────────────────────

describe('stripHarmonyTokens', () => {
  it('strips channel/message/start/end tokens from gpt-oss output', () => {
    const raw = '<|start|>assistant<|channel|>analysis<|message|>thinking...<|end|><|start|>assistant<|channel|>final<|message|>Hello world'
    expect(stripHarmonyTokens(raw)).toBe('thinking...Hello world')
  })

  it('returns clean text unchanged', () => {
    expect(stripHarmonyTokens('Hello world')).toBe('Hello world')
  })

  it('handles empty string', () => {
    expect(stripHarmonyTokens('')).toBe('')
  })

  it('strips return and call tokens', () => {
    expect(stripHarmonyTokens('answer<|return|>')).toBe('answer')
    expect(stripHarmonyTokens('<|call|>func')).toBe('func')
  })
})

// ─── extractJsonFromText ────────────────────────────────────────────────────

describe('extractJsonFromText', () => {
  it('returns valid JSON as-is', () => {
    const json = '{"queries":[{"query":"test"}]}'
    expect(extractJsonFromText(json)).toBe(json)
  })

  it('extracts JSON from markdown code fence', () => {
    const input = 'Here is the result:\n```json\n{"answer": 42}\n```\nDone.'
    expect(extractJsonFromText(input)).toBe('{"answer": 42}')
  })

  it('extracts JSON object from surrounding prose', () => {
    const input = 'Sure! The answer is: {"query": "test"} as requested.'
    expect(extractJsonFromText(input)).toBe('{"query": "test"}')
  })

  it('extracts JSON array from surrounding prose', () => {
    const input = 'Results: [1, 2, 3] end.'
    expect(extractJsonFromText(input)).toBe('[1, 2, 3]')
  })

  it('handles nested objects correctly', () => {
    const input = 'Here: {"a": {"b": "c"}} done.'
    expect(extractJsonFromText(input)).toBe('{"a": {"b": "c"}}')
  })

  it('handles strings containing braces', () => {
    const input = 'Look: {"text": "a {b} c"} fin.'
    expect(extractJsonFromText(input)).toBe('{"text": "a {b} c"}')
  })

  it('returns original when no JSON found', () => {
    expect(extractJsonFromText('no json here')).toBe('no json here')
  })
})
