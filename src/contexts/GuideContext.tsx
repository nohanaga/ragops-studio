/**
 * Feature Guide context — centralizes drawer state so the guide can
 * persist across tab changes when a user launches a feature from the
 * Portal. The drawer is rendered at AppLayout level.
 */

/* eslint-disable react-refresh/only-export-components */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { PortalCard } from '../app/featurePortalCards'
import { PORTAL_CARDS } from '../app/featurePortalCards'

export type GuideMode = 'modal' | 'companion'

export type ActiveGuide = {
  cardId: string
  stepIndex: number
  mode: GuideMode
}

type GuideContextValue = {
  activeGuide: ActiveGuide | null
  activeCard: PortalCard | null
  /** Open the guide in modal mode (from the Portal). */
  openGuide: (cardId: string) => void
  closeGuide: () => void
  setStepIndex: (index: number) => void
  /** Called when the user clicks "Launch" — switches to companion mode. */
  launchCompanion: () => void
}

const GuideContext = createContext<GuideContextValue | null>(null)

export function GuideProvider({ children }: { children: ReactNode }) {
  const [activeGuide, setActiveGuide] = useState<ActiveGuide | null>(null)

  const openGuide = useCallback((cardId: string) => {
    setActiveGuide({ cardId, stepIndex: 0, mode: 'modal' })
  }, [])

  const closeGuide = useCallback(() => {
    setActiveGuide(null)
  }, [])

  const setStepIndex = useCallback((index: number) => {
    setActiveGuide((prev) => (prev ? { ...prev, stepIndex: index } : prev))
  }, [])

  const launchCompanion = useCallback(() => {
    setActiveGuide((prev) => (prev ? { ...prev, mode: 'companion' } : prev))
  }, [])

  const activeCard = useMemo(() => {
    if (!activeGuide) return null
    return PORTAL_CARDS.find((c) => c.id === activeGuide.cardId) ?? null
  }, [activeGuide])

  const value = useMemo<GuideContextValue>(
    () => ({ activeGuide, activeCard, openGuide, closeGuide, setStepIndex, launchCompanion }),
    [activeGuide, activeCard, openGuide, closeGuide, setStepIndex, launchCompanion],
  )

  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>
}

export function useGuide(): GuideContextValue {
  const ctx = useContext(GuideContext)
  if (!ctx) throw new Error('useGuide must be used within a GuideProvider')
  return ctx
}
