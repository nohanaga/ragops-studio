/**
 * Token counting and truncation utilities using gpt-tokenizer (o200k_base).
 *
 * o200k_base is used by all modern OpenAI models (gpt-4o, gpt-4.1, o1, o3, o4, gpt-5).
 * For non-OpenAI models (Claude, Gemini, etc.), it serves as a good approximation —
 * significantly more accurate than the naive "1 token ≈ 4 chars" heuristic,
 * especially for non-Latin scripts like Japanese.
 */
import { encode, decode, countTokens as gptCountTokens } from 'gpt-tokenizer'

/** Count the number of tokens in a text string. */
export function countTokens(text: string): number {
  if (!text) return 0
  return gptCountTokens(text)
}

/**
 * Truncate text to fit within a token limit.
 * Returns the original text if it already fits; otherwise encodes,
 * slices to `maxTokens`, and decodes back.
 */
export function truncateToTokenLimit(text: string, maxTokens: number): string {
  if (!text || maxTokens <= 0) return ''
  const tokens = encode(text)
  if (tokens.length <= maxTokens) return text
  return decode(tokens.slice(0, maxTokens))
}
