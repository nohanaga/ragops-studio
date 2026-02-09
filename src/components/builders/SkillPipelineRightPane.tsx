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
import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import { createOrUpdateSkillset, getSkillset } from '../../lib/aiSearchRest'

type TranslationKey = keyof typeof translations.ja

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function ensureJsonObject(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {}
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
  } = useSkillPipelineState()

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
      setPublishError(String((translations as any)[language]?.restErrorProfileUnset ?? 'Profile is not set'))
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
      setPublishError(String((translations as any)[language]?.restErrorProfileUnset ?? 'Profile is not set'))
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

        <div className="section__title" style={{ marginTop: 14 }}>
          {selectedProjectionNode ? t('spbSelectedIndexProjectionsJson') : t('spbSelectedSkillJson')}
        </div>

        {!selectedSkillNode && !selectedIndexerNode && !selectedIndexNode && !selectedProjectionNode && <div className="empty">(no selection)</div>}

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
