import { useMemo } from 'react'
import type { JsonValue } from '../lib/aiSearchRest'
import { safeJsonParse } from '../utils'
import { extractSearchFacets } from '../utils/searchFacets'
import type { CenterTab, PaneSizes, ResultView } from '../types'

export function useRightPaneDerivations(params: {
  centerTab: CenterTab
  resultViews: ResultView[]
  paneSizes: PaneSizes
  isRightPaneCollapsed: boolean
  requestJson: string
}) {
  const { centerTab, resultViews, paneSizes, isRightPaneCollapsed, requestJson } = params

  const activeResultView = useMemo(() => {
    return centerTab === 'builder'
      ? resultViews[0]
      : resultViews.find((v) => v.id === centerTab) ?? resultViews[0]
  }, [centerTab, resultViews])

  const gridTemplateColumns = useMemo(() => {
    const rightPaneWidth = isRightPaneCollapsed ? 0 : paneSizes.rightPx
    const rightSplitterWidth = isRightPaneCollapsed ? 32 : 10

    return isRightPaneCollapsed
      ? `${paneSizes.leftPx}px 10px 1fr ${rightSplitterWidth}px`
      : `${paneSizes.leftPx}px 10px 1fr ${rightSplitterWidth}px ${rightPaneWidth}px`
  }, [isRightPaneCollapsed, paneSizes.leftPx, paneSizes.rightPx])

  const jsonViewerRequestData: JsonValue = useMemo(() => {
    return centerTab === 'builder' ? safeJsonParse(requestJson) : activeResultView?.response?.requestBody ?? {}
  }, [activeResultView?.response?.requestBody, centerTab, requestJson])

  const jsonViewerResponseData: JsonValue = useMemo(() => {
    return centerTab === 'builder' ? activeResultView?.response?.body ?? {} : activeResultView?.response?.body ?? {}
  }, [activeResultView?.response?.body, centerTab])

  const jsonViewerFacets = useMemo(() => extractSearchFacets(jsonViewerResponseData), [jsonViewerResponseData])

  return {
    activeResultView,
    gridTemplateColumns,
    jsonViewerRequestData,
    jsonViewerResponseData,
    jsonViewerFacets,
  }
}
