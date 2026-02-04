/**
 * Skill Pipeline Builder.
 *
 * Assists authoring Azure AI Search skillsets by mapping each skill to a node
 * and showing a left-to-right flow. The underlying artifact is skillset JSON.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

import {
  ReactFlow,
  Controls,
  Background,
  Panel,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type NodeProps,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import dagre from 'dagre'

import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import { getSkillset, listSkillsets } from '../../lib/aiSearchRest'

import type { ThemePreference } from '../../types/app'
import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import {
  useSkillPipelineState,
  type SkillPipelineNode,
  type SkillPipelineEdge,
  type SkillPipelineSkillDefinition,
  SKILL_PIPELINE_DOC_NODE_ID,
} from '../../contexts'

type TranslationKey = keyof typeof translations.ja

type SkillPipelineBuilderProps = {
  t: (key: TranslationKey) => string
  language: Language
  theme: ThemePreference
  copyToClipboard: (text: string) => Promise<void>

  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
}

function SkillPipelineSkillNode(props: NodeProps<SkillPipelineNode>) {
  const { data, selected } = props
  const skill = (data as any)?.kind === 'skill' ? ((data as any).skill as SkillPipelineSkillDefinition) : undefined
  const name = typeof skill?.name === 'string' ? skill.name.trim() : ''
  const odataType = typeof skill?.['@odata.type'] === 'string' ? String(skill['@odata.type']).trim() : ''

  const shortTypeName = useMemo(() => {
    if (!odataType) return ''
    const cleaned = odataType.startsWith('#') ? odataType.slice(1) : odataType
    const parts = cleaned.split('.').filter(Boolean)
    return parts.length ? parts[parts.length - 1] : cleaned
  }, [odataType])

  const label = shortTypeName || name || '(skill)'

  const tag = (() => {
    const t = odataType
    if (!t) return null
    if (t.includes('.Skills.Util.') || t.includes('#Microsoft.Skills.Util.')) return { text: 'Util', cls: 'spvStage__status--util' }
    if (t.includes('.Skills.Text.') || t.includes('#Microsoft.Skills.Text.')) return { text: 'Text', cls: 'spvStage__status--text' }
    if (t.includes('.Skills.Custom.') || t.includes('#Microsoft.Skills.Custom.')) return { text: 'Custom', cls: 'spvStage__status--custom' }
    return { text: 'Skill', cls: 'spvStage__status--tag' }
  })()

  return (
    <div style={{ width: 260 }}>
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />

      <div
        className="spvStage spvStage--skill"
        style={{
          outline: selected ? '2px solid var(--accent)' : 'none',
          outlineOffset: 1,
        }}
      >
        <div className="spvStage__header">
          <div className="spvStage__title">
            <div className="spvStage__label">{label}</div>
            {tag ? <div className={`spvStage__status spvStage__status--tag ${tag.cls}`}>{tag.text}</div> : <div className="spvStage__status"></div>}
          </div>
          <div className="spvStage__meta">
            {name ? (
              <span className="mono mono--ellipsesSm" title={name}>
                {name}
              </span>
            ) : null}
            <span className="mono mono--ellipsesSm" title={odataType}>
              {odataType || ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function SkillPipelineDocumentNode(props: NodeProps<SkillPipelineNode>) {
  const { data, selected } = props
  const path = (data as any)?.kind === 'doc' && typeof (data as any).path === 'string' ? String((data as any).path) : '/document'

  return (
    <div style={{ width: 260 }}>
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />

      <div
        className="spvStage spvStage--doc"
        style={{
          outline: selected ? '2px solid var(--accent)' : 'none',
          outlineOffset: 1,
        }}
      >
        <div className="spvStage__header">
          <div className="spvStage__title">
            <div className="spvStage__label">ドキュメント</div>
            <div className="spvStage__status spvStage__status--tag">root</div>
          </div>
          <div className="spvStage__meta">
            <span className="mono mono--ellipsesSm" title={path}>
              {path}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function SkillPipelineProjectionNode(props: NodeProps<SkillPipelineNode>) {
  const { data, selected } = props
  const targetIndexName = (data as any)?.kind === 'projection' && typeof (data as any).targetIndexName === 'string' ? String((data as any).targetIndexName) : ''
  const sourceContext = (data as any)?.kind === 'projection' && typeof (data as any).sourceContext === 'string' ? String((data as any).sourceContext) : ''
  const projectionCount = (data as any)?.kind === 'projection' && typeof (data as any).projectionCount === 'number' ? (data as any).projectionCount : null
  const fieldMappingCount = (data as any)?.kind === 'projection' && typeof (data as any).fieldMappingCount === 'number' ? (data as any).fieldMappingCount : null
  const outputFieldMappingCount = (data as any)?.kind === 'projection' && typeof (data as any).outputFieldMappingCount === 'number' ? (data as any).outputFieldMappingCount : null

  return (
    <div style={{ width: 260 }}>
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />

      <div
        className="spvStage spvStage--projection"
        style={{
          outline: selected ? '2px solid var(--accent)' : 'none',
          outlineOffset: 1,
        }}
      >
        <div className="spvStage__header">
          <div className="spvStage__title">
            <div className="spvStage__label">インデックスマッピング</div>
            <div className="spvStage__status"></div>
          </div>
          <div className="spvStage__meta">
            <span className="mono mono--ellipsesSm" title={sourceContext}>
              {sourceContext || ''}
            </span>
            <span className="mono mono--ellipsesSm" title={targetIndexName}>
              {targetIndexName || ''}
            </span>
          </div>
        </div>

        <div className="spvStage__tableWrap">
          <div className="kv">
            <div className="kv__row">
              <div className="kv__k">プロジェクションマッピング</div>
              <div className="kv__v" style={{ textAlign: 'right' }}>{projectionCount ?? '-'}</div>
            </div>
            <div className="kv__row">
              <div className="kv__k">出力フィールドのマッピング</div>
              <div className="kv__v" style={{ textAlign: 'right' }}>{outputFieldMappingCount ?? '-'}</div>
            </div>
            <div className="kv__row">
              <div className="kv__k">フィールドのマッピング</div>
              <div className="kv__v" style={{ textAlign: 'right' }}>{fieldMappingCount ?? '-'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SkillPipelineIndexNode(props: NodeProps<SkillPipelineNode>) {
  const { data, selected } = props
  const targetIndexName = (data as any)?.kind === 'index' && typeof (data as any).targetIndexName === 'string' ? String((data as any).targetIndexName) : ''

  return (
    <div style={{ width: 260 }}>
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />

      <div
        className="spvStage spvStage--index"
        style={{
          outline: selected ? '2px solid var(--accent)' : 'none',
          outlineOffset: 1,
        }}
      >
        <div className="spvStage__header">
          <div className="spvStage__title">
            <div className="spvStage__label">検索インデックス</div>
            <div className="spvStage__status"></div>
          </div>
          <div className="spvStage__meta">
            <span className="mono mono--ellipsesSm" title={targetIndexName}>
              {targetIndexName || ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function getNodeDims(n: SkillPipelineNode): { width: number; height: number } {
  const kind = (n as any)?.data?.kind
  if (kind === 'projection') return { width: 260, height: 200 }
  return { width: 260, height: 88 }
}

function applyDagreLayout(inputNodes: SkillPipelineNode[], inputEdges: SkillPipelineEdge[]): SkillPipelineNode[] {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 80, ranksep: 140 })

  for (const n of inputNodes) {
    const { width, height } = getNodeDims(n)
    g.setNode(n.id, { width, height })
  }
  for (const e of inputEdges) g.setEdge(e.source, e.target)

  dagre.layout(g)

  return inputNodes.map((n) => {
    const p = g.node(n.id)
    if (!p) return n
    const { width, height } = getNodeDims(n)
    return {
      ...n,
      position: { x: p.x - width / 2, y: p.y - height / 2 },
    }
  })
}

function joinPath(context: string, segment: string): string {
  const ctxRaw = (context || '').trim() || '/document'
  const segRaw = (segment || '').trim()
  const ctx = ctxRaw.endsWith('/') ? ctxRaw.slice(0, -1) : ctxRaw
  if (!segRaw) return ctx
  return `${ctx}/${segRaw}`
}

function getSkillFromNode(node: SkillPipelineNode): SkillPipelineSkillDefinition | null {
  const data: any = node.data
  if (data?.kind !== 'skill') return null
  const skill = data.skill
  return isRecord(skill) ? (skill as SkillPipelineSkillDefinition) : (skill as SkillPipelineSkillDefinition)
}

function inferEdgesFromSkills(params: {
  docNodeId: string
  docPath: string
  skillNodes: SkillPipelineNode[]
}): SkillPipelineEdge[] {
  const { docNodeId, docPath, skillNodes } = params
  const edges: SkillPipelineEdge[] = []
  const seen = new Set<string>()

  // Decide edges only when we can determine a single producer.
  const producedByLengthDesc = computeProducedPaths(skillNodes)

  const addEdgeUnique = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId) return
    if (sourceId === targetId) return
    const key = `${sourceId}->${targetId}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ id: uuidv4(), source: sourceId, target: targetId })
  }

  for (const n of skillNodes) {
    const skill = getSkillFromNode(n)
    if (!skill) continue

    const inputsRaw = (skill as any).inputs
    const inputs = Array.isArray(inputsRaw) ? inputsRaw : []

    for (const i of inputs) {
      const r = isRecord(i) ? i : {}
      const source = typeof r.source === 'string' ? r.source.trim() : ''
      if (!source) continue

      // Skip expression-only sources (constants, string concatenation, etc.)
      if (source.startsWith("='")) continue
      if (source.startsWith('=') && source.includes('$(')) {
        // These are often computed from other fields; we don't try to parse expressions.
        continue
      }

      const producerId = findDeterministicProducerId({ source, producedByLengthDesc })
      if (producerId && producerId !== n.id) {
        addEdgeUnique(producerId, n.id)
        continue
      }

      // Deterministic doc edge only for direct children (e.g. /document/file_data)
      // and only when no skill produced it.
      if (source.startsWith(`${docPath}/`)) {
        const rest = source.slice((`${docPath}/`).length)
        if (rest && !rest.includes('/') && !rest.includes('*')) {
          addEdgeUnique(docNodeId, n.id)
        }
      }
    }
  }

  return edges
}

function computeProducedPaths(skillNodes: SkillPipelineNode[]): Array<{ path: string; producerId: string }> {
  const produced: Array<{ path: string; producerId: string }> = []
  for (const n of skillNodes) {
    const skill = getSkillFromNode(n)
    if (!skill) continue
    const context = typeof skill.context === 'string' ? skill.context : '/document'
    const outputsRaw = (skill as any).outputs
    const outputs = Array.isArray(outputsRaw) ? outputsRaw : []
    for (const o of outputs) {
      const r = isRecord(o) ? o : {}
      const targetName = typeof r.targetName === 'string' ? r.targetName : ''
      const name = typeof r.name === 'string' ? r.name : ''
      const seg = targetName.trim() || name.trim()
      if (!seg) continue
      produced.push({ path: joinPath(context, seg), producerId: n.id })
    }
  }
  return produced.sort((a, b) => b.path.length - a.path.length)
}

function trimTrailingWildcards(path: string): string[] {
  const out: string[] = []
  let cur = path.trim()
  if (!cur) return out
  out.push(cur)

  while (cur.endsWith('/*')) {
    cur = cur.slice(0, -2)
    if (cur.endsWith('/')) cur = cur.slice(0, -1)
    if (!cur) break
    out.push(cur)
  }

  return Array.from(new Set(out))
}

function findDeterministicProducerId(params: {
  source: string
  producedByLengthDesc: Array<{ path: string; producerId: string }>
}): string | null {
  const { source, producedByLengthDesc } = params
  const s = source.trim()
  if (!s) return null

  const candidates = trimTrailingWildcards(s)
  const hits: string[] = []

  for (const p of producedByLengthDesc) {
    // Exact match against the source or its trimmed variants.
    if (candidates.includes(p.path)) {
      hits.push(p.producerId)
      continue
    }

    // Array expansion: producer outputs a collection at p.path,
    // consumer reads elements under p.path/*/...
    if (s.startsWith(`${p.path}/*`)) {
      hits.push(p.producerId)
    }
  }

  const uniq = Array.from(new Set(hits))
  return uniq.length === 1 ? uniq[0] : null
}

function inferEdgesToIndexProjections(params: {
  docNodeId: string
  docRoot: string
  producedByLengthDesc: Array<{ path: string; producerId: string }>
  selectorNodes: Array<{ id: string; mappings: Array<{ source: string }> }>
  indexNodeIdByTarget: Map<string, string>
}): SkillPipelineEdge[] {
  const { docNodeId, docRoot, producedByLengthDesc, selectorNodes, indexNodeIdByTarget } = params
  const edges: SkillPipelineEdge[] = []
  const seen = new Set<string>()

  const addEdgeUnique = (sourceId: string, targetId: string) => {
    if (!sourceId || !targetId) return
    if (sourceId === targetId) return
    const key = `${sourceId}->${targetId}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ id: uuidv4(), source: sourceId, target: targetId })
  }

  for (const sel of selectorNodes) {
    for (const m of sel.mappings) {
      const source = (m.source || '').trim()
      if (!source) continue
      if (source.startsWith("='")) continue
      if (source.startsWith('=') && source.includes('$(')) continue

      const producerId = findDeterministicProducerId({ source, producedByLengthDesc })
      if (producerId) {
        addEdgeUnique(producerId, sel.id)
        continue
      }

      // Deterministic doc edge only for direct children.
      if (source.startsWith(`${docRoot}/`)) {
        const rest = source.slice((`${docRoot}/`).length)
        if (rest && !rest.includes('/') && !rest.includes('*')) {
          addEdgeUnique(docNodeId, sel.id)
        }
      }
    }
  }

  // projection -> index
  for (const sel of selectorNodes) {
    const idxId = indexNodeIdByTarget.get((sel as any).targetIndexName)
    if (idxId) addEdgeUnique(sel.id, idxId)
  }

  return edges
}

export function SkillPipelineBuilder(props: SkillPipelineBuilderProps) {
  const { t, profile, apiVersion, language } = props

  const {
    nodes,
    setNodes,
    edges,
    setEdges,
    setSelectedNodeId,
    setDraftSkillJson,
    setDraftError,
    setSkillsetName,
    setSkillsetDescription,
    setIndexProjections,
    setKnowledgeStore,
  } = useSkillPipelineState()

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)

  const flowRef = useRef<ReactFlowInstance<SkillPipelineNode, SkillPipelineEdge> | null>(null)
  const pendingFitViewRef = useRef(false)

  const [remoteSkillsets, setRemoteSkillsets] = useState<string[]>([])
  const [remoteSelected, setRemoteSelected] = useState<string>('')
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)

  const addSkill = () => {
    setNodes((prev) => {
      const skillCount = prev.filter((x) => (x as any)?.data?.kind === 'skill').length
      const n = skillCount + 1
      const id = uuidv4()
      const next: SkillPipelineNode = {
        id,
        type: 'skill',
        position: { x: 80 + (n - 1) * 40, y: 80 + (n - 1) * 30 },
        data: {
          kind: 'skill',
          skill: {
            '@odata.type': '',
            name: `skill${n}`,
            context: '/document',
            inputs: [],
            outputs: [],
          },
        },
      }
      const out = [...prev, next]
      setSelectedNodeId(id)
      setDraftSkillJson(JSON.stringify((next.data as any).skill, null, 2))
      setDraftError(null)
      return out
    })
  }

  const onSelectNode = (id: string) => {
    setSelectedNodeId(id)
    const node = nodes.find((n) => n.id === id) ?? null
    if (node && (node as any)?.data?.kind === 'skill') setDraftSkillJson(JSON.stringify((node as any).data?.skill ?? {}, null, 2))
    setDraftError(null)
  }

  const nodeTypes = useMemo(
    () => ({
      skill: SkillPipelineSkillNode,
      doc: SkillPipelineDocumentNode,
      projection: SkillPipelineProjectionNode,
      index: SkillPipelineIndexNode,
    }),
    [],
  )

  const doLayout = () => {
    setNodes((prev) => applyDagreLayout(prev, edges))

    // Keep it snappy: re-fit after layout.
    setTimeout(() => flowRef.current?.fitView({ padding: 0.2, duration: 250 }), 0)
  }

  const refreshRemoteSkillsets = async () => {
    if (!profile) return
    setRemoteLoading(true)
    setRemoteError(null)
    try {
      const res = await listSkillsets({ profile, apiVersion, language })
      if (!res.ok) {
        setRemoteError(res.error.message)
        setRemoteSkillsets([])
        return
      }
      const value = (res.response as any)?.value
      const names = Array.isArray(value)
        ? value
            .map((x: any) => (x && typeof x.name === 'string' ? x.name : null))
            .filter((x: any): x is string => typeof x === 'string')
        : []
      setRemoteSkillsets(names)
      if (!remoteSelected && names.length > 0) setRemoteSelected(names[0])
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e))
      setRemoteSkillsets([])
    } finally {
      setRemoteLoading(false)
    }
  }

  const loadRemoteSkillset = async () => {
    if (!profile) return
    const name = remoteSelected.trim()
    if (!name) return

    setRemoteLoading(true)
    setRemoteError(null)
    try {
      const res = await getSkillset({ profile, skillsetName: name, apiVersion, language })
      if (!res.ok) {
        setRemoteError(res.error.message)
        return
      }

      const obj = res.response as any
      const skills = Array.isArray(obj?.skills) ? obj.skills : []

      const docNode: SkillPipelineNode = {
        id: SKILL_PIPELINE_DOC_NODE_ID,
        type: 'doc',
        position: { x: 80, y: 80 },
        data: { kind: 'doc', path: '/document' } as any,
      }

      const nextSkillNodes: SkillPipelineNode[] = skills.map((skill: any, idx: number) => ({
        id: uuidv4(),
        type: 'skill',
        position: { x: 420 + idx * 320, y: 80 + idx * 10 },
        data: { kind: 'skill', skill: (skill ?? {}) as any } as any,
      }))

      // Prefer persisted graph layout if present.
      const graph = isRecord(obj?._ragops) && isRecord((obj as any)._ragops.graph) ? ((obj as any)._ragops.graph as any) : null
      const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes : null
      const graphEdges = Array.isArray(graph?.edges) ? graph.edges : null

      // indexProjections => projection nodes and index nodes
      const selectors = Array.isArray(obj?.indexProjections?.selectors) ? obj.indexProjections.selectors : []
      const uniqueTargets = Array.from(
        new Set(selectors.map((s: any) => (typeof s?.targetIndexName === 'string' ? s.targetIndexName : '')).filter((x: string) => x)),
      )
      const targetIndexName = uniqueTargets.join(', ')
      const sourceContext = selectors
        .map((s: any) => (typeof s?.sourceContext === 'string' ? s.sourceContext : ''))
        .filter((x: string) => x)
        .join(', ')

      const fieldMappingCount = selectors.reduce((acc: number, s: any) => acc + (Array.isArray(s?.mappings) ? s.mappings.length : 0), 0)

      const projectionNodes: SkillPipelineNode[] = selectors.length
        ? [
            {
              id: `mapping-${uuidv4()}`,
              type: 'projection',
              position: { x: 1100, y: 140 },
              data: {
                kind: 'projection',
                targetIndexName,
                sourceContext,
                projectionCount: selectors.length,
                outputFieldMappingCount: fieldMappingCount,
                fieldMappingCount,
              } as any,
            },
          ]
        : []

      const indexNodeIdByTarget = new Map<string, string>()
      const indexNodes: SkillPipelineNode[] = []
      for (const s of selectors) {
        const targetIndexName = typeof s?.targetIndexName === 'string' ? s.targetIndexName : ''
        if (!targetIndexName) continue
        if (indexNodeIdByTarget.has(targetIndexName)) continue
        const id = `index-${uuidv4()}`
        indexNodeIdByTarget.set(targetIndexName, id)
        indexNodes.push({
          id,
          type: 'index',
          position: { x: 1500, y: 180 + indexNodes.length * 220 },
          data: { kind: 'index', targetIndexName } as any,
        })
      }

      let nextNodes: SkillPipelineNode[] = [docNode, ...nextSkillNodes, ...projectionNodes, ...indexNodes]
      let nextEdges: SkillPipelineEdge[] = []

      if (graphNodes && graphEdges) {
        const posById = new Map<string, { x: number; y: number }>()
        for (const gn of graphNodes) {
          if (!isRecord(gn)) continue
          if (typeof gn.id !== 'string') continue
          if (typeof gn.x !== 'number' || typeof gn.y !== 'number') continue
          posById.set(gn.id, { x: gn.x, y: gn.y })
        }

        // If IDs match, apply positions. (Remote graph IDs may not match our generated UUIDs.)
        nextNodes = nextNodes.map((n) => {
          const p = posById.get(n.id)
          return p ? { ...n, position: { x: p.x, y: p.y } } : n
        })

        nextEdges = graphEdges
          .map((ge: any): SkillPipelineEdge | null => {
            if (!isRecord(ge)) return null
            const source = typeof ge.source === 'string' ? ge.source : ''
            const target = typeof ge.target === 'string' ? ge.target : ''
            if (!source || !target) return null
            return { id: typeof ge.id === 'string' ? ge.id : uuidv4(), source, target }
          })
          .filter((x: SkillPipelineEdge | null): x is SkillPipelineEdge => x !== null)
      } else {
        const docRoot = '/document'
        nextEdges = inferEdgesFromSkills({
          docNodeId: SKILL_PIPELINE_DOC_NODE_ID,
          docPath: docRoot,
          skillNodes: nextSkillNodes,
        })

        const producedByLengthDesc = computeProducedPaths(nextSkillNodes)
        const mappingNodeId = projectionNodes[0]?.id
        if (mappingNodeId) {
          const allMappingSources = selectors
            .flatMap((s: any) => (Array.isArray(s?.mappings) ? s.mappings : []))
            .map((m: any) => ({ source: typeof m?.source === 'string' ? m.source : '' }))
            .filter((m: any) => typeof m.source === 'string' && m.source.trim())

          nextEdges = nextEdges.concat(
            inferEdgesToIndexProjections({
              docNodeId: SKILL_PIPELINE_DOC_NODE_ID,
              docRoot,
              producedByLengthDesc,
              selectorNodes: [{ id: mappingNodeId, mappings: allMappingSources, targetIndexName: '' } as any],
              indexNodeIdByTarget,
            }),
          )

          // mapping -> index for every target index
          for (const [target, idxId] of indexNodeIdByTarget.entries()) {
            if (!target) continue
            nextEdges.push({ id: uuidv4(), source: mappingNodeId, target: idxId })
          }
        }
      }

      // Always apply a clean layout right after remote load.
      const laidOut = applyDagreLayout(nextNodes, nextEdges)

      setSkillsetName(typeof obj?.name === 'string' && obj.name.trim() ? obj.name : name)
      setSkillsetDescription(typeof obj?.description === 'string' ? obj.description : '')
      setIndexProjections(obj?.indexProjections ?? null)
      setKnowledgeStore(obj?.knowledgeStore ?? null)
      setNodes(laidOut)
      setEdges(nextEdges)

      const firstSkill = nextNodes.find((n) => (n as any)?.data?.kind === 'skill')
      if (firstSkill) {
        setSelectedNodeId(firstSkill.id)
        setDraftSkillJson(JSON.stringify((firstSkill as any).data.skill, null, 2))
      } else {
        setSelectedNodeId('')
        setDraftSkillJson('{}')
      }
      setDraftError(null)
      pendingFitViewRef.current = true
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoteLoading(false)
    }
  }

  useEffect(() => {
    if (!pendingFitViewRef.current) return
    if (!flowRef.current) return
    if (nodes.length === 0) return

    // Wait one paint so ReactFlow has applied nodes/edges.
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        flowRef.current?.fitView({ padding: 0.2, duration: 250 })
        pendingFitViewRef.current = false
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [nodes.length, edges.length])

  useEffect(() => {
    // Auto-load the remote list once a profile is present.
    if (!profile) return
    refreshRemoteSkillsets()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.endpoint, profile?.authType, profile?.apiKey, profile?.bearerToken])

  return (
    <div className="pane__centerContent" style={{ height: '100%' }}>
      <div className="section" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div className="section__title">{t('skillPipelineBuilder')}</div>
        <div className="section__hint">{t('spbIntro')}</div>

        <div className="actions actions--mb10" style={{ flexWrap: 'wrap' }}>
          <div className="field" style={{ minWidth: 280 }}>
            <span className="field__label">Skillsets (service)</span>
            <select
              className="field__input"
              value={remoteSelected}
              onChange={(e) => setRemoteSelected(e.target.value)}
              disabled={!profile || remoteLoading || remoteSkillsets.length === 0}
            >
              {remoteSkillsets.length === 0 ? <option value="">(none)</option> : null}
              {remoteSkillsets.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="btn" onClick={refreshRemoteSkillsets} disabled={!profile || remoteLoading}>
            Refresh
          </button>
          <button type="button" className="btn" onClick={loadRemoteSkillset} disabled={!profile || remoteLoading || !remoteSelected}>
            Load
          </button>
          {remoteError && <div className="notice notice--error builder__notice">{remoteError}</div>}
        </div>

        <div className="actions actions--mb10">
          <button type="button" className="btn" onClick={addSkill}>
            + {t('spbAddSkill')}
          </button>
        </div>

        <div
          className="spvPipeline"
          style={{
            position: 'relative',
            flex: 1,
            minHeight: 360,
            overflow: 'hidden',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--panel-2)',
          }}
          role="region"
          aria-label="skill pipeline canvas"
          tabIndex={0}
          onKeyDown={(e) => {
            if ((e.key === 'Backspace' || e.key === 'Delete') && selectedEdgeId) {
              e.preventDefault()
              setEdges((prev) => prev.filter((x) => x.id !== selectedEdgeId))
              setSelectedEdgeId(null)
            }
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={(changes) => setNodes((prev) => applyNodeChanges(changes, prev))}
            onEdgesChange={(changes) => setEdges((prev) => applyEdgeChanges(changes, prev))}
            onConnect={(connection: Connection) => {
              if (!connection.source || !connection.target) return
              setEdges((prev) => addEdge({ ...connection, id: uuidv4() }, prev))
            }}
            onNodeClick={(_, node) => {
              setSelectedEdgeId(null)
              onSelectNode(node.id)
            }}
            onSelectionChange={(sel) => {
              const selected = sel.nodes?.[0]
              if (selected && selected.id) {
                setSelectedEdgeId(null)
                onSelectNode(selected.id)
              }
            }}
            onEdgeClick={(e, edge) => {
              e.preventDefault()
              setSelectedEdgeId(edge.id)
            }}
            onPaneClick={() => setSelectedEdgeId(null)}
            onInit={(instance) => {
              flowRef.current = instance
            }}
            fitView
          >
            <Controls showFitView />
            <Background />
            <Panel position="top-right">
              <button type="button" className="btn btn--tab" onClick={doLayout}>
                Layout
              </button>
            </Panel>
          </ReactFlow>
        </div>
      </div>
    </div>
  )
}
