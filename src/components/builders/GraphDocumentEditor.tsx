import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { JsonObject } from '../../app/json'
import type { JsonValue } from '../../lib/aiSearchRest'
import { buildGraphDocumentBatch, graphMappings, parseDocumentArray } from '../../lib/knowledgeGraph'
import { translations, type Language } from '../../lib/translations'
import type { ThemePreference } from '../../types'
import { downloadText } from '../../utils/apiHelpers'
import { GraphJsonEditor } from './GraphJsonEditor'

export function GraphDocumentDialog({ title, description, language, onDismiss, busy, children, footer }: {
  title: string
  description: string
  language: Language
  onDismiss: () => void
  busy?: boolean
  children: ReactNode
  footer: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [])
  const dismiss = () => {
    dialogRef.current?.close()
    onDismiss()
  }
  return <dialog ref={dialogRef} className="modal-content kgDocumentDialog" aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={(event) => { event.preventDefault(); if (!busy) dismiss() }}>
    <div className="modal-header">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="btn" aria-label={translations[language].dialogClose} disabled={busy} onClick={dismiss}>✕</button>
    </div>
    <div className="modal-body">
      <p id={descriptionId} className="field__hint">{description}</p>
      {children}
    </div>
    <div className="actions kgDocumentDialog__footer">{footer}</div>
  </dialog>
}

export function GraphDocumentEditor({ definition, indexName, baseline, draft, initialRecord, owner, language, theme, onPreview, onDismiss }: {
  definition: JsonValue
  indexName: string
  baseline: JsonObject[]
  draft: string
  initialRecord: number
  owner?: string
  language: Language
  theme: ThemePreference
  onPreview: (draft: string) => void
  onDismiss: () => void
}) {
  const t = (key: keyof typeof translations.ja) => translations[language][key]
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(draft)
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [recordIndex, setRecordIndex] = useState(Math.max(0, initialRecord))
  const [fileError, setFileError] = useState('')
  const [importing, setImporting] = useState(false)
  const { documents, error, hasChanges } = useMemo(() => {
    let documents: JsonObject[] | null = null
    try {
      documents = parseDocumentArray(text)
      const changes = buildGraphDocumentBatch(definition, baseline, documents).value
      return { documents, error: '', hasChanges: Array.isArray(changes) && changes.length > 0 }
    } catch (e) {
      return { documents, error: e instanceof Error ? e.message : String(e), hasChanges: false }
    }
  }, [baseline, definition, text])
  const mappings = graphMappings(definition)
  const subject = String(mappings.subjectField)
  const predicate = String(mappings.predicateField)
  const object = String(mappings.objectField)
  const selection = Math.min(recordIndex, (documents?.length ?? 0) - 1)
  const record = documents?.[selection]
  const normalized = documents && !error ? JSON.stringify(hasChanges ? documents : baseline, null, 2) : null
  const view = record ? mode : 'json'
  return <GraphDocumentDialog title={t('kgEditDocuments')} description={t('kgEditDocumentsHint')} language={language}
    onDismiss={onDismiss} busy={importing} footer={<>
      <button type="button" className="btn btn--secondary" disabled={importing} onClick={onDismiss}>{t('kgCancel')}</button>
      <button type="button" className="btn btn--secondary" disabled={!!error || importing} onClick={() => downloadText(`${indexName}.json`, text)}>
        <i className="bi bi-download icon--mr6" aria-hidden="true" />{t('kgExport')}
      </button>
      <button type="button" className="btn btn--primary" disabled={normalized === null || normalized === draft || importing}
        onClick={() => { if (normalized !== null) onPreview(normalized) }}>
        <i className="bi bi-diagram-2 icon--mr6" aria-hidden="true" />{t('kgPreviewDocuments')}
      </button>
    </>}>
    <div className="actions"><span className="kgBadge">{t('kgIndex')}: <strong>{indexName}</strong></span>
      <span className="kgBadge">{(documents?.length ?? baseline.length).toLocaleString(language)} {t('kgDocumentUnit')}</span></div>
    <p className="field__hint">{owner ? t('kgSaveManagedHint') : t('kgEditLocalOnly')}</p>
    <div className="actions kgInspector__tabs">
      <button type="button" className={`btn btn--tab${view === 'form' ? ' btn--active' : ''}`} aria-pressed={view === 'form'}
        disabled={!record} onClick={() => setMode('form')}><i className="bi bi-pencil icon--mr6" aria-hidden="true" />{t('kgEditRelationForm')}</button>
      <button type="button" className={`btn btn--tab${view === 'json' ? ' btn--active' : ''}`} aria-pressed={view === 'json'}
        onClick={() => setMode('json')}><i className="bi bi-braces icon--mr6" aria-hidden="true" />{t('kgEditBulkJson')}</button>
    </div>
    {fileError && <div className="notice notice--error" role="alert">{fileError}</div>}
    {view === 'form' && record && documents ? <>
      <label className="field">
        <span className="field__label">{t('kgEditRecord')}</span>
        <select className="field__input" value={selection} onChange={(event) => setRecordIndex(Number(event.target.value))}>
          {documents.map((item, index) => <option key={index} value={index}>
            {`${index + 1}. ${String(item[subject])} · ${String(item[predicate])} · ${String(item[object])}`}
          </option>)}
        </select>
      </label>
      <div className="form">
        {([[subject, 'kgEditSubject'], [predicate, 'kgEditPredicate'], [object, 'kgEditObject']] as const).map(([field, label]) =>
          <label key={label} className="field">
            <span className="field__label">{t(label)}</span>
            <input className="field__input" value={String(record[field])} readOnly={typeof record[field] !== 'string'}
              onChange={(event) => {
                const value = event.target.value
                setText(JSON.stringify(documents.map((item, index) => index === selection ? { ...item, [field]: value } : item), null, 2))
              }} />
          </label>
        )}
      </div>
      <p className="field__hint">{t('kgEditRelationFormHint')}</p>
    </> : <>
      <p className="field__hint">{t('kgEditBulkJsonHint')}</p>
      <div className="actions">
        <button type="button" className="btn btn--secondary btn--sm" disabled={importing} onClick={() => fileRef.current?.click()}>
          <i className="bi bi-upload icon--mr6" aria-hidden="true" />{t('kgImport')}
        </button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          setFileError('')
          setImporting(true)
          try {
            const value = await file.text()
            const documents = parseDocumentArray(value)
            buildGraphDocumentBatch(definition, baseline, documents)
            setText(JSON.stringify(documents, null, 2))
            setRecordIndex(0)
          } catch (e) {
            setFileError(`${t('kgImportFailed')}: ${e instanceof Error ? e.message : String(e)}`)
          } finally {
            setImporting(false)
          }
        }} />
      </div>
      <GraphJsonEditor value={text} onChange={setText} readOnly={importing} language={language} theme={theme} height="min(360px, 38vh)" />
    </>}
    {error && <div className="notice notice--error" role="alert">{t('kgInvalid')} {error}</div>}
  </GraphDocumentDialog>
}
