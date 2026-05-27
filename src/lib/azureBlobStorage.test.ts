/**
 * Tests for Azure Blob Storage client helpers.
 *
 * Only tests the pure functions (parsing, mapping) since actual network
 * operations require a live Azure Storage account.
 */

import { describe, expect, it } from 'vitest'
import {
  parseStorageConnectionString,
  normalizeStorageResourceIdInput,
  mapProjectionToSearchResult,
} from './azureBlobStorage'

// ---------------------------------------------------------------------------
// parseStorageConnectionString
// ---------------------------------------------------------------------------

describe('parseStorageConnectionString', () => {
  it('parses a valid connection string', () => {
    const cs =
      'DefaultEndpointsProtocol=https;AccountName=myacct;AccountKey=abc123==;EndpointSuffix=core.windows.net'
    const result = parseStorageConnectionString(cs)
    expect(result).not.toBeNull()
    expect(result!.accountName).toBe('myacct')
    expect(result!.accountKey).toBe('abc123==')
    expect(result!.endpointSuffix).toBe('core.windows.net')
  })

  it('defaults endpointSuffix when missing', () => {
    const cs = 'AccountName=myacct;AccountKey=key123=='
    const result = parseStorageConnectionString(cs)
    expect(result).not.toBeNull()
    expect(result!.endpointSuffix).toBe('core.windows.net')
  })

  it('returns null when AccountName is missing', () => {
    expect(parseStorageConnectionString('AccountKey=key123==')).toBeNull()
  })

  it('returns null when AccountKey is missing', () => {
    expect(parseStorageConnectionString('AccountName=myacct')).toBeNull()
  })

  it('handles AccountKey that contains "=" characters', () => {
    const cs =
      'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=abc+def/ghi==;EndpointSuffix=core.windows.net'
    const result = parseStorageConnectionString(cs)
    expect(result).not.toBeNull()
    expect(result!.accountKey).toBe('abc+def/ghi==')
  })
})

// ---------------------------------------------------------------------------
// normalizeStorageResourceIdInput
// ---------------------------------------------------------------------------

describe('normalizeStorageResourceIdInput', () => {
  it('extracts a storage account resource ID from an Azure portal URL', () => {
    const portalUrl = 'https://ms.portal.azure.com/#@fdpo.onmicrosoft.com/resource/subscriptions/57004694-ab6a-4083-82f5-ec89057b6749/resourceGroups/search-semantic2/providers/Microsoft.Storage/storageAccounts/strsemantic1/overview'

    expect(normalizeStorageResourceIdInput(portalUrl)).toBe('/subscriptions/57004694-ab6a-4083-82f5-ec89057b6749/resourceGroups/search-semantic2/providers/Microsoft.Storage/storageAccounts/strsemantic1')
  })

  it('preserves a plain storage account resource ID', () => {
    const resourceId = '/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/account'

    expect(normalizeStorageResourceIdInput(resourceId)).toBe(resourceId)
  })

  it('removes a ResourceId prefix and semicolon', () => {
    expect(normalizeStorageResourceIdInput('ResourceId=/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/account;')).toBe('/subscriptions/sub/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/account')
  })
})

// ---------------------------------------------------------------------------
// mapProjectionToSearchResult
// ---------------------------------------------------------------------------

describe('mapProjectionToSearchResult', () => {
  const outputs = [
    { sourcePath: '/document/organizations', fieldName: 'dbg__ner__organizations' },
    { sourcePath: '/document/keyPhrases', fieldName: 'dbg__kpe__keyPhrases' },
    { sourcePath: '/document/language', fieldName: 'dbg__lang__language' },
    { sourcePath: '/document/pages/*/chunk', fieldName: 'dbg__split__chunk' },
  ]

  it('maps top-level values from projection JSON', () => {
    const projection = {
      content: 'Hello world',
      organizations: ['Microsoft', 'Contoso'],
      keyPhrases: ['Azure', 'AI'],
      language: 'en',
    }

    const result = mapProjectionToSearchResult(projection, outputs)
    expect(result['@odata.count']).toBe(1)
    expect(result.value).toHaveLength(1)

    const doc = result.value[0]
    expect(doc['dbg__ner__organizations']).toEqual(['Microsoft', 'Contoso'])
    expect(doc['dbg__kpe__keyPhrases']).toEqual(['Azure', 'AI'])
    expect(doc['dbg__lang__language']).toBe('en')
    expect(doc['content']).toBe('Hello world')
  })

  it('maps nested array context values (pages/*/chunk)', () => {
    const projection = {
      pages: [
        { chunk: 'Page 1 text', embedding: [0.1, 0.2] },
        { chunk: 'Page 2 text', embedding: [0.3, 0.4] },
      ],
    }

    const result = mapProjectionToSearchResult(projection, outputs)
    const doc = result.value[0]
    // /document/pages/*/chunk should collect "chunk" from each page
    expect(doc['dbg__split__chunk']).toEqual(['Page 1 text', 'Page 2 text'])
  })

  it('handles missing values gracefully', () => {
    const projection = { content: 'Just content' }
    const result = mapProjectionToSearchResult(projection, outputs)
    const doc = result.value[0]
    expect(doc['dbg__ner__organizations']).toBeUndefined()
    expect(doc['content']).toBe('Just content')
  })

  it('handles non-record input', () => {
    const result = mapProjectionToSearchResult(null, outputs)
    expect(result.value).toHaveLength(1)
    expect(Object.keys(result.value[0])).toHaveLength(0)
  })

  it('includes _ragops_field_mappings metadata', () => {
    const projection = { content: 'Hello', organizations: ['MS'] }
    const result = mapProjectionToSearchResult(projection, outputs)
    expect(result._ragops_field_mappings).toBeDefined()
    expect(result._ragops_field_mappings!['/document/organizations']).toBe('dbg__ner__organizations')
    expect(result._ragops_field_mappings!['/document/pages/*/chunk']).toBe('dbg__split__chunk')
    expect(result._ragops_field_mappings!['/document/content']).toBe('content')
  })

  it('maps doubly-nested array context values (pages/*/pages2)', () => {
    const projection = {
      content: 'RAG...',
      pages: ['page1 text', 'page2 text'],
      pages_2: [
        { pages2: ['sub1a', 'sub1b'] },
        { pages2: ['sub2a', 'sub2b', 'sub2c'] },
      ],
    }

    const nestedOutputs = [
      { sourcePath: '/document/pages', fieldName: 'dbg__split2__pages' },
      { sourcePath: '/document/pages_2/*/pages2', fieldName: 'dbg__split3__pages2' },
    ]

    const result = mapProjectionToSearchResult(projection, nestedOutputs)
    const doc = result.value[0]
    expect(doc['dbg__split2__pages']).toEqual(['page1 text', 'page2 text'])
    // Doubly-nested: should collect inner arrays from each element
    expect(doc['dbg__split3__pages2']).toEqual([
      ['sub1a', 'sub1b'],
      ['sub2a', 'sub2b', 'sub2c'],
    ])
    expect(result._ragops_field_mappings!['/document/pages_2/*/pages2']).toBe('dbg__split3__pages2')
  })

  it('includes enrichmentPath in _ragops_field_mappings when blobPath differs', () => {
    const projection = {
      content: 'Hello',
      pages: ['page1 text'],
      pages_2: [
        { keyPhrases: ['Azure', 'AI Search'] },
      ],
    }

    const outputsWithEnrichment = [
      { sourcePath: '/document/pages', fieldName: 'dbg__split__pages' },
      {
        sourcePath: '/document/pages_2/*/keyPhrases',
        fieldName: 'dbg__kpe__keyPhrases',
        enrichmentPath: '/document/pages/*/keyPhrases',
      },
    ]

    const result = mapProjectionToSearchResult(projection, outputsWithEnrichment)
    const doc = result.value[0]
    expect(doc['dbg__kpe__keyPhrases']).toEqual([['Azure', 'AI Search']])

    // Both blobPath and enrichmentPath should be in mappings
    expect(result._ragops_field_mappings!['/document/pages_2/*/keyPhrases']).toBe('dbg__kpe__keyPhrases')
    expect(result._ragops_field_mappings!['/document/pages/*/keyPhrases']).toBe('dbg__kpe__keyPhrases')
  })

  it('enrichmentPath covers doc-level name collision (content → content_2)', () => {
    // When a skill outputs to /document/content but "content" is already used
    // by the Shaper seed, the Shaper renames it to content_2.
    const projection = {
      content: 'original doc content',
      content_2: 'skill-produced content',
    }

    const outputsWithCollision = [
      {
        sourcePath: '/document/content_2',
        fieldName: 'dbg__skill__content',
        enrichmentPath: '/document/content',
      },
    ]

    const result = mapProjectionToSearchResult(projection, outputsWithCollision)
    const doc = result.value[0]
    expect(doc['dbg__skill__content']).toBe('skill-produced content')

    // Both the blobPath and the original enrichment path should be mapped
    expect(result._ragops_field_mappings!['/document/content_2']).toBe('dbg__skill__content')
    expect(result._ragops_field_mappings!['/document/content']).toBe('dbg__skill__content')
  })

  it('enrichmentPath covers sanitized name (key-phrases → key_phrases)', () => {
    // When a skill's targetName contains characters invalid for Shaper input
    // names (e.g. hyphens), the Shaper sanitizes them to underscores.
    const projection = {
      key_phrases: ['Azure', 'AI'],
    }

    const outputsWithSanitized = [
      {
        sourcePath: '/document/key_phrases',
        fieldName: 'dbg__skill__key_phrases',
        enrichmentPath: '/document/key-phrases',
      },
    ]

    const result = mapProjectionToSearchResult(projection, outputsWithSanitized)
    const doc = result.value[0]
    expect(doc['dbg__skill__key_phrases']).toEqual(['Azure', 'AI'])

    expect(result._ragops_field_mappings!['/document/key_phrases']).toBe('dbg__skill__key_phrases')
    expect(result._ragops_field_mappings!['/document/key-phrases']).toBe('dbg__skill__key_phrases')
  })

  it('no enrichmentPath added when blobPath matches sourcePath', () => {
    // When there's no collision or sanitization, enrichmentPath is undefined
    // and no duplicate mapping should be created.
    const projection = {
      organizations: ['Microsoft'],
    }

    const outputsNoCollision = [
      { sourcePath: '/document/organizations', fieldName: 'dbg__ner__organizations' },
    ]

    const result = mapProjectionToSearchResult(projection, outputsNoCollision)
    const doc = result.value[0]
    expect(doc['dbg__ner__organizations']).toEqual(['Microsoft'])

    expect(result._ragops_field_mappings!['/document/organizations']).toBe('dbg__ner__organizations')
    // Only 2 keys: the sourcePath + the always-added /document/content
    const mappingKeys = Object.keys(result._ragops_field_mappings!)
    expect(mappingKeys).toEqual(
      expect.arrayContaining(['/document/organizations', '/document/content']),
    )
    expect(mappingKeys).toHaveLength(2)
  })

  it('enrichmentPath covers nested subName sanitization (chunks/*/key-phrases)', () => {
    const projection = {
      chunks: [
        { key_phrases: ['phrase1', 'phrase2'] },
        { key_phrases: ['phrase3'] },
      ],
    }

    const outputsNestedSanitized = [
      {
        sourcePath: '/document/chunks/*/key_phrases',
        fieldName: 'dbg__kpe__key_phrases',
        enrichmentPath: '/document/chunks/*/key-phrases',
      },
    ]

    const result = mapProjectionToSearchResult(projection, outputsNestedSanitized)
    const doc = result.value[0]
    expect(doc['dbg__kpe__key_phrases']).toEqual([['phrase1', 'phrase2'], ['phrase3']])

    // Both sanitized blobPath and original enrichment path mapped
    expect(result._ragops_field_mappings!['/document/chunks/*/key_phrases']).toBe('dbg__kpe__key_phrases')
    expect(result._ragops_field_mappings!['/document/chunks/*/key-phrases']).toBe('dbg__kpe__key_phrases')
  })

  it('handles multiple enrichmentPath mappings across different outputs', () => {
    const projection = {
      content: 'Hello',
      pages: ['page1'],
      pages_2: [
        { keyPhrases: ['kp1'], entities: ['Microsoft'] },
      ],
    }

    const multiOutputs = [
      { sourcePath: '/document/pages', fieldName: 'dbg__split__pages' },
      {
        sourcePath: '/document/pages_2/*/keyPhrases',
        fieldName: 'dbg__kpe__keyPhrases',
        enrichmentPath: '/document/pages/*/keyPhrases',
      },
      {
        sourcePath: '/document/pages_2/*/entities',
        fieldName: 'dbg__ner__entities',
        enrichmentPath: '/document/pages/*/entities',
      },
    ]

    const result = mapProjectionToSearchResult(projection, multiOutputs)

    // All blob paths mapped
    expect(result._ragops_field_mappings!['/document/pages_2/*/keyPhrases']).toBe('dbg__kpe__keyPhrases')
    expect(result._ragops_field_mappings!['/document/pages_2/*/entities']).toBe('dbg__ner__entities')

    // All enrichment paths also mapped
    expect(result._ragops_field_mappings!['/document/pages/*/keyPhrases']).toBe('dbg__kpe__keyPhrases')
    expect(result._ragops_field_mappings!['/document/pages/*/entities']).toBe('dbg__ner__entities')

    // Non-colliding output has no extra mapping
    expect(result._ragops_field_mappings!['/document/pages']).toBe('dbg__split__pages')
  })
})
