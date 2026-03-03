import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { ConnectionProfile } from '../lib/model'
import type { AgenticFormState, KnowledgeSourceInfo, LabMode } from '../types'
import type { Language } from '../lib/translations'
import { translations } from '../lib/translations'
import { getKnowledgeBase, listKnowledgeBases } from '../lib/aiSearchRest'

export function useKnowledgeBaseData(params: {
  labMode: LabMode
  activeProfile: ConnectionProfile | null
  knowledgeBaseName: string
  language: Language
  setAgenticForm: Dispatch<SetStateAction<AgenticFormState>>
}) {
  const { labMode, activeProfile, knowledgeBaseName, language, setAgenticForm } = params

  const [availableKnowledgeBaseNames, setAvailableKnowledgeBaseNames] = useState<string[]>([])
  const [knowledgeBaseNamesLoading, setKnowledgeBaseNamesLoading] = useState(false)
  const [knowledgeBaseNamesError, setKnowledgeBaseNamesError] = useState<string | null>(null)
  const [availableKnowledgeSources, setAvailableKnowledgeSources] = useState<KnowledgeSourceInfo[]>([])

  // Reset knowledgeSourceParams when knowledgeBaseName changes so the
  // fetch-and-init guard (length === 0) works correctly on KB switch.
  // Skip the first render to preserve persisted state.
  const prevKbNameRef = useRef(knowledgeBaseName)
  useEffect(() => {
    if (prevKbNameRef.current !== knowledgeBaseName) {
      prevKbNameRef.current = knowledgeBaseName
      setAvailableKnowledgeSources([])
      setAgenticForm((prev) => ({
        ...prev,
        knowledgeSourceParams: [],
      }))
    }
  }, [knowledgeBaseName, setAgenticForm])

  useEffect(() => {
    if (labMode !== 'agentic' || !knowledgeBaseName.trim() || !activeProfile) {
      return
    }

    const abortController = new AbortController()
    ;(async () => {
      try {
        const result = await getKnowledgeBase({
          profile: activeProfile,
          knowledgeBaseName: knowledgeBaseName.trim(),
          language,
        })

        if (abortController.signal.aborted) return

        if (result.ok && result.response && typeof result.response === 'object') {
          const kb = result.response as { knowledgeSources?: Array<{ name: string; kind?: string }> }
          const sources: KnowledgeSourceInfo[] = Array.isArray(kb.knowledgeSources)
            ? kb.knowledgeSources
                .filter((ks): ks is { name: string; kind?: string } => typeof ks.name === 'string')
                .map((ks) => ({ name: ks.name, kind: typeof ks.kind === 'string' ? ks.kind : 'searchIndex' }))
            : []

          setAvailableKnowledgeSources(sources)

          setAgenticForm((prev) => {
            if (prev.knowledgeSourceParams.length === 0 && sources.length > 0) {
              return {
                ...prev,
                knowledgeSourceParams: sources.map((src) => ({
                  knowledgeSourceName: src.name,
                  kind: src.kind,
                  includeReferences: src.kind === 'searchIndex',
                  includeReferenceSourceData: src.kind === 'searchIndex',
                  alwaysQuerySource: false,
                })),
              }
            }
            return prev
          })
        }
      } catch (e) {
        if (abortController.signal.aborted) return
        console.error('Failed to load knowledge sources:', e)
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [activeProfile, knowledgeBaseName, labMode, language, setAgenticForm])

  useEffect(() => {
    if (labMode !== 'agentic' || !activeProfile) {
      setAvailableKnowledgeBaseNames([])
      setKnowledgeBaseNamesLoading(false)
      setKnowledgeBaseNamesError(null)
      return
    }

    const abortController = new AbortController()
    setKnowledgeBaseNamesLoading(true)
    setKnowledgeBaseNamesError(null)

    ;(async () => {
      try {
        const result = await listKnowledgeBases({ profile: activeProfile, language })
        if (abortController.signal.aborted) return

        if (result.ok && result.response && typeof result.response === 'object') {
          const data = result.response as { value?: Array<{ name?: string }> }
          const names = Array.isArray(data.value)
            ? data.value
                .map((x) => (typeof x?.name === 'string' ? x.name.trim() : ''))
                .filter((s) => s.length > 0)
            : []
          const uniq = Array.from(new Set(names)).sort((a, b) => a.localeCompare(b))
          setAvailableKnowledgeBaseNames(uniq)
        } else {
          setAvailableKnowledgeBaseNames([])
          setKnowledgeBaseNamesError(
            !result.ok
              ? result.error.message
              : String(translations[language].failedToLoad ?? 'Failed to load'),
          )
        }
      } catch (e) {
        if (abortController.signal.aborted) return
        setAvailableKnowledgeBaseNames([])
        setKnowledgeBaseNamesError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!abortController.signal.aborted) setKnowledgeBaseNamesLoading(false)
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [activeProfile, labMode, language])

  const knowledgeBaseNameOptions = useMemo(() => {
    const opts = new Set<string>()
    for (const n of availableKnowledgeBaseNames) opts.add(n)
    if (knowledgeBaseName.trim()) opts.add(knowledgeBaseName.trim())
    return Array.from(opts).sort((a, b) => a.localeCompare(b))
  }, [availableKnowledgeBaseNames, knowledgeBaseName])

  return {
    knowledgeBaseNamesLoading,
    knowledgeBaseNamesError,
    knowledgeBaseNameOptions,
    availableKnowledgeSources,
  }
}
