/**
 * Text-to-vector helper modal.
 *
 * Lets the user call an embedding endpoint, inspect the resulting vector, and
 * copy/paste it into the request builder.
 */

import type { TranslationKey } from '../../lib/translations'

export function TextToVectorModal(props: {
  open: boolean
  onClose: () => void
  t: (key: TranslationKey) => string
  format: (key: TranslationKey, params: Record<string, string | number>) => string
  textToVectorEndpoint: string
  setTextToVectorEndpoint: (v: string) => void
  textToVectorApiKey: string
  setTextToVectorApiKey: (v: string) => void
  textToVectorModel: string
  setTextToVectorModel: (v: string) => void
  textToVectorDimensions: number | null
  setTextToVectorDimensions: (v: number | null) => void
  textToVectorInput: string
  setTextToVectorInput: (v: string) => void
  textToVectorLoading: boolean
  onGenerateVector: () => void
  textToVectorResult: number[] | null
  onCopyVector: () => void
  onPasteVectorToBuilder: () => void
}) {
  const {
    open,
    onClose,
    t,
    format,
    textToVectorEndpoint,
    setTextToVectorEndpoint,
    textToVectorApiKey,
    setTextToVectorApiKey,
    textToVectorModel,
    setTextToVectorModel,
    textToVectorDimensions,
    setTextToVectorDimensions,
    textToVectorInput,
    setTextToVectorInput,
    textToVectorLoading,
    onGenerateVector,
    textToVectorResult,
    onCopyVector,
    onPasteVectorToBuilder,
  } = props

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <i className="bi bi-123"></i> Text to Vector
          </h2>
          <button type="button" className="btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <label className="field field--mb16" data-guide-target="t2v-endpoint">
            <span className="field__label">{t('textToVectorEndpointLabel')}</span>
            <input
              className="field__input"
              value={textToVectorEndpoint}
              onChange={(e) => setTextToVectorEndpoint(e.target.value)}
              placeholder={String(t('textToVectorEndpointPlaceholder'))}
              disabled={textToVectorLoading}
            />
          </label>

          <label className="field field--mb16">
            <span className="field__label">
              {t('textToVectorApiKeyLabel')}
              <span className="infoTooltip infoTooltip--danger" title={String(t('textToVectorSecurityNoticeBody'))}>
                ⚠️
              </span>
            </span>
            <input
              className="field__input"
              type="password"
              value={textToVectorApiKey}
              onChange={(e) => setTextToVectorApiKey(e.target.value)}
              placeholder={String(t('textToVectorApiKeyPlaceholder'))}
              disabled={textToVectorLoading}
            />
          </label>

          <label className="field field--mb16">
            <span className="field__label">{t('textToVectorModelLabel')}</span>
            <select
              className="field__input"
              value={textToVectorModel}
              onChange={(e) => setTextToVectorModel(e.target.value)}
              disabled={textToVectorLoading}
            >
              <option value="text-embedding-ada-002">text-embedding-ada-002</option>
              <option value="text-embedding-3-small">text-embedding-3-small</option>
              <option value="text-embedding-3-large">text-embedding-3-large</option>
            </select>
          </label>

          <label className="field field--mb16">
            <span className="field__label">{t('textToVectorDimensionsLabel')}</span>
            <input
              className="field__input"
              type="number"
              min={1}
              value={textToVectorDimensions ?? ''}
              onChange={(e) => {
                const raw = e.target.value
                if (!raw.trim()) return setTextToVectorDimensions(null)
                const n = Number(raw)
                setTextToVectorDimensions(Number.isFinite(n) ? n : null)
              }}
              placeholder={String(t('textToVectorDimensionsPlaceholder'))}
              disabled={textToVectorLoading}
            />
          </label>

          <label className="field field--mb16" data-guide-target="t2v-input">
            <span className="field__label">{t('textToVectorInputLabel')}</span>
            <textarea
              className="field__textarea"
              rows={4}
              value={textToVectorInput}
              onChange={(e) => setTextToVectorInput(e.target.value)}
              placeholder={String(t('textToVectorInputPlaceholder'))}
              disabled={textToVectorLoading}
            />
          </label>

          <div className="actions actions--mb16">
            <button
              type="button"
              className="btn"
              onClick={onGenerateVector}
              disabled={textToVectorLoading || !textToVectorInput.trim()}
              data-guide-target="t2v-generate"
            >
              {textToVectorLoading ? t('textToVectorGenerating') : t('textToVectorGenerate')}
            </button>
          </div>

          {textToVectorResult && (
            <div>
              <div className="section__title">{format('textToVectorResultTitle', { n: textToVectorResult.length })}</div>
              <div className="field__textarea mono textToVector__resultBox">{textToVectorResult.join(', ')}</div>
              <div className="actions actions--mb10">
                <button type="button" className="btn" onClick={onCopyVector}>
                  📋 {t('textToVectorCopy')}
                </button>
                <button type="button" className="btn" onClick={onPasteVectorToBuilder}>
                  📎 {t('textToVectorPasteToVectorInput')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
