import { describe, expect, it } from 'vitest'
import { parseActivity, type ActivityItem } from './agenticActivityGraph'
import { buildActivityTiming } from './agenticActivityTiming'
import type { JsonValue } from './aiSearchRest'

function items(raw: JsonValue[]): ActivityItem[] {
  return raw.map(parseActivity).filter((item): item is ActivityItem => item !== null)
}

describe('buildActivityTiming', () => {
  it('uses startedAt/completedAt even when elapsedMs and queryTime report different values', () => {
    const timing = buildActivityTiming(items([
      { type: 'modelQueryPlanning', id: 0, elapsedMs: 50 },
      { type: 'searchIndex', id: 1, startedAt: '2026-10-22T00:00:00.000Z', completedAt: '2026-10-22T00:00:00.100Z', elapsedMs: 9999, queryTime: '2000-01-01T00:00:00Z' },
      { type: 'web', id: 2, startedAt: '2026-10-22T00:00:00.050Z', completedAt: '2026-10-22T00:00:00.150Z', elapsedMs: 1 },
    ]))
    expect(timing.originMs).toBe(Date.parse('2026-10-22T00:00:00Z'))
    expect(timing.spanMs).toBe(150)
    expect(timing.workMs).toBe(200)
    expect(timing.timedRows.map((row) => row.overlaps)).toEqual([true, true])
    expect(timing.unplacedRows).toHaveLength(1)
    expect(timing.unplacedRows[0].durationMs).toBeNull()
    expect(timing.timedRows[1].startMs! - timing.originMs!).toBe(50)
  })

  it('does not treat touching or zero-duration intervals as overlapping', () => {
    const timing = buildActivityTiming(items([
      { type: 'searchIndex', id: 1, startedAt: '2026-10-22T00:00:00Z', completedAt: '2026-10-22T00:00:00.100Z' },
      { type: 'web', id: 2, startedAt: '2026-10-22T00:00:00.100Z', completedAt: '2026-10-22T00:00:00.150Z' },
      { type: 'web', id: 3, startedAt: '2026-10-22T00:00:00.050Z', completedAt: '2026-10-22T00:00:00.050Z' },
    ]))
    expect(timing.rows.every((row) => !row.overlaps)).toBe(true)
    expect(timing.rows[2].durationMs).toBe(0)
  })

  it('retains known starts without inventing a duration for running actions', () => {
    const timing = buildActivityTiming(items([{ type: 'web', id: 1, startedAt: '2026-10-22T00:00:00Z', elapsedMs: 100 }]))
    expect(timing.timedRows[0].durationMs).toBeNull()
    expect(timing.timedRows[0].endMs).toBeNull()
    expect(timing.spanMs).toBe(0)
    expect(timing.rows[0].overlaps).toBe(false)
  })

  it('does not infer times from elapsedMs/queryTime and flags invalid or reversed timestamps', () => {
    const timing = buildActivityTiming(items([
      { type: 'modelQueryPlanning', id: 1, elapsedMs: 40, queryTime: '2026-10-22T00:00:00Z' },
      { type: 'web', id: 2, startedAt: 'invalid', completedAt: '2026-10-22T00:00:00Z' },
      { type: 'agenticReasoning', id: 3, startedAt: '2026-10-22T00:00:01Z', completedAt: '2026-10-22T00:00:00Z' },
    ]))
    expect(timing.timedRows).toEqual([])
    expect(timing.originMs).toBeNull()
    expect(timing.unplacedRows).toHaveLength(3)
    expect(timing.unplacedRows.map((row) => row.durationMs)).toEqual([null, null, null])
    expect(timing.rows.map((row) => row.invalidTimes)).toEqual([false, true, true])
    expect(timing.workMs).toBe(0)
  })

  it('keeps a completion-only timestamp as a point without inventing its start', () => {
    const timing = buildActivityTiming(items([{ type: 'web', id: 1, completedAt: '2026-10-22T00:00:00Z', elapsedMs: 100 }]))
    expect(timing.timedRows[0].startMs).toBeNull()
    expect(timing.timedRows[0].durationMs).toBeNull()
    expect(timing.originMs).toBe(Date.parse('2026-10-22T00:00:00Z'))
    expect(timing.spanMs).toBe(0)
  })

  it('returns an empty model without generated actions or timing', () => {
    const timing = buildActivityTiming([])
    expect(timing.rows).toEqual([])
    expect(timing.originMs).toBeNull()
    expect(timing.spanMs).toBe(0)
  })
})
