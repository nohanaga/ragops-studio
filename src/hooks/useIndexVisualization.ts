/**
 * Hook orchestrating the Index Cluster Visualizer workflow:
 * scan vectors → cluster → PCA → 2D scatter data.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { ConnectionProfile, SearchApiVersion } from '../lib/model'
import { getIndexDefinition, type JsonValue } from '../lib/aiSearchRest'
import type { Language } from '../lib/translations'
import type { ClusterResult, HierarchicalClusterResult } from '../lib/clustering'
import type { PcaResult, ReductionMethod } from '../lib/dimensionReduction'
import type { WorkerRequest, WorkerMessage } from '../lib/visualizationWorker'
import type { ClusterGraphData } from '../lib/clusterGraph'
import { detectIndexStructure, scanVectorsSimple, scanVectorsAdaptive } from '../lib/vectorSampling'
import type { IndexStructureInfo } from '../types/evalDataset'

export type VectorFieldInfo = {
  name: string
  dimensions: number
}

export type ScannedDoc = {
  id: string
  title: string
  vector: Float32Array
}

export type VisualizationData = {
  docs: ScannedDoc[]
  cluster: ClusterResult
  pca: PcaResult
  /** Hierarchical 2-level clustering (present when hierarchical mode is enabled). */
  hierarchical?: HierarchicalClusterResult
  /** Phase 4: Cluster relationship graph (present when graph mode is enabled). */
  graph?: ClusterGraphData
}

type Phase = 'idle' | 'detecting' | 'scanning' | 'clustering' | 'graphing' | 'projecting' | 'done' | 'error'

export type DisplayTitleFieldSource = 'user' | 'auto' | 'key'

const DISPLAY_TITLE_FIELD_PRIORITY = [
  'title',
  'name',
  'displaytitle',
  'displayname',
  'documenttitle',
  'doctitle',
  'heading',
  'header',
  'subject',
  'caption',
  'filename',
  'file_name',
  'metadata_storage_name',
  'path',
  'filepath',
  'file_path',
  'url',
  'uri',
]

function findFieldDef(fieldList: Array<Record<string, JsonValue>>, path: string): Record<string, JsonValue> | undefined {
  const parts = path.split('/')
  for (const field of fieldList) {
    if (String(field.name) === parts[0]) {
      if (parts.length === 1) return field
      if (field.fields && Array.isArray(field.fields)) {
        return findFieldDef(field.fields as Array<Record<string, JsonValue>>, parts.slice(1).join('/'))
      }
    }
  }
  return undefined
}

function collectDisplayStringFields(fieldList: Array<Record<string, JsonValue>>, vectorField: string, prefix = ''): string[] {
  const result: string[] = []
  for (const field of fieldList) {
    const name = String(field.name ?? '')
    if (!name) continue
    const path = prefix ? `${prefix}/${name}` : name
    if (
      field.type === 'Edm.String' &&
      field.key !== true &&
      field.retrievable !== false &&
      path !== vectorField
    ) {
      result.push(path)
    }
    if (field.fields && Array.isArray(field.fields)) {
      result.push(...collectDisplayStringFields(field.fields as Array<Record<string, JsonValue>>, vectorField, path))
    }
  }
  return result
}

function getSemanticTitleFieldName(indexDefinition: Record<string, JsonValue>): string | null {
  const semantic = indexDefinition.semantic
  if (!semantic || typeof semantic !== 'object' || Array.isArray(semantic)) return null
  const configurations = (semantic as Record<string, JsonValue>).configurations
  if (!Array.isArray(configurations)) return null
  for (const configuration of configurations) {
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) continue
    const prioritizedFields = (configuration as Record<string, JsonValue>).prioritizedFields
    if (!prioritizedFields || typeof prioritizedFields !== 'object' || Array.isArray(prioritizedFields)) continue
    const titleField = (prioritizedFields as Record<string, JsonValue>).titleField
    if (!titleField || typeof titleField !== 'object' || Array.isArray(titleField)) continue
    const fieldName = (titleField as Record<string, JsonValue>).fieldName
    if (typeof fieldName === 'string' && fieldName.trim()) return fieldName.trim()
  }
  return null
}

function validateUserDisplayTitleField(input: {
  fields: Array<Record<string, JsonValue>> | undefined
  fieldName: string
  keyFieldName: string
  language: Language
}): string {
  const requested = input.fieldName.trim()
  if (!requested) return ''
  if (requested === input.keyFieldName) return requested
  const fieldDef = input.fields ? findFieldDef(input.fields, requested) : undefined
  if (!fieldDef) {
    throw new Error(input.language === 'ja'
      ? `表示タイトル field "${requested}" はインデックス定義に存在しません。`
      : `Display title field "${requested}" does not exist in the index definition.`)
  }
  if (fieldDef.type !== 'Edm.String') {
    throw new Error(input.language === 'ja'
      ? `表示タイトル field "${requested}" は Edm.String ではありません。表示名には文字列 field を指定してください。`
      : `Display title field "${requested}" is not Edm.String. Choose a string field for display titles.`)
  }
  if (fieldDef.retrievable === false) {
    throw new Error(input.language === 'ja'
      ? `表示タイトル field "${requested}" は retrievable: false に設定されています。取得可能な field を指定してください。`
      : `Display title field "${requested}" has retrievable: false. Choose a retrievable field.`)
  }
  return requested
}

function pickDisplayTitleField(input: {
  indexDefinition: Record<string, JsonValue>
  fields: Array<Record<string, JsonValue>> | undefined
  vectorField: string
  keyFieldName: string
}): { fieldName: string; source: DisplayTitleFieldSource } {
  const { indexDefinition, fields, vectorField, keyFieldName } = input
  if (!fields) return { fieldName: keyFieldName, source: 'key' }

  const candidates = collectDisplayStringFields(fields, vectorField)
  const candidateSet = new Set(candidates.map((field) => field.toLowerCase()))
  const semanticTitleField = getSemanticTitleFieldName(indexDefinition)
  if (semanticTitleField && candidateSet.has(semanticTitleField.toLowerCase())) return { fieldName: semanticTitleField, source: 'auto' }

  for (const priority of DISPLAY_TITLE_FIELD_PRIORITY) {
    const exact = candidates.find((field) => field.split('/').at(-1)?.toLowerCase() === priority)
    if (exact) return { fieldName: exact, source: 'auto' }
  }

  const searchable = candidates.find((field) => {
    const def = findFieldDef(fields, field)
    return def?.searchable !== false
  })
  if (searchable) return { fieldName: searchable, source: 'auto' }
  if (candidates[0]) return { fieldName: candidates[0], source: 'auto' }
  return { fieldName: keyFieldName, source: 'key' }
}

export function useIndexVisualization(input: {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
  language: Language
}) {
  const { profile, apiVersion, language } = input

  // Settings
  const [selectedIndex, setSelectedIndex] = useState('')
  const [vectorFields, setVectorFields] = useState<VectorFieldInfo[]>([])
  const [selectedVectorField, setSelectedVectorField] = useState('')
  const [displayTitleField, setDisplayTitleField] = useState('')
  const [k, setK] = useState(5)
  const [microK, setMicroK] = useState(3)
  const [maxDocs, setMaxDocs] = useState(1000)
  const [enableAdaptiveSampling, setEnableAdaptiveSampling] = useState(true)
  const [enableHierarchical, setEnableHierarchical] = useState(false)
  const [reductionMethod, setReductionMethod] = useState<ReductionMethod>('pca')
  const [enableGraph, setEnableGraph] = useState(false)
  const [graphEdgeThreshold, setGraphEdgeThreshold] = useState(0.5)

  // State
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState(0)
  const [progressTotal, setProgressTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<VisualizationData | null>(null)
  const [indexStructure, setIndexStructure] = useState<IndexStructureInfo | null>(null)
  const [titleFieldName, setTitleFieldName] = useState<string>('')
  const [titleFieldSource, setTitleFieldSource] = useState<DisplayTitleFieldSource>('auto')

  const abortRef = useRef<AbortController | null>(null)
  const workerRef = useRef<Worker | null>(null)

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  /** Fetch index definition to discover vector fields. */
  const loadVectorFields = useCallback(
    async (indexName: string) => {
      if (!profile || !indexName) {
        setVectorFields([])
        return
      }
      const result = await getIndexDefinition({
        profile,
        indexName,
        apiVersion,
        language,
      })
      if (!result.ok || !result.response) {
        setVectorFields([])
        return
      }
      const resp = result.response as Record<string, JsonValue>
      const fields = resp.fields as Array<Record<string, JsonValue>> | undefined
      if (!fields) {
        setVectorFields([])
        return
      }
      const vFields: VectorFieldInfo[] = []
      const collectVectorFields = (fieldList: Array<Record<string, JsonValue>>, prefix = '') => {
        for (const f of fieldList) {
          const name = prefix ? `${prefix}/${f.name}` : String(f.name ?? '')
          const type = String(f.type ?? '')
          if (type.startsWith('Collection(Edm.') && type.includes('Single') || type === 'Collection(Edm.Half)' || type === 'Collection(Edm.Int16)') {
            const dims = typeof f.dimensions === 'number' ? f.dimensions : 0
            if (dims > 0) {
              vFields.push({ name, dimensions: dims })
            }
          }
          // Check sub-fields for complex types
          if (f.fields && Array.isArray(f.fields)) {
            collectVectorFields(f.fields as Array<Record<string, JsonValue>>, name)
          }
        }
      }
      collectVectorFields(fields)
      setVectorFields(vFields)
      if (vFields.length > 0 && !vFields.some((f) => f.name === selectedVectorField)) {
        setSelectedVectorField(vFields[0].name)
      }
    },
    [profile, apiVersion, language, selectedVectorField]
  )

  /** Run the full pipeline: scan → cluster → PCA. */
  const run = useCallback(async () => {
    if (!profile || !selectedIndex || !selectedVectorField) return

    const ctrl = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ctrl

    setError(null)
    setData(null)
    setPhase(enableAdaptiveSampling ? 'detecting' : 'scanning')
    setProgress(0)
    setProgressTotal(0)

    try {
      // Find primary key from index definition
      const defResult = await getIndexDefinition({
        profile,
        indexName: selectedIndex,
        apiVersion,
        language,
      })
      if (ctrl.signal.aborted) return
      if (!defResult.ok || !defResult.response) {
        throw new Error('Failed to get index definition')
      }
      const defResp = defResult.response as Record<string, JsonValue>
      const defFields = defResp.fields as Array<Record<string, JsonValue>> | undefined
      const keyField = defFields?.find((f) => f.key === true)
      const keyFieldName = keyField ? String(keyField.name) : ''
      // Check that the selected vector field is retrievable
      const vectorFieldDef = defFields ? findFieldDef(defFields, selectedVectorField) : undefined
      if (vectorFieldDef && vectorFieldDef.retrievable === false) {
        throw new Error(
          language === 'ja'
            ? `ベクトルフィールド "${selectedVectorField}" は retrievable: false に設定されています。インデックス定義で retrievable を true に変更してください。`
            : `Vector field "${selectedVectorField}" has retrievable: false. Update the index definition to set retrievable to true.`
        )
      }
      if (vectorFieldDef && vectorFieldDef.stored === false) {
        throw new Error(
          language === 'ja'
            ? `ベクトルフィールド "${selectedVectorField}" は stored: false に設定されています。stored が false のフィールドは取得できません。`
            : `Vector field "${selectedVectorField}" has stored: false. Fields with stored=false cannot be retrieved.`
        )
      }
      const requestedTitleField = displayTitleField.trim()
      const resolvedTitleField = requestedTitleField
        ? { fieldName: validateUserDisplayTitleField({ fields: defFields, fieldName: requestedTitleField, keyFieldName, language }), source: 'user' as const }
        : pickDisplayTitleField({
            indexDefinition: defResp,
            fields: defFields,
            vectorField: selectedVectorField,
            keyFieldName,
          })
      const titleFieldName = resolvedTitleField.fieldName
      setTitleFieldName(titleFieldName)
      setTitleFieldSource(resolvedTitleField.source)

      const limit = Math.min(maxDocs, 10000)
      setProgressTotal(limit)

      let allDocs: ScannedDoc[]

      if (enableAdaptiveSampling) {
        // Adaptive Sampling: detect index structure then branch
        setPhase('detecting')
        const structure = await detectIndexStructure({
          profile,
          indexName: selectedIndex,
          apiVersion,
          keyField: keyFieldName,
          language,
          signal: ctrl.signal,
        })
        if (ctrl.signal.aborted) return
        setIndexStructure(structure)

        setPhase('scanning')
        const sampled = await scanVectorsAdaptive({
          profile,
          indexName: selectedIndex,
          apiVersion,
          keyField: keyFieldName,
          vectorField: selectedVectorField,
          titleField: titleFieldName,
          maxDocs: limit,
          language,
          signal: ctrl.signal,
          onProgress: (n, t) => { setProgress(n); setProgressTotal(t) },
          indexStructure: structure,
        })
        if (ctrl.signal.aborted) return
        allDocs = sampled
      } else {
        // Simple sequential scan (original behavior)
        setPhase('scanning')
        const sampled = await scanVectorsSimple({
          profile,
          indexName: selectedIndex,
          apiVersion,
          keyField: keyFieldName,
          vectorField: selectedVectorField,
          titleField: titleFieldName,
          maxDocs: limit,
          language,
          signal: ctrl.signal,
          onProgress: (n, t) => { setProgress(n); setProgressTotal(t) },
        })
        if (ctrl.signal.aborted) return
        allDocs = sampled
      }

      if (allDocs.length === 0) {
        throw new Error('No documents with vectors found')
      }

      // Clustering + dimensionality reduction (off main thread via Web Worker)
      setPhase('clustering')
      const vectors = allDocs.map((d) => d.vector)
      const dim = vectors[0].length

      // Pack vectors into a single flat Float32Array for transfer
      const flat = new Float32Array(vectors.length * dim)
      for (let i = 0; i < vectors.length; i++) {
        flat.set(vectors[i], i * dim)
      }

      const workerResult = await new Promise<{
        cluster: ClusterResult
        pca: PcaResult
        hierarchical?: HierarchicalClusterResult
        graph?: ClusterGraphData
      }>((resolve, reject) => {
        const worker = new Worker(
          new URL('../lib/visualizationWorker.ts', import.meta.url),
          { type: 'module' },
        )
        workerRef.current = worker

        const handleAbort = () => {
          worker.terminate()
          reject(new DOMException('Aborted', 'AbortError'))
        }
        ctrl.signal.addEventListener('abort', handleAbort, { once: true })

        worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
          const msg = ev.data
          if (msg.type === 'phase') {
            if (msg.phase === 'clustering') setPhase('clustering')
            else if (msg.phase === 'graphing') setPhase('graphing')
            else if (msg.phase === 'projecting') setPhase('projecting')
          } else if (msg.type === 'result') {
            ctrl.signal.removeEventListener('abort', handleAbort)
            worker.terminate()
            workerRef.current = null
            resolve({ cluster: msg.cluster, pca: msg.pca, hierarchical: msg.hierarchical, graph: msg.graph })
          }
        }

        worker.onerror = (err) => {
          ctrl.signal.removeEventListener('abort', handleAbort)
          worker.terminate()
          workerRef.current = null
          reject(new Error(err.message || 'Worker error'))
        }

        const req: WorkerRequest = {
          vectorData: flat,
          vectorCount: vectors.length,
          vectorDim: dim,
          k,
          reductionMethod,
          enableHierarchical,
          microK,
          enableGraph,
          graphEdgeThreshold,
        }
        worker.postMessage(req, [flat.buffer])
      })

      if (ctrl.signal.aborted) return

      setData({ docs: allDocs, cluster: workerResult.cluster, pca: workerResult.pca, hierarchical: workerResult.hierarchical, graph: workerResult.graph })
      setPhase('done')
    } catch (err) {
      if (ctrl.signal.aborted) return
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [profile, selectedIndex, selectedVectorField, displayTitleField, vectorFields, k, microK, maxDocs, enableAdaptiveSampling, enableHierarchical, enableGraph, graphEdgeThreshold, reductionMethod, apiVersion, language])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    workerRef.current?.terminate()
    workerRef.current = null
    setPhase('idle')
    setProgress(0)
    setProgressTotal(0)
  }, [])

  /** Restore visualization data from a snapshot (load/import). */
  const restoreData = useCallback((restored: VisualizationData) => {
    setData(restored)
    setPhase('done')
    setError(null)
  }, [])

  /** Clear all visualization data back to idle state. */
  const clearData = useCallback(() => {
    abortRef.current?.abort()
    workerRef.current?.terminate()
    workerRef.current = null
    setData(null)
    setPhase('idle')
    setError(null)
    setProgress(0)
    setProgressTotal(0)
  }, [])

  return {
    // Settings
    selectedIndex,
    setSelectedIndex,
    vectorFields,
    selectedVectorField,
    setSelectedVectorField,
    displayTitleField,
    setDisplayTitleField,
    k,
    setK,
    microK,
    setMicroK,
    maxDocs,
    setMaxDocs,
    enableAdaptiveSampling,
    setEnableAdaptiveSampling,
    enableHierarchical,
    setEnableHierarchical,
    enableGraph,
    setEnableGraph,
    graphEdgeThreshold,
    setGraphEdgeThreshold,
    reductionMethod,
    setReductionMethod,
    // Actions
    loadVectorFields,
    run,
    cancel,
    restoreData,
    clearData,
    // State
    phase,
    progress,
    progressTotal,
    error,
    data,
    indexStructure,
    titleFieldName,
    titleFieldSource,
  }
}
