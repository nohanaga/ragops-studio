import { useCallback, useState } from 'react'
import type { JsonValue } from '../lib/aiSearchRest'
import type { JwtDecoderResult } from '../components/modals/JwtDecoderModal'

/**
 * JWT decoder modal state + helpers.
 *
 * Keeps the decode/format logic out of App.tsx.
 */
export function useJwtDecoderModal() {
  const [isJwtDecoderOpen, setIsJwtDecoderOpen] = useState(false)
  const [jwtDecoderResult, setJwtDecoderResult] = useState<JwtDecoderResult>(null)

  const base64UrlToUint8Array = useCallback((b64url: string): Uint8Array => {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const bin = atob(padded)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return bytes
  }, [])

  const decodeJwtJsonPart = useCallback((part: string): JsonValue => {
    const bytes = base64UrlToUint8Array(part)
    const text = new TextDecoder().decode(bytes)
    return JSON.parse(text) as JsonValue
  }, [base64UrlToUint8Array])

  const formatJwtEpochSeconds = useCallback((value: unknown): { raw: string; utcIso: string; local: string } | null => {
    const seconds =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : NaN

    if (!Number.isFinite(seconds)) return null
    const date = new Date(seconds * 1000)
    if (Number.isNaN(date.getTime())) return null

    return {
      raw: String(value),
      utcIso: date.toISOString(),
      local: date.toLocaleString(),
    }
  }, [])

  const openJwtDecoder = useCallback((rawInputValue: string) => {
    const rawInput = rawInputValue.trim()
    if (!rawInput) {
      setJwtDecoderResult({ raw: '', error: 'token が未入力です' })
      setIsJwtDecoderOpen(true)
      return
    }

    const token = rawInput.toLowerCase().startsWith('bearer ') ? rawInput.slice(7).trim() : rawInput
    const parts = token.split('.')

    try {
      if (parts.length === 3) {
        const header = decodeJwtJsonPart(parts[0])
        const payload = decodeJwtJsonPart(parts[1])
        setJwtDecoderResult({ raw: token, header, payload })
      } else if (parts.length === 5) {
        // JWE: the header is visible, but the payload is encrypted.
        const header = decodeJwtJsonPart(parts[0])
        setJwtDecoderResult({
          raw: token,
          error:
            'JWE (5 parts) は header のみ decode できます。payload は暗号化されているため表示できません。\n\nheader: ' +
            JSON.stringify(header, null, 2),
        })
      } else {
        setJwtDecoderResult({ raw: token, error: 'JWT/JWE として解釈できません（segments が不正です）' })
      }
    } catch (e) {
      setJwtDecoderResult({ raw: token, error: e instanceof Error ? e.message : String(e) })
    }

    setIsJwtDecoderOpen(true)
  }, [decodeJwtJsonPart])

  return {
    isJwtDecoderOpen,
    setIsJwtDecoderOpen,
    jwtDecoderResult,
    setJwtDecoderResult,
    openJwtDecoder,
    formatJwtEpochSeconds,
  }
}
