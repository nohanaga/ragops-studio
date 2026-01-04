import type { Dispatch, SetStateAction } from 'react'
import {
  createExperiment,
  deleteExperiment,
  deleteRun,
  exportRunsBundle,
  importRunsBundle,
} from '../lib/db'
import type { Experiment, Run } from '../lib/model'
import type { TranslationKey } from '../lib/translations'

type TFunction = (key: TranslationKey) => string

export function useExperimentRunActions(params: {
  t: TFunction
  selectedExperimentId: string | null
  experiments: Experiment[]
  runs: Run[]
  selectedRun: Run | null
  setSelectedRun: Dispatch<SetStateAction<Run | null>>
  setSelectedRunIds: Dispatch<SetStateAction<string[]>>
  setRuns: Dispatch<SetStateAction<Run[]>>
  reloadExperiments: (nextSelectedId?: string) => Promise<void>
  reloadRuns: (experimentId: string | null) => Promise<void>
}) {
  const {
    t,
    selectedExperimentId,
    experiments,
    runs,
    selectedRun,
    setSelectedRun,
    setSelectedRunIds,
    setRuns,
    reloadExperiments,
    reloadRuns,
  } = params

  /** Prompts for a new experiment name, creates it, and switches selection. */
  async function onCreateExperiment() {
    const name = window.prompt(t('promptExperimentName'))
    if (!name) return
    const exp = await createExperiment({ name, tags: [] })
    await reloadExperiments(exp.experimentId)
  }

  /** Deletes an experiment and cleans up related UI state (runs/tabs selection). */
  async function onDeleteExperiment(experimentId: string) {
    const ok = window.confirm(t('confirmDeleteExperiment'))
    if (!ok) return

    // Collect run IDs associated with the experiment being deleted.
    const runsToDelete = runs.filter((r) => r.experimentId === experimentId).map((r) => r.runId)

    await deleteExperiment(experimentId)
    await reloadExperiments()

    // Remove runs from the UI.
    setRuns((prev) => prev.filter((r) => r.experimentId !== experimentId))
    setSelectedRunIds((prev) => prev.filter((id) => !runsToDelete.includes(id)))

    // Clear selection if the selected run was deleted.
    if (selectedRun && selectedRun.experimentId === experimentId) {
      setSelectedRun(null)
    }
  }

  /** Deletes a single run and keeps the selected-run list consistent. */
  async function onDeleteRun(runId: string) {
    const ok = window.confirm(t('confirmDeleteRun'))
    if (!ok) return
    await deleteRun(runId)
    if (selectedExperimentId) {
      await reloadRuns(selectedExperimentId)
    }
    setSelectedRunIds((prev) => prev.filter((id) => id !== runId))
  }

  /** Deletes all currently selected runs (with confirmation) and refreshes the list. */
  async function onDeleteSelectedRuns(selectedRunIds: string[]) {
    if (selectedRunIds.length === 0) return
    const ok = window.confirm(t('confirmDeleteSelectedRuns').replace('{count}', selectedRunIds.length.toString()))
    if (!ok) return

    for (const runId of selectedRunIds) {
      await deleteRun(runId)
    }

    if (selectedExperimentId) {
      await reloadRuns(selectedExperimentId)
    }
    setSelectedRunIds([])
  }

  /** Sanitizes an arbitrary string into a safe filename fragment. */
  function sanitizeFilePart(value: string): string {
    return value
      .trim()
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .slice(0, 80)
  }

  /** Exports selected runs (and their artifacts) into a downloadable JSON file. */
  async function onExportRuns(runIds: string[]) {
    if (!selectedExperimentId) return
    try {
      const bundle = await exportRunsBundle(runIds)
      const expName = experiments.find((e) => e.experimentId === selectedExperimentId)?.name ?? 'experiment'
      const ts = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `runs-${sanitizeFilePart(expName)}-${ts}.json`

      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert(String(t('error')) + ': ' + msg)
    }
  }

  /** Imports a previously exported runs bundle into the currently selected experiment. */
  async function onImportRunsFromFile(file: File) {
    if (!selectedExperimentId) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text)
      const result = await importRunsBundle(parsed, { targetExperimentId: selectedExperimentId })
      await reloadRuns(selectedExperimentId)
      setSelectedRunIds([])
      alert(`Imported: runs=${result.importedRuns}, artifacts=${result.importedArtifacts}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert(String(t('error')) + ': ' + msg)
    }
  }

  return {
    onCreateExperiment,
    onDeleteExperiment,
    onDeleteRun,
    onDeleteSelectedRuns,
    onExportRuns,
    onImportRunsFromFile,
  }
}
