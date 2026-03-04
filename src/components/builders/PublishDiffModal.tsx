/**
 * PublishDiffModal – Confirmation dialog for publishing a skillset to Azure.
 *
 * Renders a full-screen modal with two view modes:
 *   1. **Semantic diff** – a table showing structural changes (added/removed/changed/reordered).
 *   2. **Text diff** – normalised JSON side-by-side with line highlighting.
 *
 * Extracted from SkillPipelineRightPane so the same dialog can be opened from
 * both the center-pane toolbar and the right-pane buttons.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { json } from '@codemirror/lang-json'
import { EditorView, Decoration, ViewPlugin } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

import type { ThemePreference } from '../../types/app'
import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import { diffEntriesToText, type DiffEntry, type SkillsetDiffResult } from '../../utils/skillsetDiff'

type TranslationKey = keyof typeof translations.ja

// ── Helpers ─────────────────────────────────────────────────────────────

function diffKindBadge(kind: DiffEntry['kind'], t: (k: TranslationKey) => string): React.ReactNode {
  const map: Record<string, { label: string; color: string; bg: string }> = {
    'added':          { label: t('spbDiffPropertyAdded'),   color: '#22863a', bg: '#dcffe4' },
    'removed':        { label: t('spbDiffPropertyRemoved'), color: '#cb2431', bg: '#ffeef0' },
    'changed':        { label: t('spbDiffPropertyChanged'), color: '#e36209', bg: '#fff3cd' },
    'reordered':      { label: t('spbDiffSkillReordered'),  color: '#6f42c1', bg: '#f5f0ff' },
    'skill-added':    { label: t('spbDiffSkillAdded'),      color: '#22863a', bg: '#dcffe4' },
    'skill-removed':  { label: t('spbDiffSkillRemoved'),    color: '#cb2431', bg: '#ffeef0' },
    'skill-changed':  { label: t('spbDiffSkillChanged'),    color: '#e36209', bg: '#fff3cd' },
    'unchanged':      { label: '—', color: '#586069', bg: 'transparent' },
  }
  const info = map[kind] ?? { label: kind, color: '#586069', bg: 'transparent' }
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        color: info.color,
        background: info.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {info.label}
    </span>
  )
}

function SemanticDiffRow({ entry, t, depth = 0 }: { entry: DiffEntry; t: (k: TranslationKey) => string; depth?: number }) {
  const indent = depth * 16
  const pathDisplay = entry.skillName
    ? `${entry.path} (${entry.skillName})`
    : entry.path

  return (
    <>
      <tr style={{ borderBottom: '1px solid var(--border)' }}>
        <td style={{ padding: '4px 8px', paddingLeft: 8 + indent, fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
          {pathDisplay}
        </td>
        <td style={{ padding: '4px 8px' }}>
          {diffKindBadge(entry.kind, t)}
        </td>
        <td
          style={{
            padding: '4px 8px',
            fontFamily: 'monospace',
            fontSize: 12,
            maxWidth: 300,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            ...(entry.kind === 'removed' || entry.kind === 'skill-removed'
              ? { background: 'rgba(255,0,0,0.06)' }
              : entry.kind === 'changed' || entry.kind === 'skill-changed'
                ? { background: 'rgba(255,200,0,0.06)' }
                : {}),
          }}
          title={entry.oldValue ?? ''}
        >
          {entry.oldValue ?? '—'}
        </td>
        <td
          style={{
            padding: '4px 8px',
            fontFamily: 'monospace',
            fontSize: 12,
            maxWidth: 300,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            ...(entry.kind === 'added' || entry.kind === 'skill-added'
              ? { background: 'rgba(0,200,0,0.06)' }
              : entry.kind === 'changed' || entry.kind === 'skill-changed'
                ? { background: 'rgba(0,200,0,0.06)' }
                : {}),
          }}
          title={entry.newValue ?? ''}
        >
          {entry.newValue ?? '—'}
        </td>
      </tr>
      {entry.children?.map((child, ci) => (
        <SemanticDiffRow key={ci} entry={child} t={t} depth={depth + 1} />
      ))}
    </>
  )
}

// ── Props ───────────────────────────────────────────────────────────────

export interface PublishDiffModalProps {
  t: (key: TranslationKey) => string
  language: Language
  theme: ThemePreference
  copyToClipboard: (text: string) => Promise<void>

  /** Whether the dialog is open. */
  open: boolean
  /** Close the dialog. */
  onClose: () => void
  /** Confirm publish. */
  onConfirmPublish: () => void

  publishLoading: boolean
  diffViewMode: 'semantic' | 'text'
  setDiffViewMode: (mode: 'semantic' | 'text') => void

  publishBaselineText: string
  publishCandidateJson: string
  semanticDiff: SkillsetDiffResult | null
  normalizedDiffLineSets: { left: Set<number>; right: Set<number> }

  /** The target skillset name on Azure. */
  publishTargetName: string
  /** Whether the target is a new skillset (404). */
  isNewSkillset: boolean
  /** Whether a baseline re-fetch is in progress. */
  refetchingBaseline: boolean
  /** Called when the user changes the target name. */
  onChangeTargetName: (name: string) => void
  /** Names of existing skillsets on Azure (for the dropdown). */
  existingSkillsetNames: string[]
}

// ── Component ───────────────────────────────────────────────────────────

export function PublishDiffModal(props: PublishDiffModalProps) {
  const {
    t,
    language,
    theme,
    copyToClipboard,
    open,
    onClose,
    onConfirmPublish,
    publishLoading,
    diffViewMode,
    setDiffViewMode,
    publishBaselineText,
    publishCandidateJson,
    semanticDiff,
    normalizedDiffLineSets,
    publishTargetName,
    isNewSkillset,
    refetchingBaseline,
    onChangeTargetName,
    existingSkillsetNames,
  } = props

  // ── Dropdown "create new" mode ───────────────────────────────────────
  const CREATE_NEW_SENTINEL = '__create_new__'
  const [creatingNew, setCreatingNew] = useState(false)

  // When the dialog opens, decide initial mode based on existing names.
  useEffect(() => {
    if (open) {
      const nameInList = existingSkillsetNames.includes(publishTargetName)
      setCreatingNew(!nameInList)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value
      if (val === CREATE_NEW_SENTINEL) {
        setCreatingNew(true)
        // Clear to an empty new name (user will type).
        onChangeTargetName('')
      } else {
        setCreatingNew(false)
        onChangeTargetName(val)
      }
    },
    [onChangeTargetName],
  )

  const codeMirrorTheme = useMemo(() => {
    const isLight = theme === 'light' || theme === 'solarized'
    return isLight ? githubLight : githubDark
  }, [theme])

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

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ width: '96vw', maxWidth: 1600, minWidth: 760, maxHeight: '94vh' }}
      >
        <div className="modal-header">
          <h2>{t('spbSaveConfirmTitle')}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className={'btn btn--sm ' + (diffViewMode === 'semantic' ? 'btn--active' : '')}
              onClick={() => setDiffViewMode('semantic')}
              title={t('spbSemanticDiffSemantic')}
            >
              <i className="bi bi-diagram-3"></i> {t('spbSemanticDiffTitle')}
            </button>
            <button
              type="button"
              className={'btn btn--sm ' + (diffViewMode === 'text' ? 'btn--active' : '')}
              onClick={() => setDiffViewMode('text')}
              title={t('spbSemanticDiffTextFallback')}
            >
              <i className="bi bi-file-diff"></i> Text Diff
            </button>
            <button type="button" className="btn" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>
        <div className="modal-body" style={{ padding: 12 }}>
          {/* ── Target Skillset Name ──────────────────────────── */}
          <div style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap' }}>
              <i className="bi bi-cloud-upload" style={{ marginRight: 4 }}></i>
              {t('spbPublishTargetName')}:
            </label>

            {/* Dropdown: existing skillsets + "Create new" option */}
            <select
              value={creatingNew ? CREATE_NEW_SENTINEL : publishTargetName}
              onChange={handleSelectChange}
              style={{ flex: '0 1 280px', fontSize: 13 }}
            >
              {existingSkillsetNames.length > 0 && (
                <optgroup label={t('spbPublishSelectExisting')}>
                  {existingSkillsetNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </optgroup>
              )}
              <option value={CREATE_NEW_SENTINEL}>{t('spbPublishCreateNewOption')}</option>
            </select>

            {/* When "create new" is selected, show a text input for the name */}
            {creatingNew && (
              <input
                type="text"
                value={publishTargetName}
                onChange={(e) => onChangeTargetName(e.target.value)}
                placeholder={t('spbPublishNewNamePlaceholder')}
                style={{ flex: '1 1 200px', maxWidth: 300, fontSize: 13 }}
                autoFocus
              />
            )}

            {refetchingBaseline ? (
              <span style={{ fontSize: 11, opacity: 0.7 }}>
                <i className="bi bi-arrow-repeat" style={{ marginRight: 3 }}></i>
                {t('spbPublishRefetching')}
              </span>
            ) : (
              <span
                style={{
                  display: 'inline-block',
                  padding: '2px 8px',
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 600,
                  color: isNewSkillset ? '#22863a' : '#0366d6',
                  background: isNewSkillset ? '#dcffe4' : '#dbedff',
                  whiteSpace: 'nowrap',
                }}
              >
                {isNewSkillset ? t('spbPublishCreateNew') : t('spbPublishUpdateExisting')}
              </span>
            )}
          </div>
          {creatingNew && (
            <div className="section__hint" style={{ marginBottom: 8, fontSize: 12, color: 'var(--success, #22863a)' }}>
              <i className="bi bi-info-circle" style={{ marginRight: 4 }}></i>
              {t('spbPublishTargetNameHint')}
            </div>
          )}

          <div className="section__hint" style={{ marginBottom: 10 }}>
            {t('spbSaveConfirmHint')}
            <br />
            <span style={{ fontSize: 11, opacity: 0.7 }}>{t('spbPublishTwoStageHint')}</span>
          </div>

          {/* ── Semantic Diff View ────────────────────────────── */}
          {diffViewMode === 'semantic' && semanticDiff && (
            <div className="skillset-semantic-diff" style={{ marginBottom: 12 }}>
              <div className="section__hint" style={{ marginBottom: 8, fontSize: 12 }}>
                <i className="bi bi-info-circle" style={{ marginRight: 4 }}></i>
                {t('spbSemanticDiffHint')}
              </div>

              {semanticDiff.identical ? (
                <div className="notice" style={{ marginBottom: 8 }}>
                  {publishBaselineText !== publishCandidateJson
                    ? t('spbFormatOnlyChanges')
                    : t('spbSaveNoChanges')}
                </div>
              ) : (
                <div
                  style={{
                    maxHeight: 480,
                    overflowY: 'auto',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--panel-2)',
                    fontSize: 13,
                  }}
                >
                  <table className="seGrid" style={{ width: '100%' }}>
                    <colgroup>
                      <col style={{ width: '30%' }} />
                      <col style={{ width: '15%' }} />
                      <col style={{ width: '27.5%' }} />
                      <col style={{ width: '27.5%' }} />
                    </colgroup>
                    <thead>
                      <tr style={{ position: 'sticky', top: 0, background: 'var(--panel-2)', zIndex: 1 }}>
                        <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600 }}>Path</th>
                        <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600 }}>Kind</th>
                        <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600 }}>{t('spbSaveDiffBefore')}</th>
                        <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600 }}>{t('spbSaveDiffAfter')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {semanticDiff.changes.map((entry, i) => (
                        <SemanticDiffRow key={i} entry={entry} t={t} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {semanticDiff.changes.length > 0 && (
                <div style={{ marginTop: 6, textAlign: 'right' }}>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      const text = diffEntriesToText(semanticDiff.changes)
                      copyToClipboard(text)
                    }}
                    title={t('spbDiffCopySummary')}
                  >
                    <i className="bi bi-clipboard" style={{ marginRight: 4 }}></i>
                    {t('spbDiffCopySummary')}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Text Diff View (normalised) ──────────────────── */}
          {diffViewMode === 'text' && (
            <>
              {semanticDiff?.identical && publishBaselineText !== publishCandidateJson ? (
                <div className="notice" style={{ marginBottom: 8 }}>{t('spbFormatOnlyChanges')}</div>
              ) : semanticDiff?.normalizedBeforeJson === semanticDiff?.normalizedAfterJson ? (
                <div className="notice" style={{ marginBottom: 8 }}>{t('spbSaveNoChanges')}</div>
              ) : null}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="skillset-diff-editor">
                  <div className="section__title" style={{ marginTop: 0 }}>
                    {t('spbSaveDiffBefore')}
                  </div>
                  <ExpandableCodeMirror
                    t={(k) => String(translations[language][k] ?? '')}
                    modalTitle={t('spbSaveDiffBefore')}
                    value={semanticDiff?.normalizedBeforeJson ?? publishBaselineText}
                    height="520px"
                    theme={codeMirrorTheme}
                    extensions={[
                      json(),
                      EditorView.lineWrapping,
                      EditorView.editable.of(false),
                      makeLineClassExtension(normalizedDiffLineSets.left, 'cm-diff-removed'),
                    ]}
                    onChange={() => {}}
                  />
                </div>

                <div className="skillset-diff-editor">
                  <div className="section__title" style={{ marginTop: 0 }}>
                    {t('spbSaveDiffAfter')}
                  </div>
                  <ExpandableCodeMirror
                    t={(k) => String(translations[language][k] ?? '')}
                    modalTitle={t('spbSaveDiffAfter')}
                    value={semanticDiff?.normalizedAfterJson ?? publishCandidateJson}
                    height="520px"
                    theme={codeMirrorTheme}
                    extensions={[
                      json(),
                      EditorView.lineWrapping,
                      EditorView.editable.of(false),
                      makeLineClassExtension(normalizedDiffLineSets.right, 'cm-diff-added'),
                    ]}
                    onChange={() => {}}
                  />
                </div>
              </div>
            </>
          )}

          <div className="actions" style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onClose}>
              {t('spbSaveConfirmCancel')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={onConfirmPublish}
              disabled={(semanticDiff?.identical && publishBaselineText === publishCandidateJson) || publishLoading}
              title={semanticDiff?.identical ? t('spbFormatOnlyChanges') : ''}
              style={
                (semanticDiff?.identical && publishBaselineText === publishCandidateJson) || publishLoading
                  ? undefined
                  : { background: 'var(--accent)', color: 'var(--accent-fg, #fff)', border: 'none' }
              }
            >
              <i className="bi bi-cloud-upload" style={{ marginRight: 4 }}></i>
              {publishLoading ? t('spbPublishing') : t('spbSaveConfirmPublish')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
