import { useCallback, useState } from 'react'
import type { TranslationKey } from '../lib/translations'
import type { SharedLlmConfig } from './useSharedLlmConfig'
import { buildEmbeddingsUrl, buildProviderAuthHeaders, PROVIDER_DEFAULTS } from '../lib/llmProvider'

type Translator = (key: TranslationKey) => unknown

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // ignore
  }
}

export function useTextToVectorTool(args: { t: Translator; sharedLlm: SharedLlmConfig }) {
  const { t, sharedLlm } = args

  const [showTextToVectorTool, setShowTextToVectorTool] = useState<boolean>(false)
  const [textToVectorInput, setTextToVectorInput] = useState<string>('')
  const [textToVectorDimensions, setTextToVectorDimensions] = useState<number | null>(null)
  const [textToVectorResult, setTextToVectorResult] = useState<number[] | null>(null)
  const [textToVectorLoading, setTextToVectorLoading] = useState<boolean>(false)
  const [selectedLlmProfileId, setSelectedLlmProfileId] = useState<string>('')

  const onGenerateVector = useCallback(async () => {
    if (!textToVectorInput.trim()) {
      alert(String(t('textToVectorAlertEnterText')))
      return
    }
    const llm = sharedLlm.resolve(selectedLlmProfileId)
    if (!llm.deployment.trim()) {
      alert(String(t('textToVectorAlertEnterEndpoint')))
      return
    }
    const effectiveEndpoint = llm.effectiveEndpoint
    if (!effectiveEndpoint) {
      alert(String(t('textToVectorAlertEnterEndpoint')))
      return
    }
    const effectiveAuthMode = llm.provider === 'openai' ? 'apiKey' : llm.authMode
    if (effectiveAuthMode === 'apiKey' && !llm.apiKey.trim()) {
      alert(String(t('textToVectorAlertEnterApiKey')))
      return
    }
    if (effectiveAuthMode === 'bearer' && !llm.bearerToken.trim()) {
      alert(String(t('textToVectorAlertEnterBearerToken')))
      return
    }

    setTextToVectorLoading(true)
    setTextToVectorResult(null)

    try {
      const auth = llm.buildAuth()
      const deploymentName = llm.deployment.trim()

      const config = {
        provider: llm.provider,
        endpoint: effectiveEndpoint,
        auth,
        model: deploymentName,
        apiVersion: llm.provider === 'azure-openai'
          ? (llm.apiVersion.trim() || PROVIDER_DEFAULTS['azure-openai'].apiVersion)
          : '',
      }

      const url = buildEmbeddingsUrl(config)
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...buildProviderAuthHeaders(auth, llm.provider),
      }

      const body: Record<string, unknown> = {
        input: textToVectorInput,
        ...(llm.provider !== 'azure-openai' ? { model: deploymentName } : {}),
        ...(typeof textToVectorDimensions === 'number' &&
        Number.isFinite(textToVectorDimensions) &&
        textToVectorDimensions > 0
          ? { dimensions: Math.floor(textToVectorDimensions) }
          : {}),
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`Failed to generate embedding: ${response.status} ${errorText}`)
      }

      const data = await response.json()
      const embedding = data?.data?.[0]?.embedding

      if (!Array.isArray(embedding)) {
        throw new Error('Invalid response format')
      }

      setTextToVectorResult(embedding)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert(String(t('error')) + ': ' + msg)
    } finally {
      setTextToVectorLoading(false)
    }
  }, [t, sharedLlm, selectedLlmProfileId, textToVectorDimensions, textToVectorInput])

  const onCopyVector = useCallback(async () => {
    if (!textToVectorResult) return
    const vectorString = textToVectorResult.join(', ')
    await copyToClipboard(vectorString)
    alert(String(t('textToVectorAlertVectorCopied')))
  }, [t, textToVectorResult])

  return {
    showTextToVectorTool,
    setShowTextToVectorTool,
    textToVectorInput,
    setTextToVectorInput,
    textToVectorDimensions,
    setTextToVectorDimensions,
    textToVectorResult,
    setTextToVectorResult,
    textToVectorLoading,
    setTextToVectorLoading,
    onGenerateVector,
    onCopyVector,
    selectedLlmProfileId,
    setSelectedLlmProfileId,
  }
}
