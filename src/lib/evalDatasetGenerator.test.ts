/**
 * Tests for `evalDatasetGenerator` (Phase 1 MVP).
 */

import { describe, it, expect } from 'vitest'
import { callAzureOpenAIChat, parseGeneratedQueries, dedupBySurface, toJsonl, parseHardenedQuery, computeRelevanceGrades, parseRaftAnswer, toRaftJsonl } from './evalDatasetGenerator'
import { LlmAuthError } from './llmAuth'
import type { GeneratedQAItem } from '../types'

describe('parseGeneratedQueries', () => {
  it('parses a valid response with two items', () => {
    const raw = JSON.stringify({
      queries: [
        { query: 'What is X?', query_type: 'factoid' },
        { query: 'How to do Y?', query_type: 'how-to' },
      ],
    })
    const out = parseGeneratedQueries(raw)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ query: 'What is X?', query_type: 'factoid' })
    expect(out[1].query_type).toBe('how-to')
  })

  it('falls back to factoid when query_type is missing or unknown', () => {
    const raw = JSON.stringify({
      queries: [{ query: 'Q?' }, { query: 'Q2?', query_type: 'unknown_type' }],
    })
    const out = parseGeneratedQueries(raw)
    expect(out).toHaveLength(2)
    expect(out[0].query_type).toBe('factoid')
    expect(out[1].query_type).toBe('factoid')
  })

  it('drops malformed entries silently', () => {
    const raw = JSON.stringify({
      queries: [{ query: 'ok', query_type: 'factoid' }, { foo: 'bar' }, { query: '   ' }, null],
    })
    const out = parseGeneratedQueries(raw)
    expect(out).toHaveLength(1)
    expect(out[0].query).toBe('ok')
  })

  it('returns [] for invalid JSON', () => {
    expect(parseGeneratedQueries('not-json')).toEqual([])
    expect(parseGeneratedQueries('null')).toEqual([])
    expect(parseGeneratedQueries('[]')).toEqual([])
  })

  it('returns [] when "queries" is missing', () => {
    expect(parseGeneratedQueries('{"foo":1}')).toEqual([])
  })

  it('coerces to the first allowed type when allowedTypes is provided and query_type is not allowed', () => {
    const raw = JSON.stringify({
      queries: [
        { query: 'Q1?', query_type: 'factoid' },
        { query: 'Q2?', query_type: 'how-to' },
        { query: 'Q3?' },
      ],
    })
    const out = parseGeneratedQueries(raw, ['comparative', 'yes-no'])
    expect(out).toHaveLength(3)
    // factoid / how-to are not allowed, so they get coerced to the first allowed: 'comparative'
    expect(out[0].query_type).toBe('comparative')
    expect(out[1].query_type).toBe('comparative')
    expect(out[2].query_type).toBe('comparative')
  })

  it('preserves an allowed type when present', () => {
    const raw = JSON.stringify({
      queries: [{ query: 'Q?', query_type: 'yes-no' }],
    })
    const out = parseGeneratedQueries(raw, ['comparative', 'yes-no'])
    expect(out[0].query_type).toBe('yes-no')
  })
})

describe('dedupBySurface', () => {
  const mk = (q: string): GeneratedQAItem => ({ query: q, expected_ids: ['d1'] })

  it('keeps distinct queries', () => {
    const out = dedupBySurface([mk('What is Azure?'), mk('How to deploy?')], 0.85)
    expect(out).toHaveLength(2)
  })

  it('drops near-duplicates above threshold', () => {
    const out = dedupBySurface(
      [mk('What is Azure AI Search?'), mk('What is Azure AI Search?')],
      0.85,
    )
    expect(out).toHaveLength(1)
  })

  it('preserves order (first wins)', () => {
    const a = mk('alpha beta gamma')
    const b = mk('alpha beta gamma')
    const c = mk('completely different sentence here')
    const out = dedupBySurface([a, b, c], 0.85)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(a)
    expect(out[1]).toBe(c)
  })

  it('does not drop anything when threshold is 1.0 unless tokens match exactly', () => {
    const out = dedupBySurface(
      [mk('Azure search ranks results'), mk('Azure search ranks documents')],
      1.0,
    )
    expect(out).toHaveLength(2)
  })
})

describe('toJsonl', () => {
  it('produces one JSON object per line, AutoTuning-compatible fields', () => {
    const items: GeneratedQAItem[] = [
      {
        query: 'Q1',
        expected_ids: ['d1'],
        query_type: 'factoid',
        language: 'ja',
        source_doc_id: 'd1',
        generation_model: 'gpt-4o',
      },
      { query: 'Q2', expected_ids: ['d2'] },
    ]
    const out = toJsonl(items)
    const lines = out.split('\n')
    expect(lines).toHaveLength(2)
    const first = JSON.parse(lines[0])
    expect(first.query).toBe('Q1')
    expect(first.expected_ids).toEqual(['d1'])
    expect(first.query_type).toBe('factoid')
    expect(first.language).toBe('ja')
    const second = JSON.parse(lines[1])
    expect(second.query).toBe('Q2')
    expect(second.expected_ids).toEqual(['d2'])
    expect(second.query_type).toBeUndefined()
  })

  it('excludes rejected items', () => {
    const items: GeneratedQAItem[] = [
      { query: 'kept', expected_ids: ['d1'] },
      { query: 'dropped', expected_ids: ['d2'], rejected: true, rejection_reason: 'grounding' },
    ]
    const out = toJsonl(items)
    expect(out.split('\n')).toHaveLength(1)
    expect(JSON.parse(out).query).toBe('kept')
  })

  it('emits provenance metadata when present (Phase 2.0)', () => {
    const items: GeneratedQAItem[] = [
      {
        query: 'Q1',
        expected_ids: ['d1'],
        provenance: 'synthetic',
        generated_at: '2026-04-20T00:00:00.000Z',
        generated_against_index: 'demo-idx',
        generation_run_id: 'edg-abc-123',
        grounding_rank: 2,
        grounding_top_k: 10,
      },
    ]
    const out = toJsonl(items)
    const obj = JSON.parse(out)
    expect(obj.provenance).toBe('synthetic')
    expect(obj.generated_at).toBe('2026-04-20T00:00:00.000Z')
    expect(obj.generated_against_index).toBe('demo-idx')
    expect(obj.generation_run_id).toBe('edg-abc-123')
    expect(obj.grounding_rank).toBe(2)
    expect(obj.grounding_top_k).toBe(10)
  })
})

describe('toJsonl Phase 4 fields', () => {
  it('emits difficulty and hard_negative_ids when present', () => {
    const items: GeneratedQAItem[] = [
      {
        query: 'Q?',
        expected_ids: ['a'],
        source_doc_id: 'a',
        generation_model: 'm',
        difficulty: 'hard',
        hard_negative_ids: ['x', 'y'],
      },
    ]
    const obj = JSON.parse(toJsonl(items))
    expect(obj.difficulty).toBe('hard')
    expect(obj.hard_negative_ids).toEqual(['x', 'y'])
  })

  it('omits hard_negative_ids when empty', () => {
    const items: GeneratedQAItem[] = [
      {
        query: 'Q?',
        expected_ids: ['a'],
        source_doc_id: 'a',
        generation_model: 'm',
        hard_negative_ids: [],
      },
    ]
    const obj = JSON.parse(toJsonl(items))
    expect('hard_negative_ids' in obj).toBe(false)
  })
})

describe('parseHardenedQuery', () => {
  it('extracts trimmed query', () => {
    expect(parseHardenedQuery(JSON.stringify({ query: '  harder?  ' }))).toBe('harder?')
  })
  it('returns null for missing or empty query', () => {
    expect(parseHardenedQuery(JSON.stringify({ query: '' }))).toBeNull()
    expect(parseHardenedQuery(JSON.stringify({}))).toBeNull()
  })
  it('returns null for invalid JSON', () => {
    expect(parseHardenedQuery('not json')).toBeNull()
  })
})

describe('computeRelevanceGrades (Phase 6)', () => {
  it('grades primary anchor as 3 and secondary expected_ids as 2', () => {
    const item: GeneratedQAItem = {
      query: 'Q?',
      expected_ids: ['a', 'b', 'c'],
      source_doc_id: 'a',
    }
    const g = computeRelevanceGrades(item)
    expect(g).toEqual({ a: 3, b: 2, c: 2 })
  })
  it('uses source_doc_id as the anchor when present in expected_ids', () => {
    const item: GeneratedQAItem = {
      query: 'Q?',
      expected_ids: ['a', 'b'],
      source_doc_id: 'b',
    }
    expect(computeRelevanceGrades(item)).toEqual({ b: 3, a: 2 })
  })
  it('grades hard_negative_ids as 0', () => {
    const item: GeneratedQAItem = {
      query: 'Q?',
      expected_ids: ['a'],
      hard_negative_ids: ['x', 'y'],
    }
    expect(computeRelevanceGrades(item)).toEqual({ a: 3, x: 0, y: 0 })
  })
  it('returns undefined when there is nothing to grade', () => {
    const item: GeneratedQAItem = { query: 'Q?', expected_ids: [] }
    expect(computeRelevanceGrades(item)).toBeUndefined()
  })
  it('does not overwrite a higher grade with a lower one if id collides', () => {
    const item: GeneratedQAItem = {
      query: 'Q?',
      expected_ids: ['a'],
      hard_negative_ids: ['a'],
    }
    expect(computeRelevanceGrades(item)).toEqual({ a: 3 })
  })
})

describe('callAzureOpenAIChat (auth failures)', () => {
  const baseParams = {
    endpoint: 'https://example.openai.azure.com',
    deployment: 'gpt',
    apiVersion: '2024-02-15-preview',
    systemPrompt: 's',
    userPrompt: 'u',
  }

  it('throws LlmAuthError on HTTP 401 (bearer)', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('Unauthorized', { status: 401 })) as typeof fetch
    try {
      await expect(
        callAzureOpenAIChat({
          ...baseParams,
          auth: { mode: 'bearer', bearerToken: 'expired' },
        }),
      ).rejects.toBeInstanceOf(LlmAuthError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws LlmAuthError on HTTP 403 (apiKey)', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('Forbidden', { status: 403 })) as typeof fetch
    try {
      await expect(
        callAzureOpenAIChat({
          ...baseParams,
          auth: { mode: 'apiKey', apiKey: 'wrong' },
        }),
      ).rejects.toMatchObject({ name: 'LlmAuthError', status: 403, authMode: 'apiKey' })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('throws a regular Error on non-auth failures (e.g. 500)', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as typeof fetch
    try {
      const p = callAzureOpenAIChat({
        ...baseParams,
        auth: { mode: 'apiKey', apiKey: 'k' },
      })
      await expect(p).rejects.toThrow(/500/)
      await expect(p).rejects.not.toBeInstanceOf(LlmAuthError)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('toJsonl emits relevance_grades', () => {
  it('round-trips relevance_grades', () => {
    const items: GeneratedQAItem[] = [
      {
        query: 'Q?',
        expected_ids: ['a'],
        relevance_grades: { a: 3, x: 0 },
      },
    ]
    const obj = JSON.parse(toJsonl(items))
    expect(obj.relevance_grades).toEqual({ a: 3, x: 0 })
  })
  it('omits relevance_grades when empty', () => {
    const items: GeneratedQAItem[] = [
      { query: 'Q?', expected_ids: ['a'], relevance_grades: {} },
    ]
    const obj = JSON.parse(toJsonl(items))
    expect('relevance_grades' in obj).toBe(false)
  })
})

// ── RAFT tests ──────────────────────────────────────────────────────

describe('parseRaftAnswer', () => {
  it('parses a valid cot_answer', () => {
    const raw = JSON.stringify({ cot_answer: '##Reason: because ... ##Answer: 42' })
    expect(parseRaftAnswer(raw)).toBe('##Reason: because ... ##Answer: 42')
  })

  it('returns null for invalid JSON', () => {
    expect(parseRaftAnswer('not-json')).toBeNull()
  })

  it('returns null when cot_answer is missing', () => {
    expect(parseRaftAnswer(JSON.stringify({ foo: 'bar' }))).toBeNull()
  })

  it('returns null when cot_answer is not a string', () => {
    expect(parseRaftAnswer(JSON.stringify({ cot_answer: 123 }))).toBeNull()
  })

  it('returns null for empty or whitespace cot_answer', () => {
    expect(parseRaftAnswer(JSON.stringify({ cot_answer: '' }))).toBeNull()
    expect(parseRaftAnswer(JSON.stringify({ cot_answer: '   ' }))).toBeNull()
  })

  it('trims whitespace from cot_answer', () => {
    const raw = JSON.stringify({ cot_answer: '  ##Reason: trimmed  ' })
    expect(parseRaftAnswer(raw)).toBe('##Reason: trimmed')
  })

  it('returns null for null/array JSON', () => {
    expect(parseRaftAnswer('null')).toBeNull()
    expect(parseRaftAnswer('[]')).toBeNull()
  })
})

describe('toRaftJsonl', () => {
  it('exports RAFT items with context and cot_answer', () => {
    const items: GeneratedQAItem[] = [
      {
        query: 'What is X?',
        expected_ids: ['doc1'],
        raft_cot_answer: '##Reason: ... ##Answer: X is ...',
        raft_context: [
          { doc_id: 'doc1', text: 'Oracle text', oracle: true },
          { doc_id: 'doc2', text: 'Distractor text', oracle: false },
        ],
      },
    ]
    const line = toRaftJsonl(items)
    const obj = JSON.parse(line)
    expect(obj.question).toBe('What is X?')
    expect(obj.cot_answer).toBe('##Reason: ... ##Answer: X is ...')
    expect(obj.context).toHaveLength(2)
    expect(obj.context[0].oracle).toBe(true)
    expect(obj.context[1].oracle).toBe(false)
    expect(obj.expected_ids).toEqual(['doc1'])
  })

  it('filters out rejected items', () => {
    const items: GeneratedQAItem[] = [
      {
        query: 'Q1',
        expected_ids: ['a'],
        rejected: true,
        raft_cot_answer: 'answer',
        raft_context: [],
      },
    ]
    expect(toRaftJsonl(items)).toBe('')
  })

  it('filters out items without raft_cot_answer', () => {
    const items: GeneratedQAItem[] = [
      { query: 'Q1', expected_ids: ['a'] },
    ]
    expect(toRaftJsonl(items)).toBe('')
  })

  it('includes metadata fields when present', () => {
    const items: GeneratedQAItem[] = [
      {
        query: 'Q?',
        expected_ids: ['a'],
        query_type: 'factoid',
        language: 'en',
        source_doc_id: 'src1',
        generation_model: 'gpt-4o',
        difficulty: 'hard',
        raft_cot_answer: 'answer',
        raft_context: [],
      },
    ]
    const obj = JSON.parse(toRaftJsonl(items))
    expect(obj.query_type).toBe('factoid')
    expect(obj.language).toBe('en')
    expect(obj.source_doc_id).toBe('src1')
    expect(obj.generation_model).toBe('gpt-4o')
    expect(obj.difficulty).toBe('hard')
  })

  it('emits multiple lines for multiple items', () => {
    const items: GeneratedQAItem[] = [
      { query: 'Q1', expected_ids: ['a'], raft_cot_answer: 'a1', raft_context: [] },
      { query: 'Q2', expected_ids: ['b'], raft_cot_answer: 'a2', raft_context: [] },
    ]
    const lines = toRaftJsonl(items).split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).question).toBe('Q1')
    expect(JSON.parse(lines[1]).question).toBe('Q2')
  })
})
