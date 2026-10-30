import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb'
import { openDB, unwrap } from 'idb'
import type { Artifact, Experiment, Run, SettingsRecord } from './model'

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

describe('lib/db compatibility', () => {
  let dbModule: typeof import('./db')
  const connections: Array<{ close(): void }> = []
  const timestamp = '2026-01-01T00:00:00.000Z'
  const experiment: Experiment = {
    experimentId: 'saved-experiment',
    name: 'Saved experiment',
    tags: ['saved'],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const run: Run = {
    runId: 'saved-run',
    experimentId: experiment.experimentId,
    runType: 'query',
    status: 'success',
    startedAt: timestamp,
    context: { endpoint: 'saved', apiVersion: '2025-09-01', authType: 'apiKey' },
    params: { search: 'saved query' },
    metrics: {},
    artifactIds: ['saved-artifact'],
  }
  const artifact: Artifact = {
    artifactId: 'saved-artifact',
    runId: run.runId,
    type: 'response_json',
    content: '{"value":[]}',
    createdAt: timestamp,
  }
  const settings: SettingsRecord = {
    id: 'app',
    settings: { version: 1, activeProfileId: 'saved', profiles: {}, language: 'ja' },
  }

  async function connect<T extends { close(): void }>(pending: Promise<T>): Promise<T> {
    const db = await pending
    connections.push(db)
    return db
  }

  async function seedLegacyDatabase(version = 1, omitIndexes = false) {
    const db = await connect(openDB('ragops-studio', version, {
      upgrade(db) {
        const experiments = db.createObjectStore('experiments', { keyPath: 'experimentId' })
        experiments.createIndex('by_updatedAt', 'updatedAt')
        const runs = db.createObjectStore('runs', { keyPath: 'runId' })
        runs.createIndex('by_experimentId', 'experimentId')
        runs.createIndex('by_startedAt', 'startedAt')
        const artifacts = db.createObjectStore('artifacts', { keyPath: 'artifactId' })
        artifacts.createIndex('by_runId', 'runId')
        if (!omitIndexes) {
          runs.createIndex('by_experimentId_startedAt', ['experimentId', 'startedAt'])
          artifacts.createIndex('by_runId_type', ['runId', 'type'])
        }
        db.createObjectStore('settings', { keyPath: 'id' })
        if (version > 2) db.createObjectStore('future-data')
      },
    }))
    const tx = db.transaction(['experiments', 'runs', 'artifacts', 'settings'], 'readwrite')
    await Promise.all([
      tx.objectStore('experiments').put(experiment),
      tx.objectStore('runs').put(run),
      tx.objectStore('artifacts').put(artifact),
      tx.objectStore('settings').put(settings),
    ])
    await tx.done
    return db
  }

  async function expectSavedData() {
    expect(await dbModule.listExperiments()).toEqual([experiment])
    expect(await dbModule.getRun(run.runId)).toEqual(run)
    expect(await dbModule.getArtifact(artifact.artifactId)).toEqual(artifact)
    expect(await dbModule.getSettings()).toEqual(settings.settings)
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', new IDBFactory())
    dbModule = await import('./db')
  })

  afterEach(() => {
    for (const db of connections) db.close()
    connections.length = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('creates a new database with all required stores and indexes', async () => {
    const db = await connect(dbModule.getDb())
    expect(db.version).toBe(2)
    await dbModule.ensureSeedData()
    const experiments = await dbModule.listExperiments()
    expect(experiments).toHaveLength(1)
    expect(await dbModule.listRunsByExperiment(experiments[0].experimentId)).toEqual([])
    expect(await dbModule.listArtifactsByRun('missing')).toEqual([])
    const tx = db.transaction('artifacts')
    expect(tx.store.index('by_runId_type').keyPath).toEqual(['runId', 'type'])
    await tx.done
  })

  it('keeps a compatible v1 database usable while an unpatched old tab is open', async () => {
    const oldTab = await seedLegacyDatabase()
    const versionChange = vi.fn()
    oldTab.addEventListener('versionchange', versionChange)

    const db = await connect(dbModule.getDb())
    expect(db.version).toBe(1)
    expect(versionChange).not.toHaveBeenCalled()
    await dbModule.ensureSeedData()
    await expectSavedData()
    expect(await oldTab.get('settings', 'app')).toEqual(settings)
  })

  it.each([2, 5])('opens compatible v%i databases without downgrading or losing data', async (version) => {
    const oldTab = await seedLegacyDatabase(version)
    if (version > 2) await oldTab.put('future-data', { preserved: true }, 'future')

    const db = await connect(dbModule.getDb())
    expect(db.version).toBe(version)
    await dbModule.ensureSeedData()
    await expectSavedData()
    if (version > 2) expect(await oldTab.get('future-data', 'future')).toEqual({ preserved: true })
  })

  it('adds missing indexes on existing stores without changing saved data', async () => {
    const oldDb = await seedLegacyDatabase(1, true)
    oldDb.close()

    const db = await connect(dbModule.getDb())
    expect(db.version).toBe(2)
    expect(await dbModule.listRunsByExperiment(experiment.experimentId)).toEqual([run])
    const tx = db.transaction('artifacts')
    expect(await tx.store.index('by_runId_type').get([run.runId, artifact.type])).toEqual(artifact)
    await tx.done
    await expectSavedData()
  })

  it('adds missing stores even when the database is already at the target version', async () => {
    const oldDb = await connect(openDB('ragops-studio', 2, {
      upgrade(db) {
        db.createObjectStore('settings', { keyPath: 'id' })
      },
    }))
    await oldDb.put('settings', settings)
    oldDb.close()

    const db = await connect(dbModule.getDb())
    expect(db.version).toBe(3)
    await dbModule.ensureSeedData()
    expect(await dbModule.getSettings()).toEqual(settings.settings)
    expect(await dbModule.listExperiments()).toHaveLength(1)
  })

  it('closes for an external upgrade and reconnects on the next operation', async () => {
    const db = await connect(dbModule.getDb())
    await dbModule.ensureSeedData()
    const savedExperiments = await dbModule.listExperiments()
    const newer = await connect(openDB('ragops-studio', db.version + 1, {
      upgrade(db) {
        db.createObjectStore('future-data')
      },
    }))
    await newer.put('future-data', 'preserved', 'future')

    const reconnected = await connect(dbModule.getDb())
    expect(reconnected).not.toBe(db)
    expect(reconnected.version).toBe(newer.version)
    expect(await dbModule.listExperiments()).toEqual(savedExperiments)
    expect(await newer.get('future-data', 'future')).toBe('preserved')
  })

  it('reconnects after an unexpected connection termination', async () => {
    const db = await connect(dbModule.getDb())
    await dbModule.ensureSeedData()
    const savedExperiments = await dbModule.listExperiments()
    const closed = new Promise<void>((resolve) => {
      db.addEventListener('close', () => resolve(), { once: true })
    })
    forceCloseDatabase(unwrap(db))
    await closed

    const reconnected = await connect(dbModule.getDb())
    expect(reconnected).not.toBe(db)
    expect(await dbModule.listExperiments()).toEqual(savedExperiments)
  })

  it('does not cache a failed open', async () => {
    const error = new DOMException('Database unavailable', 'UnknownError')
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => { throw error })
    await expect(dbModule.getDb()).rejects.toBe(error)

    const db = await connect(dbModule.getDb())
    expect(db.version).toBe(2)
    await dbModule.ensureSeedData()
    expect(await dbModule.listExperiments()).toHaveLength(1)
  })

  it('reports blocked migrations and retries without deleting existing data', async () => {
    const oldTab = await seedLegacyDatabase(1, true)
    await expect(dbModule.getDb()).rejects.toThrow(/tab|タブ/)
    oldTab.close()

    const db = await connect(dbModule.getDb())
    expect(db.version).toBe(2)
    await expectSavedData()
    expect(await dbModule.listRunsByExperiment(experiment.experimentId)).toEqual([run])
  })

  it('reports incompatible index definitions without resetting the database', async () => {
    const oldDb = await seedLegacyDatabase()
    oldDb.close()
    const incompatible = await connect(openDB('ragops-studio', 3, {
      upgrade(_db, _oldVersion, _newVersion, tx) {
        const store = tx.objectStore('runs')
        store.deleteIndex('by_startedAt')
        store.createIndex('by_startedAt', 'differentField')
      },
    }))
    incompatible.close()

    await expect(dbModule.getDb()).rejects.toThrow('runs.by_startedAt')
    const unchanged = await connect(openDB('ragops-studio'))
    expect(unchanged.version).toBe(3)
    expect(await unchanged.get('runs', run.runId)).toEqual(run)
    expect(await unchanged.get('settings', 'app')).toEqual(settings)
  })
})
