/**
 * Application-wide constants.
 *
 * Centralizes magic numbers and configuration values.
 */

// ============================================================================
// Pagination & Limits
// ============================================================================

/** Maximum number of runs to load per experiment for UI responsiveness */
export const MAX_RUNS_PER_EXPERIMENT = 200

/** Maximum number of selected run IDs to persist in localStorage */
export const MAX_PERSISTED_RUN_IDS = 10

/** Initial page number for result pagination */
export const INITIAL_PAGE_NUMBER = 1

// ============================================================================
// UI Timeouts & Delays
// ============================================================================

/** Delay in ms before focusing dropdown filter inputs */
export const DROPDOWN_FILTER_FOCUS_DELAY = 100

/** Delay in ms for dropdown active item scroll */
export const DROPDOWN_SCROLL_DELAY = 0

// ============================================================================
// String Display Limits
// ============================================================================

/** Maximum string length before truncation in JSON viewer */
export const JSON_VIEWER_MAX_STRING_LENGTH = 300

/** Initial depth to expand in JSON viewer */
export const JSON_VIEWER_INITIAL_OPEN_DEPTH = 1

/** Number of characters to show in run ID display */
export const RUN_ID_DISPLAY_LENGTH = 8

/** Number of vector dimensions to show in preview */
export const VECTOR_PREVIEW_DIMENSIONS = 3

/** Maximum length for truncated query strings */
export const QUERY_STRING_MAX_LENGTH = 50

// ============================================================================
// Persistence Keys
// ============================================================================

/** localStorage key for the most recently selected experimentId */
export const LAST_SELECTED_EXPERIMENT_ID_KEY = 'ragops:lastSelectedExperimentId'

/** localStorage key for the most recently viewed runId in the Result (latest) tab */
export const LAST_VIEWED_RUN_ID_KEY = 'ragops:lastViewedRunId'

/** localStorage key for Debug Runner storage connection string */
export const DEBUG_RUNNER_STORAGE_CONNECTION_STRING_KEY = 'ragops:debugRunner:storageConnectionString'

/** localStorage key for Debug Runner storage auth mode ('connectionString' | 'bearer') */
export const DEBUG_RUNNER_STORAGE_AUTH_MODE_KEY = 'ragops:debugRunner:storageAuthMode'

/** localStorage key for Debug Runner storage account name (bearer mode) */
export const DEBUG_RUNNER_STORAGE_ACCOUNT_NAME_KEY = 'ragops:debugRunner:storageAccountName'

/** localStorage key for Debug Runner storage bearer token (bearer mode) */
export const DEBUG_RUNNER_STORAGE_BEARER_TOKEN_KEY = 'ragops:debugRunner:storageBearerToken'

/** localStorage key for Debug Runner storage Resource ID (bearer mode, for data source / KS) */
export const DEBUG_RUNNER_STORAGE_RESOURCE_ID_KEY = 'ragops:debugRunner:storageResourceId'

/** localStorage key for Debug Runner blob container name */
export const DEBUG_RUNNER_BLOB_CONTAINER_KEY = 'ragops:debugRunner:blobContainer'

/** localStorage key for Debug Runner blob path (container.query; single file) */
export const DEBUG_RUNNER_BLOB_PATH_KEY = 'ragops:debugRunner:blobPath'

// ============================================================================
// Index Inspector
// ============================================================================

/** Token used to trigger index inspector reload */
export const INDEX_INSPECTOR_RELOAD_TOKEN_INITIAL = 0
