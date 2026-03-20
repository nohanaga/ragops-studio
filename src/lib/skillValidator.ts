/**
 * Custom Skill Interface validator.
 *
 * Validates request/response payloads against the Azure AI Search
 * Custom Web API Skill interface specification.
 *
 * @see https://learn.microsoft.com/azure/search/cognitive-search-custom-skill-interface
 * @see https://learn.microsoft.com/azure/search/cognitive-search-custom-skill-web-api
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ValidationSeverity = 'error' | 'warning'

export interface ValidationResult {
  severity: ValidationSeverity
  message: string
  path?: string
}

/** A single record inside the `values` array. */
export interface SkillRecord {
  recordId: string
  data: Record<string, unknown>
  errors?: Array<{ message: string }>
  warnings?: Array<{ message: string }>
}

/** Top-level request/response body shape. */
export interface SkillPayload {
  values: SkillRecord[]
}

// ---------------------------------------------------------------------------
// Constants (from Microsoft Learn docs)
// ---------------------------------------------------------------------------

/** Max timeout for custom skills (seconds). */
export const MAX_TIMEOUT_SECONDS = 230

/** Default batch size. */
export const DEFAULT_BATCH_SIZE = 1000

/** Max degreeOfParallelism. */
export const MAX_DEGREE_OF_PARALLELISM = 10

/** Min degreeOfParallelism. */
export const MIN_DEGREE_OF_PARALLELISM = 1

/** Recommended max response size in bytes. */
export const RECOMMENDED_MAX_RESPONSE_BYTES = 150 * 1024 * 1024 // 150 MB

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/**
 * Validate a Custom Skill **request** payload.
 *
 * Checks:
 * - Top-level `values` array exists and is non-empty
 * - Every record has a non-empty `recordId` (string)
 * - Every record has a `data` object
 * - No duplicate `recordId` values
 */
export function validateRequest(body: unknown): ValidationResult[] {
  const results: ValidationResult[] = []

  if (!isRecord(body)) {
    results.push({ severity: 'error', message: 'Request body must be a JSON object.' })
    return results
  }

  if (!Array.isArray(body.values)) {
    results.push({ severity: 'error', message: '`values` must be an array.', path: 'values' })
    return results
  }

  if (body.values.length === 0) {
    results.push({ severity: 'warning', message: '`values` array is empty.', path: 'values' })
  }

  const seenIds = new Set<string>()

  for (let i = 0; i < body.values.length; i++) {
    const record = body.values[i]
    const prefix = `values[${i}]`

    if (!isRecord(record)) {
      results.push({ severity: 'error', message: `${prefix} must be a JSON object.`, path: prefix })
      continue
    }

    // recordId
    if (typeof record.recordId !== 'string' || record.recordId.trim() === '') {
      results.push({ severity: 'error', message: `${prefix}.recordId must be a non-empty string.`, path: `${prefix}.recordId` })
    } else {
      if (seenIds.has(record.recordId)) {
        results.push({ severity: 'error', message: `Duplicate recordId "${record.recordId}" at ${prefix}.`, path: `${prefix}.recordId` })
      }
      seenIds.add(record.recordId)
    }

    // data
    if (!isRecord(record.data)) {
      results.push({ severity: 'error', message: `${prefix}.data must be a JSON object.`, path: `${prefix}.data` })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------

/**
 * Validate a Custom Skill **response** payload.
 *
 * Checks:
 * - Top-level `values` array exists
 * - Every record has a `recordId` and `data` object
 * - `errors` and `warnings` arrays (if present) contain `{ message }` objects
 * - recordIds match what was sent in the request (if `requestRecordIds` provided)
 * - Response size stays under recommended limit
 */
export function validateResponse(
  body: unknown,
  options?: { requestRecordIds?: string[]; rawBytes?: number },
): ValidationResult[] {
  const results: ValidationResult[] = []

  if (!isRecord(body)) {
    results.push({ severity: 'error', message: 'Response body must be a JSON object.' })
    return results
  }

  if (!Array.isArray(body.values)) {
    results.push({ severity: 'error', message: '`values` must be an array.', path: 'values' })
    return results
  }

  const responseIds: string[] = []

  for (let i = 0; i < body.values.length; i++) {
    const record = body.values[i]
    const prefix = `values[${i}]`

    if (!isRecord(record)) {
      results.push({ severity: 'error', message: `${prefix} must be a JSON object.`, path: prefix })
      continue
    }

    // recordId
    if (typeof record.recordId !== 'string' || record.recordId.trim() === '') {
      results.push({ severity: 'error', message: `${prefix}.recordId must be a non-empty string.`, path: `${prefix}.recordId` })
    } else {
      responseIds.push(record.recordId)
    }

    // data
    if (!isRecord(record.data)) {
      results.push({ severity: 'error', message: `${prefix}.data must be a JSON object.`, path: `${prefix}.data` })
    }

    // errors (optional)
    if (record.errors !== undefined) {
      if (!Array.isArray(record.errors)) {
        results.push({ severity: 'error', message: `${prefix}.errors must be an array.`, path: `${prefix}.errors` })
      } else {
        for (let j = 0; j < record.errors.length; j++) {
          const e = record.errors[j]
          if (!isRecord(e) || typeof e.message !== 'string') {
            results.push({
              severity: 'warning',
              message: `${prefix}.errors[${j}] should have a "message" string.`,
              path: `${prefix}.errors[${j}]`,
            })
          }
        }
      }
    }

    // warnings (optional)
    if (record.warnings !== undefined) {
      if (!Array.isArray(record.warnings)) {
        results.push({ severity: 'error', message: `${prefix}.warnings must be an array.`, path: `${prefix}.warnings` })
      } else {
        for (let j = 0; j < record.warnings.length; j++) {
          const w = record.warnings[j]
          if (!isRecord(w) || typeof w.message !== 'string') {
            results.push({
              severity: 'warning',
              message: `${prefix}.warnings[${j}] should have a "message" string.`,
              path: `${prefix}.warnings[${j}]`,
            })
          }
        }
      }
    }
  }

  // recordId matching
  if (options?.requestRecordIds) {
    const reqSet = new Set(options.requestRecordIds)
    const resSet = new Set(responseIds)

    for (const id of reqSet) {
      if (!resSet.has(id)) {
        results.push({ severity: 'error', message: `Request recordId "${id}" is missing in the response.` })
      }
    }
    for (const id of resSet) {
      if (!reqSet.has(id)) {
        results.push({ severity: 'warning', message: `Response contains unexpected recordId "${id}".` })
      }
    }
  }

  // Size check
  if (options?.rawBytes != null && options.rawBytes > RECOMMENDED_MAX_RESPONSE_BYTES) {
    results.push({
      severity: 'warning',
      message: `Response size (${(options.rawBytes / 1024 / 1024).toFixed(1)} MB) exceeds the recommended 150 MB limit.`,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Skill definition validation
// ---------------------------------------------------------------------------

/**
 * Validate a WebApiSkill definition object.
 *
 * Checks skill parameters against the Custom Web API Skill spec.
 */
export function validateSkillDefinition(skill: unknown): ValidationResult[] {
  const results: ValidationResult[] = []

  if (!isRecord(skill)) {
    results.push({ severity: 'error', message: 'Skill definition must be a JSON object.' })
    return results
  }

  // uri
  if (typeof skill.uri === 'string') {
    if (!skill.uri.startsWith('https://')) {
      results.push({ severity: 'error', message: 'Skill URI must use the HTTPS scheme.', path: 'uri' })
    }
  }

  // timeout
  if (typeof skill.timeout === 'string') {
    const match = skill.timeout.match(/^PT(\d+)S$/)
    if (match) {
      const secs = parseInt(match[1], 10)
      if (secs > MAX_TIMEOUT_SECONDS) {
        results.push({ severity: 'error', message: `timeout (${secs}s) exceeds the maximum of ${MAX_TIMEOUT_SECONDS}s.`, path: 'timeout' })
      }
      if (secs < 1) {
        results.push({ severity: 'error', message: `timeout must be at least 1 second.`, path: 'timeout' })
      }
    }
  }

  // batchSize
  if (typeof skill.batchSize === 'number') {
    if (skill.batchSize < 1) {
      results.push({ severity: 'error', message: 'batchSize must be at least 1.', path: 'batchSize' })
    }
  }

  // degreeOfParallelism
  if (typeof skill.degreeOfParallelism === 'number') {
    if (skill.degreeOfParallelism < MIN_DEGREE_OF_PARALLELISM || skill.degreeOfParallelism > MAX_DEGREE_OF_PARALLELISM) {
      results.push({
        severity: 'error',
        message: `degreeOfParallelism must be between ${MIN_DEGREE_OF_PARALLELISM} and ${MAX_DEGREE_OF_PARALLELISM}.`,
        path: 'degreeOfParallelism',
      })
    }
  }

  // httpMethod
  if (typeof skill.httpMethod === 'string') {
    const method = skill.httpMethod.toUpperCase()
    if (method !== 'PUT' && method !== 'POST') {
      results.push({ severity: 'error', message: 'httpMethod must be "PUT" or "POST".', path: 'httpMethod' })
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Quick helpers
// ---------------------------------------------------------------------------

/** Check whether a payload is structurally valid as a Custom Skill request. */
export function isValidRequest(body: unknown): boolean {
  return validateRequest(body).filter((r) => r.severity === 'error').length === 0
}

/** Check whether a payload is structurally valid as a Custom Skill response. */
export function isValidResponse(body: unknown): boolean {
  return validateResponse(body).filter((r) => r.severity === 'error').length === 0
}

/** Extract recordIds from a request payload (returns [] on invalid input). */
export function extractRecordIds(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.values)) return []
  return body.values
    .filter((v: unknown) => isRecord(v) && typeof v.recordId === 'string')
    .map((v: Record<string, unknown>) => v.recordId as string)
}

/** Build a minimal Custom Skill request template. */
export function buildSampleRequest(): SkillPayload {
  return {
    values: [
      {
        recordId: '1',
        data: {
          text: 'Azure AI Search custom skill sample text for local testing.',
        },
      },
    ],
  }
}

/** Build a minimal Custom Skill response template. */
export function buildSampleResponse(): SkillPayload {
  return {
    values: [
      {
        recordId: '1',
        data: {},
        errors: [],
        warnings: [],
      },
    ],
  }
}
