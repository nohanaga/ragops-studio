import type { Language } from './translations'
import type { ClusterFacet, ClusterSemanticSignature } from './metaIndex'

export interface MicroSignatureInput {
  clusterId: string
  documentCount: number
  signature: ClusterSemanticSignature
}

export interface HierarchicalSignaturePayload {
  level: 'macro'
  strategy: 'bottom-up-micro-signatures'
  childClusterIds: string[]
  childDocumentCounts: number[]
  childCount: number
}

export function aggregateMicroSignatures(input: {
  macroId: number
  children: MicroSignatureInput[]
  language: Language
}): ClusterSemanticSignature {
  const { macroId, children, language } = input
  const totalDocuments = children.reduce((sum, child) => sum + child.documentCount, 0)
  const childLabels = uniqueStrings(children.map((child) => child.signature.primaryLabel)).slice(0, 4)
  const primaryLabel = buildFallbackMacroLabel({ macroId, labels: childLabels, language })
  const facets = aggregateFacets(children, totalDocuments)
  const inclusionCriteria = uniqueStrings(children.flatMap((child) => child.signature.inclusionCriteria)).slice(0, 8)
  const exclusionCriteria = uniqueStrings(children.flatMap((child) => child.signature.exclusionCriteria)).slice(0, 8)
  const evidenceDocIds = uniqueStrings(children.flatMap((child) => child.signature.evidenceDocIds)).slice(0, 64)
  const splitCandidate = children.length > 6 || children.some((child) => child.signature.splitCandidate)
  const shortSummary = language === 'ja'
    ? `${children.length} 個のマイクロクラスタから構成されるマクロクラスタです。主な観点: ${childLabels.join(' / ') || `Macro ${macroId}`}。`
    : `Macro cluster composed of ${children.length} micro clusters. Main facets: ${childLabels.join(' / ') || `Macro ${macroId}`}.`

  return {
    primaryLabel,
    shortSummary,
    facets,
    inclusionCriteria: inclusionCriteria.length > 0 ? inclusionCriteria : childLabels,
    exclusionCriteria,
    evidenceDocIds,
    splitCandidate,
  }
}

export function buildHierarchicalSignaturePayload(children: MicroSignatureInput[]): HierarchicalSignaturePayload {
  return {
    level: 'macro',
    strategy: 'bottom-up-micro-signatures',
    childClusterIds: children.map((child) => child.clusterId),
    childDocumentCounts: children.map((child) => child.documentCount),
    childCount: children.length,
  }
}

function aggregateFacets(children: MicroSignatureInput[], totalDocuments: number): ClusterFacet[] {
  const byLabel = new Map<string, ClusterFacet & { supportWeight: number }>()

  for (const child of children) {
    const childWeight = totalDocuments > 0 ? child.documentCount / totalDocuments : 1 / Math.max(children.length, 1)
    const childFacets = child.signature.facets.length > 0
      ? child.signature.facets
      : [{
          label: child.signature.primaryLabel,
          summary: child.signature.shortSummary,
          keywords: [child.signature.primaryLabel],
          supportRatio: childWeight,
          representativeDocIds: child.signature.evidenceDocIds.slice(0, 5),
        }]

    for (const facet of childFacets) {
      const key = normalizeLabel(facet.label)
      if (!key) continue
      const support = Math.max(0, Math.min(1, facet.supportRatio || childWeight)) * childWeight
      const existing = byLabel.get(key)
      if (!existing) {
        byLabel.set(key, {
          label: facet.label,
          summary: facet.summary,
          keywords: uniqueStrings(facet.keywords).slice(0, 12),
          supportRatio: support,
          representativeDocIds: uniqueStrings(facet.representativeDocIds).slice(0, 12),
          supportWeight: support,
        })
        continue
      }
      existing.supportWeight += support
      existing.supportRatio += support
      existing.keywords = uniqueStrings([...existing.keywords, ...facet.keywords]).slice(0, 12)
      existing.representativeDocIds = uniqueStrings([...existing.representativeDocIds, ...facet.representativeDocIds]).slice(0, 12)
      if (facet.summary.length > existing.summary.length && facet.summary.length <= 240) {
        existing.summary = facet.summary
      }
    }
  }

  return Array.from(byLabel.values())
    .sort((left, right) => right.supportWeight - left.supportWeight)
    .slice(0, 6)
    .map(({ supportWeight: _supportWeight, ...facet }) => ({
      ...facet,
      supportRatio: Number(Math.min(1, facet.supportRatio).toFixed(3)),
    }))
}

function buildFallbackMacroLabel(input: { macroId: number; labels: string[]; language: Language }): string {
  if (input.labels.length === 1) return input.labels[0]
  if (input.labels.length > 1) return input.labels.slice(0, 3).join(' / ')
  return input.language === 'ja' ? `マクロクラスタ ${input.macroId}` : `Macro Cluster ${input.macroId}`
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    const key = normalizeLabel(trimmed)
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}
