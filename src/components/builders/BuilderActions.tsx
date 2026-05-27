/**
 * Builder action buttons.
 *
 * Centralizes the Execute / Execute All Modes / Clear actions so the tab pane
 * can stay focused on state wiring.
 */

import type { BuilderMode, LabMode } from '../../types'
import { translations } from '../../lib/translations'

type TranslationKey = keyof typeof translations.ja

export type BuilderActionsProps = {
  t: (key: TranslationKey) => string

  builderMode: BuilderMode
  labMode: LabMode

  isExecuting: boolean
  onExecute: () => void
  onExecuteAllModes: () => void
  onClearAll: () => void
}

export function BuilderActions(props: BuilderActionsProps) {
  const { t, builderMode, labMode, isExecuting, onExecute, onExecuteAllModes, onClearAll } = props

  const executeLabel = (() => {
    if (isExecuting) {
      if (labMode === 'analyze') return t('analyzing')
      if (labMode === 'autocomplete' || labMode === 'suggest') return t('typeaheadRealtimeTesting')
      return t('searching')
    }
    if (labMode === 'analyze') return t('analyze')
    if (labMode === 'autocomplete') return t('autocomplete')
    if (labMode === 'suggest') return t('suggest')
    return t('execute')
  })()

  return (
    <div className="actions">
      <button type="button" className="btn btn--search" onClick={onExecute} disabled={isExecuting} data-guide-target="execute-button">
        <i className="bi bi-search icon--mr6"></i>
        {executeLabel}
      </button>
      {builderMode === 'form' && labMode === 'semantic-vector' && (
        <button type="button" className="btn btn--multi-mode" onClick={onExecuteAllModes} disabled={isExecuting}>
          <i className="bi bi-bar-chart-steps icon--mr6"></i>
          {t('executeAllModes')}
        </button>
      )}
      <button type="button" className="btn" onClick={onClearAll} disabled={isExecuting}>
        <i className="bi bi-eraser icon--mr6"></i>
        {t('clear')}
      </button>
    </div>
  )
}
