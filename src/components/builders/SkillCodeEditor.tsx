/**
 * Custom Skill Code Editor.
 *
 * Provides a Python code editor, test data editor, validation, and
 * Cloud Runtime execution for Azure AI Search Custom Skills.
 *
 * Three tabs:
 *   1. Skill Code  — Python editor with syntax highlighting
 *   2. Test        — Custom Skill Interface input/output with validation
 *   3. Settings    — Runtime URL, API key, health check
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'

import CodeMirror from '@uiw/react-codemirror'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { EditorView, Decoration, ViewPlugin } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { diffLines } from 'diff'

import type { Language, TranslationKey } from '../../lib/translations'
import { translations } from '../../lib/translations'
import type { ThemePreference } from '../../types/app'
import { useModalState, useSkillPipelineState } from '../../contexts'
import {
  validateRequest,
  validateResponse,
  extractRecordIds,
  type ValidationResult,
} from '../../lib/skillValidator'
import { buildSkillEditorSampleCode, buildSkillEditorSampleRequest } from '../../lib/skillEditorSamples'
import {
  executeRemoteSkill,
  checkHealth,
  uploadSkillCode,
  downloadSkillCode,
  resolveRuntimeExecuteUrl,
  type SkillRuntimeConfig,
  type SimulateResponse,
} from '../../lib/skillRuntime'
import { runSkillLocally, isPyodideReady } from '../../lib/pyodideRunner'
import { computeCodeHash } from '../../utils/codeHash'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type SkillCodeEditorProps = {
  language: Language
  theme: ThemePreference
  onReturnToSkillPipelineBuilder?: () => void
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type EditorTab = 'code' | 'test' | 'settings'

const CUSTOM_WEB_API_SKILL_ODATA_TYPE = '#Microsoft.Skills.Custom.WebApiSkill'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SkillCodeEditor({ language, theme, onReturnToSkillPipelineBuilder: _onReturnToSkillPipelineBuilder }: SkillCodeEditorProps) {
  const t = useCallback(
    (key: TranslationKey) => translations[language]?.[key] ?? key,
    [language],
  )
  const { skillEditorLinkedNodeId } = useModalState()
  const {
    nodes,
    skillsetName,
    skillEditorDrafts,
    upsertSkillEditorDraft,
    updateSkillNode,
  } = useSkillPipelineState()

  // Only use skillsetName when the editor is linked to a Pipeline node
  const effectiveSkillsetName = skillEditorLinkedNodeId ? skillsetName : undefined

  const fallbackSampleCode = useMemo(() => t('sceSampleCode').replace(/\\n/g, '\n'), [t])

  const linkedSkill = useMemo(() => {
    if (!skillEditorLinkedNodeId) return null
    const node = nodes.find((candidate) => candidate.id === skillEditorLinkedNodeId) ?? null
    if (!node || node.data.kind !== 'skill') return null

    const skill = node.data.skill
    const odataType = typeof skill?.['@odata.type'] === 'string' ? String(skill['@odata.type']).trim() : ''
    if (odataType !== CUSTOM_WEB_API_SKILL_ODATA_TYPE) return null

    return skill
  }, [nodes, skillEditorLinkedNodeId])

  const linkedSkillName = typeof linkedSkill?.name === 'string' ? linkedSkill.name.trim() : ''
  const linkedSkillUri = typeof linkedSkill?.uri === 'string' ? linkedSkill.uri.trim() : ''
  const linkedSkillInputs = useMemo(
    () => (Array.isArray(linkedSkill?.inputs) ? linkedSkill.inputs : []),
    [linkedSkill],
  )
  const linkedSkillOutputs = useMemo(
    () => (Array.isArray(linkedSkill?.outputs) ? linkedSkill.outputs : []),
    [linkedSkill],
  )

  const generatedSkillCode = useMemo(
    () => buildSkillEditorSampleCode({
      inputs: linkedSkillInputs,
      outputs: linkedSkillOutputs,
      fallbackCode: fallbackSampleCode,
    }),
    [fallbackSampleCode, linkedSkillInputs, linkedSkillOutputs],
  )

  const generatedTestInput = useMemo(
    () => JSON.stringify(buildSkillEditorSampleRequest(linkedSkillInputs), null, 2),
    [linkedSkillInputs],
  )

  const linkedSkillDraft = useMemo(
    () => (skillEditorLinkedNodeId ? skillEditorDrafts[skillEditorLinkedNodeId] ?? null : null),
    [skillEditorDrafts, skillEditorLinkedNodeId],
  )
  const linkedSkillHasDraft = !!(skillEditorLinkedNodeId && linkedSkillDraft)
  const restoredSkillCode = linkedSkillHasDraft
    ? (linkedSkillDraft?.skillCode || fallbackSampleCode)
    : fallbackSampleCode
  const restoredTestInput = linkedSkillHasDraft ? (linkedSkillDraft?.testInput ?? '') : generatedTestInput
  // Use the node's uri as the runtime URL source of truth when available.
  // Fall back to draft's runtimeUrl, then to empty.
  const restoredRuntimeUrl = linkedSkillUri
    || (linkedSkillHasDraft ? (linkedSkillDraft?.runtimeUrl?.trim() || '') : '')
  const restoredDeploySkillName = linkedSkillHasDraft
    ? (linkedSkillDraft?.deploySkillName ?? linkedSkillName ?? 'custom-skill')
    : (linkedSkillName || 'custom-skill')
  const restoredRemoteCodeHash = linkedSkillHasDraft ? (linkedSkillDraft?.remoteCodeHash ?? '') : ''

  const sampleSeed = useMemo(
    () => JSON.stringify({
      linkedNodeId: skillEditorLinkedNodeId ?? '',
      linkedSkillName,
      inputs: linkedSkillInputs.map((input) => ({ name: input?.name ?? '', source: input?.source ?? '' })),
      outputs: linkedSkillOutputs.map((output) => ({ name: output?.name ?? '', targetName: output?.targetName ?? '' })),
    }),
    [linkedSkillInputs, linkedSkillName, linkedSkillOutputs, skillEditorLinkedNodeId],
  )
  const lastSampleSeedRef = useRef<string | null>(null)

  // Theme
  const codeMirrorTheme = useMemo(() => {
    const isLight = theme === 'light' || theme === 'solarized'
    return isLight ? githubLight : githubDark
  }, [theme])

  const pythonExtensions = useMemo(() => [python(), EditorView.lineWrapping], [])
  const jsonExtensions = useMemo(() => [json(), EditorView.lineWrapping], [])

  // Tab state
  const [activeTab, setActiveTab] = useState<EditorTab>('code')

  // Skill code
  const [skillCode, setSkillCode] = useState(() => restoredSkillCode)

  // Test input/output
  const [testInput, setTestInput] = useState(() => restoredTestInput)
  const [testOutput, setTestOutput] = useState('')
  const [requestValidationResults, setRequestValidationResults] = useState<ValidationResult[]>([])
  const [executionValidationResults, setExecutionValidationResults] = useState<ValidationResult[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [executionLogs, setExecutionLogs] = useState('')
  const [executionTimeMs, setExecutionTimeMs] = useState<number | null>(null)

  // Local run state
  const [pyodideStatus, setPyodideStatus] = useState<'idle' | 'loading' | 'ready'>(
    () => isPyodideReady() ? 'ready' : 'idle',
  )

  // ACA deploy state
  const [deploySkillName, setDeploySkillName] = useState(() => restoredDeploySkillName)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadSuccessMessage, setUploadSuccessMessage] = useState('')
  const [uploadedEndpointUrl, setUploadedEndpointUrl] = useState('')

  // Remote load state
  const [isLoadingFromRuntime, setIsLoadingFromRuntime] = useState(false)
  const [loadFromRuntimeMessage, setLoadFromRuntimeMessage] = useState('')
  const [loadFromRuntimeError, setLoadFromRuntimeError] = useState<string | null>(null)

  // Sync status (Content Hash)
  const [localCodeHash, setLocalCodeHash] = useState('')
  const [remoteCodeHash, setRemoteCodeHash] = useState(() => restoredRemoteCodeHash)
  const [codeLoadSource, setCodeLoadSource] = useState<'blob' | 'template' | 'draft' | 'manual-load'>(
    () => linkedSkillHasDraft ? 'draft' : 'template',
  )

  // Diff mode state
  const [diffMode, setDiffMode] = useState(false)
  const [blobCode, setBlobCode] = useState('')
  const [pendingAction, setPendingAction] = useState<'upload' | 'load' | null>(null)
  const diffLeftViewRef = useRef<EditorView | null>(null)

  // Settings
  const [runtimeUrl, setRuntimeUrl] = useState(() => restoredRuntimeUrl)
  const [runtimeApiKey, setRuntimeApiKey] = useState('')
  const [healthStatus, setHealthStatus] = useState<'unknown' | 'ok' | 'error'>('unknown')
  const [runtimeVersion, setRuntimeVersion] = useState('')
  const [isCheckingHealth, setIsCheckingHealth] = useState(false)
  const [isDiffLoading, setIsDiffLoading] = useState(false)

  // ---------------------------------------------------------------------------
  // Connection analysis: check if Python code references WebApiSkill I/O keys
  // ---------------------------------------------------------------------------
  type IoConnectionStatus = { name: string; source?: string; targetName?: string; connected: boolean }

  const ioConnectionStatus = useMemo(() => {
    if (linkedSkillInputs.length === 0 && linkedSkillOutputs.length === 0) return null

    const inputStatuses: IoConnectionStatus[] = linkedSkillInputs
      .filter((i): i is { name: string; source?: string } => typeof i?.name === 'string' && i.name.trim() !== '')
      .map((input) => ({
        name: input.name,
        source: typeof input.source === 'string' ? input.source : undefined,
        connected: skillCode.includes(JSON.stringify(input.name)) || skillCode.includes(`"${input.name}"`) || skillCode.includes(`'${input.name}'`),
      }))

    const outputStatuses: IoConnectionStatus[] = linkedSkillOutputs
      .filter((o): o is { name: string; targetName?: string } => typeof o?.name === 'string' && o.name.trim() !== '')
      .map((output) => ({
        name: output.name,
        targetName: typeof output.targetName === 'string' ? output.targetName : undefined,
        connected: skillCode.includes(JSON.stringify(output.name)) || skillCode.includes(`"${output.name}"`) || skillCode.includes(`'${output.name}'`),
      }))

    return { inputs: inputStatuses, outputs: outputStatuses }
  }, [linkedSkillInputs, linkedSkillOutputs, skillCode])

  const testInputKeyStatus = useMemo(() => {
    if (!ioConnectionStatus) return null
    try {
      const parsed = JSON.parse(testInput)
      const dataKeys = new Set<string>()
      if (Array.isArray(parsed?.values)) {
        for (const v of parsed.values) {
          if (v?.data && typeof v.data === 'object') {
            for (const k of Object.keys(v.data)) dataKeys.add(k)
          }
        }
      }
      return ioConnectionStatus.inputs.map((i) => ({
        name: i.name,
        present: dataKeys.has(i.name),
      }))
    } catch {
      return null
    }
  }, [ioConnectionStatus, testInput])

  const [showConnectionPanel, setShowConnectionPanel] = useState(true)

  // Estimated blob path (mirrors runtime normalization logic)
  const estimatedBlobPath = useMemo(() => {
    const rawName = deploySkillName.trim() || linkedSkillName || 'custom-skill'
    const normalizedSkill = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'custom-skill'
    const ns = effectiveSkillsetName
      ? effectiveSkillsetName.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
      : null
    return ns
      ? `{prefix}/${ns}/${normalizedSkill}/skill_logic.py`
      : `{prefix}/${normalizedSkill}/skill_logic.py`
  }, [deploySkillName, effectiveSkillsetName, linkedSkillName])

  useEffect(() => {
    if (lastSampleSeedRef.current === sampleSeed) return
    lastSampleSeedRef.current = sampleSeed

    setActiveTab('code')
    setSkillCode(restoredSkillCode)
    setTestInput(restoredTestInput)
    setTestOutput('')
    setRequestValidationResults([])
    setExecutionValidationResults([])
    setExecutionLogs('')
    setExecutionTimeMs(null)
    setUploadError(null)
    setUploadSuccessMessage('')
    setRuntimeUrl(restoredRuntimeUrl)
    setDeploySkillName(restoredDeploySkillName)
    setRemoteCodeHash(restoredRemoteCodeHash)
    setCodeLoadSource(linkedSkillHasDraft ? 'draft' : 'template')
    setDiffMode(false)
    setBlobCode('')
  }, [linkedSkillHasDraft, restoredDeploySkillName, restoredRemoteCodeHash, restoredRuntimeUrl, restoredSkillCode, restoredTestInput, sampleSeed])

  // Auto-load deployed skill code from runtime when the editor opens.
  // Always tries Blob first; falls back to template if unavailable.
  useEffect(() => {
    const runtimeUrlToFetch = restoredRuntimeUrl.trim()
    const skillNameToFetch = (restoredDeploySkillName || linkedSkillName || '').trim()
    if (!runtimeUrlToFetch || !skillNameToFetch) return

    let cancelled = false
    setIsLoadingFromRuntime(true)
    setLoadFromRuntimeError(null)
    setLoadFromRuntimeMessage('')

    const config: SkillRuntimeConfig = { runtimeUrl: runtimeUrlToFetch }

    // Health check in parallel with download
    checkHealth(config).then((result) => {
      if (cancelled) return
      setHealthStatus(result.status)
      setRuntimeVersion(result.version ?? '')
    }).catch(() => {
      if (!cancelled) setHealthStatus('error')
    })

    downloadSkillCode(config, skillNameToFetch, effectiveSkillsetName).then(async (result) => {
      if (cancelled) return
      setIsLoadingFromRuntime(false)
      if (result.success && result.skillCode) {
        const downloadedHash = result.codeHash || await computeCodeHash(result.skillCode)
        if (!cancelled && downloadedHash) setRemoteCodeHash(downloadedHash)
        setBlobCode(result.skillCode)

        // If local (draft) code differs from blob, show diff for user to choose
        const currentLocalHash = await computeCodeHash(skillCode)
        if (currentLocalHash && downloadedHash && currentLocalHash !== downloadedHash
            && skillCode !== fallbackSampleCode) {
          // Draft has unsaved edits that differ from blob — let user decide
          if (!cancelled) {
            setCodeLoadSource('blob')
            setPendingAction('load')
            setCurrentHunkIndex(0)
            setDiffMode(true)
          }
        } else {
          // No conflict — silently apply blob code
          setSkillCode(result.skillCode)
          if (!cancelled) setCodeLoadSource('blob')
          setLoadFromRuntimeMessage(t('sceLoadFromRuntimeSuccess'))
          if (skillEditorLinkedNodeId) {
            upsertSkillEditorDraft(skillEditorLinkedNodeId, {
              skillCode: result.skillCode,
              runtimeUrl: runtimeUrlToFetch,
              deploySkillName: skillNameToFetch,
              remoteCodeHash: downloadedHash,
            })
          }
        }
      } else {
        setLoadFromRuntimeError(result.error ?? t('sceLoadFromRuntimeNotFound'))
      }
    })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleSeed])

  useEffect(() => {
    if (!skillEditorLinkedNodeId) return

    upsertSkillEditorDraft(skillEditorLinkedNodeId, {
      skillCode,
      testInput,
      runtimeUrl: runtimeUrl.trim(),
      deploySkillName: deploySkillName.trim(),
    })
  }, [deploySkillName, runtimeUrl, skillCode, skillEditorLinkedNodeId, testInput, upsertSkillEditorDraft])

  // Compute local content hash whenever skill code changes (debounced).
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      computeCodeHash(skillCode).then((hash) => {
        if (!cancelled) setLocalCodeHash(hash)
      })
    }, 300)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [skillCode])

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  // Auto-validate test input JSON as the user types.
  useEffect(() => {
    let parsed: unknown
    try {
      parsed = JSON.parse(testInput)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setRequestValidationResults([{ severity: 'error', message: `JSON parse error: ${msg}` }])
      return
    }
    const results = validateRequest(parsed)
    setRequestValidationResults(results)
  }, [testInput])

  /** Shared logic: parse + validate input, run a callback, handle results. */
  const executeSkill = useCallback(
    async (runner: (parsed: { values: Array<{ recordId: string; data: Record<string, unknown> }> }) => Promise<SimulateResponse>) => {
      let parsedInput: unknown
      try {
        parsedInput = JSON.parse(testInput)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        setExecutionValidationResults([{ severity: 'error', message: `JSON parse error: ${msg}` }])
        return
      }

      const inputErrors = validateRequest(parsedInput)
      if (inputErrors.some((r) => r.severity === 'error')) {
        setExecutionValidationResults(inputErrors)
        return
      }

      setIsRunning(true)
      setExecutionValidationResults([])
      setTestOutput('')
      setExecutionLogs('')
      setExecutionTimeMs(null)

      try {
        const typed = parsedInput as { values: Array<{ recordId: string; data: Record<string, unknown> }> }
        const result: SimulateResponse = await runner(typed)

        if (result.success && result.output) {
          setTestOutput(JSON.stringify(result.output, null, 2))
          const requestIds = extractRecordIds(parsedInput)
          const responseValidation = validateResponse(result.output, { requestRecordIds: requestIds })
          setExecutionValidationResults(responseValidation)
        } else {
          setTestOutput('')
          setExecutionValidationResults([{ severity: 'error', message: result.error ?? 'Unknown error' }])
        }

        setExecutionTimeMs(result.executionTimeMs ?? null)
        setExecutionLogs(result.logs ?? '')
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        setExecutionValidationResults([{ severity: 'error', message: msg }])
      } finally {
        setIsRunning(false)
      }
    },
    [testInput],
  )

  /** Run locally via Pyodide (WebAssembly Python). */
  const handleLocalRun = useCallback(async () => {
    await executeSkill(async (parsed) => {
      if (!isPyodideReady()) {
        setPyodideStatus('loading')
      }
      const result = await runSkillLocally(skillCode, parsed)
      setPyodideStatus(isPyodideReady() ? 'ready' : 'idle')
      return result
    })
  }, [skillCode, executeSkill])

  const handleLocalRunFromCode = useCallback(async () => {
    setActiveTab('test')
    await handleLocalRun()
  }, [handleLocalRun])

  /** Run against the configured remote runtime endpoint. */
  const handleRun = useCallback(async () => {
    if (!runtimeUrl.trim()) {
      setExecutionValidationResults([{ severity: 'error', message: t('sceNoRuntimeUrl') }])
      return
    }
    await executeSkill(async (parsed) => {
      const config: SkillRuntimeConfig = {
        runtimeUrl: runtimeUrl.trim(),
        apiKey: runtimeApiKey.trim() || undefined,
      }
      return executeRemoteSkill(config, parsed, effectiveSkillsetName)
    })
  }, [runtimeUrl, runtimeApiKey, effectiveSkillsetName, executeSkill, t])

  const handleRemoteRunFromCode = useCallback(async () => {
    setActiveTab('test')
    await handleRun()
  }, [handleRun])

  const handlePublishToBlob = useCallback(async () => {
    if (!runtimeUrl.trim()) {
      setUploadSuccessMessage('')
      setUploadedEndpointUrl('')
      setUploadError(t('sceNoRuntimeUrl'))
      return;
    }

    setIsUploading(true)
    setUploadError(null)
    setUploadSuccessMessage('')
    setUploadedEndpointUrl('')

    try {
      const config: SkillRuntimeConfig = {
        runtimeUrl: runtimeUrl.trim(),
        apiKey: runtimeApiKey.trim() || undefined,
      }
      const skillNameToPublish = deploySkillName.trim() || linkedSkillName || 'custom-skill'
      const result = await uploadSkillCode(config, {
        skillName: skillNameToPublish,
        skillCode,
        skillsetName: effectiveSkillsetName,
        metadata: {
          linkedNodeId: skillEditorLinkedNodeId ?? undefined,
          linkedSkillName: linkedSkillName || undefined,
        },
      })

      if (!result.success) {
        setUploadError(t('sceUploadFailed').replace('{error}', result.error ?? 'Unknown error'))
        return
      }

      const executeUrl = resolveRuntimeExecuteUrl(runtimeUrl.trim())
      // Build full Custom Skill endpoint URL including skillset_name if applicable
      let fullEndpointUrl = executeUrl
      if (effectiveSkillsetName) {
        const sep = fullEndpointUrl.includes('?') ? '&' : '?'
        fullEndpointUrl = `${fullEndpointUrl}${sep}skillset_name=${encodeURIComponent(effectiveSkillsetName)}`
      }
      setRuntimeUrl(executeUrl)
      setHealthStatus('unknown')
      setUploadSuccessMessage(result.message ?? t('sceUploadSuccess'))
      setUploadedEndpointUrl(fullEndpointUrl)
      const uploadedHash = result.codeHash || localCodeHash
      if (uploadedHash) setRemoteCodeHash(uploadedHash)
      setBlobCode(skillCode)

      if (skillEditorLinkedNodeId && linkedSkill) {
        updateSkillNode(skillEditorLinkedNodeId, (skill) => ({
          ...skill,
          uri: fullEndpointUrl,
        }))
        upsertSkillEditorDraft(skillEditorLinkedNodeId, {
          skillCode,
          testInput,
          runtimeUrl: executeUrl,
          deploySkillName: skillNameToPublish,
          remoteCodeHash: uploadedHash,
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setUploadError(t('sceUploadFailed').replace('{error}', msg))
    } finally {
      setIsUploading(false)
    }
  }, [deploySkillName, effectiveSkillsetName, linkedSkill, linkedSkillName, localCodeHash, runtimeApiKey, runtimeUrl, skillCode, skillEditorLinkedNodeId, t, testInput, updateSkillNode, upsertSkillEditorDraft])

  const handleLoadFromRuntime = useCallback(async () => {
    const url = runtimeUrl.trim()
    const name = (deploySkillName.trim() || linkedSkillName || '').trim()
    if (!url || !name) return

    setIsLoadingFromRuntime(true)
    setLoadFromRuntimeError(null)
    setLoadFromRuntimeMessage('')

    try {
      const config: SkillRuntimeConfig = { runtimeUrl: url, apiKey: runtimeApiKey.trim() || undefined }
      const result = await downloadSkillCode(config, name, effectiveSkillsetName)
      if (result.success && result.skillCode) {
        setSkillCode(result.skillCode)
        setBlobCode(result.skillCode)
        const downloadedHash = result.codeHash || await computeCodeHash(result.skillCode)
        if (downloadedHash) setRemoteCodeHash(downloadedHash)
        setLoadFromRuntimeMessage(t('sceLoadFromRuntimeSuccess'))
        setCodeLoadSource('manual-load')
        setDiffMode(false)
        if (skillEditorLinkedNodeId) {
          upsertSkillEditorDraft(skillEditorLinkedNodeId, {
            skillCode: result.skillCode,
            runtimeUrl: url,
            deploySkillName: name,
            remoteCodeHash: downloadedHash,
          })
        }
      } else {
        setLoadFromRuntimeError(result.error ?? t('sceLoadFromRuntimeNotFound'))
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setLoadFromRuntimeError(t('sceLoadFromRuntimeFailed').replace('{error}', msg))
    } finally {
      setIsLoadingFromRuntime(false)
    }
  }, [deploySkillName, effectiveSkillsetName, linkedSkillName, runtimeApiKey, runtimeUrl, skillEditorLinkedNodeId, t, upsertSkillEditorDraft])

  const handleHealthCheck = useCallback(async () => {
    if (!runtimeUrl.trim()) return
    setHealthStatus('unknown')
    setIsCheckingHealth(true)

    try {
      const config: SkillRuntimeConfig = {
        runtimeUrl: runtimeUrl.trim(),
        apiKey: runtimeApiKey.trim() || undefined,
      }

      const result = await checkHealth(config)
      setHealthStatus(result.status)
      setRuntimeVersion(result.version ?? '')
    } finally {
      setIsCheckingHealth(false)
    }
  }, [runtimeUrl, runtimeApiKey])

  // ---------------------------------------------------------------------------
  // Diff mode helpers
  // ---------------------------------------------------------------------------

  const diffLineSets = useMemo(() => {
    if (!diffMode || !blobCode) return { left: new Set<number>(), right: new Set<number>() }
    const parts = diffLines(skillCode, blobCode)
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
      if (p.added) { for (let i = 0; i < c; i++) right.add(r + i); r += c; continue }
      if (p.removed) { for (let i = 0; i < c; i++) left.add(l + i); l += c; continue }
      l += c; r += c
    }
    return { left, right }
  }, [diffMode, blobCode, skillCode])

  // Derive hunk start-lines (contiguous groups of changed lines on the left side).
  const diffHunks = useMemo(() => {
    const sorted = [...diffLineSets.left].sort((a, b) => a - b)
    const hunks: number[] = []
    for (const line of sorted) {
      if (hunks.length === 0 || line > hunks[hunks.length - 1] + 1) {
        hunks.push(line)
      } else {
        hunks[hunks.length - 1] = hunks[hunks.length - 1] // keep start
      }
    }
    return hunks
  }, [diffLineSets.left])

  const [currentHunkIndex, setCurrentHunkIndex] = useState(0)

  const makeLineClassExtension = useCallback((lines: Set<number>, className: string) => {
    const deco = Decoration.line({ class: className })
    const build = (view: EditorView) => {
      const b = new RangeSetBuilder<Decoration>()
      const max = view.state.doc.lines
      for (const n of lines) {
        if (n < 1 || n > max) continue
        const line = view.state.doc.line(n)
        b.add(line.from, line.from, deco)
      }
      return b.finish()
    }
    return ViewPlugin.fromClass(
      class {
        decorations: ReturnType<typeof build>
        constructor(view: EditorView) { this.decorations = build(view) }
        update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }) {
          if (update.docChanged || update.viewportChanged) this.decorations = build(update.view)
        }
      },
      { decorations: (v) => v.decorations },
    )
  }, [])

  const handleDiffNavigate = useCallback((direction: 'up' | 'down') => {
    if (diffHunks.length === 0) return
    const next = direction === 'down'
      ? Math.min(currentHunkIndex + 1, diffHunks.length - 1)
      : Math.max(currentHunkIndex - 1, 0)
    setCurrentHunkIndex(next)
    const lineNo = diffHunks[next]
    if (diffLeftViewRef.current && lineNo) {
      const line = diffLeftViewRef.current.state.doc.line(Math.min(lineNo, diffLeftViewRef.current.state.doc.lines))
      diffLeftViewRef.current.dispatch({
        effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 40 }),
      })
    }
  }, [currentHunkIndex, diffHunks])

  // Fetch latest blob code and enter diff mode. Returns true if diff mode was entered.
  const enterDiffMode = useCallback(async (): Promise<boolean> => {
    let latestBlob = blobCode
    if (!latestBlob) {
      const url = runtimeUrl.trim()
      const name = (deploySkillName.trim() || linkedSkillName || '').trim()
      if (!url || !name) return false
      setIsDiffLoading(true)
      try {
        const config: SkillRuntimeConfig = { runtimeUrl: url, apiKey: runtimeApiKey.trim() || undefined }
        const result = await downloadSkillCode(config, name, effectiveSkillsetName)
        if (result.success && result.skillCode) {
          latestBlob = result.skillCode
          setBlobCode(result.skillCode)
        } else {
          return false
        }
      } finally {
        setIsDiffLoading(false)
      }
    }
    setCurrentHunkIndex(0)
    setDiffMode(true)
    return true
  }, [blobCode, deploySkillName, effectiveSkillsetName, linkedSkillName, runtimeApiKey, runtimeUrl])

  const handleToggleDiff = useCallback(async () => {
    if (diffMode) {
      setDiffMode(false)
      setPendingAction(null)
      return
    }
    await enterDiffMode()
  }, [diffMode, enterDiffMode])

  // Wrapper: upload with diff confirmation when there's a diff
  const handleUploadWithConfirm = useCallback(async () => {
    if (blobCode && blobCode !== skillCode) {
      setPendingAction('upload')
      await enterDiffMode()
    } else {
      handlePublishToBlob()
    }
  }, [blobCode, skillCode, enterDiffMode, handlePublishToBlob])

  // Wrapper: load with diff confirmation when there's a diff
  const handleLoadWithConfirm = useCallback(async () => {
    // Fetch latest blob to compare
    const url = runtimeUrl.trim()
    const name = (deploySkillName.trim() || linkedSkillName || '').trim()
    if (!url || !name) return
    setIsLoadingFromRuntime(true)
    try {
      const config: SkillRuntimeConfig = { runtimeUrl: url, apiKey: runtimeApiKey.trim() || undefined }
      const result = await downloadSkillCode(config, name, effectiveSkillsetName)
      if (!result.success || !result.skillCode) {
        setLoadFromRuntimeError(result.error ?? t('sceLoadFromRuntimeNotFound'))
        return
      }
      setBlobCode(result.skillCode)
      if (result.skillCode !== skillCode) {
        setPendingAction('load')
        setCurrentHunkIndex(0)
        setDiffMode(true)
      } else {
        // No diff — just apply silently
        setLoadFromRuntimeMessage(t('sceLoadFromRuntimeSuccess'))
      }
    } finally {
      setIsLoadingFromRuntime(false)
    }
  }, [deploySkillName, effectiveSkillsetName, linkedSkillName, runtimeApiKey, runtimeUrl, skillCode, t])

  // Execute pending action after diff confirmation
  const handleConfirmPendingAction = useCallback(() => {
    if (pendingAction === 'upload') {
      setDiffMode(false)
      setPendingAction(null)
      handlePublishToBlob()
    } else if (pendingAction === 'load') {
      setDiffMode(false)
      setPendingAction(null)
      handleLoadFromRuntime()
    }
  }, [handleLoadFromRuntime, handlePublishToBlob, pendingAction])

  const handleCancelPendingAction = useCallback(() => {
    setDiffMode(false)
    setPendingAction(null)
    setCodeLoadSource('draft')
  }, [])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const requestErrors = requestValidationResults.filter((r) => r.severity === 'error')
  const requestWarnings = requestValidationResults.filter((r) => r.severity === 'warning')
  const executionErrors = executionValidationResults.filter((r) => r.severity === 'error')
  const executionWarnings = executionValidationResults.filter((r) => r.severity === 'warning')
  const hasExecutionFeedback =
    executionValidationResults.length > 0 || testOutput.length > 0 || executionLogs.length > 0
  const canUploadToBlob =
    !isRunning &&
    !isUploading &&
    !!runtimeUrl.trim() &&
    testOutput.trim().length > 0 &&
    requestErrors.length === 0 &&
    executionErrors.length === 0

  const requestValidationOk = requestErrors.length === 0 && requestWarnings.length === 0
  const executionValidationOk =
    hasExecutionFeedback && executionErrors.length === 0 && executionWarnings.length === 0

  function renderValidationNotice(
    title: string,
    results: ValidationResult[],
  ) {
    const errors = results.filter((r) => r.severity === 'error')
    const warnings = results.filter((r) => r.severity === 'warning')

    if (errors.length === 0 && warnings.length === 0) {
      return null
    }

    return (
      <div
        className={
          'notice ' +
          (errors.length > 0
            ? 'notice--error'
            : warnings.length > 0
              ? 'notice--warning'
              : 'notice--success')
        }
      >
        <div className="notice__title">{title}</div>
        {errors.length > 0 && (
          <>
            <div className="notice__meta">{t('sceErrors')} ({errors.length})</div>
            <ul className="notice__list">
              {errors.map((e, i) => (
                <li key={i}>
                  {e.path && <code>{e.path}</code>} {e.message}
                </li>
              ))}
            </ul>
          </>
        )}
        {warnings.length > 0 && (
          <>
            <div className="notice__meta">{t('sceWarnings')} ({warnings.length})</div>
            <ul className="notice__list">
              {warnings.map((w, i) => (
                <li key={i}>
                  {w.path && <code>{w.path}</code>} {w.message}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    )
  }

  function renderValidationSummary() {
    if (!requestValidationOk && !executionValidationOk) {
      return null
    }

    const parts: string[] = []
    if (requestValidationOk) {
      parts.push(`${t('sceLiveValidationTitle')}: OK`)
    }
    if (executionValidationOk) {
      parts.push(`${t('sceExecutionValidationTitle')}: OK`)
    }

    if (parts.length === 0) {
      return null
    }

    return (
      <div className="notice notice--success" style={{ marginTop: 0 }}>
        <div className="notice__meta">{parts.join(' / ')}</div>
      </div>
    )
  }

  function renderExecutionFeedback(compact: boolean) {
    return (
      <>
        {hasExecutionFeedback &&
          renderValidationNotice(t('sceExecutionValidationTitle'), executionValidationResults)}

        {testOutput && (
          <label className="field" style={compact ? undefined : { flex: 1, minHeight: 0 }}>
            <span className="field__label">{t('sceTestOutputLabel')}</span>
            <div style={compact ? undefined : { flex: 1, minHeight: 0 }}>
              <CodeMirror
                value={testOutput}
                readOnly
                theme={codeMirrorTheme}
                extensions={jsonExtensions}
                height={compact ? '180px' : '100%'}
                style={compact ? { height: '180px' } : { height: '100%' }}
              />
            </div>
          </label>
        )}

        {executionLogs && (
          <div className="field">
            <span className="field__label">{t('sceLogs')}</span>
            <pre className="notice__pre">{executionLogs}</pre>
          </div>
        )}
      </>
    )
  }

  function renderUploadNotice() {
    if (!uploadError && !uploadSuccessMessage) return null

    if (uploadError) {
      return (
        <div className="notice notice--error">
          <button type="button" className="notice__close" onClick={() => setUploadError(null)} aria-label="Close"><i className="bi bi-x-lg" /></button>
          <div className="notice__title">{t('sceUploadToBlob')}</div>
          <div className="notice__meta">{uploadError}</div>
        </div>
      )
    }

    return (
      <div className="notice notice--success">
        <button type="button" className="notice__close" onClick={() => { setUploadSuccessMessage(''); setUploadedEndpointUrl('') }} aria-label="Close"><i className="bi bi-x-lg" /></button>
        <div className="notice__meta">{uploadSuccessMessage}</div>
        {uploadedEndpointUrl && (
          <>
            <div className="notice__meta" style={{ marginTop: 4 }}>
              <span style={{ fontWeight: 600 }}>{t('sceEndpointUrlLabel')}</span>{' '}
              <code className="mono" style={{ userSelect: 'all', wordBreak: 'break-all' }}>{uploadedEndpointUrl}</code>{' '}
              <button
                type="button"
                className="btn btn--icon btn--xs"
                title="Copy"
                onClick={() => navigator.clipboard.writeText(uploadedEndpointUrl)}
              >
                <i className="bi bi-clipboard" aria-hidden="true" />
              </button>
            </div>
            <div className="notice__meta" style={{ marginTop: 4, opacity: 0.85 }}>
              {t('sceEndpointUrlHint')}
            </div>
          </>
        )}
      </div>
    )
  }

  function renderLoadFromRuntimeNotice() {
    if (!loadFromRuntimeError && !loadFromRuntimeMessage) return null

    if (loadFromRuntimeError) {
      return (
        <div className="notice notice--error">
          <button type="button" className="notice__close" onClick={() => setLoadFromRuntimeError(null)} aria-label="Close"><i className="bi bi-x-lg" /></button>
          <div className="notice__title">{t('sceLoadFromRuntime')}</div>
          <div className="notice__meta">{loadFromRuntimeError}</div>
        </div>
      )
    }

    return (
      <div className="notice notice--success">
        <button type="button" className="notice__close" onClick={() => setLoadFromRuntimeMessage('')} aria-label="Close"><i className="bi bi-x-lg" /></button>
        <div className="notice__meta">{loadFromRuntimeMessage}</div>
      </div>
    )
  }

  return (
    <div className="section" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="section__title">{t('sceTitle')}</div>
      <div className="section__hint">{t('sceIntro')}</div>

      {/* ================================================================ */}
      {/* Connection panel + Template paste row                            */}
      {/* ================================================================ */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        {/* WebApiSkill I/O Connection Status Panel */}
        {ioConnectionStatus ? (
          <div style={{
            flex: 1,
            minWidth: 0,
            border: '1px solid var(--border)',
            borderRadius: 6,
            overflow: 'hidden',
            fontSize: 12,
          }}>
          {/* Header - clickable toggle */}
          <button
            type="button"
            onClick={() => setShowConnectionPanel((prev) => !prev)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              width: '100%',
              padding: '6px 10px',
              border: 'none',
              background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
              color: 'var(--fg)',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            <i className={`bi bi-chevron-${showConnectionPanel ? 'down' : 'right'}`} aria-hidden="true" />
            <i className="bi bi-plug" aria-hidden="true" />
            {t('sceConnectionTitle')}
            {linkedSkillName && (
              <span style={{ fontWeight: 400, color: 'var(--muted)', marginLeft: 4 }}>
                — {linkedSkillName}
              </span>
            )}
            {/* Summary badges when collapsed */}
            {!showConnectionPanel && (
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                {(() => {
                  const allInputs = ioConnectionStatus.inputs.every((i) => i.connected)
                  const allOutputs = ioConnectionStatus.outputs.every((o) => o.connected)
                  if (allInputs && allOutputs) {
                    return (
                      <span style={{ color: 'var(--success, #4caf50)' }}>
                        <i className="bi bi-check-circle-fill" aria-hidden="true" /> {t('sceConnectionAllOk')}
                      </span>
                    )
                  }
                  const disconnected = [
                    ...ioConnectionStatus.inputs.filter((i) => !i.connected),
                    ...ioConnectionStatus.outputs.filter((o) => !o.connected),
                  ].length
                  return (
                    <span style={{ color: 'var(--warning-fg, #856404)' }}>
                      <i className="bi bi-exclamation-triangle-fill" aria-hidden="true" />{' '}
                      {t('sceConnectionDisconnected').replace('{count}', String(disconnected))}
                    </span>
                  )
                })()}
              </span>
            )}
          </button>

          {/* Expanded panel body */}
          {showConnectionPanel && (
            <div style={{ padding: '8px 10px', display: 'flex', gap: 16 }}>
              {/* Inputs column */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontWeight: 600,
                  marginBottom: 4,
                  color: 'var(--accent)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}>
                  <i className="bi bi-box-arrow-in-right" aria-hidden="true" />
                  {t('sceConnectionInputsLabel')} ({ioConnectionStatus.inputs.length})
                </div>
                {ioConnectionStatus.inputs.map((input) => {
                  const testPresent = testInputKeyStatus?.find((t) => t.name === input.name)?.present ?? false
                  return (
                    <div key={input.name} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '3px 0',
                      borderBottom: '1px solid color-mix(in srgb, var(--border) 50%, transparent)',
                    }}>
                      {/* Code connection indicator */}
                      <span title={input.connected ? t('sceConnectionCodeOk') : t('sceConnectionCodeMissing')} style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 2,
                        color: input.connected ? 'var(--success, #4caf50)' : 'var(--danger, #dc3545)',
                      }}>
                        <i className={`bi bi-${input.connected ? 'check-circle-fill' : 'x-circle-fill'}`} aria-hidden="true" />
                      </span>
                      {/* Test data indicator */}
                      <span title={testPresent ? t('sceConnectionTestOk') : t('sceConnectionTestMissing')} style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 2,
                        color: testPresent ? 'var(--success, #4caf50)' : 'var(--warning-fg, #856404)',
                      }}>
                        <i className={`bi bi-${testPresent ? 'braces' : 'braces-asterisk'}`} aria-hidden="true" />
                      </span>
                      {/* Name */}
                      <code style={{
                        fontFamily: 'monospace',
                        fontWeight: 500,
                        background: input.connected
                          ? 'color-mix(in srgb, var(--success, #4caf50) 10%, transparent)'
                          : 'color-mix(in srgb, var(--danger, #dc3545) 10%, transparent)',
                        padding: '1px 5px',
                        borderRadius: 3,
                      }}>
                        {input.name}
                      </code>
                      {/* Arrow + source */}
                      {input.source && (
                        <span style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          ← <span style={{ fontFamily: 'monospace' }}>{input.source}</span>
                        </span>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Center connector arrow */}
              <div style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--muted)',
                fontSize: 18,
                padding: '0 4px',
              }}>
                <i className="bi bi-arrow-right" aria-hidden="true" />
                <span style={{ fontSize: 9, marginTop: 2 }}>process()</span>
                <i className="bi bi-arrow-right" aria-hidden="true" />
              </div>

              {/* Outputs column */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontWeight: 600,
                  marginBottom: 4,
                  color: 'var(--accent)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}>
                  <i className="bi bi-box-arrow-right" aria-hidden="true" />
                  {t('sceConnectionOutputsLabel')} ({ioConnectionStatus.outputs.length})
                </div>
                {ioConnectionStatus.outputs.map((output) => (
                  <div key={output.name} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 0',
                    borderBottom: '1px solid color-mix(in srgb, var(--border) 50%, transparent)',
                  }}>
                    {/* Code connection indicator */}
                    <span title={output.connected ? t('sceConnectionCodeOk') : t('sceConnectionCodeMissing')} style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 2,
                      color: output.connected ? 'var(--success, #4caf50)' : 'var(--danger, #dc3545)',
                    }}>
                      <i className={`bi bi-${output.connected ? 'check-circle-fill' : 'x-circle-fill'}`} aria-hidden="true" />
                    </span>
                    {/* Name */}
                    <code style={{
                      fontFamily: 'monospace',
                      fontWeight: 500,
                      background: output.connected
                        ? 'color-mix(in srgb, var(--success, #4caf50) 10%, transparent)'
                        : 'color-mix(in srgb, var(--danger, #dc3545) 10%, transparent)',
                      padding: '1px 5px',
                      borderRadius: 3,
                    }}>
                      {output.name}
                    </code>
                    {/* Arrow + targetName */}
                    {output.targetName && (
                      <span style={{ color: 'var(--muted)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        → <span style={{ fontFamily: 'monospace' }}>{output.targetName}</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Legend bar */}
          {showConnectionPanel && (
            <div style={{
              padding: '4px 10px',
              borderTop: '1px solid var(--border)',
              background: 'color-mix(in srgb, var(--accent) 4%, var(--surface))',
              display: 'flex',
              gap: 12,
              fontSize: 11,
              color: 'var(--muted)',
              flexWrap: 'wrap',
            }}>
              <span><i className="bi bi-check-circle-fill" style={{ color: 'var(--success, #4caf50)' }} /> {t('sceConnectionLegendCodeOk')}</span>
              <span><i className="bi bi-x-circle-fill" style={{ color: 'var(--danger, #dc3545)' }} /> {t('sceConnectionLegendCodeMissing')}</span>
              <span><i className="bi bi-braces" style={{ color: 'var(--success, #4caf50)' }} /> {t('sceConnectionLegendTestOk')}</span>
              <span><i className="bi bi-braces-asterisk" style={{ color: 'var(--warning-fg, #856404)' }} /> {t('sceConnectionLegendTestMissing')}</span>
            </div>
          )}
        </div>
        ) : (
          <span style={{ flex: 1 }} />
        )}
      </div>

      {/* Tab bar — same pattern as SkillPipelineBuilder / BuilderTabPane */}
      <div className="actions actions--mb10">
        <button
          type="button"
          className={'btn btn--tab ' + (activeTab === 'code' ? 'btn--active' : '')}
          onClick={() => setActiveTab('code')}
        >
          {t('sceTabCode')}
        </button>
        <button
          type="button"
          className={'btn btn--tab ' + (activeTab === 'test' ? 'btn--active' : '')}
          onClick={() => setActiveTab('test')}
        >
          {t('sceTabTest')}
        </button>
        <button
          type="button"
          className={'btn btn--tab ' + (activeTab === 'settings' ? 'btn--active' : '')}
          onClick={() => setActiveTab('settings')}
        >
          {t('sceTabSettings')}
        </button>
        <span style={{ flex: 1 }} />
        {generatedSkillCode !== fallbackSampleCode && skillCode !== generatedSkillCode && (
          <button
            type="button"
            className="btn btn--tab"
            title={t('sceApplyTemplateHint')}
            onClick={() => {
              setSkillCode(generatedSkillCode)
              setTestInput(generatedTestInput)
              setCodeLoadSource('template')
            }}
          >
            <i className="bi bi-clipboard-plus" aria-hidden="true" /> {t('sceApplyTemplate')}
          </button>
        )}
      </div>

      {/* ================================================================ */}
      {/* Code Tab                                                         */}
      {/* ================================================================ */}
      {activeTab === 'code' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'hidden' }}>
          <div className="field" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <span className="field__label" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span><i className="bi bi-filetype-py" aria-hidden="true" /> {t('scePythonCodeLabel')}</span>
              <span
                style={{
                  fontSize: 11,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'var(--info-bg, #d1ecf1)',
                  color: 'var(--info-fg, #0c5460)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <i className="bi bi-box-arrow-in-down" aria-hidden="true" />
                {t(`sceCodeSource_${codeLoadSource}` as TranslationKey)}
              </span>
              {remoteCodeHash && (
                <span
                  title={`Local: ${localCodeHash.slice(0, 8)}…\nBlob:  ${remoteCodeHash.slice(0, 8)}…`}
                  style={{
                    fontSize: 11,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: localCodeHash === remoteCodeHash ? 'var(--success-bg, #d4edda)' : 'var(--warning-bg, #fff3cd)',
                    color: localCodeHash === remoteCodeHash ? 'var(--success-fg, #155724)' : 'var(--warning-fg, #856404)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {localCodeHash === remoteCodeHash
                    ? <><i className="bi bi-check-circle-fill" aria-hidden="true" /> {t('sceSyncStatusSynced')}</>
                    : <><i className="bi bi-exclamation-triangle-fill" aria-hidden="true" /> {t('sceSyncStatusDirty')}</>}
                  <span style={{ fontFamily: 'monospace', opacity: 0.75 }}>
                    {localCodeHash === remoteCodeHash
                      ? localCodeHash.slice(0, 8)
                      : `Local:${localCodeHash.slice(0, 7)} Blob:${remoteCodeHash.slice(0, 7)}`}
                  </span>
                </span>
              )}
              {!remoteCodeHash && runtimeUrl.trim() && (
                <span
                  title={`Local: ${localCodeHash.slice(0, 8)}…\nBlob:  (${t('sceSyncStatusUnknown')})`}
                  style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'var(--muted-bg, #e9ecef)', color: 'var(--muted, #6c757d)' }}
                >
                  <i className="bi bi-question-circle" aria-hidden="true" /> {t('sceSyncStatusUnknown')}
                </span>
              )}
              {runtimeUrl.trim() && (
                <span
                  title={estimatedBlobPath}
                  style={{
                    fontSize: 10,
                    fontFamily: 'monospace',
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: 'var(--muted-bg, #e9ecef)',
                    color: 'var(--muted, #6c757d)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    maxWidth: 360,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <i className="bi bi-cloud" aria-hidden="true" />
                  {estimatedBlobPath}
                </span>
              )}
              <span style={{ flex: 1 }} />
              {runtimeVersion && (
                <span
                  style={{
                    fontSize: 11,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: healthStatus === 'ok'
                      ? 'var(--success-bg, #d4edda)'
                      : healthStatus === 'error'
                        ? 'color-mix(in srgb, var(--danger, #dc3545) 15%, var(--surface))'
                        : 'var(--muted-bg, #e9ecef)',
                    color: healthStatus === 'ok'
                      ? 'var(--success-fg, #155724)'
                      : healthStatus === 'error'
                        ? 'var(--danger, #dc3545)'
                        : 'var(--muted, #6c757d)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  {healthStatus === 'ok'
                    ? <i className="bi bi-circle-fill" style={{ fontSize: 7 }} aria-hidden="true" />
                    : healthStatus === 'error'
                      ? <i className="bi bi-circle-fill" style={{ fontSize: 7 }} aria-hidden="true" />
                      : <i className="bi bi-circle" style={{ fontSize: 7 }} aria-hidden="true" />}
                  SkillLive v{runtimeVersion}
                </span>
              )}
            </span>

            {/* ── Diff toolbar ── */}
            {diffMode && (
              <div className="actions actions--tight" style={{ marginBottom: 4 }}>
                {pendingAction ? (
                  <>
                    <button type="button" className="btn btn--sm btn--tab btn--active" onClick={handleConfirmPendingAction}>
                      <i className="bi bi-check-lg" aria-hidden="true" />{' '}
                      {pendingAction === 'upload' ? t('sceDiffConfirmUpload') : t('sceDiffConfirmLoad')}
                    </button>
                    <button type="button" className="btn btn--sm" onClick={handleCancelPendingAction}>
                      <i className="bi bi-x-lg" aria-hidden="true" /> {t('sceDiffCancel')}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn--sm" onClick={() => setDiffMode(false)}>
                    <i className="bi bi-x-lg" aria-hidden="true" /> {t('sceDiffExit')}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => handleDiffNavigate('up')}
                  disabled={diffHunks.length === 0 || currentHunkIndex <= 0}
                  title={t('sceDiffPrev')}
                >
                  <i className="bi bi-chevron-up" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => handleDiffNavigate('down')}
                  disabled={diffHunks.length === 0 || currentHunkIndex >= diffHunks.length - 1}
                  title={t('sceDiffNext')}
                >
                  <i className="bi bi-chevron-down" aria-hidden="true" />
                </button>
                {diffHunks.length > 0 && (
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                    {t('sceDiffHunkCounter')
                      .replace('{current}', String(currentHunkIndex + 1))
                      .replace('{total}', String(diffHunks.length))}
                  </span>
                )}
                {diffHunks.length === 0 && blobCode && (
                  <span style={{ fontSize: 12, color: 'var(--success, #4caf50)' }}>
                    <i className="bi bi-check-circle" aria-hidden="true" /> {t('sceDiffNoChanges')}
                  </span>
                )}
              </div>
            )}

            {/* ── Editor area ── */}
            {diffMode ? (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, flex: 1, minHeight: 0 }}>
                <div className="skillset-diff-editor" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  <div className="section__title" style={{ marginTop: 0, fontSize: 12 }}>
                    <i className="bi bi-pencil-square" aria-hidden="true" /> {t('sceDiffLocalLabel')}
                  </div>
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <CodeMirror
                      value={skillCode}
                      readOnly
                      theme={codeMirrorTheme}
                      extensions={[
                        ...pythonExtensions,
                        EditorView.editable.of(false),
                        makeLineClassExtension(diffLineSets.left, 'cm-diff-removed'),
                      ]}
                      height="100%"
                      style={{ height: '100%' }}
                      onCreateEditor={(view) => { diffLeftViewRef.current = view }}
                    />
                  </div>
                </div>
                <div className="skillset-diff-editor" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  <div className="section__title" style={{ marginTop: 0, fontSize: 12 }}>
                    <i className="bi bi-cloud" aria-hidden="true" /> {t('sceDiffBlobLabel')}
                  </div>
                  <div style={{ flex: 1, minHeight: 0 }}>
                    <CodeMirror
                      value={blobCode}
                      readOnly
                      theme={codeMirrorTheme}
                      extensions={[
                        ...pythonExtensions,
                        EditorView.editable.of(false),
                        makeLineClassExtension(diffLineSets.right, 'cm-diff-added'),
                      ]}
                      height="100%"
                      style={{ height: '100%' }}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                <CodeMirror
                  value={skillCode}
                  onChange={isLoadingFromRuntime ? undefined : setSkillCode}
                  readOnly={isLoadingFromRuntime}
                  theme={codeMirrorTheme}
                  extensions={isLoadingFromRuntime ? [...pythonExtensions, EditorView.editable.of(false)] : pythonExtensions}
                  height="100%"
                  style={{ height: '100%' }}
                />
                {isLoadingFromRuntime && (
                  <div style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'color-mix(in srgb, var(--surface) 80%, transparent)',
                    backdropFilter: 'blur(2px)',
                    zIndex: 10,
                    borderRadius: 4,
                  }}>
                    <span style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 16px',
                      borderRadius: 6,
                      background: 'var(--panel)',
                      border: '1px solid var(--border)',
                      fontSize: 13,
                      fontWeight: 500,
                      color: 'var(--fg)',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                    }}>
                      <i className="bi bi-arrow-repeat spin" aria-hidden="true" />
                      {t('sceLoadingFromBlob')}
                    </span>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="actions actions--tight">
            <button
              type="button"
              className="btn btn--tab btn--active"
              onClick={handleLocalRunFromCode}
              disabled={isRunning || diffMode}
            >
              <i className="bi bi-play-fill" aria-hidden="true" />{' '}
              {isRunning && pyodideStatus === 'loading'
                ? t('sceLocalRunLoading')
                : isRunning
                  ? t('sceRunning')
                  : t('sceLocalRun')}
            </button>
            {runtimeUrl.trim() && (
              <button
                type="button"
                className="btn btn--tab"
                onClick={handleRemoteRunFromCode}
                disabled={isRunning || diffMode}
              >
                <i className="bi bi-cloud-arrow-up" aria-hidden="true" /> {t('sceRunTest')}
              </button>
            )}
            {executionTimeMs != null && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {t('sceExecutionTime').replace('{ms}', String(executionTimeMs))}
              </span>
            )}
            <button
              type="button"
              className="btn btn--tab"
              onClick={handleUploadWithConfirm}
              disabled={!canUploadToBlob || diffMode}
              title={!canUploadToBlob ? t('sceUploadDisabledHint') : t('sceUploadToBlob')}
            >
              <i className="bi bi-cloud-arrow-up" aria-hidden="true" />{' '}
              {isUploading ? t('sceUploadingToBlob') : t('sceUploadToBlob')}
            </button>
            <button
              type="button"
              className="btn btn--tab"
              onClick={handleLoadWithConfirm}
              disabled={isLoadingFromRuntime || !runtimeUrl.trim() || diffMode}
              title={t('sceLoadFromBlob')}
            >
              <i className="bi bi-cloud-arrow-down" aria-hidden="true" />{' '}
              {isLoadingFromRuntime ? t('sceLoadingFromBlob') : t('sceLoadFromBlob')}
            </button>
            <button
              type="button"
              className={'btn btn--tab' + (diffMode ? ' btn--active' : '')}
              onClick={handleToggleDiff}
              disabled={(!blobCode && !runtimeUrl.trim()) || isDiffLoading}
              title={t('sceDiffCompare')}
            >
              <i className={isDiffLoading ? 'bi bi-arrow-repeat spin' : 'bi bi-file-diff'} aria-hidden="true" />{' '}
              {isDiffLoading ? t('sceDiffLoading') : t('sceDiffCompare')}
            </button>
          </div>
          {renderLoadFromRuntimeNotice()}
          {renderUploadNotice()}
        </div>
      )}

      {/* ================================================================ */}
      {/* Test Tab                                                         */}
      {/* ================================================================ */}
      {activeTab === 'test' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          {/* Input editor */}
          <label className="field" style={{ flex: 1, minHeight: 0 }}>
            <span className="field__label">{t('sceTestInputLabel')}</span>
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              <CodeMirror
                value={testInput}
                onChange={isLoadingFromRuntime ? undefined : setTestInput}
                readOnly={isLoadingFromRuntime}
                theme={codeMirrorTheme}
                extensions={isLoadingFromRuntime ? [...jsonExtensions, EditorView.editable.of(false)] : jsonExtensions}
                height="100%"
                style={{ height: '100%' }}
              />
              {isLoadingFromRuntime && (
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'color-mix(in srgb, var(--surface) 80%, transparent)',
                  backdropFilter: 'blur(2px)',
                  zIndex: 10,
                  borderRadius: 4,
                }}>
                  <span style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '8px 16px',
                    borderRadius: 6,
                    background: 'var(--panel)',
                    border: '1px solid var(--border)',
                    fontSize: 13,
                    fontWeight: 500,
                    color: 'var(--fg)',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
                  }}>
                    <i className="bi bi-arrow-repeat spin" aria-hidden="true" />
                    {t('sceLoadingFromBlob')}
                  </span>
                </div>
              )}
            </div>
          </label>

          {/* Action buttons */}
          <div className="actions actions--tight">
            <button
              type="button"
              className="btn btn--tab btn--active"
              onClick={handleLocalRun}
              disabled={isRunning}
            >
              <i className="bi bi-play-fill" aria-hidden="true" />{' '}
              {isRunning && pyodideStatus === 'loading'
                ? t('sceLocalRunLoading')
                : isRunning
                  ? t('sceRunning')
                  : t('sceLocalRun')}
            </button>
            {runtimeUrl.trim() && (
              <button
                type="button"
                className="btn btn--tab"
                onClick={handleRun}
                disabled={isRunning}
              >
                <i className="bi bi-cloud-arrow-up" aria-hidden="true" /> {t('sceRunTest')}
              </button>
            )}
            {executionTimeMs != null && (
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {t('sceExecutionTime').replace('{ms}', String(executionTimeMs))}
              </span>
            )}
          </div>

          {renderValidationSummary()}
          {renderValidationNotice(t('sceLiveValidationTitle'), requestValidationResults)}
          {renderExecutionFeedback(false)}
        </div>
      )}

      {/* ================================================================ */}
      {/* Settings Tab                                                     */}
      {/* ================================================================ */}
      {activeTab === 'settings' && (
        <div className="form form--compact">
          <label className="field">
            <span className="field__label">{t('sceRuntimeUrlLabel')}</span>
            <input
              type="url"
              className="field__input"
              value={runtimeUrl}
              onChange={(e) => setRuntimeUrl(e.target.value)}
              placeholder={t('sceRuntimeUrlPlaceholder')}
            />
          </label>

          <label className="field">
            <span className="field__label">{t('sceRuntimeApiKeyLabel')}</span>
            <input
              type="password"
              className="field__input"
              value={runtimeApiKey}
              onChange={(e) => setRuntimeApiKey(e.target.value)}
              autoComplete="off"
            />
          </label>

          <div className="actions actions--tight">
            <button
              type="button"
              className="btn"
              onClick={handleHealthCheck}
              disabled={!runtimeUrl.trim() || isCheckingHealth}
            >
              <i className={isCheckingHealth ? 'bi bi-arrow-repeat spin' : 'bi bi-heart-pulse'} aria-hidden="true" />{' '}
              {isCheckingHealth ? t('sceCheckingHealth') : t('sceCheckHealth')}
            </button>
            {healthStatus === 'ok' && (
              <span style={{ fontSize: 12, color: 'var(--success, #4caf50)' }}>
                <i className="bi bi-check-circle-fill" aria-hidden="true" /> {t('sceRuntimeHealthOk')}
                {runtimeVersion && <span style={{ marginLeft: 4, opacity: 0.75 }}>v{runtimeVersion}</span>}
              </span>
            )}
            {healthStatus === 'error' && (
              <span style={{ fontSize: 12, color: 'var(--danger)' }}>
                <i className="bi bi-x-circle-fill" aria-hidden="true" /> {t('sceRuntimeHealthError')}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
