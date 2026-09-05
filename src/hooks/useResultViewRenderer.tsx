import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { AppSettings, ConnectionProfile, Run, SearchApiVersion } from '../lib/model'
import type { TranslationKey, Language } from '../lib/translations'
import type { LatestResponse, ResultView } from '../types'
import type { JsonValue } from '../lib/aiSearchRest'
import { ResultViewPanel } from '../components'

type TFunction = (key: TranslationKey) => string

type JsonObject = { [key: string]: JsonValue }

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameDocumentKey(a: JsonValue | undefined, b: JsonValue): boolean {
  if (a === undefined) return false
  return String(a) === String(b)
}

function mergeDocumentForDisplay(current: JsonObject, next: JsonObject): JsonObject {
  const merged: JsonObject = {}
  for (const [key, value] of Object.entries(current)) {
    if (key.startsWith('@search.')) merged[key] = value
  }
  for (const [key, value] of Object.entries(next)) {
    if (!key.startsWith('@search.')) merged[key] = value
  }
  return merged
}

function updateSearchResponseBody(
  body: JsonValue,
  change: { keyFieldName: string; keyValue: JsonValue; nextDocument: JsonObject | null },
): JsonValue {
  if (!isJsonObject(body) || !Array.isArray(body.value)) return body

  const nextDocument = change.nextDocument
  const nextValue = nextDocument
    ? body.value.map((item) => {
        if (!isJsonObject(item) || !sameDocumentKey(item[change.keyFieldName], change.keyValue)) return item
        return mergeDocumentForDisplay(item, nextDocument)
      })
    : body.value.filter((item) => !isJsonObject(item) || !sameDocumentKey(item[change.keyFieldName], change.keyValue))

  return {
    ...body,
    value: nextValue,
  }
}

export function useResultViewRenderer(params: {
  t: TFunction
  language: Language
  settings: AppSettings | null
  activeProfile: ConnectionProfile | null
  indexName: string
  apiVersion: SearchApiVersion | ''
  requestBuilderKeyFieldName: string | null

  resultPages: Record<string, number>
  setResultPages: Dispatch<SetStateAction<Record<string, number>>>

  compareMode: boolean
  setCompareMode: Dispatch<SetStateAction<boolean>>

  latestResponse: LatestResponse | null
  setLatestResponse: Dispatch<SetStateAction<LatestResponse | null>>
  setRunResultMap: Dispatch<SetStateAction<Record<string, { run: Run; response: LatestResponse | null }>>>
  isStreamingResponse: boolean
}) {
  const {
    t,
    language,
    settings,
    activeProfile,
    indexName,
    apiVersion,
    requestBuilderKeyFieldName,
    resultPages,
    setResultPages,
    compareMode,
    setCompareMode,
    latestResponse,
    setLatestResponse,
    setRunResultMap,
    isStreamingResponse,
  } = params

  const onDocumentActionApplied = useCallback(
    (change: {
      viewId: ResultView['id']
      runId?: string
      keyFieldName: string
      keyValue: JsonValue
      nextDocument: JsonObject | null
    }) => {
      if (change.viewId === 'latest') {
        setLatestResponse((prev) => prev ? { ...prev, body: updateSearchResponseBody(prev.body, change) } : prev)
      }

      if (change.runId) {
        setRunResultMap((prev) => {
          const entry = prev[change.runId!]
          if (!entry?.response) return prev
          return {
            ...prev,
            [change.runId!]: {
              ...entry,
              response: {
                ...entry.response,
                body: updateSearchResponseBody(entry.response.body, change),
              },
            },
          }
        })
      }
    },
    [setLatestResponse, setRunResultMap],
  )

  const renderResultView = useCallback(
    (view: ResultView) => {
      const currentPage = resultPages[view.id] ?? 1
      const setCurrentPage = (page: number) =>
        setResultPages((prev) => ({
          ...prev,
          [view.id]: page,
        }))

      const compareBaseline =
        compareMode &&
        view.id !== 'latest' &&
        view.runType === 'analyze' &&
        latestResponse?.runType === 'analyze'
          ? latestResponse
          : null

      return (
        <ResultViewPanel
          view={view}
          currentPage={currentPage}
          onPageChange={setCurrentPage}
          t={t}
          language={language}
          compareMode={compareMode}
          onCompareModeChange={setCompareMode}
          compareBaseline={compareBaseline}
          settings={settings}
          documentActionProfile={activeProfile}
          documentActionIndexName={view.indexName ?? indexName}
          documentActionApiVersion={(view.apiVersion as SearchApiVersion | undefined) ?? apiVersion}
          documentActionKeyFieldName={requestBuilderKeyFieldName}
          isStreamingResponse={view.id === 'latest' && isStreamingResponse}
          onDocumentActionApplied={(change) => onDocumentActionApplied({ ...change, viewId: view.id, runId: view.runId })}
        />
      )
    },
    [activeProfile, apiVersion, compareMode, indexName, isStreamingResponse, language, latestResponse, onDocumentActionApplied, requestBuilderKeyFieldName, resultPages, setCompareMode, setResultPages, settings, t],
  )

  return { renderResultView }
}
