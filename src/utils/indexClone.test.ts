import { describe, expect, it } from 'vitest'

import type { JsonObject } from '../app/json'

import {
  buildCloneFieldPlan,
  buildIndexDocumentsPayload,
  cloneIndexDefinition,
  countIndexingFailures,
  countIndexingSuccesses,
  getIndexKeyFieldName,
  getRetrievableFieldNames,
  getRetryableIndexingFailureKeys,
} from './indexClone'

describe('utils/indexClone', () => {
  const sourceDefinition: JsonObject = {
    name: 'source-index',
    fields: [
      { name: 'id', type: 'Edm.String', key: true },
      { name: 'title', type: 'Edm.String', searchable: true },
      { name: 'contentVector', type: 'Collection(Edm.Single)', retrievable: false },
      { name: 'legacyOnly', type: 'Edm.String' },
    ],
  }

  it('clones an index definition with a new name', () => {
    const cloned = cloneIndexDefinition(sourceDefinition, 'target-index')
    expect(cloned).toMatchObject({ name: 'target-index' })
    expect(sourceDefinition.name).toBe('source-index')
  })

  it('finds key and retrievable fields', () => {
    expect(getIndexKeyFieldName(sourceDefinition)).toBe('id')
    expect(getRetrievableFieldNames(sourceDefinition)).toEqual(['id', 'title', 'legacyOnly'])
  })

  it('builds a clone copy field plan', () => {
    const targetDefinition: JsonObject = {
      name: 'target-index',
      fields: [
        { name: 'id', type: 'Edm.String', key: true },
        { name: 'title', type: 'Edm.String', searchable: true },
        { name: 'newField', type: 'Edm.String' },
      ],
    }

    const plan = buildCloneFieldPlan(sourceDefinition, targetDefinition)
    expect(plan.keyFieldName).toBe('id')
    expect(plan.copyFieldNames).toEqual(['id', 'title'])
    expect(plan.skippedSourceFieldNames).toEqual(['contentVector'])
    expect(plan.missingTargetFieldNames).toEqual(['legacyOnly'])
  })

  it('projects search results into index upload payloads', () => {
    const payload = buildIndexDocumentsPayload(
      [
        {
          '@search.score': 1,
          id: '1',
          title: 'Hello',
          legacyOnly: 'skip me',
        },
      ],
      ['id', 'title'],
    )

    expect(payload).toEqual({
      value: [
        {
          '@search.action': 'upload',
          id: '1',
          title: 'Hello',
        },
      ],
    })
  })

  it('counts indexing result successes and failures', () => {
    const response: JsonObject = {
      value: [
        { key: '1', succeeded: true },
        { key: '2', succeeded: false, errorMessage: 'bad' },
      ],
    }

    expect(countIndexingFailures(response)).toBe(1)
    expect(countIndexingSuccesses(response, 2)).toBe(1)
    expect(countIndexingSuccesses({}, 3)).toBe(3)
  })

  it('finds retryable indexing failure keys', () => {
    const response: JsonObject = {
      value: [
        { key: '1', succeeded: true, statusCode: 200 },
        { key: '2', succeeded: false, statusCode: 429, errorMessage: 'throttled' },
        { key: '3', succeeded: false, statusCode: 400, errorMessage: 'bad document' },
        { key: '4', succeeded: false, statusCode: 503, errorMessage: 'busy' },
      ],
    }

    expect(getRetryableIndexingFailureKeys(response)).toEqual(['2', '4'])
  })
})
