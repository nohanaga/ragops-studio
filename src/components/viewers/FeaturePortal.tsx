/**
 * FeaturePortal — welcome screen / feature directory for RAGOps Studio.
 *
 * Displays all available tools/features as a card grid, grouped by
 * category. Each card can launch its feature and (optionally) open a
 * step-by-step guide drawer via the shared `GuideContext`.
 */

import { useState } from 'react'
import type { Language } from '../../lib/translations'
import { PORTAL_DISMISSED_KEY } from '../../app/constants'
import { CATEGORY_META, CATEGORY_ORDER, PORTAL_CARDS } from '../../app/featurePortalCards'
import { isPortalDismissed } from '../../app/portalDismissed'
import { useGuide } from '../../contexts/GuideContext'

export type FeaturePortalProps = {
  language: Language
  onAction: (action: string) => void
  onClose: () => void
}

export function FeaturePortal({ language, onAction, onClose }: FeaturePortalProps) {
  const isJa = language === 'ja'
  const [dontShowAgain, setDontShowAgain] = useState(isPortalDismissed())
  const { openGuide } = useGuide()

  const handleDontShowChange = (checked: boolean) => {
    setDontShowAgain(checked)
    if (checked) {
      localStorage.setItem(PORTAL_DISMISSED_KEY, '1')
    } else {
      localStorage.removeItem(PORTAL_DISMISSED_KEY)
    }
  }

  const cardsByCategory = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    meta: CATEGORY_META[cat],
    cards: PORTAL_CARDS.filter((c) => c.category === cat),
  }))

  return (
    <div className="portal">
      <div className="portal__header">
        <div className="portal__headerLeft">
          <h2 className="portal__title">
            <i className="bi bi-compass portal__titleIcon"></i>
            {isJa ? 'Feature Portal' : 'Feature Portal'}
          </h2>
          <p className="portal__subtitle">
            {isJa
              ? 'Azure AI Search の豊富な機能をすべて一覧できます。カードを選択して各機能を起動、'
              : 'Explore all Azure AI Search capabilities at a glance. Select a card to launch, or click '}
            <i className="bi bi-question-circle" style={{ fontSize: '12px' }}></i>
            {isJa
              ? ' で使い方ガイドを確認しましょう。'
              : ' for a step-by-step guide.'}
          </p>
        </div>
        <div className="portal__headerRight">
          <label className="portal__dismissLabel">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(e) => handleDontShowChange(e.target.checked)}
            />
            <span>{isJa ? '次回から自動表示しない' : "Don't show on startup"}</span>
          </label>
          <button type="button" className="portal__closeBtn" onClick={onClose} title={isJa ? '閉じる' : 'Close'}>
            <i className="bi bi-x-lg"></i>
          </button>
        </div>
      </div>

      <div className="portal__body">
        {cardsByCategory.map(({ category, meta, cards }) => (
          <section key={category} className="portal__section">
            <h3 className="portal__sectionTitle">
              <i className={`bi ${meta.iconClass} portal__sectionIcon`}></i>
              {isJa ? meta.labelJa : meta.labelEn}
              {category === 'azure' && (
                <span className="portal__comingSoonBadge">
                  {isJa ? 'Coming Soon' : 'Coming Soon'}
                </span>
              )}
            </h3>
            <div className="portal__grid">
              {cards.map((card) => (
                <div key={card.id} className={'portal__cardWrap' + (card.disabled ? ' portal__cardWrap--disabled' : '')}>
                  <button
                    type="button"
                    className={'portal__card' + (card.disabled ? ' portal__card--disabled' : '')}
                    disabled={card.disabled}
                    onClick={() => card.action && onAction(card.action)}
                    title={card.disabled ? (isJa ? '未実装の機能です' : 'Not yet implemented') : undefined}
                  >
                    <div className="portal__cardIcon">
                      <i className={`bi bi-${card.icon}`}></i>
                    </div>
                    <div className="portal__cardBody">
                      <div className="portal__cardTitle">{isJa ? card.titleJa : card.titleEn}</div>
                      <div className="portal__cardDesc">{isJa ? card.descJa : card.descEn}</div>
                    </div>
                    {card.disabled && (
                      <span className="portal__cardBadge">
                        <i className="bi bi-lock"></i>
                      </span>
                    )}
                  </button>
                  {!card.disabled && card.guide && (
                    <button
                      type="button"
                      className="portal__guideBtn"
                      onClick={(e) => {
                        e.stopPropagation()
                        openGuide(card.id)
                      }}
                      title={isJa ? '使い方ガイド' : 'How to use'}
                    >
                      <i className="bi bi-question-circle"></i>
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>

      <div className="portal__footer">
        <span className="portal__footerText">
          {isJa
            ? 'RAGOps Studio — for Azure AI Search | RAGOps, from query to quality.'
            : 'RAGOps Studio — for Azure AI Search | RAGOps, from query to quality.'}
        </span>
        <a
          href="https://learn.microsoft.com/azure/search/"
          target="_blank"
          rel="noopener noreferrer"
          className="portal__docsLink"
        >
          <i className="bi bi-box-arrow-up-right"></i>
          {isJa ? 'Azure AI Search ドキュメント' : 'Azure AI Search Docs'}
        </a>
      </div>
    </div>
  )
}
