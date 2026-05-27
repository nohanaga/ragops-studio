import { isJsonObject, type JsonObject } from '../app/json'
import type { JsonValue } from '../lib/aiSearchRest'

export type CloneFieldPlan = {
  keyFieldName: string
  sourceRetrievableFieldNames: string[]
  targetFieldNames: string[]
  copyFieldNames: string[]
  skippedSourceFieldNames: string[]
  missingTargetFieldNames: string[]
}

export const RETRYABLE_INDEXING_STATUS_CODES = [408, 429, 500, 502, 503, 504]

function getFields(indexDefinition: JsonValue): JsonObject[] {
  if (!isJsonObject(indexDefinition) || !Array.isArray(indexDefinition.fields)) return []
  return indexDefinition.fields.filter((field): field is JsonObject => isJsonObject(field))
}

export function cloneIndexDefinition(sourceDefinition: JsonValue, targetIndexName: string): JsonValue {
  const clone = JSON.parse(JSON.stringify(sourceDefinition ?? {})) as JsonValue
  if (!isJsonObject(clone)) return { name: targetIndexName }
  clone.name = targetIndexName
  return clone
}

export function getIndexKeyFieldName(indexDefinition: JsonValue): string {
  const keyField = getFields(indexDefinition).find((field) => field.key === true)
  return typeof keyField?.name === 'string' ? keyField.name : ''
}

export function getIndexTopLevelFieldNames(indexDefinition: JsonValue): string[] {
  return getFields(indexDefinition)
    .map((field) => (typeof field.name === 'string' ? field.name.trim() : ''))
    .filter((name) => name.length > 0)
}

export function getRetrievableFieldNames(indexDefinition: JsonValue): string[] {
  const keyFieldName = getIndexKeyFieldName(indexDefinition)
  const names = getFields(indexDefinition)
    .filter((field) => field.retrievable !== false || field.name === keyFieldName)
    .map((field) => (typeof field.name === 'string' ? field.name.trim() : ''))
    .filter((name) => name.length > 0)
  return Array.from(new Set(names))
}

export function buildCloneFieldPlan(sourceDefinition: JsonValue, targetDefinition: JsonValue): CloneFieldPlan {
  const keyFieldName = getIndexKeyFieldName(sourceDefinition)
  const sourceRetrievableFieldNames = getRetrievableFieldNames(sourceDefinition)
  const targetFieldNames = getIndexTopLevelFieldNames(targetDefinition)
  const targetFieldSet = new Set(targetFieldNames)
  const copyFieldNames = sourceRetrievableFieldNames.filter((name) => targetFieldSet.has(name))
  const skippedSourceFieldNames = getIndexTopLevelFieldNames(sourceDefinition).filter((name) => !sourceRetrievableFieldNames.includes(name))
  const missingTargetFieldNames = sourceRetrievableFieldNames.filter((name) => !targetFieldSet.has(name))

  return {
    keyFieldName,
    sourceRetrievableFieldNames,
    targetFieldNames,
    copyFieldNames,
    skippedSourceFieldNames,
    missingTargetFieldNames,
  }
}

export function projectDocumentForIndexing(document: JsonValue, copyFieldNames: string[]): JsonObject {
  const projected: JsonObject = { '@search.action': 'upload' }
  if (!isJsonObject(document)) return projected
  const copyFieldSet = new Set(copyFieldNames)

  for (const [key, value] of Object.entries(document)) {
    if (key.startsWith('@search.')) continue
    if (!copyFieldSet.has(key)) continue
    projected[key] = value
  }

  return projected
}

export function buildIndexDocumentsPayload(documents: JsonValue[], copyFieldNames: string[]): JsonValue {
  return {
    value: documents.map((document) => projectDocumentForIndexing(document, copyFieldNames)),
  }
}

export function countIndexingFailures(response: JsonValue): number {
  if (!isJsonObject(response) || !Array.isArray(response.value)) return 0
  return response.value.filter((item) => isJsonObject(item) && item.succeeded === false).length
}

export function countIndexingSuccesses(response: JsonValue, fallbackCount: number): number {
  if (!isJsonObject(response) || !Array.isArray(response.value)) return fallbackCount
  return response.value.filter((item) => !isJsonObject(item) || item.succeeded !== false).length
}

export function getRetryableIndexingFailureKeys(
  response: JsonValue,
  retryableStatusCodes: readonly number[] = RETRYABLE_INDEXING_STATUS_CODES,
): string[] {
  if (!isJsonObject(response) || !Array.isArray(response.value)) return []
  return response.value
    .filter((item): item is JsonObject => isJsonObject(item))
    .filter((item) => {
      if (item.succeeded !== false) return false
      const statusCode = item.statusCode
      return typeof statusCode === 'number' && retryableStatusCodes.includes(statusCode)
    })
    .map((item) => (typeof item.key === 'string' ? item.key : ''))
    .filter((key) => key.length > 0)
}
