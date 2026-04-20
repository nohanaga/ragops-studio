// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import {
  deleteEvalDataset,
  getEvalDataset,
  listEvalDatasets,
  newEvalDatasetId,
  upsertEvalDataset,
} from './persistedEvalDatasets'
import type { GeneratedQAItem } from '../types'

function sample(query: string): GeneratedQAItem {
  return {
    query,
    expected_ids: ['doc-1'],
    source_doc_id: 'doc-1',
    generation_model: 'gpt-x',
    language: 'en',
    provenance: 'synthetic',
    generated_at: '2026-04-20T00:00:00.000Z',
  }
}

describe('app/persistedEvalDatasets', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns empty list initially', () => {
    expect(listEvalDatasets()).toEqual([])
  })

  it('upsert creates and updates entries; itemCount derived from items.length', () => {
    upsertEvalDataset({
      id: 'eds-1',
      title: 'first',
      updatedAt: 0,
      indexName: 'idx-a',
      itemCount: 0,
      items: [sample('q1'), sample('q2')],
    })
    const list = listEvalDatasets()
    expect(list).toHaveLength(1)
    expect(list[0].itemCount).toBe(2)
    expect(list[0].title).toBe('first')

    upsertEvalDataset({
      id: 'eds-1',
      title: 'first-updated',
      updatedAt: 0,
      itemCount: 0,
      items: [sample('q1')],
    })
    const list2 = listEvalDatasets()
    expect(list2).toHaveLength(1)
    expect(list2[0].title).toBe('first-updated')
    expect(list2[0].itemCount).toBe(1)
  })

  it('list sorts by updatedAt desc', () => {
    upsertEvalDataset({ id: 'a', title: 'a', updatedAt: 0, itemCount: 0, items: [sample('q')] })
    // Tiny pause via different ids; updatedAt is set inside upsert.
    upsertEvalDataset({ id: 'b', title: 'b', updatedAt: 0, itemCount: 0, items: [sample('q')] })
    const list = listEvalDatasets()
    expect(list[0].id).toBe('b')
    expect(list[1].id).toBe('a')
  })

  it('get retrieves by id; delete removes', () => {
    upsertEvalDataset({ id: 'x', title: 'x', updatedAt: 0, itemCount: 0, items: [sample('q')] })
    expect(getEvalDataset('x')?.id).toBe('x')
    deleteEvalDataset('x')
    expect(getEvalDataset('x')).toBeNull()
  })

  it('newEvalDatasetId returns prefixed unique-ish id', () => {
    const a = newEvalDatasetId()
    const b = newEvalDatasetId()
    expect(a).toMatch(/^eds-/)
    expect(a).not.toBe(b)
  })

  it('drops corrupted entries on read', () => {
    localStorage.setItem(
      'ragops.evalDatasets.v1',
      JSON.stringify({ items: [{ id: 'ok', title: 't', updatedAt: 1, items: [] }, { broken: true }] }),
    )
    const list = listEvalDatasets()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('ok')
  })
})
