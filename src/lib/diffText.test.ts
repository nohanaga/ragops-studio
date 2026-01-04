import { describe, expect, it } from 'vitest'

import { unifiedDiff } from './diffText'

describe('lib/diffText', () => {
  it('produces a unified diff with file headers and hunks', () => {
    const out = unifiedDiff({
      aName: 'a.json',
      bName: 'b.json',
      aText: '{"a":1}\n',
      bText: '{"a":2}\n',
      context: 1,
    })

    expect(out).toContain('--- a.json')
    expect(out).toContain('+++ b.json')
    expect(out).toContain('@@')
    expect(out).toContain('-{"a":1}')
    expect(out).toContain('+{"a":2}')
  })
})
