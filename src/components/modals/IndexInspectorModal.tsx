/**
 * Modal for inspecting index definitions.
 *
 * Displays the current index JSON (with an editor) and basic load/error state.
 */

import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { json } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'
import type { JsonValue } from '../../lib/aiSearchRest'
import type { TranslationKey } from '../../lib/translations'
import type { ThemePreference } from '../../types'

export function IndexInspectorModal(props: {
  open: boolean
  onClose: () => void
  t: (key: TranslationKey) => string
  indexInspectorIndexName: string
  effectiveApiVersion: string
  indexInspectorLoading: boolean
  indexInspectorError: string | null
  indexInspectorDefinition: JsonValue | null
  indexInspectorEditedJson: string
  onReload: () => void
  theme: ThemePreference
}) {
  const {
    open,
    onClose,
    t,
    indexInspectorIndexName,
    effectiveApiVersion,
    indexInspectorLoading,
    indexInspectorError,
    indexInspectorDefinition,
    indexInspectorEditedJson,
    onReload,
    theme,
  } = props

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('indexInspector')}</h2>
          <button type="button" className="btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="kv kv--mb16">
            <div className="kv__row">
              <div className="kv__k">{t('indexName')}</div>
              <div className="kv__v mono">{indexInspectorIndexName}</div>
            </div>
            <div className="kv__row">
              <div className="kv__k">{t('apiVersion')}</div>
              <div className="kv__v mono">{effectiveApiVersion}</div>
            </div>
          </div>

          <div className="actions actions--mb10">
            <button
              type="button"
              className="btn"
              onClick={onReload}
              disabled={indexInspectorLoading}
              title={t('indexInspectorReloadTitle')}
            >
              <i className="bi bi-arrow-clockwise icon--mr6"></i>
              {t('indexInspectorReload')}
            </button>
          </div>

          {indexInspectorError && <div className="notice notice--error builder__notice">{indexInspectorError}</div>}

          {indexInspectorLoading ? (
            <div className="empty">{t('loading')}…</div>
          ) : indexInspectorDefinition !== null ? (
            <div className="builder__jsonViewBox">
              <div className="synonym-editor">
                <ExpandableCodeMirror
                  t={t}
                  modalTitle={t('indexInspector')}
                  value={indexInspectorEditedJson}
                  height="calc(90vh - 280px)"
                  theme={theme === 'light' ? githubLight : githubDark}
                  basicSetup={{
                    lineNumbers: true,
                    foldGutter: true,
                    highlightActiveLine: true,
                  }}
                  extensions={[json(), EditorView.lineWrapping, EditorView.editable.of(false)]}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
