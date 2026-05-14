import { useEffect, useMemo, useState } from 'react'
import type { ConnectionProfile } from '../lib/model'
import { getIndexDefinition, type JsonValue } from '../lib/aiSearchRest'
import { isJsonObject, type JsonObject } from '../app/json'
import type { Language } from '../lib/translations'

export function useRequestBuilderIndexSchema(args: {
  activeProfile: ConnectionProfile | null
  indexName: string
  apiVersion: string
  language: Language
}) {
  const { activeProfile, indexName, apiVersion, language } = args

  const [requestBuilderIndexSchema, setRequestBuilderIndexSchema] = useState<JsonValue | null>(null)
  const [isLoadingRequestBuilderSchema, setIsLoadingRequestBuilderSchema] = useState(false)

  useEffect(() => {
    const idx = indexName.trim()
    if (!activeProfile || !idx.trim() || !apiVersion.trim()) {
      setRequestBuilderIndexSchema(null)
      return
    }

    const abortController = new AbortController()
    setIsLoadingRequestBuilderSchema(true)

    ;(async () => {
      try {
        const res = await getIndexDefinition({
          profile: activeProfile,
          indexName: idx,
          apiVersion,
          language,
        })
        if (abortController.signal.aborted) return
        setRequestBuilderIndexSchema(res.ok ? res.response : null)
      } catch {
        if (abortController.signal.aborted) return
        setRequestBuilderIndexSchema(null)
      } finally {
        if (!abortController.signal.aborted) setIsLoadingRequestBuilderSchema(false)
      }
    })()

    return () => {
      abortController.abort()
    }
  }, [activeProfile, indexName, apiVersion, language])

  const requestBuilderIndexFields = useMemo(() => {
    if (!requestBuilderIndexSchema || !isJsonObject(requestBuilderIndexSchema)) return []
    const fields = requestBuilderIndexSchema.fields
    if (!Array.isArray(fields)) return []
    return fields
      .filter((f): f is JsonObject => isJsonObject(f))
      .map((f) => ({
        name: typeof f.name === 'string' ? f.name : '',
        type: typeof f.type === 'string' ? f.type : '',
        searchable: f.searchable === true,
      }))
      .filter((f) => f.name.trim().length > 0)
  }, [requestBuilderIndexSchema])

  const requestBuilderKeyFieldName = useMemo(() => {
    if (!requestBuilderIndexSchema || !isJsonObject(requestBuilderIndexSchema)) return null
    const fields = requestBuilderIndexSchema.fields
    if (!Array.isArray(fields)) return null
    for (const f of fields) {
      if (!isJsonObject(f)) continue
      const isKey = f.key
      const name = f.name
      if (isKey === true && typeof name === 'string' && name.trim()) return name
    }
    return null
  }, [requestBuilderIndexSchema])

  const requestBuilderIndexFieldNames = useMemo(() => requestBuilderIndexFields.map((f) => f.name), [requestBuilderIndexFields])

  const requestBuilderSearchableFieldNames = useMemo(() => {
    return requestBuilderIndexFields
      .filter((f) => f.searchable || f.type === 'Edm.String' || f.type === 'Collection(Edm.String)')
      .map((f) => f.name)
  }, [requestBuilderIndexFields])

  const requestBuilderVectorFieldNames = useMemo(() => {
    return requestBuilderIndexFields
      .filter((f) => f.type.startsWith('Collection(Edm.Single)') || f.type.includes('vector'))
      .map((f) => f.name)
  }, [requestBuilderIndexFields])

  const requestBuilderSuggesterNames = useMemo(() => {
    if (!requestBuilderIndexSchema || !isJsonObject(requestBuilderIndexSchema)) return []
    const suggesters = requestBuilderIndexSchema.suggesters
    if (!Array.isArray(suggesters)) return []
    return suggesters
      .filter((suggester): suggester is JsonObject => isJsonObject(suggester))
      .map((suggester) => (typeof suggester.name === 'string' ? suggester.name : ''))
      .filter((name) => name.trim().length > 0)
  }, [requestBuilderIndexSchema])

  return {
    requestBuilderIndexSchema,
    isLoadingRequestBuilderSchema,
    requestBuilderIndexFields,
    requestBuilderKeyFieldName,
    requestBuilderIndexFieldNames,
    requestBuilderSearchableFieldNames,
    requestBuilderVectorFieldNames,
    requestBuilderSuggesterNames,
  }
}
