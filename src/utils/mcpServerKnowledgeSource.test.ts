import { describe, expect, it } from 'vitest'

import {
  buildMcpServerKnowledgeSourceBody,
  normalizeMcpServerParameters,
  serializeMcpServerParameters,
} from './mcpServerKnowledgeSource'

describe('utils/mcpServerKnowledgeSource', () => {
  it('normalizes legacy inclusionMode values for editing', () => {
    expect(normalizeMcpServerParameters({
      serverURL: 'https://example.test/mcp',
      tools: [
        { name: 'search', inclusionMode: 'reranked' },
        { name: 'lookup', inclusionMode: 'always' },
      ],
    })).toEqual({
      serverURL: 'https://example.test/mcp',
      tools: [
        { name: 'search', resultsProcessing: 'rerank' },
        { name: 'lookup', resultsProcessing: 'none' },
      ],
    })
  })

  it('serializes the 2026-05-preview MCP Tool contract', () => {
    expect(serializeMcpServerParameters({
      tools: [
        { name: 'search', resultsProcessing: 'rerank' },
        { name: 'lookup', resultsProcessing: 'none' },
      ],
    }, '2026-05-01-preview')).toEqual({
      tools: [
        { name: 'search', inclusionMode: 'reranked' },
        { name: 'lookup', inclusionMode: 'always' },
      ],
    })
  })

  it('serializes only the August resultsProcessing shape for MCP Tools', () => {
    expect(serializeMcpServerParameters({
      tools: [{ name: 'search', inclusionMode: 'always' }],
    }, '2026-08-01-preview')).toEqual({
      tools: [{ name: 'search', resultsProcessing: 'none' }],
    })
  })

  it('omits top-level resultsProcessing before August', () => {
    const parameters = { tools: [{ name: 'search', resultsProcessing: 'rerank' }] }

    expect(buildMcpServerKnowledgeSourceBody({
      name: 'mcp-source',
      description: null,
      resultsProcessing: 'none',
      mcpServerParameters: parameters,
      apiVersion: '2026-05-01-preview',
    })).toEqual({
      name: 'mcp-source',
      kind: 'mcpServer',
      description: null,
      mcpServerParameters: {
        tools: [{ name: 'search', inclusionMode: 'reranked' }],
      },
    })

    expect(buildMcpServerKnowledgeSourceBody({
      name: 'mcp-source',
      description: null,
      resultsProcessing: 'none',
      mcpServerParameters: parameters,
      apiVersion: '2026-08-01-preview',
    })).toMatchObject({
      resultsProcessing: 'none',
      mcpServerParameters: {
        tools: [{ name: 'search', resultsProcessing: 'rerank' }],
      },
    })
  })
})