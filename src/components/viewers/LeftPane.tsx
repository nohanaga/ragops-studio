/**
 * Left-side navigation pane.
 *
 * Hosts experiment/run lists, basic search/filter UI, and resize affordances.
 */

import { useRef } from 'react'
import type React from 'react'

import { extractQueryString, formatLocalDateTime } from '../../utils'
import type { PaneSizes } from '../../types'
import type { Experiment, Run } from '../../lib/model'
import { translations } from '../../lib/translations'

type TranslationKey = keyof typeof translations.ja

export type LeftPaneProps = {
  t: (key: TranslationKey) => string

  paneSizes: PaneSizes

  // Experiments
  experiments: Experiment[]
  selectedExperimentId: string | null
  onCreateExperiment: () => void
  onSelectExperiment: (experimentId: string) => void
  onDeleteExperiment: (experimentId: string) => void

  // Resize (experiments height)
  isVerticalDragging: boolean
  onStartResizeExperiments: (e: React.PointerEvent<HTMLDivElement>) => void

  // Runs
  runsCount: number
  filteredRuns: Run[]
  activeRunId: string | null
  selectedRunIds: string[]
  runQueryFilterText: string
  onRunQueryFilterTextChange: (text: string) => void
  onDeleteSelectedRuns: () => void
  onDeleteRun: (runId: string) => void
  onToggleRunSelection: (runId: string, checked: boolean) => void
  onRestoreRun: (runId: string) => void

  onExportRuns: (runIds: string[]) => void
  onImportRunsFromFile: (file: File) => void
}

export function LeftPane(props: LeftPaneProps) {
  const {
    t,
    paneSizes,
    experiments,
    selectedExperimentId,
    onCreateExperiment,
    onSelectExperiment,
    onDeleteExperiment,
    isVerticalDragging,
    onStartResizeExperiments,
    runsCount,
    filteredRuns,
    activeRunId,
    selectedRunIds,
    runQueryFilterText,
    onRunQueryFilterTextChange,
    onDeleteSelectedRuns,
    onDeleteRun,
    onToggleRunSelection,
    onRestoreRun,
    onExportRuns,
    onImportRunsFromFile,
  } = props

  const importFileInputRef = useRef<HTMLInputElement | null>(null)

  const selectedExperimentName = selectedExperimentId
    ? (experiments.find((e) => e.experimentId === selectedExperimentId)?.name ?? selectedExperimentId)
    : null

  return (
    <aside className="pane pane--left">
      <div className="pane__header">
        <div className="pane__title">{t('experiments')}</div>
        <button type="button" className="btn" onClick={onCreateExperiment}>
          +
        </button>
      </div>

      <div className="list" style={{ height: `${paneSizes.experimentsHeightPx}px` }}>
        {experiments.map((exp) => (
          <div
            key={exp.experimentId}
            className={'list__row ' + (exp.experimentId === selectedExperimentId ? 'list__row--active' : '')}
          >
            <button
              type="button"
              className="list__main"
              onClick={() => onSelectExperiment(exp.experimentId)}
              title={exp.description ?? ''}
            >
              <div className="list__primary">{exp.name}</div>
              <div className="list__secondary">{exp.tags.join(' / ')}</div>
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => onDeleteExperiment(exp.experimentId)}
              aria-label="delete experiment"
              title={t('deleteButtonTitle')}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div
        className={'splitter splitter--horizontal' + (isVerticalDragging ? ' splitter--active' : '')}
        role="separator"
        aria-orientation="horizontal"
        aria-label="resize experiments pane"
        onPointerDown={onStartResizeExperiments}
      />

      <div className="pane__header pane__header--spaced">
        <div className="pane__headerStack">
          <div className="pane__title">{t('runs')}</div>
          {selectedExperimentName && <div className="pane__headerSubtitle">{selectedExperimentName}</div>}
        </div>
        <div className="pane__headerActions">
          <button
            type="button"
            className="btn btn--xs"
            onClick={() => {
              const runIds = (selectedRunIds.length > 0 ? selectedRunIds : filteredRuns.map((r) => r.runId)).filter(Boolean)
              onExportRuns(runIds)
            }}
            disabled={!selectedExperimentId || (selectedRunIds.length === 0 && filteredRuns.length === 0)}
            title={t('exportRunsTitle')}
            aria-label={t('exportRunsTitle')}
          >
            <i className="bi bi-download"></i>
          </button>

          <button
            type="button"
            className="btn btn--xs"
            onClick={() => importFileInputRef.current?.click()}
            disabled={!selectedExperimentId}
            title={t('importRunsTitle')}
            aria-label={t('importRunsTitle')}
          >
            <i className="bi bi-upload"></i>
          </button>
          <input
            ref={importFileInputRef}
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0]
              e.currentTarget.value = ''
              if (!file) return
              onImportRunsFromFile(file)
            }}
          />

          {selectedRunIds.length > 0 && (
            <button
              type="button"
              className="btn btn--danger btn--xs pane__dangerBtnSm"
              onClick={onDeleteSelectedRuns}
              title={t('deleteSelectedTitle').replace('{count}', selectedRunIds.length.toString())}
            >
              ×
            </button>
          )}
          <div className="pane__meta">{selectedExperimentId ? runsCount : 0}</div>
        </div>
      </div>

      <div className="list list--fill">
        <div className="list__filter">
          <input
            type="text"
            className="field__input"
            value={runQueryFilterText}
            onChange={(e) => onRunQueryFilterTextChange(e.target.value)}
            placeholder={t('runQuerySearchPlaceholder')}
            aria-label={t('runQuerySearchPlaceholder')}
          />
        </div>

        {filteredRuns.map((run) => {
          const checked = selectedRunIds.includes(run.runId)
          const isActive = !!activeRunId && activeRunId === run.runId
          return (
            <div
              key={run.runId}
              className={'list__row list__row--run' + (isActive ? ' list__row--active' : '')}
            >
              <button
                type="button"
                className="btn btn--danger btn--xs list__runDelete"
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteRun(run.runId)
                }}
                aria-label="delete run"
                title={t('deleteButtonTitle')}
              >
                ×
              </button>
              <label className="list__runCheckbox">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => onToggleRunSelection(run.runId, e.target.checked)}
                />
              </label>
              <div className={`run run--${run.status} run--clickable`} onClick={() => onRestoreRun(run.runId)}>
                <div className="run__top">
                  <span className={`run__type run__type--${run.runType}`}>{run.runType}</span>
                  {extractQueryString(run.params) && (
                    <span
                      className="run__queryPreview"
                      style={{ maxWidth: `${Math.max(50, paneSizes.leftPx - 200)}px` }}
                    >
                      {extractQueryString(run.params)}
                    </span>
                  )}
                </div>
                <div className="run__bottom">
                  <span className="mono mono--ellipsesSm">{formatLocalDateTime(run.startedAt)}</span>
                </div>
                <div className="run__bottom">
                  <span className="mono mono--ellipsesXsMuted">ID: {run.runId}</span>
                </div>
              </div>
            </div>
          )
        })}

        {filteredRuns.length === 0 && <div className="empty">{t('noRuns')}</div>}
      </div>
    </aside>
  )
}
