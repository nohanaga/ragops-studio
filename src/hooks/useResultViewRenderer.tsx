import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { AppSettings } from '../lib/model'
import type { TranslationKey, Language } from '../lib/translations'
import type { LatestResponse, ResultView } from '../types'
import { ResultViewPanel } from '../components'

type TFunction = (key: TranslationKey) => string

export function useResultViewRenderer(params: {
  t: TFunction
  language: Language
  settings: AppSettings | null

  resultPages: Record<string, number>
  setResultPages: Dispatch<SetStateAction<Record<string, number>>>

  compareMode: boolean
  setCompareMode: Dispatch<SetStateAction<boolean>>

  latestResponse: LatestResponse | null
}) {
  const {
    t,
    language,
    settings,
    resultPages,
    setResultPages,
    compareMode,
    setCompareMode,
    latestResponse,
  } = params

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
        />
      )
    },
    [compareMode, language, latestResponse, resultPages, setCompareMode, setResultPages, settings, t],
  )

  return { renderResultView }
}
