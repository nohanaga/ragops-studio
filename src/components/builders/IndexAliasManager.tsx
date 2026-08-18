import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import {
  createOrUpdateAlias,
  deleteAlias,
  listAliases,
  type JsonValue,
} from '../../lib/aiSearchRest'
import { translations, type Language } from '../../lib/translations'

type IndexAliasManagerProps = {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion | ''
  language: Language
  indexNames: string[]
  selectedIndexName: string
  isIndexNamesLoading: boolean
  onReloadIndexNames: () => void | Promise<void>
}

type UiMessage = { type: 'success' | 'error'; text: string }

type IndexAlias = {
  name: string
  indexes: string[]
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function parseAliases(response: JsonValue | null): IndexAlias[] {
  const value = asObject(response).value
  if (!Array.isArray(value)) return []

  return value
    .map((item) => {
      const object = asObject(item)
      const name = typeof object.name === 'string' ? object.name.trim() : ''
      const indexes = Array.isArray(object.indexes)
        ? object.indexes.filter((indexName): indexName is string => typeof indexName === 'string' && indexName.trim().length > 0).map((indexName) => indexName.trim())
        : []
      return name ? { name, indexes } : null
    })
    .filter((alias): alias is IndexAlias => alias !== null)
    .sort((left, right) => left.name.localeCompare(right.name))
}

function isServerlessAliasEnumerationError(message: string): boolean {
  const normalized = message.toLowerCase()
  return normalized.includes('serverless services cannot enumerate resources without paging')
}

export function IndexAliasManager({ profile, apiVersion, language, indexNames, selectedIndexName, isIndexNamesLoading, onReloadIndexNames }: IndexAliasManagerProps) {
  const t = (key: keyof typeof translations.ja): string => String(translations[language][key] ?? '')
  const format = (key: keyof typeof translations.ja, params: Record<string, string | number>): string => {
    let text = t(key)
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
    return text
  }

  const [aliases, setAliases] = useState<IndexAlias[]>([])
  const [loadingAliases, setLoadingAliases] = useState(false)
  const [savingAlias, setSavingAlias] = useState(false)
  const [deletingAliasName, setDeletingAliasName] = useState('')
  const [aliasName, setAliasName] = useState('')
  const [targetIndexName, setTargetIndexName] = useState(selectedIndexName.trim())
  const [message, setMessage] = useState<UiMessage | null>(null)
  const [serverlessUnsupported, setServerlessUnsupported] = useState(false)

  const hasConnection = !!profile && !!apiVersion.trim()
  const canQuery = hasConnection && !serverlessUnsupported
  const selectedIndex = selectedIndexName.trim()

  const aliasesForSelectedIndex = useMemo(() => {
    if (!selectedIndex) return []
    return aliases.filter((alias) => alias.indexes.includes(selectedIndex))
  }, [aliases, selectedIndex])

  const existingAlias = useMemo(() => {
    const name = aliasName.trim()
    if (!name) return null
    return aliases.find((alias) => alias.name === name) ?? null
  }, [aliases, aliasName])

  const loadAliasList = useCallback(async () => {
    if (!profile || !apiVersion.trim()) return

    setLoadingAliases(true)
    setMessage(null)
    setServerlessUnsupported(false)
    try {
      const result = await listAliases({ profile, apiVersion, language })
      if (!result.ok) {
        setAliases([])
        if (isServerlessAliasEnumerationError(result.error.message)) {
          setServerlessUnsupported(true)
          return
        }
        setMessage({ type: 'error', text: result.error.message })
        return
      }
      setAliases(parseAliases(result.response))
    } catch (error) {
      setAliases([])
      setMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoadingAliases(false)
    }
  }, [profile, apiVersion, language])

  useEffect(() => {
    setAliases([])
    setAliasName('')
    setTargetIndexName(selectedIndexName.trim())
    setMessage(null)
    setServerlessUnsupported(false)
    if (!hasConnection) return
    void loadAliasList()
  }, [hasConnection, loadAliasList, selectedIndexName])

  useEffect(() => {
    const selected = selectedIndexName.trim()
    if (!selected) return
    setTargetIndexName((current) => current.trim() ? current : selected)
  }, [selectedIndexName])

  const onTargetIndexChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setTargetIndexName(event.target.value)
  }

  const onEditAlias = (alias: IndexAlias) => {
    setAliasName(alias.name)
    setTargetIndexName(alias.indexes[0] ?? selectedIndex)
    setMessage(null)
  }

  const onPointAliasToSelected = (alias: IndexAlias) => {
    setAliasName(alias.name)
    setTargetIndexName(selectedIndex)
    setMessage(null)
  }

  const onSaveAlias = async () => {
    if (!profile || !apiVersion.trim()) return

    const nextAliasName = aliasName.trim()
    const nextTargetIndexName = targetIndexName.trim()
    if (!nextAliasName) {
      setMessage({ type: 'error', text: t('indexBuilderAliasNameRequired') })
      return
    }
    if (!nextTargetIndexName) {
      setMessage({ type: 'error', text: t('indexBuilderAliasTargetRequired') })
      return
    }

    const currentTarget = existingAlias?.indexes[0] ?? ''
    if (currentTarget && currentTarget !== nextTargetIndexName) {
      const confirmed = window.confirm(format('indexBuilderAliasSwitchConfirm', {
        name: nextAliasName,
        current: currentTarget,
        next: nextTargetIndexName,
      }))
      if (!confirmed) return
    }

    setSavingAlias(true)
    setMessage(null)
    try {
      const result = await createOrUpdateAlias({
        profile,
        apiVersion,
        aliasName: nextAliasName,
        body: { name: nextAliasName, indexes: [nextTargetIndexName] },
        language,
      })
      if (!result.ok) {
        setMessage({ type: 'error', text: result.error.message })
        return
      }
      setMessage({ type: 'success', text: format('indexBuilderAliasSaved', { name: nextAliasName, index: nextTargetIndexName }) })
      await loadAliasList()
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSavingAlias(false)
    }
  }

  const onDeleteAlias = async (name: string) => {
    if (!profile || !apiVersion.trim()) return
    const nextAliasName = name.trim()
    if (!nextAliasName) return

    const confirmed = window.confirm(format('indexBuilderAliasDeleteConfirm', { name: nextAliasName }))
    if (!confirmed) return

    setDeletingAliasName(nextAliasName)
    setMessage(null)
    try {
      const result = await deleteAlias({ profile, apiVersion, aliasName: nextAliasName, language })
      if (!result.ok) {
        setMessage({ type: 'error', text: result.error.message })
        return
      }
      setMessage({ type: 'success', text: format('indexBuilderAliasDeleted', { name: nextAliasName }) })
      if (aliasName.trim() === nextAliasName) setAliasName('')
      await loadAliasList()
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setDeletingAliasName('')
    }
  }

  return (
    <div className="indexAliasManager">
      <div className="section__hint">{t('indexBuilderAliasesHint')}</div>
      <div className="notice builder__notice">{t('indexBuilderAliasServiceLevelNotice')}</div>

      {message && (
        <div className={`notice notice--${message.type} builder__notice`}>
          {message.text}
        </div>
      )}

      {serverlessUnsupported && (
        <div className="notice notice--error builder__notice">
          {t('indexBuilderAliasServerlessUnsupported')}
        </div>
      )}

      {!hasConnection && (
        <div className="notice notice--error builder__notice">
          {t('indexBuilderMissingProfileOrApiVersion')}
        </div>
      )}

      <div className="actions actions--mt10">
        <button
          type="button"
          className="btn"
          onClick={loadAliasList}
          disabled={!hasConnection || loadingAliases || savingAlias || !!deletingAliasName}
          title={t('indexBuilderAliasesRefreshTitle')}
        >
          <i className="bi bi-arrow-clockwise icon--mr6"></i>
          {loadingAliases ? t('indexBuilderAliasesLoading') : t('refresh')}
        </button>
      </div>

      <div className="builder__block">
        <div className="builder__editorTitle">{t('indexBuilderAliasEditorTitle')}</div>
        <div className="form form--compact">
          <label className="field">
            <span className="field__label">{t('indexBuilderAliasName')}</span>
            <input
              className="field__input"
              value={aliasName}
              onChange={(event) => setAliasName(event.target.value)}
              placeholder={t('indexBuilderAliasNamePlaceholder')}
              disabled={!canQuery || savingAlias || !!deletingAliasName}
            />
          </label>
          <label className="field">
            <span className="field__label">{t('indexBuilderAliasTargetIndex')}</span>
            <div className="indexSelectControl">
              <select
                className="field__select"
                value={targetIndexName}
                onChange={onTargetIndexChange}
                disabled={!canQuery || indexNames.length === 0 || savingAlias || !!deletingAliasName}
              >
                <option value="">{t('indexBuilderAliasSelectTarget')}</option>
                {indexNames.map((indexName) => (
                  <option key={indexName} value={indexName}>{indexName}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--icon indexSelectReloadBtn"
                onClick={() => void onReloadIndexNames()}
                disabled={!canQuery || loadingAliases || isIndexNamesLoading || savingAlias || !!deletingAliasName}
                title={t('indexBuilderRefreshIndexListTitle')}
                aria-label={t('indexBuilderRefreshIndexListTitle')}
              >
                <i className={isIndexNamesLoading ? 'bi bi-arrow-repeat spin' : 'bi bi-arrow-clockwise'} aria-hidden="true" />
              </button>
            </div>
          </label>
        </div>
        <div className="actions actions--mt10">
          <button
            type="button"
            className="btn btn--search"
            onClick={onSaveAlias}
            disabled={!canQuery || savingAlias || loadingAliases || !!deletingAliasName}
            title={t('indexBuilderAliasCreateUpdateTitle')}
          >
            <i className="bi bi-save icon--mr6"></i>
            {savingAlias ? t('saving') : t('indexBuilderAliasCreateUpdate')}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setAliasName('')
              setTargetIndexName(selectedIndex)
              setMessage(null)
            }}
            disabled={savingAlias || !!deletingAliasName}
          >
            <i className="bi bi-plus-lg icon--mr6"></i>
            {t('indexBuilderAliasNewDraft')}
          </button>
        </div>
        <div className="field__hint">{t('indexBuilderAliasPropagationHint')}</div>
      </div>

      <div className="builder__block">
        <div className="builder__editorTitle">
          {selectedIndex
            ? format('indexBuilderAliasesForSelected', { name: selectedIndex, count: aliasesForSelectedIndex.length })
            : t('indexBuilderAliasesSelectIndexFirst')}
        </div>
        {!selectedIndex && <div className="empty">{t('indexBuilderAliasesSelectIndexFirst')}</div>}
        {selectedIndex && aliasesForSelectedIndex.length === 0 && (
          <div className="empty">{t('indexBuilderAliasNoSelectedAliases')}</div>
        )}
        {aliasesForSelectedIndex.map((alias) => (
          <div key={alias.name} className="builder-list-item">
            <button
              type="button"
              className="btn builder-list-item__btn"
              onClick={() => onEditAlias(alias)}
              title={alias.name}
            >
              <span className="mono">{alias.name}</span>
            </button>
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => onDeleteAlias(alias.name)}
              disabled={!canQuery || deletingAliasName === alias.name || savingAlias}
              title={t('indexBuilderAliasDeleteTitle')}
            >
              <i className="bi bi-trash"></i>
            </button>
          </div>
        ))}
      </div>

      <div className="builder__block">
        <div className="builder__editorTitle">{format('indexBuilderAliasAll', { count: aliases.length })}</div>
        {loadingAliases && <div className="empty">{t('indexBuilderAliasesLoading')}</div>}
        {!loadingAliases && aliases.length === 0 && <div className="empty">{t('indexBuilderAliasNoAliases')}</div>}
        {!loadingAliases && aliases.map((alias) => {
          const target = alias.indexes[0] ?? '-'
          return (
            <div key={alias.name} className="builder-list-item">
              <button
                type="button"
                className="btn builder-list-item__btn"
                onClick={() => onEditAlias(alias)}
                title={`${alias.name} -> ${target}`}
              >
                <span className="mono">{alias.name}</span>
                <span className="field__hint"> → {target}</span>
              </button>
              {selectedIndex && target !== selectedIndex && (
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => onPointAliasToSelected(alias)}
                  disabled={!canQuery || savingAlias || !!deletingAliasName}
                  title={format('indexBuilderAliasPointToSelectedTitle', { name: selectedIndex })}
                >
                  <i className="bi bi-arrow-right-circle"></i>
                </button>
              )}
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => onDeleteAlias(alias.name)}
                disabled={!canQuery || deletingAliasName === alias.name || savingAlias}
                title={t('indexBuilderAliasDeleteTitle')}
              >
                <i className="bi bi-trash"></i>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}