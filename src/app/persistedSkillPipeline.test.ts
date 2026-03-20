// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'

import { getSkillPipeline, listSkillPipelines, upsertSkillPipeline } from './persistedSkillPipeline'

describe('app/persistedSkillPipeline', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('persists skill editor drafts with the skill pipeline item', () => {
    upsertSkillPipeline({
      id: 'pipeline-1',
      title: 'skillset1',
      updatedAt: 0,
      state: {
        skillsetName: 'skillset1',
        skillsetDescription: '',
        nodes: [],
        edges: [],
        skillEditorDrafts: {
          nodeA: {
            skillCode: 'def process(input: dict) -> dict:\n    return {"result": "ok"}',
            testInput: '{"values":[{"recordId":"1","data":{"text":"hello"}}]}',
            runtimeUrl: 'https://skill-runtime.example.com',
            deploySkillName: 'customwebapi1',
            deployStorageAccountUrl: 'https://examplestorage.blob.core.windows.net',
            deployStorageContainer: 'skills',
          },
        },
      },
    })

    const loaded = getSkillPipeline('pipeline-1')
    expect(loaded).not.toBeNull()
    expect(loaded!.state.skillEditorDrafts).toEqual({
      nodeA: {
        skillCode: 'def process(input: dict) -> dict:\n    return {"result": "ok"}',
        testInput: '{"values":[{"recordId":"1","data":{"text":"hello"}}]}',
        runtimeUrl: 'https://skill-runtime.example.com',
        deploySkillName: 'customwebapi1',
        deployStorageAccountUrl: 'https://examplestorage.blob.core.windows.net',
        deployStorageContainer: 'skills',
      },
    })
  })

  it('lists the newest saved pipeline first while preserving drafts', () => {
    upsertSkillPipeline({
      id: 'older',
      title: 'older',
      updatedAt: 1,
      state: {
        skillsetName: 'older',
        skillsetDescription: '',
        nodes: [],
        edges: [],
      },
    })

    upsertSkillPipeline({
      id: 'newer',
      title: 'newer',
      updatedAt: 1,
      state: {
        skillsetName: 'newer',
        skillsetDescription: '',
        nodes: [],
        edges: [],
        skillEditorDrafts: {
          nodeB: {
            skillCode: 'print(1)',
            testInput: '{}',
          },
        },
      },
    })

    const items = listSkillPipelines()
    expect(items[0].id).toBe('newer')
    expect(items[0].state.skillEditorDrafts?.nodeB?.skillCode).toBe('print(1)')
  })
})