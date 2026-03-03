/**
 * EnrichmentPathPicker - A combo-box that lets users pick enrichment tree paths
 * (e.g. `/document/pages/*`, `/document/content`) from a searchable dropdown,
 * while still allowing free-form text input for custom paths and expressions.
 *
 * Designed to make the `/document/…` path syntax approachable for beginners.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// ── Path annotation helpers ─────────────────────────────────────────────────

const PATH_ANNOTATIONS: Record<string, { ja: string; en: string }> = {
  '/document': { ja: 'ドキュメントルート', en: 'Document root' },
  '/document/content': { ja: 'ドキュメント本文テキスト', en: 'Document body text' },
  '/document/file_data': { ja: 'ファイルメタデータ', en: 'File metadata' },
  '/document/metadata_storage_path': { ja: 'Blobストレージパス', en: 'Blob storage path' },
  '/document/metadata_storage_name': { ja: 'Blobファイル名', en: 'Blob file name' },
  '/document/metadata_content_type': { ja: 'Content-Type', en: 'Content-Type' },
  '/document/normalized_images': { ja: '正規化画像の配列', en: 'Normalized images array' },
  '/document/normalized_images/*': { ja: '各画像をループ', en: 'Each image (loop)' },
  '/document/normalized_images/*/content': { ja: '画像バイナリ', en: 'Image binary' },
  '/document/normalized_images/*/ocrText': { ja: 'OCRテキスト', en: 'OCR text' },
  '/document/pages': { ja: 'ページ分割の配列', en: 'Page-split array' },
  '/document/pages/*': { ja: '各ページをループ', en: 'Each page (loop)' },
  '/document/sentences': { ja: '文分割の配列', en: 'Sentence-split array' },
  '/document/sentences/*': { ja: '各文をループ', en: 'Each sentence (loop)' },
}

function getAnnotation(path: string, lang: 'ja' | 'en'): string | null {
  const a = PATH_ANNOTATIONS[path]
  if (a) return a[lang]
  // Detect generic array iterator
  if (path.endsWith('/*')) return lang === 'ja' ? '配列をループ' : 'Array loop'
  return null
}

export type EnrichmentPathPickerProps = {
  /** Current value of the field. */
  value: string
  /** Callback when value changes. */
  onChange: (value: string) => void
  /** All available enrichment tree paths (sorted). */
  paths: string[]
  /** The set of paths produced by skill outputs. */
  producedPaths?: Set<string>
  /** Language for annotations. */
  language: 'ja' | 'en'
  /** Placeholder text. */
  placeholder?: string
  /** Whether to show context-specific hint (e.g. "this is where the skill loops"). */
  showHint?: boolean
  /** CSS class for the outer wrapper. */
  className?: string
  /** If true, the input is read-only. */
  readOnly?: boolean
}

export function EnrichmentPathPicker(props: EnrichmentPathPickerProps) {
  const { value, onChange, paths, producedPaths, language, placeholder, showHint = true, className, readOnly } = props

  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [highlightIdx, setHighlightIdx] = useState(0)
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({})

  // Track the last value that was set internally (by typing or selecting).
  // When `value` prop differs from this, it means an external change (e.g. node switch).
  const lastInternalValue = useRef(value)

  // Compute position for the fixed dropdown
  const updateDropdownPosition = useCallback(() => {
    if (!wrapRef.current) return
    const rect = wrapRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const dropdownMaxH = 320
    const goUp = spaceBelow < dropdownMaxH && rect.top > spaceBelow

    setDropdownStyle({
      position: 'fixed',
      left: rect.left,
      width: Math.max(rect.width, 360),
      maxWidth: 520,
      ...(goUp
        ? { bottom: window.innerHeight - rect.top + 2, top: 'auto' }
        : { top: rect.bottom + 2, bottom: 'auto' }),
      zIndex: 9999,
    })
  }, [])

  // Close dropdown on outside click; close on ancestor scroll (but NOT dropdown-internal scroll)
  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node) &&
          (!dropdownRef.current || !dropdownRef.current.contains(e.target as Node))) {
        setOpen(false)
      }
    }
    const handleScroll = (e: Event) => {
      // Ignore scroll events originating from inside the dropdown itself (e.g. list scrolling)
      if (dropdownRef.current && dropdownRef.current.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    // Close on scroll of any scrollable ancestor of the picker
    const scrollParents: HTMLElement[] = []
    let el = wrapRef.current?.parentElement
    while (el) {
      if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
        scrollParents.push(el)
        el.addEventListener('scroll', handleScroll)
      }
      el = el.parentElement
    }
    // Also catch window-level scroll but filter out dropdown-internal events
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      for (const sp of scrollParents) sp.removeEventListener('scroll', handleScroll)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [open])

  // Close dropdown when value changes externally (e.g. user selected a different node).
  // This effect intentionally calls setState to dismiss the dropdown when a parent
  // component changes the controlled `value` prop (e.g. selecting a different node).
  // The ref comparison ensures it only fires on external changes, not user input.
  useEffect(() => {
    if (value !== lastInternalValue.current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: sync UI with externally-driven prop change
      setOpen(false)
      setFilter('')
    }
    lastInternalValue.current = value
  }, [value])

  // Filter paths — always include the full list when filter is empty.
  // If current value is not in paths, prepend it as a custom entry.
  const filtered = useMemo(() => {
    let base: string[]
    if (!filter.trim()) {
      base = paths
    } else {
      const lc = filter.toLowerCase()
      base = paths.filter((p) => p.toLowerCase().includes(lc))
    }
    // If current value is non-empty and not in the paths list, show it at top
    const trimVal = value.trim()
    if (trimVal && !paths.includes(trimVal)) {
      // Also apply filter to the custom value
      if (!filter.trim() || trimVal.toLowerCase().includes(filter.toLowerCase())) {
        return [trimVal, ...base]
      }
    }
    return base
  }, [paths, filter, value])

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || !listRef.current) return
    const el = listRef.current.children[highlightIdx] as HTMLElement | undefined
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightIdx, open])

  const select = useCallback(
    (path: string) => {
      lastInternalValue.current = path
      onChange(path)
      setOpen(false)
      setFilter('')
      setHighlightIdx(0)
    },
    [onChange],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          updateDropdownPosition()
          setOpen(true)
          setFilter('')
          setHighlightIdx(0)
        }
        return
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setHighlightIdx((i) => Math.min(i + 1, filtered.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setHighlightIdx((i) => Math.max(i - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (filtered[highlightIdx]) select(filtered[highlightIdx])
          break
        case 'Escape':
          e.preventDefault()
          setOpen(false)
          setFilter('')
          break
      }
    },
    [open, filtered, highlightIdx, select],
  )

  const annotation = showHint ? getAnnotation(value, language) : null
  const isWild = value.includes('/*')

  // Compute depth for indent display
  const getDepth = (p: string) => {
    const segs = p.split('/').filter(Boolean)
    return Math.max(0, segs.length - 1) // /document = 0, /document/content = 1
  }

  return (
    <div className={`epPicker ${className ?? ''}`} ref={wrapRef}>
      <div className="epPicker__inputWrap">
        <input
          ref={inputRef}
          className="epPicker__input"
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          onChange={(e) => { lastInternalValue.current = e.target.value; onChange(e.target.value) }}
          onFocus={() => {
            if (!readOnly && paths.length > 0) {
              updateDropdownPosition()
              setOpen(true)
              setFilter('')
              setHighlightIdx(Math.max(0, filtered.indexOf(value)))
            }
          }}
          onKeyDown={handleKeyDown}
        />
        {!readOnly && paths.length > 0 && (
          <button
            type="button"
            className="epPicker__toggle"
            tabIndex={-1}
            onClick={() => {
              if (!open) {
                updateDropdownPosition()
                setOpen(true)
                setFilter('')
                setHighlightIdx(Math.max(0, paths.indexOf(value)))
                inputRef.current?.focus()
              } else {
                setOpen(false)
              }
            }}
          >
            ▾
          </button>
        )}
      </div>

      {/* Annotation badge */}
      {annotation && (
        <span className={`epPicker__hint ${isWild ? 'epPicker__hint--loop' : ''}`}>
          {isWild ? '⟳ ' : ''}{annotation}
        </span>
      )}

      {/* Dropdown list — rendered in a portal to escape overflow:hidden ancestors */}
      {open && filtered.length > 0 && createPortal(
        <div className="epPicker__dropdown" ref={dropdownRef} style={dropdownStyle}>
          {/* Filter search box */}
          <div className="epPicker__filter">
            <input
              className="epPicker__filterInput"
              placeholder={language === 'ja' ? '🔍 パスをフィルター...' : '🔍 Filter paths...'}
              value={filter}
              onChange={(e) => { setFilter(e.target.value); setHighlightIdx(0) }}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          </div>
          <div className="epPicker__list" ref={listRef}>
            {filtered.map((p, i) => {
              const depth = getDepth(p)
              const ann = getAnnotation(p, language)
              const isProduced = producedPaths?.has(p) ?? false
              const isCustom = !paths.includes(p)
              return (
                <div
                  key={p}
                  className={`epPicker__item ${i === highlightIdx ? 'epPicker__item--hl' : ''} ${p === value ? 'epPicker__item--selected' : ''} ${isCustom ? 'epPicker__item--custom' : ''}`}
                  style={{ paddingLeft: isCustom ? 8 : 8 + depth * 14 }}
                  onMouseEnter={() => setHighlightIdx(i)}
                  onClick={() => select(p)}
                >
                  <span className="epPicker__icon">
                    {isCustom ? '✎' : p.endsWith('/*') ? '⟳' : isProduced ? '◆' : '◇'}
                  </span>
                  <span className="epPicker__path">{p}</span>
                  {isCustom && <span className="epPicker__ann">{language === 'ja' ? 'カスタム値' : 'Custom value'}</span>}
                  {!isCustom && ann && <span className="epPicker__ann">{ann}</span>}
                </div>
              )
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
