/**
 * Synonym map editor.
 *
 * Supports viewing/editing synonym rules, parsing Solr-style syntax, and working
 * with large maps efficiently via list virtualization.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import { List as VirtualList, type RowComponentProps } from 'react-window'
import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import { githubLight, githubDark } from '@uiw/codemirror-theme-github'
import { EditorView, lineNumbers } from '@codemirror/view'
import type { ConnectionProfile } from '../../lib/model'
import type { SynonymMap } from '../../types'
import {
  listSynonymMaps,
  getSynonymMap,
  createOrUpdateSynonymMap,
  deleteSynonymMap,
} from '../../lib/aiSearchRest'
import { translations, type Language } from '../../lib/translations'

type SynonymRule = {
  type: 'equivalency' | 'explicit'
  terms: string
  mappedTerm?: string
}

function parseSolrSynonymsToRules(text: string): SynonymRule[] {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const rules: SynonymRule[] = []
  for (const line of lines) {
    if (line.includes('=>')) {
      const [left, right] = line.split('=>').map((s) => s.trim())
      rules.push({ type: 'explicit', terms: left, mappedTerm: right })
    } else {
      rules.push({ type: 'equivalency', terms: line })
    }
  }
  return rules
}

function buildSolrSynonymsFromRules(rules: SynonymRule[]): string {
  return rules
    .map((r) => {
      const terms = (r.terms ?? '').trim()
      if (!terms) return ''
      if (r.type === 'explicit') {
        const mapped = (r.mappedTerm ?? '').trim()
        if (!mapped) return ''
        return `${terms} => ${mapped}`
      }
      return terms
    })
    .filter((l) => l.length > 0)
    .join('\n')
}

function splitNonEmptyCommaSeparated(text: string): string[] {
  return (text ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function findCharIndexForLine(text: string, lineNumber1Based: number): number {
  const target = Math.max(1, lineNumber1Based)
  if (target === 1) return 0
  let line = 1
  let idx = 0
  while (line < target) {
    const next = text.indexOf('\n', idx)
    if (next === -1) return text.length
    idx = next + 1
    line++
  }
  return idx
}

type ValidationResult = {
  ruleCount: number
  errors: string[]
}

type SynonymValidationKey =
  | 'synValidateExplicitRightEmpty'
  | 'synValidateExplicitLeftEmpty'
  | 'synValidateRuleTooManyItems'
  | 'synValidateRuleEmpty'
  | 'synValidateTooManyRules'

function validateSolrSynonyms(
  text: string,
  format: (key: SynonymValidationKey, params: Record<string, string | number>) => string
): ValidationResult {
  const lines = text.split('\n')
  let ruleCount = 0
  const errors: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const line = raw.trim()
    if (!line) continue

    ruleCount++

    // max expansions per rule: 20
    if (line.includes('=>')) {
      const [left, right] = line.split('=>').map((s) => s.trim())
      const leftTerms = splitNonEmptyCommaSeparated(left)
      const mapped = right.trim()
      const expansions = leftTerms.length + (mapped ? 1 : 0)
      if (!mapped) {
        errors.push(format('synValidateExplicitRightEmpty', { line: i + 1 }))
      }
      if (leftTerms.length === 0) {
        errors.push(format('synValidateExplicitLeftEmpty', { line: i + 1 }))
      }
      if (expansions > 20) {
        errors.push(format('synValidateRuleTooManyItems', { line: i + 1, count: expansions }))
      }
    } else {
      const terms = splitNonEmptyCommaSeparated(line)
      if (terms.length === 0) {
        errors.push(format('synValidateRuleEmpty', { line: i + 1 }))
      }
      if (terms.length > 20) {
        errors.push(format('synValidateRuleTooManyItems', { line: i + 1, count: terms.length }))
      }
    }
  }

  if (ruleCount > 20000) {
    errors.unshift(format('synValidateTooManyRules', { count: ruleCount }))
  }

  return { ruleCount, errors }
}

type CsvRow = { type: string; terms: string; mappedTerm: string }

function csvEscapeCell(v: string): string {
  const s = v ?? ''
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function toCsv(rows: CsvRow[]): string {
  const header = ['type', 'terms', 'mappedTerm']
  const lines = [header.join(',')]
  for (const r of rows) {
    lines.push([csvEscapeCell(r.type), csvEscapeCell(r.terms), csvEscapeCell(r.mappedTerm)].join(','))
  }
  return lines.join('\n')
}

function parseCsv(text: string): CsvRow[] {
  // Minimal RFC4180-ish parser (quoted cells supported)
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1]
        if (next === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += ch
      }
      continue
    }

    if (ch === '"') {
      inQuotes = true
      continue
    }

    if (ch === ',') {
      row.push(cell)
      cell = ''
      continue
    }

    if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }

    if (ch === '\r') {
      continue
    }

    cell += ch
  }

  row.push(cell)
  rows.push(row)

  // trim trailing empty rows
  while (rows.length > 0 && rows[rows.length - 1].every((c) => (c ?? '').trim() === '')) {
    rows.pop()
  }

  if (rows.length === 0) return []

  const looksLikeHeader =
    rows[0].length >= 2 &&
    rows[0][0].toLowerCase() === 'type' &&
    rows[0][1].toLowerCase() === 'terms'

  // If it doesn't look like our builder CSV, assume it's a Solr-style synonym list:
  // each CSV row is an equivalency rule where all columns are terms.
  // Example row: "USA, United States, United States of America"
  const looksLikeSolrEquivalencyCsv =
    !looksLikeHeader && rows[0].length >= 2 && rows.some((r) => r.filter((c) => (c ?? '').trim()).length >= 2)

  const startIdx = looksLikeHeader ? 1 : 0
  const out: CsvRow[] = []
  for (let i = startIdx; i < rows.length; i++) {
    const r = rows[i]

    if (looksLikeSolrEquivalencyCsv) {
      const terms = r
        .map((c) => (c ?? '').trim())
        .filter(Boolean)
        .join(', ')
      out.push({ type: 'equivalency', terms, mappedTerm: '' })
      continue
    }

    out.push({
      type: (r[0] ?? '').trim(),
      terms: (r[1] ?? '').trim(),
      mappedTerm: (r[2] ?? '').trim(),
    })
  }
  return out
}

function rulesToCsvRows(rules: SynonymRule[]): CsvRow[] {
  return rules.map((r) => ({
    type: r.type,
    terms: r.terms ?? '',
    mappedTerm: r.mappedTerm ?? '',
  }))
}

function csvRowsToRules(rows: CsvRow[]): SynonymRule[] {
  const rules: SynonymRule[] = []
  for (const r of rows) {
    const type = r.type === 'explicit' ? 'explicit' : 'equivalency'
    const terms = r.terms ?? ''
    const mappedTerm = r.mappedTerm ?? ''
    rules.push(type === 'explicit' ? { type, terms, mappedTerm } : { type, terms })
  }
  return rules
}

type SynonymMapBuilderProps = {
  profile: ConnectionProfile | null
  onClose: () => void
  language: Language
  theme: 'light' | 'dark'
}

function VirtualRuleRow({
  index,
  style,
  rulesRef,
  rulesCount,
  rulesVersion,
  t,
  onRemove,
}: {
  index: number
  style: CSSProperties
  rulesRef: MutableRefObject<SynonymRule[]>
  rulesCount: number
  rulesVersion: number
  t: (key: keyof typeof translations.ja) => string
  onRemove: (index: number) => void
}) {
  const [localType, setLocalType] = useState<SynonymRule['type']>('equivalency')
  const [localTerms, setLocalTerms] = useState('')
  const [localMapped, setLocalMapped] = useState('')

  useEffect(() => {
    const r = rulesRef.current[index]
    /* eslint-disable react-hooks/set-state-in-effect */
    setLocalType(r?.type ?? 'equivalency')
    setLocalTerms(r?.terms ?? '')
    setLocalMapped(r?.mappedTerm ?? '')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [index, rulesRef, rulesVersion])

  const commit = useCallback(() => {
    const current = rulesRef.current[index]
    if (!current) return
    rulesRef.current[index] =
      localType === 'explicit'
        ? { type: 'explicit', terms: localTerms, mappedTerm: localMapped }
        : { type: 'equivalency', terms: localTerms }
  }, [index, localMapped, localTerms, localType, rulesRef])

  return (
    <div className="synonymRuleRow" style={style}>
      <div className="synonymRuleRow__card">
        <div className="synonymRuleRow__header">
          <select
            className="field__input synonymRuleRow__typeSelect"
            value={localType}
            onChange={(e) => {
              setLocalType(e.target.value as SynonymRule['type'])
            }}
            onBlur={commit}
          >
            <option value="equivalency">{t('equivalency')}</option>
            <option value="explicit">{t('explicitMapping')}</option>
          </select>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => onRemove(index)}
            disabled={rulesCount === 1}
            aria-label="remove rule"
            title={t('remove')}
          >
            ×
          </button>
        </div>

        <div
          className={`synonymRuleRow__inputs ${localType === 'explicit' ? 'synonymRuleRow__inputs--explicit' : ''}`}
        >
          <div className="synonymRuleRow__field">
            <div className="field__label synonymRuleRow__label">
              {localType === 'explicit' ? t('sourceTerms') : t('equivalentTerms')}
            </div>
            <input
              className="field__input synonymRuleRow__textInput"
              type="text"
              value={localTerms}
              onChange={(e) => setLocalTerms(e.target.value)}
              onBlur={commit}
              placeholder={localType === 'explicit' ? t('sourceTermsPlaceholder') : t('equivalentTermsPlaceholder')}
            />
          </div>
          {localType === 'explicit' && (
            <div className="synonymRuleRow__field">
              <div className="field__label synonymRuleRow__label">{t('mappedTerm')}</div>
              <input
                className="field__input synonymRuleRow__textInput"
                type="text"
                value={localMapped}
                onChange={(e) => setLocalMapped(e.target.value)}
                onBlur={commit}
                placeholder={t('mappedTermPlaceholder')}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function SynonymMapBuilder({ profile, language, theme }: SynonymMapBuilderProps) {
  const t = useCallback((key: keyof typeof translations.ja) => translations[language][key], [language])
  const format = useCallback(
    (key: keyof typeof translations.ja, params: Record<string, string | number>) => {
      let out = String(translations[language][key] ?? '')
      for (const [k, v] of Object.entries(params)) {
        out = out.replaceAll(`{${k}}`, String(v))
      }
      return out
    },
    [language]
  )
  
  const codeMirrorTheme = useMemo(() => (theme === 'light' ? githubLight : githubDark), [theme])
  
  const [synonymMaps, setSynonymMaps] = useState<SynonymMap[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedMap, setSelectedMap] = useState<SynonymMap | null>(null)
  const [formData, setFormData] = useState<Partial<SynonymMap>>({
    name: '',
    format: 'solr',
    synonyms: '',
  })
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [viewMode, setViewMode] = useState<'form' | 'solr'>('solr')

  // Solr mode helpers
  const solrText = formData.synonyms ?? ''
  const solrEditorViewRef = useRef<EditorView | null>(null)

  const [solrSearchText, setSolrSearchText] = useState('')
  const [solrJumpLine, setSolrJumpLine] = useState<string>('')
  const [validation, setValidation] = useState<ValidationResult | null>(null)

  const csvFileInputRef = useRef<HTMLInputElement | null>(null)

  const doSearchNext = useCallback(() => {
    const view = solrEditorViewRef.current
    const q = solrSearchText
    if (!view || !q) return

    const text = view.state.doc.toString()
    const start = view.state.selection.main.to
    const idx = text.indexOf(q, start)
    const found = idx !== -1 ? idx : text.indexOf(q, 0)
    if (found === -1) {
      setMessage({ type: 'error', text: `${t('synSearchNotFound')}: ${q}` })
      return
    }

    view.focus()
    view.dispatch({
      selection: { anchor: found, head: found + q.length },
      scrollIntoView: true,
    })
  }, [solrSearchText, t])

  const doJumpToLine = useCallback(() => {
    const view = solrEditorViewRef.current
    if (!view) return
    const n = Number(solrJumpLine)
    if (!Number.isFinite(n) || n <= 0) return

    const text = view.state.doc.toString()
    const idx = findCharIndexForLine(text, n)
    view.focus()
    view.dispatch({ selection: { anchor: idx, head: idx }, scrollIntoView: true })
  }, [solrJumpLine])

  const doValidate = useCallback(() => {
    const res = validateSolrSynonyms(solrText, (key, params) => format(key, params))
    setValidation(res)
    if (res.errors.length === 0) {
      setMessage({ type: 'success', text: `${t('synValidateOk')} (${t('synRuleCount')}: ${res.ruleCount})` })
    } else {
      setMessage({
        type: 'error',
        text: `${t('synValidateNg')} (${t('synRuleCount')}: ${res.ruleCount}, ${t('synErrorCount')}: ${res.errors.length})`,
      })
    }
  }, [format, solrText, t])

  // Form mode: rules stored in ref to avoid copying 20k items on every keypress
  const rulesRef = useRef<SynonymRule[]>([{ type: 'equivalency', terms: '' }])
  const [rulesVersion, setRulesVersion] = useState(0)
  const [rulesCount, setRulesCount] = useState(1)
  const bumpRulesVersion = useCallback(() => setRulesVersion((v) => v + 1), [])

  const setRulesFromText = useCallback((text: string) => {
    const parsed = parseSolrSynonymsToRules(text)
    rulesRef.current = parsed.length > 0 ? parsed : [{ type: 'equivalency', terms: '' }]
    setRulesCount(rulesRef.current.length)
    bumpRulesVersion()
  }, [bumpRulesVersion])

  const setTextFromRules = useCallback(() => {
    const built = buildSolrSynonymsFromRules(rulesRef.current)
    setFormData((prev) => ({ ...prev, synonyms: built }))
  }, [])

  useEffect(() => {
    // Keep both modes consistent when toggling
    if (viewMode === 'form') {
      setRulesFromText(formData.synonyms ?? '')
    } else {
      setTextFromRules()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode])

  useEffect(() => {
    if (profile) {
      loadSynonymMaps()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile])

  const loadSynonymMaps = async () => {
    if (!profile) return
    setLoading(true)
    try {
      const result = await listSynonymMaps({ profile, language })
      if (result.ok && result.response && typeof result.response === 'object') {
        const data = result.response as { value?: SynonymMap[] }
        setSynonymMaps(data.value || [])
      }
    } catch (e) {
      console.error(e)
      setMessage({ type: 'error', text: `${t('failedToLoad')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }

  const handleLoadMap = async (mapName: string) => {
    if (!profile) return
    setLoading(true)
    try {
      const result = await getSynonymMap({ profile, synonymMapName: mapName, language })
      if (result.ok && result.response) {
        const map = result.response as SynonymMap
        setSelectedMap(map)
        setFormData(map)

        // Ensure rules stay in sync (for form mode)
        setRulesFromText(map.synonyms ?? '')
        setValidation(null)
        
        setMessage(null)
      } else {
        const errorMsg = !result.ok && 'error' in result ? result.error.message : 'Unknown error'
        setMessage({ type: 'error', text: `${t('failedToLoad')}: ${errorMsg}` })
      }
    } catch (e) {
      console.error(e)
      setMessage({ type: 'error', text: `${t('failedToLoad')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async () => {
    if (!profile || !formData.name) {
      setMessage({ type: 'error', text: t('nameRequired') })
      return
    }
    
    setLoading(true)
    try {
      // Build synonyms string from rules (form) or use direct solr text
      const synonymsString =
        viewMode === 'form'
          ? buildSolrSynonymsFromRules(rulesRef.current)
          : (formData.synonyms || '')
      
      const body = {
        name: formData.name,
        format: 'solr',
        synonyms: synonymsString,
      }
      
      const result = await createOrUpdateSynonymMap({
        profile,
        synonymMapName: formData.name,
        body,
        language,
      })
      
      if (result.ok) {
        setMessage({ type: 'success', text: `${t('created')}: ${formData.name}` })
        await loadSynonymMaps()
        setFormData({ name: '', format: 'solr', synonyms: '' })
        rulesRef.current = [{ type: 'equivalency', terms: '' }]
        setRulesCount(1)
        bumpRulesVersion()
        setValidation(null)
      } else {
        const errorMsg = !result.ok && 'error' in result ? result.error.message : 'Unknown error'
        setMessage({ type: 'error', text: `${t('failed')}: ${errorMsg}` })
      }
    } catch (e) {
      console.error(e)
      setMessage({ type: 'error', text: `${t('failed')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }

  const handleDelete = async (mapName: string) => {
    if (!profile) return
    if (!confirm(`${t('confirmDelete')} "${mapName}"?`)) return
    
    setLoading(true)
    try {
      const result = await deleteSynonymMap({ profile, synonymMapName: mapName, language })
      if (result.ok) {
        setMessage({ type: 'success', text: `${t('deleted')}: ${mapName}` })
        await loadSynonymMaps()
        if (selectedMap?.name === mapName) {
          setSelectedMap(null)
          setFormData({ name: '', format: 'solr', synonyms: '' })
          rulesRef.current = [{ type: 'equivalency', terms: '' }]
          setRulesCount(1)
          bumpRulesVersion()
          setValidation(null)
        }
      } else {
        const errorMsg = !result.ok && 'error' in result ? result.error.message : 'Unknown error'
        setMessage({ type: 'error', text: `${t('failed')}: ${errorMsg}` })
      }
    } catch (e) {
      console.error(e)
      setMessage({ type: 'error', text: `${t('failed')}: ${e}` })
    } finally {
      setLoading(false)
    }
  }

  const handleAddRule = useCallback(() => {
    rulesRef.current = [...rulesRef.current, { type: 'equivalency', terms: '' }]
    setRulesCount(rulesRef.current.length)
    bumpRulesVersion()
  }, [bumpRulesVersion])

  const handleRemoveRule = useCallback((index: number) => {
    if (rulesRef.current.length === 1) return
    rulesRef.current = rulesRef.current.filter((_, i) => i !== index)
    setRulesCount(rulesRef.current.length)
    bumpRulesVersion()
  }, [bumpRulesVersion])

  const exportCsv = useCallback(() => {
    const rules = parseSolrSynonymsToRules(solrText)
    const csv = toCsv(rulesToCsvRows(rules))
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(formData.name || 'synonym-map')}-rules.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [formData.name, solrText])

  const triggerImportCsv = useCallback(() => {
    csvFileInputRef.current?.click()
  }, [])

  const onImportCsvFile = useCallback(
    async (file: File | null) => {
      if (!file) return
      const text = await file.text()
      const rows = parseCsv(text)
      const rules = csvRowsToRules(rows)
      const solr = buildSolrSynonymsFromRules(rules)
      setFormData((prev) => ({ ...prev, synonyms: solr }))
      rulesRef.current = rules.length > 0 ? rules : [{ type: 'equivalency', terms: '' }]
      setRulesCount(rulesRef.current.length)
      bumpRulesVersion()
      setValidation(null)
      setMessage({ type: 'success', text: `${t('synCsvImported')}: ${file.name}` })
    },
    [bumpRulesVersion, t]
  )

  const SolrEditor = (
    <div>
      <div className="synonymSolr__toolbar">
        <div className="synonymSolr__group">
          <span className="synonymSolr__label">{t('synSearch')}</span>
          <input
            className="field__input synonymSolr__input synonymSolr__input--search"
            value={solrSearchText}
            onChange={(e) => setSolrSearchText(e.target.value)}
            placeholder={t('synSearchPlaceholder')}
            disabled={loading}
          />
          <button type="button" className="btn" onClick={doSearchNext} disabled={loading || !solrSearchText}>
            {t('synSearchNext')}
          </button>
        </div>

        <div className="synonymSolr__group">
          <span className="synonymSolr__label">{t('synJump')}</span>
          <input
            className="field__input synonymSolr__input synonymSolr__input--jump"
            value={solrJumpLine}
            onChange={(e) => setSolrJumpLine(e.target.value)}
            placeholder="1"
            disabled={loading}
            inputMode="numeric"
          />
          <button type="button" className="btn" onClick={doJumpToLine} disabled={loading || !solrJumpLine}>
            {t('synJumpGo')}
          </button>
        </div>

        <button type="button" className="btn" onClick={doValidate} disabled={loading}>
          {t('synValidate')}
        </button>

        <button type="button" className="btn" onClick={exportCsv} disabled={loading}>
          {t('synCsvExport')}
        </button>

        <button type="button" className="btn" onClick={triggerImportCsv} disabled={loading}>
          {t('synCsvImport')}
        </button>
        <input
          ref={csvFileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="synonymSolr__fileInput"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null
            void onImportCsvFile(f)
            e.target.value = ''
          }}
        />

        <div className="synonymSolr__meta">
          {t('synRuleCount')}: {validation?.ruleCount ?? validateSolrSynonyms(solrText, (key, params) => format(key, params)).ruleCount}
        </div>
      </div>

      {validation && validation.errors.length > 0 && (
        <div className="notice notice--warning synonymSolr__validation">
          <div className="notice__title">{t('synValidateIssues')}</div>
          <pre className="notice__pre">{validation.errors.slice(0, 50).join('\n')}</pre>
          {validation.errors.length > 50 && (
            <div className="notice__meta">{format('synValidateMore', { count: validation.errors.length - 50 })}</div>
          )}
        </div>
      )}

      <div className="synonym-editor synonymSolr__editorFrame">
        <ExpandableCodeMirror
          t={t}
          modalTitle={t('synonymMapBuilder')}
          value={solrText}
          height="360px"
          theme={codeMirrorTheme}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
          }}
          extensions={[lineNumbers(), EditorView.lineWrapping, EditorView.editable.of(!loading)]}
          onCreateEditor={(view) => {
            solrEditorViewRef.current = view
          }}
          onChange={(value) => {
            setFormData((prev) => ({ ...prev, synonyms: value }))
            setValidation(null)
          }}
          placeholder={t('synonymsPlaceholder')}
        />
      </div>
      <div className="synonymSolr__hint">
        {t('synonymsHint')}
      </div>
    </div>
  )

  const renderRuleRow = useCallback(
    ({ index, style }: RowComponentProps) => (
      <VirtualRuleRow
        index={index}
        style={style}
        rulesRef={rulesRef}
        rulesCount={rulesCount}
        rulesVersion={rulesVersion}
        t={t}
        onRemove={handleRemoveRule}
      />
    ),
    [handleRemoveRule, rulesCount, rulesRef, rulesVersion, t]
  )

  return (
    <div className="pane__centerContent">
      <div className="section synonymMapBuilder">
        <div className="section__title">{t('synonymMapBuilder')}</div>
        <div className="synonymMapBuilder__desc">
          {t('synonymMapBuilderDesc')}
        </div>

        {message && (
          <div className={`notice notice--${message.type} synonymMapBuilder__notice`}>
            {message.text}
          </div>
        )}

      <div className="synonymMapBuilder__block">
        <h3 className="section__title synonymMapBuilder__subTitle">
          {t('existingSynonymMaps')}
        </h3>
        {loading && <div>{t('loading')}...</div>}
        {!loading && synonymMaps.length === 0 && (
          <div className="synonymMapBuilder__empty">
            {t('noSynonymMaps')}
          </div>
        )}
        {!loading && synonymMaps.length > 0 && (
          <div className="synonymMapBuilder__listFrame">
            <div className={`list synonymMapBuilder__list ${synonymMaps.length > 5 ? 'synonymMapBuilder__list--scroll' : ''}`}>
              {synonymMaps.map((map) => {
                const ruleCount = map.synonyms
                  ? map.synonyms.split('\n').filter((line) => line.trim()).length
                  : 0

                const isActive = selectedMap?.name === map.name

                return (
                  <div
                    key={map.name}
                    className={`synonymMapBuilder__listRow ${isActive ? 'synonymMapBuilder__listRow--active' : ''}`}
                  >
                    <button
                      type="button"
                      className="list__main"
                      onClick={() => handleLoadMap(map.name)}
                      title={map.name}
                    >
                      <div className="list__primary">{map.name}</div>
                      <div className="list__secondary">{format('synonymMapRuleCount', { count: ruleCount })}</div>
                    </button>
                    <button
                      type="button"
                      className="btn btn--danger"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDelete(map.name)
                      }}
                      disabled={loading}
                      aria-label="delete synonym map"
                      title={t('delete')}
                    >
                      ×
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      <div className="synonymMapBuilder__block">
        <h3 className="section__title synonymMapBuilder__subTitle">
          {selectedMap ? t('editSynonymMap') : t('createSynonymMap')}
        </h3>

        <label className="field synonymMapBuilder__nameField">
          <span className="field__label synonymMapBuilder__nameLabel">
            {t('name')} *
          </span>
          <input
            className="field__input"
            type="text"
            value={formData.name || ''}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder={t('synonymMapNamePlaceholder')}
            disabled={loading || !!selectedMap}
          />
          <span className="synonymMapBuilder__nameHint">
            {t('synonymMapNameHint')}
          </span>
        </label>

        <div className="synonymMapBuilder__modeBlock">
          <div className="synonymMapBuilder__modeButtons">
            <button
              type="button"
              className={`btn btn--sm ${viewMode === 'form' ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setViewMode('form')}
            >
              {t('formMode')}
            </button>
            <button
              type="button"
              className={`btn btn--sm ${viewMode === 'solr' ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setViewMode('solr')}
            >
              {t('solrMode')}
            </button>
          </div>

          {viewMode === 'form' ? (
            <div>
              <div className="synonymMapBuilder__rulesIntro">
                <strong>{t('synonymRules')}</strong>
                <p className="synonymMapBuilder__rulesDesc">
                  {t('synonymRulesDesc')}
                </p>
              </div>

              <div className="synonymMapBuilder__rulesListFrame">
                <VirtualList
                  key={rulesVersion}
                  rowComponent={renderRuleRow}
                  rowCount={rulesCount}
                  rowHeight={136}
                  rowProps={{}}
                  className="synonymMapBuilder__rulesList"
                />
              </div>

              <button
                type="button"
                className="btn btn--secondary btn--sm synonymMapBuilder__addRuleBtn"
                onClick={handleAddRule}
              >
                + {t('addRule')}
              </button>
            </div>
          ) : (
            SolrEditor
          )}
        </div>

        <div className="synonymMapBuilder__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={handleCreate}
            disabled={loading || !formData.name}
          >
            {loading ? t('saving') : selectedMap ? t('update') : t('create')}
          </button>
          {selectedMap && (
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                setSelectedMap(null)
                setFormData({ name: '', format: 'solr', synonyms: '' })
                rulesRef.current = [{ type: 'equivalency', terms: '' }]
                setRulesCount(1)
                bumpRulesVersion()
                setValidation(null)
              }}
              disabled={loading}
            >
              {t('cancel')}
            </button>
          )}
        </div>
      </div>

      <div className="synonymMapBuilder__about">
        <h4 className="synonymMapBuilder__aboutTitle">{t('about')}</h4>
        <ul className="synonymMapBuilder__aboutList">
          <li>{t('synonymMapInfo1')}</li>
          <li>{t('synonymMapInfo2')}</li>
          <li>{t('synonymMapInfo3')}</li>
        </ul>
      </div>
      </div>
    </div>
  )
}
