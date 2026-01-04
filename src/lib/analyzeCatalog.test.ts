import { describe, expect, it } from 'vitest'

import {
  ANALYZE_ANALYZERS,
  ANALYZE_BUILT_IN_ANALYZERS,
  ANALYZE_CHAR_FILTERS,
  ANALYZE_NORMALIZERS,
  ANALYZE_TOKENIZERS,
} from './analyzeCatalog'

describe('lib/analyzeCatalog', () => {
  it('exports non-empty constant lists with expected well-known values', () => {
    expect(ANALYZE_BUILT_IN_ANALYZERS.length).toBeGreaterThan(0)
    expect(ANALYZE_BUILT_IN_ANALYZERS).toContain('standard')
    expect(ANALYZE_BUILT_IN_ANALYZERS).toContain('standard.lucene')

    expect(ANALYZE_ANALYZERS.length).toBeGreaterThanOrEqual(ANALYZE_BUILT_IN_ANALYZERS.length)
    expect(ANALYZE_ANALYZERS).toContain('ja.microsoft')

    expect(ANALYZE_CHAR_FILTERS).toContain('html_strip')
    expect(ANALYZE_TOKENIZERS).toContain('standard_v2')
    expect(ANALYZE_NORMALIZERS).toContain('lowercase')
  })
})
