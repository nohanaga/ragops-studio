import { useState } from 'react'
import type { JsonValue } from '../lib/aiSearchRest'

export function useIndexInspectorState() {
  const [isIndexInspectorOpen, setIsIndexInspectorOpen] = useState(false)
  const [indexInspectorIndexName, setIndexInspectorIndexName] = useState('')
  const [indexInspectorLoading, setIndexInspectorLoading] = useState(false)
  const [indexInspectorError, setIndexInspectorError] = useState<string | null>(null)
  const [indexInspectorDefinition, setIndexInspectorDefinition] = useState<JsonValue | null>(null)
  const [indexInspectorEditedJson, setIndexInspectorEditedJson] = useState('')
  const [indexInspectorReloadToken, setIndexInspectorReloadToken] = useState(0)

  return {
    isIndexInspectorOpen,
    setIsIndexInspectorOpen,
    indexInspectorIndexName,
    setIndexInspectorIndexName,
    indexInspectorLoading,
    setIndexInspectorLoading,
    indexInspectorError,
    setIndexInspectorError,
    indexInspectorDefinition,
    setIndexInspectorDefinition,
    indexInspectorEditedJson,
    setIndexInspectorEditedJson,
    indexInspectorReloadToken,
    setIndexInspectorReloadToken,
  }
}
