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

// ============================================================================
// Index Inspector
// ============================================================================

/** Token used to trigger index inspector reload */
export const INDEX_INSPECTOR_RELOAD_TOKEN_INITIAL = 0
