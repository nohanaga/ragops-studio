import { describe, expect, it } from 'vitest'

import {
  buildScenarioSystemPrompt,
  buildScenarioUserPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  renderDomainSchema,
  buildHardenSystemPrompt,
  buildHardenUserPrompt,
} from './evalDatasetPrompts'

/**
 * Snapshot tests for the LLM prompts. These are intentionally tight: any change
 * to wording, schema, or shape descriptions will fail and force a deliberate
 * snapshot update — important for synthetic eval reproducibility.
 */
describe('evalDatasetPrompts (Phase 1 / 3 snapshots)', () => {
  describe('buildSystemPrompt', () => {
    it('matches snapshot for ja without domain', () => {
      expect(buildSystemPrompt('ja')).toMatchSnapshot()
    })

    it('matches snapshot for en with domain', () => {
      expect(buildSystemPrompt('en', 'API reference for an internal HR portal')).toMatchSnapshot()
    })
  })

  describe('buildUserPrompt', () => {
    it('matches snapshot for ja, factoid only, 2 queries per doc', () => {
      const out = buildUserPrompt({
        language: 'ja',
        queryTypes: ['factoid'],
        queriesPerDoc: 2,
        docId: 'doc-1',
        chunkText: 'これはテスト用のドキュメント本文です。X の値は 42 です。',
      })
      expect(out).toMatchSnapshot()
    })

    it('matches snapshot for en, factoid+how-to, 3 queries per doc, with domain', () => {
      const out = buildUserPrompt({
        language: 'en',
        queryTypes: ['factoid', 'how-to'],
        queriesPerDoc: 3,
        docId: 'doc-2',
        chunkText: 'To configure logging, set the LOG_LEVEL environment variable.',
        domainDescription: 'Engineering wiki',
      })
      expect(out).toMatchSnapshot()
    })
  })

  describe('buildScenarioSystemPrompt (Phase 3 Ragas)', () => {
    it('matches snapshot for ja without domain', () => {
      expect(buildScenarioSystemPrompt('ja')).toMatchSnapshot()
    })

    it('matches snapshot for en with domain', () => {
      expect(
        buildScenarioSystemPrompt('en', 'Customer-facing knowledge base for a SaaS product'),
      ).toMatchSnapshot()
    })
  })

  describe('buildScenarioUserPrompt (Phase 3 Ragas)', () => {
    it('matches snapshot for single_specific (ja, web_search style, short)', () => {
      const out = buildScenarioUserPrompt({
        language: 'ja',
        shape: 'single_specific',
        style: 'web_search',
        length: 'short',
        persona: '新人開発者',
        docs: [{ id: 'doc-A', text: 'X の値は 42 である。' }],
      })
      expect(out).toMatchSnapshot()
    })

    it('matches snapshot for multi_abstract (en, formal style, long, two docs)', () => {
      const out = buildScenarioUserPrompt({
        language: 'en',
        shape: 'multi_abstract',
        style: 'formal',
        length: 'long',
        persona: 'system architect',
        docs: [
          { id: 'doc-A', text: 'Service A handles authentication via OAuth 2.' },
          { id: 'doc-B', text: 'Service B performs authorisation using policy files.' },
        ],
        domainDescription: 'Platform internals',
      })
      expect(out).toMatchSnapshot()
    })
  })
})

describe('renderDomainSchema (Phase 4)', () => {
  it('returns empty string when schema is undefined', () => {
    expect(renderDomainSchema('ja')).toBe('')
  })
  it('returns empty string when schema has only empty fields', () => {
    expect(renderDomainSchema('ja', { entities: '  ', relations: '', constraints: undefined })).toBe('')
  })
  it('renders ja schema with filled fields', () => {
    const out = renderDomainSchema('ja', {
      entities: 'サービス, チケット',
      relations: 'サービス → 依存サービス',
    })
    expect(out).toMatchSnapshot()
  })
  it('renders en schema with all three fields', () => {
    const out = renderDomainSchema('en', {
      entities: 'service, ticket',
      relations: 'service → dependent service',
      constraints: 'approved-only',
    })
    expect(out).toMatchSnapshot()
  })
})

describe('buildHardenPrompts (Phase 4, Evol-Instruct)', () => {
  it('buildHardenSystemPrompt ja snapshot', () => {
    expect(buildHardenSystemPrompt('ja')).toMatchSnapshot()
  })
  it('buildHardenSystemPrompt en snapshot', () => {
    expect(buildHardenSystemPrompt('en')).toMatchSnapshot()
  })
  it('buildHardenUserPrompt embeds query and context (ja)', () => {
    const out = buildHardenUserPrompt({
      language: 'ja',
      query: 'What is X?',
      contextText: 'X is the HR portal.',
    })
    expect(out).toContain('What is X?')
    expect(out).toContain('X is the HR portal.')
  })
})
