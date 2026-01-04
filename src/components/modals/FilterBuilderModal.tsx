/**
 * Modal wrapper for the `$filter` visual builder.
 *
 * Hosts `FilterQueryBuilder` in a lightweight overlay so users can edit complex
 * OData filter expressions without leaving the main form.
 */

import type { ConnectionProfile } from '../../lib/model'
import type { Language } from '../../lib/translations'
import { FilterQueryBuilder } from '../builders/FilterQueryBuilder'

export function FilterBuilderModal(props: {
  open: boolean
  onClose: () => void
  profile: ConnectionProfile | null
  apiVersion: string
  indexName: string
  value: string
  onChange: (next: string) => void
  language: Language
}) {
  const { open, onClose, profile, apiVersion, indexName, value, onChange, language } = props

  if (!open) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Filter Query Builder</h2>
          <button type="button" className="btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <FilterQueryBuilder
            profile={profile}
            apiVersion={apiVersion}
            indexName={indexName}
            value={value}
            onChange={onChange}
            language={language}
          />
        </div>
      </div>
    </div>
  )
}
