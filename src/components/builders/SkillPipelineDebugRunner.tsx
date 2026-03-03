import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'

import { EditorView } from 'codemirror'
import { json } from '@codemirror/lang-json'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'

import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import type { JsonValue, RestResult } from '../../lib/aiSearchRest'
import {
  createOrUpdateDataSource,
  createOrUpdateIndexer,
  createOrUpdateIndex,
  createOrUpdateSkillset,
  deleteDataSource,
  deleteIndexer,
  deleteIndex,
  deleteSkillset,
  getIndexerStatus,
  runIndexer,
  searchDocuments,
} from '../../lib/aiSearchRest'
import {
  parseStorageConnectionString,
  generateAccountSas,
  getBlobEndpoint,
  findFirstContentBlob,
  readBlobAsJson,
  deleteContainer,
  mapProjectionToSearchResult,
} from '../../lib/azureBlobStorage'
import { translations, type Language } from '../../lib/translations'
import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import { JsonViewer } from '../viewers/JsonViewer'
import {
  DEBUG_RUNNER_BLOB_CONTAINER_KEY,
  DEBUG_RUNNER_BLOB_PATH_KEY,
  DEBUG_RUNNER_STORAGE_CONNECTION_STRING_KEY,
} from '../../app/constants'
import {
  extractSkillOutputs,
  guessOutputMappingShape,
  makeDebugCaptureFieldName,
  buildShaperInputs,
  type ResolvedSkillOutput,
} from '../../utils/debugRunnerHelpers'

type TranslationKey = keyof typeof translations.ja

type UiMessage = { type: 'success' | 'error' | 'info'; text: string }

function loadPersistedString(key: string): string {
  try {
    return String(localStorage.getItem(key) ?? '')
  } catch {
    return ''
  }
}

function persistString(key: string, value: string): void {
  try {
    const v = String(value ?? '')
    if (!v.trim()) localStorage.removeItem(key)
    else localStorage.setItem(key, v)
  } catch {
    // ignore
  }
}

function safeJsonParse(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeIndexFields(baseFields: any[], extraFields: any[]): any[] {
  const byName = new Map<string, any>()
  for (const f of baseFields) {
    const n = isRecord(f) && typeof f.name === 'string' ? (f.name as string) : ''
    if (n) byName.set(n, f)
  }
  for (const f of extraFields) {
    const n = isRecord(f) && typeof f.name === 'string' ? (f.name as string) : ''
    if (!n) continue
    if (byName.has(n)) continue
    byName.set(n, f)
  }
  return Array.from(byName.values())
}

function restResultToLogJson(res: RestResult): JsonValue {
  if (res.ok) {
    return {
      ok: true,
      status: res.status,
      requestId: res.requestId,
      clientRequestId: res.clientRequestId ?? null,
      url: res.url,
      response: res.response,
      elapsedTimeMs: res.elapsedTimeMs ?? null,
    } as unknown as JsonValue
  }
  return {
    ok: false,
    status: res.status,
    requestId: res.requestId,
    clientRequestId: res.clientRequestId ?? null,
    url: res.url,
    error: res.error,
    elapsedTimeMs: res.elapsedTimeMs ?? null,
  } as unknown as JsonValue
}

function getIndexerLastResultStatus(statusResponse: JsonValue): string | null {
  if (!isRecord(statusResponse)) return null
  const lastResult = statusResponse.lastResult
  if (!isRecord(lastResult)) return null
  const status = lastResult.status
  return typeof status === 'string' ? status : null
}

function makeDefaultIndexJson(indexName: string): string {
  const base = {
    name: indexName,
    fields: [
      // Use an explicit key field and base64Encode metadata_storage_path into it via indexer fieldMappings.
      // This avoids invalid document key errors when metadata_storage_path is a URL.
      { name: 'id', type: 'Edm.String', key: true, filterable: true, sortable: true },
      { name: 'metadata_storage_path', type: 'Edm.String', filterable: true, retrievable: true },
      { name: 'metadata_storage_name', type: 'Edm.String', filterable: true },
      // Keep content as searchable+retrievable, and explicitly disable filter/sort/facet.
      { name: 'content', type: 'Edm.String', searchable: true, retrievable: true, filterable: false, sortable: false, facetable: false },
    ],
  }
  return JSON.stringify(base, null, 2)
}

function forceContentFieldMinimal(fields: any[]): any[] {
  if (!Array.isArray(fields)) return []
  return fields.map((f) => {
    if (!isRecord(f)) return f
    const name = typeof f.name === 'string' ? (f.name as string) : ''
    if (name !== 'content') return f
    const type = typeof f.type === 'string' && (f.type as string).trim() ? (f.type as string) : 'Edm.String'
    return { name: 'content', type, searchable: true, retrievable: true, filterable: false, sortable: false, facetable: false }
  })
}

function findIndexKeyFieldName(indexBody: Record<string, unknown>): string | null {
  const fields = Array.isArray(indexBody.fields) ? (indexBody.fields as unknown[]) : []
  for (const f of fields) {
    if (!isRecord(f)) continue
    if (f.key !== true) continue
    const name = typeof f.name === 'string' ? (f.name as string) : ''
    if (name.trim()) return name.trim()
  }
  return null
}

function isTerminalIndexerStatus(status: unknown): boolean {
  // Indexer status lastResult.status is usually: "success" | "transientFailure" | "persistentFailure" | "inProgress".
  if (typeof status !== 'string') return false
  const s = status.toLowerCase()
  return s === 'success' || s === 'transientfailure' || s === 'persistentfailure'
}

export type SkillPipelineDebugRunnerHandle = {
  startDebug: () => void
}

type SkillPipelineDebugRunnerProps = {
  t: (k: TranslationKey) => string
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
  language: Language
  theme: string
  skillsetJson: string
  defaultSkillsetName: string
  onFetchedDocs?: (docs: JsonValue | null) => void
  onBusyChange?: (busy: boolean) => void
  onProgressChange?: (progress: string | null) => void
}

export const SkillPipelineDebugRunner = forwardRef<SkillPipelineDebugRunnerHandle, SkillPipelineDebugRunnerProps>(function SkillPipelineDebugRunner(props, ref) {
  const { t, profile, apiVersion, language, theme, skillsetJson, defaultSkillsetName, onFetchedDocs, onBusyChange, onProgressChange } = props

  const format = (key: TranslationKey, params: Record<string, string | number>): string => {
    let text: string = String(t(key) ?? '')
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
    return text
  }

  const codeMirrorTheme = useMemo(() => {
    const isLight = theme === 'light' || theme === 'solarized'
    return isLight ? githubLight : githubDark
  }, [theme])

  const nowSuffix = useMemo(() => {
    const d = new Date()
    const pad2 = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  }, [])

  const [storageConnectionString, setStorageConnectionString] = useState(() => loadPersistedString(DEBUG_RUNNER_STORAGE_CONNECTION_STRING_KEY))
  const [containerName, setContainerName] = useState(() => loadPersistedString(DEBUG_RUNNER_BLOB_CONTAINER_KEY))
  const [virtualFolder, setVirtualFolder] = useState(() => loadPersistedString(DEBUG_RUNNER_BLOB_PATH_KEY))

  useEffect(() => {
    persistString(DEBUG_RUNNER_STORAGE_CONNECTION_STRING_KEY, storageConnectionString)
  }, [storageConnectionString])

  useEffect(() => {
    persistString(DEBUG_RUNNER_BLOB_CONTAINER_KEY, containerName)
  }, [containerName])

  useEffect(() => {
    persistString(DEBUG_RUNNER_BLOB_PATH_KEY, virtualFolder)
  }, [virtualFolder])

  const [resourcePrefix, setResourcePrefix] = useState(`ragops-debug-${nowSuffix}`)
  const [debugSkillsetName, setDebugSkillsetName] = useState(() => {
    const base = defaultSkillsetName.trim() || 'skillset1'
    return `${base}-debug-${nowSuffix}`
  })
  const [debugIndexName, setDebugIndexName] = useState(`${resourcePrefix}-idx`)
  const [debugDataSourceName, setDebugDataSourceName] = useState(`${resourcePrefix}-ds`)
  const [debugIndexerName, setDebugIndexerName] = useState(`${resourcePrefix}-ixr`)

  const [createIndexChecked, setCreateIndexChecked] = useState(true)
  const [indexJson, setIndexJson] = useState(() => makeDefaultIndexJson(`${resourcePrefix}-idx`))
  const [autoGenerateMappings, setAutoGenerateMappings] = useState(true)

  // Knowledge Store Projection mode
  const [ksProjectionEnabled, setKsProjectionEnabled] = useState(true)
  const [ksContainerName, setKsContainerName] = useState(`ragops-debug-ks-${nowSuffix}`)

  // Auto-cleanup after debug run
  const [autoCleanup, setAutoCleanup] = useState(true)

  const [busy, setBusyRaw] = useState(false)
  const [message, setMessage] = useState<UiMessage | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [debugProgress, setDebugProgressRaw] = useState<string | null>(null)

  // Wrap setters to notify parent
  const setBusy = (v: boolean) => { setBusyRaw(v); onBusyChange?.(v) }
  const setDebugProgress = (v: string | null) => { setDebugProgressRaw(v); onProgressChange?.(v) }

  const [lastProvision, setLastProvision] = useState<JsonValue | null>(null)
  const [lastRun, setLastRun] = useState<JsonValue | null>(null)
  const [lastStatus, setLastStatus] = useState<JsonValue | null>(null)
  const [lastDocs, setLastDocs] = useState<JsonValue | null>(null)
  const [lastProjection, setLastProjection] = useState<JsonValue | null>(null)

  /**
   * Keeps the resolved outputs around between provision() and fetchProjections()
   * so we can map projection data back to enrichment-tree field names.
   */
  const resolvedOutputsRef = useRef<ResolvedSkillOutput[]>([])

  const pollTimerRef = useRef<number | null>(null)

  const stopPolling = () => {
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }

  const validateBasics = (): string | null => {
    if (!profile) return t('spbDebugErrProfileRequired')
    if (!apiVersion || !apiVersion.trim()) return t('spbDebugErrApiVersionRequired')
    if (!debugSkillsetName.trim()) return t('spbDebugErrSkillsetNameRequired')
    if (!debugIndexName.trim()) return t('spbDebugErrIndexNameRequired')
    if (!debugDataSourceName.trim()) return t('spbDebugErrDataSourceNameRequired')
    if (!debugIndexerName.trim()) return t('spbDebugErrIndexerNameRequired')
    if (!storageConnectionString.trim()) return t('spbDebugErrStorageConnRequired')
    if (!containerName.trim()) return t('spbDebugErrContainerNameRequired')
    if (!virtualFolder.trim()) return t('spbDebugErrBlobPathRequired')
    if (virtualFolder.trim().endsWith('/')) return t('spbDebugErrBlobPathTrailingSlash')
    return null
  }

  const provision = async () => {
    const basicErr = validateBasics()
    if (basicErr) {
      setMessage({ type: 'error', text: basicErr })
      return
    }

    const p = profile as ConnectionProfile

    stopPolling()
    setBusy(true)
    setMessage(null)

    try {
      const parsedSkillset = safeJsonParse(skillsetJson)
      if (!parsedSkillset.ok) {
        setMessage({ type: 'error', text: format('spbDebugErrSkillsetJsonParse', { error: parsedSkillset.error }) })
        return
      }

      const skillsetBody: Record<string, unknown> = isRecord(parsedSkillset.value) ? { ...parsedSkillset.value } : {}
      skillsetBody.name = debugSkillsetName.trim()
      // Remove internal UI metadata before sending to the service.
      // Azure AI Search rejects unknown properties on the skillset resource.
      delete skillsetBody['_ragops']

      // ── Pre-flight: detect cyclic dependencies between skills ──
      // Build a directed graph: skill → skills it depends on (via input sources
      // referencing output paths of other skills).
      const skillsArr = Array.isArray(skillsetBody.skills) ? (skillsetBody.skills as any[]) : []
      const outputPathToSkillIdx = new Map<string, number>()
      for (let si = 0; si < skillsArr.length; si++) {
        const sk = skillsArr[si]
        if (!isRecord(sk)) continue
        const ctx = typeof sk.context === 'string' ? sk.context.replace(/\/\*$/, '') : '/document'
        const outputs = Array.isArray(sk.outputs) ? sk.outputs : []
        for (const o of outputs) {
          if (!isRecord(o)) continue
          const tgt = typeof o.targetName === 'string' ? o.targetName : (typeof o.name === 'string' ? o.name : '')
          if (tgt) {
            outputPathToSkillIdx.set(`${ctx}/${tgt}`, si)
            // Also register with /* suffix for Collection references
            outputPathToSkillIdx.set(`${ctx}/${tgt}/*`, si)
          }
        }
      }
      // Build adjacency and detect cycle via DFS
      const adj = new Map<number, Set<number>>()
      for (let si = 0; si < skillsArr.length; si++) {
        const sk = skillsArr[si]
        if (!isRecord(sk)) continue
        const inputs = Array.isArray(sk.inputs) ? sk.inputs : []
        for (const inp of inputs) {
          if (!isRecord(inp)) continue
          const src = typeof inp.source === 'string' ? inp.source.trim() : ''
          if (!src) continue
          // Check if this source matches any skill output path
          const producerIdx = outputPathToSkillIdx.get(src) ?? outputPathToSkillIdx.get(src.replace(/\/\*$/, ''))
          if (producerIdx !== undefined && producerIdx !== si) {
            if (!adj.has(producerIdx)) adj.set(producerIdx, new Set())
            adj.get(producerIdx)!.add(si)
          }
        }
      }
      // DFS cycle detection
      const visited = new Set<number>()
      const inStack = new Set<number>()
      let hasCycle = false
      const cycleSkills: string[] = []
      const dfs = (node: number) => {
        if (hasCycle) return
        visited.add(node)
        inStack.add(node)
        for (const neighbor of (adj.get(node) ?? [])) {
          if (inStack.has(neighbor)) {
            hasCycle = true
            const sk = skillsArr[neighbor]
            cycleSkills.push(typeof sk?.name === 'string' ? sk.name : `skill[${neighbor}]`)
            return
          }
          if (!visited.has(neighbor)) dfs(neighbor)
        }
        inStack.delete(node)
      }
      for (let si = 0; si < skillsArr.length; si++) {
        if (!visited.has(si)) dfs(si)
      }
      if (hasCycle) {
        setMessage({ type: 'error', text: format('spbDebugErrCyclicDependency', { skills: cycleSkills.join(', ') }) })
        setBusy(false)
        return
      }

      // Generate outputFieldMappings and index fields from skill outputs (per Microsoft docs).
      // https://learn.microsoft.com/azure/search/cognitive-search-output-field-mapping
      const extractedOutputs = extractSkillOutputs(skillsetBody)
      const usedFieldNames = new Map<string, number>()
      const resolvedOutputs: ResolvedSkillOutput[] = extractedOutputs.map((x) => {
        const fieldName = makeDebugCaptureFieldName({ skillName: x.skillName, outputName: x.outputName, usedFieldNames })
        return { ...x, fieldName }
      })

      const generatedOutputFieldMappings = resolvedOutputs.map((x) => {
        const shape = guessOutputMappingShape(x)
        return {
          sourceFieldName: shape.sourcePath,
          targetFieldName: x.fieldName,
          mappingFunction: null,
        }
      })

      const generatedIndexFields = resolvedOutputs.map((x) => {
        const shape = guessOutputMappingShape(x)
        const name = x.fieldName
        return {
          name,
          type: shape.fieldType,
          retrievable: true,
          searchable: shape.fieldType === 'Edm.String',
          filterable: false,
          sortable: false,
          facetable: false,
        }
      })

      const actions: Record<string, JsonValue> = {}

      let resolvedKeyFieldName = 'id'

      // ── Knowledge Store Projection mode ──────────────────────────────────
      // Inject a Shaper skill that aggregates ALL skill outputs + original
      // document fields into a single JSON object, then project that object
      // to Azure Blob Storage via knowledgeStore.  This is required because a
      // plain object projection with source="/document" only captures the
      // original document fields — enrichment nodes produced by skills are NOT
      // included unless explicitly collected by a Shaper.
      if (ksProjectionEnabled) {
        const connInfo = parseStorageConnectionString(storageConnectionString)
        if (!connInfo) {
          setMessage({ type: 'error', text: t('spbDebugErrInvalidStorageConnKs') })
          setBusy(false)
          return
        }

        // ── Build Shaper skill inputs ──
        const { shaperInputs, blobPathMap } = buildShaperInputs(extractedOutputs)

        // Propagate blobPath to resolvedOutputs for fetchProjections().
        for (const ro of resolvedOutputs) {
          ro.blobPath = blobPathMap.get(ro.sourcePath)
        }

        const shaperSkill = {
          '@odata.type': '#Microsoft.Skills.Util.ShaperSkill',
          name: 'ragops_debug_shaper',
          description: 'Auto-generated by RAGOps Studio Debug Runner to capture all skill outputs for Knowledge Store projection.',
          context: '/document',
          inputs: shaperInputs,
          outputs: [{ name: 'output', targetName: 'ragops_debug_capture' }],
        }

        // Append the Shaper skill to the skills array.
        const skills = Array.isArray(skillsetBody.skills) ? (skillsetBody.skills as unknown[]) : []
        skills.push(shaperSkill)
        skillsetBody.skills = skills

        skillsetBody.knowledgeStore = {
          storageConnectionString: storageConnectionString.trim(),
          projections: [
            {
              tables: [],
              objects: [
                {
                  storageContainer: ksContainerName.trim(),
                  source: '/document/ragops_debug_capture',
                  generatedKeyName: 'ragops_debug_id',
                },
              ],
              files: [],
            },
          ],
        }
      }

      // Store the resolved outputs so fetchProjections() can map them later.
      resolvedOutputsRef.current = resolvedOutputs

      const putSkillset = await createOrUpdateSkillset({
        profile: p,
        skillsetName: debugSkillsetName.trim(),
        apiVersion,
        body: skillsetBody as unknown as JsonValue,
        language,
      })
      actions.skillset = restResultToLogJson(putSkillset)
      if (!putSkillset.ok) {
        setLastProvision(actions)
        setMessage({ type: 'error', text: putSkillset.error.message })
        return
      }

      if (createIndexChecked) {
        const parsedIndex = safeJsonParse(indexJson)
        if (!parsedIndex.ok) {
          setLastProvision(actions)
          setMessage({ type: 'error', text: format('spbDebugErrIndexJsonParse', { error: parsedIndex.error }) })
          return
        }
        const indexBody: Record<string, unknown> = isRecord(parsedIndex.value) ? { ...parsedIndex.value } : {}
        indexBody.name = debugIndexName.trim()

        // Resolve the key field name from the index definition.
        resolvedKeyFieldName = findIndexKeyFieldName(indexBody) ?? resolvedKeyFieldName

        if (autoGenerateMappings) {
          const fields = Array.isArray(indexBody.fields) ? (indexBody.fields as any[]) : []
          const baseFields = [
            { name: 'id', type: 'Edm.String', key: true, filterable: true, sortable: true },
            { name: 'metadata_storage_path', type: 'Edm.String', filterable: true, retrievable: true },
            { name: 'metadata_storage_name', type: 'Edm.String', filterable: true, retrievable: true },
            // Keep content as searchable+retrievable, and explicitly disable filter/sort/facet.
            { name: 'content', type: 'Edm.String', searchable: true, retrievable: true, filterable: false, sortable: false, facetable: false },
          ]

          indexBody.fields = forceContentFieldMinimal(mergeIndexFields(mergeIndexFields(baseFields, fields), generatedIndexFields))

          // If the user had a different key field name, we still need it for the indexer mapping.
          resolvedKeyFieldName = findIndexKeyFieldName(indexBody) ?? resolvedKeyFieldName

          // Reflect the effective index JSON back into the editor so users can see/adjust it.
          setIndexJson(JSON.stringify(indexBody, null, 2))
        }

        const putIndex = await createOrUpdateIndex({
          profile: p,
          indexName: debugIndexName.trim(),
          apiVersion,
          body: indexBody as unknown as JsonValue,
          language,
        })
        actions.index = restResultToLogJson(putIndex)
        if (!putIndex.ok) {
          setLastProvision(actions)
          setMessage({ type: 'error', text: putIndex.error.message })
          return
        }
      }

      const dsBody: Record<string, unknown> = {
        name: debugDataSourceName.trim(),
        type: 'azureblob',
        credentials: {
          connectionString: storageConnectionString.trim(),
        },
        container: {
          name: containerName.trim(),
        },
      }
      // Always scope the debug run to a single blob path via container.query.
      if (isRecord(dsBody.container)) (dsBody.container as Record<string, unknown>).query = virtualFolder.trim()

      const putDs = await createOrUpdateDataSource({
        profile: p,
        dataSourceName: debugDataSourceName.trim(),
        apiVersion,
        body: dsBody as unknown as JsonValue,
        language,
      })
      actions.dataSource = restResultToLogJson(putDs)
      if (!putDs.ok) {
        setLastProvision(actions)
        setMessage({ type: 'error', text: putDs.error.message })
        return
      }

      const indexerBody: Record<string, unknown> = {
        name: debugIndexerName.trim(),
        dataSourceName: debugDataSourceName.trim(),
        targetIndexName: debugIndexName.trim(),
        skillsetName: debugSkillsetName.trim(),
        fieldMappings: [
          // Preserve the raw path as a retrievable/filterable field.
          { sourceFieldName: 'metadata_storage_path', targetFieldName: 'metadata_storage_path' },
          // Ensure the document key is URL-safe.
          {
            sourceFieldName: 'metadata_storage_path',
            targetFieldName: resolvedKeyFieldName,
            mappingFunction: {
              name: 'base64Encode',
              // Use RFC 4648 base64url encoding (ADLS Gen2 compatible).
              parameters: { useHttpServerUtilityUrlTokenEncode: false },
            },
          },
        ],
        // fieldMappings map source fields to index fields; outputFieldMappings map enrichments to index fields.
        // Docs: outputFieldMappings are required for AI enrichment scenarios.
        // https://learn.microsoft.com/rest/api/searchservice/create-indexer#examples
        outputFieldMappings: autoGenerateMappings ? generatedOutputFieldMappings : undefined,
        parameters: {
          maxFailedItems: -1,
          maxFailedItemsPerBatch: -1,
          configuration: {
            dataToExtract: 'contentAndMetadata',
          },
        },
      }

      const putIndexer = await createOrUpdateIndexer({
        profile: p,
        indexerName: debugIndexerName.trim(),
        apiVersion,
        body: indexerBody as unknown as JsonValue,
        language,
      })
      actions.indexer = restResultToLogJson(putIndexer)
      if (!putIndexer.ok) {
        setLastProvision(actions)
        setMessage({ type: 'error', text: putIndexer.error.message })
        return
      }

      setLastProvision(actions)
      setMessage({ type: 'success', text: t('spbDebugMsgProvisioned') })
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    const basicErr = validateBasics()
    if (basicErr) {
      setMessage({ type: 'error', text: basicErr })
      return
    }

    stopPolling()
    setBusy(true)
    setMessage(null)

    try {
      const p = profile as ConnectionProfile
      const res = await runIndexer({ profile: p, indexerName: debugIndexerName.trim(), apiVersion, language })
      setLastRun(restResultToLogJson(res))
      if (!res.ok) {
        setMessage({ type: 'error', text: res.error.message })
        return
      }

      setMessage({ type: 'success', text: t('spbDebugMsgIndexerStarted') })

      pollTimerRef.current = window.setInterval(async () => {
        const st = await getIndexerStatus({ profile: p, indexerName: debugIndexerName.trim(), apiVersion, language })
        if (!st.ok) {
          setLastStatus(restResultToLogJson(st))
          setMessage({ type: 'error', text: st.error.message })
          stopPolling()
          return
        }
        setLastStatus(st.response)

        const lastResultStatus = getIndexerLastResultStatus(st.response)
        if (isTerminalIndexerStatus(lastResultStatus)) {
          setMessage({ type: 'success', text: format('spbDebugMsgIndexerFinished', { status: String(lastResultStatus) }) })
          stopPolling()
        }
      }, 2000)
    } finally {
      setBusy(false)
    }
  }

  const fetchDocs = async () => {
    if (!profile) {
      setMessage({ type: 'error', text: t('spbDebugErrProfileRequired') })
      return
    }
    if (!debugIndexName.trim()) {
      setMessage({ type: 'error', text: t('spbDebugErrIndexNameRequired') })
      return
    }

    setBusy(true)
    setMessage(null)
    try {
      const p = profile as ConnectionProfile
      const res = await searchDocuments({
        profile: p,
        indexName: debugIndexName.trim(),
        apiVersion,
        language,
        body: {
          search: '*',
          top: 5,
          count: true,
        },
      })
      setLastDocs(res.ok ? res.response : restResultToLogJson(res))
      if (!res.ok) {
        onFetchedDocs?.(null)
        setMessage({ type: 'error', text: res.error.message })
        return
      }
      onFetchedDocs?.(res.response)
      setMessage({ type: 'success', text: t('spbDebugMsgFetchedDocs') })
    } finally {
      setBusy(false)
    }
  }

  // ── Knowledge Store Projection fetch ────────────────────────────────────
  // Reads the projected blob(s) from the Knowledge Store container, maps the
  // JSON back to enrichment-tree field names, and feeds the result into the
  // same `onFetchedDocs` callback so the Enrichment Tree can display values.
  const fetchProjections = async () => {
    if (!storageConnectionString.trim()) {
      setMessage({ type: 'error', text: t('spbDebugErrStorageConnRequired') })
      return
    }
    if (!ksContainerName.trim()) {
      setMessage({ type: 'error', text: t('spbDebugErrProjectionContainerRequired') })
      return
    }

    const connInfo = parseStorageConnectionString(storageConnectionString)
    if (!connInfo) {
      setMessage({ type: 'error', text: t('spbDebugErrInvalidStorageConn') })
      return
    }

    setBusy(true)
    setMessage(null)
    try {
      // Generate a short-lived Account SAS (read + list on blob service).
      const sasToken = await generateAccountSas({
        accountName: connInfo.accountName,
        accountKey: connInfo.accountKey,
        permissions: 'rl',
        services: 'b',
        resourceTypes: 'sco',
        expiryMinutes: 30,
      })

      const blobEndpoint = getBlobEndpoint(connInfo.accountName, connInfo.endpointSuffix)

      // Find the first real content blob in the projection container.
      // Knowledge Store creates directory markers (ResourceType=directory,
      // Content-Length=0) and places the actual JSON blob inside them.
      const contentBlob = await findFirstContentBlob({
        blobEndpoint,
        containerName: ksContainerName.trim(),
        sasToken,
      })

      if (!contentBlob) {
        setLastProjection({ message: t('spbDebugMsgNoBlobsDirectory') } as unknown as JsonValue)
        setMessage({ type: 'error', text: t('spbDebugMsgNoBlobsFound') })
        return
      }

      // Read the content blob.
      const projectionJson = await readBlobAsJson({
        blobEndpoint,
        containerName: ksContainerName.trim(),
        blobName: contentBlob.name,
        sasToken,
      })

      setLastProjection(projectionJson as JsonValue)

      // Map the projection data into a synthetic search-result document
      // keyed by the same field names as the outputFieldMappings, so the
      // Enrichment Tree can display the values without any UI changes.
      // Use blobPath (Shaper input name based path) when available so we
      // navigate the Shaper output structure rather than the enrichment tree.
      const outputsForMapping = resolvedOutputsRef.current.map(o => ({
        sourcePath: o.blobPath || o.sourcePath,
        fieldName: o.fieldName,
        enrichmentPath: o.blobPath ? o.sourcePath : undefined,
      }))
      const syntheticResult = mapProjectionToSearchResult(
        projectionJson,
        outputsForMapping,
      )

      onFetchedDocs?.(syntheticResult as unknown as JsonValue)
      setMessage({ type: 'success', text: format('spbDebugMsgFetchedProjection', { name: contentBlob.name, size: contentBlob.contentLength }) })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      setLastProjection({ error: detail } as unknown as JsonValue)
      setMessage({ type: 'error', text: format('spbDebugErrFetchProjectionFailed', { error: detail }) })
    } finally {
      setBusy(false)
    }
  }

  const cleanup = async () => {
    if (!profile) {
      setMessage({ type: 'error', text: t('spbDebugErrProfileRequired') })
      return
    }

    const p = profile as ConnectionProfile

    stopPolling()
    setBusy(true)
    setMessage(null)
    try {
      const actions: Record<string, JsonValue> = {}

      const delIndexer = await deleteIndexer({ profile: p, indexerName: debugIndexerName.trim(), apiVersion, language })
      actions.deleteIndexer = restResultToLogJson(delIndexer)

      const delDs = await deleteDataSource({ profile: p, dataSourceName: debugDataSourceName.trim(), apiVersion, language })
      actions.deleteDataSource = restResultToLogJson(delDs)

      const delSkillset = await deleteSkillset({ profile: p, skillsetName: debugSkillsetName.trim(), apiVersion, language })
      actions.deleteSkillset = restResultToLogJson(delSkillset)

      if (createIndexChecked) {
        const delIndex = await deleteIndex({ profile: p, indexName: debugIndexName.trim(), apiVersion, language })
        actions.deleteIndex = restResultToLogJson(delIndex)
      }

      // Best-effort cleanup of the Knowledge Store projection container.
      if (ksProjectionEnabled && ksContainerName.trim()) {
        try {
          const connInfo = parseStorageConnectionString(storageConnectionString)
          if (connInfo) {
            const sasToken = await generateAccountSas({
              accountName: connInfo.accountName,
              accountKey: connInfo.accountKey,
              permissions: 'rld',  // read + list + delete
              services: 'b',
              resourceTypes: 'sco',
              expiryMinutes: 10,
            })
            const blobEndpoint = getBlobEndpoint(connInfo.accountName, connInfo.endpointSuffix)
            await deleteContainer({ blobEndpoint, containerName: ksContainerName.trim(), sasToken })
            actions.deleteKsContainer = { ok: true, container: ksContainerName.trim() } as unknown as JsonValue
          }
        } catch (e) {
          actions.deleteKsContainer = { ok: false, error: e instanceof Error ? e.message : String(e) } as unknown as JsonValue
        }
      }

      setLastProvision(actions)
      setMessage({ type: 'success', text: t('spbDebugMsgCleanupDone') })
    } finally {
      setBusy(false)
    }
  }

  // ── Start Debug (automatic full pipeline) ────────────────────────────────
  // Runs: Provision → Run indexer → Poll until complete → Fetch projections → Cleanup → Switch to Enrichment Tree
  // This is a self-contained flow that doesn't call the individual step functions
  // (which manage their own busy state), to avoid state conflicts.
  const startDebug = async () => {
    const basicErr = validateBasics()
    if (basicErr) {
      setMessage({ type: 'error', text: basicErr })
      return
    }

    const p = profile as ConnectionProfile

    stopPolling()
    setBusy(true)
    setMessage(null)
    setDebugProgress(null)

    try {
      // ── Step 1: Provision ──
      setDebugProgress(t('spbDebugProgressProvisioning'))

      const parsedSkillset = safeJsonParse(skillsetJson)
      if (!parsedSkillset.ok) {
        setMessage({ type: 'error', text: format('spbDebugErrSkillsetJsonParse', { error: parsedSkillset.error }) })
        return
      }

      const skillsetBody: Record<string, unknown> = isRecord(parsedSkillset.value) ? { ...parsedSkillset.value } : {}
      skillsetBody.name = debugSkillsetName.trim()
      delete skillsetBody['_ragops']

      const extractedOutputs = extractSkillOutputs(skillsetBody)
      const usedFieldNames = new Map<string, number>()
      const resolvedOutputs: ResolvedSkillOutput[] = extractedOutputs.map((x) => {
        const fieldName = makeDebugCaptureFieldName({ skillName: x.skillName, outputName: x.outputName, usedFieldNames })
        return { ...x, fieldName }
      })

      const generatedOutputFieldMappings = resolvedOutputs.map((x) => {
        const shape = guessOutputMappingShape(x)
        return { sourceFieldName: shape.sourcePath, targetFieldName: x.fieldName, mappingFunction: null }
      })

      const generatedIndexFields = resolvedOutputs.map((x) => {
        const shape = guessOutputMappingShape(x)
        return { name: x.fieldName, type: shape.fieldType, retrievable: true, searchable: shape.fieldType === 'Edm.String', filterable: false, sortable: false, facetable: false }
      })

      // KS Projection
      if (ksProjectionEnabled) {
        const connInfo = parseStorageConnectionString(storageConnectionString)
        if (!connInfo) {
          setMessage({ type: 'error', text: t('spbDebugErrInvalidStorageConnKs') })
          return
        }

        const { shaperInputs, blobPathMap } = buildShaperInputs(extractedOutputs)
        for (const ro of resolvedOutputs) { ro.blobPath = blobPathMap.get(ro.sourcePath) }

        const shaperSkill = {
          '@odata.type': '#Microsoft.Skills.Util.ShaperSkill',
          name: 'ragops_debug_shaper',
          description: 'Auto-generated by RAGOps Studio Debug Runner.',
          context: '/document',
          inputs: shaperInputs,
          outputs: [{ name: 'output', targetName: 'ragops_debug_capture' }],
        }
        const skills = Array.isArray(skillsetBody.skills) ? (skillsetBody.skills as unknown[]) : []
        skills.push(shaperSkill)
        skillsetBody.skills = skills

        skillsetBody.knowledgeStore = {
          storageConnectionString: storageConnectionString.trim(),
          projections: [{ tables: [], objects: [{ storageContainer: ksContainerName.trim(), source: '/document/ragops_debug_capture', generatedKeyName: 'ragops_debug_id' }], files: [] }],
        }
      }

      resolvedOutputsRef.current = resolvedOutputs

      const putSkillset = await createOrUpdateSkillset({ profile: p, skillsetName: debugSkillsetName.trim(), apiVersion, body: skillsetBody as unknown as JsonValue, language })
      if (!putSkillset.ok) { setMessage({ type: 'error', text: putSkillset.error.message }); return }

      let resolvedKeyFieldName = 'id'

      if (createIndexChecked) {
        const parsedIndex = safeJsonParse(indexJson)
        if (!parsedIndex.ok) { setMessage({ type: 'error', text: format('spbDebugErrIndexJsonParse', { error: parsedIndex.error }) }); return }

        const indexBody: Record<string, unknown> = isRecord(parsedIndex.value) ? { ...parsedIndex.value } : {}
        indexBody.name = debugIndexName.trim()
        resolvedKeyFieldName = findIndexKeyFieldName(indexBody) ?? 'id'

        if (autoGenerateMappings) {
          const fields = Array.isArray(indexBody.fields) ? (indexBody.fields as any[]) : []
          const baseFields = [
            { name: 'id', type: 'Edm.String', key: true, filterable: true, sortable: true },
            { name: 'metadata_storage_path', type: 'Edm.String', filterable: true, retrievable: true },
            { name: 'metadata_storage_name', type: 'Edm.String', filterable: true, retrievable: true },
            { name: 'content', type: 'Edm.String', searchable: true, retrievable: true, filterable: false, sortable: false, facetable: false },
          ]
          indexBody.fields = forceContentFieldMinimal(mergeIndexFields(mergeIndexFields(baseFields, fields), generatedIndexFields))
          resolvedKeyFieldName = findIndexKeyFieldName(indexBody) ?? resolvedKeyFieldName
          setIndexJson(JSON.stringify(indexBody, null, 2))
        }

        const putIndex = await createOrUpdateIndex({ profile: p, indexName: debugIndexName.trim(), apiVersion, body: indexBody as unknown as JsonValue, language })
        if (!putIndex.ok) { setMessage({ type: 'error', text: putIndex.error.message }); return }
      }

      const dsBody: Record<string, unknown> = {
        name: debugDataSourceName.trim(), type: 'azureblob',
        credentials: { connectionString: storageConnectionString.trim() },
        container: { name: containerName.trim(), query: virtualFolder.trim() },
      }
      const putDs = await createOrUpdateDataSource({ profile: p, dataSourceName: debugDataSourceName.trim(), apiVersion, body: dsBody as unknown as JsonValue, language })
      if (!putDs.ok) { setMessage({ type: 'error', text: putDs.error.message }); return }

      const rkf = resolvedKeyFieldName
      const indexerBody: Record<string, unknown> = {
        name: debugIndexerName.trim(), dataSourceName: debugDataSourceName.trim(),
        targetIndexName: debugIndexName.trim(), skillsetName: debugSkillsetName.trim(),
        fieldMappings: [
          { sourceFieldName: 'metadata_storage_path', targetFieldName: 'metadata_storage_path' },
          { sourceFieldName: 'metadata_storage_path', targetFieldName: rkf, mappingFunction: { name: 'base64Encode', parameters: { useHttpServerUtilityUrlTokenEncode: false } } },
        ],
        outputFieldMappings: autoGenerateMappings ? generatedOutputFieldMappings : undefined,
        parameters: { maxFailedItems: -1, maxFailedItemsPerBatch: -1, configuration: { dataToExtract: 'contentAndMetadata' } },
      }
      const putIndexer = await createOrUpdateIndexer({ profile: p, indexerName: debugIndexerName.trim(), apiVersion, body: indexerBody as unknown as JsonValue, language })
      if (!putIndexer.ok) { setMessage({ type: 'error', text: putIndexer.error.message }); return }

      setLastProvision({ skillset: 'ok', index: 'ok', dataSource: 'ok', indexer: 'ok' } as unknown as JsonValue)
      setMessage({ type: 'success', text: t('spbDebugMsgProvisionedRunning') })

      // ── Step 2: Run indexer ──
      setDebugProgress(t('spbDebugProgressRunning'))
      const runRes = await runIndexer({ profile: p, indexerName: debugIndexerName.trim(), apiVersion, language })
      setLastRun(restResultToLogJson(runRes))
      if (!runRes.ok) {
        setMessage({ type: 'error', text: format('spbDebugErrRunFailed', { error: runRes.error.message }) })
        return
      }

      // ── Step 3: Poll until indexer completes ──
      setDebugProgress(t('spbDebugProgressWaiting'))
      const pollResult = await new Promise<string>((resolve) => {
        const timer = window.setInterval(async () => {
          const st = await getIndexerStatus({ profile: p, indexerName: debugIndexerName.trim(), apiVersion, language })
          if (!st.ok) {
            window.clearInterval(timer)
            setLastStatus(restResultToLogJson(st))
            resolve('error')
            return
          }
          setLastStatus(st.response)
          const lastResultStatus = getIndexerLastResultStatus(st.response)
          if (isTerminalIndexerStatus(lastResultStatus)) {
            window.clearInterval(timer)
            resolve(String(lastResultStatus))
          }
        }, 2000)
      })

      if (pollResult === 'error') {
        setMessage({ type: 'error', text: t('spbDebugMsgPollingFailed') })
        return
      }
      if (pollResult !== 'success') {
        setMessage({ type: 'error', text: format('spbDebugMsgIndexerStatusFinished', { status: pollResult }) })
        return
      }

      // ── Step 4: Fetch projections ──
      if (ksProjectionEnabled) {
        setDebugProgress(t('spbDebugProgressFetchingProjections'))
        await fetchProjections()
      }

      // ── Step 5: Cleanup (conditional) ──
      if (autoCleanup) {
        setDebugProgress(t('spbDebugProgressCleaningUp'))
        await cleanup()
      }

      // ── Done ──
      setDebugProgress(null)
      setMessage({ type: 'success', text: autoCleanup ? t('spbDebugMsgDebugComplete') : t('spbDebugMsgDebugCompleteNoCleanup') })


    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      setMessage({ type: 'error', text: format('spbDebugErrDebugFailed', { error: detail }) })
    } finally {
      setDebugProgress(null)
      setBusy(false)
    }
  }

  // Expose startDebug to parent via ref (must be after startDebug definition)
  useImperativeHandle(ref, () => ({ startDebug }))

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <div className="section__hint" style={{ marginBottom: 10 }}>
        {t('spbDebugRunnerIntro')}
      </div>

      {message && (
        <div className={message.type === 'error' ? 'notice notice--error builder__notice' : 'notice notice--success builder__notice'}>
          {message.text}
        </div>
      )}

      {debugProgress && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, padding: '8px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--panel-3, var(--panel-2))', border: '1px solid var(--border)' }}>
          <span className="spinner" style={{ width: 14, height: 14, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', display: 'inline-block' }} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>{debugProgress}</span>
        </div>
      )}

      {/* ── Essential settings (always visible) ── */}
      <div className="actions actions--mb10" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="field" style={{ minWidth: 320 }}>
          <span className="field__label">{t('spbDebugStorageConnectionString')}</span>
          <input
            className="field__input"
            value={storageConnectionString}
            onChange={(e) => setStorageConnectionString(e.target.value)}
            placeholder="DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net"
          />
        </div>
        <div className="field" style={{ minWidth: 220 }}>
          <span className="field__label">{t('spbDebugBlobContainer')}</span>
          <input className="field__input" value={containerName} onChange={(e) => setContainerName(e.target.value)} placeholder="my-container" />
        </div>
        <div className="field" style={{ minWidth: 220 }}>
          <span className="field__label">{t('spbDebugBlobVirtualFolder')}</span>
          <input
            className="field__input"
            value={virtualFolder}
            onChange={(e) => setVirtualFolder(e.target.value)}
            placeholder="path/to/file.pdf"
          />
        </div>
      </div>

      {/* ── Start Debug button (primary action) ── */}
      <div className="actions actions--mb10" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          style={{ fontWeight: 600, padding: '8px 20px', fontSize: 14, background: 'var(--accent)', color: 'var(--accent-fg, #fff)', border: 'none', borderRadius: 'var(--radius-sm)' }}
          onClick={startDebug}
          disabled={!profile || busy}
        >
          <i className="bi bi-play-fill" style={{ marginRight: 6 }}></i>
          {t('spbDebugStartDebug')}
        </button>
        {busy && !debugProgress && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('spbDebugProcessing')}</span>}
      </div>

      {/* ── Advanced / Developer settings (collapsible) ── */}
      <details open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)} style={{ marginBottom: 14 }}>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-muted)',
            padding: '4px 0',
            userSelect: 'none',
          }}
        >
          <i className="bi bi-gear" style={{ marginRight: 4 }}></i>
          {t('spbDebugAdvancedSettings')}
        </summary>

        <div style={{ paddingTop: 10 }}>
          <div className="actions actions--mb10" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div className="field" style={{ minWidth: 280 }}>
              <span className="field__label">{t('spbDebugPrefix')}</span>
              <input
                className="field__input"
                value={resourcePrefix}
                onChange={(e) => {
                  const next = e.target.value
                  setResourcePrefix(next)
                  if (debugIndexName.startsWith(resourcePrefix)) setDebugIndexName(`${next}-idx`)
                  if (debugDataSourceName.startsWith(resourcePrefix)) setDebugDataSourceName(`${next}-ds`)
                  if (debugIndexerName.startsWith(resourcePrefix)) setDebugIndexerName(`${next}-ixr`)
                }}
              />
            </div>
            <div className="field" style={{ minWidth: 260 }}>
              <span className="field__label">{t('spbDebugSkillsetName')}</span>
              <input className="field__input" value={debugSkillsetName} onChange={(e) => setDebugSkillsetName(e.target.value)} />
            </div>
            <div className="field" style={{ minWidth: 240 }}>
              <span className="field__label">{t('spbDebugIndexName')}</span>
              <input className="field__input" value={debugIndexName} onChange={(e) => setDebugIndexName(e.target.value)} />
            </div>
            <div className="field" style={{ minWidth: 240 }}>
              <span className="field__label">{t('spbDebugDataSourceName')}</span>
              <input className="field__input" value={debugDataSourceName} onChange={(e) => setDebugDataSourceName(e.target.value)} />
            </div>
            <div className="field" style={{ minWidth: 240 }}>
              <span className="field__label">{t('spbDebugIndexerName')}</span>
              <input className="field__input" value={debugIndexerName} onChange={(e) => setDebugIndexerName(e.target.value)} />
            </div>
          </div>

          <div className="actions actions--mb10" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={createIndexChecked} onChange={(e) => setCreateIndexChecked(e.target.checked)} />
              {t('spbDebugCreateIndex')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={autoGenerateMappings}
                onChange={(e) => setAutoGenerateMappings(e.target.checked)}
                disabled={!createIndexChecked}
              />
              {t('spbDebugAutoGenerateMappings')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={t('spbDebugKsProjectionHint')}>
              <input type="checkbox" checked={ksProjectionEnabled} onChange={(e) => setKsProjectionEnabled(e.target.checked)} />
              {t('spbDebugKsProjectionMode')}
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={t('spbDebugAutoCleanupHint')}>
              <input type="checkbox" checked={autoCleanup} onChange={(e) => setAutoCleanup(e.target.checked)} />
              {t('spbDebugAutoCleanup')}
            </label>
          </div>

          {ksProjectionEnabled ? (
            <div className="actions actions--mb10" style={{ flexWrap: 'wrap', gap: 10 }}>
              <div className="field" style={{ minWidth: 280 }}>
                <span className="field__label">{t('spbDebugKsContainerName')}</span>
                <input
                  className="field__input"
                  value={ksContainerName}
                  onChange={(e) => setKsContainerName(e.target.value)}
                  placeholder="ragops-debug-ks-..."
                />
              </div>
              <div className="section__hint" style={{ fontSize: 12, lineHeight: '1.5', alignSelf: 'center', maxWidth: 460 }}>
                {t('spbDebugKsProjectionHint')}
              </div>
            </div>
          ) : null}

          {/* ── Individual operation buttons (developer) ── */}
          <div className="actions actions--mb10" style={{ alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn--sm" onClick={provision} disabled={!profile || busy}>
              {t('spbDebugProvision')}
            </button>
            <button type="button" className="btn btn--sm" onClick={run} disabled={!profile || busy}>
              {t('spbDebugRun')}
            </button>
            <button type="button" className="btn btn--sm" onClick={fetchDocs} disabled={!profile || busy}>
              {t('spbDebugFetchDocs')}
            </button>
            {ksProjectionEnabled ? (
              <button type="button" className="btn btn--sm" onClick={fetchProjections} disabled={busy}>
                {t('spbDebugFetchProjections')}
              </button>
            ) : null}
            <button type="button" className="btn btn--sm" onClick={cleanup} disabled={!profile || busy}>
              {t('spbDebugCleanup')}
            </button>
            <button type="button" className="btn btn--xs" onClick={stopPolling} disabled={!pollTimerRef.current}>
              {t('spbDebugStopPolling')}
            </button>
          </div>

          {createIndexChecked ? (
            <div style={{ marginBottom: 14 }}>
              <div className="section__title" style={{ fontSize: 14, marginBottom: 6 }}>
                {t('spbDebugIndexJson')}
              </div>
              <ExpandableCodeMirror
                t={t}
                modalTitle={t('spbDebugIndexJson')}
                value={indexJson}
                height="220px"
                theme={codeMirrorTheme}
                extensions={[json(), EditorView.lineWrapping]}
                onChange={(v) => setIndexJson(v)}
              />
            </div>
          ) : null}
        </div>
      </details>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
        <div>
          <div className="section__title" style={{ fontSize: 14, marginBottom: 6 }}>
            {t('spbDebugSectionProvisionCleanup')}
          </div>
          {lastProvision ? <JsonViewer data={lastProvision} t={t} initialOpenDepth={2} /> : <div className="muted">{t('spbNone')}</div>}
        </div>

        <div>
          <div className="section__title" style={{ fontSize: 14, marginBottom: 6 }}>
            {t('spbDebugSectionRun')}
          </div>
          {lastRun ? <JsonViewer data={lastRun} t={t} initialOpenDepth={2} /> : <div className="muted">{t('spbNone')}</div>}
        </div>

        <div>
          <div className="section__title" style={{ fontSize: 14, marginBottom: 6 }}>
            {t('spbDebugLastStatus')}
          </div>
          {lastStatus ? <JsonViewer data={lastStatus} t={t} initialOpenDepth={3} collapseArraysByDefault /> : <div className="muted">{t('spbNone')}</div>}
        </div>

        <div>
          <div className="section__title" style={{ fontSize: 14, marginBottom: 6 }}>
            {t('spbDebugLastDocs')}
          </div>
          {lastDocs ? <JsonViewer data={lastDocs} t={t} initialOpenDepth={2} collapseArraysByDefault /> : <div className="muted">{t('spbNone')}</div>}
        </div>

        {ksProjectionEnabled ? (
          <>
            <div>
              <div className="section__title" style={{ fontSize: 14, marginBottom: 6 }}>
                {t('spbDebugProjectionStatus')}
              </div>
              {lastProjection ? (
                <JsonViewer data={lastProjection} t={t} initialOpenDepth={3} collapseArraysByDefault />
              ) : (
                <div className="muted">{t('spbNone')}</div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
})
