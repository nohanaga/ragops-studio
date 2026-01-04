import { useEffect } from 'react'
import { ensureSeedData, getSettings, listExperiments } from '../lib/db'
import type { AppSettings, Experiment } from '../lib/model'
import type { Language } from '../lib/translations'
import { LAST_SELECTED_EXPERIMENT_ID_KEY } from '../app/constants'

export function useAppBootstrap(params: {
  setBootError: (v: string | null) => void
  setSettings: (s: AppSettings) => void
  setExperiments: (xs: Experiment[]) => void
  setSelectedExperimentId: (id: string | null) => void
  setLanguage: (lang: Language) => void
}) {
  const { setBootError, setSettings, setExperiments, setSelectedExperimentId, setLanguage } = params

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await ensureSeedData()
        const [s, exps] = await Promise.all([getSettings(), listExperiments()])
        if (cancelled) return

        setSettings(s)
        setExperiments(exps)

        const firstExpId = exps.length > 0 ? exps[0].experimentId : null
        let preferredExpId: string | null = null
        try {
          preferredExpId = localStorage.getItem(LAST_SELECTED_EXPERIMENT_ID_KEY)
        } catch {
          preferredExpId = null
        }

        const restoredExpId =
          preferredExpId && exps.some((e) => e.experimentId === preferredExpId)
            ? preferredExpId
            : null

        setSelectedExperimentId(restoredExpId ?? firstExpId)

        // Load language from settings, fallback to browser language
        if (s.language) {
          setLanguage(s.language)
        }
      } catch (e) {
        if (cancelled) return
        setBootError(e instanceof Error ? e.message : String(e))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [setBootError, setExperiments, setLanguage, setSelectedExperimentId, setSettings])
}
