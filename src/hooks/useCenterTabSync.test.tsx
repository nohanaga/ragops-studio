// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useCenterTabSync } from './useCenterTabSync'

function createParams(centerTab: Parameters<typeof useCenterTabSync>[0]['centerTab']) {
  return {
    centerTab,
    selectedRunIds: [],
    latestResponse: null,
    setCenterTab: vi.fn(),
    setIsQpsTesterOpen: vi.fn(),
    setIsAutoTuningOpen: vi.fn(),
    setIsSearchPipelineVisualizerOpen: vi.fn(),
    setIsKnowledgeSourceBuilderOpen: vi.fn(),
    setIsKnowledgeBaseBuilderOpen: vi.fn(),
    setIsSynonymMapBuilderOpen: vi.fn(),
    setIsIndexBuilderOpen: vi.fn(),
    setIsSkillPipelineBuilderOpen: vi.fn(),
    setIsVectorOptimizerOpen: vi.fn(),
    setIsEvalDatasetGeneratorOpen: vi.fn(),
    setIsIndexVisualizerOpen: vi.fn(),
  }
}

describe('hooks/useCenterTabSync', () => {
  it('opens index visualizer when centerTab is index-visualizer', () => {
    const params = createParams('index-visualizer')

    renderHook(() => useCenterTabSync(params))

    expect(params.setIsIndexVisualizerOpen).toHaveBeenCalledWith(true)
  })

  it('opens eval dataset generator when centerTab is eval-dataset-generator', () => {
    const params = createParams('eval-dataset-generator')

    renderHook(() => useCenterTabSync(params))

    expect(params.setIsEvalDatasetGeneratorOpen).toHaveBeenCalledWith(true)
    expect(params.setIsIndexVisualizerOpen).not.toHaveBeenCalled()
  })
})