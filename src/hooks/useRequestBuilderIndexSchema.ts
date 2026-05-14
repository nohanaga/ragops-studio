import { useEffect, useMemo, useState } from 'react'
import type { ConnectionProfile } from '../lib/model'
import { getIndexDefinition, type JsonValue } from '../lib/aiSearchRest'
import { isJsonObject, type JsonObject } from '../app/json'
import type { Language } from '../lib/translations'
import type { FacetFieldInfo } from '../utils/facetFilter'

function flattenFacetFieldInfos(
  fields: JsonObject[],
  prefix = '',
  collectionPath: string | null = null,
): FacetFieldInfo[] {
  const out: FacetFieldInfo[] = []

  for (const field of fields) {
    const name = typeof field.name === 'string' ? field.name : ''
    if (!name.trim()) continue

    const type = typeof field.type === 'string' ? field.type : ''
    const path = prefix ? `${prefix}/${name}` : name
    const nextCollectionPath = collectionPath ?? (type.startsWith('Collection(') ? path : null)
    const collectionItemPath = nextCollectionPath
      ? path === nextCollectionPath
        ? ''
        : path.slice(nextCollectionPath.length + 1)
      : null

    out.push({ path, type, collectionPath: nextCollectionPath, collectionItemPath })

    if (Array.isArray(field.fields)) {
      out.push(
        ...flattenFacetFieldInfos(
          field.fields.filter((child): child is JsonObject => isJsonObject(child)),
          path,
          nextCollectionPath,
        ),
      )
    }
  }

  return out
}

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

  const requestBuilderFacetFieldInfos = useMemo(() => {
    if (!requestBuilderIndexSchema || !isJsonObject(requestBuilderIndexSchema)) return []
    const fields = requestBuilderIndexSchema.fields
    if (!Array.isArray(fields)) return []
    return flattenFacetFieldInfos(fields.filter((f): f is JsonObject => isJsonObject(f)))
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
    requestBuilderFacetFieldInfos,
    requestBuilderKeyFieldName,
    requestBuilderIndexFieldNames,
    requestBuilderSearchableFieldNames,
    requestBuilderVectorFieldNames,
    requestBuilderSuggesterNames,
  }
}
