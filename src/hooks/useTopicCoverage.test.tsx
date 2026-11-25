// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionProfile } from '../lib/model'
import { findNearestLeafTopics, loadChunkVectors, loadTopicHierarchy, resolveTopicGraphBinding, type TopicGraphBinding } from '../lib/topicGraphReader'
import { useTopicCoverage } from './useTopicCoverage'

vi.mock('../lib/topicGraphReader')
afterEach(cleanup)

it('allows a retry after changing endpoints during topic loading and returning', async () => {
  const firstProfile: ConnectionProfile = {
    endpoint: 'https://first.example', apiVersion: '2026-11-01-preview', authType: 'apiKey', apiKey: 'test-key',
  }
  const binding: TopicGraphBinding = {
    sourceName: 'source', contentIndex: 'content', keyField: 'id', vectorField: 'vector',
    profileName: 'profile', topicIndex: 'topics', topicDefinition: {},
  }
  let rejectFirst!: (reason: Error) => void
  const first = new Promise<TopicGraphBinding>((_, reject) => { rejectFirst = reject })
  vi.mocked(resolveTopicGraphBinding).mockReturnValueOnce(first).mockResolvedValueOnce(binding)
  vi.mocked(loadTopicHierarchy).mockResolvedValue({ topics: new Map(), roots: [], leaves: [] })
  vi.mocked(loadChunkVectors).mockResolvedValue(new Map())
  vi.mocked(findNearestLeafTopics).mockResolvedValue(new Map())
  const { result, rerender } = renderHook(({ profile }) => useTopicCoverage(profile, 'en'), {
    initialProps: { profile: firstProfile },
  })

  let pending!: Promise<void>
  act(() => { pending = result.current.analyze('source', ['chunk']) })
  expect(result.current.state.status).toBe('loading')
  const signal = vi.mocked(resolveTopicGraphBinding).mock.calls[0][0].signal

  rerender({ profile: { ...firstProfile, endpoint: 'https://second.example' } })
  expect(signal?.aborted).toBe(true)
  rerender({ profile: firstProfile })
  expect(result.current.state.status).toBe('idle')

  await act(() => result.current.analyze('source', ['chunk']))
  expect(result.current.state).toMatchObject({ status: 'ready', binding })
  await act(async () => {
    rejectFirst(new DOMException('Aborted', 'AbortError'))
    await pending
  })
  expect(result.current.state.status).toBe('ready')
})
