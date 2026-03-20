import { describe, expect, it } from 'vitest'

import { computeIndexDiff } from './indexDiff'

describe('utils/indexDiff', () => {
  // ─── Identical after normalisation ─────────────────────────────────────

  it('treats identical index objects as identical', () => {
    const a = {
      name: 'my-index',
      fields: [
        { name: 'id', type: 'Edm.String', key: true },
        { name: 'content', type: 'Edm.String', searchable: true },
      ],
    }
    const result = computeIndexDiff(a, { ...a })
    expect(result.identical).toBe(true)
    expect(result.changes).toHaveLength(0)
  })

  it('ignores key ordering differences', () => {
    const a = { name: 'my-index', fields: [{ name: 'id', type: 'Edm.String' }] }
    const b = { fields: [{ type: 'Edm.String', name: 'id' }], name: 'my-index' }
    const result = computeIndexDiff(a, b)
    expect(result.identical).toBe(true)
  })

  it('ignores @odata.etag', () => {
    const a = { '@odata.etag': '"abc"', name: 'idx', fields: [] }
    const b = { name: 'idx', fields: [] }
    const result = computeIndexDiff(a, b)
    expect(result.identical).toBe(true)
  })

  it('treats null vs missing as identical', () => {
    const a = { name: 'idx', fields: [], scoringProfiles: null as unknown }
    const b = { name: 'idx', fields: [] }
    const result = computeIndexDiff(a, b)
    expect(result.identical).toBe(true)
  })

  // ─── Top-level changes ─────────────────────────────────────────────────

  it('detects name change', () => {
    const a = { name: 'idx-old', fields: [] }
    const b = { name: 'idx-new', fields: [] }
    const result = computeIndexDiff(a, b)
    expect(result.identical).toBe(false)
    expect(result.changes.some((c) => c.path === 'name' && c.kind === 'changed')).toBe(true)
  })

  it('detects added semantic configuration', () => {
    const a = { name: 'idx', fields: [] }
    const b = {
      name: 'idx',
      fields: [],
      semantic: {
        configurations: [
          { name: 'default', prioritizedFields: { contentFields: [{ fieldName: 'content' }] } },
        ],
      },
    }
    const result = computeIndexDiff(a, b)
    expect(result.identical).toBe(false)
    expect(result.changes.some((c) => c.path.startsWith('semantic') && c.kind === 'added')).toBe(true)
  })

  // ─── Field-level changes (named array matching) ────────────────────────

  it('detects a new field added', () => {
    const a = { name: 'idx', fields: [{ name: 'id', type: 'Edm.String', key: true }] }
    const b = {
      name: 'idx',
      fields: [
        { name: 'id', type: 'Edm.String', key: true },
        { name: 'content', type: 'Edm.String', searchable: true },
      ],
    }
    const result = computeIndexDiff(a, b)
    expect(result.identical).toBe(false)
    expect(result.changes.some((c) => c.kind === 'item-added' && c.skillName === 'content')).toBe(true)
  })

  it('detects a field removed', () => {
    const a = {
      name: 'idx',
      fields: [
        { name: 'id', type: 'Edm.String', key: true },
        { name: 'content', type: 'Edm.String' },
      ],
    }
    const b = { name: 'idx', fields: [{ name: 'id', type: 'Edm.String', key: true }] }
    const result = computeIndexDiff(a, b)
    expect(result.identical).toBe(false)
    expect(result.changes.some((c) => c.kind === 'item-removed' && c.skillName === 'content')).toBe(true)
  })

  it('detects a field property change and provides children', () => {
    const a = {
      name: 'idx',
      fields: [{ name: 'content', type: 'Edm.String', searchable: true, retrievable: true }],
    }
    const b = {
      name: 'idx',
      fields: [{ name: 'content', type: 'Edm.String', searchable: true, retrievable: false }],
    }
    const result = computeIndexDiff(a, b)
    expect(result.identical).toBe(false)
    const fieldChange = result.changes.find((c) => c.kind === 'item-changed' && c.skillName === 'content')
    expect(fieldChange).toBeDefined()
    expect(fieldChange!.children).toBeDefined()
    expect(fieldChange!.children!.some((c) => c.path.includes('retrievable') && c.kind === 'changed')).toBe(true)
  })

  it('matches fields by name even when reordered', () => {
    const a = {
      name: 'idx',
      fields: [
        { name: 'id', type: 'Edm.String', key: true },
        { name: 'content', type: 'Edm.String' },
      ],
    }
    const b = {
      name: 'idx',
      fields: [
        { name: 'content', type: 'Edm.String' },
        { name: 'id', type: 'Edm.String', key: true },
      ],
    }
    const result = computeIndexDiff(a, b)
    const reordered = result.changes.filter((c) => c.kind === 'reordered')
    expect(reordered.length).toBeGreaterThanOrEqual(1)
    const fieldChanged = result.changes.filter((c) => c.kind === 'item-changed')
    expect(fieldChanged).toHaveLength(0)
  })

  // ─── Scoring profiles (another named array) ───────────────────────────

  it('detects scoring profile changes', () => {
    const a = {
      name: 'idx',
      fields: [],
      scoringProfiles: [
        { name: 'boost1', text: { weights: { content: 5 } } },
      ],
    }
    const b = {
      name: 'idx',
      fields: [],
      scoringProfiles: [
        { name: 'boost1', text: { weights: { content: 10 } } },
      ],
    }
    const result = computeIndexDiff(a, b)
    expect(result.identical).toBe(false)
    const profileChange = result.changes.find((c) => c.kind === 'item-changed' && c.skillName === 'boost1')
    expect(profileChange).toBeDefined()
  })

  // ─── Normalised JSON output ────────────────────────────────────────────

  it('produces normalised JSON strings for side-by-side display', () => {
    const a = { '@odata.etag': '"123"', name: 'idx', fields: [] }
    const b = { fields: [], name: 'idx' }
    const result = computeIndexDiff(a, b)
    expect(result.normalizedBeforeJson).toBe(result.normalizedAfterJson)
  })

  // ─── Real-world index scenario ─────────────────────────────────────────

  it('handles a realistic index with multiple changes', () => {
    const before = {
      '@odata.etag': '"0xABCD"',
      name: 'my-search-index',
      fields: [
        { name: 'id', type: 'Edm.String', key: true, searchable: false, filterable: true, sortable: true },
        { name: 'content', type: 'Edm.String', searchable: true, filterable: false },
        { name: 'title', type: 'Edm.String', searchable: true },
      ],
      scoringProfiles: [],
      semantic: null as unknown,
    }

    const after = {
      name: 'my-search-index',
      fields: [
        { name: 'id', type: 'Edm.String', key: true, searchable: false, filterable: true, sortable: true },
        { name: 'content', type: 'Edm.String', searchable: true, filterable: false, retrievable: true },  // added retrievable
        // title removed
        { name: 'embedding', type: 'Collection(Edm.Single)', searchable: true },  // new field
      ],
      semantic: {
        configurations: [{ name: 'default', prioritizedFields: { contentFields: [{ fieldName: 'content' }] } }],
      },
    }

    const result = computeIndexDiff(before, after)
    expect(result.identical).toBe(false)

    // Field added
    expect(result.changes.some((c) => c.kind === 'item-added' && c.skillName === 'embedding')).toBe(true)
    // Field removed
    expect(result.changes.some((c) => c.kind === 'item-removed' && c.skillName === 'title')).toBe(true)
    // Field changed (content gained retrievable)
    expect(result.changes.some((c) => c.kind === 'item-changed' && c.skillName === 'content')).toBe(true)
    // Semantic config added
    expect(result.changes.some((c) => c.path.startsWith('semantic'))).toBe(true)
  })
})
