/**
 * Feature Guide context — centralizes drawer state so the guide can
 * persist across tab changes when a user launches a feature from the
 * Portal. The drawer is rendered at AppLayout level.
 */

/* eslint-disable react-refresh/only-export-components */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { FeatureGuide, PortalCard } from '../app/featurePortalCards'
import { PORTAL_CARDS } from '../app/featurePortalCards'
import { BASIC_GUIDES } from '../app/featurePortalGuides.basic'

export type GuideMode = 'modal' | 'companion'
export type GuideDetail = 'basic' | 'advanced'

const GUIDE_DETAIL_STORAGE_KEY = 'ragops.guideDetail'

export type ActiveGuide = {
  cardId: string
  stepIndex: number
  mode: GuideMode
}

type GuideContextValue = {
  activeGuide: ActiveGuide | null
  activeCard: PortalCard | null
  activeGuideContent: FeatureGuide | null
  guideDetail: GuideDetail
  setGuideDetail: (detail: GuideDetail) => void
  openGuide: (cardId: string) => void
  closeGuide: () => void
  setStepIndex: (index: number) => void
  launchCompanion: () => void
}

const GuideContext = createContext<GuideContextValue | null>(null)

function readInitialDetail(): GuideDetail {
  if (typeof window === 'undefined') return 'basic'
  try {
    const v = window.localStorage.getItem(GUIDE_DETAIL_STORAGE_KEY)
    return v === 'advanced' ? 'advanced' : 'basic'
  } catch {
    return 'basic'
  }
}

export function resolveGuide(card: PortalCard | null, detail: GuideDetail): FeatureGuide | null {
  if (!card) return null
  const basic = BASIC_GUIDES[card.id] ?? null
  const advanced = card.guide ?? null
  if (detail === 'basic') return basic ?? advanced
  return advanced ?? basic
}

export function GuideProvider({ children }: { children: ReactNode }) {
  const [activeGuide, setActiveGuide] = useState<ActiveGuide | null>(null)
  const [guideDetail, setGuideDetailState] = useState<GuideDetail>(() => readInitialDetail())

  const setGuideDetail = useCallback((detail: GuideDetail) => {
    setGuideDetailState(detail)
    setActiveGuide((prev) => (prev ? { ...prev, stepIndex: 0 } : prev))
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(GUIDE_DETAIL_STORAGE_KEY, guideDetail)
    } catch {
      /* ignore */
    }
  }, [guideDetail])

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

  const activeGuideContent = useMemo(() => resolveGuide(activeCard, guideDetail), [activeCard, guideDetail])

  const value = useMemo<GuideContextValue>(
    () => ({
      activeGuide,
      activeCard,
      activeGuideContent,
      guideDetail,
      setGuideDetail,
      openGuide,
      closeGuide,
      setStepIndex,
      launchCompanion,
    }),
    [activeGuide, activeCard, activeGuideContent, guideDetail, setGuideDetail, openGuide, closeGuide, setStepIndex, launchCompanion],
  )

  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>
}

export function useGuide(): GuideContextValue {
  const ctx = useContext(GuideContext)
  if (!ctx) throw new Error('useGuide must be used within a GuideProvider')
  return ctx
}