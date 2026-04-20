import { useCallback, useEffect, useState } from 'react'
import type { TranslationKey } from '../lib/translations'
import type { AppSettings } from '../lib/model'
import { updateSettings } from '../lib/db'
import { buildLlmAuthHeaders, type LlmAuthMode } from '../lib/llmAuth'

type Translator = (key: TranslationKey) => unknown

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // ignore
  }
}

export function useTextToVectorTool(args: { t: Translator; settings: AppSettings | null }) {
  const { t, settings } = args

  const [showTextToVectorTool, setShowTextToVectorTool] = useState<boolean>(false)
  const [textToVectorInput, setTextToVectorInput] = useState<string>('')
  const [textToVectorModel, setTextToVectorModel] = useState<string>('text-embedding-3-large')
  const [textToVectorEndpoint, setTextToVectorEndpoint] = useState<string>('')
  const [textToVectorApiKey, setTextToVectorApiKey] = useState<string>('')
  const [textToVectorAuthMode, setTextToVectorAuthMode] = useState<LlmAuthMode>('apiKey')
  const [textToVectorBearerToken, setTextToVectorBearerToken] = useState<string>('')
  const [textToVectorDimensions, setTextToVectorDimensions] = useState<number | null>(null)
  const [textToVectorResult, setTextToVectorResult] = useState<number[] | null>(null)
  const [textToVectorLoading, setTextToVectorLoading] = useState<boolean>(false)

  useEffect(() => {
    if (!settings) return
    if (settings.openAiEndpoint) setTextToVectorEndpoint(settings.openAiEndpoint)
    if (settings.openAiApiKey) setTextToVectorApiKey(settings.openAiApiKey)
    if (settings.openAiAuthMode) setTextToVectorAuthMode(settings.openAiAuthMode)
    if (settings.openAiBearerToken) setTextToVectorBearerToken(settings.openAiBearerToken)
  }, [settings])

  useEffect(() => {
    if (!settings) return
    const updated: AppSettings = {
      ...settings,
      openAiEndpoint: textToVectorEndpoint,
      openAiApiKey: textToVectorApiKey,
      openAiAuthMode: textToVectorAuthMode,
      openAiBearerToken: textToVectorBearerToken,
    }
    void updateSettings(updated)
  }, [textToVectorEndpoint, textToVectorApiKey, textToVectorAuthMode, textToVectorBearerToken, settings])

  const onGenerateVector = useCallback(async () => {
    if (!textToVectorInput.trim()) {
      alert(String(t('textToVectorAlertEnterText')))
      return
    }
    if (!textToVectorEndpoint.trim()) {
      alert(String(t('textToVectorAlertEnterEndpoint')))
      return
    }
    if (textToVectorAuthMode === 'apiKey' && !textToVectorApiKey.trim()) {
      alert(String(t('textToVectorAlertEnterApiKey')))
      return
    }
    if (textToVectorAuthMode === 'bearer' && !textToVectorBearerToken.trim()) {
      alert(String(t('textToVectorAlertEnterBearerToken')))
      return
    }

    setTextToVectorLoading(true)
    setTextToVectorResult(null)

    try {
      const endpoint = textToVectorEndpoint.replace(/\/+$/, '')
      const url = `${endpoint}/openai/v1/embeddings`

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...buildLlmAuthHeaders(
          textToVectorAuthMode === 'bearer'
            ? { mode: 'bearer', bearerToken: textToVectorBearerToken }
            : { mode: 'apiKey', apiKey: textToVectorApiKey },
        ),
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          input: textToVectorInput,
          model: textToVectorModel,
          ...(typeof textToVectorDimensions === 'number' &&
          Number.isFinite(textToVectorDimensions) &&
          textToVectorDimensions > 0
            ? { dimensions: Math.floor(textToVectorDimensions) }
            : {}),
        }),
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
  }, [t, textToVectorApiKey, textToVectorAuthMode, textToVectorBearerToken, textToVectorDimensions, textToVectorEndpoint, textToVectorInput, textToVectorModel])

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
    textToVectorModel,
    setTextToVectorModel,
    textToVectorEndpoint,
    setTextToVectorEndpoint,
    textToVectorApiKey,
    setTextToVectorApiKey,
    textToVectorAuthMode,
    setTextToVectorAuthMode,
    textToVectorBearerToken,
    setTextToVectorBearerToken,
    textToVectorDimensions,
    setTextToVectorDimensions,
    textToVectorResult,
    setTextToVectorResult,
    textToVectorLoading,
    setTextToVectorLoading,
    onGenerateVector,
    onCopyVector,
  }
}
