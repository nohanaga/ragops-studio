/**
 * Client-side persistence layer (IndexedDB).
 *
 * Stores experiments, runs, artifacts, and user settings in a browser-only DB.
 * Treat it as an operational cache that users can export/import.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { v4 as uuidv4 } from 'uuid';
import type { Artifact, Experiment, Run, SettingsRecord } from './model';
import { translations, type Language } from './translations';

export type RunsExportBundleV1 = {
  kind: 'ragops-studio:runs';
  version: 1;
  exportedAt: string;
  runs: Run[];
  artifacts: Artifact[];
};

const DB_NAME = 'ragops-studio';
const DB_VERSION = 1;

interface LabDbSchema extends DBSchema {
  experiments: {
    key: string;
    value: Experiment;
    indexes: { 'by_updatedAt': string };
  };
  runs: {
    key: string;
    value: Run;
    indexes: {
      'by_experimentId': string;
      'by_experimentId_startedAt': [string, string];
      'by_startedAt': string;
    };
  };
  artifacts: {
    key: string;
    value: Artifact;
    indexes: { 'by_runId': string; 'by_runId_type': [string, string] };
  };
  settings: {
    key: string;
    value: SettingsRecord;
  };
}

let dbPromise: Promise<IDBPDatabase<LabDbSchema>> | undefined;

function nowIso(): string {
  return new Date().toISOString();
}

export async function getDb(): Promise<IDBPDatabase<LabDbSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<LabDbSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Schema creation is idempotent; upgrade runs once per version.
        if (!db.objectStoreNames.contains('experiments')) {
          const experiments = db.createObjectStore('experiments', {
            keyPath: 'experimentId',
          });
          experiments.createIndex('by_updatedAt', 'updatedAt');
        }

        if (!db.objectStoreNames.contains('runs')) {
          const runs = db.createObjectStore('runs', { keyPath: 'runId' });
          runs.createIndex('by_experimentId', 'experimentId');
          runs.createIndex('by_experimentId_startedAt', [
            'experimentId',
            'startedAt',
          ]);
          runs.createIndex('by_startedAt', 'startedAt');
        }

        if (!db.objectStoreNames.contains('artifacts')) {
          const artifacts = db.createObjectStore('artifacts', {
            keyPath: 'artifactId',
          });
          artifacts.createIndex('by_runId', 'runId');
          artifacts.createIndex('by_runId_type', ['runId', 'type']);
        }

        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'id' });
        }
      },
    });
  }

  return dbPromise;
}

export async function ensureSeedData(language: Language = 'en'): Promise<void> {
  const db = await getDb();

  const tx = db.transaction(['experiments', 'settings'], 'readwrite');
  const settingsStore = tx.objectStore('settings');
  const experimentsStore = tx.objectStore('experiments');

  const existingSettings = await settingsStore.get('app');
  if (!existingSettings) {
    // Initial settings bootstrap: provide a default profile and sensible field candidates.
    await settingsStore.put({
      id: 'app',
      settings: {
        version: 1,
        activeProfileId: 'default',
        profiles: {
          default: {
            endpoint: 'https://<your-service-name>.search.windows.net',
            apiVersion: '2026-05-01-preview',
            authType: 'apiKey',
          },
        },
        displayTitleFields: 'title,name,id,key,documentId,chunkId,path,url,metadata_storage_name',
        displayTextFields: 'text,content,description,chunk',
      },
    });
  }

  const count = await experimentsStore.count();
  if (count === 0) {
    // First-run experience: create a starter experiment so the UI is usable immediately.
    const createdAt = nowIso();
    await experimentsStore.put({
      experimentId: uuidv4(),
      name: 'Experiment 1',
      description: translations[language].dbFirstExperimentDescription,
      tags: [],
      pinned: true,
      createdAt,
      updatedAt: createdAt,
      defaultContext: {
        apiVersion: '2026-05-01-preview',
      },
    });
  }

  await tx.done;
}

export async function listExperiments(): Promise<Experiment[]> {
  const db = await getDb();
  const experiments = await db.getAll('experiments');
  experiments.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return experiments;
}

export async function getExperiment(experimentId: string): Promise<Experiment | undefined> {
  const db = await getDb();
  return db.get('experiments', experimentId);
}

export async function createExperiment(input: {
  name: string;
  description?: string;
  tags?: string[];
  pinned?: boolean;
  defaultContext?: Experiment['defaultContext'];
}): Promise<Experiment> {
  const db = await getDb();
  const createdAt = nowIso();
  const experiment: Experiment = {
    experimentId: uuidv4(),
    name: input.name.trim() || 'untitled',
    description: input.description,
    tags: input.tags ?? [],
    pinned: input.pinned ?? false,
    createdAt,
    updatedAt: createdAt,
    defaultContext: input.defaultContext,
  };

  await db.put('experiments', experiment);
  return experiment;
}

export async function updateExperiment(experimentId: string, patch: Partial<Omit<Experiment, 'experimentId' | 'createdAt'>>): Promise<Experiment> {
  const db = await getDb();
  const existing = await db.get('experiments', experimentId);
  if (!existing) throw new Error('Experiment not found');

  const updated: Experiment = {
    ...existing,
    ...patch,
    experimentId,
    createdAt: existing.createdAt,
    updatedAt: nowIso(),
  };

  await db.put('experiments', updated);
  return updated;
}

export async function deleteExperiment(experimentId: string): Promise<void> {
  const db = await getDb();
  // Use a single transaction so experiment/runs/artifacts stay consistent.
  const tx = db.transaction(['experiments', 'runs', 'artifacts'], 'readwrite');

  const runsIndex = tx.objectStore('runs').index('by_experimentId');
  let cursor = await runsIndex.openCursor(experimentId);
  while (cursor) {
    const runId = cursor.primaryKey;

    // Delete artifacts for each run, then delete the run record.
    const artifactsIndex = tx.objectStore('artifacts').index('by_runId');
    let aCursor = await artifactsIndex.openCursor(runId as string);
    while (aCursor) {
      await aCursor.delete();
      aCursor = await aCursor.continue();
    }

    await cursor.delete();
    cursor = await cursor.continue();
  }

  await tx.objectStore('experiments').delete(experimentId);
  await tx.done;
}

export async function listRunsByExperiment(experimentId: string, options?: { limit?: number }): Promise<Run[]> {
  const db = await getDb();
  const index = db.transaction('runs').store.index('by_experimentId_startedAt');

  const lower = [experimentId, ''] as [string, string];
  const upper = [experimentId, '\uffff'] as [string, string];
  const range = IDBKeyRange.bound(lower, upper);

  const runs: Run[] = [];
  let cursor = await index.openCursor(range, 'prev');
  while (cursor) {
    runs.push(cursor.value);
    if (options?.limit && runs.length >= options.limit) break;
    cursor = await cursor.continue();
  }

  return runs;
}

export async function getRun(runId: string): Promise<Run | undefined> {
  const db = await getDb();
  return db.get('runs', runId);
}

export async function createRun(run: Omit<Run, 'runId' | 'artifactIds'> & { artifactIds?: string[] }): Promise<Run> {
  const db = await getDb();
  const record: Run = {
    ...run,
    runId: uuidv4(),
    artifactIds: run.artifactIds ?? [],
  };
  await db.put('runs', record);

  // Touch the parent experiment so it bubbles up in "recent" ordering.
  await updateExperiment(record.experimentId, {});
  return record;
}

export async function updateRun(runId: string, patch: Partial<Omit<Run, 'runId' | 'experimentId'>>): Promise<Run> {
  const db = await getDb();
  const existing = await db.get('runs', runId);
  if (!existing) throw new Error('Run not found');

  const updated: Run = {
    ...existing,
    ...patch,
    runId,
    experimentId: existing.experimentId,
  };

  await db.put('runs', updated);
  await updateExperiment(updated.experimentId, {});
  return updated;
}

export async function deleteRun(runId: string): Promise<void> {
  const db = await getDb();
  const existing = await db.get('runs', runId);

  const tx = db.transaction(['runs', 'artifacts'], 'readwrite');
  const artifactsIndex = tx.objectStore('artifacts').index('by_runId');

  let cursor = await artifactsIndex.openCursor(runId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }

  await tx.objectStore('runs').delete(runId);
  await tx.done;

  if (existing) await updateExperiment(existing.experimentId, {});
}

export async function addArtifact(input: Omit<Artifact, 'artifactId' | 'createdAt'> & { createdAt?: string }): Promise<Artifact> {
  const db = await getDb();
  const artifact: Artifact = {
    artifactId: uuidv4(),
    runId: input.runId,
    type: input.type,
    content: input.content,
    createdAt: input.createdAt ?? nowIso(),
  };

  const tx = db.transaction(['artifacts', 'runs'], 'readwrite');
  await tx.objectStore('artifacts').put(artifact);

  const run = await tx.objectStore('runs').get(input.runId);
  if (run) {
    if (!run.artifactIds.includes(artifact.artifactId)) {
      run.artifactIds.push(artifact.artifactId);
      await tx.objectStore('runs').put(run);
    }
  }

  await tx.done;
  return artifact;
}

export async function listArtifactsByRun(runId: string): Promise<Artifact[]> {
  const db = await getDb();
  const artifacts = await db.getAllFromIndex('artifacts', 'by_runId', runId);
  artifacts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return artifacts;
}

export async function exportRunsBundle(runIds: string[]): Promise<RunsExportBundleV1> {
  const uniqueRunIds = Array.from(new Set(runIds)).filter(Boolean);
  if (uniqueRunIds.length === 0) {
    return {
      kind: 'ragops-studio:runs',
      version: 1,
      exportedAt: nowIso(),
      runs: [],
      artifacts: [],
    };
  }

  const db = await getDb();
  const tx = db.transaction(['runs', 'artifacts'], 'readonly');
  const runsStore = tx.objectStore('runs');
  const artifactsByRunId = tx.objectStore('artifacts').index('by_runId');

  const runs: Run[] = [];
  const artifacts: Artifact[] = [];

  for (const runId of uniqueRunIds) {
    const run = await runsStore.get(runId);
    if (!run) continue;
    runs.push(run);
    const runArtifacts = await artifactsByRunId.getAll(runId);
    artifacts.push(...runArtifacts);
  }

  await tx.done;
  return {
    kind: 'ragops-studio:runs',
    version: 1,
    exportedAt: nowIso(),
    runs,
    artifacts,
  };
}

function isRunsExportBundleV1(value: unknown): value is RunsExportBundleV1 {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<RunsExportBundleV1>;
  return v.kind === 'ragops-studio:runs' && v.version === 1 && Array.isArray(v.runs) && Array.isArray(v.artifacts);
}

export async function importRunsBundle(
  bundle: unknown,
  options: { targetExperimentId: string }
): Promise<{ importedRuns: number; importedArtifacts: number; newRunIds: string[] }> {
  if (!isRunsExportBundleV1(bundle)) {
    throw new Error('Invalid runs export format');
  }

  const { targetExperimentId } = options;
  if (!targetExperimentId) throw new Error('targetExperimentId is required');

  const db = await getDb();
  const targetExperiment = await db.get('experiments', targetExperimentId);
  if (!targetExperiment) throw new Error('Target experiment not found');

  const tx = db.transaction(['runs', 'artifacts'], 'readwrite');
  const runsStore = tx.objectStore('runs');
  const artifactsStore = tx.objectStore('artifacts');

  const runIdMap = new Map<string, string>();
  const newRuns: Run[] = [];

  for (const run of bundle.runs) {
    if (!run || typeof run !== 'object') continue;
    const newRunId = uuidv4();
    runIdMap.set(run.runId, newRunId);

    const record: Run = {
      ...run,
      runId: newRunId,
      experimentId: targetExperimentId,
      artifactIds: [],
    };

    newRuns.push(record);
    await runsStore.put(record);
  }

  const runArtifactIds = new Map<string, string[]>();
  let importedArtifacts = 0;

  for (const artifact of bundle.artifacts) {
    if (!artifact || typeof artifact !== 'object') continue;
    const newRunId = runIdMap.get(artifact.runId);
    if (!newRunId) continue;

    const newArtifactId = uuidv4();
    const record: Artifact = {
      ...artifact,
      artifactId: newArtifactId,
      runId: newRunId,
    };

    await artifactsStore.put(record);
    importedArtifacts += 1;

    const ids = runArtifactIds.get(newRunId) ?? [];
    ids.push(newArtifactId);
    runArtifactIds.set(newRunId, ids);
  }

  for (const run of newRuns) {
    const ids = runArtifactIds.get(run.runId) ?? [];
    if (ids.length === 0) continue;
    await runsStore.put({ ...run, artifactIds: ids });
  }

  await tx.done;
  await updateExperiment(targetExperimentId, {});

  return {
    importedRuns: newRuns.length,
    importedArtifacts,
    newRunIds: newRuns.map((r) => r.runId),
  };
}

export async function getArtifact(artifactId: string): Promise<Artifact | undefined> {
  const db = await getDb();
  return db.get('artifacts', artifactId);
}

export async function getSettings(): Promise<SettingsRecord['settings']> {
  const db = await getDb();
  const record = await db.get('settings', 'app');
  if (!record) {
    await ensureSeedData();
    const fresh = await db.get('settings', 'app');
    if (!fresh) throw new Error('Settings initialization failed');
    return fresh.settings;
  }
  return record.settings;
}

export async function updateSettings(patch: Partial<SettingsRecord['settings']>): Promise<SettingsRecord['settings']> {
  const db = await getDb();
  const current = await getSettings();
  const next = { ...current, ...patch };
  await db.put('settings', { id: 'app', settings: next });
  return next;
}
