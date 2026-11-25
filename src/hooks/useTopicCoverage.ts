import { useCallback, useEffect, useRef, useState } from 'react'
import { KNOWLEDGE_GRAPH_API_VERSION } from '../lib/knowledgeGraph'
import type { ConnectionProfile } from '../lib/model'
import type { LeafAssignment, TopicHierarchy } from '../lib/topicGraphCoverage'
import {
  findNearestLeafTopics, loadChunkVectors, loadTopicHierarchy, resolveTopicGraphBinding, TopicGraphReadError,
  type TopicGraphBinding, type TopicGraphReadErrorCode,
} from '../lib/topicGraphReader'
import type { Language } from '../lib/translations'

export type TopicCoverageState =
  | { status: 'idle' }
  | { status: 'loading'; sourceName: string }
  | { status: 'error'; sourceName: string; code: TopicGraphReadErrorCode | 'unexpected'; detail: string }
  | {
      status: 'ready'
      sourceName: string
      binding: TopicGraphBinding
      hierarchy: TopicHierarchy
      /** Leaf topic of every chunk whose vector was read, by chunk key. */
      assignments: ReadonlyMap<string, LeafAssignment>
      refreshing: boolean
    }

const IDLE: TopicCoverageState = { status: 'idle' }

type Loaded = {
  scope: string
  binding: TopicGraphBinding
  hierarchy: TopicHierarchy
  assignments: Map<string, LeafAssignment>
  requested: Set<string>
}

export function canReadTopicGraph(profile: ConnectionProfile | null | undefined): boolean {
  return !!profile?.endpoint.trim() && profile.apiVersion === KNOWLEDGE_GRAPH_API_VERSION
}

/**
 * Loads the topic hierarchy behind a knowledge source and places result chunks into its leaf topics.
 * The hierarchy is read once per source; later calls only read the vectors of chunks that were not requested yet.
 */
export function useTopicCoverage(profile: ConnectionProfile | null | undefined, language: Language) {
  const endpoint = profile?.endpoint
  const [stored, setStored] = useState<{ endpoint: string | undefined; state: TopicCoverageState }>({ endpoint, state: IDLE })
  // Discard the previous state even if the user later returns to that endpoint.
  if (stored.endpoint !== endpoint) setStored({ endpoint, state: IDLE })
  const state = stored.endpoint === endpoint ? stored.state : IDLE
  const loadedRef = useRef<Loaded | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => () => controllerRef.current?.abort(), [])
  useEffect(() => {
    controllerRef.current?.abort()
    loadedRef.current = null
  }, [endpoint])

  const analyze = useCallback(async (sourceName: string, keys: readonly string[], options: { reload?: boolean } = {}) => {
    if (!profile || !canReadTopicGraph(profile) || !sourceName) return
    const setState = (next: TopicCoverageState) => setStored({ endpoint: profile.endpoint, state: next })
    const scope = `${profile.endpoint}|${sourceName}`
    if (options.reload || loadedRef.current?.scope !== scope) loadedRef.current = null
    const current = loadedRef.current
    if (current && keys.every((key) => current.requested.has(key))) return

    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    const connection = { profile, language, signal: controller.signal }
    try {
      let loaded = current
      if (!loaded) {
        setState({ status: 'loading', sourceName })
        const binding = await resolveTopicGraphBinding(connection, sourceName)
        const hierarchy = await loadTopicHierarchy(connection, binding)
        loaded = { scope, binding, hierarchy, assignments: new Map(), requested: new Set() }
      } else {
        setState({ ...readyState(loaded, sourceName), refreshing: true })
      }
      const missing = keys.filter((key) => !loaded.requested.has(key))
      const vectors = await loadChunkVectors(connection, loaded.binding, missing)
      const nearest = await findNearestLeafTopics(connection, loaded.binding, vectors)
      controller.signal.throwIfAborted()
      for (const key of missing) loaded.requested.add(key)
      for (const [key, assignment] of nearest) {
        if (loaded.hierarchy.topics.get(assignment.leafId)?.children.length === 0) loaded.assignments.set(key, assignment)
      }
      loadedRef.current = loaded
      setState(readyState(loaded, sourceName))
    } catch (error) {
      if (controller.signal.aborted) return
      loadedRef.current = null
      setState(error instanceof TopicGraphReadError
        ? { status: 'error', sourceName, code: error.code, detail: error.detail }
        : { status: 'error', sourceName, code: 'unexpected', detail: error instanceof Error ? error.message : String(error) })
    }
  }, [profile, language])

  const reset = useCallback(() => {
    controllerRef.current?.abort()
    loadedRef.current = null
    setStored({ endpoint, state: IDLE })
  }, [endpoint])

  return { state, analyze, reset }
}

function readyState(loaded: Loaded, sourceName: string): Extract<TopicCoverageState, { status: 'ready' }> {
  return {
    status: 'ready',
    sourceName,
    binding: loaded.binding,
    hierarchy: loaded.hierarchy,
    assignments: new Map(loaded.assignments),
    refreshing: false,
  }
}
