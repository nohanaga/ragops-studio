import { isJsonObject } from '../app/json'
import {
  createOrUpdateIndex,
  getIndexDefinition,
  indexDocuments,
  searchDocuments,
  type JsonValue,
  type RestResult,
} from './aiSearchRest'
import type { ConnectionProfile, SearchApiVersion } from './model'
import { translations, type Language } from './translations'
import {
  buildCloneFieldPlan,
  buildIndexDocumentsPayload,
  countIndexingFailures,
  getRetryableIndexingFailureKeys,
} from '../utils/indexClone'

type TranslationKey = keyof typeof translations.ja

export type IndexCloneWorkerPhase = 'creating' | 'copying' | 'completed' | 'cancelled'

export type IndexCloneRetryOperation = 'load-source' | 'create-index' | 'search-documents' | 'upload-documents' | 'upload-items'

export type CloneRetryPolicy = {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  jitterRatio: number
}

export type IndexCloneWorkerProgress = {
  phase: IndexCloneWorkerPhase
  totalDocuments?: number
  readDocuments: number
  uploadedDocuments: number
  failedDocuments: number
  skippedSourceFieldNames: string[]
  missingTargetFieldNames: string[]
}

export type IndexCloneRetryNotice = {
  operation: IndexCloneRetryOperation
  attempt: number
  maxAttempts: number
  delayMs: number
  status: number
  message: string
}

export type IndexCloneWorkerStartRequest = {
  type: 'start'
  requestId: number
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  language: Language
  sourceIndexName: string
  targetIndexName: string
  targetDefinition: JsonValue
  sourceDefinition?: JsonValue
  batchSize: number
  maxDocuments?: number
  retryPolicy?: Partial<CloneRetryPolicy>
}

export type IndexCloneWorkerCancelRequest = {
  type: 'cancel'
  requestId: number
}

export type IndexCloneWorkerInbound = IndexCloneWorkerStartRequest | IndexCloneWorkerCancelRequest

export type IndexCloneWorkerOutbound =
  | { type: 'progress'; requestId: number; progress: IndexCloneWorkerProgress }
  | { type: 'retry'; requestId: number; retry: IndexCloneRetryNotice }
  | { type: 'completed'; requestId: number; progress: IndexCloneWorkerProgress }
  | { type: 'cancelled'; requestId: number; progress: IndexCloneWorkerProgress }
  | { type: 'error'; requestId: number; message: string; progress?: IndexCloneWorkerProgress }

type RetryRunnerOptions = {
  operationName: IndexCloneRetryOperation
  policy?: Partial<CloneRetryPolicy>
  signal?: AbortSignal
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  onRetry?: (notice: IndexCloneRetryNotice) => void
}

type UploadBatchOptions = {
  profile: ConnectionProfile
  apiVersion: SearchApiVersion
  language: Language
  targetIndexName: string
  keyFieldName: string
  documents: JsonValue[]
  copyFieldNames: string[]
  signal: AbortSignal
  retryPolicy: CloneRetryPolicy
  onRetry: (notice: IndexCloneRetryNotice) => void
}

const DEFAULT_RETRY_POLICY: CloneRetryPolicy = {
  maxAttempts: 5,
  initialDelayMs: 500,
  maxDelayMs: 8000,
  jitterRatio: 0.2,
}

export function resolveCloneRetryPolicy(policy?: Partial<CloneRetryPolicy>): CloneRetryPolicy {
  return {
    maxAttempts: Math.max(1, Math.floor(policy?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts)),
    initialDelayMs: Math.max(0, Math.floor(policy?.initialDelayMs ?? DEFAULT_RETRY_POLICY.initialDelayMs)),
    maxDelayMs: Math.max(0, Math.floor(policy?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs)),
    jitterRatio: Math.max(0, Math.min(1, policy?.jitterRatio ?? DEFAULT_RETRY_POLICY.jitterRatio)),
  }
}

export function isRetryableCloneStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504
}

export function calculateCloneRetryDelayMs(
  retryIndex: number,
  policy: CloneRetryPolicy,
  random: () => number = Math.random,
): number {
  const exponentialDelay = policy.initialDelayMs * (2 ** Math.max(0, retryIndex - 1))
  const cappedDelay = Math.min(policy.maxDelayMs, exponentialDelay)
  if (policy.jitterRatio <= 0 || cappedDelay <= 0) return Math.round(cappedDelay)

  const jitter = cappedDelay * policy.jitterRatio
  const multiplier = (random() * 2) - 1
  return Math.max(0, Math.round(cappedDelay + (jitter * multiplier)))
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('Aborted', 'AbortError')
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError()
}

function sleepWithSignal(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)

    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(createAbortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function runCloneOperationWithRetry(
  operation: () => Promise<RestResult>,
  options: RetryRunnerOptions,
): Promise<RestResult> {
  const policy = resolveCloneRetryPolicy(options.policy)
  const sleep = options.sleep ?? sleepWithSignal

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    throwIfAborted(options.signal)
    const result = await operation()
    throwIfAborted(options.signal)

    if (result.ok || !isRetryableCloneStatus(result.status) || attempt >= policy.maxAttempts) {
      return result
    }

    const delayMs = calculateCloneRetryDelayMs(attempt, policy)
    options.onRetry?.({
      operation: options.operationName,
      attempt: attempt + 1,
      maxAttempts: policy.maxAttempts,
      delayMs,
      status: result.status,
      message: result.error.message,
    })
    await sleep(delayMs, options.signal)
  }

  return operation()
}

function getResponseItems(response: JsonValue): JsonValue[] {
  if (!isJsonObject(response) || !Array.isArray(response.value)) return []
  return response.value
}

function getResponseCount(response: JsonValue): number | undefined {
  if (!isJsonObject(response)) return undefined
  const count = response['@odata.count']
  return typeof count === 'number' && Number.isFinite(count) ? count : undefined
}

function getDocumentKey(document: JsonValue, keyFieldName: string): string {
  if (!isJsonObject(document)) return ''
  const keyValue = document[keyFieldName]
  if (typeof keyValue === 'string') return keyValue
  if (typeof keyValue === 'number' || typeof keyValue === 'boolean') return String(keyValue)
  return ''
}

function format(language: Language, key: TranslationKey, params: Record<string, string | number>): string {
  let text = String(translations[language][key] ?? '')
  for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

function makeProgress(phase: IndexCloneWorkerPhase, progress?: Partial<IndexCloneWorkerProgress>): IndexCloneWorkerProgress {
  return {
    phase,
    readDocuments: progress?.readDocuments ?? 0,
    uploadedDocuments: progress?.uploadedDocuments ?? 0,
    failedDocuments: progress?.failedDocuments ?? 0,
    totalDocuments: progress?.totalDocuments,
    skippedSourceFieldNames: progress?.skippedSourceFieldNames ?? [],
    missingTargetFieldNames: progress?.missingTargetFieldNames ?? [],
  }
}

function postWorkerMessage(message: IndexCloneWorkerOutbound) {
  self.postMessage(message)
}

async function uploadDocumentsWithItemRetries(options: UploadBatchOptions): Promise<{ uploadedDocuments: number; failedDocuments: number }> {
  let pendingDocuments = options.documents
  let uploadedDocuments = 0
  let failedDocuments = 0

  for (let attempt = 1; attempt <= options.retryPolicy.maxAttempts; attempt += 1) {
    throwIfAborted(options.signal)

    const payload = buildIndexDocumentsPayload(pendingDocuments, options.copyFieldNames)
    const uploadResult = await runCloneOperationWithRetry(
      () => indexDocuments({
        profile: options.profile,
        apiVersion: options.apiVersion,
        indexName: options.targetIndexName,
        body: payload,
        language: options.language,
        signal: options.signal,
      }),
      {
        operationName: 'upload-documents',
        policy: options.retryPolicy,
        signal: options.signal,
        onRetry: options.onRetry,
      },
    )

    if (!uploadResult.ok) {
      throw new Error(format(options.language, 'indexCloneUploadFailed', { error: uploadResult.error.message }))
    }

    const batchFailures = countIndexingFailures(uploadResult.response)
    const retryableFailureKeys = getRetryableIndexingFailureKeys(uploadResult.response)
    uploadedDocuments += pendingDocuments.length - batchFailures

    if (retryableFailureKeys.length === 0) {
      failedDocuments += batchFailures
      break
    }

    const retryableKeySet = new Set(retryableFailureKeys)
    const retryableDocuments = pendingDocuments.filter((document) => retryableKeySet.has(getDocumentKey(document, options.keyFieldName)))
    failedDocuments += batchFailures - retryableFailureKeys.length
    failedDocuments += Math.max(0, retryableFailureKeys.length - retryableDocuments.length)

    if (retryableDocuments.length === 0) break
    if (attempt >= options.retryPolicy.maxAttempts) {
      failedDocuments += retryableDocuments.length
      break
    }

    const delayMs = calculateCloneRetryDelayMs(attempt, options.retryPolicy)
    options.onRetry({
      operation: 'upload-items',
      attempt: attempt + 1,
      maxAttempts: options.retryPolicy.maxAttempts,
      delayMs,
      status: 207,
      message: format(options.language, 'indexCloneRetryableItemFailures', { count: retryableDocuments.length }),
    })
    await sleepWithSignal(delayMs, options.signal)
    pendingDocuments = retryableDocuments
  }

  return { uploadedDocuments, failedDocuments }
}

let activeAbortController: AbortController | null = null
let activeRequestId = 0

async function startIndexClone(request: IndexCloneWorkerStartRequest) {
  const abortController = new AbortController()
  activeAbortController = abortController
  activeRequestId = request.requestId

  const retryPolicy = resolveCloneRetryPolicy(request.retryPolicy)
  let latestProgress = makeProgress('creating')
  const postProgress = (progress: IndexCloneWorkerProgress) => {
    latestProgress = progress
    postWorkerMessage({ type: 'progress', requestId: request.requestId, progress })
  }
  const postRetry = (retry: IndexCloneRetryNotice) => {
    postWorkerMessage({ type: 'retry', requestId: request.requestId, retry })
  }

  try {
    postProgress(makeProgress('creating'))

    const sourceDefinition = request.sourceDefinition ?? await (async () => {
      const sourceResult = await runCloneOperationWithRetry(
        () => getIndexDefinition({
          profile: request.profile,
          apiVersion: request.apiVersion,
          indexName: request.sourceIndexName,
          language: request.language,
          signal: abortController.signal,
        }),
        {
          operationName: 'load-source',
          policy: retryPolicy,
          signal: abortController.signal,
          onRetry: postRetry,
        },
      )
      if (!sourceResult.ok) throw new Error(format(request.language, 'indexCloneSourceLoadFailed', { error: sourceResult.error.message }))
      return sourceResult.response
    })()

    const plan = buildCloneFieldPlan(sourceDefinition, request.targetDefinition)
    if (!plan.keyFieldName) throw new Error(translations[request.language].indexCloneNoKeyField)
    if (!plan.copyFieldNames.includes(plan.keyFieldName)) throw new Error(format(request.language, 'indexCloneKeyNotCopyable', { key: plan.keyFieldName }))
    if (plan.copyFieldNames.length === 0) throw new Error(translations[request.language].indexCloneNoCopyFields)

    const createResult = await runCloneOperationWithRetry(
      () => createOrUpdateIndex({
        profile: request.profile,
        apiVersion: request.apiVersion,
        indexName: request.targetIndexName,
        body: request.targetDefinition,
        language: request.language,
        signal: abortController.signal,
      }),
      {
        operationName: 'create-index',
        policy: retryPolicy,
        signal: abortController.signal,
        onRetry: postRetry,
      },
    )
    if (!createResult.ok) throw new Error(createResult.error.message)

    let skip = 0
    let readDocuments = 0
    let uploadedDocuments = 0
    let failedDocuments = 0
    let totalDocuments: number | undefined

    postProgress(makeProgress('copying', {
      totalDocuments,
      readDocuments,
      uploadedDocuments,
      failedDocuments,
      skippedSourceFieldNames: plan.skippedSourceFieldNames,
      missingTargetFieldNames: plan.missingTargetFieldNames,
    }))

    while (!abortController.signal.aborted) {
      const remainingLimit = typeof request.maxDocuments === 'number' ? request.maxDocuments - readDocuments : undefined
      if (typeof remainingLimit === 'number' && remainingLimit <= 0) break
      const top = typeof remainingLimit === 'number' ? Math.min(request.batchSize, remainingLimit) : request.batchSize

      const searchResult = await runCloneOperationWithRetry(
        () => searchDocuments({
          profile: request.profile,
          indexName: request.sourceIndexName,
          apiVersion: request.apiVersion,
          language: request.language,
          signal: abortController.signal,
          body: {
            search: '*',
            top,
            skip,
            count: skip === 0,
            select: plan.copyFieldNames.join(','),
          },
        }),
        {
          operationName: 'search-documents',
          policy: retryPolicy,
          signal: abortController.signal,
          onRetry: postRetry,
        },
      )
      if (!searchResult.ok) throw new Error(format(request.language, 'indexCloneSearchFailed', { error: searchResult.error.message }))

      const items = getResponseItems(searchResult.response)
      if (skip === 0) totalDocuments = getResponseCount(searchResult.response)
      if (items.length === 0) break

      const batchResult = await uploadDocumentsWithItemRetries({
        profile: request.profile,
        apiVersion: request.apiVersion,
        language: request.language,
        targetIndexName: request.targetIndexName,
        keyFieldName: plan.keyFieldName,
        documents: items,
        copyFieldNames: plan.copyFieldNames,
        signal: abortController.signal,
        retryPolicy,
        onRetry: postRetry,
      })

      readDocuments += items.length
      uploadedDocuments += batchResult.uploadedDocuments
      failedDocuments += batchResult.failedDocuments
      skip += items.length

      postProgress(makeProgress('copying', {
        totalDocuments: typeof request.maxDocuments === 'number'
          ? Math.min(request.maxDocuments, totalDocuments ?? request.maxDocuments)
          : totalDocuments,
        readDocuments,
        uploadedDocuments,
        failedDocuments,
        skippedSourceFieldNames: plan.skippedSourceFieldNames,
        missingTargetFieldNames: plan.missingTargetFieldNames,
      }))

      if (items.length < top) break
    }

    if (abortController.signal.aborted) {
      latestProgress = { ...latestProgress, phase: 'cancelled' }
      postWorkerMessage({ type: 'cancelled', requestId: request.requestId, progress: latestProgress })
      return
    }

    latestProgress = { ...latestProgress, phase: 'completed' }
    postWorkerMessage({ type: 'completed', requestId: request.requestId, progress: latestProgress })
  } catch (error) {
    if (abortController.signal.aborted) {
      latestProgress = { ...latestProgress, phase: 'cancelled' }
      postWorkerMessage({ type: 'cancelled', requestId: request.requestId, progress: latestProgress })
      return
    }
    postWorkerMessage({ type: 'error', requestId: request.requestId, message: error instanceof Error ? error.message : String(error), progress: latestProgress })
  } finally {
    if (activeRequestId === request.requestId) {
      activeAbortController = null
      activeRequestId = 0
    }
  }
}

if (typeof self !== 'undefined') {
  self.onmessage = (event: MessageEvent<IndexCloneWorkerInbound>) => {
    const message = event.data
    if (message.type === 'cancel') {
      if (activeRequestId === message.requestId) activeAbortController?.abort()
      return
    }

    void startIndexClone(message)
  }
}
