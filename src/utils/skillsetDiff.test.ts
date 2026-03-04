import { describe, expect, it } from 'vitest'

import { computeSkillsetDiff, diffEntriesToText } from './skillsetDiff'

describe('utils/skillsetDiff', () => {
  // ─── Identical after normalisation ─────────────────────────────────────

  it('treats identical objects as identical', () => {
    const a = {
      name: 'skillset1',
      skills: [
        { '@odata.type': '#Microsoft.Skills.Text.SplitSkill', name: 'split', context: '/document', inputs: [{ name: 'text', source: '/document/content' }], outputs: [{ name: 'textItems', targetName: 'pages' }] },
      ],
    }
    const b = { ...a }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(true)
    expect(result.changes).toHaveLength(0)
  })

  it('ignores key ordering differences', () => {
    const a = { name: 'skillset1', description: 'desc', skills: [] }
    const b = { skills: [], description: 'desc', name: 'skillset1' }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(true)
  })

  it('ignores @odata.etag', () => {
    const a = { '@odata.etag': '"abc123"', name: 'skillset1', skills: [] }
    const b = { name: 'skillset1', skills: [] }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(true)
  })

  it('treats null vs missing as identical', () => {
    const a = { name: 'skillset1', description: null, skills: [] }
    const b = { name: 'skillset1', skills: [] }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(true)
  })

  it('treats empty arrays vs missing as identical', () => {
    const a = { name: 'skillset1', skills: [], cognitiveServices: [] as unknown[] }
    const b = { name: 'skillset1', skills: [] }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(true)
  })

  // ─── Top-level property changes ────────────────────────────────────────

  it('detects name change', () => {
    const a = { name: 'skillset1', skills: [] }
    const b = { name: 'skillset2', skills: [] }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(false)
    expect(result.changes.some((c) => c.path === 'name' && c.kind === 'changed')).toBe(true)
  })

  it('detects added description', () => {
    const a = { name: 'skillset1', skills: [] }
    const b = { name: 'skillset1', description: 'new desc', skills: [] }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(false)
    expect(result.changes.some((c) => c.path === 'description' && c.kind === 'added')).toBe(true)
  })

  it('detects removed description', () => {
    const a = { name: 'skillset1', description: 'old desc', skills: [] }
    const b = { name: 'skillset1', skills: [] }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(false)
    expect(result.changes.some((c) => c.path === 'description' && c.kind === 'removed')).toBe(true)
  })

  // ─── Skill-level changes ───────────────────────────────────────────────

  it('detects a new skill added', () => {
    const a = { name: 'skillset1', skills: [] }
    const b = {
      name: 'skillset1',
      skills: [
        { '@odata.type': '#Microsoft.Skills.Text.SplitSkill', name: 'split', context: '/document', inputs: [], outputs: [] },
      ],
    }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(false)
    expect(result.changes.some((c) => c.kind === 'skill-added' && c.skillName === 'split')).toBe(true)
  })

  it('detects a skill removed', () => {
    const a = {
      name: 'skillset1',
      skills: [
        { '@odata.type': '#Microsoft.Skills.Text.SplitSkill', name: 'split', context: '/document', inputs: [], outputs: [] },
      ],
    }
    const b = { name: 'skillset1', skills: [] }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(false)
    expect(result.changes.some((c) => c.kind === 'skill-removed' && c.skillName === 'split')).toBe(true)
  })

  it('detects a skill property change and provides children', () => {
    const a = {
      name: 'skillset1',
      skills: [
        { '@odata.type': '#Microsoft.Skills.Text.SplitSkill', name: 'split', context: '/document', maximumPageLength: 5000, inputs: [{ name: 'text', source: '/document/content' }], outputs: [{ name: 'textItems', targetName: 'pages' }] },
      ],
    }
    const b = {
      name: 'skillset1',
      skills: [
        { '@odata.type': '#Microsoft.Skills.Text.SplitSkill', name: 'split', context: '/document', maximumPageLength: 2000, inputs: [{ name: 'text', source: '/document/content' }], outputs: [{ name: 'textItems', targetName: 'pages' }] },
      ],
    }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(false)
    const skillChange = result.changes.find((c) => c.kind === 'skill-changed' && c.skillName === 'split')
    expect(skillChange).toBeDefined()
    expect(skillChange!.children).toBeDefined()
    expect(skillChange!.children!.some((c) => c.path.includes('maximumPageLength') && c.kind === 'changed')).toBe(true)
  })

  it('matches skills by name even when reordered', () => {
    const a = {
      name: 'skillset1',
      skills: [
        { '@odata.type': '#Microsoft.Skills.Text.SplitSkill', name: 'split', context: '/document', inputs: [], outputs: [] },
        { '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill', name: 'keyPhrases', context: '/document', inputs: [], outputs: [] },
      ],
    }
    const b = {
      name: 'skillset1',
      skills: [
        { '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill', name: 'keyPhrases', context: '/document', inputs: [], outputs: [] },
        { '@odata.type': '#Microsoft.Skills.Text.SplitSkill', name: 'split', context: '/document', inputs: [], outputs: [] },
      ],
    }
    const result = computeSkillsetDiff(a, b)
    // Skills are reordered but identical in content — should show reordered, not changed.
    const reorderedEntries = result.changes.filter((c) => c.kind === 'reordered')
    expect(reorderedEntries.length).toBeGreaterThanOrEqual(1)
    // No skill-changed entries
    const changedEntries = result.changes.filter((c) => c.kind === 'skill-changed')
    expect(changedEntries).toHaveLength(0)
  })

  it('handles skill input source change within a matched skill', () => {
    const a = {
      name: 'skillset1',
      skills: [
        { '@odata.type': '#Microsoft.Skills.Text.SplitSkill', name: 'split', context: '/document', inputs: [{ name: 'text', source: '/document/content' }], outputs: [{ name: 'textItems', targetName: 'pages' }] },
      ],
    }
    const b = {
      name: 'skillset1',
      skills: [
        { '@odata.type': '#Microsoft.Skills.Text.SplitSkill', name: 'split', context: '/document', inputs: [{ name: 'text', source: '/document/merged_content' }], outputs: [{ name: 'textItems', targetName: 'pages' }] },
      ],
    }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(false)
    const skillChange = result.changes.find((c) => c.kind === 'skill-changed' && c.skillName === 'split')
    expect(skillChange).toBeDefined()
    const sourceChange = skillChange!.children!.find((c) => c.path.includes('source'))
    expect(sourceChange).toBeDefined()
    expect(sourceChange!.kind).toBe('changed')
  })

  // ─── Normalised JSON output ────────────────────────────────────────────

  it('produces normalised JSON strings for side-by-side display', () => {
    const a = { name: 'skillset1', '@odata.etag': '"123"', skills: [] }
    const b = { skills: [], name: 'skillset1' }
    const result = computeSkillsetDiff(a, b)
    // Both should be identical after normalisation
    expect(result.normalizedBeforeJson).toBe(result.normalizedAfterJson)
  })

  // ─── indexProjections / knowledgeStore ──────────────────────────────────

  it('detects indexProjections changes', () => {
    const a = { name: 'skillset1', skills: [], indexProjections: { selectors: [] } }
    const b = { name: 'skillset1', skills: [], indexProjections: { selectors: [{ targetIndexName: 'chunks', parentKeyFieldName: 'parent_id', sourceContext: '/document/pages/*', mappings: [] }] } }
    const result = computeSkillsetDiff(a, b)
    expect(result.identical).toBe(false)
  })

  // ─── diffEntriesToText ─────────────────────────────────────────────────

  it('renders a human-readable text summary', () => {
    const a = { name: 'skillset1', skills: [] }
    const b = { name: 'skillset2', description: 'added', skills: [] }
    const result = computeSkillsetDiff(a, b)
    const text = diffEntriesToText(result.changes)
    expect(text).toContain('name')
    expect(text).toContain('description')
  })

  // ─── Complex real-world scenario ───────────────────────────────────────

  it('handles a realistic skillset with multiple changes', () => {
    const before = {
      '@odata.etag': '"0x1234"',
      name: 'my-skillset',
      description: 'Original description',
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
          name: 'splitText',
          context: '/document',
          textSplitMode: 'pages',
          maximumPageLength: 5000,
          pageOverlapLength: 0,
          defaultLanguageCode: 'en',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [{ name: 'textItems', targetName: 'pages' }],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
          name: 'keyPhrases',
          context: '/document/pages/*',
          defaultLanguageCode: 'en',
          inputs: [{ name: 'text', source: '/document/pages/*' }],
          outputs: [{ name: 'keyPhrases', targetName: 'keyPhrases' }],
        },
      ],
      indexProjections: null,
      knowledgeStore: null,
    }

    const after = {
      name: 'my-skillset',
      description: 'Updated description',
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
          name: 'splitText',
          context: '/document',
          textSplitMode: 'pages',
          maximumPageLength: 2000,  // changed
          pageOverlapLength: 500,   // changed
          defaultLanguageCode: 'en',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [{ name: 'textItems', targetName: 'pages' }],
        },
        // keyPhrases removed
        // New embedding skill added
        {
          '@odata.type': '#Microsoft.Skills.Custom.AmlSkill',
          name: 'embedding',
          context: '/document/pages/*',
          inputs: [{ name: 'text', source: '/document/pages/*' }],
          outputs: [{ name: 'embedding', targetName: 'vector' }],
        },
      ],
    }

    const result = computeSkillsetDiff(before, after)
    expect(result.identical).toBe(false)

    // description changed
    expect(result.changes.some((c) => c.path === 'description' && c.kind === 'changed')).toBe(true)

    // splitText skill changed (maximumPageLength, pageOverlapLength)
    const splitChange = result.changes.find((c) => c.kind === 'skill-changed' && c.skillName === 'splitText')
    expect(splitChange).toBeDefined()

    // keyPhrases skill removed
    expect(result.changes.some((c) => c.kind === 'skill-removed' && c.skillName === 'keyPhrases')).toBe(true)

    // embedding skill added
    expect(result.changes.some((c) => c.kind === 'skill-added' && c.skillName === 'embedding')).toBe(true)

    // @odata.etag should NOT appear in changes
    expect(result.changes.every((c) => !c.path.includes('@odata.etag'))).toBe(true)
  })
})
