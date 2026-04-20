/**
 * Phase 6 (Entity-KG): LLM-based entity extraction for multi-hop pairing.
 *
 * Extracts a small bag of normalized entities (proper nouns, named
 * concepts, technical terms) from a sampled document. Entity sets per
 * document are then used by `findDocPairsByEntities` in
 * {@link ./evalDatasetRagas.ts} to find multi-hop candidates whose entity
 * vocabularies overlap, which is a closer approximation to a true KG than
 * surface token Jaccard.
 *
 * Failure mode: if extraction fails (network, JSON parse, abort), the
 * caller transparently falls back to token Jaccard for that doc.
 */

import type { EvalLanguage } from '../types'
import type { LlmAuth } from './llmAuth'
import { callAzureOpenAIChat } from './evalDatasetGenerator'

export interface ExtractEntitiesParams {
  language: EvalLanguage
  text: string
  llm: {
    endpoint: string
    auth: LlmAuth
    deployment: string
    apiVersion: string
  }
  /** Cap for entities per document. Defaults to 12. */
  maxEntities?: number
  signal?: AbortSignal
}

/** Truncate to the same 4000-char window used by the main generation pass. */
const MAX_CHARS = 4000

const SYSTEM_PROMPT_EN = [
  'You are an information extraction assistant for a RAG evaluation pipeline.',
  'Given a single document excerpt, extract the most important named',
  'entities and domain-specific concepts (proper nouns, products, services,',
  'persons, organisations, technical terms, locations, dates).',
  'Output JSON ONLY: { "entities": ["..."] }.',
  'Rules: each entity is a short noun phrase (<= 6 words), lowercased,',
  'whitespace-trimmed, NFKC-normalised. Do not include verbs, adjectives,',
  'adverbs, or filler words. Avoid duplicates and near-duplicates.',
].join(' ')

const SYSTEM_PROMPT_JA = [
  'あなたは RAG 評価パイプラインのための情報抽出アシスタントです。',
  '与えられたドキュメント抜粋から、最も重要な固有名詞・ドメイン用語',
  '(製品名・サービス名・人物・組織・技術用語・場所・日付など) を抽出してください。',
  '出力は JSON のみ: { "entities": ["..."] }。',
  'ルール: 各エンティティは短い名詞句 (6 語以内)、小文字化・NFKC 正規化済み。',
  '動詞・形容詞・副詞・冗長語は含めないこと。重複や類似語は避けること。',
].join(' ')

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * Parse `{ entities: string[] }` defensively. Returns a deduped, normalized,
 * length-capped Set so downstream Jaccard math is consistent.
 */
export function parseEntityResponse(raw: string, maxEntities = 12): Set<string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return new Set()
  }
  if (!parsed || typeof parsed !== 'object') return new Set()
  const arr = (parsed as { entities?: unknown }).entities
  if (!Array.isArray(arr)) return new Set()
  const out = new Set<string>()
  for (const v of arr) {
    if (typeof v !== 'string') continue
    const n = normalize(v)
    if (!n) continue
    if (n.split(/\s+/).length > 6) continue
    out.add(n)
    if (out.size >= maxEntities) break
  }
  return out
}

/**
 * Run a single entity extraction LLM call for one document.
 * Throws on transport / API errors so the caller can decide whether to
 * retry or fall back. Returns an empty Set when the model returns nothing
 * usable.
 */
export async function extractEntities(
  params: ExtractEntitiesParams,
): Promise<Set<string>> {
  const { language, text, llm, maxEntities = 12, signal } = params
  if (!text.trim()) return new Set()
  const excerpt = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text
  const systemPrompt = language === 'ja' ? SYSTEM_PROMPT_JA : SYSTEM_PROMPT_EN
  const raw = await callAzureOpenAIChat({
    endpoint: llm.endpoint,
    auth: llm.auth,
    deployment: llm.deployment,
    apiVersion: llm.apiVersion,
    systemPrompt,
    userPrompt: excerpt,
    signal,
  })
  return parseEntityResponse(raw, maxEntities)
}
