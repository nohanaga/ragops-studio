/**
 * React hook orchestrating the Eval Dataset Generator pipeline.
 *
 * Sequence:
 *   1. Sample N docs from the configured Azure AI Search index.
 *   2. For each sampled doc, call Azure OpenAI to produce M queries.
 *      Provenance metadata is attached at this step (Phase 2.0).
 *   3. Surface dedup (Jaccard, Phase 1).
 *   4. Round-trip consistency filter (Promptagator, Phase 2.1, opt-in).
 *   5. Semantic dedup via embeddings cosine (Phase 2.2, opt-in).
 *   6. Reflect into local state with progress and cancellation.
 *
 * Concurrency is limited to keep within typical AOAI rate limits.
 */

import { useCallback, useRef, useState } from 'react'

import type { ConnectionProfile, SearchApiVersion } from '../lib/model'
import type { Language } from '../lib/translations'
import { computeRelevanceGrades, generateForDoc, generateForScenario, generateHydeHypothesis, generateRaftAnswer, hardenQuery, markSurfaceDuplicates } from '../lib/evalDatasetGenerator'
import { fetchDistractorDocs } from '../lib/evalDatasetGrounding'
import { LlmAuthError, formatLlmAuthErrorMessage } from '../lib/llmAuth'
import { sampleDocsFromIndex, detectIndexStructure, sampleDocsAdaptive } from '../lib/evalDatasetSampling'
import { checkGrounding, mineHardNegatives } from '../lib/evalDatasetGrounding'
// fetchDistractorDocs is imported above alongside generateRaftAnswer
import { embedTexts, findSemanticDuplicates } from '../lib/evalDatasetEmbeddings'
import { planScenarios } from '../lib/evalDatasetRagas'
import { extractEntities } from '../lib/evalDatasetEntities'
import { degradeQuery } from '../lib/evalDatasetStyleEvolution'
import type { EvalDatasetGenerationConfig, GeneratedQAItem, IndexStructureInfo, TraceEvent } from '../types'

const CONCURRENCY = 3
const SURFACE_DEDUP_THRESHOLD = 0.85
const GROUNDING_CONCURRENCY = 4

export interface UseEvalDatasetGenerationParams {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
  language: Language
}

export type EdgPhase =
  | 'idle'
  | 'detecting'
  | 'sampling'
  | 'generating'
  | 'grounding'
  | 'embedding'
  | 'styleevol'
  | 'difficulty'
  | 'hardneg'
  | 'raft'
  | 'hyde'
  | 'done'

export interface UseEvalDatasetGenerationResult {
  items: GeneratedQAItem[]
  isRunning: boolean
  error: string | null
  progress: { done: number; total: number; phase: EdgPhase; phaseIndex: number; phaseTotal: number }
  /** Map of doc id → original content text (only populated for the latest run's sample). */
  docTextById: Record<string, string>
  /** Detected index structure info (populated after Phase 0). */
  indexStructure: IndexStructureInfo | null
  start: (config: EvalDatasetGenerationConfig) => Promise<void>
  cancel: () => void
  reset: () => void
}

/** Generate a short, opaque run id for provenance correlation. */
function newRunId(): string {
  const rand = Math.random().toString(36).slice(2, 10)
  const ts = Date.now().toString(36)
  return `edg-${ts}-${rand}`
}

/** Append a trace event to an item (mutates in place). */
function pushTrace(item: GeneratedQAItem, evt: Omit<TraceEvent, 'timestamp'>): void {
  if (!item.trace) item.trace = []
  item.trace.push({ ...evt, timestamp: new Date().toISOString() })
}

export function useEvalDatasetGeneration(
  params: UseEvalDatasetGenerationParams,
): UseEvalDatasetGenerationResult {
  const { profile, apiVersion, language } = params

  const [items, setItems] = useState<GeneratedQAItem[]>([])
  const [docTextById, setDocTextById] = useState<Record<string, string>>({})
  const [indexStructure, setIndexStructure] = useState<IndexStructureInfo | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; phase: EdgPhase; phaseIndex: number; phaseTotal: number }>({
    done: 0,
    total: 0,
    phase: 'idle',
    phaseIndex: 0,
    phaseTotal: 0,
  })
  const abortRef = useRef<AbortController | null>(null)

  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort()
    }
  }, [])

  const reset = useCallback(() => {
    setItems([])
    setDocTextById({})
    setIndexStructure(null)
    setError(null)
    setProgress({ done: 0, total: 0, phase: 'idle', phaseIndex: 0, phaseTotal: 0 })
  }, [])

  const start = useCallback(
    async (config: EvalDatasetGenerationConfig) => {
      if (!profile) {
        setError('Active connection profile is required')
        return
      }
      const controller = new AbortController()
      abortRef.current = controller
      setIsRunning(true)
      setError(null)
      setItems([])
      setIndexStructure(null)

      // Calculate total pipeline phases for the outer progress bar.
      const useAdaptive = config.enableAdaptiveSampling ?? false
      let totalPhases = 2 // sampling + generating (always run)
      if (useAdaptive) totalPhases++ // detection phase
      if (config.enableGroundingCheck) totalPhases++
      if (config.enableSemanticDedup && config.embeddingDeployment?.trim()) totalPhases++
      if (config.enableDifficultyEvolution) totalPhases++
      if (config.enableStyleEvolution) totalPhases++
      if (config.enableHardNegativeMining) totalPhases++
      if (config.enableRelevanceGrades) totalPhases++
      if (config.enableRaftMode) totalPhases++
      if (config.enableHydeMode) totalPhases++
      let currentPhase = 0

      const runId = newRunId()
      const generatedAt = new Date().toISOString()

      // Fatal LLM auth failure (HTTP 401/403). Captured separately so that:
      //   - The pipeline can short-circuit (`controller.abort()`) instead of
      //     spamming the same auth error per doc/worker.
      //   - The user-facing message wins over later non-fatal errors.
      let fatalAuthMsg: string | null = null
      const edgLang: 'ja' | 'en' = language === 'ja' ? 'ja' : 'en'

      try {
        // Phase 0) Index Structure Detection (opt-in via enableAdaptiveSampling).
        let detectedStructure: IndexStructureInfo | null = null
        if (useAdaptive) {
          setProgress({ done: 0, total: 0, phase: 'detecting', phaseIndex: ++currentPhase, phaseTotal: totalPhases })
          detectedStructure = await detectIndexStructure({
            profile,
            indexName: config.indexName,
            apiVersion,
            keyField: config.keyField,
            parentFieldOverride: config.parentField,
            language,
            signal: controller.signal,
          })
          setIndexStructure(detectedStructure)
          if (controller.signal.aborted) return
        }

        // 1) Sample docs.
        setProgress({ done: 0, total: 0, phase: 'sampling', phaseIndex: ++currentPhase, phaseTotal: totalPhases })
        const docs = detectedStructure
          ? await sampleDocsAdaptive({
              profile,
              indexName: config.indexName,
              apiVersion,
              keyField: config.keyField,
              contentFields: config.contentFields,
              sampleSize: config.sampleSize,
              language,
              signal: controller.signal,
              indexStructure: detectedStructure,
            })
          : await sampleDocsFromIndex({
              profile,
              indexName: config.indexName,
              apiVersion,
              keyField: config.keyField,
              contentFields: config.contentFields,
              sampleSize: config.sampleSize,
              language,
              signal: controller.signal,
            })

        if (docs.length === 0) {
          setError('No documents were sampled from the index')
          return
        }

        // Build sibling lookup for sibling-aware grounding.
        const siblingMap: Record<string, string[]> = {}
        for (const d of docs) {
          if (d.siblingIds && d.siblingIds.length > 0) {
            siblingMap[d.id] = d.siblingIds
          }
        }

        // Publish sampled doc texts so the UI can preview content per expected_id.
        {
          const map: Record<string, string> = {}
          for (const d of docs) map[d.id] = d.text
          setDocTextById(map)
        }

        setProgress({ done: 0, total: docs.length, phase: 'generating', phaseIndex: ++currentPhase, phaseTotal: totalPhases })

        // 2) Generate queries with bounded concurrency.
        //    Ragas mode plans scenarios across the 4-quadrant taxonomy
        //    (single/multi × specific/abstract). Classic mode generates
        //    M queries per doc.
        const llm = {
          endpoint: config.llmEndpoint,
          auth: config.llmAuth,
          deployment: config.llmDeployment,
          apiVersion: config.llmApiVersion,
          provider: config.llmProvider,
        }
        // Judge LLM: same endpoint/auth, different deployment only.
        const judgeLlm = config.judgeLlmDeployment?.trim()
          ? { ...llm, deployment: config.judgeLlmDeployment.trim() }
          : llm
        const tracing = config.enableTrace ?? false
        const promptCfg = {
          language: config.language,
          queryTypes: config.queryTypes,
          queriesPerDoc: config.queriesPerDoc,
          domainDescription: config.domainDescription,
          domainSchema: config.domainSchema,
        }
        const provenance = {
          indexName: config.indexName,
          runId,
          generatedAt,
        }

        const collected: GeneratedQAItem[] = []
        let firstError: string | null = null
        const recordWorkerError = (e: unknown): void => {
          if (e instanceof LlmAuthError) {
            if (!fatalAuthMsg) fatalAuthMsg = formatLlmAuthErrorMessage(e, edgLang)
            controller.abort()
            return
          }
          const msg = e instanceof Error ? e.message : String(e)
          if (!firstError) firstError = msg
        }

        if (config.enableRagasMode) {
          // -------- Ragas scenario pipeline --------
          const totalQueries = Math.max(1, docs.length * config.queriesPerDoc)

          // Phase 6 (Entity-KG): optional LLM entity extraction per doc.
          // On failure for a given doc we silently fall back to token Jaccard
          // for that doc, so the pipeline never blocks on extraction errors.
          let entitySetsById: Record<string, Set<string>> | undefined
          if (config.enableEntityKG) {
            setProgress((p) => ({ ...p, done: 0, total: docs.length }))
            entitySetsById = {}
            let eCursor = 0
            const eWorker = async () => {
              while (!controller.signal.aborted) {
                const idx = eCursor++
                if (idx >= docs.length) return
                const d = docs[idx]
                try {
                  const ents = await extractEntities({
                    language: config.language,
                    text: d.text,
                    llm,
                    signal: controller.signal,
                  })
                  if (ents.size > 0 && entitySetsById) entitySetsById[d.id] = ents
                } catch (e) {
                  // Per-doc failure is normally non-fatal; we just lose KG signal for it.
                  // recordWorkerError still escalates 401/403 to fatalAuthMsg + abort.
                  if (controller.signal.aborted) return
                  recordWorkerError(e)
                } finally {
                  setProgress((p) => ({ ...p, done: p.done + 1 }))
                }
              }
            }
            const eWorkers: Promise<void>[] = []
            const ew = Math.min(CONCURRENCY, docs.length)
            for (let i = 0; i < ew; i++) eWorkers.push(eWorker())
            await Promise.all(eWorkers)
          }

          const slots = planScenarios({
            docs,
            totalQueries,
            distribution: config.queryDistribution,
            personas: config.personas,
            styles: config.styles,
            lengths: config.lengths,
            multiHopPairingThreshold: config.multiHopPairingThreshold,
            entitySetsById,
          })
          setProgress((p) => ({ ...p, done: 0, total: slots.length }))

          let sCursor = 0
          const sWorker = async () => {
            while (!controller.signal.aborted) {
              const idx = sCursor++
              if (idx >= slots.length) return
              try {
                const item = await generateForScenario({
                  slot: slots[idx],
                  language: config.language,
                  domainDescription: config.domainDescription,
                  domainSchema: config.domainSchema,
                  llm,
                  signal: controller.signal,
                  provenance,
                })
                if (item) {
                  collected.push(item)
                  setItems([...collected])
                }
              } catch (e) {
                if (controller.signal.aborted) return
                recordWorkerError(e)
              } finally {
                setProgress((p) => ({ ...p, done: p.done + 1 }))
              }
            }
          }
          const sw: Promise<void>[] = []
          const swCount = Math.min(CONCURRENCY, slots.length)
          for (let i = 0; i < swCount; i++) sw.push(sWorker())
          await Promise.all(sw)
        } else {
          // -------- Classic per-doc pipeline --------
          let cursor = 0
          const worker = async () => {
            while (!controller.signal.aborted) {
              const myIndex = cursor++
              if (myIndex >= docs.length) return
              try {
                const generated = await generateForDoc({
                  doc: docs[myIndex],
                  prompt: promptCfg,
                  llm,
                  signal: controller.signal,
                  provenance,
                })
                collected.push(...generated)
                setItems([...collected])
              } catch (e) {
                if (controller.signal.aborted) return
                recordWorkerError(e)
              } finally {
                setProgress((p) => ({ ...p, done: p.done + 1 }))
              }
            }
          }
          const workers: Promise<void>[] = []
          const w = Math.min(CONCURRENCY, docs.length)
          for (let i = 0; i < w; i++) workers.push(worker())
          await Promise.all(workers)
        }

        if (controller.signal.aborted) return

        // Trace: mark all collected items as 'created' at generation step.
        if (tracing) {
          for (const it of collected) {
            pushTrace(it, { step: 1, phase: 'generation', action: 'created', detail: { after: it.query } })
          }
        }

        // 3) Surface dedup (Jaccard).
        const pipeline: GeneratedQAItem[] = markSurfaceDuplicates(collected, SURFACE_DEDUP_THRESHOLD)
        // Trace: keep rejected duplicates visible so the UI can explain why they were filtered.
        if (tracing) {
          for (const it of pipeline) {
            pushTrace(it, it.rejection_reason === 'surface-dup'
              ? { step: 2, phase: 'surface-dedup', action: 'rejected', detail: { reason: 'surface-dup' } }
              : { step: 2, phase: 'surface-dedup', action: 'kept' })
          }
        }
        setItems(pipeline)

        // 4) Round-trip consistency filter (Phase 2.1).
        if (config.enableGroundingCheck) {
          const groundingIdx: number[] = []
          for (let i = 0; i < pipeline.length; i++) {
            if (!pipeline[i].rejected) groundingIdx.push(i)
          }
          setProgress({ done: 0, total: groundingIdx.length, phase: 'grounding', phaseIndex: ++currentPhase, phaseTotal: totalPhases })
          const topK = Math.max(1, Math.min(50, Math.floor(config.groundingTopK || 10)))

          let gCursor = 0
          const gWorker = async () => {
            while (!controller.signal.aborted) {
              const localIdx = gCursor++
              if (localIdx >= groundingIdx.length) return
              const idx = groundingIdx[localIdx]
              const item = pipeline[idx]
              // For multi-hop items, accept the query as grounded if ANY of the
              // expected docs is retrieved within top-k (best rank wins).
              // For chunked indexes, also accept sibling chunks from the same source.
              const candidateIds =
                item.expected_ids.length > 0
                  ? [...item.expected_ids]
                  : item.source_doc_id
                    ? [item.source_doc_id]
                    : []
              // Expand candidates with sibling IDs for sibling-aware grounding
              for (const eid of [...candidateIds]) {
                const siblings = siblingMap[eid]
                if (siblings) {
                  for (const sid of siblings) {
                    if (!candidateIds.includes(sid)) candidateIds.push(sid)
                  }
                }
              }
              if (candidateIds.length === 0) {
                item.grounding_rank = 0
                item.grounding_top_k = topK
                item.rejected = true
                item.rejection_reason = 'grounding'
                if (tracing) pushTrace(item, { step: 3, phase: 'grounding', action: 'rejected', detail: { reason: 'no-candidate-ids' } })
                setProgress((p) => ({ ...p, done: p.done + 1 }))
                continue
              }
              try {
                let bestRank = 0
                for (const docId of candidateIds) {
                  const r = await checkGrounding({
                    profile,
                    indexName: config.indexName,
                    apiVersion,
                    keyField: config.keyField,
                    query: item.query,
                    expectedDocId: docId,
                    topK,
                    language,
                    signal: controller.signal,
                  })
                  if (r.found && (bestRank === 0 || r.rank < bestRank)) {
                    bestRank = r.rank
                  }
                }
                item.grounding_rank = bestRank
                item.grounding_top_k = topK
                if (bestRank === 0) {
                  item.rejected = true
                  item.rejection_reason = 'grounding'
                  if (tracing) pushTrace(item, { step: 3, phase: 'grounding', action: 'rejected', detail: { reason: 'grounding', score: 0 } })
                } else {
                  if (tracing) pushTrace(item, { step: 3, phase: 'grounding', action: 'kept', detail: { score: bestRank } })
                }
              } catch (e) {
                if (controller.signal.aborted) return
                recordWorkerError(e)
              } finally {
                setProgress((p) => ({ ...p, done: p.done + 1 }))
                setItems([...pipeline])
              }
            }
          }

          const gWorkers: Promise<void>[] = []
          const gw = Math.min(GROUNDING_CONCURRENCY, pipeline.length)
          for (let i = 0; i < gw; i++) gWorkers.push(gWorker())
          await Promise.all(gWorkers)

          if (controller.signal.aborted) return
        }

        // 5) Semantic dedup via embeddings (Phase 2.2).
        if (config.enableSemanticDedup && config.embeddingDeployment?.trim()) {
          const survivorIdx: number[] = []
          for (let i = 0; i < pipeline.length; i++) {
            if (!pipeline[i].rejected) survivorIdx.push(i)
          }
          if (survivorIdx.length >= 2) {
            setProgress({ done: 0, total: survivorIdx.length, phase: 'embedding', phaseIndex: ++currentPhase, phaseTotal: totalPhases })
            try {
              const queries = survivorIdx.map((i) => pipeline[i].query)
              const vectors = await embedTexts({
                endpoint: config.embeddingEndpoint || config.llmEndpoint,
                auth: config.embeddingAuth || config.llmAuth,
                deployment: config.embeddingDeployment!.trim(),
                apiVersion: config.embeddingApiVersion ?? config.llmApiVersion,
                inputs: queries,
                signal: controller.signal,
                provider: config.embeddingProvider || config.llmProvider,
              })
              setProgress((p) => ({ ...p, done: survivorIdx.length, total: survivorIdx.length }))
              const dropped = findSemanticDuplicates(vectors, config.semanticDedupThreshold)
              for (const localIdx of dropped) {
                const globalIdx = survivorIdx[localIdx]
                pipeline[globalIdx].rejected = true
                pipeline[globalIdx].rejection_reason = 'semantic-dup'
                if (tracing) pushTrace(pipeline[globalIdx], { step: 4, phase: 'semantic-dedup', action: 'rejected', detail: { reason: 'semantic-dup' } })
              }
              if (tracing) {
                for (const i of survivorIdx) {
                  if (!pipeline[i].rejected) pushTrace(pipeline[i], { step: 4, phase: 'semantic-dedup', action: 'kept' })
                }
              }
              setItems([...pipeline])
            } catch (e) {
              if (controller.signal.aborted) return
              recordWorkerError(e)
            }
          }
        }

        // Build id → text lookup once for difficulty rewrite (Phase 4.2).
        const docTextById = new Map<string, string>()
        for (const d of docs) docTextById.set(d.id, d.text)

        // 5) Difficulty Evolution (Phase 4.2, Evol-Instruct).
        //    Sequentially rewrites each kept query into a HARDER variant.
        //    On parse error the original query is kept verbatim.
        if (config.enableDifficultyEvolution) {
          const survivors: number[] = []
          for (let i = 0; i < pipeline.length; i++) {
            if (!pipeline[i].rejected) survivors.push(i)
          }
          if (survivors.length > 0) {
            setProgress({ done: 0, total: survivors.length, phase: 'difficulty', phaseIndex: ++currentPhase, phaseTotal: totalPhases })
            // Mark every kept item as `easy` baseline first.
            for (const idx of survivors) {
              if (!pipeline[idx].difficulty) pipeline[idx].difficulty = 'easy'
            }

            let dCursor = 0
            const dWorker = async () => {
              while (!controller.signal.aborted) {
                const localIdx = dCursor++
                if (localIdx >= survivors.length) return
                const globalIdx = survivors[localIdx]
                const item = pipeline[globalIdx]
                const ctxId = item.source_doc_id || item.expected_ids[0] || ''
                const ctx = docTextById.get(ctxId) ?? ''
                if (!ctx) {
                  setProgress((p) => ({ ...p, done: p.done + 1 }))
                  continue
                }
                try {
                  const harder = await hardenQuery({
                    language: config.language,
                    query: item.query,
                    contextText: ctx,
                    llm: judgeLlm,
                    signal: controller.signal,
                  })
                  if (harder) {
                    const before = item.query
                    item.query = harder
                    item.difficulty = 'hard'
                    if (tracing) pushTrace(item, { step: 5, phase: 'difficulty', action: 'modified', detail: { before, after: harder } })
                  } else {
                    if (tracing) pushTrace(item, { step: 5, phase: 'difficulty', action: 'kept' })
                  }
                } catch (e) {
                  if (controller.signal.aborted) return
                  recordWorkerError(e)
                } finally {
                  setProgress((p) => ({ ...p, done: p.done + 1 }))
                  setItems([...pipeline])
                }
              }
            }
            const dWorkers: Promise<void>[] = []
            const dw = Math.min(CONCURRENCY, survivors.length)
            for (let i = 0; i < dw; i++) dWorkers.push(dWorker())
            await Promise.all(dWorkers)
          }
        }

        // 6) Style Evolution / SNS mode (Phase 7b).
        //    Degrades clean LLM queries into real-traffic surface forms.
        if (config.enableStyleEvolution) {
          const survivors: number[] = []
          for (let i = 0; i < pipeline.length; i++) {
            if (!pipeline[i].rejected) survivors.push(i)
          }
          if (survivors.length > 0) {
            setProgress({ done: 0, total: survivors.length, phase: 'styleevol', phaseIndex: ++currentPhase, phaseTotal: totalPhases })
            const seLlm = judgeLlm // style evolution uses judge LLM (or generation LLM as fallback)
            const allowedKinds = config.styleEvolutionKinds ?? []

            let seCursor = 0
            const seWorker = async () => {
              while (!controller.signal.aborted) {
                const localIdx = seCursor++
                if (localIdx >= survivors.length) return
                const globalIdx = survivors[localIdx]
                const item = pipeline[globalIdx]
                try {
                  const before = item.query
                  const result = await degradeQuery({
                    endpoint: seLlm.endpoint,
                    auth: seLlm.auth,
                    deployment: seLlm.deployment,
                    apiVersion: seLlm.apiVersion,
                    provider: seLlm.provider,
                    query: item.query,
                    language: config.language,
                    allowedKinds,
                    signal: controller.signal,
                  })
                  const changed = result.degraded.normalize('NFC') !== before.normalize('NFC')
                  if (changed) {
                    item.query = result.degraded
                    item.style_evolution_kind = result.kind
                  }
                  if (tracing) pushTrace(item, {
                    step: 6, phase: 'style-evolution',
                    action: changed ? 'modified' : 'kept',
                    detail: changed
                      ? { before, after: result.degraded, styleKind: result.kind }
                      : { reason: 'unchanged', styleKind: result.kind },
                  })
                } catch (e) {
                  if (controller.signal.aborted) return
                  recordWorkerError(e)
                  if (tracing) pushTrace(item, { step: 6, phase: 'style-evolution', action: 'kept', detail: { reason: 'error' } })
                } finally {
                  setProgress((p) => ({ ...p, done: p.done + 1 }))
                  setItems([...pipeline])
                }
              }
            }
            const seWorkers: Promise<void>[] = []
            const sew = Math.min(CONCURRENCY, survivors.length)
            for (let i = 0; i < sew; i++) seWorkers.push(seWorker())
            await Promise.all(seWorkers)
          }
        }

        // 7) Hard Negative Mining (Phase 4.3, DPR-style).
        //    For each kept query, fetch top-k from the index and store
        //    non-expected ids as `hard_negative_ids`.
        if (config.enableHardNegativeMining) {
          const survivors: number[] = []
          for (let i = 0; i < pipeline.length; i++) {
            if (!pipeline[i].rejected) survivors.push(i)
          }
          if (survivors.length > 0) {
            setProgress({ done: 0, total: survivors.length, phase: 'hardneg', phaseIndex: ++currentPhase, phaseTotal: totalPhases })
            const topK = Math.max(
              1,
              Math.min(50, Math.floor(config.hardNegativeTopK || 10)),
            )
            const maxNeg = Math.max(1, Math.min(20, topK)) // cap to topK

            let hnCursor = 0
            const hnWorker = async () => {
              while (!controller.signal.aborted) {
                const localIdx = hnCursor++
                if (localIdx >= survivors.length) return
                const globalIdx = survivors[localIdx]
                const item = pipeline[globalIdx]
                try {
                  const negatives = await mineHardNegatives({
                    profile,
                    indexName: config.indexName,
                    apiVersion,
                    keyField: config.keyField,
                    query: item.query,
                    expectedIds: item.expected_ids,
                    topK,
                    maxNegatives: maxNeg,
                    language,
                    signal: controller.signal,
                  })
                  if (negatives.length > 0) {
                    item.hard_negative_ids = negatives
                    if (tracing) pushTrace(item, { step: 7, phase: 'hardneg', action: 'enriched', detail: { reason: `${negatives.length} negatives mined` } })
                  } else {
                    if (tracing) pushTrace(item, { step: 7, phase: 'hardneg', action: 'kept' })
                  }
                } catch (e) {
                  if (controller.signal.aborted) return
                  recordWorkerError(e)
                } finally {
                  setProgress((p) => ({ ...p, done: p.done + 1 }))
                  setItems([...pipeline])
                }
              }
            }
            const hnWorkers: Promise<void>[] = []
            const hw = Math.min(GROUNDING_CONCURRENCY, survivors.length)
            for (let i = 0; i < hw; i++) hnWorkers.push(hnWorker())
            await Promise.all(hnWorkers)
          }
        }

        // 8) Relevance grading (Phase 6, NDCG/XDCG compatibility).
        //    Stamps each kept item with `relevance_grades`. Runs locally
        //    (no LLM/search), so it is cheap to leave on by default.
        if (config.enableRelevanceGrades) {
          currentPhase++
          for (const it of pipeline) {
            if (it.rejected) continue
            const grades = computeRelevanceGrades(it)
            if (grades) {
              it.relevance_grades = grades
              if (tracing) pushTrace(it, { step: 8, phase: 'relevance', action: 'enriched', detail: { reason: `${Object.keys(grades).length} grades` } })
            }
          }
          setItems([...pipeline])
        }

        // 9) RAFT: generate CoT answers with oracle + distractor context.
        //    For each kept item, fetch distractor docs from the index via
        //    similarity search, then call LLM to generate a Chain-of-Thought
        //    answer citing the oracle document.
        if (config.enableRaftMode) {
          const survivors: number[] = []
          for (let i = 0; i < pipeline.length; i++) {
            if (!pipeline[i].rejected) survivors.push(i)
          }
          if (survivors.length > 0) {
            setProgress({ done: 0, total: survivors.length, phase: 'raft', phaseIndex: ++currentPhase, phaseTotal: totalPhases })
            const distractorCount = Math.max(1, Math.min(10, Math.floor(config.raftDistractorCount || 4)))
            const raftLlm = judgeLlm // RAFT answer generation uses judge LLM (or generation LLM)

            let raftCursor = 0
            const raftWorker = async () => {
              while (!controller.signal.aborted) {
                const localIdx = raftCursor++
                if (localIdx >= survivors.length) return
                const globalIdx = survivors[localIdx]
                const item = pipeline[globalIdx]
                try {
                  // Get oracle doc text from the sampled docs map.
                  const oracleId = item.source_doc_id || item.expected_ids[0] || ''
                  const oracleText = docTextById.get(oracleId) ?? ''
                  if (!oracleText) {
                    setProgress((p) => ({ ...p, done: p.done + 1 }))
                    continue
                  }

                  // Fetch distractor documents from the index.
                  const distractors = await fetchDistractorDocs({
                    profile,
                    indexName: config.indexName,
                    apiVersion,
                    keyField: config.keyField,
                    contentFields: config.contentFields,
                    query: item.query,
                    expectedIds: item.expected_ids,
                    count: distractorCount,
                    language,
                    signal: controller.signal,
                  })

                  // Generate CoT answer.
                  const cotAnswer = await generateRaftAnswer({
                    language: config.language,
                    question: item.query,
                    oracleDoc: { id: oracleId, text: oracleText },
                    distractorDocs: distractors,
                    llm: raftLlm,
                    signal: controller.signal,
                  })

                  if (cotAnswer) {
                    item.raft_cot_answer = cotAnswer
                    // Build the full context array for RAFT JSONL export.
                    item.raft_context = [
                      { doc_id: oracleId, text: oracleText, oracle: true },
                      ...distractors.map((d) => ({ doc_id: d.id, text: d.text, oracle: false })),
                    ]
                  }
                } catch (e) {
                  if (controller.signal.aborted) return
                  recordWorkerError(e)
                } finally {
                  setProgress((p) => ({ ...p, done: p.done + 1 }))
                  setItems([...pipeline])
                }
              }
            }
            const raftWorkers: Promise<void>[] = []
            const rw = Math.min(CONCURRENCY, survivors.length)
            for (let i = 0; i < rw; i++) raftWorkers.push(raftWorker())
            await Promise.all(raftWorkers)
          }
        }

        // 10) HyDE: generate hypothetical document passages for vector search.
        //     For each kept item, generate a hypothetical answer passage via LLM
        //     that can be used as vectorText input in AutoTuning evaluation.
        if (config.enableHydeMode) {
          const survivors: number[] = []
          for (let i = 0; i < pipeline.length; i++) {
            if (!pipeline[i].rejected) survivors.push(i)
          }
          if (survivors.length > 0) {
            setProgress({ done: 0, total: survivors.length, phase: 'hyde', phaseIndex: ++currentPhase, phaseTotal: totalPhases })
            const hydeLlm = judgeLlm // HyDE uses judge LLM (or generation LLM as fallback)
            const hydeGeneratedAt = new Date().toISOString()

            let hydeCursor = 0
            const hydeWorker = async () => {
              while (!controller.signal.aborted) {
                const localIdx = hydeCursor++
                if (localIdx >= survivors.length) return
                const globalIdx = survivors[localIdx]
                const item = pipeline[globalIdx]
                try {
                  const hypothesis = await generateHydeHypothesis({
                    language: config.language,
                    query: item.query,
                    llm: hydeLlm,
                    signal: controller.signal,
                  })
                  if (hypothesis) {
                    item.hyde_hypothesis = hypothesis
                    item.hyde_model = hydeLlm.deployment
                    item.hyde_generated_at = hydeGeneratedAt
                  }
                } catch (e) {
                  if (controller.signal.aborted) return
                  recordWorkerError(e)
                } finally {
                  setProgress((p) => ({ ...p, done: p.done + 1 }))
                  setItems([...pipeline])
                }
              }
            }
            const hydeWorkers: Promise<void>[] = []
            const hw = Math.min(CONCURRENCY, survivors.length)
            for (let i = 0; i < hw; i++) hydeWorkers.push(hydeWorker())
            await Promise.all(hydeWorkers)
          }
        }

        setProgress((p) => ({ ...p, phase: 'done', phaseIndex: totalPhases, phaseTotal: totalPhases }))
        if (firstError) {
          // Surface non-fatal errors so users notice partial failures.
          // (fatalAuthMsg is handled in `finally` so it wins even when the
          // pipeline short-circuited via controller.abort().)
          setError(firstError)
        }
      } catch (e) {
        if (e instanceof LlmAuthError) {
          if (!fatalAuthMsg) fatalAuthMsg = formatLlmAuthErrorMessage(e, edgLang)
        } else if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        if (fatalAuthMsg) {
          // Fatal LLM auth failure always wins over per-item firstError noise.
          setError(fatalAuthMsg)
        }
        setIsRunning(false)
        abortRef.current = null
      }
    },
    [profile, apiVersion, language],
  )

  return { items, isRunning, error, progress, docTextById, indexStructure, start, cancel, reset }
}
