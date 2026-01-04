/**
 * Search pipeline visualizer.
 *
 * Runs representative searches across stages (text/vector/hybrid/semantic_hybrid)
 * and renders request/response summaries to help debug retrieval configuration.
 */

import { useMemo, useState, useEffect } from 'react'
import type { ConnectionProfile, AppSettings, SearchApiVersion } from '../../lib/model'
import { searchDocuments, getIndexDefinition, type JsonValue, type RestResult } from '../../lib/aiSearchRest'
import { extractDocs, pickFirstStringField, pickPrimaryText } from '../../utils/apiHelpers'
import { translations, type Language } from '../../lib/translations'
import { InfoTooltip } from '../InfoTooltip'

type JsonObject = { [key: string]: JsonValue }

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type SearchPipelineVisualizerProps = {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
  indexName: string
  language: Language
  settings: AppSettings | null
}

type StageId = 'text' | 'vector' | 'hybrid' | 'semantic_hybrid'

type StageResult = {
  id: StageId
  label: string
  requestBody: JsonValue
  result: RestResult | null
}

type Row = {
  id: string
  title: string
  text?: string
  score?: number
  rerankerScore?: number
  fields?: Record<string, JsonValue>
}

function scalarToIdString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

function idNameRank(fieldName: string): number {
  const n = fieldName.toLowerCase()
  if (n === 'id') return 0
  if (n.startsWith('id') || n.endsWith('id')) return 1
  if (n.includes('id')) return 2
  return 3
}

function sortByIdPreference(fieldNames: string[]): string[] {
  return [...fieldNames].sort((a, b) => {
    const ra = idNameRank(a)
    const rb = idNameRank(b)
    if (ra !== rb) return ra - rb
    return a.localeCompare(b)
  })
}

function inferKeyFieldFromDocs(docs: Array<Record<string, JsonValue>>): string | null {
  if (docs.length === 0) return null

  // Policy: prefer validating fields that include "id".
  // (Only accept candidates that are unique and scalar across all documents.)
  const preferredNonId = ['key', 'url', 'path', 'name', 'title']

  const allKeys = new Set<string>()
  for (const d of docs) {
    for (const k of Object.keys(d)) allKeys.add(k)
  }

  const all = [...allKeys]
  const idLike = sortByIdPreference(all.filter((k) => idNameRank(k) < 3))
  const rest = all.filter((k) => idNameRank(k) === 3)

  // For non-id fields, keep the legacy preference order, then append the rest.
  const preferredNonIdInAll = preferredNonId.filter((k) => allKeys.has(k))
  const restNonId = rest.filter((k) => !preferredNonId.includes(k)).sort((a, b) => a.localeCompare(b))

  const candidates = [...idLike, ...preferredNonIdInAll, ...restNonId]

  for (const k of candidates) {
    const values: string[] = []
    let ok = true
    for (const d of docs) {
      const asId = scalarToIdString(d[k])
      if (asId) {
        values.push(asId)
      } else {
        ok = false
        break
      }
    }
    if (!ok) continue
    const uniq = new Set(values)
    if (uniq.size === values.length) return k
  }

  return null
}

function pickStableId(doc: Record<string, JsonValue>, keyField: string | null): string {
  if (keyField) {
    const asId = scalarToIdString(doc[keyField])
    if (asId) return asId
  }

  // When auto-selecting, prefer fields that include "id".
  const idLikeKeys = sortByIdPreference(Object.keys(doc).filter((k) => idNameRank(k) < 3))
  for (const k of idLikeKeys) {
    const asId = scalarToIdString(doc[k])
    if (asId) return asId
  }

  const candidates = ['id', 'key', 'documentId', 'chunkId', 'path', 'url', 'name', 'title']
  for (const k of candidates) {
    const asId = scalarToIdString(doc[k])
    if (asId) return asId
  }
  const first = Object.entries(doc).find(([, v]) => typeof v === 'string' || typeof v === 'number')
  if (first) return String(first[1])
  return JSON.stringify(doc)
}

function toRows(
  body: JsonValue,
  titleCandidates: string | undefined,
  textCandidates: string | undefined,
  keyField: string | null,
): Row[] {
  const docs = extractDocs(body)
  return docs.map((doc) => {
    const score = typeof doc['@search.score'] === 'number' ? doc['@search.score'] : undefined
    const rerankerScore = typeof doc['@search.rerankerScore'] === 'number' ? doc['@search.rerankerScore'] : undefined
    const text = pickFirstStringField(doc, textCandidates) ?? (typeof doc.text === 'string' ? doc.text : undefined)
    return {
      id: pickStableId(doc, keyField),
      title: pickPrimaryText(doc, titleCandidates),
      text,
      score,
      rerankerScore,
      fields: doc,
    }
  })
}

function rankMap(rows: Row[]): Map<string, number> {
  const m = new Map<string, number>()
  rows.forEach((r, idx) => m.set(r.id, idx + 1))
  return m
}

export function SearchPipelineVisualizer({ profile, apiVersion, indexName, language, settings }: SearchPipelineVisualizerProps) {
  const t = (key: keyof typeof translations.ja): string => String(translations[language][key] ?? '')
  const format = (key: keyof typeof translations.ja, params: Record<string, string | number>): string => {
    let text: string = t(key)
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
    return text
  }

  const [query, setQuery] = useState(() => t('sampleQuery'))
  const [vectorText, setVectorText] = useState('')
  const [vectorFieldsInput, setVectorFieldsInput] = useState('')
  const [top, setTop] = useState(1000)
  const [vectorK, setVectorK] = useState(50)
  const [maxTextRecallSize, setMaxTextRecallSize] = useState<number | null>(1000)
  const [idField, setIdField] = useState('')
  const [semanticConfiguration, setSemanticConfiguration] = useState('default')
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [stages, setStages] = useState<StageResult[] | null>(null)
  const [docKeyField, setDocKeyField] = useState<string | null>(null)
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null)
  const [indexSchema, setIndexSchema] = useState<JsonValue | null>(null)
  const [isLoadingSchema, setIsLoadingSchema] = useState(false)

  const titleCandidates = settings?.displayTitleFields ?? 'title,name,id,key,documentId,chunkId,path,url,metadata_storage_name'
  const textCandidates = settings?.displayTextFields ?? 'text,content,description,chunk'

  const effectiveIdField = useMemo(() => {
    const explicit = idField.trim()
    return explicit.length > 0 ? explicit : docKeyField
  }, [idField, docKeyField])

  const maxTextRecallSizeValue = useMemo(() => {
    return typeof maxTextRecallSize === 'number' && Number.isFinite(maxTextRecallSize) && maxTextRecallSize > 0
      ? Math.floor(maxTextRecallSize)
      : null
  }, [maxTextRecallSize])

  const indexFields = useMemo(() => {
    if (!indexSchema || !isJsonObject(indexSchema)) return []
    const fields = indexSchema.fields
    if (!Array.isArray(fields)) return []
    return fields
      .filter((f): f is JsonObject => isJsonObject(f))
      .map((f) => ({
        name: typeof f.name === 'string' ? f.name : '',
        type: typeof f.type === 'string' ? f.type : '',
      }))
  }, [indexSchema])

  const vectorFields = useMemo(() => {
    return indexFields.filter(f => f.type?.startsWith('Collection(Edm.Single)') || f.type?.includes('vector')).map(f => f.name)
  }, [indexFields])

  const allFieldNames = useMemo(() => {
    return indexFields.map(f => f.name)
  }, [indexFields])

  const queryLanguage = useMemo(() => {
    if (language === 'ja') return 'ja-jp'
    return 'en-us'
  }, [language])

  useEffect(() => {
    if (!selectedDocId) return

    const cssEscape = (value: string): string => {
      const cssObj = (globalThis as typeof globalThis & { CSS?: { escape?: (v: string) => string } }).CSS
      if (cssObj && typeof cssObj.escape === 'function') return cssObj.escape(value)
      // Minimal fallback: escape quotes/backslashes for attribute selectors.
      return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    }

    try {
      // Get all rows that have the selected docId.
      const rows = document.querySelectorAll(`[data-doc-id="${cssEscape(selectedDocId)}"]`)

      rows.forEach((row) => {
        // Find the scrollable table wrapper (.spvStage__tableWrap) for each row.
        const tableWrap = row.closest('.spvStage__tableWrap')
        if (!tableWrap) return

        // Get row and wrapper positions.
        const rowRect = (row as HTMLElement).getBoundingClientRect()

        // Compute a scroll position so the row is centered within the wrapper.
        const rowOffsetInWrap = (row as HTMLElement).offsetTop
        const wrapHeight = tableWrap.clientHeight
        const rowHeight = rowRect.height

        const targetScroll = rowOffsetInWrap - (wrapHeight / 2) + (rowHeight / 2)

        // Smooth scroll.
        tableWrap.scrollTo({
          top: targetScroll,
          behavior: 'smooth'
        })
      })
    } catch {
      // Ignore selector/escape issues; this effect is best-effort.
    }
  }, [selectedDocId])

  useEffect(() => {
    async function loadSchema() {
      if (!profile || !indexName.trim()) {
        setIndexSchema(null)
        return
      }
      setIsLoadingSchema(true)
      try {
        const result = await getIndexDefinition({ profile, indexName, apiVersion, language })
        if (result.ok) {
          setIndexSchema(result.response)
        } else {
          setIndexSchema(null)
        }
      } catch {
        setIndexSchema(null)
      } finally {
        setIsLoadingSchema(false)
      }
    }
    loadSchema()
  }, [profile, indexName, apiVersion, language])

  useEffect(() => {
    if (vectorFields.length > 0 && !vectorFields.includes(vectorFieldsInput)) {
      setVectorFieldsInput(vectorFields[0])
    }
  }, [vectorFields, vectorFieldsInput])

  useEffect(() => {
    if (!indexSchema || !isJsonObject(indexSchema)) return
    const schema = indexSchema
    
    // Prefer defaultConfiguration; otherwise use the first element of semantic.configurations.
    let defaultSemanticConfig = ''
    const semantic = isJsonObject(schema.semantic) ? schema.semantic : null
    if (semantic && typeof semantic.defaultConfiguration === 'string') {
      defaultSemanticConfig = semantic.defaultConfiguration
    } else if (semantic && Array.isArray(semantic.configurations) && semantic.configurations.length > 0) {
      const first = semantic.configurations[0]
      const firstObj = isJsonObject(first) ? first : null
      defaultSemanticConfig = typeof firstObj?.name === 'string' ? firstObj.name : ''
    }
    
    if (defaultSemanticConfig) {
      setSemanticConfiguration(defaultSemanticConfig)
    }
  }, [indexSchema])

  const rrfSources = useMemo(() => {
    if (!stages) return null
    const stageById = new Map(stages.map((s) => [s.id, s]))
    const text = stageById.get('text')
    const vector = stageById.get('vector')
    if (!text?.result?.ok || !vector?.result?.ok) return null

    const textRows = toRows(text.result.response, titleCandidates, textCandidates, effectiveIdField)
    const vectorRows = toRows(vector.result.response, titleCandidates, textCandidates, effectiveIdField)

    return {
      textRanks: rankMap(textRows),
      vectorRanks: rankMap(vectorRows),
    }
  }, [stages, titleCandidates, textCandidates, effectiveIdField])

  async function run() {
    setError(null)
    setStages(null)
    setDocKeyField(null)

    if (!profile) {
      setError(t('spvErrorProfileUnset'))
      return
    }
    if (!indexName.trim()) {
      setError(t('spvErrorIndexNameUnset'))
      return
    }
    const q = query.trim()
    if (!q) {
      setError(t('spvErrorQueryEmpty'))
      return
    }

    const vText = (vectorText.trim() || q)
    const vFields = (vectorFieldsInput.trim() || 'ada_v3_large')

    const textBody: JsonValue = {
      search: q,
      queryType: 'simple',
      top,
      count: true,
    }

    const vectorBody: JsonValue = {
      top,
      count: true,
      vectorQueries: [
        {
          kind: 'text',
          text: vText,
          fields: vFields,
          k: vectorK,
        },
      ],
    }

    const hybridBody: JsonValue = {
      search: q,
      queryType: 'simple',
      top,
      count: true,
      ...(maxTextRecallSizeValue ? { hybridSearch: { maxTextRecallSize: maxTextRecallSizeValue } } : {}),
      vectorQueries: [
        {
          kind: 'text',
          text: vText,
          fields: vFields,
          k: vectorK,
        },
      ],
    }

    const semanticHybridBody: JsonValue = {
      search: q,
      queryType: 'semantic',
      semanticConfiguration: semanticConfiguration.trim() || 'default',
      queryLanguage,
      captions: 'extractive',
      answers: 'extractive|count-3',
      top,
      count: true,
      ...(maxTextRecallSizeValue ? { hybridSearch: { maxTextRecallSize: maxTextRecallSizeValue } } : {}),
      vectorQueries: [
        {
          kind: 'text',
          text: vText,
          fields: vFields,
          k: vectorK,
        },
      ],
    }

    const initialStages: StageResult[] = [
      { id: 'text', label: t('spvStageText'), requestBody: textBody, result: null },
      { id: 'vector', label: t('spvStageVector'), requestBody: vectorBody, result: null },
      { id: 'hybrid', label: t('spvStageHybrid'), requestBody: hybridBody, result: null },
      { id: 'semantic_hybrid', label: t('spvStageSemanticHybrid'), requestBody: semanticHybridBody, result: null },
    ]

    setIsRunning(true)
    try {
      const [textRes, vectorRes, hybridRes, semanticRes] = await Promise.all([
        searchDocuments({ profile, indexName, apiVersion, body: textBody, language }),
        searchDocuments({ profile, indexName, apiVersion, body: vectorBody, language }),
        searchDocuments({ profile, indexName, apiVersion, body: hybridBody, language }),
        searchDocuments({ profile, indexName, apiVersion, body: semanticHybridBody, language }),
      ])

      const nextStages: StageResult[] = initialStages.map((s) => {
        if (s.id === 'text') return { ...s, result: textRes }
        if (s.id === 'vector') return { ...s, result: vectorRes }
        if (s.id === 'hybrid') return { ...s, result: hybridRes }
        return { ...s, result: semanticRes }
      })

      const keyField = (() => {
        if (hybridRes.ok) return inferKeyFieldFromDocs(extractDocs(hybridRes.response))
        if (semanticRes.ok) return inferKeyFieldFromDocs(extractDocs(semanticRes.response))
        if (textRes.ok) return inferKeyFieldFromDocs(extractDocs(textRes.response))
        return null
      })()
      setDocKeyField(keyField)

      setStages(nextStages)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    } finally {
      setIsRunning(false)
    }
  }

  function renderStage(stage: StageResult) {
    const r = stage.result
    const ok = r?.ok === true
    const statusText = !r ? '' : ok ? `HTTP ${r.status}` : `HTTP ${r.status}`

    const rows = r?.ok ? toRows(r.response, titleCandidates, textCandidates, effectiveIdField) : []

    function formatRrfCell(docId: string): { label: string; value?: number } | null {
      if (!rrfSources) return null
      const rt = rrfSources.textRanks.get(docId)
      const rv = rrfSources.vectorRanks.get(docId)
      if (!rt && !rv) return null

      const k = 59
      const t = rt ? 1 / (rt + k) : 0
      const v = rv ? 1 / (rv + k) : 0
      const value = t + v

      const left = rt ? `1/(${rt}+${k})` : '0'
      const right = rv ? `1/(${rv}+${k})` : '0'
      return {
        label: `${left}+${right}`,
        value,
      }
    }

    const shouldScrollY = rows.length > 10
    const wrapClass = 'spvStage__tableWrap' + (shouldScrollY ? ' spvStage__tableWrap--scrollY' : '')

    return (
      <div key={stage.id} className="spvStage">
        <div className="spvStage__header">
          <div className="spvStage__title">
            <span className="spvStage__label">{stage.label}</span>
            {r && (
              <span className={'spvStage__status ' + (ok ? 'spvStage__status--ok' : 'spvStage__status--err')}>
                {statusText}
              </span>
            )}
          </div>
          {r && (
            <div className="spvStage__meta mono">
              <span>
                {t('spvStageMetaRequestId')}: {r.requestId}
              </span>
              {typeof r.elapsedTimeMs === 'number' && (
                <span>
                  {t('spvStageMetaElapsedTime')}: {r.elapsedTimeMs.toFixed(0)} ms
                </span>
              )}
            </div>
          )}
        </div>

        {r?.ok === false && (
          <div className="notice notice--error" role="status" aria-live="polite">
            <div className="notice__title">{t('spvApiErrorTitle')}</div>
            <div className="notice__meta">{r.error.message}</div>
            {r.error.responseText && <pre className="mono notice__pre">{r.error.responseText}</pre>}
          </div>
        )}

        {r?.ok === true && (
          <div className={wrapClass}>
            <table className="spvTable">
              <thead>
                <tr>
                  <th className="spvCol spvCol--rank">#</th>
                  <th
                    className="spvCol spvCol--docid"
                    title={
                      effectiveIdField
                        ? format('spvIdFieldTitleWithField', { field: effectiveIdField })
                        : t('spvIdFieldTitleAuto')
                    }
                  >
                    {t('spvTableColId')}
                  </th>
                  <th>{t('spvTableColTitle')}</th>
                  <th>{t('spvTableColText')}</th>
                  <th className="spvCol spvCol--score">@search.score</th>
                  {stage.id === 'hybrid' && <th className="spvCol spvCol--rrf">{t('spvTableColCalcRrf')}</th>}
                  {stage.id === 'semantic_hybrid' && <th className="spvCol spvCol--rerank">@search.rerankerScore</th>}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, top).map((row, idx) => {
                  const isSelected = selectedDocId === row.id
                  return (
                    <tr
                      key={row.id + ':' + idx}
                      data-doc-id={row.id}
                      className={'spvRow' + (isSelected ? ' spvRow--selected' : '')}
                      onClick={() => setSelectedDocId((prev) => (prev === row.id ? null : row.id))}
                    >
                    <td className="mono">{idx + 1}</td>
                    <td className="mono spvCell spvCell--ellipsis" title={row.id}>{row.id}</td>
                    <td className="spvCell spvCell--ellipsis" title={row.id}>{row.title}</td>
                    <td className="spvCell spvCell--ellipsis" title={row.text ?? ''}>{row.text ?? ''}</td>
                    <td className="mono">{typeof row.score === 'number' ? row.score.toFixed(6) : ''}</td>
                    {stage.id === 'hybrid' && (() => {
                      const rrf = formatRrfCell(row.id)
                      return (
                        <td className="mono" title={rrf ? `${rrf.label} = ${rrf.value?.toFixed(8)}` : ''}>
                          {rrf ? `${rrf.label} = ${rrf.value?.toFixed(8)}` : ''}
                        </td>
                      )
                    })()}
                    {stage.id === 'semantic_hybrid' && <td className="mono">{typeof row.rerankerScore === 'number' ? row.rerankerScore.toFixed(6) : ''}</td>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="pane__centerContent">
      <div className="section">
        <div className="section__title">{t('searchPipelineVisualizer')}</div>
        <div className="app__hint">
          {t('spvDescription')}
        </div>

        <div className="form">
          <label className="field">
            <span className="field__label">
              query (search)
              <InfoTooltip tooltipKey="spvQuery" language={language} />
            </span>
            <input
              className="field__input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('spvQueryPlaceholderExample')}
            />
          </label>

          <div className="form form--grid2">
            <label className="field">
              <span className="field__label">
                {t('spvLabelVectorText')}
                <InfoTooltip tooltipKey="spvVectorText" language={language} />
              </span>
              <input
                className="field__input"
                value={vectorText}
                onChange={(e) => setVectorText(e.target.value)}
                placeholder={t('spvVectorTextPlaceholderOptional')}
              />
            </label>
            <label className="field">
              <span className="field__label">
                {t('spvLabelVectorFields')}
                <InfoTooltip tooltipKey="spvVectorFields" language={language} />
              </span>
              {isLoadingSchema ? (
                <input className="field__input" value={t('spvVectorFieldsLoading')} disabled />
              ) : vectorFields.length > 0 ? (
                <select
                  className="field__input"
                  value={vectorFieldsInput}
                  onChange={(e) => setVectorFieldsInput(e.target.value)}
                >
                  {vectorFields.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="field__input"
                  value={vectorFieldsInput}
                  onChange={(e) => setVectorFieldsInput(e.target.value)}
                  placeholder={t('spvVectorFieldsPlaceholderExample')}
                />
              )}
            </label>
          </div>

          <div className="form form--grid3">
            <label className="field">
              <span className="field__label">
                top
                <InfoTooltip tooltipKey="spvTop" language={language} />
              </span>
              <input
                className="field__input"
                type="number"
                min={1}
                max={1000}
                value={top}
                onChange={(e) => setTop(Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">
                {t('spvLabelVectorK')}
                <InfoTooltip tooltipKey="spvVectorK" language={language} />
              </span>
              <input
                className="field__input"
                type="number"
                min={1}
                max={200}
                value={vectorK}
                onChange={(e) => setVectorK(Number(e.target.value))}
              />
            </label>
            <label className="field field--full">
              <span className="field__label">
                semanticConfiguration
                <InfoTooltip tooltipKey="spvSemanticConfiguration" language={language} />
              </span>
              <input
                className="field__input"
                value={semanticConfiguration}
                onChange={(e) => setSemanticConfiguration(e.target.value)}
                placeholder="default"
              />
            </label>
          </div>

          <div className="form form--grid2">
            <label className="field">
              <span className="field__label">
                {t('spvLabelMaxTextRecallSizeOptional')}
                <InfoTooltip tooltipKey="spvMaxTextRecallSize" language={language} />
              </span>
              <input
                className="field__input"
                type="number"
                min={1}
                max={10000}
                value={maxTextRecallSize ?? ''}
                onChange={(e) => {
                  const raw = e.target.value
                  if (!raw.trim()) return setMaxTextRecallSize(null)
                  const n = Number(raw)
                  setMaxTextRecallSize(Number.isFinite(n) ? n : null)
                }}
                placeholder="1000"
              />
            </label>
            <label className="field">
              <span className="field__label">
                {t('spvLabelIdFieldRowId')}
                <InfoTooltip tooltipKey="spvIdField" language={language} />
              </span>
              {isLoadingSchema ? (
                <input className="field__input" value={t('spvVectorFieldsLoading')} disabled />
              ) : allFieldNames.length > 0 ? (
                <select
                  className="field__input"
                  value={idField}
                  onChange={(e) => setIdField(e.target.value)}
                >
                  <option value="">{t('spvOptionAutoDetect')}</option>
                  {allFieldNames.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="field__input"
                  value={idField}
                  onChange={(e) => setIdField(e.target.value)}
                  placeholder="docid"
                />
              )}
            </label>
          </div>
        </div>

        {error && (
          <div className="notice notice--error" role="status" aria-live="polite">
            <div className="notice__title">{t('error')}</div>
            <div className="notice__meta">{error}</div>
          </div>
        )}

        <div className="actions">
          <button type="button" className="btn btn--search" onClick={run} disabled={isRunning}>
            <i className="bi bi-bar-chart-steps icon--mr6"></i>
            {isRunning ? t('spvButtonRunning') : t('spvButtonRunPipeline')}
          </button>
        </div>
      </div>

      {stages && (
        <div className="section">
          <div className="section__title">{t('spvPipelineTitle')}</div>
          <div className="spvPipeline">
            {stages.map((s, idx) => (
              <div key={s.id} className="spvPipeline__row">
                <div className="spvNode">{renderStage(s)}</div>
                {idx < stages.length - 1 && <div className="spvEdge" aria-hidden="true">↓</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
