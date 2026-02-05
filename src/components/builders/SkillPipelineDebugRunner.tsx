import { useMemo, useRef, useState } from 'react'

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
import { translations, type Language } from '../../lib/translations'
import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import { JsonViewer } from '../viewers/JsonViewer'

type TranslationKey = keyof typeof translations.ja

type UiMessage = { type: 'success' | 'error' | 'info'; text: string }

type SkillsetSkillLike = {
  '@odata.type'?: unknown
  name?: unknown
  context?: unknown
  outputs?: unknown
}

type ExtractedSkillOutput = {
  skillName: string
  odataType: string
  context: string
  outputName: string
  targetName: string
  sourcePath: string
}

type ResolvedSkillOutput = ExtractedSkillOutput & { fieldName: string }

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

function normalizeJsonPointerPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return '/document'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function joinEnrichmentPath(context: string, child: string): string {
  const base = normalizeJsonPointerPath(context)
  const c = child.trim()
  if (!c) return base
  if (base.endsWith('/')) return `${base}${c}`
  return `${base}/${c}`
}

function toSearchFieldName(input: string): string {
  // Azure AI Search field names: start with a letter, and contain only letters, digits, underscores.
  const raw = input.trim()
  const stripped = raw.replace(/^\/document\//, '').replace(/^\//, '')
  const underscored = stripped.replace(/[^A-Za-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  const startsOk = underscored.match(/^[A-Za-z]/) ? underscored : `f_${underscored || 'out'}`
  return startsOk.slice(0, 128)
}

function extractSkillOutputs(skillset: Record<string, unknown>): ExtractedSkillOutput[] {
  const skills = Array.isArray(skillset.skills) ? (skillset.skills as unknown[]) : []
  const out: ExtractedSkillOutput[] = []

  for (const s of skills) {
    const skill = (isRecord(s) ? (s as SkillsetSkillLike) : {}) as SkillsetSkillLike
    const odataType = typeof skill['@odata.type'] === 'string' ? (skill['@odata.type'] as string) : ''
    const skillName = typeof skill.name === 'string' ? (skill.name as string) : ''
    const context = typeof skill.context === 'string' ? (skill.context as string) : '/document'
    const outputs = Array.isArray(skill.outputs) ? (skill.outputs as unknown[]) : []

    for (const o of outputs) {
      if (!isRecord(o)) continue
      const outputName = typeof o.name === 'string' ? (o.name as string) : ''
      if (!outputName.trim()) continue
      const targetNameRaw = typeof o.targetName === 'string' ? (o.targetName as string) : ''
      const targetName = (targetNameRaw.trim() || outputName.trim()).trim()
      const sourcePath = joinEnrichmentPath(context, targetName)

      out.push({
        skillName: skillName || '(unnamed-skill)',
        odataType,
        context,
        outputName: outputName.trim(),
        targetName,
        sourcePath,
      })
    }
  }

  return out
}

function guessOutputMappingShape(x: ExtractedSkillOutput): { sourcePath: string; fieldType: string } {
  // Minimal, docs-aligned heuristics. Most outputs are strings; some are string collections.
  // Users can always edit index JSON if the inferred type is wrong.
  const odata = x.odataType.toLowerCase()
  const outName = x.outputName.toLowerCase()

  // KeyPhraseExtractionSkill -> keyPhrases is a collection of strings; docs show a trailing /*.
  if (odata.includes('keyphraseextractionskill') && outName === 'keyphrases') {
    return { sourcePath: `${x.sourcePath}/*`, fieldType: 'Collection(Edm.String)' }
  }

  // OCR skill outputs are commonly collections; docs map without trailing /*.
  if (odata.includes('ocrskill') && (outName === 'text' || outName === 'layouttext')) {
    return { sourcePath: x.sourcePath, fieldType: 'Collection(Edm.String)' }
  }

  // Default: store as a simple string.
  return { sourcePath: x.sourcePath, fieldType: 'Edm.String' }
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
      { name: 'content', type: 'Edm.String', searchable: true },
    ],
  }
  return JSON.stringify(base, null, 2)
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

export function SkillPipelineDebugRunner(props: {
  t: (k: TranslationKey) => string
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
  language: Language
  theme: string
  skillsetJson: string
  defaultSkillsetName: string
}) {
  const { t, profile, apiVersion, language, theme, skillsetJson, defaultSkillsetName } = props

  const codeMirrorTheme = useMemo(() => {
    const isLight = theme === 'light' || theme === 'solarized'
    return isLight ? githubLight : githubDark
  }, [theme])

  const nowSuffix = useMemo(() => {
    const d = new Date()
    const pad2 = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  }, [])

  const [storageConnectionString, setStorageConnectionString] = useState('')
  const [containerName, setContainerName] = useState('')
  const [virtualFolder, setVirtualFolder] = useState('')

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

  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<UiMessage | null>(null)

  const [lastProvision, setLastProvision] = useState<JsonValue | null>(null)
  const [lastRun, setLastRun] = useState<JsonValue | null>(null)
  const [lastStatus, setLastStatus] = useState<JsonValue | null>(null)
  const [lastDocs, setLastDocs] = useState<JsonValue | null>(null)

  const pollTimerRef = useRef<number | null>(null)

  const stopPolling = () => {
    if (pollTimerRef.current) {
      window.clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }

  const validateBasics = (): string | null => {
    if (!profile) return 'profile is required'
    if (!apiVersion || !apiVersion.trim()) return 'apiVersion is required'
    if (!debugSkillsetName.trim()) return 'skillset name is required'
    if (!debugIndexName.trim()) return 'index name is required'
    if (!debugDataSourceName.trim()) return 'data source name is required'
    if (!debugIndexerName.trim()) return 'indexer name is required'
    if (!storageConnectionString.trim()) return 'storage connection string is required'
    if (!containerName.trim()) return 'container name is required'
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
        setMessage({ type: 'error', text: `skillset JSON parse error: ${parsedSkillset.error}` })
        return
      }

      const skillsetBody: Record<string, unknown> = isRecord(parsedSkillset.value) ? { ...parsedSkillset.value } : {}
      skillsetBody.name = debugSkillsetName.trim()
      // Remove internal UI metadata before sending to the service.
      // Azure AI Search rejects unknown properties on the skillset resource.
      delete skillsetBody['_ragops']

      // Generate outputFieldMappings and index fields from skill outputs (per Microsoft docs).
      // https://learn.microsoft.com/azure/search/cognitive-search-output-field-mapping
      const extractedOutputs = extractSkillOutputs(skillsetBody)
      const usedFieldNames = new Map<string, number>()
      const resolvedOutputs: ResolvedSkillOutput[] = extractedOutputs.map((x) => {
        const base = toSearchFieldName(x.targetName)
        const prev = usedFieldNames.get(base) ?? 0
        usedFieldNames.set(base, prev + 1)

        if (prev === 0) return { ...x, fieldName: base }

        // Collision: disambiguate deterministically.
        const withSkill = toSearchFieldName(`${x.skillName}_${x.targetName}`)
        const altPrev = usedFieldNames.get(withSkill) ?? 0
        if (altPrev === 0) {
          usedFieldNames.set(withSkill, 1)
          return { ...x, fieldName: withSkill }
        }

        return { ...x, fieldName: `${base}_${prev + 1}` }
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
          setMessage({ type: 'error', text: `index JSON parse error: ${parsedIndex.error}` })
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
            { name: 'content', type: 'Edm.String', searchable: true, retrievable: true },
          ]

          indexBody.fields = mergeIndexFields(mergeIndexFields(baseFields, fields), generatedIndexFields)

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
      if (virtualFolder.trim() && isRecord(dsBody.container)) (dsBody.container as Record<string, unknown>).query = virtualFolder.trim()

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
              // Default is URL-safe when omitted; keep explicit for clarity.
              parameters: { useHttpServerUtilityUrlTokenEncode: true },
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
      setMessage({ type: 'success', text: 'Provisioned debug resources.' })
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

      setMessage({ type: 'success', text: 'Indexer run started. Polling status…' })

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
          setMessage({ type: 'success', text: `Indexer finished: ${String(lastResultStatus)}` })
          stopPolling()
        }
      }, 2000)
    } finally {
      setBusy(false)
    }
  }

  const fetchDocs = async () => {
    if (!profile) {
      setMessage({ type: 'error', text: 'profile is required' })
      return
    }
    if (!debugIndexName.trim()) {
      setMessage({ type: 'error', text: 'index name is required' })
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
        setMessage({ type: 'error', text: res.error.message })
        return
      }
      setMessage({ type: 'success', text: 'Fetched documents from debug index.' })
    } finally {
      setBusy(false)
    }
  }

  const cleanup = async () => {
    if (!profile) {
      setMessage({ type: 'error', text: 'profile is required' })
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

      setLastProvision(actions)
      setMessage({ type: 'success', text: 'Cleanup attempted (some deletes may be no-op if missing).' })
    } finally {
      setBusy(false)
    }
  }

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
            placeholder="optional/path/prefix"
          />
        </div>
      </div>

      <div className="actions actions--mb10" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div className="field" style={{ minWidth: 280 }}>
          <span className="field__label">prefix</span>
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
        <button type="button" className="btn" onClick={provision} disabled={!profile || busy}>
          {t('spbDebugProvision')}
        </button>
        <button type="button" className="btn" onClick={run} disabled={!profile || busy}>
          {t('spbDebugRun')}
        </button>
        <button type="button" className="btn" onClick={fetchDocs} disabled={!profile || busy}>
          {t('spbDebugFetchDocs')}
        </button>
        <button type="button" className="btn" onClick={cleanup} disabled={!profile || busy}>
          {t('spbDebugCleanup')}
        </button>
        <button type="button" className="btn btn--xs" onClick={stopPolling} disabled={!pollTimerRef.current}>
          Stop polling
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

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
        <div>
          <div className="section__title" style={{ fontSize: 14, marginBottom: 6 }}>
            Provision / Cleanup
          </div>
          {lastProvision ? <JsonViewer data={lastProvision} t={t} initialOpenDepth={2} /> : <div className="muted">(none)</div>}
        </div>

        <div>
          <div className="section__title" style={{ fontSize: 14, marginBottom: 6 }}>
            Run
          </div>
          {lastRun ? <JsonViewer data={lastRun} t={t} initialOpenDepth={2} /> : <div className="muted">(none)</div>}
        </div>

        <div>
          <div className="section__title" style={{ fontSize: 14, marginBottom: 6 }}>
            {t('spbDebugLastStatus')}
          </div>
          {lastStatus ? <JsonViewer data={lastStatus} t={t} initialOpenDepth={3} collapseArraysByDefault /> : <div className="muted">(none)</div>}
        </div>

        <div>
          <div className="section__title" style={{ fontSize: 14, marginBottom: 6 }}>
            {t('spbDebugLastDocs')}
          </div>
          {lastDocs ? <JsonViewer data={lastDocs} t={t} initialOpenDepth={2} collapseArraysByDefault /> : <div className="muted">(none)</div>}
        </div>
      </div>
    </div>
  )
}
