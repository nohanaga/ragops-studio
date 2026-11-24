/**
 * Loads the definitions needed by the dependency map: indexes, knowledge sources and knowledge bases.
 *
 * A failed or unsupported resource list never fails the whole load. The error is returned
 * so the map can still show the part of the chain that could be read.
 */

import {
  getKnowledgeBase,
  getKnowledgeSource,
  listIndexes,
  listKnowledgeBases,
  listKnowledgeSources,
  type RestResult,
} from './aiSearchRest'
import type { DependencySnapshot } from './indexDependencies'
import type { ConnectionProfile, SearchApiVersion } from './model'
import type { Language } from './translations'

export type DependencyResource = 'indexes' | 'knowledgeSources' | 'knowledgeBases'
export type DependencyLoadError = { resource: DependencyResource; message: string }

export type DependencySnapshotResult = {
  snapshot: DependencySnapshot
  errors: DependencyLoadError[]
  /** Definitions that were not completed because the number of detail requests is capped. */
  skippedDetails: number
}

export const MAX_DETAIL_REQUESTS = 100
const DETAIL_CONCURRENCY = 5

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function loadList(resource: DependencyResource, load: () => Promise<RestResult>): Promise<{ items: JsonRecord[]; error?: DependencyLoadError }> {
  try {
    const result = await load()
    if (!result.ok) return { items: [], error: { resource, message: result.error.message } }
    const value = isRecord(result.response) ? result.response.value : undefined
    return { items: Array.isArray(value) ? (value as unknown[]).filter(isRecord) : [] }
  } catch (error) {
    return { items: [], error: { resource, message: errorMessage(error) } }
  }
}

async function loadDetail(resource: DependencyResource, load: () => Promise<RestResult>): Promise<{ item?: JsonRecord; error?: DependencyLoadError }> {
  try {
    const result = await load()
    if (!result.ok) return { error: { resource, message: result.error.message } }
    return isRecord(result.response) ? { item: result.response } : {}
  } catch (error) {
    return { error: { resource, message: errorMessage(error) } }
  }
}

async function mapWithLimit<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const position = next
      next += 1
      await task(items[position])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** Without cursor paging the list API returns only names, so the definitions are read one by one. */
const hasSourceDetails = (source: JsonRecord): boolean => Object.keys(source).some((key) => key.endsWith('Parameters'))
const hasBaseDetails = (base: JsonRecord): boolean => Array.isArray(base.knowledgeSources)

async function completeDefinitions(input: {
  resource: 'knowledgeSources' | 'knowledgeBases'
  items: JsonRecord[]
  isComplete: (item: JsonRecord) => boolean
  budget: { remaining: number }
  fetchOne: (name: string) => Promise<RestResult>
  errors: DependencyLoadError[]
}): Promise<{ items: JsonRecord[]; skipped: number }> {
  const incomplete = input.items.filter((item) => typeof item.name === 'string' && !input.isComplete(item))
  const selected = incomplete.slice(0, input.budget.remaining)
  input.budget.remaining -= selected.length

  const details = new Map<string, JsonRecord>()
  await mapWithLimit(selected, DETAIL_CONCURRENCY, async (item) => {
    const name = item.name as string
    const detail = await loadDetail(input.resource, () => input.fetchOne(name))
    if (detail.item) details.set(name, detail.item)
    if (detail.error) input.errors.push(detail.error)
  })

  return {
    items: input.items.map((item) => (typeof item.name === 'string' ? details.get(item.name) ?? item : item)),
    skipped: incomplete.length - selected.length,
  }
}

export async function loadDependencySnapshot(input: {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  language: Language
  signal?: AbortSignal
}): Promise<DependencySnapshotResult> {
  const { profile, apiVersion, language, signal } = input
  const [indexes, sources, bases] = await Promise.all([
    loadList('indexes', () => listIndexes({ profile, apiVersion, language, signal })),
    loadList('knowledgeSources', () => listKnowledgeSources({ profile, language, signal })),
    loadList('knowledgeBases', () => listKnowledgeBases({ profile, language })),
  ])
  const errors = [indexes.error, sources.error, bases.error].filter((error): error is DependencyLoadError => error !== undefined)
  const budget = { remaining: MAX_DETAIL_REQUESTS }

  const completedSources = await completeDefinitions({
    resource: 'knowledgeSources',
    items: sources.items,
    isComplete: hasSourceDetails,
    budget,
    fetchOne: (name) => getKnowledgeSource({ profile, knowledgeSourceName: name, language }),
    errors,
  })
  const completedBases = await completeDefinitions({
    resource: 'knowledgeBases',
    items: bases.items,
    isComplete: hasBaseDetails,
    budget,
    fetchOne: (name) => getKnowledgeBase({ profile, knowledgeBaseName: name, language }),
    errors,
  })

  return {
    snapshot: { indexes: indexes.items, knowledgeSources: completedSources.items, knowledgeBases: completedBases.items },
    errors,
    skippedDetails: completedSources.skipped + completedBases.skipped,
  }
}
