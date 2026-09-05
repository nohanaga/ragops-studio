import { describe, expect, it } from 'vitest'

import { getSearchApiCapabilities } from './searchApiCapabilities'

describe('lib/searchApiCapabilities', () => {
  it('separates August capabilities from the 2026-05 MCP contract', () => {
    expect(getSearchApiCapabilities('2026-08-01-preview')).toMatchObject({
      cursorList: true,
      agenticStreaming: true,
      reasoningAuto: true,
      queryHints: true,
      retrieveDefaults: true,
      perSourceResultsProcessing: true,
      mcpServerKnowledgeSources: true,
      mcpToolResultsProcessing: true,
    })
    expect(getSearchApiCapabilities('2026-05-01-preview')).toMatchObject({
      cursorList: false,
      agenticStreaming: false,
      reasoningAuto: false,
      queryHints: false,
      retrieveDefaults: false,
      perSourceResultsProcessing: false,
      mcpServerKnowledgeSources: true,
      mcpToolResultsProcessing: false,
    })
  })

  it('models the extractive-only 2026-04 agentic contract', () => {
    expect(getSearchApiCapabilities('2026-04-01')).toMatchObject({
      agenticResponseSynthesis: false,
      alwaysQuerySource: false,
    })
    expect(getSearchApiCapabilities('2025-11-01-preview')).toMatchObject({
      agenticResponseSynthesis: true,
      alwaysQuerySource: true,
      mcpServerKnowledgeSources: false,
    })
  })
})