import type { JsonValue } from '../lib/aiSearchRest'

export type JsonObject = { [key: string]: JsonValue }

/** Runtime type guard for JSON objects (excluding arrays and null). */
export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
