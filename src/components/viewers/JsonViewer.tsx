/**
 * Lightweight JSON viewer.
 *
 * Renders JSON values with expandable objects/arrays and small UX helpers for
 * large strings.
 */

import { useState } from 'react'
import type { JsonValue } from '../../lib/aiSearchRest'
import type { TranslationKey } from '../../lib/translations'
import { JSON_VIEWER_MAX_STRING_LENGTH } from '../../app/constants'

type JsonViewerProps = {
  data: JsonValue
  t?: (key: TranslationKey) => string
  level?: number
  initialOpenDepth?: number
  maxStringLength?: number
  hideRootObjectToggle?: boolean
  collapseArraysByDefault?: boolean
}

function JsonString(props: { value: string; maxStringLength: number; t?: (key: TranslationKey) => string }) {
  const { value, maxStringLength, t } = props
  const [expanded, setExpanded] = useState(false)

  if (value.length <= maxStringLength) {
    return <span className="jsonViewer__string">&quot;{value}&quot;</span>
  }

  const shown = expanded ? value : value.slice(0, maxStringLength) + '…'

  return (
    <span>
      <span className="jsonViewer__string">&quot;{shown}&quot;</span>
      <span className="jsonViewer__muted"> ({value.length.toLocaleString()} {t ? t('charsUnit') : 'chars'})</span>
      <button
        type="button"
        className="btn btn--mini jsonViewer__inlineBtn"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (t ? t('showLessText') : '省略') : (t ? t('showFullText') : '全文')}
      </button>
    </span>
  )
}

export function JsonViewer({
  data,
  t,
  level = 0,
  initialOpenDepth = 1,
  maxStringLength = JSON_VIEWER_MAX_STRING_LENGTH,
  hideRootObjectToggle = false,
  collapseArraysByDefault = false,
}: JsonViewerProps) {
  const [isOpen, setIsOpen] = useState(() => {
    if (collapseArraysByDefault && Array.isArray(data)) return false
    return level <= initialOpenDepth
  })

  if (data === null) {
    return <span className="jsonViewer__muted">null</span>
  }

  if (typeof data === 'string') {
    return <JsonString value={data} maxStringLength={maxStringLength} t={t} />
  }

  if (typeof data === 'number') {
    return <span className="jsonViewer__number">{data}</span>
  }

  if (typeof data === 'boolean') {
    return <span className="jsonViewer__bool">{String(data)}</span>
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <span className="jsonViewer__muted">[]</span>
    }
    return (
      <div style={{ marginLeft: level > 0 ? 20 : 0 }}>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="jsonViewer__toggle"
        >
          {isOpen ? '▼' : '▶'} Array[{data.length}]
        </button>
        {isOpen && (
          <div className="jsonViewer__children">
            {data.map((item, idx) => (
              <div key={idx} className="jsonViewer__row">
                <span className="jsonViewer__muted">{idx}: </span>
                <JsonViewer
                  data={item}
                  t={t}
                  level={level + 1}
                  initialOpenDepth={initialOpenDepth}
                  maxStringLength={maxStringLength}
                  hideRootObjectToggle={hideRootObjectToggle}
                  collapseArraysByDefault={collapseArraysByDefault}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (typeof data === 'object') {
    const keys = Object.keys(data)
    if (keys.length === 0) {
      return <span className="jsonViewer__muted">{'{}'}</span>
    }

    // RAW view, etc.: the root "Object" toggle is unnecessary, so render only the top-level contents.
    if (hideRootObjectToggle && level === 0) {
      return (
        <div>
          <div className="jsonViewer__children">
            {keys.map((key) => (
              <div key={key} className="jsonViewer__row">
                <span className="jsonViewer__key">"{key}"</span>
                <span className="jsonViewer__colon">: </span>
                <JsonViewer
                  data={data[key]}
                  t={t}
                  level={level + 1}
                  initialOpenDepth={initialOpenDepth}
                  maxStringLength={maxStringLength}
                  hideRootObjectToggle={hideRootObjectToggle}
                  collapseArraysByDefault={collapseArraysByDefault}
                />
              </div>
            ))}
          </div>
        </div>
      )
    }

    return (
      <div style={{ marginLeft: level > 0 ? 20 : 0 }}>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="jsonViewer__toggle"
        >
          {isOpen ? '▼' : '▶'} Object
        </button>
        {isOpen && (
          <div className="jsonViewer__children">
            {keys.map((key) => (
              <div key={key} className="jsonViewer__row">
                <span className="jsonViewer__key">"{key}"</span>
                <span className="jsonViewer__colon">: </span>
                <JsonViewer
                  data={data[key]}
                  t={t}
                  level={level + 1}
                  initialOpenDepth={initialOpenDepth}
                  maxStringLength={maxStringLength}
                  hideRootObjectToggle={hideRootObjectToggle}
                  collapseArraysByDefault={collapseArraysByDefault}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return <span>{String(data)}</span>
}
