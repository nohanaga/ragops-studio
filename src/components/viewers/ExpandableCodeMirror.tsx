/**
 * Expandable CodeMirror wrapper.
 *
 * Provides a small "expand" affordance that opens the editor in a modal-sized
 * view for easier editing/inspection.
 */

import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react'

import CodeMirror, { type ReactCodeMirrorProps } from '@uiw/react-codemirror'

import type { TranslationKey } from '../../lib/translations'

type ExpandableCodeMirrorProps = ReactCodeMirrorProps & {
  t?: (key: TranslationKey) => string
  modalTitle?: string
}

export function ExpandableCodeMirror(props: ExpandableCodeMirrorProps) {
  const { t, modalTitle, onCreateEditor, height, ...rest } = props
  const [mode, setMode] = useState<'dialog' | 'overlay' | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (mode !== 'dialog') return
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [mode])

  const expandTitle = t ? t('editorExpand') : 'Expand'
  const expandedTitle = modalTitle ?? (t ? t('editorExpandedTitle') : 'Editor')
  const close = () => {
    dialogRef.current?.close()
    setMode(null)
  }
  const dismissNested = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault()
    event.stopPropagation()
    close()
  }
  const expandedEditor = mode && (
    <>
      <div className="modal-header">
        <h2 id={titleId}>{expandedTitle}</h2>
        <button type="button" className="btn" aria-label={t ? t('dialogClose') : 'Close'} onClick={close}>✕</button>
      </div>
      <div className="modal-body" style={{ padding: 12 }}>
        <CodeMirror height={mode === 'dialog' ? 'calc(100dvh - 130px)' : 'calc(94vh - 140px)'} {...rest} />
      </div>
    </>
  )

  return (
    <>
      <div style={{ position: 'relative' }}>
        <button
          type="button"
          className="btn btn--icon"
          // A nested modal must join the browser's top layer too.
          onClick={(event) => setMode(event.currentTarget.closest('dialog:modal') ? 'dialog' : 'overlay')}
          aria-haspopup="dialog"
          title={expandTitle}
          style={{ position: 'absolute', top: 8, right: 8, zIndex: 5 }}
        >
          <i className="bi bi-arrows-fullscreen" aria-hidden="true"></i>
        </button>

        <CodeMirror height={height} onCreateEditor={onCreateEditor} {...rest} />
      </div>

      {mode === 'dialog' && (
        <dialog ref={dialogRef} className="modal-content expandedEditorDialog" aria-labelledby={titleId}
          onCancel={dismissNested}
          onKeyDown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented) dismissNested(event) }}>
          {expandedEditor}
        </dialog>
      )}
      {mode === 'overlay' && (
        <div className="modal-overlay" onClick={close}>
          <div
            className="modal-content"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
            style={{ width: '96vw', maxWidth: 1400, minWidth: 600, maxHeight: '94vh' }}
          >
            {expandedEditor}
          </div>
        </div>
      )}
    </>
  )
}
