import { useEffect, useRef } from 'react'
import type { CenterTab } from '../types'
import { loadPersistedTabs, normalizeCenterTab, type PersistedTabs, MAX_PERSISTED_RUN_IDS } from '../app/persistedTabs'
import { saveLastViewedRunId } from '../app/persistedLatestRun'

export function usePersistedTabsState(params: {
  selectedExperimentId: string | null
  selectedRunIds: string[]
  centerTab: CenterTab

  latestRunId: string | null

  isQpsTesterOpen: boolean
  isAutoTuningOpen: boolean
  isSearchPipelineVisualizerOpen: boolean
  isKnowledgeSourceBuilderOpen: boolean
  isKnowledgeBaseBuilderOpen: boolean
  isSynonymMapBuilderOpen: boolean
  isIndexBuilderOpen: boolean
  isIndexingPipelineBuilderOpen: boolean
  isSkillPipelineBuilderOpen: boolean
  isVectorOptimizerOpen: boolean
  isSkillEditorOpen: boolean
  isEvalDatasetGeneratorOpen: boolean
  isIndexVisualizerOpen: boolean
}) {
  const {
    selectedExperimentId,
    selectedRunIds,
    centerTab,
    latestRunId,
    isQpsTesterOpen,
    isAutoTuningOpen,
    isSearchPipelineVisualizerOpen,
    isKnowledgeSourceBuilderOpen,
    isKnowledgeBaseBuilderOpen,
    isSynonymMapBuilderOpen,
    isIndexBuilderOpen,
    isIndexingPipelineBuilderOpen,
    isSkillPipelineBuilderOpen,
    isVectorOptimizerOpen,
    isSkillEditorOpen,
    isEvalDatasetGeneratorOpen,
    isIndexVisualizerOpen,
  } = params

  /**
   * Tracks whether the restoration logic has completed for the current experiment.
   * When switching experiments, we need to allow the restore hook to apply persisted
   * state before this hook starts persisting changes again.
   */
  const hasRestoredRef = useRef(false)

  useEffect(() => {
    // Mark restoration as not yet complete when experiment changes
    hasRestoredRef.current = false
  }, [selectedExperimentId])

  useEffect(() => {
    if (!selectedExperimentId) return
    // Wait until restoration completes before saving
    if (!hasRestoredRef.current) {
      hasRestoredRef.current = true
      return
    }

    // `latestResponse` is in-memory, so on refresh it starts as null. Preserve the
    // previously persisted `latestRunId` until the restore hook reconstructs
    // `latestResponse` (even if the user refreshed while on a different tab).
    const persistedLatestRunId = loadPersistedTabs(selectedExperimentId)?.latestRunId
    const effectiveLatestRunId = latestRunId ?? persistedLatestRunId

    const normalizedCenterTab = normalizeCenterTab(centerTab, selectedRunIds)

    // Keep tool open flags consistent with the active tool tab.
    // This prevents persisting impossible states like "centerTab=index-builder" with "isIndexBuilderOpen=false".
    const toolOpen = {
      isQpsTesterOpen: isQpsTesterOpen || normalizedCenterTab === 'qps-tester',
      isAutoTuningOpen: isAutoTuningOpen || normalizedCenterTab === 'auto-tuning',
      isSearchPipelineVisualizerOpen: isSearchPipelineVisualizerOpen || normalizedCenterTab === 'search-pipeline-visualizer',
      isKnowledgeSourceBuilderOpen: isKnowledgeSourceBuilderOpen || normalizedCenterTab === 'knowledge-source-builder',
      isKnowledgeBaseBuilderOpen: isKnowledgeBaseBuilderOpen || normalizedCenterTab === 'knowledge-base-builder',
      isSynonymMapBuilderOpen: isSynonymMapBuilderOpen || normalizedCenterTab === 'synonym-map-builder',
      isIndexBuilderOpen: isIndexBuilderOpen || normalizedCenterTab === 'index-builder',
      isIndexingPipelineBuilderOpen: isIndexingPipelineBuilderOpen || normalizedCenterTab === 'indexing-pipeline-builder',
      isSkillPipelineBuilderOpen: isSkillPipelineBuilderOpen || normalizedCenterTab === 'skill-pipeline-builder',
      isVectorOptimizerOpen: isVectorOptimizerOpen || normalizedCenterTab === 'vector-optimizer',
      isSkillEditorOpen: isSkillEditorOpen || normalizedCenterTab === 'skill-editor',
      isEvalDatasetGeneratorOpen: isEvalDatasetGeneratorOpen || normalizedCenterTab === 'eval-dataset-generator',
      isIndexVisualizerOpen: isIndexVisualizerOpen || normalizedCenterTab === 'index-visualizer',
    }

    const payload: PersistedTabs = {
      selectedRunIds: selectedRunIds.slice(0, MAX_PERSISTED_RUN_IDS),
      centerTab: normalizedCenterTab,
      latestRunId: effectiveLatestRunId ?? undefined,
      ...toolOpen,
    }
    try {
      localStorage.setItem(`tabs:${selectedExperimentId}`, JSON.stringify(payload))
    } catch {
      // ignore
    }

    // Persist the last viewed result globally so browser refresh restores the
    // most recently opened run (via run click), independent of experiment.
    if (latestRunId) {
      saveLastViewedRunId(latestRunId)
    }
  }, [
    selectedExperimentId,
    selectedRunIds,
    centerTab,
    latestRunId,
    isQpsTesterOpen,
    isAutoTuningOpen,
    isSearchPipelineVisualizerOpen,
    isKnowledgeSourceBuilderOpen,
    isKnowledgeBaseBuilderOpen,
    isSynonymMapBuilderOpen,
    isIndexBuilderOpen,
    isIndexingPipelineBuilderOpen,
    isSkillPipelineBuilderOpen,
    isVectorOptimizerOpen,
    isSkillEditorOpen,
    isEvalDatasetGeneratorOpen,
    isIndexVisualizerOpen,
  ])
}
