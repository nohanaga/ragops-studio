/**
 * Index Cluster Visualizer end-to-end pipeline flow diagram.
 *
 * Mirrors the styling of EdgPipelineFlow (Eval Dataset Generator) so the
 * "What it does (end-to-end pipeline)" sections look consistent across
 * features. Step labels and descriptions are i18n-keyed and reused via
 * {@link TipsBlock} for inline markdown.
 */

import type { ReactNode } from 'react'

import { translations, type Language } from '../../lib/translations'
import { TipsBlock } from '../builders/TipsBlock'

type TranslationKey = keyof typeof translations.ja

function tr(language: Language, key: TranslationKey): string {
  return String(
    (translations[language] as Record<string, string>)[key] ??
      (translations.en as Record<string, string>)[key] ??
      key,
  )
}

interface PipelineStep {
  num: number
  icon: string
  titleKey: TranslationKey
  descKey: TranslationKey
  badgeKey?: TranslationKey
  optional?: boolean
  accent?: boolean
}

const STEPS: PipelineStep[] = [
  {
    num: 1,
    icon: 'bi-database',
    titleKey: 'ivFlowS1Title',
    descKey: 'ivFlowS1Desc',
    accent: true,
  },
  {
    num: 2,
    icon: 'bi-grid-3x3-gap',
    titleKey: 'ivFlowS2Title',
    descKey: 'ivFlowS2Desc',
    badgeKey: 'ivFlowS2Badge',
    accent: true,
  },
  {
    num: 3,
    icon: 'bi-bounding-box-circles',
    titleKey: 'ivFlowS3Title',
    descKey: 'ivFlowS3Desc',
    badgeKey: 'ivFlowS3Badge',
  },
  {
    num: 4,
    icon: 'bi-diagram-2',
    titleKey: 'ivFlowS4Title',
    descKey: 'ivFlowS4Desc',
    badgeKey: 'ivFlowS4Badge',
    optional: true,
  },
  {
    num: 5,
    icon: 'bi-stars',
    titleKey: 'ivFlowS5Title',
    descKey: 'ivFlowS5Desc',
    badgeKey: 'ivFlowS5Badge',
    optional: true,
  },
  {
    num: 6,
    icon: 'bi-search',
    titleKey: 'ivFlowS6Title',
    descKey: 'ivFlowS6Desc',
    badgeKey: 'ivFlowS6Badge',
    accent: true,
  },
  {
    num: 7,
    icon: 'bi-filetype-json',
    titleKey: 'ivFlowS7Title',
    descKey: 'ivFlowS7Desc',
  },
]

interface IvPipelineFlowProps {
  language: Language
}

export function IvPipelineFlow({ language }: IvPipelineFlowProps): ReactNode {
  const t = (key: TranslationKey) => tr(language, key)

  return (
    <div className="edgFlow" aria-label={t('ivTipsWhatItDoesH')}>
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
                <TipsBlock text={t(s.descKey)} />
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
