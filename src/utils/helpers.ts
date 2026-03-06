/**
 * Small, UI-facing helper utilities.
 *
 * Includes locale/language helpers, date formatting, and safe extraction of a
 * human-readable query string from request parameters.
 */

import type { Language } from '../lib/translations'

export function getBrowserLanguage(): Language {
  const lang = navigator.language.toLowerCase()
  if (lang.startsWith('ja')) return 'ja'
  return 'en'
}

export function formatLocalDateTime(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

import { QUERY_STRING_MAX_LENGTH } from '../app/constants'

export function extractQueryString(params: unknown): string {
  if (!params || typeof params !== 'object') return ''
  const p = params as Record<string, unknown>

  const truncate = (s: string, max = QUERY_STRING_MAX_LENGTH): string => (s.length > max ? s.slice(0, max) + '...' : s)

  const formatVectorArrayPreview = (arr: unknown): string => {
    if (!Array.isArray(arr)) return ''
    const nums = arr.filter((x) => typeof x === 'number' && Number.isFinite(x)) as number[]
    if (nums.length === 0) return ''
    const head = nums.slice(0, 3).map((n) => n.toFixed(3)).join(', ')
    const suffix = nums.length > 3 ? ', ...' : ''
    return `[${head}${suffix}]`
  }
  
  // If a `search` parameter exists (prefer `search` for hybrid/semantic_hybrid).
  if (typeof p.search === 'string' && p.search.trim()) {
    return truncate(p.search)
  }

  // If `vectorQueries` exists (vector only)
  // - kind=text: show `text`
  // - kind=vector: show short numeric preview like [0.123, 0.456, ...]
  if (Array.isArray(p.vectorQueries) && p.vectorQueries.length > 0) {
    const first = p.vectorQueries[0]
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const vq = first as Record<string, unknown>
      const kind = typeof vq.kind === 'string' ? vq.kind : ''

      if (kind === 'text' && typeof vq.text === 'string' && vq.text.trim()) {
        return truncate(vq.text.trim())
      }

      if (kind === 'vector' && Array.isArray(vq.vector)) {
        const preview = formatVectorArrayPreview(vq.vector)
        if (preview) return preview
      }
    }
  }

  // If analyze `text` exists.
  if (typeof p.text === 'string' && p.text.trim()) {
    return truncate(p.text)
  }

  // If `messages` exists (agentic retrieval request shape).
  if (Array.isArray(p.messages) && p.messages.length > 0) {
    const msg = p.messages[0]
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      const msgObj = msg as Record<string, unknown>
      if (typeof msgObj.content === 'string' && msgObj.content.trim()) {
        return truncate(msgObj.content)
      }

      if (Array.isArray(msgObj.content) && msgObj.content.length > 0) {
        const firstContent = msgObj.content[0]
        if (firstContent && typeof firstContent === 'object' && !Array.isArray(firstContent)) {
          const contentObj = firstContent as Record<string, unknown>
          if (typeof contentObj.text === 'string' && contentObj.text.trim()) {
            return truncate(contentObj.text)
          }
        }
      }
    }
  }
  
  // If `userMessages` exists (legacy agentic shape).
  if (Array.isArray(p.userMessages) && p.userMessages.length > 0) {
    const msg = p.userMessages[0]
    if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
      const msgObj = msg as Record<string, unknown>
      if (typeof msgObj.content === 'string' && msgObj.content.trim()) {
        return truncate(msgObj.content)
      }
    }
  }
  
  return ''
}

export function sanitizeEndpoint(value: string): string {
  return value.trim()
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n))
}
