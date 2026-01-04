import type { Dispatch, SetStateAction } from 'react'
import { useEffect } from 'react'
import type { AgenticFormState, AnalyzeFormState, BuilderMode, LabMode, SearchFormState } from '../types'
import type { Language } from '../lib/translations'
import { buildAgenticBodyFromForm, buildAnalyzeBodyFromForm, buildSearchBodyFromForm } from '../utils/appRequestBodies'

export function useRequestJsonSync(params: {
  builderMode: BuilderMode
  labMode: LabMode
  searchForm: SearchFormState
  agenticForm: AgenticFormState
  analyzeForm: AnalyzeFormState
  language: Language
  isPreviewApiVersion: boolean

  requestJson: string
  setRequestJson: Dispatch<SetStateAction<string>>
  setUiError: Dispatch<SetStateAction<string | null>>
}) {
  const {
    builderMode,
    labMode,
    searchForm,
    agenticForm,
    analyzeForm,
    language,
    isPreviewApiVersion,
    requestJson,
    setRequestJson,
    setUiError,
  } = params

  // Keep requestJson in sync with form state when in form mode.
  useEffect(() => {
    if (builderMode !== 'form') return
    try {
      if (labMode === 'agentic') {
        const body = buildAgenticBodyFromForm(agenticForm)
        setRequestJson(JSON.stringify(body ?? {}, null, 2))
      } else if (labMode === 'analyze') {
        const body = buildAnalyzeBodyFromForm(analyzeForm)
        setRequestJson(JSON.stringify(body ?? {}, null, 2))
      } else {
        const body = buildSearchBodyFromForm(labMode, searchForm, language, isPreviewApiVersion)
        setRequestJson(JSON.stringify(body ?? {}, null, 2))
      }
    } catch (e) {
      setUiError(e instanceof Error ? e.message : String(e))
    }
  }, [
    agenticForm,
    analyzeForm,
    builderMode,
    isPreviewApiVersion,
    labMode,
    language,
    searchForm,
    setRequestJson,
    setUiError,
  ])

  // Ensure a minimal starter JSON is present when empty.
  useEffect(() => {
    if (requestJson.trim().length > 0) return

    if (labMode === 'query') {
      setRequestJson(
        JSON.stringify(
          {
            search: '*',
            queryType: 'simple',
            top: 10,
            skip: 0,
            count: true,
          },
          null,
          2,
        ),
      )
      return
    }

    if (labMode === 'semantic-vector') {
      setRequestJson(
        JSON.stringify(
          {
            search: '...',
            queryType: 'semantic',
            semanticConfiguration: 'default',
            queryLanguage: 'ja-jp',
            captions: 'extractive',
            answers: 'extractive|count-3',
            vectorQueries: [],
          },
          null,
          2,
        ),
      )
      return
    }

    // Agentic default.
    setRequestJson(
      JSON.stringify(
        {
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: '...' }],
            },
          ],
          includeActivity: true,
          outputMode: 'answerSynthesis',
          maxRuntimeInSeconds: 60,
          maxOutputSize: 100000,
          retrievalReasoningEffort: { kind: 'low' },
          knowledgeSourceParams: [],
        },
        null,
        2,
      ),
    )
  }, [labMode, requestJson, setRequestJson])
}
