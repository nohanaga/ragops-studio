/**
 * Top application header.
 *
 * Owns global UI affordances (language/theme) and provides entry points to
 * helper tools (builders/modals) used throughout the app.
 */

import type { ChangeEvent } from 'react'
import type { Language } from '../lib/translations'
import { translations } from '../lib/translations'
import type { ThemePreference } from '../types'

type TranslationKey = keyof typeof translations.ja

export type AppHeaderProps = {
  t: (key: TranslationKey) => string
  language: Language
  onLanguageChange: (language: Language) => void
  theme: ThemePreference
  onThemeChange: (theme: ThemePreference) => void
  onOpenTextToVector: () => void
  onOpenVectorOptimizer: () => void
  onOpenSearchParameterAutoTuning: () => void
  onOpenEvalDatasetGenerator: () => void
  onOpenTokenAnalyzer: () => void
  onOpenQpsTester: () => void
  onOpenIndexBuilder: () => void
  onOpenKnowledgeBaseBuilder: () => void
  onOpenKnowledgeSourceBuilder: () => void
  onOpenSynonymMapBuilder: () => void
  onOpenSkillPipelineBuilder: () => void
  onOpenSkillEditor: () => void
  onOpenSearchPipelineVisualizer: () => void
}

export function AppHeader({
  t,
  language,
  onLanguageChange,
  theme,
  onThemeChange,
  onOpenTextToVector,
  onOpenVectorOptimizer,
  onOpenSearchParameterAutoTuning,
  onOpenEvalDatasetGenerator,
  onOpenTokenAnalyzer,
  onOpenQpsTester,
  onOpenIndexBuilder,
  onOpenKnowledgeBaseBuilder,
  onOpenKnowledgeSourceBuilder,
  onOpenSynonymMapBuilder,
  onOpenSkillPipelineBuilder,
  onOpenSkillEditor,
  onOpenSearchPipelineVisualizer,
}: AppHeaderProps) {
  return (
    <header className="app__header">
      <div className="app__title">
        <a href={import.meta.env.BASE_URL} className="app__titleLink">
          {t('appTitle')}
        </a>
        <span className="app__subtitle">{t('appSubtitle')}</span>
      </div>
      <div className="app__headerRight">
        <div className="dropdown">
          <button
            type="button"
            className="btn"
            data-bs-toggle="dropdown"
            data-bs-display="static"
            aria-haspopup="true"
          >
            {t('tools')} ▾
          </button>
          <div className="dropdown-menu dropdown-menu-end dropdown-menu--flushTop">
            <div className="dropdown__header" role="presentation">{t('toolsCategoryUtilities')}</div>
            <button type="button" className="dropdown-item" onClick={onOpenTextToVector}>
              <i className="bi bi-123"></i> {t('textToVector')}
            </button>
            <button type="button" className="dropdown-item" onClick={onOpenTokenAnalyzer}>
              🔍 Token Analyzer
            </button>

            <div className="dropdown__divider" role="separator" />
            <div className="dropdown__header" role="presentation">{t('toolsCategoryOptimization')}</div>
            <button type="button" className="dropdown-item" onClick={onOpenVectorOptimizer}>
              <i className="bi bi-arrows-angle-contract"></i> {t('vectorOptimizer')}
            </button>
            <button type="button" className="dropdown-item" onClick={onOpenSearchParameterAutoTuning}>
              <i className="bi bi-sliders"></i> {t('searchParameterAutoTuning')}
            </button>
            <button type="button" className="dropdown-item" onClick={onOpenEvalDatasetGenerator}>
              <i className="bi bi-stars"></i> {t('evalDatasetGenerator')}
            </button>
            <button type="button" className="dropdown-item" onClick={onOpenQpsTester}>
              <i className="bi bi-speedometer2"></i> {t('qpsTestTitle')}
            </button>

            <div className="dropdown__divider" role="separator" />
            <div className="dropdown__header" role="presentation">{t('toolsCategoryBuilders')}</div>
            <button type="button" className="dropdown-item" onClick={onOpenIndexBuilder}>
              🔖 Index Builder
            </button>
            <button type="button" className="dropdown-item" onClick={onOpenKnowledgeBaseBuilder}>
              🧠 Knowledge Base Builder
            </button>
            <button type="button" className="dropdown-item" onClick={onOpenKnowledgeSourceBuilder}>
              📚 Knowledge Source Builder
            </button>
            <button type="button" className="dropdown-item" onClick={onOpenSynonymMapBuilder}>
              📖 Synonym Map Builder
            </button>
            <button type="button" className="dropdown-item" onClick={onOpenSkillPipelineBuilder}>
              🧩 {t('skillPipelineBuilder')}
            </button>
            <button type="button" className="dropdown-item" onClick={onOpenSkillEditor}>
              🐍 {t('sceMenuLabel')}
            </button>

            <div className="dropdown__divider" role="separator" />
            <div className="dropdown__header" role="presentation">{t('toolsCategoryVisualizers')}</div>
            <button
              type="button"
              className="dropdown-item"
              onClick={onOpenSearchPipelineVisualizer}
            >
              🧬 {t('searchPipelineVisualizer')}
            </button>
          </div>
        </div>
        <label className="theme" aria-label="language selector">
          <span className="theme__label">{t('language')}</span>
          <select
            className="theme__select"
            value={language}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              const value = e.target.value
              if (value === 'ja' || value === 'en') {
                onLanguageChange(value)
              }
            }}
          >
            <option value="ja">{t('japanese')}</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="theme" aria-label="theme selector">
          <span className="theme__label">{t('theme')}</span>
          <select
            className="theme__select"
            value={theme}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              const value = e.target.value
              if (value === 'system' || value === 'dark' || value === 'light' || 
                  value === 'midnight' || value === 'forest' || value === 'solarized') {
                onThemeChange(value)
              }
            }}
          >
            <option value="system">{t('themeSystem')}</option>
            <option value="dark">{t('themeDark')}</option>
            <option value="light">{t('themeLight')}</option>
            <option value="midnight">{t('themeMidnight')}</option>
            <option value="forest">{t('themeForest')}</option>
            <option value="solarized">{t('themeSolarized')}</option>
          </select>
        </label>
        <div className="dropdown dropdown--ml12">
          <button
            type="button"
            className="btn btn--avatar"
            data-bs-toggle="dropdown"
            data-bs-display="static"
            aria-haspopup="true"
          >
            <img src="/icon.png" alt="About" className="btn--avatarImg" />
          </button>
          <div className="dropdown-menu dropdown-menu-end dropdown-menu--flushTop dropdown-menu--minw250">
            <div className="aboutMenu__header">
              <div className="aboutMenu__title">RAGOps Studio — for Azure AI Search</div>
              <div className="aboutMenu__versionRow">
                <div className="aboutMenu__version">Version 0.0.2</div>
                <a
                  href="https://github.com/nohanaga/ragops-studio"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="aboutMenu__githubIconLink"
                  aria-label="GitHub repository"
                  title="GitHub"
                >
                  <i className="bi bi-github" aria-hidden="true" />
                </a>
              </div>
            </div>
            <a
              href="https://github.com/nohanaga"
              target="_blank"
              rel="noopener noreferrer"
              className="aboutMenu__link"
            >
              <div className="aboutMenu__copyright">© 2025 Nobusuke Hanagasaki</div>
            </a>
          </div>
        </div>
      </div>
    </header>
  )
}
