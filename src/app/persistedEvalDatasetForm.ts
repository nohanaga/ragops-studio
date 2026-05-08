/**
 * Persistence layer for the Eval Dataset Generator (EDAG) input form.
 *
 * Stored in IndexedDB via {@link ../lib/db.ts} (under
 * `AppSettings.evalDatasetFormJson`), mirroring how Connection profile admin
 * keys are persisted. localStorage from previous versions is read once on
 * load and migrated into IndexedDB.
 */

import type { EvalLanguage, EvalQueryType } from '../types'
import type { LlmAuthMode } from '../lib/llmAuth'
import type { LlmProviderType } from '../lib/llmProvider'
import { getSettings, updateSettings } from '../lib/db'

const LEGACY_STORAGE_KEY = 'ragops.evalDatasetForm.v1'

export type PersistedEvalDatasetForm = {
  // Source
  keyField?: string
  contentFieldsText?: string
  sampleSize?: number
  queriesPerDoc?: number

  // Phase 0: Adaptive Sampling
  enableAdaptiveSampling?: boolean
  parentField?: string

  // Generation
  edgLanguage?: EvalLanguage
  queryTypes?: EvalQueryType[]
  domainDescription?: string

  // LLM (apiKey / bearerToken are persisted, mirroring the Connection
  // profile behavior which stores admin keys in IndexedDB.)
  llmProvider?: LlmProviderType
  llmEndpoint?: string
  llmAuthMode?: LlmAuthMode
  llmApiKey?: string
  llmBearerToken?: string
  llmDeployment?: string
  llmApiVersion?: string

  // Phase 2
  enableGroundingCheck?: boolean
  groundingTopK?: number
  enableSemanticDedup?: boolean
  embeddingDeployment?: string
  semanticThreshold?: number
  showRejected?: boolean

  // Phase 3 Ragas
  enableRagasMode?: boolean
  distSingleSpecific?: number
  distSingleAbstract?: number
  distMultiSpecific?: number
  distMultiAbstract?: number
  personasText?: string
  styleWebSearch?: boolean
  styleChat?: boolean
  styleFormal?: boolean
  styleInformal?: boolean
  lengthShort?: boolean
  lengthMedium?: boolean
  lengthLong?: boolean
  multiHopThreshold?: number

  // Phase 4
  enableDifficultyEvolution?: boolean
  enableHardNegativeMining?: boolean
  hardNegativeTopK?: number
  schemaEntities?: string
  schemaRelations?: string
  schemaConstraints?: string

  // Phase 6 (NDCG / KG)
  enableRelevanceGrades?: boolean
  enableEntityKG?: boolean

  // Phase 7a: Judge LLM (deployment name only)
  judgeLlmDeployment?: string

  // Phase 7b: Style Evolution (SNS mode)
  enableStyleEvolution?: boolean
  seKeyword?: boolean
  seColloquial?: boolean
  seTypo?: boolean
  seAbbreviated?: boolean
  seCodeSwitch?: boolean

  // Phase 7c: Trace
  enableTrace?: boolean

  // RAFT
  enableRaftMode?: boolean
  raftDistractorCount?: number

  // HyDE
  enableHydeMode?: boolean

  // Persistence panel
  persistTitle?: string
  selectedPersistId?: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function pickString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
function pickNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
function pickBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

const VALID_LANGUAGES: EvalLanguage[] = ['ja', 'en']
const VALID_QUERY_TYPES: EvalQueryType[] = ['factoid', 'how-to', 'comparative', 'yes-no']
const VALID_AUTH_MODES: LlmAuthMode[] = ['apiKey', 'bearer']
const VALID_LLM_PROVIDERS: LlmProviderType[] = ['azure-openai', 'openai', 'foundry-local', 'lmstudio']

function normalize(parsed: unknown): PersistedEvalDatasetForm | null {
  if (!isRecord(parsed)) return null
  const lang = pickString(parsed.edgLanguage)
  const auth = pickString(parsed.llmAuthMode)
  const prov = pickString(parsed.llmProvider)
  const qts = Array.isArray(parsed.queryTypes)
    ? (parsed.queryTypes.filter(
        (x): x is EvalQueryType =>
          typeof x === 'string' && (VALID_QUERY_TYPES as string[]).includes(x),
      ))
    : undefined

  return {
    keyField: pickString(parsed.keyField),
    contentFieldsText: pickString(parsed.contentFieldsText),
    sampleSize: pickNumber(parsed.sampleSize),
    queriesPerDoc: pickNumber(parsed.queriesPerDoc),

    enableAdaptiveSampling: pickBoolean(parsed.enableAdaptiveSampling),
    parentField: pickString(parsed.parentField),

    edgLanguage:
      lang && (VALID_LANGUAGES as string[]).includes(lang) ? (lang as EvalLanguage) : undefined,
    queryTypes: qts,
    domainDescription: pickString(parsed.domainDescription),

    llmProvider:
      prov && (VALID_LLM_PROVIDERS as string[]).includes(prov) ? (prov as LlmProviderType) : undefined,
    llmEndpoint: pickString(parsed.llmEndpoint),
    llmAuthMode:
      auth && (VALID_AUTH_MODES as string[]).includes(auth) ? (auth as LlmAuthMode) : undefined,
    llmApiKey: pickString(parsed.llmApiKey),
    llmBearerToken: pickString(parsed.llmBearerToken),
    llmDeployment: pickString(parsed.llmDeployment),
    llmApiVersion: pickString(parsed.llmApiVersion),

    enableGroundingCheck: pickBoolean(parsed.enableGroundingCheck),
    groundingTopK: pickNumber(parsed.groundingTopK),
    enableSemanticDedup: pickBoolean(parsed.enableSemanticDedup),
    embeddingDeployment: pickString(parsed.embeddingDeployment),
    semanticThreshold: pickNumber(parsed.semanticThreshold),
    showRejected: pickBoolean(parsed.showRejected),

    enableRagasMode: pickBoolean(parsed.enableRagasMode),
    distSingleSpecific: pickNumber(parsed.distSingleSpecific),
    distSingleAbstract: pickNumber(parsed.distSingleAbstract),
    distMultiSpecific: pickNumber(parsed.distMultiSpecific),
    distMultiAbstract: pickNumber(parsed.distMultiAbstract),
    personasText: pickString(parsed.personasText),
    styleWebSearch: pickBoolean(parsed.styleWebSearch),
    styleChat: pickBoolean(parsed.styleChat),
    styleFormal: pickBoolean(parsed.styleFormal),
    styleInformal: pickBoolean(parsed.styleInformal),
    lengthShort: pickBoolean(parsed.lengthShort),
    lengthMedium: pickBoolean(parsed.lengthMedium),
    lengthLong: pickBoolean(parsed.lengthLong),
    multiHopThreshold: pickNumber(parsed.multiHopThreshold),

    enableDifficultyEvolution: pickBoolean(parsed.enableDifficultyEvolution),
    enableHardNegativeMining: pickBoolean(parsed.enableHardNegativeMining),
    hardNegativeTopK: pickNumber(parsed.hardNegativeTopK),
    schemaEntities: pickString(parsed.schemaEntities),
    schemaRelations: pickString(parsed.schemaRelations),
    schemaConstraints: pickString(parsed.schemaConstraints),

    enableRelevanceGrades: pickBoolean(parsed.enableRelevanceGrades),
    enableEntityKG: pickBoolean(parsed.enableEntityKG),

    persistTitle: pickString(parsed.persistTitle),
    selectedPersistId: pickString(parsed.selectedPersistId),
  }
}

function readLegacyLocalStorage(): PersistedEvalDatasetForm | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return null
    return normalize(safeParse(raw))
  } catch {
    return null
  }
}

function clearLegacyLocalStorage(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    // ignore
  }
}

/**
 * Load the persisted form snapshot from IndexedDB. On first run after the
 * storage migration, transparently imports any existing localStorage payload
 * and removes the legacy key.
 */
export async function loadEvalDatasetForm(): Promise<PersistedEvalDatasetForm | null> {
  try {
    const settings = await getSettings()
    const json = settings.evalDatasetFormJson
    if (json) {
      const parsed = normalize(safeParse(json))
      if (parsed) return parsed
    }
    // Migration: legacy localStorage -> IndexedDB (one-shot).
    const legacy = readLegacyLocalStorage()
    if (legacy) {
      await saveEvalDatasetForm(legacy)
      clearLegacyLocalStorage()
      return legacy
    }
    return null
  } catch {
    // If IndexedDB is unavailable (e.g., private mode), fall back to legacy
    // localStorage so the user still sees their previously saved form.
    return readLegacyLocalStorage()
  }
}

export async function saveEvalDatasetForm(form: PersistedEvalDatasetForm): Promise<void> {
  try {
    await updateSettings({ evalDatasetFormJson: JSON.stringify(form) })
  } catch {
    // Best-effort; ignore quota / serialization errors.
  }
}

export async function clearEvalDatasetForm(): Promise<void> {
  try {
    await updateSettings({ evalDatasetFormJson: undefined })
  } catch {
    // ignore
  }
  clearLegacyLocalStorage()
}
