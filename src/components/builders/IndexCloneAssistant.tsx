import { useEffect, useMemo, useRef, useState } from 'react'

import { isJsonObject } from '../../app/json'
import { getIndexDefinition, type JsonValue } from '../../lib/aiSearchRest'
import type {
  IndexCloneRetryNotice,
  IndexCloneRetryOperation,
  IndexCloneWorkerInbound,
  IndexCloneWorkerOutbound,
  IndexCloneWorkerProgress,
  IndexCloneWorkerStartRequest,
} from '../../lib/indexCloneWorker'
import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import { translations, type Language } from '../../lib/translations'
import { cloneIndexDefinition } from '../../utils/indexClone'

type TranslationKey = keyof typeof translations.ja

type ClonePhase = 'idle' | 'preparing' | 'creating' | 'copying' | 'completed' | 'cancelled' | 'error'

type CloneProgress = {
  phase: ClonePhase
  message: string
  totalDocuments?: number
  readDocuments: number
  uploadedDocuments: number
  failedDocuments: number
  skippedSourceFieldNames: string[]
  missingTargetFieldNames: string[]
}

type IndexCloneAssistantProps = {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion | ''
  language: Language
  indexNames: string[]
  selectedIndexName: string
  editedJson: string
  isIndexNamesLoading: boolean
  onReloadIndexNames: () => void | Promise<void>
  onApplyCloneJson: (definition: JsonValue, sourceIndexName: string, targetIndexName: string) => void
  onCloneCompleted: (targetIndexName: string) => Promise<void>
}

function defaultCloneName(sourceIndexName: string, existingNames: string[]): string {
  const base = `${sourceIndexName.trim()}-clone`
  if (!existingNames.includes(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base}-${i}`
    if (!existingNames.includes(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

function clampBatchSize(value: number): number {
  if (!Number.isFinite(value)) return 500
  return Math.max(1, Math.min(1000, Math.floor(value)))
}

function parseIndexDefinitionJson(raw: string, objectError: string, nameError: string): { name: string; body: JsonValue } {
  const parsed = JSON.parse(raw) as JsonValue
  if (!isJsonObject(parsed)) throw new Error(objectError)
  const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
  if (!name) throw new Error(nameError)
  return { name, body: parsed }
}

export function IndexCloneAssistant(props: IndexCloneAssistantProps) {
  const {
    profile,
    apiVersion,
    language,
    indexNames,
    selectedIndexName,
    editedJson,
    isIndexNamesLoading,
    onReloadIndexNames,
    onApplyCloneJson,
    onCloneCompleted,
  } = props
  const t = (key: TranslationKey): string => String(translations[language][key] ?? '')
  const format = (key: TranslationKey, params: Record<string, string | number>): string => {
    let text = t(key)
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }

  const [sourceIndexName, setSourceIndexName] = useState(selectedIndexName.trim())
  const [targetIndexName, setTargetIndexName] = useState(() => selectedIndexName.trim() ? defaultCloneName(selectedIndexName, indexNames) : '')
  const [targetTouched, setTargetTouched] = useState(false)
  const [batchSize, setBatchSize] = useState(500)
  const [maxDocumentsText, setMaxDocumentsText] = useState('')
  const [sourceDefinition, setSourceDefinition] = useState<JsonValue | null>(null)
  const [preparedSourceName, setPreparedSourceName] = useState('')
  const [progress, setProgress] = useState<CloneProgress>({
    phase: 'idle',
    message: '',
    readDocuments: 0,
    uploadedDocuments: 0,
    failedDocuments: 0,
    skippedSourceFieldNames: [],
    missingTargetFieldNames: [],
  })
  const workerRef = useRef<Worker | null>(null)
  const workerRequestIdRef = useRef(0)

  const canRun = !!profile && !!apiVersion && apiVersion.trim().length > 0
  const isRunning = progress.phase === 'preparing' || progress.phase === 'creating' || progress.phase === 'copying'
  const progressPercent = useMemo(() => {
    if (!progress.totalDocuments || progress.totalDocuments <= 0) return 0
    return Math.max(0, Math.min(100, Math.round((progress.readDocuments / progress.totalDocuments) * 100)))
  }, [progress.readDocuments, progress.totalDocuments])

  useEffect(() => {
    const selected = selectedIndexName.trim()
    if (!selected || isRunning) return
    setSourceIndexName(selected)
    if (!targetTouched) setTargetIndexName(defaultCloneName(selected, indexNames))
  }, [indexNames, isRunning, selectedIndexName, targetTouched])

  useEffect(() => {
    return () => {
      workerRef.current?.terminate()
      workerRef.current = null
    }
  }, [])

  const retryOperationLabel = (operation: IndexCloneRetryOperation): string => {
    switch (operation) {
      case 'load-source': return t('indexCloneRetryOperationLoadSource')
      case 'create-index': return t('indexCloneRetryOperationCreateIndex')
      case 'search-documents': return t('indexCloneRetryOperationSearchDocuments')
      case 'upload-documents': return t('indexCloneRetryOperationUploadDocuments')
      case 'upload-items': return t('indexCloneRetryOperationUploadItems')
    }
  }

  const messageForWorkerProgress = (workerProgress: IndexCloneWorkerProgress, targetName: string): string => {
    if (workerProgress.phase === 'creating') return t('indexCloneCreatingIndex')
    if (workerProgress.phase === 'copying') return t('indexCloneCopyingDocuments')
    if (workerProgress.phase === 'cancelled') return t('indexCloneCancelled')
    return format('indexCloneCompleted', { target: targetName, count: workerProgress.uploadedDocuments, failed: workerProgress.failedDocuments })
  }

  const toCloneProgress = (workerProgress: IndexCloneWorkerProgress, targetName: string, message?: string): CloneProgress => ({
    phase: workerProgress.phase,
    message: message ?? messageForWorkerProgress(workerProgress, targetName),
    totalDocuments: workerProgress.totalDocuments,
    readDocuments: workerProgress.readDocuments,
    uploadedDocuments: workerProgress.uploadedDocuments,
    failedDocuments: workerProgress.failedDocuments,
    skippedSourceFieldNames: workerProgress.skippedSourceFieldNames,
    missingTargetFieldNames: workerProgress.missingTargetFieldNames,
  })

  const terminateCloneWorker = () => {
    workerRef.current?.terminate()
    workerRef.current = null
  }

  const setRetryProgress = (retry: IndexCloneRetryNotice) => {
    setProgress((previous) => ({
      ...previous,
      message: format('indexCloneRetrying', {
        operation: retryOperationLabel(retry.operation),
        attempt: retry.attempt,
        maxAttempts: retry.maxAttempts,
        delayMs: retry.delayMs,
        status: retry.status,
      }),
    }))
  }

  const runCloneWorker = (request: Omit<IndexCloneWorkerStartRequest, 'type' | 'requestId'>): Promise<'completed' | 'cancelled'> => {
    terminateCloneWorker()
    const requestId = workerRequestIdRef.current + 1
    workerRequestIdRef.current = requestId

    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../../lib/indexCloneWorker.ts', import.meta.url), { type: 'module' })
      workerRef.current = worker

      const cleanup = () => {
        worker.terminate()
        if (workerRef.current === worker) workerRef.current = null
      }

      worker.onmessage = (event: MessageEvent<IndexCloneWorkerOutbound>) => {
        const message = event.data
        if (message.requestId !== requestId) return

        if (message.type === 'progress') {
          setProgress(toCloneProgress(message.progress, request.targetIndexName))
          return
        }

        if (message.type === 'retry') {
          setRetryProgress(message.retry)
          return
        }

        if (message.type === 'completed') {
          setProgress(toCloneProgress(message.progress, request.targetIndexName))
          cleanup()
          resolve('completed')
          return
        }

        if (message.type === 'cancelled') {
          setProgress(toCloneProgress(message.progress, request.targetIndexName, t('indexCloneCancelled')))
          cleanup()
          resolve('cancelled')
          return
        }

        const fallbackProgress = message.progress
          ? toCloneProgress(message.progress, request.targetIndexName, message.message)
          : null
        if (fallbackProgress) setProgress({ ...fallbackProgress, phase: 'error', message: message.message })
        else setProgress((previous) => ({ ...previous, phase: 'error', message: message.message }))
        cleanup()
        reject(new Error(message.message))
      }

      worker.onerror = (event) => {
        const message = event.message || 'Index clone worker error'
        setProgress((previous) => ({ ...previous, phase: 'error', message }))
        cleanup()
        reject(new Error(message))
      }

      worker.postMessage({ type: 'start', requestId, ...request } satisfies IndexCloneWorkerInbound)
    })
  }

  const loadSourceDefinition = async (sourceName: string): Promise<JsonValue> => {
    if (!profile || !apiVersion) throw new Error(t('indexBuilderMissingProfileOrApiVersion'))
    if (sourceDefinition && preparedSourceName === sourceName) return sourceDefinition

    const res = await getIndexDefinition({ profile, apiVersion, indexName: sourceName, language })
    if (!res.ok) throw new Error(res.error.message)
    setSourceDefinition(res.response)
    setPreparedSourceName(sourceName)
    return res.response
  }

  const prepareCloneJson = async () => {
    if (!canRun || !profile || !apiVersion) return
    const sourceName = sourceIndexName.trim()
    const targetName = targetIndexName.trim()
    if (!sourceName) {
      setProgress((previous) => ({ ...previous, phase: 'error', message: t('indexCloneSelectSourceError') }))
      return
    }
    if (!targetName) {
      setProgress((previous) => ({ ...previous, phase: 'error', message: t('indexCloneTargetNameRequired') }))
      return
    }
    if (sourceName === targetName) {
      setProgress((previous) => ({ ...previous, phase: 'error', message: t('indexCloneSameNameError') }))
      return
    }

    setProgress({
      phase: 'preparing',
      message: t('indexClonePreparing'),
      readDocuments: 0,
      uploadedDocuments: 0,
      failedDocuments: 0,
      skippedSourceFieldNames: [],
      missingTargetFieldNames: [],
    })

    try {
      const source = await loadSourceDefinition(sourceName)
      const cloned = cloneIndexDefinition(source, targetName)
      onApplyCloneJson(cloned, sourceName, targetName)
      setProgress((previous) => ({ ...previous, phase: 'idle', message: format('indexClonePrepared', { source: sourceName, target: targetName }) }))
    } catch (error) {
      setProgress((previous) => ({
        ...previous,
        phase: 'error',
        message: format('indexCloneSourceLoadFailed', { error: error instanceof Error ? error.message : String(error) }),
      }))
    }
  }

  const createAndCopy = async () => {
    if (!canRun || !profile || !apiVersion) return
    const sourceName = sourceIndexName.trim()
    if (!sourceName) {
      setProgress((previous) => ({ ...previous, phase: 'error', message: t('indexCloneSelectSourceError') }))
      return
    }

    let targetName = targetIndexName.trim()
    let targetDefinition: JsonValue
    try {
      const parsed = parseIndexDefinitionJson(editedJson.trim(), t('indexBuilderJsonMustBeObject'), t('indexBuilderJsonNameRequired'))
      targetDefinition = parsed.body
      targetName = parsed.name
    } catch (error) {
      setProgress((previous) => ({
        ...previous,
        phase: 'error',
        message: format('indexCloneInvalidEditedJson', { error: error instanceof Error ? error.message : String(error) }),
      }))
      return
    }

    if (sourceName === targetName) {
      setProgress((previous) => ({ ...previous, phase: 'error', message: t('indexCloneSameNameError') }))
      return
    }
    if (indexNames.includes(targetName)) {
      const ok = window.confirm(format('indexCloneConfirmExistingTarget', { target: targetName }))
      if (!ok) return
    }
    const ok = window.confirm(format('indexCloneConfirmStart', { source: sourceName, target: targetName }))
    if (!ok) return

    const parsedMaxDocuments = maxDocumentsText.trim() ? Number(maxDocumentsText) : undefined
    const maxDocuments = typeof parsedMaxDocuments === 'number' && Number.isFinite(parsedMaxDocuments)
      ? Math.max(0, Math.floor(parsedMaxDocuments))
      : undefined
    const resolvedBatchSize = clampBatchSize(batchSize)
    const cachedSourceDefinition = sourceDefinition && preparedSourceName === sourceName ? sourceDefinition : undefined

    setProgress({
      phase: 'creating',
      message: t('indexCloneCreatingIndex'),
      readDocuments: 0,
      uploadedDocuments: 0,
      failedDocuments: 0,
      skippedSourceFieldNames: [],
      missingTargetFieldNames: [],
    })

    try {
      const outcome = await runCloneWorker({
        profile,
        apiVersion,
        language,
        sourceIndexName: sourceName,
        targetIndexName: targetName,
        targetDefinition,
        sourceDefinition: cachedSourceDefinition,
        batchSize: resolvedBatchSize,
        maxDocuments,
      })
      if (outcome === 'completed') await onCloneCompleted(targetName)
    } catch (error) {
      setProgress((previous) => previous.phase === 'error'
        ? previous
        : { ...previous, phase: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const cancelClone = () => {
    const worker = workerRef.current
    if (!worker) return
    worker.postMessage({ type: 'cancel', requestId: workerRequestIdRef.current } satisfies IndexCloneWorkerInbound)
  }

  return (
    <div className="indexCloneAssistant">
      <div className="indexCloneAssistant__header">
        <div>
          <div className="indexCloneAssistant__title">
            <i className="bi bi-intersect icon--mr6"></i>
            {t('indexCloneAssistant')}
          </div>
        </div>
      </div>

      <div className="indexCloneAssistant__body">
          <div className="indexCloneAssistant__desc">{t('indexCloneAssistantDesc')}</div>

          <div className="notice notice--warning indexCloneAssistant__notice">
            {t('indexCloneRetrievableWarning')}
          </div>

          <div className="form form--compact indexCloneAssistant__form">
            <label className="field">
              <span className="field__label">{t('indexCloneSourceIndex')}</span>
              <div className="indexSelectControl">
                <select
                  className="field__input"
                  value={sourceIndexName}
                  onChange={(event) => {
                    const next = event.target.value
                    setSourceIndexName(next)
                    setSourceDefinition(null)
                    setPreparedSourceName('')
                    if (!targetTouched) setTargetIndexName(defaultCloneName(next, indexNames))
                  }}
                  disabled={!canRun || isRunning}
                >
                  <option value="">{t('placeholderUnset')}</option>
                  {indexNames.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn--icon indexSelectReloadBtn"
                  onClick={() => void onReloadIndexNames()}
                  disabled={!canRun || isRunning || isIndexNamesLoading}
                  title={t('indexBuilderRefreshIndexListTitle')}
                  aria-label={t('indexBuilderRefreshIndexListTitle')}
                >
                  <i className={isIndexNamesLoading ? 'bi bi-arrow-repeat spin' : 'bi bi-arrow-clockwise'} aria-hidden="true" />
                </button>
              </div>
            </label>

            <label className="field">
              <span className="field__label">{t('indexCloneTargetIndex')}</span>
              <input
                className="field__input"
                value={targetIndexName}
                onChange={(event) => {
                  setTargetTouched(true)
                  setTargetIndexName(event.target.value)
                }}
                disabled={!canRun || isRunning}
                placeholder="my-index-v2"
              />
            </label>

            <label className="field">
              <span className="field__label">{t('indexCloneBatchSize')}</span>
              <input
                className="field__input"
                type="number"
                min={1}
                max={1000}
                value={batchSize}
                onChange={(event) => setBatchSize(clampBatchSize(Number(event.target.value)))}
                disabled={!canRun || isRunning}
              />
            </label>

            <label className="field">
              <span className="field__label">{t('indexCloneMaxDocuments')}</span>
              <input
                className="field__input"
                type="number"
                min={0}
                value={maxDocumentsText}
                onChange={(event) => setMaxDocumentsText(event.target.value)}
                disabled={!canRun || isRunning}
                placeholder={t('indexCloneMaxDocumentsPlaceholder')}
              />
            </label>
          </div>

          <div className="actions actions--mt10">
            <button type="button" className="btn" onClick={prepareCloneJson} disabled={!canRun || isRunning || !sourceIndexName.trim()}>
              <i className="bi bi-file-earmark-code icon--mr6"></i>
              {t('indexClonePrepareJson')}
            </button>
            <button type="button" className="btn btn--search" onClick={createAndCopy} disabled={!canRun || isRunning || !sourceIndexName.trim() || !editedJson.trim()}>
              <i className="bi bi-copy icon--mr6"></i>
              {t('indexCloneCreateAndCopy')}
            </button>
            {isRunning ? (
              <button type="button" className="btn" onClick={cancelClone}>
                <i className="bi bi-stop-circle icon--mr6"></i>
                {t('indexCloneCancel')}
              </button>
            ) : null}
          </div>

          {progress.message ? (
            <div className={`notice notice--${progress.phase === 'error' ? 'error' : progress.phase === 'completed' ? 'success' : progress.phase === 'cancelled' ? 'warning' : 'info'} indexCloneAssistant__notice`}>
              {progress.message}
            </div>
          ) : null}

          {(progress.phase === 'copying' || progress.phase === 'completed' || progress.phase === 'cancelled') ? (
            <div className="indexCloneAssistant__progress">
              <div className="indexCloneAssistant__progressTop">
                <span>{format('indexCloneProgressStats', {
                  read: progress.readDocuments,
                  uploaded: progress.uploadedDocuments,
                  failed: progress.failedDocuments,
                  total: progress.totalDocuments ?? '-',
                })}</span>
                <span>{progressPercent}%</span>
              </div>
              <div className="indexCloneAssistant__progressTrack" aria-hidden="true">
                <div className="indexCloneAssistant__progressFill" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          ) : null}

          {(progress.skippedSourceFieldNames.length > 0 || progress.missingTargetFieldNames.length > 0) ? (
            <div className="indexCloneAssistant__fieldPlan">
              <div className="indexCloneAssistant__fieldPlanTitle">{t('indexCloneFieldPlan')}</div>
              {progress.skippedSourceFieldNames.length > 0 ? (
                <div>{format('indexCloneSkippedFields', { fields: progress.skippedSourceFieldNames.join(', ') })}</div>
              ) : null}
              {progress.missingTargetFieldNames.length > 0 ? (
                <div>{format('indexCloneMissingTargetFields', { fields: progress.missingTargetFieldNames.join(', ') })}</div>
              ) : null}
            </div>
          ) : null}
      </div>
    </div>
  )
}
