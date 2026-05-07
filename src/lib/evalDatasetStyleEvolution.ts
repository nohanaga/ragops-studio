/**
 * Style Evolution (SNS mode) — degrade clean LLM-generated queries
 * into surface forms that mimic real user traffic.
 *
 * 5 degradation kinds:
 *   keyword       – strip particles/connectives → noun-list style
 *   colloquial    – casual / spoken form (e.g. 「〜って何」)
 *   typo          – random char substitution / deletion
 *   abbreviated   – drop subject / object for contextual brevity
 *   code_switch   – mix ja/en in one query
 */

import type { StyleEvolutionKind } from '../types'
import { callAzureOpenAIChat } from './evalDatasetGenerator'
import type { LlmAuth } from './llmAuth'
import type { LlmProviderType } from './llmProvider'

const ALL_KINDS: StyleEvolutionKind[] = [
  'keyword',
  'colloquial',
  'typo',
  'abbreviated',
  'code_switch',
]

/** Pick a random element from the allowed kinds. */
function pickKind(kinds: StyleEvolutionKind[]): StyleEvolutionKind {
  const pool = kinds.length > 0 ? kinds : ALL_KINDS
  return pool[Math.floor(Math.random() * pool.length)]
}

/** Build a system prompt for style devolution. */
function buildStyleDevolSystemPrompt(kind: StyleEvolutionKind, language: string): string {
  const kindInstructions: Record<StyleEvolutionKind, string> = {
    keyword:
      'Rewrite the query as a keyword-only search query — remove all particles, connectives, and verbs. Output only nouns/noun-phrases separated by spaces.',
    colloquial:
      'Rewrite the query as if it were a casual tweet or social media post (Twitter/X style). Use slang, sentence fragments, emoji-free raw text, dropped particles, trailing "…" or "w" (Japanese) / "lol" (English), casual abbreviations, and messy grammar. It should feel like a real person typed it quickly on their phone — NOT like a polished chatbot message. Examples of Japanese colloquial: 「〜ってなに」「〜わからんのだけど」「〜教えて」「まじで〜」.',
    typo:
      'Introduce 1–2 realistic typos into the query (adjacent key substitution, missing character, or duplicated character). Keep the query otherwise unchanged and understandable.',
    abbreviated:
      'Shorten the query by dropping the subject, obvious context words, and redundant particles. A real user would type the minimum they expect the search engine to understand.',
    code_switch:
      'Rewrite the query mixing Japanese and English naturally (code-switching). Replace 1–3 content words with their English (or Japanese) equivalent while keeping the query coherent.',
  }

  return [
    'You are a query surface-form editor.',
    `Task: ${kindInstructions[kind]}`,
    `The query language is: ${language}.`,
    'Output ONLY the rewritten query — no explanation, no quotes.',
    'If the query is already in the target style, return it unchanged.',
  ].join('\n')
}

export interface DegradeQueryParams {
  endpoint: string
  auth: LlmAuth
  deployment: string
  apiVersion: string
  provider?: LlmProviderType
  query: string
  language: string
  allowedKinds: StyleEvolutionKind[]
  signal?: AbortSignal
}

export interface DegradeResult {
  degraded: string
  kind: StyleEvolutionKind
}

/**
 * Degrade a single query via LLM.
 * The returned `kind` tells the caller which degradation was applied.
 */
export async function degradeQuery(params: DegradeQueryParams): Promise<DegradeResult> {
  const kind = pickKind(params.allowedKinds)
  const systemPrompt = buildStyleDevolSystemPrompt(kind, params.language)
  const content = await callAzureOpenAIChat({
    endpoint: params.endpoint,
    auth: params.auth,
    deployment: params.deployment,
    apiVersion: params.apiVersion,
    provider: params.provider,
    systemPrompt,
    userPrompt: params.query,
    signal: params.signal,
    jsonMode: false,
  })
  // The LLM should return the degraded query directly.
  // Strip wrapping quotes / backticks the model sometimes adds, then normalise Unicode.
  let degraded = content.trim()
  degraded = degraded.replace(/^["'`「『]+|["'`」』]+$/g, '').trim()
  degraded = degraded.normalize('NFC') || params.query
  return { degraded, kind }
}
