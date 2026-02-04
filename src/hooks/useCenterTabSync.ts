import type { Dispatch, SetStateAction } from 'react'
import { useEffect } from 'react'
import type { CenterTab, LatestResponse } from '../types'

export function useCenterTabSync(params: {
  centerTab: CenterTab
  selectedRunIds: string[]
  latestResponse: LatestResponse | null
  setCenterTab: Dispatch<SetStateAction<CenterTab>>

  setIsQpsTesterOpen: Dispatch<SetStateAction<boolean>>
  setIsAutoTuningOpen: Dispatch<SetStateAction<boolean>>
  setIsSearchPipelineVisualizerOpen: Dispatch<SetStateAction<boolean>>
  setIsKnowledgeSourceBuilderOpen: Dispatch<SetStateAction<boolean>>
  setIsKnowledgeBaseBuilderOpen: Dispatch<SetStateAction<boolean>>
  setIsSynonymMapBuilderOpen: Dispatch<SetStateAction<boolean>>
  setIsIndexBuilderOpen: Dispatch<SetStateAction<boolean>>
  setIsSkillPipelineBuilderOpen: Dispatch<SetStateAction<boolean>>
  setIsVectorOptimizerOpen: Dispatch<SetStateAction<boolean>>
}) {
  const {
    centerTab,
    selectedRunIds,
    latestResponse,
    setCenterTab,
    setIsQpsTesterOpen,
    setIsAutoTuningOpen,
    setIsSearchPipelineVisualizerOpen,
    setIsKnowledgeSourceBuilderOpen,
    setIsKnowledgeBaseBuilderOpen,
    setIsSynonymMapBuilderOpen,
    setIsIndexBuilderOpen,
    setIsSkillPipelineBuilderOpen,
    setIsVectorOptimizerOpen,
  } = params

  // Keep centerTab pointing to something valid.
  useEffect(() => {
    if (centerTab === 'builder') return

    if (typeof centerTab === 'string' && centerTab.startsWith('run:')) {
      const runId = centerTab.slice(4)
      if (!selectedRunIds.includes(runId)) {
        if (selectedRunIds.length > 0) {
          setCenterTab(`run:${selectedRunIds[0]}`)
        } else if (latestResponse) {
          setCenterTab('latest')
        } else {
          setCenterTab('builder')
        }
      }
      return
    }

    // Don't validate 'latest' tab - allow it even if latestResponse is temporarily null
    // This prevents race conditions during state updates
  }, [centerTab, latestResponse, selectedRunIds, setCenterTab])

  // Sync centerTab with builder tool open states.
  useEffect(() => {
    switch (centerTab) {
      case 'qps-tester':
        setIsQpsTesterOpen(true)
        break
      case 'auto-tuning':
        setIsAutoTuningOpen(true)
        break
      case 'search-pipeline-visualizer':
        setIsSearchPipelineVisualizerOpen(true)
        break
      case 'knowledge-source-builder':
        setIsKnowledgeSourceBuilderOpen(true)
        break
      case 'knowledge-base-builder':
        setIsKnowledgeBaseBuilderOpen(true)
        break
      case 'synonym-map-builder':
        setIsSynonymMapBuilderOpen(true)
        break
      case 'index-builder':
        setIsIndexBuilderOpen(true)
        break
      case 'skill-pipeline-builder':
        setIsSkillPipelineBuilderOpen(true)
        break
      case 'vector-optimizer':
        setIsVectorOptimizerOpen(true)
        break
    }
  }, [
    centerTab,
    setIsAutoTuningOpen,
    setIsIndexBuilderOpen,
    setIsSkillPipelineBuilderOpen,
    setIsKnowledgeBaseBuilderOpen,
    setIsKnowledgeSourceBuilderOpen,
    setIsQpsTesterOpen,
    setIsSearchPipelineVisualizerOpen,
    setIsSynonymMapBuilderOpen,
    setIsVectorOptimizerOpen,
  ])
}
