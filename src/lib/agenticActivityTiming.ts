import type { ActivityItem } from './agenticActivityGraph'

export type ActivityTimingRow = {
  id: string
  item: ActivityItem
  startMs: number | null
  durationMs: number | null
  endMs: number | null
  invalidTimes: boolean
  overlaps: boolean
}

export function parseActivityTimestamps(item: Pick<ActivityItem, 'startedAt' | 'completedAt'>) {
  const start = item.startedAt === undefined ? NaN : Date.parse(item.startedAt)
  const end = item.completedAt === undefined ? NaN : Date.parse(item.completedAt)
  const startMs = Number.isFinite(start) ? start : null
  const endMs = Number.isFinite(end) ? end : null
  const invalidTimes = (item.startedAt !== undefined && startMs === null)
    || (item.completedAt !== undefined && endMs === null)
    || (startMs !== null && endMs !== null && endMs < startMs)
  return {
    startMs, endMs, invalidTimes,
    durationMs: !invalidTimes && startMs !== null && endMs !== null ? endMs - startMs : null,
  }
}

export function buildActivityTiming(items: ActivityItem[]) {
  const rows: ActivityTimingRow[] = items.map((item, index) => ({
    id: `activity-${index}`, item, ...parseActivityTimestamps(item), overlaps: false,
  }))
  for (const row of rows) {
    if (row.invalidTimes || row.startMs === null || row.endMs === null || row.durationMs === 0) continue
    const { startMs, endMs } = row
    row.overlaps = rows.some((other) => (
      other !== row && !other.invalidTimes && other.startMs !== null && other.endMs !== null && other.durationMs !== 0
      && startMs < other.endMs && endMs > other.startMs
    ))
  }
  const timedRows = rows.filter((row) => !row.invalidTimes && (row.startMs !== null || row.endMs !== null))
  const unplacedRows = rows.filter((row) => !timedRows.includes(row))
  const timestamps = timedRows.flatMap((row) => [row.startMs, row.endMs].filter((value): value is number => value !== null))
  const originMs = timestamps.length > 0 ? Math.min(...timestamps) : null
  const spanMs = originMs !== null ? Math.max(...timestamps) - originMs : 0
  return {
    rows, timedRows, unplacedRows, originMs, spanMs,
    workMs: rows.reduce((sum, row) => sum + (row.durationMs ?? 0), 0),
  }
}
