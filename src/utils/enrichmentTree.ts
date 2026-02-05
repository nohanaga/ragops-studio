/**
 * Enrichment Tree utilities.
 *
 * Builds a /document-rooted tree view and cross-references:
 * - which skill outputs produce each path
 * - which skill inputs reference each path
 * - how the indexer (outputFieldMappings) uses each path
 */

import type { SkillPipelineIndexerDefinition, SkillPipelineNode, SkillPipelineSkillDefinition } from '../contexts'

export type EnrichmentProducedItem = {
  path: string
  skillId: string
  skillName: string
  odataType: string
  context: string
  outputName: string
  targetName: string
}

export type EnrichmentReferenceItem = {
  source: string
  skillId: string
  skillName: string
  inputName: string
}

export type EnrichmentIndexerUsageItem = {
  sourceFieldName: string
  targetFieldName: string
}

export type EnrichmentTreeNode = {
  path: string
  segment: string
  children: EnrichmentTreeNode[]
}

export type EnrichmentTreeModel = {
  root: EnrichmentTreeNode
  produced: EnrichmentProducedItem[]
  references: EnrichmentReferenceItem[]
  indexerUsages: EnrichmentIndexerUsageItem[]
  producedPathSet: Set<string>
  allPathSet: Set<string>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function normalizePath(input: string, defaultPath = '/document'): string {
  const raw = String(input || '').trim()
  const s = raw || defaultPath
  return s.startsWith('/') ? s : `/${s}`
}

function stripExpressionSources(s: string): string {
  const src = String(s || '').trim()
  if (!src) return ''
  if (src.startsWith("='")) return ''
  if (src.startsWith('=') && src.includes('$(')) return ''
  return src
}

function joinPath(context: string, segment: string): string {
  const ctxRaw = normalizePath(context || '/document', '/document')
  const segRaw = String(segment || '').trim().replace(/^\/+/, '')
  const ctx = ctxRaw.endsWith('/') ? ctxRaw.slice(0, -1) : ctxRaw
  if (!segRaw) return ctx
  return `${ctx}/${segRaw}`
}

function getSkillFromNode(node: SkillPipelineNode): SkillPipelineSkillDefinition | null {
  const data: any = (node as any)?.data
  if (!data || data.kind !== 'skill') return null
  const skill = data.skill
  return isRecord(skill) ? (skill as SkillPipelineSkillDefinition) : (skill as SkillPipelineSkillDefinition)
}

function splitSegments(path: string): string[] {
  return String(path || '')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
}

function addPathAndPrefixes(paths: Set<string>, path: string): void {
  const p = normalizePath(path)
  const segs = splitSegments(p)
  if (!segs.length) return

  let cur = ''
  for (const seg of segs) {
    cur = `${cur}/${seg}`
    paths.add(cur)
  }
}

function buildTreeFromPaths(paths: Set<string>, docRoot: string): EnrichmentTreeNode {
  const rootPath = normalizePath(docRoot, '/document')
  addPathAndPrefixes(paths, rootPath)

  const nodeByPath = new Map<string, EnrichmentTreeNode>()
  const ensure = (path: string, segment: string): EnrichmentTreeNode => {
    const p = normalizePath(path)
    const existing = nodeByPath.get(p)
    if (existing) return existing
    const n: EnrichmentTreeNode = { path: p, segment, children: [] }
    nodeByPath.set(p, n)
    return n
  }

  const rootSeg = rootPath
  const root = ensure(rootPath, rootSeg)

  const sorted = Array.from(paths)
    .map((p) => normalizePath(p))
    .filter((p) => p === rootPath || p.startsWith(`${rootPath}/`))
    .sort((a, b) => a.localeCompare(b))

  for (const p of sorted) {
    if (p === rootPath) continue
    const segs = splitSegments(p)
    const rootSegs = splitSegments(rootPath)
    const rel = segs.slice(rootSegs.length)
    if (!rel.length) continue

    let parentPath = rootPath
    for (let i = 0; i < rel.length; i++) {
      const seg = rel[i]
      const curPath = `${parentPath}/${seg}`
      const node = ensure(curPath, seg)
      const parent = ensure(parentPath, parentPath === rootPath ? rootSeg : splitSegments(parentPath).slice(-1)[0] ?? parentPath)
      if (!parent.children.some((c) => c.path === node.path)) parent.children.push(node)
      parentPath = node.path
    }
  }

  const sortChildren = (n: EnrichmentTreeNode) => {
    n.children.sort((a, b) => a.segment.localeCompare(b.segment))
    n.children.forEach(sortChildren)
  }
  sortChildren(root)
  return root
}

export function buildEnrichmentTreeModel(params: {
  nodes: SkillPipelineNode[]
  indexer: SkillPipelineIndexerDefinition | null
  docRoot?: string
}): EnrichmentTreeModel {
  const docRoot = normalizePath(params.docRoot || '/document', '/document')
  const skillNodes = params.nodes.filter((n) => (n as any)?.data?.kind === 'skill')

  const produced: EnrichmentProducedItem[] = []
  const references: EnrichmentReferenceItem[] = []
  const indexerUsages: EnrichmentIndexerUsageItem[] = []

  const allPathSet = new Set<string>()
  addPathAndPrefixes(allPathSet, docRoot)

  // Seed known document ports so the tree is useful even before any skills exist.
  ;['content', 'normalized_images', 'normalized_images/*', 'normalized_images/*/content', 'normalized_images/*/ocrText'].forEach((seg) => {
    addPathAndPrefixes(allPathSet, joinPath(docRoot, seg))
  })

  for (const n of skillNodes) {
    const skill = getSkillFromNode(n)
    if (!skill) continue

    const skillId = String((n as any)?.id ?? '')
    const skillName = typeof (skill as any)?.name === 'string' && (skill as any).name.trim() ? String((skill as any).name) : skillId
    const odataType = typeof (skill as any)['@odata.type'] === 'string' ? String((skill as any)['@odata.type']) : ''
    const context = typeof (skill as any).context === 'string' && String((skill as any).context).trim() ? String((skill as any).context) : docRoot
    const contextNorm = normalizePath(context, docRoot)

    const outputsRaw = (skill as any).outputs
    const outputs = Array.isArray(outputsRaw) ? outputsRaw : []
    for (const o of outputs) {
      const r = isRecord(o) ? o : {}
      const targetName = typeof (r as any).targetName === 'string' ? String((r as any).targetName) : ''
      const name = typeof (r as any).name === 'string' ? String((r as any).name) : ''
      const seg = (targetName || name).trim()
      if (!seg) continue

      const path = joinPath(contextNorm, seg)
      produced.push({
        path,
        skillId,
        skillName,
        odataType,
        context: contextNorm,
        outputName: name,
        targetName,
      })
      addPathAndPrefixes(allPathSet, path)
    }

    const inputsRaw = (skill as any).inputs
    const inputs = Array.isArray(inputsRaw) ? inputsRaw : []
    for (const i of inputs) {
      const r = isRecord(i) ? i : {}
      const inputName = typeof (r as any).name === 'string' ? String((r as any).name) : ''
      const sourceRaw = typeof (r as any).source === 'string' ? String((r as any).source) : ''
      const sourceClean = stripExpressionSources(sourceRaw)
      if (!sourceClean) continue

      const source = normalizePath(sourceClean, docRoot)
      references.push({ source, skillId, skillName, inputName })
      addPathAndPrefixes(allPathSet, source)
    }
  }

  const outputFieldMappings = Array.isArray((params.indexer as any)?.outputFieldMappings)
    ? (((params.indexer as any).outputFieldMappings as any[]) ?? [])
    : []

  for (const m of outputFieldMappings) {
    if (!m || typeof m !== 'object') continue
    const sourceRaw = typeof (m as any).sourceFieldName === 'string' ? String((m as any).sourceFieldName) : ''
    const targetRaw = typeof (m as any).targetFieldName === 'string' ? String((m as any).targetFieldName) : ''
    const sourceClean = stripExpressionSources(sourceRaw)
    const target = targetRaw.trim()
    if (!sourceClean || !target) continue

    const sourceFieldName = normalizePath(sourceClean, docRoot)
    indexerUsages.push({ sourceFieldName, targetFieldName: target })
    addPathAndPrefixes(allPathSet, sourceFieldName)
  }

  const producedPathSet = new Set<string>(produced.map((p) => p.path))

  return {
    root: buildTreeFromPaths(allPathSet, docRoot),
    produced,
    references,
    indexerUsages,
    producedPathSet,
    allPathSet,
  }
}

export const _internal = {
  normalizePath,
  joinPath,
  stripExpressionSources,
  splitSegments,
  addPathAndPrefixes,
}
