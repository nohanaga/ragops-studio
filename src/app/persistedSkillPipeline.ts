import type { SkillPipelineEdge, SkillPipelineNode } from '../contexts'

export type PersistedSkillPipelineState = {
  skillsetName: string
  skillsetDescription: string
  indexProjections?: unknown | null
  knowledgeStore?: unknown | null
  indexer?: unknown | null
  nodes: SkillPipelineNode[]
  edges: SkillPipelineEdge[]
}

export type PersistedSkillPipelineItem = {
  id: string
  title: string
  updatedAt: number
  state: PersistedSkillPipelineState
}

const STORAGE_KEY = 'ragops.skillPipeline.v1'

type PersistedRoot = {
  items: PersistedSkillPipelineItem[]
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
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return { items: [] }

  const parsed = safeParse(raw)
  if (!isRecord(parsed)) return { items: [] }

  const items = parsed.items
  if (!Array.isArray(items)) return { items: [] }

  // We intentionally avoid deep validation; corrupted records are dropped.
  const normalized = items
    .map((x: unknown): PersistedSkillPipelineItem | null => {
      if (!isRecord(x)) return null
      if (typeof x.id !== 'string') return null
      if (typeof x.title !== 'string') return null
      if (typeof x.updatedAt !== 'number') return null
      if (!isRecord(x.state)) return null

      return x as unknown as PersistedSkillPipelineItem
    })
    .filter((x): x is PersistedSkillPipelineItem => x !== null)

  return { items: normalized }
}

function writeRoot(root: PersistedRoot) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(root))
}

export function listSkillPipelines(): PersistedSkillPipelineItem[] {
  const root = readRoot()
  return [...root.items].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function upsertSkillPipeline(item: PersistedSkillPipelineItem) {
  const root = readRoot()
  const idx = root.items.findIndex((x) => x.id === item.id)
  const next = { ...item, updatedAt: Date.now() }

  if (idx >= 0) {
    root.items[idx] = next
  } else {
    root.items.unshift(next)
  }

  writeRoot(root)
}

export function deleteSkillPipeline(id: string) {
  const root = readRoot()
  root.items = root.items.filter((x) => x.id !== id)
  writeRoot(root)
}

export function getSkillPipeline(id: string): PersistedSkillPipelineItem | null {
  const root = readRoot()
  return root.items.find((x) => x.id === id) ?? null
}
