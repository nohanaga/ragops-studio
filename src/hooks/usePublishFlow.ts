/**
 * usePublishFlow - shared hook encapsulating the Azure publish flow.
 *
 * The flow is:
 *   1. Fetch baseline from Azure (GET /skillsets/{name})
 *   2. Compare with local candidate (semantic + text diff)
 *   3. Show diff confirmation dialog
 *   4. PUT to Azure
 *
 * This hook is used by both the center-pane toolbar and the right-pane buttons
 * to avoid duplicating the publish machinery.
 */

import { useCallback, useMemo, useState } from 'react'
import { diffLines } from 'diff'

import type { ConnectionProfile, SearchApiVersion } from '../lib/model'
import { createOrUpdateSkillset, getSkillset } from '../lib/aiSearchRest'
import { useSkillPipelineState } from '../contexts'
import type { Language } from '../lib/translations'
import { translations } from '../lib/translations'
import { computeSkillsetDiff, type SkillsetDiffResult } from '../utils/skillsetDiff'

type TranslationKey = keyof typeof translations.ja

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function ensureJsonObject(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {}
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

function stripServiceMeta(obj: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k === '@odata.etag') continue
    next[k] = v
  }
  return next
}

export interface UsePublishFlowArgs {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
  language: Language
  t: (key: TranslationKey) => string
}

export interface UsePublishFlowReturn {
  /* state */
  saveDiffOpen: boolean
  publishLoading: boolean
  publishError: string | null
  publishOkMessage: string | null
  diffViewMode: 'semantic' | 'text'
  setDiffViewMode: (mode: 'semantic' | 'text') => void

  /* computed */
  publishBaselineText: string
  publishCandidateJson: string
  publishCandidateObject: Record<string, unknown> | null
  semanticDiff: SkillsetDiffResult | null
  normalizedDiffLineSets: { left: Set<number>; right: Set<number> }

  /* actions */
  /** Start the publish flow: fetch baseline & open diff dialog. */
  onPublishClick: () => Promise<void>
  /** Confirm and PUT to Azure. */
  publishToAzure: () => Promise<void>
  /** Close the diff dialog. */
  closeDiffDialog: () => void
  /** Dismiss error / ok message. */
  clearMessages: () => void
}

export function usePublishFlow({ profile, apiVersion, language, t }: UsePublishFlowArgs): UsePublishFlowReturn {
  const {
    skillsetName,
    skillsetDescription,
    indexProjections,
    knowledgeStore,
    nodes,
    selectedNodeId,
    draftSkillJson,
    draftError,
    baselineSkillsetJson,
    setBaselineSkillsetJson,
  } = useSkillPipelineState()

  // ── Local state for the publish flow ─────────────────────────────────
  const [saveDiffOpen, setSaveDiffOpen] = useState(false)
  const [publishBeforeJson, setPublishBeforeJson] = useState<string | null>(null)
  const [publishLoading, setPublishLoading] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)
  const [publishOkMessage, setPublishOkMessage] = useState<string | null>(null)
  const [diffViewMode, setDiffViewMode] = useState<'semantic' | 'text'>('semantic')

  // ── Computed baseline & candidate ────────────────────────────────────
  const publishBaselineText = useMemo(() => {
    return publishBeforeJson !== null ? publishBeforeJson : baselineSkillsetJson
  }, [baselineSkillsetJson, publishBeforeJson])

  const publishCandidateObject = useMemo(() => {
    const name = skillsetName.trim() || 'skillset1'
    const base = stripServiceMeta(parseJsonOrEmpty(publishBaselineText || ''))

    // Overlay the current draft into skills when it is valid.
    let draftOverlay: Record<string, unknown> | null = null
    if (!draftError && selectedNodeId) {
      const raw = draftSkillJson.trim()
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (isRecord(parsed)) draftOverlay = parsed
        } catch {
          // ignore; fall back to node data
        }
      }
    }

    const skillNodes = nodes.filter((n) => (n as any)?.data?.kind === 'skill')
    const skills = skillNodes.map((n) => {
      if (draftOverlay && n.id === selectedNodeId) return draftOverlay
      return ensureJsonObject((n as any).data?.skill)
    })

    const nextBody: Record<string, unknown> = {
      ...base,
      name,
      skills,
    }

    const desc = skillsetDescription.trim()
    if (desc) nextBody.description = desc
    else delete nextBody.description

    if (indexProjections) nextBody.indexProjections = indexProjections
    else delete nextBody.indexProjections

    if (knowledgeStore) nextBody.knowledgeStore = knowledgeStore
    else delete nextBody.knowledgeStore

    return nextBody
  }, [draftError, draftSkillJson, indexProjections, knowledgeStore, nodes, publishBaselineText, selectedNodeId, skillsetDescription, skillsetName])

  const publishCandidateJson = useMemo(
    () => JSON.stringify(publishCandidateObject, null, 2),
    [publishCandidateObject],
  )

  // ── Semantic diff (computed only when dialog is open) ────────────────
  const semanticDiff = useMemo<SkillsetDiffResult | null>(() => {
    if (!saveDiffOpen) return null
    try {
      const beforeObj: Record<string, unknown> = publishBaselineText
        ? JSON.parse(publishBaselineText)
        : {}
      return computeSkillsetDiff(beforeObj, publishCandidateObject ?? {})
    } catch {
      return null
    }
  }, [saveDiffOpen, publishBaselineText, publishCandidateObject])

  const normalizedDiffLineSets = useMemo(() => {
    if (!semanticDiff) return { left: new Set<number>(), right: new Set<number>() }
    const a = semanticDiff.normalizedBeforeJson
    const b = semanticDiff.normalizedAfterJson
    const parts = diffLines(a, b)
    const left = new Set<number>()
    const right = new Set<number>()
    let l = 1, r = 1
    const countLines = (text: string) => {
      if (!text) return 0
      const lines = text.split('\n')
      if (lines.length && lines[lines.length - 1] === '') return lines.length - 1
      return lines.length
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
  const onPublishClick = useCallback(async () => {
    if (!profile) {
      setPublishError(
        String((translations as any)[language]?.restErrorProfileUnset ?? t('spbRightPaneErrProfileNotSet')),
      )
      return
    }

    const name = skillsetName.trim() || 'skillset1'
    setPublishOkMessage(null)
    setPublishError(null)
    setPublishLoading(true)

    try {
      const res = await getSkillset({ profile, skillsetName: name, apiVersion, language })
      if (res.ok) {
        const obj = res.response as any
        const { ['@odata.etag']: _etag, ...rest } = obj && typeof obj === 'object' ? obj : ({} as any)
        setPublishBeforeJson(JSON.stringify(rest, null, 2))
      } else {
        if (res.status === 404) {
          setPublishBeforeJson('')
        } else {
          setPublishError(res.error.message)
          return
        }
      }

      setSaveDiffOpen(true)
      setDiffViewMode('semantic')
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e))
    } finally {
      setPublishLoading(false)
    }
  }, [profile, skillsetName, apiVersion, language, t])

  const publishToAzure = useCallback(async () => {
    if (!profile) {
      setPublishError(
        String((translations as any)[language]?.restErrorProfileUnset ?? t('spbRightPaneErrProfileNotSet')),
      )
      return
    }

    const name = skillsetName.trim() || 'skillset1'
    setPublishOkMessage(null)
    setPublishError(null)
    setPublishLoading(true)

    try {
      const put = await createOrUpdateSkillset({
        profile,
        skillsetName: name,
        apiVersion,
        language,
        body: publishCandidateObject as any,
      })
      if (!put.ok) {
        setPublishError(put.error.message)
        return
      }

      setPublishOkMessage(t('spbPublishOk'))
      setPublishBeforeJson(JSON.stringify(publishCandidateObject, null, 2))
      setBaselineSkillsetJson(JSON.stringify(publishCandidateObject, null, 2))
      setSaveDiffOpen(false)
    } catch (e) {
      setPublishError(e instanceof Error ? e.message : String(e))
    } finally {
      setPublishLoading(false)
    }
  }, [profile, skillsetName, apiVersion, language, publishCandidateObject, setBaselineSkillsetJson, t])

  const closeDiffDialog = useCallback(() => {
    setSaveDiffOpen(false)
  }, [])

  const clearMessages = useCallback(() => {
    setPublishError(null)
    setPublishOkMessage(null)
  }, [])

  return {
    saveDiffOpen,
    publishLoading,
    publishError,
    publishOkMessage,
    diffViewMode,
    setDiffViewMode,
    publishBaselineText,
    publishCandidateJson,
    publishCandidateObject,
    semanticDiff,
    normalizedDiffLineSets,
    onPublishClick,
    publishToAzure,
    closeDiffDialog,
    clearMessages,
  }
}
