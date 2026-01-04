/**
 * Expandable CodeMirror wrapper.
 *
 * Provides a small "expand" affordance that opens the editor in a modal-sized
 * view for easier editing/inspection.
 */

import { useState } from 'react'

import CodeMirror, { type ReactCodeMirrorProps } from '@uiw/react-codemirror'

import type { TranslationKey } from '../../lib/translations'

type ExpandableCodeMirrorProps = ReactCodeMirrorProps & {
  t?: (key: TranslationKey) => string
  modalTitle?: string
}

export function ExpandableCodeMirror(props: ExpandableCodeMirrorProps) {
  const { t, modalTitle, onCreateEditor, height, ...rest } = props
  const [open, setOpen] = useState(false)

  const expandTitle = t ? t('editorExpand') : 'Expand'
  const expandedTitle = modalTitle ?? (t ? t('editorExpandedTitle') : 'Editor')

  return (
    <>
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className="btn btn--icon"
          onClick={() => setOpen(true)}
          title={expandTitle}
          style={{ position: 'absolute', top: 8, right: 8, zIndex: 5 }}
        >
          <i className="bi bi-arrows-fullscreen" aria-hidden="true"></i>
        </button>

        <CodeMirror height={height} onCreateEditor={onCreateEditor} {...rest} />
      </div>

      {open && (
        <div className="modal-overlay" onClick={() => setOpen(false)}>
          <div
            className="modal-content"
            onClick={(e) => e.stopPropagation()}
            style={{ width: '96vw', maxWidth: 1400, minWidth: 600, maxHeight: '94vh' }}
          >
            <div className="modal-header">
              <h2>{expandedTitle}</h2>
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body" style={{ padding: 12 }}>
              <CodeMirror height="calc(94vh - 140px)" {...rest} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
