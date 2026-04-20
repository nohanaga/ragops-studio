/**
 * FeatureGuideDrawer
 *
 * A slide-in drawer that displays step-by-step guidance for a Portal
 * feature. Supports two modes:
 * - `modal`:     opened from the Portal; shows a backdrop overlay.
 * - `companion`: persists after launching the feature; floats on the
 *                right without blocking interaction, and highlights
 *                the DOM element targeted by the active step.
 */

import { useEffect, useRef } from 'react'
import type { Language } from '../../lib/translations'
import { useGuide } from '../../contexts/GuideContext'
import type { PortalCard } from '../../app/featurePortalCards'

export type FeatureGuideDrawerProps = {
  language: Language
  /**
   * Invoked when the user clicks "Launch Feature". Should trigger the
   * feature's action (navigate / open tab) and is responsible for keeping
   * the guide alive by calling `launchCompanion()` via the context.
   */
  onLaunch: (card: PortalCard) => void
}

const HIGHLIGHT_CLASS = 'guide-highlight-target'

export function FeatureGuideDrawer({ language, onLaunch }: FeatureGuideDrawerProps) {
  const { activeGuide, activeCard, activeGuideContent, guideDetail, setGuideDetail, closeGuide, setStepIndex } = useGuide()
  const drawerRef = useRef<HTMLDivElement>(null)
  const isJa = language === 'ja'

  // Always call hooks at the top-level.
  const guide = activeGuideContent
  // Clamp the step index in case the resolved guide has fewer steps
  // than the previously active variant (e.g. after switching detail level).
  const stepIndex = guide && activeGuide ? Math.min(activeGuide.stepIndex, guide.steps.length - 1) : 0
  const activeStep = guide && activeGuide ? guide.steps[stepIndex] ?? null : null
  const selector = activeStep?.targetSelector

  // Apply DOM highlight while in companion mode with an active targetSelector.
  useEffect(() => {
    if (!activeGuide || activeGuide.mode !== 'companion' || !selector) return

    let element: Element | null = null
    let rafId: number | null = null

    // Try to find the target element; retry briefly since the target
    // feature may still be mounting after launch.
    const tryLocate = (attempt: number) => {
      element = document.querySelector(selector)
      if (element) {
        element.classList.add(HIGHLIGHT_CLASS)
        try {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' })
        } catch {
          /* ignore */
        }
      } else if (attempt < 20) {
        rafId = window.setTimeout(() => tryLocate(attempt + 1), 100) as unknown as number
      }
    }
    tryLocate(0)

    return () => {
      if (rafId !== null) window.clearTimeout(rafId)
      element?.classList.remove(HIGHLIGHT_CLASS)
      // Safety: clear any residual highlight on this selector.
      document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach((el) => {
        el.classList.remove(HIGHLIGHT_CLASS)
      })
    }
  }, [activeGuide, selector])

  // Close on Escape key (both modes).
  useEffect(() => {
    if (!activeGuide) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeGuide()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeGuide, closeGuide])

  // Scroll the active step into view in the drawer.
  useEffect(() => {
    if (!activeGuide) return
    const el = drawerRef.current?.querySelector(`[data-step="${stepIndex}"]`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [activeGuide, stepIndex])

  if (!activeGuide || !activeCard || !guide) return null

  const isCompanion = activeGuide.mode === 'companion'
  const steps = guide.steps
  const tips = isJa ? guide.tipsJa : guide.tipsEn
  // Use the clamped index for all rendering so the UI stays in sync
  // when the resolved guide is shorter than the persisted step index.
  const currentStep = stepIndex

  const drawerNode = (
    <div
      ref={drawerRef}
      className={'guideDrawer' + (isCompanion ? ' guideDrawer--companion' : '')}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="guideDrawer__header">
        <div className="guideDrawer__headerIcon">
          <i className={`bi bi-${activeCard.icon}`}></i>
        </div>
        <div className="guideDrawer__headerText">
          <h3 className="guideDrawer__title">{isJa ? guide.stepsJa : guide.stepsEn}</h3>
          <p className="guideDrawer__subtitle">{isJa ? activeCard.descJa : activeCard.descEn}</p>
        </div>
        {isCompanion && (
          <span className="guideDrawer__modeBadge" title={isJa ? 'ガイド追従中' : 'Guide active'}>
            <i className="bi bi-broadcast-pin"></i>
            {isJa ? '追従中' : 'Live'}
          </span>
        )}
        <button type="button" className="guideDrawer__closeBtn" onClick={closeGuide} title={isJa ? 'ガイドを終了' : 'Close guide'}>
          <i className="bi bi-x-lg"></i>
        </button>
      </div>

      {/* Detail-level toggle (basic / advanced) */}
      <div className="guideDrawer__detailToggle" role="radiogroup" aria-label={isJa ? 'ガイドの詳しさ' : 'Guide detail level'}>
        <label className={'guideDrawer__detailOption' + (guideDetail === 'basic' ? ' is-active' : '')}>
          <input
            type="radio"
            name="guideDetail"
            value="basic"
            checked={guideDetail === 'basic'}
            onChange={() => setGuideDetail('basic')}
          />
          <i className="bi bi-mortarboard"></i>
          <span>{isJa ? '基礎ガイド' : 'Basic'}</span>
        </label>
        <label className={'guideDrawer__detailOption' + (guideDetail === 'advanced' ? ' is-active' : '')}>
          <input
            type="radio"
            name="guideDetail"
            value="advanced"
            checked={guideDetail === 'advanced'}
            onChange={() => setGuideDetail('advanced')}
          />
          <i className="bi bi-stars"></i>
          <span>{isJa ? 'アドバンスドガイド' : 'Advanced'}</span>
        </label>
      </div>

      {/* Body */}
      <div className="guideDrawer__body">
        <div className="guideDrawer__steps">
          {steps.map((step, i) => (
            <button
              key={i}
              type="button"
              data-step={i}
              className={
                'guideStep' +
                (i === currentStep ? ' guideStep--active' : '') +
                (i < currentStep ? ' guideStep--done' : '')
              }
              onClick={() => setStepIndex(i)}
            >
              <div className="guideStep__number">
                {i < currentStep ? <i className="bi bi-check-lg"></i> : <span>{i + 1}</span>}
              </div>
              <div className="guideStep__connector" />
              <div className="guideStep__content">
                <div className="guideStep__icon">
                  <i className={`bi bi-${step.icon}`}></i>
                </div>
                <div className="guideStep__text">
                  <div className="guideStep__title">
                    {isJa ? step.titleJa : step.titleEn}
                    {step.targetSelector && (
                      <i className="bi bi-cursor-fill guideStep__targetIcon" title={isJa ? 'この項目をハイライト' : 'Highlights a target'}></i>
                    )}
                  </div>
                  <div className="guideStep__desc">{isJa ? step.descJa : step.descEn}</div>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Step navigation */}
        <div className="guideDrawer__nav">
          <button
            type="button"
            className="guideDrawer__navBtn"
            disabled={currentStep === 0}
            onClick={() => setStepIndex(Math.max(0, currentStep - 1))}
          >
            <i className="bi bi-chevron-left"></i>
            {isJa ? '前へ' : 'Previous'}
          </button>
          <span className="guideDrawer__navProgress">
            {currentStep + 1} / {steps.length}
          </span>
          <button
            type="button"
            className="guideDrawer__navBtn"
            disabled={currentStep === steps.length - 1}
            onClick={() => setStepIndex(Math.min(steps.length - 1, currentStep + 1))}
          >
            {isJa ? '次へ' : 'Next'}
            <i className="bi bi-chevron-right"></i>
          </button>
        </div>

        {/* Tips */}
        {tips && tips.length > 0 && (
          <div className="guideDrawer__tips">
            <div className="guideDrawer__tipsHeader">
              <i className="bi bi-lightbulb"></i>
              {isJa ? 'ヒント' : 'Tips'}
            </div>
            <ul className="guideDrawer__tipsList">
              {tips.map((tip, i) => (
                <li key={i}>{tip}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="guideDrawer__footer">
        {guide.docsUrl && (
          <a
            href={guide.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="guideDrawer__docsLink"
          >
            <i className="bi bi-box-arrow-up-right"></i>
            {isJa ? '公式ドキュメント' : 'Official Docs'}
          </a>
        )}
        {isCompanion ? (
          <button
            type="button"
            className="guideDrawer__launchBtn guideDrawer__launchBtn--ghost"
            onClick={closeGuide}
          >
            <i className="bi bi-check-lg"></i>
            {isJa ? 'ガイドを終了' : 'Finish'}
          </button>
        ) : (
          <button
            type="button"
            className="guideDrawer__launchBtn"
            onClick={() => onLaunch(activeCard)}
            disabled={!activeCard.action}
          >
            <i className="bi bi-rocket-takeoff"></i>
            {isJa ? 'この機能を起動' : 'Launch Feature'}
          </button>
        )}
      </div>
    </div>
  )

  // Modal mode wraps the drawer in an overlay that closes on outside click.
  if (!isCompanion) {
    return (
      <div className="guideOverlay" onClick={closeGuide}>
        {drawerNode}
      </div>
    )
  }
  // Companion mode renders only the drawer, pinned to the right side.
  return drawerNode
}
