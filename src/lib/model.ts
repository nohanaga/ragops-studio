/**
 * Shared domain models and type definitions.
 *
 * These types are used across UI, persistence (IndexedDB), and REST operations.
 */

import type { LlmProviderType } from './llmProvider'

/**
 * Named LLM model configuration profile.
 *
 * Users can define multiple profiles (e.g. "GPT-4o", "GPT-4.1-mini") and
 * select one per feature.  Stored in AppSettings.llmProfiles.
 */
/** Model category. `'chat'` for Chat Completions, `'embeddings'` for Embeddings. */
export type LlmModelType = 'chat' | 'embeddings'

export interface LlmModelProfile {
  /** Unique ID (UUID). */
  id: string
  /** User-facing display name. */
  name: string
  provider: LlmProviderType
  endpoint: string
  authMode: 'apiKey' | 'bearer'
  apiKey: string
  bearerToken: string
  deployment: string
  apiVersion: string
  /** Max input tokens override. When undefined/0, auto-detected from model name. */
  maxInputTokens?: number
  /** Model category. Defaults to `'chat'` when undefined (backward compat). */
  modelType?: LlmModelType
}

export type AuthType = 'apiKey' | 'bearer';

export type RunStatus = 'success' | 'error' | 'canceled';

export type RunType =
  | 'query'
  | 'semantic'
  | 'vector'
  | 'hybrid'
  | 'semantic_hybrid'
  | 'qps_test'
  | 'auto_tuning'
  | 'agentic_retrieve'
  | 'analyze'
  | 'autocomplete'
  | 'suggest'
  | 'kb_create'
  | 'kb_update'
  | 'kb_delete'
  | 'kb_list'
  | 'ks_create'
  | 'ks_delete'
  | 'ks_list'
  | 'other';

export type IsoDateTime = string;

export type SearchApiVersion =
  | '2026-04-01'
  | '2025-11-01-preview'
  | '2025-09-01'
  | '2025-05-01-preview'
  | '2025-03-01-preview'
  | '2024-11-01-preview'
  | '2024-09-01-preview'
  | '2024-07-01'
  | '2024-05-01-preview'
  | '2023-11-01'
  | (string & {});

export interface ConnectionProfile {
  endpoint: string;
  apiVersion: SearchApiVersion;
  authType: AuthType;
  apiKey?: string;
  bearerToken?: string;
  querySourceAuthorization?: string;
  useQuerySourceAuthorization?: boolean;
  enableElevatedRead?: boolean;
}

export interface Experiment {
  experimentId: string;
  name: string;
  description?: string;
  tags: string[];
  pinned?: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  defaultContext?: Partial<RunContext>;
}

export interface RunContext {
  endpoint: string;
  apiVersion: SearchApiVersion;
  authType: AuthType;
  indexName?: string;
  knowledgeBaseName?: string;
}

export interface RunMetrics {
  latencyMs?: number;
  elapsedTimeMs?: number;
  httpStatus?: number;
  /** Service-generated request id (e.g. response header `request-id`). */
  serviceRequestId?: string;
  /** Client-generated request id (sent as `x-ms-client-request-id`). */
  clientRequestId?: string;
  resultCount?: number;
  p50Score?: number;
  maxScore?: number;
  bytesIn?: number;
  bytesOut?: number;
}

export interface Run {
  runId: string;
  experimentId: string;
  runType: RunType;
  status: RunStatus;
  startedAt: IsoDateTime;
  endedAt?: IsoDateTime;
  context: RunContext;
  params: unknown;
  metrics: RunMetrics;
  artifactIds: string[];
  note?: string;
}

export type ArtifactType =
  | 'request_json'
  | 'response_json'
  | 'response_table'
  | 'curl'
  | 'diff'
  | 'note';

export interface Artifact {
  artifactId: string;
  runId: string;
  type: ArtifactType;
  content: string;
  createdAt: IsoDateTime;
}

export interface AppSettings {
  version: 1;
  activeProfileId: string;
  profiles: Record<string, ConnectionProfile>;
  /** Named LLM model profiles (replaces flat llmProvider/openAi* fields). */
  llmProfiles?: LlmModelProfile[];
  /** ID of the default LLM profile used when a feature has no explicit selection. */
  defaultLlmProfileId?: string;
  /** @deprecated — migrated into llmProfiles[0] on first load */
  llmProvider?: LlmProviderType;
  /** @deprecated */ openAiEndpoint?: string;
  /** @deprecated */ openAiApiKey?: string;
  /** @deprecated */ openAiAuthMode?: 'apiKey' | 'bearer';
  /** @deprecated */ openAiBearerToken?: string;
  /** @deprecated */ llmDeployment?: string;
  /** @deprecated */ llmApiVersion?: string;
  language?: 'ja' | 'en';
  displayTitleFields?: string;
  displayTextFields?: string;
  evalDatasetFormJson?: string;
}

export interface SettingsRecord {
  id: 'app';
  settings: AppSettings;
}
