/**
 * Skill Pipeline Builder - Right pane.
 *
 * Hosts JSON editing for the selected skill and skillset-level properties.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'

import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { json } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'

import type { ThemePreference } from '../../types/app'
import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import { useSkillPipelineState, type SkillPipelineSkillDefinition } from '../../contexts'

type TranslationKey = keyof typeof translations.ja

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function ensureSkillShape(input: unknown): SkillPipelineSkillDefinition {
  const obj = isRecord(input) ? input : {}
  const odataType = typeof obj['@odata.type'] === 'string' ? (obj['@odata.type'] as string) : ''
  const name = typeof obj.name === 'string' ? obj.name : undefined
  const description = typeof obj.description === 'string' ? obj.description : undefined
  const context = typeof obj.context === 'string' && obj.context.trim() ? obj.context : '/document'

  const inputsRaw = obj.inputs
  const outputsRaw = obj.outputs

  const inputs = Array.isArray(inputsRaw)
    ? inputsRaw
        .map((x) => {
          const r = isRecord(x) ? x : {}
          return {
            name: typeof r.name === 'string' ? r.name : '',
            source: typeof r.source === 'string' ? r.source : '',
          }
        })
        .filter((x) => x.name.trim() || x.source.trim())
    : []

  const outputs = Array.isArray(outputsRaw)
    ? outputsRaw
        .map((x) => {
          const r = isRecord(x) ? x : {}
          const name = typeof r.name === 'string' ? r.name : ''
          const targetName = typeof r.targetName === 'string' ? r.targetName : undefined
          return { name, targetName }
        })
        .filter((x) => x.name.trim())
    : []

  return {
    ...obj,
    '@odata.type': odataType,
    name,
    description,
    context,
    inputs,
    outputs,
  }
}

export function SkillPipelineRightPane(props: {
  t: (key: TranslationKey) => string
  language: Language
  theme: ThemePreference
  copyToClipboard: (text: string) => Promise<void>
  onCollapse: () => void
}) {
  const { t, language, theme, copyToClipboard } = props

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
    currentSavedId,
    savedSkillsets,
    saveSkillset,
    loadSkillset,
    deleteSkillset,
    nodes,
    setNodes,
    edges,
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
  } = useSkillPipelineState()

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

  const lastSelectedIdRef = useRef<string>('')
  const lastSyncedIndexerJsonRef = useRef<string>('')
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

  const skillsetObject = useMemo(() => {
    const name = skillsetName.trim() || 'skillset1'
    const description = skillsetDescription.trim()

    const skillNodes = nodes.filter((n) => (n as any)?.data?.kind === 'skill')

    const base: Record<string, unknown> = {
      name,
      skills: skillNodes.map((n) => ensureSkillShape((n as any).data?.skill)),
    }
    if (description) base.description = description

    if (indexProjections) base.indexProjections = indexProjections
    if (knowledgeStore) base.knowledgeStore = knowledgeStore

    return base
  }, [edges, nodes, skillsetDescription, skillsetName, indexProjections, knowledgeStore])

  const skillsetJson = useMemo(() => JSON.stringify(skillsetObject, null, 2), [skillsetObject])

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

    const normalized = ensureSkillShape(parsed)
    setNodes((prev) =>
      prev.map((n) =>
        n.id === selectedNodeId && (n as any)?.data?.kind === 'skill'
          ? ({ ...n, data: { ...(n.data ?? {}), kind: 'skill', skill: normalized } } as any)
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

  const fmtUpdated = (ms: number) => {
    try {
      const locale = language === 'ja' ? 'ja-JP' : 'en-US'
      return new Date(ms).toLocaleString(locale)
    } catch {
      return String(ms)
    }
  }

  return (
    <section className="pane pane--right">
      <div className="pane__header">
        <div className="pane__title">{t('skillPipelineBuilder')}</div>
        <button
          type="button"
          className="btn btn--icon"
          aria-label="Hide pane"
          title="Hide pane"
          onClick={props.onCollapse}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M9 5v14l7-7z" fill="currentColor" />
          </svg>
        </button>
      </div>

      <div className="section pane__scroll">
        <div className="section__title">Skillset</div>

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
          <button type="button" className="btn" onClick={() => saveSkillset('save')}>
            {t('spbSave')}
          </button>
          <button type="button" className="btn" onClick={() => saveSkillset('saveAs')}>
            {t('spbSaveAs')}
          </button>
        </div>

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbSavedSkillsets')}
        </div>

        {savedSkillsets.length === 0 && <div className="empty">{t('spbNoSavedSkillsets')}</div>}

        {savedSkillsets.length > 0 && (
          <div className="kv kv--mb16">
            {savedSkillsets.map((s) => (
              <div key={s.id} className="kv__row" style={{ alignItems: 'center' }}>
                <div className="kv__k" title={s.id}>
                  {s.title}
                  {currentSavedId === s.id ? ' (current)' : ''}
                  <div className="mono" style={{ opacity: 0.7, fontSize: 12 }}>
                    {fmtUpdated(s.updatedAt)}
                  </div>
                </div>
                <div className="kv__v" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button type="button" className="btn btn--tab" onClick={() => loadSkillset(s.id)}>
                    {t('spbLoad')}
                  </button>
                  <button type="button" className="btn btn--danger" onClick={() => deleteSkillset(s.id)}>
                    {t('spbDelete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="section__title" style={{ marginTop: 14 }}>
          {t('spbSelectedSkillJson')}
        </div>

        {!selectedSkillNode && !selectedIndexerNode && !selectedIndexNode && <div className="empty">(no selection)</div>}

        {selectedSkillNode && (
          <>
            {draftError && <div className="notice notice--error builder__notice">{draftError}</div>}

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

        {selectedIndexerNode && (
          <>
            <div className="section__title" style={{ marginTop: 14 }}>
              {t('spbSelectedIndexerJson')}
            </div>

            {draftIndexerError && <div className="notice notice--error builder__notice">{draftIndexerError}</div>}

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

      </div>
    </section>
  )
}
