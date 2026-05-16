/**
 * Index management tool.
 *
 * Lets the user list, inspect, create/update, and delete search indexes, with a
 * JSON editor and basic stats display.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import { githubLight, githubDark } from '@uiw/codemirror-theme-github'
import { json } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'
import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import type { ThemePreference } from '../../types/app'
import { deleteIndex, getIndexDefinition, getIndexStatistics, listIndexes, type JsonValue } from '../../lib/aiSearchRest'
import { translations, type Language } from '../../lib/translations'
import { useIndexPublishFlow } from '../../hooks/useIndexPublishFlow'
import { PublishDiffModal } from './PublishDiffModal'
import { IndexCloneAssistant } from './IndexCloneAssistant'
import { IndexAliasManager } from './IndexAliasManager'
import { IndexSchemaConfigurationEditorPanel, IndexSchemaOverview, type ConfigEditorTab } from './IndexSchemaOverview'
import { applyIndexSchemaTemplate, type IndexSchemaTemplateKind } from './indexSchemaTemplates'

type IndexBuilderProps = {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion | ''
  activeIndexName?: string
  language: Language
  theme: ThemePreference
  onClose: () => void
  copyToClipboard: (text: string) => Promise<void>
}

type UiMessage = { type: 'success' | 'error'; text: string }

type IndexStats = {
  documentCount?: number
  storageSize?: number
  vectorIndexSize?: number
}

type IndexBuilderRightTab = 'schema' | 'config' | 'json' | 'clone' | 'aliases'

const indexBuilderRightTabs: Array<{ id: IndexBuilderRightTab; labelKey: keyof typeof translations.ja; icon: string }> = [
  { id: 'schema', labelKey: 'indexBuilderSchemaWorkbench', icon: 'bi-stars' },
  { id: 'config', labelKey: 'indexBuilderConfigEditors', icon: 'bi-ui-checks-grid' },
  { id: 'json', labelKey: 'indexBuilderJsonEditor', icon: 'bi-code-slash' },
  { id: 'clone', labelKey: 'indexCloneAssistant', icon: 'bi-intersect' },
  { id: 'aliases', labelKey: 'indexBuilderAliases', icon: 'bi-signpost-split' },
]

const indexTemplateLabelKeys: Record<IndexSchemaTemplateKind, keyof typeof translations.ja> = {
  semantic: 'indexBuilderFeatureSemantic',
  suggester: 'indexBuilderFeatureSuggesters',
  scoringProfile: 'indexBuilderFeatureScoringProfiles',
  cors: 'indexBuilderFeatureCors',
  vectorSearch: 'indexBuilderFeatureVectorSearch',
}

const INDEX_BUILDER_SPLIT_STORAGE_KEY = 'ragops.indexBuilder.listPanePercent'
const INDEX_BUILDER_SPLIT_DEFAULT_PERCENT = 26
const INDEX_BUILDER_SPLIT_MIN_PERCENT = 16
const INDEX_BUILDER_SPLIT_MAX_PERCENT = 42

function clampIndexBuilderSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return INDEX_BUILDER_SPLIT_DEFAULT_PERCENT
  return Math.min(INDEX_BUILDER_SPLIT_MAX_PERCENT, Math.max(INDEX_BUILDER_SPLIT_MIN_PERCENT, value))
}

function readIndexBuilderSplitPercent(): number {
  try {
    if (typeof window === 'undefined') return INDEX_BUILDER_SPLIT_DEFAULT_PERCENT
    const raw = window.localStorage.getItem(INDEX_BUILDER_SPLIT_STORAGE_KEY)
    return raw === null ? INDEX_BUILDER_SPLIT_DEFAULT_PERCENT : clampIndexBuilderSplitPercent(Number(raw))
  } catch {
    return INDEX_BUILDER_SPLIT_DEFAULT_PERCENT
  }
}

function writeIndexBuilderSplitPercent(value: number): void {
  try {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(INDEX_BUILDER_SPLIT_STORAGE_KEY, String(clampIndexBuilderSplitPercent(value)))
  } catch {
    // Storage can fail in restricted browser modes.
  }
}

function formatBytes(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-'
  const abs = Math.abs(n)
  if (abs < 1024) return `${n.toFixed(0)} B`
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`
  if (abs < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatCount(n: number | null | undefined, locale: string): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '-'
  try {
    return new Intl.NumberFormat(locale).format(n)
  } catch {
    return new Intl.NumberFormat().format(n)
  }
}

export function IndexBuilder({ profile, apiVersion, activeIndexName, language, theme, copyToClipboard }: IndexBuilderProps) {
  const t = (key: keyof typeof translations.ja): string => String(translations[language][key] ?? '')
  const format = (key: keyof typeof translations.ja, params: Record<string, string | number>): string => {
    let text: string = t(key)
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v))
    }
    return text
  }
  const codeMirrorTheme = useMemo(() => (theme === 'light' ? githubLight : githubDark), [theme])

  const [indexNames, setIndexNames] = useState<string[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [selectedName, setSelectedName] = useState('')

  const [loadingDef, setLoadingDef] = useState(false)
  const [definition, setDefinition] = useState<JsonValue | null>(null)
  const [editedJson, setEditedJson] = useState('')
  const [baselineJson, setBaselineJson] = useState('')

  const [saving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [loadingStats, setLoadingStats] = useState(false)
  const [stats, setStats] = useState<IndexStats | null>(null)
  const [statsError, setStatsError] = useState<string>('')

  const [message, setMessage] = useState<UiMessage | null>(null)
  const [filterText, setFilterText] = useState('')
  const [rightTab, setRightTab] = useState<IndexBuilderRightTab>('schema')
  const [activeConfigEditorTab, setActiveConfigEditorTab] = useState<ConfigEditorTab>('semantic')
  const [indexListPaneWidthPercent, setIndexListPaneWidthPercent] = useState(readIndexBuilderSplitPercent)
  const [isIndexBuilderSplitterDragging, setIsIndexBuilderSplitterDragging] = useState(false)

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const splitContainerRef = useRef<HTMLDivElement | null>(null)

  // ── Index Publish Flow (diff before save) ────────────────────────────
  const indexPublish = useIndexPublishFlow({ profile, apiVersion, language, t })

  const canQuery = !!profile && !!apiVersion && apiVersion.trim().length > 0

  const openConfigEditorTab = useCallback((tab: ConfigEditorTab) => {
    setActiveConfigEditorTab(tab)
    setRightTab('config')
  }, [])

  const isDirty = useMemo(() => {
    return editedJson.trim().length > 0 && editedJson !== baselineJson
  }, [editedJson, baselineJson])

  const isExistingSelectedIndex = useMemo(() => {
    const name = selectedName.trim()
    if (!name) return false
    return indexNames.includes(name)
  }, [selectedName, indexNames])

  const indexBuilderGridStyle = useMemo(() => ({
    '--index-builder-list-pane': `${indexListPaneWidthPercent}%`,
  }) as CSSProperties, [indexListPaneWidthPercent])

  const startIndexBuilderSplitterDrag = useCallback((clientX: number) => {
    const container = splitContainerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (rect.width <= 0) return

    const updateWidth = (x: number) => {
      const next = ((x - rect.left) / rect.width) * 100
      setIndexListPaneWidthPercent(clampIndexBuilderSplitPercent(next))
    }

    setIsIndexBuilderSplitterDragging(true)
    updateWidth(clientX)

    const handlePointerMove = (event: PointerEvent) => {
      event.preventDefault()
      updateWidth(event.clientX)
    }
    const handlePointerUp = () => {
      setIsIndexBuilderSplitterDragging(false)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerUp)
  }, [])

  useEffect(() => {
    writeIndexBuilderSplitPercent(indexListPaneWidthPercent)
  }, [indexListPaneWidthPercent])

  const confirmDiscardIfDirty = (): boolean => {
    if (!isDirty) return true
    return window.confirm(t('indexBuilderDiscardUnsavedConfirm'))
  }

  const setEditorJson = (next: unknown) => {
    const nextText = JSON.stringify(next ?? {}, null, 2)
    setEditedJson(nextText)
    setBaselineJson(nextText)
  }

  const parseEditedIndex = (): { name: string; body: JsonValue } | null => {
    const raw = editedJson.trim()
    if (!raw) {
      setMessage({ type: 'error', text: t('indexBuilderJsonEmptyError') })
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      setMessage({
        type: 'error',
        text: format('indexBuilderJsonParseError', { error: e instanceof Error ? e.message : String(e) }),
      })
      return null
    }

    if (!parsed || typeof parsed !== 'object') {
      setMessage({ type: 'error', text: t('indexBuilderJsonMustBeObject') })
      return null
    }

    const name = (parsed as { name?: unknown }).name
    if (typeof name !== 'string' || !name.trim()) {
      setMessage({ type: 'error', text: t('indexBuilderJsonNameRequired') })
      return null
    }

    return { name: name.trim(), body: parsed as JsonValue }
  }

  const loadIndexes = async () => {
    if (!profile || !apiVersion.trim()) return
    setLoadingList(true)
    setMessage(null)

    try {
      const res = await listIndexes({ profile, apiVersion, language })
      if (!res.ok) {
        setIndexNames([])
        setMessage({ type: 'error', text: `${t('failedToLoad')}: ${res.error.message}` })
        return
      }

      const json = res.response
      const value =
        json && typeof json === 'object' && Array.isArray((json as { value?: unknown }).value)
          ? ((json as { value: Array<{ name?: unknown }> }).value ?? [])
          : []

      const names = value
        .map((x) => (typeof x?.name === 'string' ? x.name : ''))
        .filter((s) => s.trim().length > 0)
        .map((s) => s.trim())

      const uniq = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b))
      setIndexNames(uniq)

      // Auto-select: activeIndexName -> first index
      const preferred = (activeIndexName ?? '').trim()
      const nextSelected = preferred && uniq.includes(preferred) ? preferred : (uniq[0] ?? '')
      setSelectedName((prev) => prev.trim() ? prev : nextSelected)
    } catch (e) {
      setIndexNames([])
      setMessage({ type: 'error', text: `${t('failedToLoad')}: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setLoadingList(false)
    }
  }

  const loadDefinition = useCallback(async (name: string) => {
    const idx = name.trim()
    if (!profile || !apiVersion.trim() || !idx) return

    setLoadingDef(true)
    setMessage(null)
    setDefinition(null)
    setEditedJson('')
    setBaselineJson('')

    try {
      const res = await getIndexDefinition({ profile, apiVersion, indexName: idx, language })
      if (!res.ok) {
        setDefinition(res.error.response ?? null)
        const text = JSON.stringify(res.error.response ?? {}, null, 2)
        setEditedJson(text)
        setBaselineJson(text)
        setMessage({ type: 'error', text: res.error.message })
        return
      }
      setDefinition(res.response)
      const text = JSON.stringify(res.response ?? {}, null, 2)
      setEditedJson(text)
      setBaselineJson(text)
    } catch (e) {
      setDefinition(null)
      setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoadingDef(false)
    }
  }, [profile, apiVersion, language])

  const loadStats = useCallback(async (name: string) => {
    const idx = name.trim()
    if (!profile || !apiVersion.trim() || !idx) return

    setLoadingStats(true)
    setStats(null)
    setStatsError('')

    try {
      const res = await getIndexStatistics({ profile, apiVersion, indexName: idx, language })
      if (!res.ok) {
        setStatsError(res.error.message)
        return
      }

      const body = res.response
      if (!body || typeof body !== 'object') {
        setStatsError('Invalid response')
        return
      }

      const obj = body as Record<string, unknown>
      const documentCount = typeof obj.documentCount === 'number' ? obj.documentCount : undefined
      const storageSize = typeof obj.storageSize === 'number' ? obj.storageSize : undefined
      const vectorIndexSize = typeof obj.vectorIndexSize === 'number' ? obj.vectorIndexSize : undefined

      setStats({ documentCount, storageSize, vectorIndexSize })
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingStats(false)
    }
  }, [profile, apiVersion, language])

  const onSaveIndex = async () => {
    if (!canQuery || !profile || !apiVersion.trim()) return

    const parsed = parseEditedIndex()
    if (!parsed) return

    const selected = selectedName.trim()
    const targetName = parsed.name

    if (selected && selected !== targetName) {
      const ok = window.confirm(
        format('indexBuilderNameMismatchConfirm', { selected, name: targetName }),
      )
      if (!ok) return
    }

    // Open the diff confirmation modal instead of saving directly
    await indexPublish.onPublishClick(editedJson)
  }

  /** Called when the user confirms publish inside the diff modal. */
  const onConfirmIndexPublish = async () => {
    const updatedText = await indexPublish.publishToAzure()
    if (updatedText) {
      const targetName = indexPublish.publishTargetName
      setMessage({ type: 'success', text: format('indexBuilderSaved', { name: targetName, status: 200 }) })
      await loadIndexes()
      setSelectedName(targetName)
      await loadDefinition(targetName)
    }
  }

  const onNewIndex = () => {
    if (!confirmDiscardIfDirty()) return
    setMessage(null)
    setDefinition({} as JsonValue)
    setSelectedName('')

    // Minimal valid skeleton (REST): name + fields + key
    setEditorJson({
      name: 'my-index',
      fields: [{ name: 'id', type: 'Edm.String', key: true }],
    })
    setRightTab('json')
  }

  const onImportJsonClick = () => {
    if (!confirmDiscardIfDirty()) return
    fileInputRef.current?.click()
  }

  const onImportJsonFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget
    const file = input.files?.[0] ?? null
    input.value = ''

    if (!file) return

    setMessage(null)
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object') {
        setMessage({ type: 'error', text: t('indexBuilderJsonMustBeObject') })
        return
      }

      setDefinition(parsed as JsonValue)
      setSelectedName('')
      setEditorJson(parsed)
      setRightTab('json')
      setMessage({ type: 'success', text: t('indexBuilderImported') })
    } catch (err) {
      setMessage({
        type: 'error',
        text: format('indexBuilderJsonParseError', { error: err instanceof Error ? err.message : String(err) }),
      })
    }
  }

  const onExportJson = () => {
    const raw = editedJson.trim()
    if (!raw) {
      setMessage({ type: 'error', text: t('indexBuilderJsonEmptyError') })
      return
    }

    let fileBase = 'index'
    try {
      const parsed = JSON.parse(raw)
      const name = (parsed as { name?: unknown })?.name
      if (typeof name === 'string' && name.trim()) fileBase = name.trim()
    } catch {
      // Export raw even if JSON is invalid.
    }

    const blob = new Blob([raw], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = `${fileBase}.json`
      a.click()
      setMessage({ type: 'success', text: t('indexBuilderExported') })
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  const onDeleteIndex = async () => {
    if (!canQuery || !profile || !apiVersion.trim()) return

    const selected = selectedName.trim()
    if (!selected) {
      setMessage({ type: 'error', text: t('indexBuilderSelectIndexToDeleteError') })
      return
    }

    const ok = window.confirm(
      format('indexBuilderDeleteConfirm', { name: selected }),
    )
    if (!ok) return

    setDeleting(true)
    setMessage(null)
    try {
      const res = await deleteIndex({ profile, apiVersion, indexName: selected, language })
      if (!res.ok) {
        setMessage({ type: 'error', text: res.error.message })
        return
      }

      setMessage({ type: 'success', text: format('indexBuilderDeleted', { name: selected, status: res.status }) })
      setSelectedName('')
      setDefinition(null)
      setEditedJson('')
      await loadIndexes()
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setDeleting(false)
    }
  }

  const onApplySchemaTemplate = (kind: IndexSchemaTemplateKind) => {
    const parsed = parseEditedIndex()
    if (!parsed) return
    if (!parsed.body || typeof parsed.body !== 'object' || Array.isArray(parsed.body)) {
      setMessage({ type: 'error', text: t('indexBuilderJsonMustBeObject') })
      return
    }

    const next = applyIndexSchemaTemplate(parsed.body as Record<string, unknown>, kind)
    const text = JSON.stringify(next, null, 2)
    setDefinition(next as JsonValue)
    setEditedJson(text)
    setMessage({
      type: 'success',
      text: format('indexBuilderTemplateApplied', { feature: t(indexTemplateLabelKeys[kind]) }),
    })
  }

  const onChangeSchemaIndex = (nextIndex: Record<string, unknown>) => {
    const text = JSON.stringify(nextIndex, null, 2)
    setDefinition(nextIndex as JsonValue)
    setEditedJson(text)
  }

  const onApplyCloneJson = (cloneDefinition: JsonValue, sourceIndexName: string, targetIndexName: string) => {
    const text = JSON.stringify(cloneDefinition ?? {}, null, 2)
    setDefinition(cloneDefinition)
    setSelectedName('')
    setEditedJson(text)
    setBaselineJson('')
    setRightTab('json')
    setMessage({ type: 'success', text: format('indexClonePrepared', { source: sourceIndexName, target: targetIndexName }) })
  }

  const onCloneCompleted = async (targetIndexName: string) => {
    await loadIndexes()
    setSelectedName(targetIndexName)
    await loadDefinition(targetIndexName)
    await loadStats(targetIndexName)
  }

  useEffect(() => {
    setIndexNames([])
    setSelectedName('')
    setDefinition(null)
    setEditedJson('')
    setBaselineJson('')
    setMessage(null)

    if (!canQuery) return
    void loadIndexes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, apiVersion])

  useEffect(() => {
    const preferred = (activeIndexName ?? '').trim()
    if (!preferred) return
    setSelectedName(preferred)
  }, [activeIndexName])

  useEffect(() => {
    const name = selectedName.trim()
    if (!name) return
    if (!canQuery) return

    // Only auto-load definitions for indexes that exist in the service.
    // This prevents imported/draft JSON from being overwritten by a GET.
    if (!indexNames.includes(name)) return
    void loadDefinition(name)
    void loadStats(name)
  }, [selectedName, canQuery, indexNames, loadDefinition, loadStats])

  const filteredIndexNames = useMemo(() => {
    const q = filterText.trim().toLowerCase()
    if (!q) return indexNames
    return indexNames.filter((n) => n.toLowerCase().includes(q))
  }, [indexNames, filterText])

  return (
    <div className="pane__centerContent">
      <div className="section">
        <div className="section__title">{t('indexBuilder')}</div>

        <div className="section__hint">{t('indexBuilderJsonEditHint')}</div>

        {!canQuery && (
          <div className="notice notice--error builder__notice">
            {t('indexBuilderMissingProfileOrApiVersion')}
          </div>
        )}

        {message && (
          <div className={`notice notice--${message.type} builder__notice`}>
            {message.text}
          </div>
        )}

        <div ref={splitContainerRef} className="builder__grid builder__grid--resizable" style={indexBuilderGridStyle}>
          <div className="builder__listPane">
            <div className="builder__sidebarTitle">{format('indexBuilderIndexes', { count: indexNames.length })}</div>
            <div className="form form--compact">
              <label className="field field--full">
                <span className="field__label">{t('indexBuilderFilterLabel')}</span>
                <input
                  className="field__input"
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  placeholder={t('indexBuilderFilterPlaceholder')}
                  disabled={!canQuery}
                />
              </label>
            </div>
            <button
              type="button"
              className="btn builder__refreshBtn"
              onClick={loadIndexes}
              disabled={!canQuery || loadingList}
              title={t('indexBuilderRefreshIndexListTitle')}
            >
              <i className="bi bi-arrow-clockwise"></i> {t('refresh')}
            </button>

            <button
              type="button"
              className="btn builder__refreshBtn"
              onClick={onNewIndex}
              disabled={!canQuery || loadingList || loadingDef || saving || deleting}
              title={t('indexBuilderNewTitle')}
            >
              <i className="bi bi-plus-lg"></i> {t('indexBuilderNew')}
            </button>
            <div className="builder__listBox" data-guide-target="index-builder-list">
              {filteredIndexNames.map((name) => (
                <div key={name} className="builder-list-item">
                  <button
                    type="button"
                    className={`btn builder-list-item__btn ${selectedName === name ? 'builder-list-item__btn--active' : ''}`}
                    onClick={() => setSelectedName(name)}
                    disabled={!canQuery}
                    title={name}
                  >
                    {name}
                  </button>
                </div>
              ))}
              {filteredIndexNames.length === 0 && (
                <div className="empty">{t('indexBuilderNoIndexes')}</div>
              )}
            </div>
          </div>

          <div
            role="separator"
            aria-orientation="vertical"
            aria-valuemin={INDEX_BUILDER_SPLIT_MIN_PERCENT}
            aria-valuemax={INDEX_BUILDER_SPLIT_MAX_PERCENT}
            aria-valuenow={Math.round(indexListPaneWidthPercent)}
            tabIndex={0}
            className={'indexBuilderSplitter' + (isIndexBuilderSplitterDragging ? ' indexBuilderSplitter--active' : '')}
            title={language === 'ja' ? 'インデックス一覧と右ペインの幅をドラッグで調整' : 'Drag to resize the index list and right pane'}
            onPointerDown={(event) => {
              event.preventDefault()
              startIndexBuilderSplitterDrag(event.clientX)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              setIndexListPaneWidthPercent((current) => {
                const delta = event.key === 'ArrowLeft' ? -2 : 2
                return clampIndexBuilderSplitPercent(current + delta)
              })
            }}
          >
            <span className="indexBuilderSplitter__bar" />
          </div>

          <div className="builder__mainPane">
            <div className="builder__editorTitle">
              {selectedName.trim()
                ? format('indexBuilderDefinitionWithName', { name: selectedName })
                : t('indexBuilderDefinition')}
            </div>

            {selectedName.trim() && isExistingSelectedIndex && (
              <div className="section__hint">
                {loadingStats && <span>{t('indexBuilderStatsLoading')}</span>}
                {!loadingStats && statsError && (
                  <span>{format('indexBuilderStatsError', { error: statsError })}</span>
                )}
                {!loadingStats && !statsError && stats && (
                  <span>
                    {format('indexBuilderStatsDocCount', { count: formatCount(stats.documentCount, language) })} &nbsp;|&nbsp;{' '}
                    {format('indexBuilderStatsVectorSize', { size: formatBytes(stats.vectorIndexSize) })} &nbsp;|&nbsp;{' '}
                    {format('indexBuilderStatsTotalSize', { size: formatBytes(stats.storageSize) })}
                  </span>
                )}
                {!loadingStats && !statsError && !stats && (
                  <span>{t('indexBuilderStatsUnavailable')}</span>
                )}
              </div>
            )}

            <div className="actions actions--mt10" data-guide-target="index-builder-actions">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={onImportJsonFileChange}
              />

              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (!confirmDiscardIfDirty()) return
                  void loadDefinition(selectedName)
                  void loadStats(selectedName)
                }}
                disabled={!canQuery || !selectedName.trim() || !isExistingSelectedIndex || loadingDef || saving || deleting}
                title={t('indexBuilderReloadDefinitionTitle')}
              >
                <i className="bi bi-arrow-clockwise icon--mr6"></i>
                {t('indexBuilderReloadDefinition')}
              </button>

              <button
                type="button"
                className="btn"
                onClick={onSaveIndex}
                disabled={!canQuery || loadingDef || !editedJson.trim() || saving || deleting || indexPublish.publishLoading}
                title={t('indexBuilderSaveTitle')}
              >
                <i className="bi bi-save icon--mr6"></i>
                {saving || indexPublish.publishLoading ? t('indexBuilderSaving') : t('indexBuilderSave')}
              </button>

              <button
                type="button"
                className="btn"
                onClick={onDeleteIndex}
                disabled={!canQuery || !selectedName.trim() || loadingDef || saving || deleting}
                title={t('indexBuilderDeleteTitle')}
              >
                <i className="bi bi-trash icon--mr6"></i>
                {deleting ? t('indexBuilderDeleting') : t('indexBuilderDelete')}
              </button>

              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={onImportJsonClick}
                  disabled={!canQuery || loadingDef || saving || deleting}
                  title={t('indexBuilderImportTitle')}
                >
                  <i className="bi bi-upload icon--mr6"></i>
                  {t('indexBuilderImport')}
                </button>

                <button
                  type="button"
                  className="btn"
                  onClick={onExportJson}
                  disabled={!editedJson.trim() || loadingDef || saving || deleting}
                  title={t('indexBuilderExportTitle')}
                >
                  <i className="bi bi-download icon--mr6"></i>
                  {t('indexBuilderExport')}
                </button>
              </div>
            </div>

            <div className="indexBuilderSubTabs" role="tablist" aria-label={t('indexBuilder')}>
              {indexBuilderRightTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={rightTab === tab.id}
                  className={'btn btn--tab ' + (rightTab === tab.id ? 'btn--active' : '')}
                  onClick={() => setRightTab(tab.id)}
                  data-guide-target={tab.id === 'json' ? 'index-builder-editor' : undefined}
                >
                  <i className={`bi ${tab.icon} icon--mr6`}></i>
                  {t(tab.labelKey)}
                </button>
              ))}
            </div>

            {rightTab === 'schema' ? (
              <div className="indexBuilderSubtabPanel" role="tabpanel">
                <IndexSchemaOverview
                  editedJson={editedJson}
                  baselineJson={baselineJson}
                  isExistingIndex={isExistingSelectedIndex}
                  language={language}
                  onApplyTemplate={onApplySchemaTemplate}
                  onOpenConfigEditorTab={openConfigEditorTab}
                  onChangeIndex={onChangeSchemaIndex}
                />
              </div>
            ) : null}

            {rightTab === 'config' ? (
              <div className="indexBuilderSubtabPanel" role="tabpanel">
                <IndexSchemaConfigurationEditorPanel
                  editedJson={editedJson}
                  baselineJson={baselineJson}
                  isExistingIndex={isExistingSelectedIndex}
                  language={language}
                  activeTab={activeConfigEditorTab}
                  onActiveTabChange={setActiveConfigEditorTab}
                  onChangeIndex={onChangeSchemaIndex}
                />
              </div>
            ) : null}

            {rightTab === 'json' ? (
              <div className="indexBuilderSubtabPanel indexBuilderJsonSection" role="tabpanel">
                {loadingDef && <div className="empty">{t('loading')}…</div>}
                {!loadingDef && definition === null && (
                  <div className="empty">{t('indexBuilderSelectIndexHint')}</div>
                )}
                {!loadingDef && definition !== null && (
                  <div className="builder__jsonViewBox">
                    <div className="synonym-editor">
                      <ExpandableCodeMirror
                        t={t}
                        modalTitle={t('indexBuilder')}
                        value={editedJson}
                        height="calc(100vh - 360px)"
                        theme={codeMirrorTheme}
                        basicSetup={{
                          lineNumbers: true,
                          foldGutter: true,
                          highlightActiveLine: true,
                        }}
                        extensions={[json(), EditorView.lineWrapping]}
                        onChange={(value) => setEditedJson(value)}
                      />
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            <div className="indexBuilderSubtabPanel" role="tabpanel" hidden={rightTab !== 'clone'}>
              <IndexCloneAssistant
                profile={profile}
                apiVersion={apiVersion}
                language={language}
                indexNames={indexNames}
                selectedIndexName={selectedName}
                editedJson={editedJson}
                onApplyCloneJson={onApplyCloneJson}
                onCloneCompleted={onCloneCompleted}
              />
            </div>

            <div className="indexBuilderSubtabPanel" role="tabpanel" hidden={rightTab !== 'aliases'}>
              <IndexAliasManager
                profile={profile}
                apiVersion={apiVersion}
                language={language}
                indexNames={indexNames}
                selectedIndexName={selectedName}
              />
            </div>
          </div>
        </div>

        {/* ── Publish error from the diff flow ──────────────────── */}
        {indexPublish.publishError && (
          <div className="notice notice--error builder__notice" style={{ marginTop: 8 }}>
            {indexPublish.publishError}
            <button type="button" className="btn btn--sm" style={{ marginLeft: 8 }} onClick={indexPublish.clearMessages}>✕</button>
          </div>
        )}
        {indexPublish.publishOkMessage && (
          <div className="notice notice--success builder__notice" style={{ marginTop: 8 }}>
            {indexPublish.publishOkMessage}
            <button type="button" className="btn btn--sm" style={{ marginLeft: 8 }} onClick={indexPublish.clearMessages}>✕</button>
          </div>
        )}
      </div>

      {/* ── Index Diff Modal ───────────────────────────────────── */}
      <PublishDiffModal
        t={t}
        language={language}
        theme={theme}
        copyToClipboard={copyToClipboard}
        open={indexPublish.saveDiffOpen}
        onClose={indexPublish.closeDiffDialog}
        onConfirmPublish={onConfirmIndexPublish}
        publishLoading={indexPublish.publishLoading}
        diffViewMode={indexPublish.diffViewMode}
        setDiffViewMode={indexPublish.setDiffViewMode}
        publishBaselineText={indexPublish.publishBaselineText}
        publishCandidateJson={indexPublish.publishCandidateJson}
        semanticDiff={indexPublish.semanticDiff}
        normalizedDiffLineSets={indexPublish.normalizedDiffLineSets}
        publishTargetName={indexPublish.publishTargetName}
        isNewSkillset={indexPublish.isNewIndex}
        refetchingBaseline={indexPublish.refetchingBaseline}
        onChangeTargetName={indexPublish.changeTargetName}
        existingSkillsetNames={indexPublish.existingIndexNames}
        resourceLabels={{
          targetNameLabel: 'indexBuilderPublishTargetName',
          createNewLabel: 'indexBuilderPublishCreateNew',
          updateExistingLabel: 'indexBuilderPublishUpdateExisting',
          selectExistingLabel: 'indexBuilderPublishSelectExisting',
          createNewOptionLabel: 'indexBuilderPublishCreateNewOption',
          newNamePlaceholderLabel: 'indexBuilderPublishNewNamePlaceholder',
          targetNameHintLabel: 'indexBuilderPublishTargetNameHint',
        }}
      />
    </div>
  )
}
