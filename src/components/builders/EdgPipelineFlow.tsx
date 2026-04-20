/**
 * EDAG end-to-end pipeline flow diagram.
 *
 * Beginner-friendly visual representation of the 7-stage pipeline.
 * Step labels and descriptions are i18n-keyed so both ja and en render
 * naturally. Steps that are opt-in or branch on Ragas mode are marked
 * with a dashed border and a badge.
 *
 * The component re-uses {@link TipsBlock} for inline markdown so each
 * step body can show `code` / **bold** / [link](url) consistently with
 * the rest of the Tips section.
 */

import type { ReactNode } from 'react'

import type { translations } from '../../lib/translations'
import { TipsBlock } from './TipsBlock'

type TranslationKey = keyof typeof translations.ja

interface PipelineStep {
  /** 1-based step number shown in the header. */
  num: number
  /** Bootstrap-icons class (e.g. "bi-database"). */
  icon: string
  /** i18n key for the step title. */
  titleKey: TranslationKey
  /** i18n key for the (markdown-ish) description. */
  descKey: TranslationKey
  /** Optional i18n key for a small badge (e.g. "default ON"). */
  badgeKey?: TranslationKey
  /** When true, render with a dashed border (opt-in / conditional step). */
  optional?: boolean
  /** When true, paint with the accent background (highlight key stages). */
  accent?: boolean
}

const STEPS: PipelineStep[] = [
  {
    num: 1,
    icon: 'bi-database',
    titleKey: 'edgFlowS1Title',
    descKey: 'edgFlowS1Desc',
    accent: true,
  },
  {
    num: 2,
    icon: 'bi-scissors',
    titleKey: 'edgFlowS2Title',
    descKey: 'edgFlowS2Desc',
  },
  {
    num: 3,
    icon: 'bi-stars',
    titleKey: 'edgFlowS3Title',
    descKey: 'edgFlowS3Desc',
    badgeKey: 'edgFlowS3Badge',
    accent: true,
  },
  {
    num: 4,
    icon: 'bi-funnel',
    titleKey: 'edgFlowS4Title',
    descKey: 'edgFlowS4Desc',
    badgeKey: 'edgFlowS4Badge',
  },
  {
    num: 5,
    icon: 'bi-magic',
    titleKey: 'edgFlowS5Title',
    descKey: 'edgFlowS5Desc',
    badgeKey: 'edgFlowS5Badge',
    optional: true,
  },
  {
    num: 6,
    icon: 'bi-bullseye',
    titleKey: 'edgFlowS6Title',
    descKey: 'edgFlowS6Desc',
    badgeKey: 'edgFlowS6Badge',
  },
  {
    num: 7,
    icon: 'bi-filetype-json',
    titleKey: 'edgFlowS7Title',
    descKey: 'edgFlowS7Desc',
    accent: true,
  },
]

interface EdgPipelineFlowProps {
  t: (key: TranslationKey) => string
}

export function EdgPipelineFlow({ t }: EdgPipelineFlowProps): ReactNode {
  return (
    <div className="edgFlow" aria-label={String(t('edgTipsWhatItDoesH'))}>
      {STEPS.map((s, i) => (
        <div key={s.num}>
          <div
            className={[
              'edgFlow__step',
              s.accent ? 'edgFlow__step--accent' : '',
              s.optional ? 'edgFlow__step--optional' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className="edgFlow__icon" aria-hidden="true">
              <i className={`bi ${s.icon}`}></i>
            </div>
            <div className="edgFlow__body">
              <div className="edgFlow__head">
                <span className="edgFlow__num">{`STEP ${s.num}`}</span>
                <span className="edgFlow__title">{t(s.titleKey)}</span>
                {s.badgeKey && (
                  <span
                    className={`edgFlow__badge${
                      s.optional ? ' edgFlow__badge--muted' : ''
                    }`}
                  >
                    {t(s.badgeKey)}
                  </span>
                )}
              </div>
              <div className="edgFlow__desc">
                <TipsBlock text={String(t(s.descKey))} />
              </div>
            </div>
          </div>
          {i < STEPS.length - 1 && (
            <div className="edgFlow__arrow" aria-hidden="true">
              <i className="bi bi-arrow-down-short"></i>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
