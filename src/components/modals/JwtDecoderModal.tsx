/**
 * JWT decoder modal.
 *
 * Shows parsed JWT header/payload as JSON, and optionally formats standard epoch
 * fields such as iat/nbf/exp for readability.
 */

import type { JsonValue } from '../../lib/aiSearchRest'
import type { TranslationKey } from '../../lib/translations'
import { JsonViewer } from '../viewers/JsonViewer'

export type JwtDecoderResult =
  | {
      raw: string
      header: JsonValue
      payload: JsonValue
    }
  | {
      raw: string
      error: string
    }
  | null

export function JwtDecoderModal(props: {
  open: boolean
  onClose: () => void
  jwtDecoderResult: JwtDecoderResult
  formatJwtEpochSeconds: (value: unknown) => { raw: string; utcIso: string; local: string } | null
  t?: (key: TranslationKey) => string
}) {
  const { open, onClose, jwtDecoderResult, formatJwtEpochSeconds, t } = props

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>JWT decode</h2>
          <button type="button" className="btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {jwtDecoderResult && 'error' in jwtDecoderResult ? (
            <div className="notice notice--error builder__notice">{jwtDecoderResult.error}</div>
          ) : jwtDecoderResult ? (
            <div className="form form--compact">
              {(() => {
                const payload = jwtDecoderResult.payload
                if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null

                const payloadObj = payload as Record<string, unknown>
                const iat = formatJwtEpochSeconds(payloadObj.iat)
                const nbf = formatJwtEpochSeconds(payloadObj.nbf)
                const exp = formatJwtEpochSeconds(payloadObj.exp)

                const rows: Array<{
                  key: 'iat' | 'nbf' | 'exp'
                  value: NonNullable<ReturnType<typeof formatJwtEpochSeconds>>
                }> = []
                if (iat) rows.push({ key: 'iat', value: iat })
                if (nbf) rows.push({ key: 'nbf', value: nbf })
                if (exp) rows.push({ key: 'exp', value: exp })
                if (rows.length === 0) return null

                return (
                  <div className="field">
                    <span className="field__label">timestamps</span>
                    <div className="kv kv--mb16">
                      {rows.map((r) => (
                        <div className="kv__row" key={r.key}>
                          <div className="kv__k">{r.key}</div>
                          <div className="kv__v mono">
                            {r.value.raw} → UTC: {r.value.utcIso} / Local: {r.value.local}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
              <div className="field">
                <span className="field__label">header</span>
                <div className="mono jsonViewer__body">
                  <JsonViewer data={jwtDecoderResult.header} t={t} />
                </div>
              </div>
              <div className="field">
                <span className="field__label">payload</span>
                <div className="mono jsonViewer__body">
                  <JsonViewer data={jwtDecoderResult.payload} t={t} />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
