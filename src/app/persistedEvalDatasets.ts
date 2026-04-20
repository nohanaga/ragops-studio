/**
 * Persistence layer for generated eval datasets (Phase 3).
 * Stores in localStorage so the user can save / load / reuse synthetic
 * datasets across sessions and ship them to AutoTuning without a manual
 * download/upload round-trip.
 *
 * Pattern follows {@link ./persistedSkillPipeline.ts}.
 */

import type { GeneratedQAItem } from '../types'

export type PersistedEvalDatasetItem = {
  id: string
  title: string
  updatedAt: number
  /** Source index name at generation time (informational). */
  indexName?: string
  /** Total kept items (== `items.length`). Cached for list rendering. */
  itemCount: number
  items: GeneratedQAItem[]
}

const STORAGE_KEY = 'ragops.evalDatasets.v1'

type PersistedRoot = {
  items: PersistedEvalDatasetItem[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function readRoot(): PersistedRoot {
  if (typeof localStorage === 'undefined') return { items: [] }
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return { items: [] }

  const parsed = safeParse(raw)
  if (!isRecord(parsed)) return { items: [] }

  const items = parsed.items
  if (!Array.isArray(items)) return { items: [] }

  const normalized = items
    .map((x: unknown): PersistedEvalDatasetItem | null => {
      if (!isRecord(x)) return null
      if (typeof x.id !== 'string') return null
      if (typeof x.title !== 'string') return null
      if (typeof x.updatedAt !== 'number') return null
      if (!Array.isArray(x.items)) return null
      const itemCount = typeof x.itemCount === 'number' ? x.itemCount : x.items.length
      return {
        id: x.id,
        title: x.title,
        updatedAt: x.updatedAt,
        indexName: typeof x.indexName === 'string' ? x.indexName : undefined,
        itemCount,
        items: x.items as GeneratedQAItem[],
      }
    })
    .filter((x): x is PersistedEvalDatasetItem => x !== null)

  return { items: normalized }
}

function writeRoot(root: PersistedRoot) {
  if (typeof localStorage === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(root))
}

export function listEvalDatasets(): PersistedEvalDatasetItem[] {
  const root = readRoot()
  return [...root.items].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function upsertEvalDataset(item: PersistedEvalDatasetItem) {
  const root = readRoot()
  const idx = root.items.findIndex((x) => x.id === item.id)
  const next: PersistedEvalDatasetItem = {
    ...item,
    itemCount: item.items.length,
    updatedAt: Date.now(),
  }

  if (idx >= 0) {
    root.items[idx] = next
  } else {
    root.items.unshift(next)
  }

  writeRoot(root)
}

export function deleteEvalDataset(id: string) {
  const root = readRoot()
  root.items = root.items.filter((x) => x.id !== id)
  writeRoot(root)
}

export function getEvalDataset(id: string): PersistedEvalDatasetItem | null {
  const root = readRoot()
  return root.items.find((x) => x.id === id) ?? null
}

/** Convenience: build a stable id (timestamp + random suffix). */
export function newEvalDatasetId(): string {
  const ts = Date.now().toString(36)
  const rnd = Math.random().toString(36).slice(2, 8)
  return `eds-${ts}-${rnd}`
}
