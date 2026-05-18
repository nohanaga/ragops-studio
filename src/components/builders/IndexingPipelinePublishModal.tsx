import { useCallback, useMemo, type ReactNode } from 'react'
import { json } from '@codemirror/lang-json'
import { RangeSetBuilder } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { diffLines } from 'diff'
import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import type { ThemePreference } from '../../types/app'
import type { Language } from '../../lib/translations'
import { translations } from '../../lib/translations'
import { diffEntriesToText, type DiffEntry, type ResourceDiffResult } from '../../utils/skillsetDiff'

export type IndexingPipelinePublishResourceKind = 'dataSource' | 'index' | 'indexer'
export type IndexingPipelinePublishAction = 'create' | 'update'

export type IndexingPipelinePublishReviewResource = {
  kind: IndexingPipelinePublishResourceKind
  label: string
  name: string
  action: IndexingPipelinePublishAction
  baselineText: string
  candidateText: string
  semanticDiff: ResourceDiffResult
}

type IndexingPipelinePublishModalProps = {
  open: boolean
  language: Language
  theme: ThemePreference
  resources: IndexingPipelinePublishReviewResource[]
  activeKind: IndexingPipelinePublishResourceKind
  diffViewMode: 'semantic' | 'text'
  updateLoading: boolean
  copyToClipboard: (text: string) => Promise<void>
  onActiveKindChange: (kind: IndexingPipelinePublishResourceKind) => void
  onDiffViewModeChange: (mode: 'semantic' | 'text') => void
  onConfirmUpdateRun: () => void
  onClose: () => void
}

function text(language: Language, ja: string, en: string): string {
  return language === 'ja' ? ja : en
}

function actionLabel(language: Language, action: IndexingPipelinePublishAction): string {
  return action === 'create'
    ? text(language, '作成', 'Create')
    : text(language, '更新', 'Update')
}

function renderDiffEntry(entry: DiffEntry, depth = 0) {
  const indent = depth * 16
  return (
    <>
      <tr>
        <td style={{ paddingLeft: 8 + indent }}>{entry.path || '-'}</td>
        <td>{entry.kind}</td>
        <td title={entry.oldValue ?? ''}>{entry.oldValue ?? '-'}</td>
        <td title={entry.newValue ?? ''}>{entry.newValue ?? '-'}</td>
      </tr>
      {entry.children?.map((child, index) => (
        <FragmentLike key={`${entry.path}-${index}`}>{renderDiffEntry(child, depth + 1)}</FragmentLike>
      ))}
    </>
  )
}

function FragmentLike({ children }: { children: ReactNode }) {
  return <>{children}</>
}

function countLines(textValue: string): number {
  if (!textValue) return 0
  const lines = textValue.split('\n')
  return lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

export function IndexingPipelinePublishModal({
  open,
  language,
  theme,
  resources,
  activeKind,
  diffViewMode,
  updateLoading,
  copyToClipboard,
  onActiveKindChange,
  onDiffViewModeChange,
  onConfirmUpdateRun,
  onClose,
}: IndexingPipelinePublishModalProps) {
  const activeResource = resources.find((resource) => resource.kind === activeKind) ?? resources[0]
  const hasResources = resources.length > 0
  const codeMirrorTheme = useMemo(() => (theme === 'light' || theme === 'solarized' ? githubLight : githubDark), [theme])
  const beforeText = activeResource?.semanticDiff.normalizedBeforeJson || activeResource?.baselineText || ''
  const afterText = activeResource?.semanticDiff.normalizedAfterJson || activeResource?.candidateText || ''
  const normalizedDiffLineSets = useMemo(() => {
    const parts = diffLines(beforeText, afterText)
    const left = new Set<number>()
    const right = new Set<number>()
    let leftLine = 1
    let rightLine = 1
    for (const part of parts) {
      const lineCount = countLines(part.value)
      if (!lineCount) continue
      if (part.added) {
        for (let offset = 0; offset < lineCount; offset += 1) right.add(rightLine + offset)
        rightLine += lineCount
        continue
      }
      if (part.removed) {
        for (let offset = 0; offset < lineCount; offset += 1) left.add(leftLine + offset)
        leftLine += lineCount
        continue
      }
      leftLine += lineCount
      rightLine += lineCount
    }
    return { left, right }
  }, [beforeText, afterText])
  const makeLineClassExtension = useCallback((lines: Set<number>, className: string) => {
    const decoration = Decoration.line({ class: className })

    const buildDecorations = (view: EditorView) => {
      const builder = new RangeSetBuilder<Decoration>()
      const maxLine = view.state.doc.lines
      for (const lineNumber of lines) {
        if (lineNumber < 1 || lineNumber > maxLine) continue
        const line = view.state.doc.line(lineNumber)
        builder.add(line.from, line.from, decoration)
      }
      return builder.finish()
    }

    return ViewPlugin.fromClass(
      class {
        decorations
        constructor(view: EditorView) {
          this.decorations = buildDecorations(view)
        }
        update(update: ViewUpdate) {
          if (update.docChanged || update.viewportChanged) this.decorations = buildDecorations(update.view)
        }
      },
      { decorations: (value) => value.decorations },
    )
  }, [])

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(event) => event.stopPropagation()} style={{ width: '94vw', maxWidth: 1360, minWidth: 760, maxHeight: '92vh' }}>
        <div className="modal-header">
          <h2>{text(language, '更新内容の確認', 'Review Updates')}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>x</button>
          </div>
        </div>
        <div className="modal-body" style={{ padding: 12 }}>
          <div className="notice notice--warning builder__notice" role="status" aria-live="polite">
            {text(
              language,
              '既存リソースの更新または新規作成を行います。差分を確認し、問題がない場合のみ Publish & Run pipeline を実行してください。',
              'This operation updates existing resources or creates new resources. Review the diff and continue only if the changes are expected.',
            )}
          </div>

          {!hasResources ? (
            <div className="notice builder__notice">
              {text(language, '更新対象のリソースはありません。', 'No resources require update.')}
            </div>
          ) : (
            <>
              <div className="ipbPublishReviewSummary">
                {resources.map((resource) => (
                  <button
                    key={resource.kind}
                    type="button"
                    className={'btn btn--tab ' + (activeResource?.kind === resource.kind ? 'btn--active' : '')}
                    onClick={() => onActiveKindChange(resource.kind)}
                  >
                    <span className="indexSchemaBadge indexSchemaBadge--configured">{actionLabel(language, resource.action)}</span>
                    {resource.label}: {resource.name}
                  </button>
                ))}
              </div>

              <div className="ipbRawJson__header" style={{ marginTop: 12 }}>
                <div>
                  <div className="ipbPanelHeader__title">{activeResource.label}: {activeResource.name}</div>
                  <div className="ipbPanelHeader__meta">
                    {text(language, '現在のサービス定義と draft の差分です。', 'Diff between the current service definition and the draft.')}
                  </div>
                </div>
                <div className="ipbRawJson__controls">
                  <button type="button" className={'btn btn--tab ' + (diffViewMode === 'semantic' ? 'btn--active' : '')} onClick={() => onDiffViewModeChange('semantic')}>
                    Semantic Diff
                  </button>
                  <button type="button" className={'btn btn--tab ' + (diffViewMode === 'text' ? 'btn--active' : '')} onClick={() => onDiffViewModeChange('text')}>
                    Text Diff
                  </button>
                  <button type="button" className="btn" onClick={() => void copyToClipboard(diffEntriesToText(activeResource.semanticDiff.changes))} disabled={activeResource.semanticDiff.changes.length === 0}>
                    {text(language, '差分コピー', 'Copy diff')}
                  </button>
                </div>
              </div>

              {diffViewMode === 'semantic' ? (
                activeResource.semanticDiff.identical ? (
                  <div className="notice builder__notice">{text(language, '本質的な変更はありません。', 'No semantic changes.')}</div>
                ) : (
                  <div className="ipbPublishDiffTableWrap">
                    <table className="seGrid ipbPublishDiffTable">
                      <thead>
                        <tr>
                          <th>Path</th>
                          <th>Kind</th>
                          <th>{text(language, '変更前', 'Before')}</th>
                          <th>{text(language, '変更後', 'After')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeResource.semanticDiff.changes.map((entry, index) => (
                          <FragmentLike key={`${entry.path}-${index}`}>{renderDiffEntry(entry)}</FragmentLike>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              ) : (
                <div className="ipbVerificationGrid">
                  <div className="skillset-diff-editor">
                    <div className="form__metaTitle">{text(language, '変更前', 'Before')}</div>
                    <ExpandableCodeMirror
                      t={(key) => String(translations[language][key] ?? '')}
                      modalTitle={text(language, '変更前', 'Before')}
                      value={beforeText}
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
                    <div className="form__metaTitle">{text(language, '変更後', 'After')}</div>
                    <ExpandableCodeMirror
                      t={(key) => String(translations[language][key] ?? '')}
                      modalTitle={text(language, '変更後', 'After')}
                      value={afterText}
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
              )}
            </>
          )}
        </div>
        <div className="actions" style={{ padding: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} disabled={updateLoading}>
            {text(language, 'キャンセル', 'Cancel')}
          </button>
          <button type="button" className="btn btn--primary" onClick={onConfirmUpdateRun} disabled={!hasResources || updateLoading}>
            <i className="bi bi-cloud-upload icon--mr6"></i>
            {updateLoading ? text(language, '更新中...', 'Updating...') : 'Publish & Run pipeline'}
          </button>
        </div>
      </div>
    </div>
  )
}
