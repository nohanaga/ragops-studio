// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CenterTab } from '../types'
import { useExperimentTabRestore } from './useExperimentTabRestore'

function createParams(centerTab: CenterTab) {
  return {
    selectedExperimentId: 'exp1',
    centerTab,
    reloadRuns: vi.fn(async () => undefined),
    setSelectedRun: vi.fn(),
    setSelectedRunIds: vi.fn(),
    setCenterTab: vi.fn(),
    setIsQpsTesterOpen: vi.fn(),
    setIsAutoTuningOpen: vi.fn(),
    setIsSearchPipelineVisualizerOpen: vi.fn(),
    setIsKnowledgeSourceBuilderOpen: vi.fn(),
    setIsKnowledgeBaseBuilderOpen: vi.fn(),
    setIsSynonymMapBuilderOpen: vi.fn(),
    setIsIndexBuilderOpen: vi.fn(),
    setIsIndexingPipelineBuilderOpen: vi.fn(),
    setIsSkillPipelineBuilderOpen: vi.fn(),
    setIsVectorOptimizerOpen: vi.fn(),
    setIsSkillEditorOpen: vi.fn(),
    setIsEvalDatasetGeneratorOpen: vi.fn(),
    setIsIndexVisualizerOpen: vi.fn(),
  }
}

describe('hooks/useExperimentTabRestore', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('restores a persisted tool tab on initial boot', () => {
    localStorage.setItem(
      'tabs:exp1',
      JSON.stringify({
        selectedRunIds: [],
        centerTab: 'index-builder',
        isIndexBuilderOpen: true,
      }),
    )
    const params = createParams('portal')

    renderHook(() => useExperimentTabRestore(params))

    expect(params.setCenterTab).toHaveBeenCalledWith('index-builder')
    expect(params.setIsIndexBuilderOpen).toHaveBeenCalledWith(true)
  })
})