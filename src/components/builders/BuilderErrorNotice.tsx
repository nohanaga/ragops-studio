/**
 * Error banner for builder execution.
 *
 * Shows the most recent UI error and optional detail payload, with quick
 * actions to copy the detail to clipboard or clear the error state.
 */

import type React from 'react'

import { translations } from '../../lib/translations'
import type { UiLogEntry } from '../../types'

type TranslationKey = keyof typeof translations.ja

export type BuilderErrorNoticeProps = {
  t: (key: TranslationKey) => string
  uiError: string | null
  uiLog: UiLogEntry | null

  setUiError: React.Dispatch<React.SetStateAction<string | null>>
  setUiLog: React.Dispatch<React.SetStateAction<UiLogEntry | null>>

  copyToClipboard: (text: string) => Promise<void>
}

export function BuilderErrorNotice(props: BuilderErrorNoticeProps) {
  const { t, uiError, uiLog, setUiError, setUiLog, copyToClipboard } = props

  if (!uiError) return null

  return (
    <div className="notice notice--error" role="status" aria-live="polite">
      <div className="notice__title">{t('errorTitle')}</div>
      <div className="notice__meta">{uiError}</div>
      {uiLog?.detail && <pre className="mono notice__pre">{uiLog.detail}</pre>}
      <div className="notice__actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            if (!uiLog?.detail) return
            void copyToClipboard(uiLog.detail)
          }}
          disabled={!uiLog?.detail}
        >
          {t('copyLog')}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setUiError(null)
            setUiLog(null)
          }}
        >
          {t('clearError')}
        </button>
      </div>
    </div>
  )
}
