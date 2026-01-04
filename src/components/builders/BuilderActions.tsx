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

  return (
    <div className="actions">
      <button type="button" className="btn btn--search" onClick={onExecute} disabled={isExecuting}>
        <i className="bi bi-search icon--mr6"></i>
        {isExecuting ? (labMode === 'analyze' ? t('analyzing') : t('searching')) : labMode === 'analyze' ? t('analyze') : t('execute')}
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
