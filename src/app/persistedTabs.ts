import type { CenterTab } from '../types'
import { MAX_PERSISTED_RUN_IDS } from './constants'

export { MAX_PERSISTED_RUN_IDS }

export type PersistedTabs = {
  selectedRunIds: string[]
  centerTab: CenterTab
  /** The runId currently shown in the `latest` tab (if any). */
  latestRunId?: string
  isQpsTesterOpen?: boolean
  isAutoTuningOpen?: boolean
  isSearchPipelineVisualizerOpen?: boolean
  isKnowledgeSourceBuilderOpen?: boolean
  isKnowledgeBaseBuilderOpen?: boolean
  isSynonymMapBuilderOpen?: boolean
  isIndexBuilderOpen?: boolean
  isIndexingPipelineBuilderOpen?: boolean
  isSkillPipelineBuilderOpen?: boolean
  isVectorOptimizerOpen?: boolean
  isSkillEditorOpen?: boolean
  isEvalDatasetGeneratorOpen?: boolean
  isIndexVisualizerOpen?: boolean
}

export function normalizeCenterTab(raw: unknown, ids: string[]): CenterTab {
  // Ensure the UI can recover from stale tabs (e.g., deleted runs).
  const value = typeof raw === 'string' ? raw : ''
  
  // Direct valid tabs
  if (value === 'builder' || value === 'latest' || value === 'portal') return value
  
  // Tool tabs are valid active tabs and should survive browser refreshes.
  if (
    value === 'qps-tester' ||
    value === 'auto-tuning' ||
    value === 'search-pipeline-visualizer' ||
    value === 'vector-optimizer' ||
    value === 'knowledge-source-builder' ||
    value === 'knowledge-base-builder' ||
    value === 'synonym-map-builder' ||
    value === 'index-builder' ||
    value === 'indexing-pipeline-builder' ||
    value === 'skill-pipeline-builder' ||
    value === 'skill-editor' ||
    value === 'eval-dataset-generator' ||
    value === 'index-visualizer'
  ) {
    return value
  }
  
  // Run tabs - validate run still exists
  if (value.startsWith('run:')) {
    const runId = value.slice(4)
    if (ids.includes(runId)) return value as CenterTab
    return ids.length > 0 ? (`run:${ids[0]}` as CenterTab) : 'builder'
  }
  
  return ids.length > 0 ? (`run:${ids[0]}` as CenterTab) : 'builder'
}

/**
 * Loads persisted tab state for an experiment.
 *
 * Validates and normalizes the stored payload so the UI can recover from stale
 * state (e.g., runs deleted since last session).
 */
export function loadPersistedTabs(experimentId: string): PersistedTabs | null {
  // Tabs are persisted per experiment so users can resume where they left off.
  try {
    const raw = localStorage.getItem(`tabs:${experimentId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedTabs>
    const ids = Array.isArray(parsed.selectedRunIds)
      ? parsed.selectedRunIds
        .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
        .slice(0, MAX_PERSISTED_RUN_IDS)
      : []
    const uniqueIds = Array.from(new Set(ids))
    const latestRunId = typeof parsed.latestRunId === 'string' && parsed.latestRunId.trim().length > 0 ? parsed.latestRunId : undefined
    return {
      selectedRunIds: uniqueIds,
      centerTab: normalizeCenterTab(parsed.centerTab, uniqueIds),
      latestRunId,
      isQpsTesterOpen: parsed.isQpsTesterOpen ?? false,
      isAutoTuningOpen: parsed.isAutoTuningOpen ?? false,
      isSearchPipelineVisualizerOpen: parsed.isSearchPipelineVisualizerOpen ?? false,
      isKnowledgeSourceBuilderOpen: parsed.isKnowledgeSourceBuilderOpen ?? false,
      isKnowledgeBaseBuilderOpen: parsed.isKnowledgeBaseBuilderOpen ?? false,
      isSynonymMapBuilderOpen: parsed.isSynonymMapBuilderOpen ?? false,
      isIndexBuilderOpen: parsed.isIndexBuilderOpen ?? false,
      isIndexingPipelineBuilderOpen: parsed.isIndexingPipelineBuilderOpen ?? false,
      isSkillPipelineBuilderOpen: parsed.isSkillPipelineBuilderOpen ?? false,
      isVectorOptimizerOpen: parsed.isVectorOptimizerOpen ?? false,
      isSkillEditorOpen: parsed.isSkillEditorOpen ?? false,
      isEvalDatasetGeneratorOpen: parsed.isEvalDatasetGeneratorOpen ?? false,
      isIndexVisualizerOpen: parsed.isIndexVisualizerOpen ?? false,
    }
  } catch {
    return null
  }
}
