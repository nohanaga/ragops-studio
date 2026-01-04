/**
 * Raw request JSON editor.
 *
 * Provides a simple textarea-based editor and a lightweight JSON validity check
 * to surface parsing errors immediately.
 */

import type React from 'react'

export type RequestJsonEditorProps = {
  requestJson: string
  setRequestJson: React.Dispatch<React.SetStateAction<string>>
}

export function RequestJsonEditor(props: RequestJsonEditorProps) {
  const { requestJson, setRequestJson } = props

  return (
    <>
      <label className="field">
        <span className="field__label">request (JSON)</span>
        <textarea
          className="field__textarea mono"
          value={requestJson}
          onChange={(e) => setRequestJson(e.target.value)}
          rows={16}
        />
      </label>

      {(() => {
        try {
          if (requestJson.trim()) {
            JSON.parse(requestJson.trim())
          }
          return null
        } catch (e) {
          return (
            <div className="appJsonError">
              ⚠️ Invalid JSON: {e instanceof Error ? e.message : String(e)}
            </div>
          )
        }
      })()}
    </>
  )
}
