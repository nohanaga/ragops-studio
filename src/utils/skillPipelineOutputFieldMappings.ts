/**
 * Skill pipeline - outputFieldMappings helpers.
 *
 * outputFieldMappings are used in AI enrichment scenarios to map
 * enriched document nodes (sourceFieldName) to index fields (targetFieldName).
 * https://learn.microsoft.com/azure/search/cognitive-search-output-field-mapping
 */

export type OutputFieldMappingLike = {
  sourceFieldName: string
  targetFieldName: string
  mappingFunction?: unknown | null
}

export type IndexerLike = {
  outputFieldMappings?: OutputFieldMappingLike[]
  [key: string]: unknown
}

function normalizeJsonPointerPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return '/document'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function toSearchFieldName(input: string): string {
  // Azure AI Search field names: start with a letter, and contain only letters, digits, underscores.
  const raw = input.trim()
  const stripped = raw.replace(/^\/document\//, '').replace(/^\//, '')
  const underscored = stripped.replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  const startsOk = underscored.match(/^[A-Za-z]/) ? underscored : `f_${underscored || 'out'}`
  return startsOk.slice(0, 128)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function isMappingLike(v: unknown): v is OutputFieldMappingLike {
  if (!isRecord(v)) return false
  return typeof (v as any).sourceFieldName === 'string' && typeof (v as any).targetFieldName === 'string'
}

function makeUniqueTargetFieldName(used: Set<string>, base: string): string {
  if (!used.has(base)) return base
  for (let n = 2; n < 200; n++) {
    const candidate = `${base}_${n}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}_${Date.now()}`
}

/**
 * Adds a docs-aligned outputFieldMappings entry to an indexer definition.
 * - Preserves existing mappings
 * - Avoids exact duplicates
 * - Ensures targetFieldName is unique within the indexer
 */
export function appendOutputFieldMappingToIndexer(indexer: IndexerLike, sourceFieldName: string): IndexerLike {
  const source = normalizeJsonPointerPath(sourceFieldName)
  if (!source.trim()) return indexer

  const existing = Array.isArray(indexer.outputFieldMappings) ? indexer.outputFieldMappings : []
  const existingNormalized: OutputFieldMappingLike[] = existing
    .map((x) => (isMappingLike(x) ? x : null))
    .filter((x): x is OutputFieldMappingLike => x !== null)

  // UI connects do not have enough information to intentionally map the same
  // enrichment node to multiple index fields, so treat repeated source connects
  // as idempotent.
  const alreadyMapped = existingNormalized.some((m) => m.sourceFieldName.trim() === source)
  if (alreadyMapped) return indexer

  const baseTarget = toSearchFieldName(source)
  const usedTargets = new Set(existingNormalized.map((m) => (m.targetFieldName || '').trim()).filter(Boolean))
  const target = makeUniqueTargetFieldName(usedTargets, baseTarget)

  const next: OutputFieldMappingLike = {
    sourceFieldName: source,
    targetFieldName: target,
    mappingFunction: null,
  }

  return {
    ...indexer,
    outputFieldMappings: [...existingNormalized, next],
  }
}

/**
 * Removes an outputFieldMappings entry matching the given source+target.
 */
export function removeOutputFieldMappingFromIndexer(
  indexer: IndexerLike,
  params: { sourceFieldName: string; targetFieldName: string },
): IndexerLike {
  const source = normalizeJsonPointerPath(params.sourceFieldName)
  const target = (params.targetFieldName || '').trim()
  if (!source.trim() || !target) return indexer

  const existing = Array.isArray(indexer.outputFieldMappings) ? indexer.outputFieldMappings : []
  const existingNormalized: OutputFieldMappingLike[] = existing
    .map((x) => (isMappingLike(x) ? x : null))
    .filter((x): x is OutputFieldMappingLike => x !== null)

  const next = existingNormalized.filter((m) => !(m.sourceFieldName.trim() === source && m.targetFieldName.trim() === target))
  if (next.length === existingNormalized.length) return indexer

  return {
    ...indexer,
    outputFieldMappings: next,
  }
}

export const _internal = {
  normalizeJsonPointerPath,
  toSearchFieldName,
}
