import { LAST_VIEWED_RUN_ID_KEY } from './constants'

export function loadLastViewedRunId(): string | null {
  try {
    const raw = localStorage.getItem(LAST_VIEWED_RUN_ID_KEY)
    const value = typeof raw === 'string' ? raw.trim() : ''
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

export function saveLastViewedRunId(runId: string): void {
  try {
    const value = String(runId ?? '').trim()
    if (!value) return
    localStorage.setItem(LAST_VIEWED_RUN_ID_KEY, value)
  } catch {
    // ignore
  }
}

export function clearLastViewedRunId(): void {
  try {
    localStorage.removeItem(LAST_VIEWED_RUN_ID_KEY)
  } catch {
    // ignore
  }
}
