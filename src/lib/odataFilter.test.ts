/**
 * Tests for the lightweight OData $filter parser/serializer.
 *
 * Focuses on round-trip stability (parse → serialize → parse) and common edge
 * cases for interactive editing.
 */

import { describe, expect, it } from 'vitest'
import { parseODataFilter, serializeODataFilter } from './odataFilter'

function expectRoundtrip(input: string) {
  const first = parseODataFilter(input)
  expect(first.ok, `parse failed: ${input}${first.ok ? '' : `\n${first.error}`}`).toBe(true)
  if (!first.ok) return

  const canonical = serializeODataFilter(first.expr)

  const second = parseODataFilter(canonical)
  expect(second.ok, `re-parse failed: ${canonical}${second.ok ? '' : `\n${second.error}`}`).toBe(true)
  if (!second.ok) return

  expect(serializeODataFilter(second.expr)).toBe(canonical)
}

describe('odataFilter parse/serialize', () => {
  it('treats empty filter as true', () => {
    const r = parseODataFilter('   ')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(serializeODataFilter(r.expr)).toBe('true')
  })

  it('roundtrips basic comparisons and boolean ops', () => {
    expectRoundtrip("name eq 'abc'")
    expectRoundtrip('price gt 10')
    expectRoundtrip("name eq 'abc' and price gt 10")
    expectRoundtrip("name eq 'abc' or price gt 10 and category eq 'books'")
  })

  it('preserves parentheses for precedence changes', () => {
    expectRoundtrip("(a eq 1 or b eq 2) and c eq 3")
    expectRoundtrip("not (a eq 1)")
  })

  it("handles escaped single quotes in string literals", () => {
    expectRoundtrip("name eq 'O''Reilly'")
  })

  it('handles function calls', () => {
    expectRoundtrip("startswith(name, 'A')")
    expectRoundtrip("search.ismatch('foo', 'content')")
  })

  it('handles lambda any/all (including empty)', () => {
    expectRoundtrip('tags/any()')
    expectRoundtrip("tags/any(t: t eq 'x')")
    expectRoundtrip("orders/all(o: o/price ge 10)")
  })

  it('handles datetime and geography literals', () => {
    expectRoundtrip('created ge 2010-01-01T00:00:00Z')
    expectRoundtrip("location eq geography'POINT(-122.131577 47.678581)'")
  })

  it('fails gracefully on obviously invalid input', () => {
    const r1 = parseODataFilter('a eq')
    expect(r1.ok).toBe(false)

    const r2 = parseODataFilter('a eq 1)')
    expect(r2.ok).toBe(false)
  })
})
