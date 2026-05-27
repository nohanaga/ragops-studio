import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { loadPersistedTabs } from '../app/persistedTabs'
import type { Run } from '../lib/model'
import type { CenterTab } from '../types'

function isToolTab(tab: CenterTab): boolean {
  return (
    tab === 'qps-tester' ||
    tab === 'auto-tuning' ||
    tab === 'search-pipeline-visualizer' ||
    tab === 'vector-optimizer' ||
    tab === 'knowledge-source-builder' ||
    tab === 'knowledge-base-builder' ||
    tab === 'synonym-map-builder' ||
    tab === 'index-builder' ||
    tab === 'indexing-pipeline-builder' ||
    tab === 'skill-pipeline-builder' ||
    tab === 'skill-editor' ||
    tab === 'eval-dataset-generator' ||
    tab === 'index-visualizer'
  )
}

export function useExperimentTabRestore(params: {
  selectedExperimentId: string | null
  centerTab: CenterTab
  reloadRuns: (experimentId: string | null) => Promise<void>

  setSelectedRun: Dispatch<SetStateAction<Run | null>>
  setSelectedRunIds: Dispatch<SetStateAction<string[]>>
  setCenterTab: Dispatch<SetStateAction<CenterTab>>

  setIsQpsTesterOpen: Dispatch<SetStateAction<boolean>>
  setIsAutoTuningOpen: Dispatch<SetStateAction<boolean>>
  setIsSearchPipelineVisualizerOpen: Dispatch<SetStateAction<boolean>>
  setIsKnowledgeSourceBuilderOpen: Dispatch<SetStateAction<boolean>>
  setIsKnowledgeBaseBuilderOpen: Dispatch<SetStateAction<boolean>>
  setIsSynonymMapBuilderOpen: Dispatch<SetStateAction<boolean>>
  setIsIndexBuilderOpen: Dispatch<SetStateAction<boolean>>
  setIsIndexingPipelineBuilderOpen: Dispatch<SetStateAction<boolean>>
  setIsSkillPipelineBuilderOpen: Dispatch<SetStateAction<boolean>>
  setIsVectorOptimizerOpen: Dispatch<SetStateAction<boolean>>
  setIsSkillEditorOpen: Dispatch<SetStateAction<boolean>>
  setIsEvalDatasetGeneratorOpen: Dispatch<SetStateAction<boolean>>
  setIsIndexVisualizerOpen: Dispatch<SetStateAction<boolean>>
}) {
  const {
    selectedExperimentId,
    centerTab,
    reloadRuns,
    setSelectedRun,
    setSelectedRunIds,
    setCenterTab,
    setIsQpsTesterOpen,
    setIsAutoTuningOpen,
    setIsSearchPipelineVisualizerOpen,
    setIsKnowledgeSourceBuilderOpen,
    setIsKnowledgeBaseBuilderOpen,
    setIsSynonymMapBuilderOpen,
    setIsIndexBuilderOpen,
    setIsIndexingPipelineBuilderOpen,
    setIsSkillPipelineBuilderOpen,
    setIsVectorOptimizerOpen,
    setIsSkillEditorOpen,
    setIsEvalDatasetGeneratorOpen,
    setIsIndexVisualizerOpen,
  } = params

  // Restore tool open flags only once on initial mount/boot.
  // When switching experiments we keep tool tabs stable (global UI), instead of
  // applying per-experiment persisted booleans that would close/open tabs.
  const hasRestoredToolTabsRef = useRef(false)

  // Track the latest centerTab without re-running the restore effect on every tab click.
  const centerTabRef = useRef<CenterTab>(centerTab)

  useEffect(() => {
    centerTabRef.current = centerTab
  }, [centerTab])

  // Ensure we only run the restore logic when the experiment actually changes.
  const lastExperimentIdRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (lastExperimentIdRef.current === selectedExperimentId) return
    const previousExperimentId = lastExperimentIdRef.current
    lastExperimentIdRef.current = selectedExperimentId

    // We treat experiment selection as a navigation/filter action for the left pane.
    // It should not implicitly "restore" runs (i.e., load run artifacts and overwrite
    // the current request/result view). Therefore, we only apply persisted run-tab state
    // on initial boot (when there was no previous experiment).
    const shouldApplyPersistedRunTabs = previousExperimentId === null

    void reloadRuns(selectedExperimentId)
    setSelectedRun(null)

    if (!selectedExperimentId) {
      setSelectedRunIds([])
      // Don't force-close tool tabs or portal here; preserve global UI state.
      if (!isToolTab(centerTabRef.current) && centerTabRef.current !== 'portal') {
        setCenterTab('builder')
      }
      return
    }

    const restored = loadPersistedTabs(selectedExperimentId)
    if (restored) {
      if (shouldApplyPersistedRunTabs) {
        setSelectedRunIds(restored.selectedRunIds)
      }

      // Restore the active tab on initial boot so browser refreshes keep the same view.
      // When switching experiments, preserve global tool/portal navigation instead.
      if (shouldApplyPersistedRunTabs && !isToolTab(centerTabRef.current)) {
        setCenterTab(restored.centerTab)
      }

      // Restore tool open flags only once at boot.
      if (!hasRestoredToolTabsRef.current) {
        hasRestoredToolTabsRef.current = true
        setIsQpsTesterOpen(restored.isQpsTesterOpen ?? false)
        setIsAutoTuningOpen(restored.isAutoTuningOpen ?? false)
        setIsSearchPipelineVisualizerOpen(restored.isSearchPipelineVisualizerOpen ?? false)
        setIsKnowledgeSourceBuilderOpen(restored.isKnowledgeSourceBuilderOpen ?? false)
        setIsKnowledgeBaseBuilderOpen(restored.isKnowledgeBaseBuilderOpen ?? false)
        setIsSynonymMapBuilderOpen(restored.isSynonymMapBuilderOpen ?? false)
        setIsIndexBuilderOpen(restored.isIndexBuilderOpen ?? false)
        setIsIndexingPipelineBuilderOpen(restored.isIndexingPipelineBuilderOpen ?? false)
        setIsSkillPipelineBuilderOpen(restored.isSkillPipelineBuilderOpen ?? false)
        setIsVectorOptimizerOpen(restored.isVectorOptimizerOpen ?? false)
        setIsSkillEditorOpen(restored.isSkillEditorOpen ?? false)
        setIsEvalDatasetGeneratorOpen(restored.isEvalDatasetGeneratorOpen ?? false)
        setIsIndexVisualizerOpen(restored.isIndexVisualizerOpen ?? false)
      }
    } else {
      setSelectedRunIds([])
      if (!isToolTab(centerTabRef.current) && centerTabRef.current !== 'portal') {
        setCenterTab('builder')
      }
    }
  }, [
    reloadRuns,
    selectedExperimentId,
    setCenterTab,
    setIsAutoTuningOpen,
    setIsIndexBuilderOpen,
    setIsIndexingPipelineBuilderOpen,
    setIsSkillPipelineBuilderOpen,
    setIsKnowledgeBaseBuilderOpen,
    setIsKnowledgeSourceBuilderOpen,
    setIsQpsTesterOpen,
    setIsSearchPipelineVisualizerOpen,
    setIsSynonymMapBuilderOpen,
    setIsVectorOptimizerOpen,
    setIsSkillEditorOpen,
    setIsEvalDatasetGeneratorOpen,
    setIsIndexVisualizerOpen,
    setSelectedRun,
    setSelectedRunIds,
  ])
}
