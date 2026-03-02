/**
 * Skill Pipeline Builder - Right pane.
 *
 * Hosts JSON editing for the selected skill and skillset-level properties.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { json } from '@codemirror/lang-json'
import { EditorView, Decoration, ViewPlugin } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { diffLines } from 'diff'

import type { ThemePreference } from '../../types/app'
import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import { useSkillPipelineState } from '../../contexts'
import type { SkillPipelineSkillDefinition } from '../../contexts'
import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import { createOrUpdateSkillset, getSkillset } from '../../lib/aiSearchRest'
import { buildEnrichmentTreeModel } from '../../utils/enrichmentTree'
import { EnrichmentPathPicker } from './EnrichmentPathPicker'

type TranslationKey = keyof typeof translations.ja

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function ensureJsonObject(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {}
}

function stringifyCompact(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

// ── Path-based deep utilities for recursive nested editing ──────────────

/** Deep immutable set at a nested path (supports both string keys and numeric array indices). */
function setAtPath(root: unknown, path: (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value
  const [head, ...rest] = path
  if (typeof head === 'number') {
    const arr = Array.isArray(root) ? [...root] : []
    arr[head] = setAtPath(arr[head], rest, value)
    return arr
  }
  const obj = isRecord(root) ? { ...root } : {} as Record<string, unknown>
  obj[head] = setAtPath(obj[head], rest, value)
  return obj
}

/** Deep immutable remove at a nested path. */
function removeAtPath(root: unknown, path: (string | number)[]): unknown {
  if (path.length === 0) return undefined
  if (path.length === 1) {
    const head = path[0]
    if (typeof head === 'number' && Array.isArray(root)) return root.filter((_, i) => i !== head)
    if (isRecord(root)) { const { [String(head)]: _, ...rest } = root; return rest }
    return root
  }
  const [head, ...rest] = path
  if (typeof head === 'number' && Array.isArray(root)) {
    const arr = [...root]
    arr[head] = removeAtPath(arr[head], rest)
    return arr
  }
  if (isRecord(root)) {
    const obj = { ...root }
    obj[String(head)] = removeAtPath(obj[String(head)], rest)
    return obj
  }
  return root
}

/**
 * Recursively render `<tr>` rows for nested property structures.
 * Handles: primitives, booleans, objects (expanded as sub-rows),
 * arrays of primitives (indexed inputs), arrays of objects (indexed sub-sections).
 */
function renderNestedRows(
  entries: Array<{ key: string; value: unknown }>,
  basePath: (string | number)[],
  onUpdate: (path: (string | number)[], value: unknown) => void,
  onRemove: (path: (string | number)[]) => void,
  tFn: (k: string) => string,
  depth: number = 0,
  showRemove: boolean = true,
): React.ReactNode[] {
  const rows: React.ReactNode[] = []
  const indent = depth * 20

  for (const { key, value } of entries) {
    const path = [...basePath, key]
    const pathKey = path.join('.')

    if (typeof value === 'boolean') {
      rows.push(
        <tr key={pathKey}>
          <td className="seGrid__key" style={indent ? { paddingLeft: 8 + indent } : undefined}>{key}</td>
          <td className="seGrid__val">
            <label className="seGrid__checkWrap">
              <input type="checkbox" checked={value} onChange={(e) => onUpdate(path, e.target.checked)} />
              <span>{String(value)}</span>
            </label>
          </td>
          <td className="seGrid__act">
            {showRemove && <button type="button" onClick={() => onRemove(path)} title={tFn('spbSkillEditorRemove')}>×</button>}
          </td>
        </tr>,
      )
    } else if (Array.isArray(value)) {
      const hasObjects = value.length > 0 && isRecord(value[0])
      rows.push(
        <tr key={pathKey} className="seGrid__sectionRow">
          <td colSpan={3}><div className="seGrid__sectionInner" style={indent ? { paddingLeft: indent } : undefined}>
            <span>{key} [{value.length}]</span>
            <button type="button" className="seGrid__addInline seGrid__addInline--icon" onClick={() => {
              const template = hasObjects && value.length > 0
                ? Object.fromEntries(Object.keys(value[0] as Record<string, unknown>).map(k => [k, '']))
                : ''
              onUpdate(path, [...value, template])
            }} title="+">+</button>
            {showRemove && (
              <button type="button" className="seGrid__addInline seGrid__addInline--icon" onClick={() => onRemove(path)}
                title={tFn('spbSkillEditorRemove')} style={{ marginLeft: 2 }}>×</button>
            )}
          </div></td>
        </tr>,
      )
      if (hasObjects) {
        value.forEach((item, i) => {
          const itemPath = [...path, i]
          const itemPK = itemPath.join('.')
          rows.push(
            <tr key={`${itemPK}.__hdr`} className="seGrid__colHeader">
              <td style={{ paddingLeft: 8 + indent + 20 }}>[{i}]</td>
              <td />
              <td className="seGrid__act">
                <button type="button" onClick={() => onUpdate(path, value.filter((_, j) => j !== i))}
                  title={tFn('spbSkillEditorRemove')}>×</button>
              </td>
            </tr>,
          )
          if (isRecord(item)) {
            rows.push(...renderNestedRows(
              Object.entries(item).map(([k, v]) => ({ key: k, value: v })),
              itemPath, onUpdate, onRemove, tFn, depth + 2, false,
            ))
          }
        })
      } else {
        value.forEach((item, i) => {
          const itemPath = [...path, i]
          rows.push(
            <tr key={itemPath.join('.')}>
              <td className="seGrid__key" style={{ paddingLeft: 8 + indent + 20 }}>[{i}]</td>
              <td className="seGrid__val">
                <input value={String(item ?? '')} onChange={(e) => {
                  const newArr = [...value]
                  const raw = e.target.value
                  if (typeof item === 'number') {
                    const num = Number(raw)
                    newArr[i] = raw !== '' && !isNaN(num) ? num : raw
                  } else { newArr[i] = raw }
                  onUpdate(path, newArr)
                }} />
              </td>
              <td className="seGrid__act">
                <button type="button" onClick={() => onUpdate(path, value.filter((_, j) => j !== i))}
                  title={tFn('spbSkillEditorRemove')}>×</button>
              </td>
            </tr>,
          )
        })
      }
    } else if (isRecord(value)) {
      const subEntries = Object.entries(value).map(([k, v]) => ({ key: k, value: v }))
      rows.push(
        <tr key={pathKey} className="seGrid__sectionRow">
          <td colSpan={3}><div className="seGrid__sectionInner" style={indent ? { paddingLeft: indent } : undefined}>
            <span>{key}</span>
            {showRemove && (
              <button type="button" className="seGrid__addInline seGrid__addInline--icon" onClick={() => onRemove(path)}
                title={tFn('spbSkillEditorRemove')} style={{ marginLeft: 4 }}>×</button>
            )}
          </div></td>
        </tr>,
      )
      rows.push(...renderNestedRows(subEntries, path, onUpdate, onRemove, tFn, depth + 1, true))
    } else {
      // Primitive: string, number, null, undefined
      rows.push(
        <tr key={pathKey}>
          <td className="seGrid__key" style={indent ? { paddingLeft: 8 + indent } : undefined}>{key}</td>
          <td className="seGrid__val">
            <input value={String(value ?? '')} onChange={(e) => {
              const raw = e.target.value
              if (typeof value === 'number') {
                const num = Number(raw)
                onUpdate(path, raw !== '' && !isNaN(num) ? num : raw)
              } else {
                onUpdate(path, raw)
              }
            }} />
          </td>
          <td className="seGrid__act">
            {showRemove && <button type="button" onClick={() => onRemove(path)} title={tFn('spbSkillEditorRemove')}>×</button>}
          </td>
        </tr>,
      )
    }
  }
  return rows
}

export function SkillPipelineRightPane(props: {
  t: (key: TranslationKey) => string
  language: Language
  theme: ThemePreference
  copyToClipboard: (text: string) => Promise<void>
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
  onCollapse: () => void
}) {
  const { t, language, theme, copyToClipboard, profile, apiVersion } = props

  const format = useCallback(
    (key: TranslationKey, params: Record<string, string | number>): string => {
      let text: string = String(t(key) ?? '')
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, String(v))
      }
      return text
    },
    [t],
  )

  const codeMirrorTheme = useMemo(() => {
    const isLight = theme === 'light' || theme === 'solarized'
    return isLight ? githubLight : githubDark
  }, [theme])

  const {
    skillsetName,
    setSkillsetName,
    skillsetDescription,
    setSkillsetDescription,
    indexProjections,
    knowledgeStore,
    indexer,
    setIndexer,
    baselineSkillsetJson,
    setBaselineSkillsetJson,
    nodes,
    setNodes,
    selectedNodeId,
    draftSkillJson,
    setDraftSkillJson,
    draftError,
    setDraftError,
    draftIndexerJson,
    setDraftIndexerJson,
    draftIndexerError,
    setDraftIndexerError,

    draftIndexJson,
    setDraftIndexJson,
    draftIndexError,
    setDraftIndexError,

    debugFetchedDocs,
  } = useSkillPipelineState()

  // ── Enrichment Tree model for path suggestions ───────────────────────────
  const enrichmentModel = useMemo(
    () => buildEnrichmentTreeModel({ nodes, indexer, docRoot: '/document' }),
    [nodes, indexer],
  )

  /** Sorted list of all available enrichment paths for the path picker. */
  const enrichmentPaths = useMemo(
    () => Array.from(enrichmentModel.allPathSet).sort(),
    [enrichmentModel],
  )

  /** Set of paths produced by skill outputs (shown with ◆ in picker). */
  const producedPathSet = enrichmentModel.producedPathSet

  const [saveDiffOpen, setSaveDiffOpen] = useState(false)
  // Baseline JSON fetched from Azure for diff. `null` means "not fetched yet".
  // Empty string "" is a valid baseline representing "does not exist (404)".
  const [publishBeforeJson, setPublishBeforeJson] = useState<string | null>(null)
  const [publishLoading, setPublishLoading] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishOkMessage, setPublishOkMessage] = useState<string | null>(null)

  const makeLineClassExtension = useCallback((lines: Set<number>, className: string) => {
    const deco = Decoration.line({ class: className })

    const build = (view: any) => {
      const b = new RangeSetBuilder<Decoration>()
      const max = view.state.doc.lines
      for (const n of lines) {
        if (n < 1 || n > max) continue
        const line = view.state.doc.line(n)
        b.add(line.from, line.from, deco)
      }
      return b.finish()
    }

    return ViewPlugin.fromClass(
      class {
        decorations: any
        constructor(view: any) {
          this.decorations = build(view)
        }
        update(update: any) {
          if (update.docChanged || update.viewportChanged) this.decorations = build(update.view)
        }
      },
      { decorations: (v: any) => v.decorations },
    )
  }, [])

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedNodeId) ?? null, [nodes, selectedNodeId])
  const selectedSkillNode = useMemo(
    () => (selectedNode && (selectedNode as any)?.data?.kind === 'skill' ? selectedNode : null),
    [selectedNode],
  )

  const selectedIndexerNode = useMemo(
    () => (selectedNode && (selectedNode as any)?.data?.kind === 'indexer' ? selectedNode : null),
    [selectedNode],
  )

  const selectedIndexNode = useMemo(
    () => (selectedNode && (selectedNode as any)?.data?.kind === 'index' ? selectedNode : null),
    [selectedNode],
  )

  const selectedProjectionNode = useMemo(
    () => (selectedNode && (selectedNode as any)?.data?.kind === 'projection' ? selectedNode : null),
    [selectedNode],
  )

  const selectedDocNode = useMemo(
    () => (selectedNode && (selectedNode as any)?.data?.kind === 'doc' ? selectedNode : null),
    [selectedNode],
  )

  // ── Debug values helpers ──────────────────────────────────────────────────

  /** Extract _ragops_field_mappings from the fetched docs payload (if present).
   *  This maps enrichment-tree source paths → field names in the synthetic doc. */
  const ragopsFieldMappings = useMemo(() => {
    const map = new Map<string, string>()
    if (!debugFetchedDocs || !isRecord(debugFetchedDocs)) return map
    const raw = (debugFetchedDocs as Record<string, unknown>)['_ragops_field_mappings']
    if (!raw || !isRecord(raw)) return map
    for (const [path, fieldName] of Object.entries(raw)) {
      if (typeof fieldName === 'string' && fieldName.trim()) map.set(path, fieldName)
    }
    return map
  }, [debugFetchedDocs])

  const fetchedDocRows = useMemo(() => {
    if (!debugFetchedDocs || !isRecord(debugFetchedDocs)) return []
    const raw = (debugFetchedDocs as Record<string, unknown>)['value']
    if (!Array.isArray(raw)) return []
    return raw.filter((x): x is Record<string, unknown> => isRecord(x))
  }, [debugFetchedDocs])

  /** Look up the actual value from fetched docs for a given enrichment path. */
  const lookupValueForPath = useCallback(
    (enrichmentPath: string): unknown => {
      if (fetchedDocRows.length === 0) return undefined
      // 1. Check ragops field mappings (most reliable)
      const fieldName = ragopsFieldMappings.get(enrichmentPath)
      if (fieldName) {
        for (const row of fetchedDocRows) {
          if (fieldName in row) return row[fieldName]
        }
      }
      // 2. Fallback: try matching indexer outputFieldMappings
      if (indexer?.outputFieldMappings) {
        for (const m of indexer.outputFieldMappings) {
          const src = String(m.sourceFieldName || '').trim()
          const tgt = String(m.targetFieldName || '').trim()
          if (src === enrichmentPath && tgt) {
            for (const row of fetchedDocRows) {
              if (tgt in row) return row[tgt]
            }
          }
        }
      }
      return undefined
    },
    [fetchedDocRows, ragopsFieldMappings, indexer],
  )

  const hasDebugData = fetchedDocRows.length > 0

  /** Compute debug detail for the selected skill node: inputs and outputs with actual values. */
  const skillDebugDetail = useMemo(() => {
    if (!selectedSkillNode || !hasDebugData) return null
    const skill = (selectedSkillNode as any)?.data?.skill as SkillPipelineSkillDefinition | undefined
    if (!skill) return null

    const context = typeof skill.context === 'string' && skill.context.trim() ? skill.context.trim() : '/document'
    const normCtx = context.startsWith('/') ? context : `/${context}`

    const inputs = (Array.isArray(skill.inputs) ? skill.inputs : []).map((inp) => {
      const name = typeof inp.name === 'string' ? inp.name : ''
      const source = typeof inp.source === 'string' ? inp.source.trim() : ''
      const value = source ? lookupValueForPath(source) : undefined
      return { name, source, value }
    })

    const outputs = (Array.isArray(skill.outputs) ? skill.outputs : []).map((out) => {
      const outName = typeof out.name === 'string' ? out.name : ''
      const targetName = typeof out.targetName === 'string' ? out.targetName : outName
      const path = targetName ? `${normCtx}/${targetName}` : normCtx
      const value = lookupValueForPath(path)
      return { name: outName, targetName, path, value }
    })

    return { inputs, outputs }
  }, [selectedSkillNode, hasDebugData, lookupValueForPath])

  /** Compute debug detail for the indexer node: outputFieldMappings with actual values. */
  const indexerDebugDetail = useMemo(() => {
    if (!selectedIndexerNode || !hasDebugData) return null
    const ofm = indexer?.outputFieldMappings
    if (!Array.isArray(ofm) || ofm.length === 0) return null

    return ofm.map((m) => {
      const src = String(m.sourceFieldName || '').trim()
      const tgt = String(m.targetFieldName || '').trim()
      let value: unknown = undefined
      for (const row of fetchedDocRows) {
        if (tgt in row) { value = row[tgt]; break }
      }
      if (value === undefined) value = lookupValueForPath(src)
      return { sourceFieldName: src, targetFieldName: tgt, value }
    })
  }, [selectedIndexerNode, hasDebugData, indexer, fetchedDocRows, lookupValueForPath])

  /** Compute debug detail for the document node: show known document source paths. */
  const docDebugDetail = useMemo(() => {
    if (!selectedDocNode || !hasDebugData) return null
    const docPaths = ['/document/content', '/document/metadata_storage_path', '/document/metadata_storage_name']
    const result: Array<{ path: string; value: unknown }> = []
    for (const p of docPaths) {
      const value = lookupValueForPath(p)
      if (value !== undefined) result.push({ path: p, value })
    }
    // Also include any _ragops_field_mappings entries under /document
    for (const [path] of ragopsFieldMappings) {
      if (path.startsWith('/document/') && !result.some((r) => r.path === path)) {
        const value = lookupValueForPath(path)
        if (value !== undefined) result.push({ path, value })
      }
    }
    return result.length > 0 ? result : null
  }, [selectedDocNode, hasDebugData, lookupValueForPath, ragopsFieldMappings])

  const lastSelectedIdRef = useRef<string>('')
  const lastSyncedIndexerJsonRef = useRef<string>('')

  const [showJsonEditor, setShowJsonEditor] = useState(false)
  const [showIndexerJsonEditor, setShowIndexerJsonEditor] = useState(false)

  const DEBUG_VALUES_PAGE_SIZE = 20
  const [debugValueExpanded, setDebugValueExpanded] = useState<Set<string>>(() => new Set())
  const toggleDebugValueExpand = useCallback((key: string) => {
    setDebugValueExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const [debugValuePage, setDebugValuePage] = useState<Record<string, number>>({})
  const getDebugPage = useCallback((section: string) => debugValuePage[section] ?? 0, [debugValuePage])
  const setDebugPage = useCallback((section: string, page: number) => setDebugValuePage((prev) => ({ ...prev, [section]: page })), [])

  // Reset expanded / page state when selection changes.
  useEffect(() => {
    setDebugValueExpanded(new Set())
    setDebugValuePage({})
  }, [selectedNodeId])
  useEffect(() => {
    if (!selectedIndexerNode) return
    const next = indexer ? JSON.stringify(indexer, null, 2) : '{}'
    const selectionChanged = lastSelectedIdRef.current !== selectedIndexerNode.id
    const backingChanged = lastSyncedIndexerJsonRef.current !== next
    const userHasNotEdited = draftIndexerJson === lastSyncedIndexerJsonRef.current

    // Sync on first selection of the indexer node, and also when the backing
    // indexer changes (unless the user has started editing the draft).
    if (selectionChanged || (backingChanged && userHasNotEdited)) {
      setDraftIndexerJson(next)
      setDraftIndexerError(null)
      lastSyncedIndexerJsonRef.current = next
    }

    lastSelectedIdRef.current = selectedIndexerNode.id
  }, [draftIndexerJson, indexer, selectedIndexerNode, setDraftIndexerError, setDraftIndexerJson])

  // ── Skill Editor helpers ──────────────────────────────────────────────────

  /** The current skill object for the structured editor. */
  const selectedSkillObject = useMemo<SkillPipelineSkillDefinition | null>(() => {
    if (!selectedSkillNode) return null
    return ((selectedSkillNode as any)?.data?.skill as SkillPipelineSkillDefinition) ?? null
  }, [selectedSkillNode])

  /** Core field keys that get dedicated editor rows. */
  const SKILL_CORE_KEYS = useMemo(() => new Set(['@odata.type', 'name', 'description', 'context', 'inputs', 'outputs']), [])

  /** Extra (skill-type-specific) properties. */
  const skillExtraProps = useMemo(() => {
    if (!selectedSkillObject) return []
    return Object.entries(selectedSkillObject)
      .filter(([k]) => !SKILL_CORE_KEYS.has(k))
      .map(([k, v]) => ({ key: k, value: v }))
  }, [selectedSkillObject, SKILL_CORE_KEYS])

  /** Push an updated skill object to both the node tree and the draft JSON string. */
  const commitSkillUpdate = useCallback(
    (updatedSkill: Record<string, unknown>) => {
      setNodes((prev) =>
        prev.map((n) =>
          n.id === selectedNodeId && (n as any)?.data?.kind === 'skill'
            ? ({ ...n, data: { ...(n.data ?? {}), kind: 'skill', skill: updatedSkill } } as any)
            : n,
        ),
      )
      setDraftSkillJson(JSON.stringify(updatedSkill, null, 2))
      setDraftError(null)
    },
    [selectedNodeId, setNodes, setDraftSkillJson, setDraftError],
  )

  /** Update a single top-level field on the skill. */
  const updateSkillField = useCallback(
    (key: string, value: unknown) => {
      if (!selectedSkillObject) return
      const updated = { ...selectedSkillObject, [key]: value }
      commitSkillUpdate(updated)
    },
    [selectedSkillObject, commitSkillUpdate],
  )

  /** Remove a top-level property from the skill. */
  const removeSkillField = useCallback(
    (key: string) => {
      if (!selectedSkillObject) return
      const updated = { ...selectedSkillObject }
      delete (updated as any)[key]
      commitSkillUpdate(updated)
    },
    [selectedSkillObject, commitSkillUpdate],
  )

  /** Update a specific input entry. */
  const updateSkillInput = useCallback(
    (index: number, field: 'name' | 'source', value: string) => {
      if (!selectedSkillObject) return
      const inputs = [...(selectedSkillObject.inputs || [])]
      inputs[index] = { ...inputs[index], [field]: value }
      commitSkillUpdate({ ...selectedSkillObject, inputs })
    },
    [selectedSkillObject, commitSkillUpdate],
  )

  /** Update a specific output entry. */
  const updateSkillOutput = useCallback(
    (index: number, field: 'name' | 'targetName', value: string) => {
      if (!selectedSkillObject) return
      const outputs = [...(selectedSkillObject.outputs || [])]
      outputs[index] = { ...outputs[index], [field]: value }
      commitSkillUpdate({ ...selectedSkillObject, outputs })
    },
    [selectedSkillObject, commitSkillUpdate],
  )

  const addSkillInput = useCallback(() => {
    if (!selectedSkillObject) return
    const inputs = [...(selectedSkillObject.inputs || []), { name: '', source: '' }]
    commitSkillUpdate({ ...selectedSkillObject, inputs })
  }, [selectedSkillObject, commitSkillUpdate])

  const removeSkillInput = useCallback(
    (index: number) => {
      if (!selectedSkillObject) return
      const inputs = (selectedSkillObject.inputs || []).filter((_, i) => i !== index)
      commitSkillUpdate({ ...selectedSkillObject, inputs })
    },
    [selectedSkillObject, commitSkillUpdate],
  )

  const addSkillOutput = useCallback(() => {
    if (!selectedSkillObject) return
    const outputs = [...(selectedSkillObject.outputs || []), { name: '', targetName: '' }]
    commitSkillUpdate({ ...selectedSkillObject, outputs })
  }, [selectedSkillObject, commitSkillUpdate])

  const removeSkillOutput = useCallback(
    (index: number) => {
      if (!selectedSkillObject) return
      const outputs = (selectedSkillObject.outputs || []).filter((_, i) => i !== index)
      commitSkillUpdate({ ...selectedSkillObject, outputs })
    },
    [selectedSkillObject, commitSkillUpdate],
  )

  /** State for adding a new extra property. */
  const [newPropKey, setNewPropKey] = useState('')

  const addExtraProperty = useCallback(() => {
    if (!selectedSkillObject || !newPropKey.trim()) return
    commitSkillUpdate({ ...selectedSkillObject, [newPropKey.trim()]: '' })
    setNewPropKey('')
  }, [selectedSkillObject, commitSkillUpdate, newPropKey])

  /** Smartly update an extra property value — detect type and parse. */
  const updateExtraProperty = useCallback(
    (key: string, rawValue: string) => {
      if (!selectedSkillObject) return
      let parsed: unknown = rawValue
      // Try to detect JSON (arrays, objects, booleans, numbers, null)
      const trimmed = rawValue.trim()
      if (trimmed === 'true') parsed = true
      else if (trimmed === 'false') parsed = false
      else if (trimmed === 'null') parsed = null
      else if (/^-?\d+(\.\d+)?$/.test(trimmed) && trimmed !== '') parsed = Number(trimmed)
      else if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        try { parsed = JSON.parse(trimmed) } catch { parsed = rawValue }
      }
      commitSkillUpdate({ ...selectedSkillObject, [key]: parsed })
    },
    [selectedSkillObject, commitSkillUpdate],
  )

  /** Path-based nested update for the skill object (used by renderNestedRows). */
  const onNestedSkillUpdate = useCallback(
    (path: (string | number)[], value: unknown) => {
      if (!selectedSkillObject) return
      commitSkillUpdate(setAtPath(selectedSkillObject, path, value) as Record<string, unknown>)
    },
    [selectedSkillObject, commitSkillUpdate],
  )

  /** Path-based nested remove for the skill object. */
  const onNestedSkillRemove = useCallback(
    (path: (string | number)[]) => {
      if (!selectedSkillObject) return
      commitSkillUpdate(removeAtPath(selectedSkillObject, path) as Record<string, unknown>)
    },
    [selectedSkillObject, commitSkillUpdate],
  )

  // ── Indexer Editor helpers ────────────────────────────────────────────────

  /** Core field keys for the indexer that get dedicated editor rows. */
  const INDEXER_CORE_KEYS = useMemo(
    () => new Set(['name', 'dataSourceName', 'targetIndexName', 'skillsetName', 'fieldMappings', 'outputFieldMappings', 'parameters']),
    [],
  )

  /** Extra (indexer-specific) properties beyond core keys. */
  const indexerExtraProps = useMemo(() => {
    if (!indexer) return []
    return Object.entries(indexer)
      .filter(([k]) => !INDEXER_CORE_KEYS.has(k))
      .map(([k, v]) => ({ key: k, value: v }))
  }, [indexer, INDEXER_CORE_KEYS])

  /** Push an updated indexer object and sync draft JSON. */
  const commitIndexerUpdate = useCallback(
    (updated: Record<string, unknown>) => {
      setIndexer(updated as any)
      const next = JSON.stringify(updated, null, 2)
      setDraftIndexerJson(next)
      lastSyncedIndexerJsonRef.current = next
      setDraftIndexerError(null)
    },
    [setIndexer, setDraftIndexerJson, setDraftIndexerError],
  )

  /** Update a single field on the indexer. */
  const updateIndexerField = useCallback(
    (key: string, value: unknown) => {
      if (!indexer) return
      commitIndexerUpdate({ ...indexer, [key]: value })
    },
    [indexer, commitIndexerUpdate],
  )

  /** Remove a field from the indexer. */
  const removeIndexerField = useCallback(
    (key: string) => {
      if (!indexer) return
      const updated = { ...indexer }
      delete (updated as any)[key]
      commitIndexerUpdate(updated)
    },
    [indexer, commitIndexerUpdate],
  )

  /** Update a specific fieldMapping entry. */
  const updateFieldMapping = useCallback(
    (index: number, field: 'sourceFieldName' | 'targetFieldName', value: string) => {
      if (!indexer) return
      const arr = [...(indexer.fieldMappings || [])]
      arr[index] = { ...arr[index], [field]: value }
      commitIndexerUpdate({ ...indexer, fieldMappings: arr })
    },
    [indexer, commitIndexerUpdate],
  )

  const addFieldMapping = useCallback(() => {
    if (!indexer) return
    const arr = [...(indexer.fieldMappings || []), { sourceFieldName: '', targetFieldName: '' }]
    commitIndexerUpdate({ ...indexer, fieldMappings: arr })
  }, [indexer, commitIndexerUpdate])

  const removeFieldMapping = useCallback(
    (index: number) => {
      if (!indexer) return
      const arr = (indexer.fieldMappings || []).filter((_, i) => i !== index)
      commitIndexerUpdate({ ...indexer, fieldMappings: arr })
    },
    [indexer, commitIndexerUpdate],
  )

  /** Update a specific outputFieldMapping entry. */
  const updateOutputFieldMapping = useCallback(
    (index: number, field: 'sourceFieldName' | 'targetFieldName', value: string) => {
      if (!indexer) return
      const arr = [...(indexer.outputFieldMappings || [])]
      arr[index] = { ...arr[index], [field]: value }
      commitIndexerUpdate({ ...indexer, outputFieldMappings: arr })
    },
    [indexer, commitIndexerUpdate],
  )

  const addOutputFieldMapping = useCallback(() => {
    if (!indexer) return
    const arr = [...(indexer.outputFieldMappings || []), { sourceFieldName: '', targetFieldName: '' }]
    commitIndexerUpdate({ ...indexer, outputFieldMappings: arr })
  }, [indexer, commitIndexerUpdate])

  const removeOutputFieldMapping = useCallback(
    (index: number) => {
      if (!indexer) return
      const arr = (indexer.outputFieldMappings || []).filter((_, i) => i !== index)
      commitIndexerUpdate({ ...indexer, outputFieldMappings: arr })
    },
    [indexer, commitIndexerUpdate],
  )

  /** State for adding a new extra indexer property. */
  const [newIndexerPropKey, setNewIndexerPropKey] = useState('')

  const addIndexerExtraProperty = useCallback(() => {
    if (!indexer || !newIndexerPropKey.trim()) return
    commitIndexerUpdate({ ...indexer, [newIndexerPropKey.trim()]: '' })
    setNewIndexerPropKey('')
  }, [indexer, commitIndexerUpdate, newIndexerPropKey])

  /** Smartly parse extra property values for indexer. */
  const updateIndexerExtraProperty = useCallback(
    (key: string, rawValue: string) => {
      if (!indexer) return
      let parsed: unknown = rawValue
      const trimmed = rawValue.trim()
      if (trimmed === 'true') parsed = true
      else if (trimmed === 'false') parsed = false
      else if (trimmed === 'null') parsed = null
      else if (/^-?\d+(\.\d+)?$/.test(trimmed) && trimmed !== '') parsed = Number(trimmed)
      else if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
        try { parsed = JSON.parse(trimmed) } catch { parsed = rawValue }
      }
      commitIndexerUpdate({ ...indexer, [key]: parsed })
    },
    [indexer, commitIndexerUpdate],
  )

  /** Path-based nested update for the indexer object (used by renderNestedRows). */
  const onNestedIndexerUpdate = useCallback(
    (path: (string | number)[], value: unknown) => {
      if (!indexer) return
      commitIndexerUpdate(setAtPath(indexer, path, value) as Record<string, unknown>)
    },
    [indexer, commitIndexerUpdate],
  )

  /** Path-based nested remove for the indexer object. */
  const onNestedIndexerRemove = useCallback(
    (path: (string | number)[]) => {
      if (!indexer) return
      commitIndexerUpdate(removeAtPath(indexer, path) as Record<string, unknown>)
    },
    [indexer, commitIndexerUpdate],
  )

  const skillsetObject = useMemo(() => {
    const name = skillsetName.trim() || 'skillset1'
    const description = skillsetDescription.trim()

    const skillNodes = nodes.filter((n) => (n as any)?.data?.kind === 'skill')

    // Preserve the exact skill JSON structure stored in nodes.
    const skills = skillNodes.map((n) => ensureJsonObject((n as any).data?.skill))

    const base: Record<string, unknown> = { name, skills }
    if (description) base.description = description
    if (indexProjections) base.indexProjections = indexProjections
    if (knowledgeStore) base.knowledgeStore = knowledgeStore
    return base
  }, [nodes, skillsetDescription, skillsetName, indexProjections, knowledgeStore])

  const skillsetJson = useMemo(() => JSON.stringify(skillsetObject, null, 2), [skillsetObject])

  const parseJsonOrEmpty = (text: string): Record<string, unknown> => {
    const s = text.trim()
    if (!s) return {}
    try {
      const v = JSON.parse(s)
      return isRecord(v) ? v : {}
    } catch {
      return {}
    }
  }

  const stripServiceMeta = (obj: Record<string, unknown>): Record<string, unknown> => {
    const next: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k === '@odata.etag') continue
      next[k] = v
    }
    return next
  }

  const publishBaselineText = useMemo(() => {
    return publishBeforeJson !== null ? publishBeforeJson : baselineSkillsetJson
  }, [baselineSkillsetJson, publishBeforeJson])

  const publishCandidateObject = useMemo(() => {
    const name = skillsetName.trim() || 'skillset1'
    const base = stripServiceMeta(parseJsonOrEmpty(publishBaselineText || ''))

    // Overlay the current draft into skills when it is valid.
    let draftOverlay: Record<string, unknown> | null = null
    if (!draftError && selectedNodeId) {
      const raw = draftSkillJson.trim()
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (isRecord(parsed)) draftOverlay = parsed
        } catch {
          // ignore; fall back to node data
        }
      }
    }

    const skillNodes = nodes.filter((n) => (n as any)?.data?.kind === 'skill')
    const skills = skillNodes.map((n) => {
      if (draftOverlay && n.id === selectedNodeId) return draftOverlay
      return ensureJsonObject((n as any).data?.skill)
    })

    const nextBody: Record<string, unknown> = {
      ...base,
      name,
      skills,
    }

    const desc = skillsetDescription.trim()
    if (desc) nextBody.description = desc
    else delete nextBody.description

    if (indexProjections) nextBody.indexProjections = indexProjections
    else delete nextBody.indexProjections

    if (knowledgeStore) nextBody.knowledgeStore = knowledgeStore
    else delete nextBody.knowledgeStore

    return nextBody
  }, [draftError, draftSkillJson, indexProjections, knowledgeStore, nodes, publishBaselineText, selectedNodeId, skillsetDescription, skillsetName])

  const publishCandidateJson = useMemo(() => JSON.stringify(publishCandidateObject, null, 2), [publishCandidateObject])

  const diffLineSets = useMemo(() => {
    const a = (publishBaselineText || '') ?? ''
    const b = publishCandidateJson ?? ''
    const parts = diffLines(a, b)

    const left = new Set<number>()
    const right = new Set<number>()

    let l = 1
    let r = 1
    const countLines = (text: string) => {
      if (!text) return 0
      const lines = text.split('\n')
      // diffLines keeps trailing '\n' in value; ignore final empty line for counting.
      if (lines.length && lines[lines.length - 1] === '') return lines.length - 1
      return lines.length
    }

    for (const p of parts) {
      const c = countLines(p.value)
      if (!c) continue

      if ((p as any).added) {
        for (let i = 0; i < c; i++) right.add(r + i)
        r += c
        continue
      }
      if ((p as any).removed) {
        for (let i = 0; i < c; i++) left.add(l + i)
        l += c
        continue
      }

      l += c
      r += c
    }

    return { left, right }
  }, [publishBaselineText, publishCandidateJson])

  const onSaveClick = async () => {
    if (!profile) {
      setPublishError(String((translations as any)[language]?.restErrorProfileUnset ?? t('spbRightPaneErrProfileNotSet')))
      return
    }

    const name = skillsetName.trim() || 'skillset1'
    setPublishOkMessage(null)
    setPublishError(null)
    setPublishLoading(true)

    try {
      // Fetch remote baseline so diff is against the actual service state.
      const res = await getSkillset({ profile, skillsetName: name, apiVersion, language })
      if (res.ok) {
        const obj = res.response as any
        const { ['@odata.etag']: _etag, ...rest } = obj && typeof obj === 'object' ? obj : ({} as any)
        setPublishBeforeJson(JSON.stringify(rest, null, 2))
      } else {
        // 404 => new skillset; show empty baseline
        if (res.status === 404) {
          setPublishBeforeJson('')
        } else {
          setPublishError(res.error.message)
          return
        }
      }

      setSaveDiffOpen(true)
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e))
    } finally {
      setPublishLoading(false)
    }
  }

  const publishToAzure = async () => {
    if (!profile) {
      setPublishError(String((translations as any)[language]?.restErrorProfileUnset ?? t('spbRightPaneErrProfileNotSet')))
      return
    }

    const name = skillsetName.trim() || 'skillset1'
    setPublishOkMessage(null)
    setPublishError(null)
    setPublishLoading(true)

    try {
      const put = await createOrUpdateSkillset({ profile, skillsetName: name, apiVersion, language, body: publishCandidateObject as any })
      if (!put.ok) {
        setPublishError(put.error.message)
        return
      }

      setPublishOkMessage(t('spbPublishOk'))
      setPublishBeforeJson(JSON.stringify(publishCandidateObject, null, 2))
      // Keep baseline in sync for subsequent diffs.
      setBaselineSkillsetJson(JSON.stringify(publishCandidateObject, null, 2))
      setSaveDiffOpen(false)
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e))
    } finally {
      setPublishLoading(false)
    }
  }

  const applyDraftToSelected = () => {
    if (!selectedSkillNode) return

    const raw = draftSkillJson.trim()
    if (!raw) {
      setDraftError(format('spbInvalidJson', { error: 'empty' }))
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      setDraftError(format('spbInvalidJson', { error: e instanceof Error ? e.message : String(e) }))
      return
    }

    if (!isRecord(parsed)) {
      setDraftError(format('spbInvalidJson', { error: 'root must be an object' }))
      return
    }

    setNodes((prev) =>
      prev.map((n) =>
        n.id === selectedNodeId && (n as any)?.data?.kind === 'skill'
          ? ({ ...n, data: { ...(n.data ?? {}), kind: 'skill', skill: parsed } } as any)
          : n,
      ),
    )
    setDraftError(null)
  }

  const applyDraftToIndexer = () => {
    if (!selectedIndexerNode) return

    const raw = draftIndexerJson.trim()
    if (!raw) {
      setDraftIndexerError(format('spbInvalidJson', { error: 'empty' }))
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      setDraftIndexerError(format('spbInvalidJson', { error: e instanceof Error ? e.message : String(e) }))
      return
    }

    if (!isRecord(parsed)) {
      setDraftIndexerError(format('spbInvalidJson', { error: 'root must be an object' }))
      return
    }

    setIndexer(parsed as any)
    setDraftIndexerError(null)

    // Mark the current draft as in-sync so future indexer state updates don't
    // unexpectedly overwrite user edits.
    lastSyncedIndexerJsonRef.current = raw
  }

  const copySkillset = async () => {
    await copyToClipboard(skillsetJson)
  }

  return (
    <section className="pane pane--right">
      <div className="pane__header">
        <div className="pane__title">{t('skillPipelineBuilder')}</div>
        <button
          type="button"
          className="btn btn--icon"
          aria-label={t('spbRightPaneHide')}
          title={t('spbRightPaneHide')}
          onClick={props.onCollapse}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M9 5v14l7-7z" fill="currentColor" />
          </svg>
        </button>
      </div>

      <div className="section pane__scroll">
        {!selectedSkillNode && !selectedIndexerNode && (
          <>
        <div className="section__title">{t('spbRightPaneSkillset')}</div>

        {publishError ? <div className="notice notice--error builder__notice">{String(publishError)}</div> : null}
        {publishOkMessage ? <div className="notice builder__notice">{String(publishOkMessage)}</div> : null}

        <div className="form" style={{ marginBottom: 10 }}>
          <label className="field">
            <span className="field__label">{t('spbSkillsetName')}</span>
            <input className="field__input" value={skillsetName} onChange={(e) => setSkillsetName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field__label">{t('spbSkillsetDescription')}</span>
            <input
              className="field__input"
              value={skillsetDescription}
              onChange={(e) => setSkillsetDescription(e.target.value)}
            />
          </label>
        </div>

        <div className="actions actions--mb10">
          <button type="button" className="btn" onClick={copySkillset}>
            <i className="bi bi-clipboard"></i> {t('spbCopySkillsetJson')}
          </button>
          <button type="button" className="btn" onClick={onSaveClick} disabled={publishLoading}>
            {publishLoading ? t('spbPublishing') : t('spbPublish')}
          </button>
        </div>

        {saveDiffOpen ? (
          <div className="modal-overlay" onClick={() => setSaveDiffOpen(false)}>
            <div
              className="modal-content"
              onClick={(e) => e.stopPropagation()}
              style={{ width: '96vw', maxWidth: 1600, minWidth: 760, maxHeight: '94vh' }}
            >
              <div className="modal-header">
                <h2>{t('spbSaveConfirmTitle')}</h2>
                <button type="button" className="btn" onClick={() => setSaveDiffOpen(false)}>
                  ✕
                </button>
              </div>
              <div className="modal-body" style={{ padding: 12 }}>
                <div className="section__hint" style={{ marginBottom: 10 }}>
                  {t('spbSaveConfirmHint')}
                </div>

                {publishBaselineText === publishCandidateJson ? (
                  <div className="notice">{t('spbSaveNoChanges')}</div>
                ) : null}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className="skillset-diff-editor">
                    <div className="section__title" style={{ marginTop: 0 }}>
                      {t('spbSaveDiffBefore')}
                    </div>
                    <ExpandableCodeMirror
                      t={(k) => String(translations[language][k] ?? '')}
                      modalTitle={t('spbSaveDiffBefore')}
                      value={publishBaselineText}
                      height="520px"
                      theme={codeMirrorTheme}
                      extensions={[
                        json(),
                        EditorView.lineWrapping,
                        EditorView.editable.of(false),
                        makeLineClassExtension(diffLineSets.left, 'cm-diff-removed'),
                      ]}
                      onChange={() => {
                        // read-only
                      }}
                    />
                  </div>

                  <div className="skillset-diff-editor">
                    <div className="section__title" style={{ marginTop: 0 }}>
                      {t('spbSaveDiffAfter')}
                    </div>
                    <ExpandableCodeMirror
                      t={(k) => String(translations[language][k] ?? '')}
                      modalTitle={t('spbSaveDiffAfter')}
                      value={publishCandidateJson}
                      height="520px"
                      theme={codeMirrorTheme}
                      extensions={[
                        json(),
                        EditorView.lineWrapping,
                        EditorView.editable.of(false),
                        makeLineClassExtension(diffLineSets.right, 'cm-diff-added'),
                      ]}
                      onChange={() => {
                        // read-only
                      }}
                    />
                  </div>
                </div>

                <div className="actions" style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button type="button" className="btn" onClick={() => setSaveDiffOpen(false)}>
                    {t('spbSaveConfirmCancel')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      publishToAzure()
                    }}
                    disabled={publishBaselineText === publishCandidateJson || publishLoading}
                    title={publishBaselineText === publishCandidateJson ? t('spbSaveNoChanges') : ''}
                  >
                    {publishLoading ? t('spbPublishing') : t('spbPublish')}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
          </>
        )}

        <div className="section__title" style={{ marginTop: 14 }}>
          {selectedProjectionNode ? t('spbSelectedIndexProjectionsJson') : selectedSkillNode ? t('spbSkillEditorTitle') : t('spbSelectedSkillJson')}
        </div>

        {!selectedSkillNode && !selectedIndexerNode && !selectedIndexNode && !selectedProjectionNode && !selectedDocNode && <div className="empty">{t('spbRightPaneNoSelection')}</div>}

        {selectedSkillNode && selectedSkillObject && (() => {
          // ── Dynamic skill execution explanation ──
          const ctx = (selectedSkillObject.context ?? '').trim() || '/document'
          const isLoop = ctx.includes('/*')
          const contextBase = isLoop ? ctx.replace(/\/\*$/, '') : ctx

          const explanationLines: string[] = []
          const warnings: string[] = []

          // Validate context
          if (ctx && !ctx.startsWith('/')) {
            warnings.push(t('spbSkillExplainWarnContextNoSlash'))
          }

          // Context line
          if (isLoop) {
            explanationLines.push(format('spbSkillExplainContextLoop', { path: contextBase }))
          } else {
            explanationLines.push(t('spbSkillExplainContextOnce'))
          }
          // Input lines + validation
          for (const inp of (selectedSkillObject.inputs || [])) {
            const src = (inp.source ?? '').trim()
            const name = (inp.name ?? '').trim()
            if (!name && src) {
              warnings.push(t('spbSkillExplainWarnInputNameEmpty'))
              continue
            }
            if (name && !src) {
              warnings.push(format('spbSkillExplainWarnSourceEmpty', { name }))
              continue
            }
            if (!src || !name) continue

            if (isLoop && src === ctx) {
              explanationLines.push(format('spbSkillExplainInputSameAsCtx', { name }))
            } else if (isLoop && !src.startsWith(ctx.replace('/*', '/'))) {
              // Source is outside the loop scope — could be intentional (shared value) or a mistake
              // Check if source is an ancestor of context (valid shared value)
              const ctxSegments = contextBase.split('/').filter(Boolean)
              const srcSegments = src.replace(/\/\*$/, '').split('/').filter(Boolean)
              const isAncestor = srcSegments.length < ctxSegments.length && ctxSegments.slice(0, srcSegments.length).join('/') === srcSegments.join('/')
              if (isAncestor || src === '/document' || src.startsWith('/document/') && !src.startsWith(contextBase + '/')) {
                explanationLines.push(format('spbSkillExplainInputOutsideLoop', { source: src, name }))
              } else {
                explanationLines.push(format('spbSkillExplainInputOutsideLoop', { source: src, name }))
                warnings.push(format('spbSkillExplainWarnSourceNotUnderCtx', { name, source: src, context: ctx }))
              }
            } else if (isLoop && src.startsWith(contextBase + '/') && !src.includes('/*')) {
              // Source is under context base but missing /* — passing array not element
              explanationLines.push(format('spbSkillExplainInputDirect', { source: src, name }))
              warnings.push(format('spbSkillExplainWarnLoopSourceNeedsWild', { name, source: src }))
            } else {
              explanationLines.push(format('spbSkillExplainInputDirect', { source: src, name }))
            }
          }
          // Output lines
          const normCtx = ctx.startsWith('/') ? ctx : `/${ctx}`
          for (const out of (selectedSkillObject.outputs || [])) {
            const outName = (out.name ?? '').trim()
            const targetName = (out.targetName ?? '').trim() || outName
            if (!targetName) continue
            const normCtxBase = normCtx.endsWith('/*') ? normCtx.replace(/\/\*$/, '') : normCtx
            const outPath = `${normCtxBase}/${targetName}`
            explanationLines.push(format('spbSkillExplainOutputTarget', { path: outPath }))
          }

          const explainDismissed = debugValueExpanded.has('__explain_dismissed__')

          // ── Auto-suggest context from inputs ──
          // Rule: find the deepest `/*` path among sources. If none, `/document`.
          let suggestedContext = '/document'
          for (const inp of (selectedSkillObject.inputs || [])) {
            const src = (inp.source ?? '').trim()
            if (!src) continue
            // Find the deepest /* segment
            const wildIdx = src.lastIndexOf('/*')
            if (wildIdx >= 0) {
              const candidate = src.slice(0, wildIdx + 2) // e.g. /document/pages/*
              if (candidate.split('/').length > suggestedContext.split('/').length) {
                suggestedContext = candidate
              }
            }
          }
          const contextMismatch = ctx !== suggestedContext && suggestedContext !== '/document'

          return (
          <div className="skillEditor">
            {draftError && <div className="notice notice--error builder__notice">{draftError}</div>}

            {/* Warnings always shown */}
            {warnings.length > 0 && (
              <div className="seExplain seExplain--warn">
                <ul className="seExplain__list">
                  {warnings.map((w, i) => (
                    <li key={i} className="seExplain__item seExplain__item--warn">{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Dynamic skill execution explanation — dismissible */}
            {!explainDismissed && explanationLines.length > 0 && (
              <div className="seExplain">
                <div className="seExplain__header">
                  <i className="bi bi-lightbulb" style={{ marginRight: 5, color: 'var(--accent)' }}></i>
                  {t('spbSkillExplainTitle')}
                  <button type="button" className="seExplain__close" onClick={() => toggleDebugValueExpand('__explain_dismissed__')} title="×">×</button>
                </div>
                <ul className="seExplain__list">
                  {explanationLines.map((line, i) => (
                    <li key={i} className={line.startsWith('→') ? 'seExplain__item seExplain__item--sub' : 'seExplain__item'}>{line}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Single unified spreadsheet grid */}
            <table className="seGrid">
              <colgroup>
                <col className="seGrid__colKey" />
                <col className="seGrid__colVal" />
                <col className="seGrid__colAct" />
              </colgroup>
              <tbody>
                {/* ── Section: Core ─────────────────────────── */}
                <tr className="seGrid__sectionRow">
                  <td colSpan={3}><div className="seGrid__sectionInner">{t('spbSkillEditorCore')}</div></td>
                </tr>
                <tr>
                  <td className="seGrid__key">@odata.type</td>
                  <td className="seGrid__val" colSpan={2}>
                    <input value={selectedSkillObject['@odata.type'] ?? ''} readOnly tabIndex={-1} />
                  </td>
                </tr>
                <tr>
                  <td className="seGrid__key">name</td>
                  <td className="seGrid__val" colSpan={2}>
                    <input value={selectedSkillObject.name ?? ''} onChange={(e) => updateSkillField('name', e.target.value)} />
                  </td>
                </tr>
                <tr>
                  <td className="seGrid__key">description</td>
                  <td className="seGrid__val" colSpan={2}>
                    <input value={selectedSkillObject.description ?? ''} onChange={(e) => updateSkillField('description', e.target.value)} />
                  </td>
                </tr>
                <tr>
                  <td className="seGrid__key">context</td>
                  <td className="seGrid__val" colSpan={2}>
                    <EnrichmentPathPicker
                      value={selectedSkillObject.context ?? ''}
                      onChange={(v) => updateSkillField('context', v)}
                      paths={enrichmentPaths}
                      producedPaths={producedPathSet}
                      language={language}
                      placeholder="/document"
                    />
                    {contextMismatch && (
                      <div className="seGrid__suggest">
                        <span className="seGrid__suggestText">
                          💡 {format('spbSkillExplainSuggestContext', { suggested: suggestedContext })}
                        </span>
                        <button type="button" className="seGrid__suggestBtn" onClick={() => updateSkillField('context', suggestedContext)}>
                          {t('spbSkillExplainSuggestApply')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>

                {/* ── Section: Inputs ───────────────────────── */}
                <tr className="seGrid__sectionRow">
                  <td colSpan={3}><div className="seGrid__sectionInner">
                    <span>{t('spbSkillEditorInputs')}</span>
                    <button type="button" className="seGrid__addInline seGrid__addInline--icon" onClick={addSkillInput} title={t('spbSkillEditorAddInput')}>+</button>
                  </div></td>
                </tr>
                <tr className="seGrid__colHeader">
                  <td>name</td>
                  <td>source</td>
                  <td />
                </tr>
                {(selectedSkillObject.inputs || []).map((inp, i) => (
                  <tr key={`in-${i}`}>
                    <td className="seGrid__val">
                      <input value={inp.name} onChange={(e) => updateSkillInput(i, 'name', e.target.value)} />
                    </td>
                    <td className="seGrid__val">
                      <EnrichmentPathPicker
                        value={inp.source}
                        onChange={(v) => updateSkillInput(i, 'source', v)}
                        paths={enrichmentPaths}
                        producedPaths={producedPathSet}
                        language={language}
                        placeholder="/document/content"
                      />
                    </td>
                    <td className="seGrid__act">
                      <button type="button" onClick={() => removeSkillInput(i)} title={t('spbSkillEditorRemove')}>×</button>
                    </td>
                  </tr>
                ))}

                {/* ── Section: Outputs ──────────────────────── */}
                <tr className="seGrid__sectionRow">
                  <td colSpan={3}><div className="seGrid__sectionInner">
                    <span>{t('spbSkillEditorOutputs')}</span>
                    <button type="button" className="seGrid__addInline seGrid__addInline--icon" onClick={addSkillOutput} title={t('spbSkillEditorAddOutput')}>+</button>
                  </div></td>
                </tr>
                <tr className="seGrid__colHeader">
                  <td>name</td>
                  <td>targetName</td>
                  <td />
                </tr>
                {(selectedSkillObject.outputs || []).map((out, i) => (
                  <tr key={`out-${i}`}>
                    <td className="seGrid__val">
                      <input value={out.name} onChange={(e) => updateSkillOutput(i, 'name', e.target.value)} />
                    </td>
                    <td className="seGrid__val">
                      <input value={out.targetName ?? ''} onChange={(e) => updateSkillOutput(i, 'targetName', e.target.value)} />
                    </td>
                    <td className="seGrid__act">
                      <button type="button" onClick={() => removeSkillOutput(i)} title={t('spbSkillEditorRemove')}>×</button>
                    </td>
                  </tr>
                ))}

                {/* ── Section: Extra Properties ────────────── */}
                {skillExtraProps.length > 0 && (
                  <>
                    <tr className="seGrid__sectionRow">
                      <td colSpan={3}><div className="seGrid__sectionInner">{t('spbSkillEditorExtraProps')}</div></td>
                    </tr>
                    {renderNestedRows(skillExtraProps, [], onNestedSkillUpdate, onNestedSkillRemove, t as (k: string) => string, 1)}
                  </>
                )}

                {/* ── Add Property row ─────────────────────── */}
                <tr className="seGrid__addRow">
                  <td className="seGrid__val">
                    <input
                      placeholder={t('spbSkillEditorPropKeyPlaceholder')}
                      value={newPropKey}
                      onChange={(e) => setNewPropKey(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') addExtraProperty() }}
                    />
                  </td>
                  <td colSpan={2}>
                    <button type="button" className="seGrid__addInline seGrid__addInline--label" onClick={addExtraProperty} disabled={!newPropKey.trim()}>
                      + {t('spbSkillEditorAddProperty')}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>

            {/* ── Advanced: JSON Editor (collapsible) ──────── */}
            <div className="skillEditor__jsonToggle">
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setShowJsonEditor((p) => !p)}>
                {showJsonEditor ? '▾' : '▸'} {t('spbSkillEditorAdvancedJson')}
              </button>
            </div>

            {showJsonEditor && (
              <>
                <ExpandableCodeMirror
                  t={(k) => String(translations[language][k] ?? '')}
                  modalTitle={t('spbSelectedSkillJson')}
                  value={draftSkillJson}
                  height="520px"
                  theme={codeMirrorTheme}
                  extensions={[json(), EditorView.lineWrapping]}
                  onChange={(v) => {
                    setDraftSkillJson(v)
                    if (draftError) setDraftError(null)
                  }}
                />
                <div className="actions actions--mb10" style={{ marginTop: 10 }}>
                  <button type="button" className="btn" onClick={applyDraftToSelected} disabled={!selectedSkillNode}>
                    {t('spbApply')}
                  </button>
                </div>
              </>
            )}
          </div>
        )
        })()}

        {selectedProjectionNode && (
          <>
            <ExpandableCodeMirror
              t={(k) => String(translations[language][k] ?? '')}
              modalTitle={t('spbSelectedIndexProjectionsJson')}
              value={JSON.stringify(indexProjections ?? {}, null, 2)}
              height="520px"
              theme={codeMirrorTheme}
              extensions={[json(), EditorView.lineWrapping, EditorView.editable.of(false)]}
              onChange={() => {
                // read-only
              }}
            />
          </>
        )}

        {selectedIndexerNode && indexer && (
          <div className="skillEditor">
            <div className="section__title" style={{ marginTop: 0 }}>
              {t('spbIndexerEditorTitle')}
            </div>

            {draftIndexerError && <div className="notice notice--error builder__notice">{draftIndexerError}</div>}

            <table className="seGrid">
              <colgroup>
                <col className="seGrid__colKey" />
                <col className="seGrid__colVal" />
                <col className="seGrid__colAct" />
              </colgroup>
              <tbody>
                {/* ── Section: Core ─────────────────────────── */}
                <tr className="seGrid__sectionRow">
                  <td colSpan={3}><div className="seGrid__sectionInner">{t('spbSkillEditorCore')}</div></td>
                </tr>
                <tr>
                  <td className="seGrid__key">name</td>
                  <td className="seGrid__val" colSpan={2}>
                    <input value={indexer.name ?? ''} onChange={(e) => updateIndexerField('name', e.target.value)} />
                  </td>
                </tr>
                <tr>
                  <td className="seGrid__key">dataSourceName</td>
                  <td className="seGrid__val" colSpan={2}>
                    <input value={indexer.dataSourceName ?? ''} onChange={(e) => updateIndexerField('dataSourceName', e.target.value)} />
                  </td>
                </tr>
                <tr>
                  <td className="seGrid__key">targetIndexName</td>
                  <td className="seGrid__val" colSpan={2}>
                    <input value={indexer.targetIndexName ?? ''} onChange={(e) => updateIndexerField('targetIndexName', e.target.value)} />
                  </td>
                </tr>
                <tr>
                  <td className="seGrid__key">skillsetName</td>
                  <td className="seGrid__val" colSpan={2}>
                    <input value={indexer.skillsetName ?? ''} onChange={(e) => updateIndexerField('skillsetName', e.target.value)} />
                  </td>
                </tr>
                {/* ── parameters (recursively expanded) ───── */}
                {indexer.parameters != null && isRecord(indexer.parameters) ? (
                  <>
                    <tr className="seGrid__sectionRow">
                      <td colSpan={3}><div className="seGrid__sectionInner"><span>parameters</span></div></td>
                    </tr>
                    {renderNestedRows(
                      Object.entries(indexer.parameters as Record<string, unknown>).map(([k, v]) => ({ key: k, value: v })),
                      ['parameters'], onNestedIndexerUpdate, onNestedIndexerRemove, t as (k: string) => string, 1,
                    )}
                  </>
                ) : (
                  <tr>
                    <td className="seGrid__key">parameters</td>
                    <td className="seGrid__val" colSpan={2}>
                      <input
                        value={indexer.parameters != null ? JSON.stringify(indexer.parameters) : ''}
                        onChange={(e) => {
                          const v = e.target.value.trim()
                          if (!v) { updateIndexerField('parameters', null); return }
                          try { updateIndexerField('parameters', JSON.parse(v)) } catch { /* keep raw while typing */ }
                        }}
                      />
                    </td>
                  </tr>
                )}

                {/* ── Section: fieldMappings ─────────────────── */}
                <tr className="seGrid__sectionRow">
                  <td colSpan={3}><div className="seGrid__sectionInner">
                    <span>{t('spbIndexerEditorFieldMappings')}</span>
                    <button type="button" className="seGrid__addInline seGrid__addInline--icon" onClick={addFieldMapping} title={t('spbSkillEditorAddInput')}>+</button>
                  </div></td>
                </tr>
                {(indexer.fieldMappings || []).flatMap((fm, i) => {
                  const fmExtra = Object.entries(fm as unknown as Record<string, unknown>)
                    .filter(([k]) => k !== 'sourceFieldName' && k !== 'targetFieldName')
                    .map(([k, v]) => ({ key: k, value: v }))
                  return [
                    <tr key={`fm-${i}__hdr`} className="seGrid__colHeader">
                      <td style={{ paddingLeft: 28 }}>[{i}]</td>
                      <td />
                      <td className="seGrid__act">
                        <button type="button" onClick={() => removeFieldMapping(i)} title={t('spbSkillEditorRemove')}>×</button>
                      </td>
                    </tr>,
                    <tr key={`fm-${i}__src`}>
                      <td className="seGrid__key" style={{ paddingLeft: 48 }}>sourceFieldName</td>
                      <td className="seGrid__val" colSpan={2}>
                        <input value={fm.sourceFieldName} onChange={(e) => updateFieldMapping(i, 'sourceFieldName', e.target.value)} />
                      </td>
                    </tr>,
                    <tr key={`fm-${i}__tgt`}>
                      <td className="seGrid__key" style={{ paddingLeft: 48 }}>targetFieldName</td>
                      <td className="seGrid__val" colSpan={2}>
                        <input value={fm.targetFieldName} onChange={(e) => updateFieldMapping(i, 'targetFieldName', e.target.value)} />
                      </td>
                    </tr>,
                    ...renderNestedRows(fmExtra, ['fieldMappings', i], onNestedIndexerUpdate, onNestedIndexerRemove, t as (k: string) => string, 2),
                  ]
                })}

                {/* ── Section: outputFieldMappings ──────────── */}
                <tr className="seGrid__sectionRow">
                  <td colSpan={3}><div className="seGrid__sectionInner">
                    <span>{t('spbIndexerEditorOutputFieldMappings')}</span>
                    <button type="button" className="seGrid__addInline seGrid__addInline--icon" onClick={addOutputFieldMapping} title={t('spbSkillEditorAddOutput')}>+</button>
                  </div></td>
                </tr>
                {(indexer.outputFieldMappings || []).flatMap((ofm, i) => {
                  const ofmExtra = Object.entries(ofm as unknown as Record<string, unknown>)
                    .filter(([k]) => k !== 'sourceFieldName' && k !== 'targetFieldName')
                    .map(([k, v]) => ({ key: k, value: v }))
                  return [
                    <tr key={`ofm-${i}__hdr`} className="seGrid__colHeader">
                      <td style={{ paddingLeft: 28 }}>[{i}]</td>
                      <td />
                      <td className="seGrid__act">
                        <button type="button" onClick={() => removeOutputFieldMapping(i)} title={t('spbSkillEditorRemove')}>×</button>
                      </td>
                    </tr>,
                    <tr key={`ofm-${i}__src`}>
                      <td className="seGrid__key" style={{ paddingLeft: 48 }}>sourceFieldName</td>
                      <td className="seGrid__val" colSpan={2}>
                        <EnrichmentPathPicker
                          value={ofm.sourceFieldName}
                          onChange={(v) => updateOutputFieldMapping(i, 'sourceFieldName', v)}
                          paths={enrichmentPaths}
                          producedPaths={producedPathSet}
                          language={language}
                          placeholder="/document/..."
                        />
                      </td>
                    </tr>,
                    <tr key={`ofm-${i}__tgt`}>
                      <td className="seGrid__key" style={{ paddingLeft: 48 }}>targetFieldName</td>
                      <td className="seGrid__val" colSpan={2}>
                        <input value={ofm.targetFieldName} onChange={(e) => updateOutputFieldMapping(i, 'targetFieldName', e.target.value)} />
                      </td>
                    </tr>,
                    ...renderNestedRows(ofmExtra, ['outputFieldMappings', i], onNestedIndexerUpdate, onNestedIndexerRemove, t as (k: string) => string, 2),
                  ]
                })}

                {/* ── Section: Extra Properties ────────────── */}
                {indexerExtraProps.length > 0 && (
                  <>
                    <tr className="seGrid__sectionRow">
                      <td colSpan={3}><div className="seGrid__sectionInner">{t('spbSkillEditorExtraProps')}</div></td>
                    </tr>
                    {renderNestedRows(indexerExtraProps, [], onNestedIndexerUpdate, onNestedIndexerRemove, t as (k: string) => string, 1)}
                  </>
                )}

                {/* ── Add Property row ─────────────────────── */}
                <tr className="seGrid__addRow">
                  <td className="seGrid__val">
                    <input
                      placeholder={t('spbSkillEditorPropKeyPlaceholder')}
                      value={newIndexerPropKey}
                      onChange={(e) => setNewIndexerPropKey(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') addIndexerExtraProperty() }}
                    />
                  </td>
                  <td colSpan={2}>
                    <button type="button" className="seGrid__addInline seGrid__addInline--label" onClick={addIndexerExtraProperty} disabled={!newIndexerPropKey.trim()}>
                      + {t('spbSkillEditorAddProperty')}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>

            {/* ── Advanced: JSON Editor (collapsible) ──────── */}
            <div className="skillEditor__jsonToggle">
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => setShowIndexerJsonEditor((p) => !p)}>
                {showIndexerJsonEditor ? '▾' : '▸'} {t('spbSkillEditorAdvancedJson')}
              </button>
            </div>

            {showIndexerJsonEditor && (
              <>
                <ExpandableCodeMirror
                  t={(k) => String(translations[language][k] ?? '')}
                  modalTitle={t('spbSelectedIndexerJson')}
                  value={draftIndexerJson}
                  height="520px"
                  theme={codeMirrorTheme}
                  extensions={[json(), EditorView.lineWrapping]}
                  onChange={(v) => {
                    setDraftIndexerJson(v)
                    if (draftIndexerError) setDraftIndexerError(null)
                  }}
                />
                <div className="actions actions--mb10" style={{ marginTop: 10 }}>
                  <button type="button" className="btn" onClick={applyDraftToIndexer}>
                    {t('spbApply')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {selectedIndexNode && (
          <>
            <div className="section__title" style={{ marginTop: 14 }}>
              {t('spbSelectedIndexJson')}
            </div>

            {draftIndexError && <div className="notice notice--error builder__notice">{draftIndexError}</div>}

            <ExpandableCodeMirror
              t={(k) => String(translations[language][k] ?? '')}
              modalTitle={t('spbSelectedIndexJson')}
              value={draftIndexJson}
              height="520px"
              theme={codeMirrorTheme}
              extensions={[json(), EditorView.lineWrapping, EditorView.editable.of(false)]}
              onChange={(v) => {
                // Read-only; still accept updates from parent state.
                if (v !== draftIndexJson) setDraftIndexJson(v)
                if (draftIndexError) setDraftIndexError(null)
              }}
            />
          </>
        )}

        {/* ── Debug Values Section ── */}
        {(selectedSkillNode || selectedIndexerNode || selectedDocNode) && (
          <div className="spbDebugValues" style={{ marginTop: 18 }}>
            <div className="section__title">
              <i className="bi bi-bug" style={{ marginRight: 6 }}></i>
              {t('spbDebugValuesTitle')}
            </div>

            {!hasDebugData && (
              <div className="empty" style={{ fontSize: 13, padding: '8px 0' }}>
                {t('spbDebugValuesNoData')}
              </div>
            )}

            {/* Skill node: Inputs */}
            {selectedSkillNode && skillDebugDetail && (
              <>
                <div className="spbDebugValues__subtitle">{t('spbDebugValuesInputs')}</div>
                {skillDebugDetail.inputs.length === 0 && (
                  <div className="empty" style={{ fontSize: 12 }}>{t('spbDebugValuesNoInputs')}</div>
                )}
                {skillDebugDetail.inputs.length > 0 && (() => {
                  const allItems = skillDebugDetail.inputs
                  const page = getDebugPage('inputs')
                  const pageCount = Math.ceil(allItems.length / DEBUG_VALUES_PAGE_SIZE)
                  const paged = pageCount > 1 ? allItems.slice(page * DEBUG_VALUES_PAGE_SIZE, (page + 1) * DEBUG_VALUES_PAGE_SIZE) : allItems
                  return (
                  <div className="spbDebugValues__table">
                    <table>
                      <thead>
                        <tr>
                          <th>{t('spbDebugValuesColName')}</th>
                          <th>{t('spbDebugValuesColSource')}</th>
                          <th>{t('spbDebugValuesColValue')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paged.map((inp, pi) => {
                          const i = page * DEBUG_VALUES_PAGE_SIZE + pi
                          const valStr = inp.value !== undefined ? stringifyCompact(inp.value) : null
                          const expandKey = `in-${i}`
                          const isExpanded = debugValueExpanded.has(expandKey)
                          const truncatable = valStr !== null && valStr.length > 120
                          return (
                            <tr key={i}>
                              <td className="mono">{inp.name}</td>
                              <td className="mono mono--ellipsesSm" title={inp.source}>{inp.source}</td>
                              <td>
                                {valStr === null ? (
                                  <span className="text-muted">{t('spbDebugValuesNoValue')}</span>
                                ) : truncatable ? (
                                  <span className="spbDebugValues__val">
                                    <span>{isExpanded ? valStr : `${valStr.slice(0, 120)}…`}</span>
                                    <button type="button" className="spbDebugValues__expandBtn" onClick={() => toggleDebugValueExpand(expandKey)}>
                                      <i className={isExpanded ? 'bi bi-chevron-up' : 'bi bi-chevron-down'} />
                                    </button>
                                  </span>
                                ) : (
                                  <span className="spbDebugValues__val">{valStr}</span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {pageCount > 1 && (
                      <div className="spbDebugValues__pager">
                        <button type="button" disabled={page === 0} onClick={() => setDebugPage('inputs', page - 1)}>‹</button>
                        <span>{page + 1} / {pageCount}</span>
                        <button type="button" disabled={page >= pageCount - 1} onClick={() => setDebugPage('inputs', page + 1)}>›</button>
                        <span className="text-muted" style={{ marginLeft: 4, fontSize: 11 }}>({allItems.length})</span>
                      </div>
                    )}
                  </div>
                  )
                })()}

                <div className="spbDebugValues__subtitle">{t('spbDebugValuesOutputs')}</div>
                {skillDebugDetail.outputs.length === 0 && (
                  <div className="empty" style={{ fontSize: 12 }}>{t('spbDebugValuesNoOutputs')}</div>
                )}
                {skillDebugDetail.outputs.length > 0 && (() => {
                  const allItems = skillDebugDetail.outputs
                  const page = getDebugPage('outputs')
                  const pageCount = Math.ceil(allItems.length / DEBUG_VALUES_PAGE_SIZE)
                  const paged = pageCount > 1 ? allItems.slice(page * DEBUG_VALUES_PAGE_SIZE, (page + 1) * DEBUG_VALUES_PAGE_SIZE) : allItems
                  return (
                  <div className="spbDebugValues__table">
                    <table>
                      <thead>
                        <tr>
                          <th>{t('spbDebugValuesColName')}</th>
                          <th>{t('spbDebugValuesColSource')}</th>
                          <th>{t('spbDebugValuesColValue')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {paged.map((out, pi) => {
                          const i = page * DEBUG_VALUES_PAGE_SIZE + pi
                          const valStr = out.value !== undefined ? stringifyCompact(out.value) : null
                          const expandKey = `out-${i}`
                          const isExpanded = debugValueExpanded.has(expandKey)
                          const truncatable = valStr !== null && valStr.length > 120
                          return (
                            <tr key={i}>
                              <td className="mono">{out.targetName || out.name}</td>
                              <td className="mono mono--ellipsesSm" title={out.path}>{out.path}</td>
                              <td>
                                {valStr === null ? (
                                  <span className="text-muted">{t('spbDebugValuesNoValue')}</span>
                                ) : truncatable ? (
                                  <span className="spbDebugValues__val">
                                    <span>{isExpanded ? valStr : `${valStr.slice(0, 120)}…`}</span>
                                    <button type="button" className="spbDebugValues__expandBtn" onClick={() => toggleDebugValueExpand(expandKey)}>
                                      <i className={isExpanded ? 'bi bi-chevron-up' : 'bi bi-chevron-down'} />
                                    </button>
                                  </span>
                                ) : (
                                  <span className="spbDebugValues__val">{valStr}</span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {pageCount > 1 && (
                      <div className="spbDebugValues__pager">
                        <button type="button" disabled={page === 0} onClick={() => setDebugPage('outputs', page - 1)}>‹</button>
                        <span>{page + 1} / {pageCount}</span>
                        <button type="button" disabled={page >= pageCount - 1} onClick={() => setDebugPage('outputs', page + 1)}>›</button>
                        <span className="text-muted" style={{ marginLeft: 4, fontSize: 11 }}>({allItems.length})</span>
                      </div>
                    )}
                  </div>
                  )
                })()}
              </>
            )}

            {/* Indexer node: outputFieldMappings with values */}
            {selectedIndexerNode && indexerDebugDetail && (() => {
              const allItems = indexerDebugDetail
              const page = getDebugPage('indexer')
              const pageCount = Math.ceil(allItems.length / DEBUG_VALUES_PAGE_SIZE)
              const paged = pageCount > 1 ? allItems.slice(page * DEBUG_VALUES_PAGE_SIZE, (page + 1) * DEBUG_VALUES_PAGE_SIZE) : allItems
              return (
              <div className="spbDebugValues__table">
                <div className="spbDebugValues__subtitle">{t('spbDebugValuesFieldMappings')}</div>
                <table>
                  <thead>
                    <tr>
                      <th>{t('spbDebugValuesColSource')}</th>
                      <th>{t('spbDebugValuesColTarget')}</th>
                      <th>{t('spbDebugValuesColValue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((m, pi) => {
                      const i = page * DEBUG_VALUES_PAGE_SIZE + pi
                      const valStr = m.value !== undefined ? stringifyCompact(m.value) : null
                      const expandKey = `idxr-${i}`
                      const isExpanded = debugValueExpanded.has(expandKey)
                      const truncatable = valStr !== null && valStr.length > 120
                      return (
                        <tr key={i}>
                          <td className="mono mono--ellipsesSm" title={m.sourceFieldName}>{m.sourceFieldName}</td>
                          <td className="mono">{m.targetFieldName}</td>
                          <td>
                            {valStr === null ? (
                              <span className="text-muted">{t('spbDebugValuesNoValue')}</span>
                            ) : truncatable ? (
                              <span className="spbDebugValues__val">
                                <span>{isExpanded ? valStr : `${valStr.slice(0, 120)}…`}</span>
                                <button type="button" className="spbDebugValues__expandBtn" onClick={() => toggleDebugValueExpand(expandKey)}>
                                  <i className={isExpanded ? 'bi bi-chevron-up' : 'bi bi-chevron-down'} />
                                </button>
                              </span>
                            ) : (
                              <span className="spbDebugValues__val">{valStr}</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {pageCount > 1 && (
                  <div className="spbDebugValues__pager">
                    <button type="button" disabled={page === 0} onClick={() => setDebugPage('indexer', page - 1)}>‹</button>
                    <span>{page + 1} / {pageCount}</span>
                    <button type="button" disabled={page >= pageCount - 1} onClick={() => setDebugPage('indexer', page + 1)}>›</button>
                    <span className="text-muted" style={{ marginLeft: 4, fontSize: 11 }}>({allItems.length})</span>
                  </div>
                )}
              </div>
              )
            })()}

            {/* Document node: source document fields with values */}
            {selectedDocNode && docDebugDetail && (() => {
              const allItems = docDebugDetail
              const page = getDebugPage('doc')
              const pageCount = Math.ceil(allItems.length / DEBUG_VALUES_PAGE_SIZE)
              const paged = pageCount > 1 ? allItems.slice(page * DEBUG_VALUES_PAGE_SIZE, (page + 1) * DEBUG_VALUES_PAGE_SIZE) : allItems
              return (
              <div className="spbDebugValues__table">
                <div className="spbDebugValues__subtitle">{t('spbDebugValuesDocFields')}</div>
                <table>
                  <thead>
                    <tr>
                      <th>{t('spbDebugValuesColSource')}</th>
                      <th>{t('spbDebugValuesColValue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((item, pi) => {
                      const i = page * DEBUG_VALUES_PAGE_SIZE + pi
                      const valStr = stringifyCompact(item.value)
                      const expandKey = `doc-${i}`
                      const isExpanded = debugValueExpanded.has(expandKey)
                      const truncatable = valStr.length > 120
                      return (
                        <tr key={i}>
                          <td className="mono mono--ellipsesSm" title={item.path}>{item.path}</td>
                          <td>
                            {truncatable ? (
                              <span className="spbDebugValues__val">
                                <span>{isExpanded ? valStr : `${valStr.slice(0, 120)}…`}</span>
                                <button type="button" className="spbDebugValues__expandBtn" onClick={() => toggleDebugValueExpand(expandKey)}>
                                  <i className={isExpanded ? 'bi bi-chevron-up' : 'bi bi-chevron-down'} />
                                </button>
                              </span>
                            ) : (
                              <span className="spbDebugValues__val">{valStr}</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {pageCount > 1 && (
                  <div className="spbDebugValues__pager">
                    <button type="button" disabled={page === 0} onClick={() => setDebugPage('doc', page - 1)}>‹</button>
                    <span>{page + 1} / {pageCount}</span>
                    <button type="button" disabled={page >= pageCount - 1} onClick={() => setDebugPage('doc', page + 1)}>›</button>
                    <span className="text-muted" style={{ marginLeft: 4, fontSize: 11 }}>({allItems.length})</span>
                  </div>
                )}
              </div>
              )
            })()}
          </div>
        )}

      </div>
    </section>
  )
}
