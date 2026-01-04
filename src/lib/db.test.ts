import { beforeEach, describe, expect, it } from 'vitest'

import {
  addArtifact,
  createExperiment,
  createRun,
  deleteExperiment,
  ensureSeedData,
  getArtifact,
  getDb,
  getExperiment,
  getRun,
  getSettings,
  listExperiments,
  updateExperiment,
} from './db'

async function clearAllStores() {
  const db = await getDb()
  const tx = db.transaction(['experiments', 'runs', 'artifacts', 'settings'], 'readwrite')
  await Promise.all([
    tx.objectStore('experiments').clear(),
    tx.objectStore('runs').clear(),
    tx.objectStore('artifacts').clear(),
    tx.objectStore('settings').clear(),
  ])
  await tx.done
}

describe('lib/db (IndexedDB)', () => {
  beforeEach(async () => {
    await clearAllStores()
  })

  it('ensureSeedData seeds settings and a starter experiment', async () => {
    await ensureSeedData()

    const settings = await getSettings()
    expect(settings.version).toBe(1)
    expect(typeof settings.activeProfileId).toBe('string')

    const exps = await listExperiments()
    expect(exps.length).toBe(1)
    expect(exps[0].pinned).toBe(true)
    expect(exps[0].name).toBeTruthy()
  })

  it('createExperiment trims name and defaults to untitled', async () => {
    const exp = await createExperiment({ name: '   ' })
    expect(exp.name).toBe('untitled')

    const stored = await getExperiment(exp.experimentId)
    expect(stored?.name).toBe('untitled')
  })

  it('updateExperiment keeps createdAt and updates updatedAt', async () => {
    const exp = await createExperiment({ name: 'A' })
    const createdAt = exp.createdAt

    // Ensure clock ticks so updatedAt is observably different.
    await new Promise((r) => setTimeout(r, 5))

    const updated = await updateExperiment(exp.experimentId, { name: 'B' })

    expect(updated.createdAt).toBe(createdAt)
    expect(updated.updatedAt).not.toBe(createdAt)
  })

  it('deleteExperiment cascades runs and artifacts', async () => {
    const exp = await createExperiment({ name: 'E' })

    const run = await createRun({
      experimentId: exp.experimentId,
      runType: 'query',
      status: 'success',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      context: { endpoint: 'x', apiVersion: '2025-09-01', authType: 'apiKey' },
      params: { a: 1 },
      metrics: {},
    })

    const artifact = await addArtifact({ runId: run.runId, type: 'request_json', content: '{"a":1}' })

    await deleteExperiment(exp.experimentId)

    expect(await getExperiment(exp.experimentId)).toBeUndefined()
    expect(await getRun(run.runId)).toBeUndefined()
    expect(await getArtifact(artifact.artifactId)).toBeUndefined()

    const exps = await listExperiments()
    expect(exps.find((e) => e.experimentId === exp.experimentId)).toBeUndefined()
  })
})
