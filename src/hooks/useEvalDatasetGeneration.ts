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
import { computeRelevanceGrades, dedupBySurface, generateForDoc, generateForScenario, hardenQuery } from '../lib/evalDatasetGenerator'
import { sampleDocsFromIndex } from '../lib/evalDatasetSampling'
import { checkGrounding, mineHardNegatives } from '../lib/evalDatasetGrounding'
import { embedTexts, findSemanticDuplicates } from '../lib/evalDatasetEmbeddings'
import { planScenarios } from '../lib/evalDatasetRagas'
import { extractEntities } from '../lib/evalDatasetEntities'
import type { EvalDatasetGenerationConfig, GeneratedQAItem } from '../types'

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
  | 'sampling'
  | 'generating'
  | 'grounding'
  | 'embedding'
  | 'difficulty'
  | 'hardneg'
  | 'done'

export interface UseEvalDatasetGenerationResult {
  items: GeneratedQAItem[]
  isRunning: boolean
  error: string | null
  progress: { done: number; total: number; phase: EdgPhase }
  /** Map of doc id → original content text (only populated for the latest run's sample). */
  docTextById: Record<string, string>
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

export function useEvalDatasetGeneration(
  params: UseEvalDatasetGenerationParams,
): UseEvalDatasetGenerationResult {
  const { profile, apiVersion, language } = params

  const [items, setItems] = useState<GeneratedQAItem[]>([])
  const [docTextById, setDocTextById] = useState<Record<string, string>>({})
  const [isRunning, setIsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; phase: EdgPhase }>({
    done: 0,
    total: 0,
    phase: 'idle',
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
    setError(null)
    setProgress({ done: 0, total: 0, phase: 'idle' })
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
      setProgress({ done: 0, total: 0, phase: 'sampling' })

      const runId = newRunId()
      const generatedAt = new Date().toISOString()

      try {
        // 1) Sample docs.
        const docs = await sampleDocsFromIndex({
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

        // Publish sampled doc texts so the UI can preview content per expected_id.
        {
          const map: Record<string, string> = {}
          for (const d of docs) map[d.id] = d.text
          setDocTextById(map)
        }

        setProgress({ done: 0, total: docs.length, phase: 'generating' })

        // 2) Generate queries with bounded concurrency.
        //    Ragas mode plans scenarios across the 4-quadrant taxonomy
        //    (single/multi × specific/abstract). Classic mode generates
        //    M queries per doc.
        const llm = {
          endpoint: config.llmEndpoint,
          auth: config.llmAuth,
          deployment: config.llmDeployment,
          apiVersion: config.llmApiVersion,
        }
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

        if (config.enableRagasMode) {
          // -------- Ragas scenario pipeline --------
          const totalQueries = Math.max(1, docs.length * config.queriesPerDoc)

          // Phase 6 (Entity-KG): optional LLM entity extraction per doc.
          // On failure for a given doc we silently fall back to token Jaccard
          // for that doc, so the pipeline never blocks on extraction errors.
          let entitySetsById: Record<string, Set<string>> | undefined
          if (config.enableEntityKG) {
            setProgress({ done: 0, total: docs.length, phase: 'generating' })
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
                  // Per-doc failure is non-fatal; we just lose KG signal for it.
                  if (controller.signal.aborted) return
                  const msg = e instanceof Error ? e.message : String(e)
                  if (!firstError) firstError = msg
                } finally {
                  setProgress((p) => ({ done: p.done + 1, total: p.total, phase: p.phase }))
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
          setProgress({ done: 0, total: slots.length, phase: 'generating' })

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
                const msg = e instanceof Error ? e.message : String(e)
                if (!firstError) firstError = msg
              } finally {
                setProgress((p) => ({ done: p.done + 1, total: p.total, phase: p.phase }))
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
                const msg = e instanceof Error ? e.message : String(e)
                if (!firstError) firstError = msg
              } finally {
                setProgress((p) => ({ done: p.done + 1, total: p.total, phase: p.phase }))
              }
            }
          }
          const workers: Promise<void>[] = []
          const w = Math.min(CONCURRENCY, docs.length)
          for (let i = 0; i < w; i++) workers.push(worker())
          await Promise.all(workers)
        }

        if (controller.signal.aborted) return

        // 3) Surface dedup (Jaccard).
        const pipeline: GeneratedQAItem[] = dedupBySurface(collected, SURFACE_DEDUP_THRESHOLD)
        setItems(pipeline)

        // 4) Round-trip consistency filter (Phase 2.1).
        if (config.enableGroundingCheck) {
          setProgress({ done: 0, total: pipeline.length, phase: 'grounding' })
          const topK = Math.max(1, Math.min(50, Math.floor(config.groundingTopK || 10)))

          let gCursor = 0
          const gWorker = async () => {
            while (!controller.signal.aborted) {
              const idx = gCursor++
              if (idx >= pipeline.length) return
              const item = pipeline[idx]
              // For multi-hop items, accept the query as grounded if ANY of the
              // expected docs is retrieved within top-k (best rank wins).
              const candidateIds =
                item.expected_ids.length > 0
                  ? item.expected_ids
                  : item.source_doc_id
                    ? [item.source_doc_id]
                    : []
              if (candidateIds.length === 0) {
                item.grounding_rank = 0
                item.grounding_top_k = topK
                item.rejected = true
                item.rejection_reason = 'grounding'
                setProgress((p) => ({ done: p.done + 1, total: p.total, phase: p.phase }))
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
                }
              } catch (e) {
                if (controller.signal.aborted) return
                const msg = e instanceof Error ? e.message : String(e)
                if (!firstError) firstError = msg
              } finally {
                setProgress((p) => ({ done: p.done + 1, total: p.total, phase: p.phase }))
              }
            }
          }

          const gWorkers: Promise<void>[] = []
          const gw = Math.min(GROUNDING_CONCURRENCY, pipeline.length)
          for (let i = 0; i < gw; i++) gWorkers.push(gWorker())
          await Promise.all(gWorkers)
          setItems([...pipeline])

          if (controller.signal.aborted) return
        }

        // 5) Semantic dedup via embeddings (Phase 2.2).
        if (config.enableSemanticDedup && config.embeddingDeployment?.trim()) {
          const survivorIdx: number[] = []
          for (let i = 0; i < pipeline.length; i++) {
            if (!pipeline[i].rejected) survivorIdx.push(i)
          }
          if (survivorIdx.length >= 2) {
            setProgress({ done: 0, total: survivorIdx.length, phase: 'embedding' })
            try {
              const queries = survivorIdx.map((i) => pipeline[i].query)
              const vectors = await embedTexts({
                endpoint: config.llmEndpoint,
                auth: config.llmAuth,
                deployment: config.embeddingDeployment.trim(),
                apiVersion: config.llmApiVersion,
                inputs: queries,
                signal: controller.signal,
              })
              setProgress({ done: survivorIdx.length, total: survivorIdx.length, phase: 'embedding' })
              const dropped = findSemanticDuplicates(vectors, config.semanticDedupThreshold)
              for (const localIdx of dropped) {
                const globalIdx = survivorIdx[localIdx]
                pipeline[globalIdx].rejected = true
                pipeline[globalIdx].rejection_reason = 'semantic-dup'
              }
              setItems([...pipeline])
            } catch (e) {
              if (controller.signal.aborted) return
              const msg = e instanceof Error ? e.message : String(e)
              if (!firstError) firstError = msg
            }
          }
        }

        // Build id → text lookup once for difficulty rewrite (Phase 4.2).
        const docTextById = new Map<string, string>()
        for (const d of docs) docTextById.set(d.id, d.text)

        // 6) Difficulty Evolution (Phase 4.2, Evol-Instruct).
        //    Sequentially rewrites each kept query into a HARDER variant.
        //    On parse error the original query is kept verbatim.
        if (config.enableDifficultyEvolution) {
          const survivors: number[] = []
          for (let i = 0; i < pipeline.length; i++) {
            if (!pipeline[i].rejected) survivors.push(i)
          }
          if (survivors.length > 0) {
            setProgress({ done: 0, total: survivors.length, phase: 'difficulty' })
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
                  setProgress((p) => ({ done: p.done + 1, total: p.total, phase: p.phase }))
                  continue
                }
                try {
                  const harder = await hardenQuery({
                    language: config.language,
                    query: item.query,
                    contextText: ctx,
                    llm,
                    signal: controller.signal,
                  })
                  if (harder) {
                    item.query = harder
                    item.difficulty = 'hard'
                  }
                } catch (e) {
                  if (controller.signal.aborted) return
                  const msg = e instanceof Error ? e.message : String(e)
                  if (!firstError) firstError = msg
                } finally {
                  setProgress((p) => ({ done: p.done + 1, total: p.total, phase: p.phase }))
                }
              }
            }
            const dWorkers: Promise<void>[] = []
            const dw = Math.min(CONCURRENCY, survivors.length)
            for (let i = 0; i < dw; i++) dWorkers.push(dWorker())
            await Promise.all(dWorkers)
            setItems([...pipeline])
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
            setProgress({ done: 0, total: survivors.length, phase: 'hardneg' })
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
                  if (negatives.length > 0) item.hard_negative_ids = negatives
                } catch (e) {
                  if (controller.signal.aborted) return
                  const msg = e instanceof Error ? e.message : String(e)
                  if (!firstError) firstError = msg
                } finally {
                  setProgress((p) => ({ done: p.done + 1, total: p.total, phase: p.phase }))
                }
              }
            }
            const hnWorkers: Promise<void>[] = []
            const hw = Math.min(GROUNDING_CONCURRENCY, survivors.length)
            for (let i = 0; i < hw; i++) hnWorkers.push(hnWorker())
            await Promise.all(hnWorkers)
            setItems([...pipeline])
          }
        }

        // 8) Relevance grading (Phase 6, NDCG/XDCG compatibility).
        //    Stamps each kept item with `relevance_grades`. Runs locally
        //    (no LLM/search), so it is cheap to leave on by default.
        if (config.enableRelevanceGrades) {
          for (const it of pipeline) {
            if (it.rejected) continue
            const grades = computeRelevanceGrades(it)
            if (grades) it.relevance_grades = grades
          }
          setItems([...pipeline])
        }

        setProgress((p) => ({ ...p, phase: 'done' }))
        if (firstError) {
          // Surface non-fatal errors so users notice partial failures.
          setError(firstError)
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        setIsRunning(false)
        abortRef.current = null
      }
    },
    [profile, apiVersion, language],
  )

  return { items, isRunning, error, progress, docTextById, start, cancel, reset }
}
