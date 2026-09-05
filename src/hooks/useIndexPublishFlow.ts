/**
 * useIndexPublishFlow – hook encapsulating the Azure index publish flow with diff.
 *
 * The flow mirrors usePublishFlow (for skillsets):
 *   1. Fetch baseline from Azure (GET /indexes/{name})
 *   2. Compare with local candidate via computeIndexDiff (semantic + text diff)
 *   3. Show PublishDiffModal for review
 *   4. PUT to Azure on confirmation
 */

import { useCallback, useMemo, useState } from 'react'
import { diffLines } from 'diff'

import type { ConnectionProfile, SearchApiVersion } from '../lib/model'
import { createOrUpdateIndex, getIndexDefinition, listIndexes } from '../lib/aiSearchRest'
import type { Language } from '../lib/translations'
import { translations } from '../lib/translations'
import { computeIndexDiff } from '../utils/indexDiff'
import type { ResourceDiffResult } from '../utils/skillsetDiff'

type TranslationKey = keyof typeof translations.ja

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function parseJsonOrEmpty(text: string): Record<string, unknown> {
  const s = text.trim()
  if (!s) return {}
  try {
    const v = JSON.parse(s)
    return isRecord(v) ? v : {}
  } catch {
    return {}
  }
}

export interface UseIndexPublishFlowArgs {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion | ''
  language: Language
  t: (key: TranslationKey) => string
}

export interface UseIndexPublishFlowReturn {
  /* state */
  saveDiffOpen: boolean
  publishLoading: boolean
  publishError: string | null
  publishOkMessage: string | null
  diffViewMode: 'semantic' | 'text'
  setDiffViewMode: (mode: 'semantic' | 'text') => void
  publishTargetName: string
  isNewIndex: boolean
  allowIndexDowntime: boolean
  refetchingBaseline: boolean
  existingIndexNames: string[]

  /* computed */
  publishBaselineText: string
  publishCandidateJson: string
  semanticDiff: ResourceDiffResult | null
  normalizedDiffLineSets: { left: Set<number>; right: Set<number> }

  /* actions */
  /** Open the diff dialog. Parses `candidateJson`, fetches baseline, computes diff. */
  onPublishClick: (candidateJson: string) => Promise<void>
  /** Confirm and PUT to Azure. Returns updated definition text on success. */
  publishToAzure: () => Promise<string | null>
  closeDiffDialog: () => void
  clearMessages: () => void
  changeTargetName: (name: string) => void
  setAllowIndexDowntime: (allow: boolean) => void
}

export function useIndexPublishFlow({ profile, apiVersion, language, t }: UseIndexPublishFlowArgs): UseIndexPublishFlowReturn {
  const [saveDiffOpen, setSaveDiffOpen] = useState(false)
  const [publishBeforeJson, setPublishBeforeJson] = useState('')
  const [publishCandidateText, setPublishCandidateText] = useState('')
  const [publishLoading, setPublishLoading] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishOkMessage, setPublishOkMessage] = useState<string | null>(null)
  const [diffViewMode, setDiffViewMode] = useState<'semantic' | 'text'>('semantic')
  const [publishTargetName, setPublishTargetName] = useState('')
  const [isNewIndex, setIsNewIndex] = useState(false)
  const [allowIndexDowntime, setAllowIndexDowntime] = useState(false)
  const [refetchingBaseline, setRefetchingBaseline] = useState(false)
  const [existingIndexNames, setExistingIndexNames] = useState<string[]>([])

  const publishBaselineText = publishBeforeJson

  const publishCandidateObject = useMemo<Record<string, unknown> | null>(() => {
    const s = publishCandidateText.trim()
    if (!s) return null
    try {
      const v = JSON.parse(s)
      return isRecord(v) ? v : null
    } catch {
      return null
    }
  }, [publishCandidateText])

  const publishCandidateJson = publishCandidateText

  // ── Semantic diff ────────────────────────────────────────────────────
  const semanticDiff = useMemo<ResourceDiffResult | null>(() => {
    if (!saveDiffOpen) return null
    try {
      const beforeObj = parseJsonOrEmpty(publishBaselineText)
      return computeIndexDiff(beforeObj, publishCandidateObject ?? {})
    } catch {
      return null
    }
  }, [saveDiffOpen, publishBaselineText, publishCandidateObject])

  const normalizedDiffLineSets = useMemo(() => {
    if (!semanticDiff) return { left: new Set<number>(), right: new Set<number>() }
    const parts = diffLines(semanticDiff.normalizedBeforeJson, semanticDiff.normalizedAfterJson)
    const left = new Set<number>()
    const right = new Set<number>()
    let l = 1, r = 1
    const countLines = (text: string) => {
      if (!text) return 0
      const lines = text.split('\n')
      return lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
    }
    for (const p of parts) {
      const c = countLines(p.value)
      if (!c) continue
      if ((p as any).added) { for (let i = 0; i < c; i++) right.add(r + i); r += c; continue }
      if ((p as any).removed) { for (let i = 0; i < c; i++) left.add(l + i); l += c; continue }
      l += c; r += c
    }
    return { left, right }
  }, [semanticDiff])

  // ── Actions ──────────────────────────────────────────────────────────
  const onPublishClick = useCallback(async (candidateJson: string) => {
    if (!profile || !apiVersion.trim()) {
      setPublishError(t('indexBuilderMissingProfileOrApiVersion'))
      return
    }

    // Parse candidate to extract name
    let candidateObj: Record<string, unknown>
    try {
      const parsed = JSON.parse(candidateJson)
      if (!isRecord(parsed)) {
        setPublishError(t('indexBuilderJsonMustBeObject'))
        return
      }
      candidateObj = parsed
    } catch {
      setPublishError(t('indexBuilderJsonEmptyError'))
      return
    }

    const name = typeof candidateObj.name === 'string' ? candidateObj.name.trim() : ''
    if (!name) {
      setPublishError(t('indexBuilderJsonNameRequired'))
      return
    }

    setPublishTargetName(name)
    setAllowIndexDowntime(false)
    setPublishCandidateText(candidateJson)
    setPublishOkMessage(null)
    setPublishError(null)
    setPublishLoading(true)

    try {
      const [res, listRes] = await Promise.all([
        getIndexDefinition({ profile, indexName: name, apiVersion: apiVersion as any, language }),
        listIndexes({ profile, apiVersion: apiVersion as any, language }),
      ])

      if (listRes.ok) {
        const value = (listRes.response as any)?.value
        const names = Array.isArray(value)
          ? value
              .map((x: any) => (x && typeof x.name === 'string' ? x.name : null))
              .filter((x: any): x is string => typeof x === 'string')
          : []
        setExistingIndexNames(names)
      }

      if (res.ok) {
        const obj = res.response as any
        const { ['@odata.etag']: _etag, ...rest } = obj && typeof obj === 'object' ? obj : {} as any
        setPublishBeforeJson(JSON.stringify(rest, null, 2))
        setIsNewIndex(false)
      } else if (res.status === 404) {
        setPublishBeforeJson('')
        setIsNewIndex(true)
      } else {
        setPublishError(res.error.message)
        return
      }

      setSaveDiffOpen(true)
      setDiffViewMode('semantic')
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e))
    } finally {
      setPublishLoading(false)
    }
  }, [profile, apiVersion, language, t])

  const publishToAzure = useCallback(async (): Promise<string | null> => {
    if (!profile || !apiVersion.trim()) {
      setPublishError(t('indexBuilderMissingProfileOrApiVersion'))
      return null
    }

    const name = publishTargetName.trim()
    if (!name) {
      setPublishError(t('indexBuilderJsonNameRequired'))
      return null
    }

    setPublishOkMessage(null)
    setPublishError(null)
    setPublishLoading(true)

    try {
      const body = publishCandidateObject ? { ...publishCandidateObject, name } : null
      if (!body) {
        setPublishError(t('indexBuilderJsonEmptyError'))
        return null
      }

      const put = await createOrUpdateIndex({
        profile,
        indexName: name,
        apiVersion: apiVersion as any,
        body: body as any,
        allowIndexDowntime: !isNewIndex && allowIndexDowntime,
        language,
      })

      if (!put.ok) {
        setPublishError(put.error.message)
        return null
      }

      setPublishOkMessage(t('indexBuilderSaved').replace('{name}', name).replace('{status}', String(put.status)))
      const updatedText = JSON.stringify(body, null, 2)
      setPublishBeforeJson(updatedText)
      setSaveDiffOpen(false)
      return updatedText
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setPublishLoading(false)
    }
  }, [profile, publishTargetName, apiVersion, language, publishCandidateObject, isNewIndex, allowIndexDowntime, t])

  const changeTargetName = useCallback((newName: string) => {
    setPublishTargetName(newName)
    setAllowIndexDowntime(false)
    if (!profile || !newName.trim() || !apiVersion.trim()) return

    setRefetchingBaseline(true)
    setPublishError(null)
    getIndexDefinition({ profile, indexName: newName.trim(), apiVersion: apiVersion as any, language })
      .then((res) => {
        if (res.ok) {
          const obj = res.response as any
          const { ['@odata.etag']: _etag, ...rest } = obj && typeof obj === 'object' ? obj : {} as any
          setPublishBeforeJson(JSON.stringify(rest, null, 2))
          setIsNewIndex(false)
        } else if (res.status === 404) {
          setPublishBeforeJson('')
          setIsNewIndex(true)
        } else {
          setPublishError(res.error.message)
        }
      })
      .catch((e) => setPublishError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRefetchingBaseline(false))
  }, [profile, apiVersion, language])

  const closeDiffDialog = useCallback(() => { setSaveDiffOpen(false) }, [])
  const clearMessages = useCallback(() => { setPublishError(null); setPublishOkMessage(null) }, [])

  return {
    saveDiffOpen,
    publishLoading,
    publishError,
    publishOkMessage,
    diffViewMode,
    setDiffViewMode,
    publishTargetName,
    isNewIndex,
    allowIndexDowntime,
    refetchingBaseline,
    existingIndexNames,
    publishBaselineText,
    publishCandidateJson,
    semanticDiff,
    normalizedDiffLineSets,
    onPublishClick,
    publishToAzure,
    closeDiffDialog,
    clearMessages,
    changeTargetName,
    setAllowIndexDowntime,
  }
}
