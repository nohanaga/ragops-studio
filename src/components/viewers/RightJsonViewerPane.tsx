/**
 * Right-side JSON + facets viewer pane.
 *
 * Hosts structured JSON rendering and a simple facets viewer used by result
 * presentation modes.
 */

import type React from 'react'
import type { JsonValue } from '../../lib/aiSearchRest'
import { JsonViewer } from './JsonViewer'
import type { ResultView } from '../../types'
import { isRecord } from '../../utils/searchFacets'
import { translations } from '../../lib/translations'

type TranslationKey = keyof typeof translations.ja

function FacetsViewer(props: {
  facets: Record<string, unknown[]>
  onFacetFilterSelect?: (fieldName: string, bucket: Record<string, unknown>) => void
  t: (key: TranslationKey) => string
}) {
  const renderValue = (v: unknown, depth = 0): React.ReactNode => {
    if (v === null) return <span style={{ color: '#808080' }}>null</span>
    if (v === undefined) return <span style={{ color: '#808080' }}>undefined</span>
    if (typeof v === 'string') return <span style={{ color: '#ce9178' }}>&quot;{v}&quot;</span>
    if (typeof v === 'number') return <span style={{ color: '#b5cea8' }}>{v}</span>
    if (typeof v === 'boolean') return <span style={{ color: '#569cd6' }}>{String(v)}</span>

    if (Array.isArray(v)) {
      if (v.length === 0) return <span>[]</span>
      return (
        <span>
          {'['}
          <div style={{ paddingLeft: '20px' }}>
            {v.map((item, idx) => (
              <div key={idx}>{renderValue(item, depth + 1)},</div>
            ))}
          </div>
          {']'}
        </span>
      )
    }

    if (typeof v === 'object') {
      const obj = v as Record<string, unknown>
      const keys = Object.keys(obj)
      if (keys.length === 0) return <span>{'{}'}</span>
      return (
        <span>
          {'{'}
          <div style={{ paddingLeft: '20px' }}>
            {keys.map((key) => (
              <div key={key}>
                <span style={{ color: '#9cdcfe' }}>&quot;{key}&quot;</span>: {renderValue(obj[key], depth + 1)},
              </div>
            ))}
          </div>
          {'}'}
        </span>
      )
    }

    return <span>{String(v)}</span>
  }

  const renderFacetItem = (fieldName: string, bucket: unknown): React.ReactNode => {
    if (!isRecord(bucket)) return null

    const count = typeof bucket.count === 'number' ? bucket.count : null
    let label = ''

    // Range facet
    const from = bucket.from
    const to = bucket.to
    const hasFrom = from !== undefined
    const hasTo = to !== undefined

    if (hasFrom || hasTo) {
      const fromStr = hasFrom ? String(from) : ''
      const toStr = hasTo ? String(to) : ''
      if (hasFrom && hasTo) label = `${fromStr} .. ${toStr}`
      else if (hasFrom) label = `${fromStr} ..`
      else label = `.. ${toStr}`
    } else if (bucket.value !== undefined) {
      label = String(bucket.value)
    }

    return (
      <div style={{ marginBottom: '4px' }}>
        {label ? (
          <button
            type="button"
            className="jsonViewer__facetValue"
            onClick={() => props.onFacetFilterSelect?.(fieldName, bucket)}
            disabled={!props.onFacetFilterSelect}
            title={props.t('applyFacetToFilter')}
          >
            &quot;{label}&quot;
          </button>
        ) : (
          <span style={{ color: '#ce9178' }}>&quot;{label}&quot;</span>
        )}
        {count !== null && <span style={{ color: '#808080' }}> ({count})</span>}

        {/* Nested facets */}
        {isRecord(bucket['@search.facets']) && (
          <div style={{ paddingLeft: '20px', marginTop: '4px' }}>
            <FacetsViewer
              facets={bucket['@search.facets'] as Record<string, unknown[]>}
              onFacetFilterSelect={props.onFacetFilterSelect}
              t={props.t}
            />
          </div>
        )}

        {/* Other fields (metrics, etc.) */}
        {Object.keys(bucket)
          .filter((k) => k !== 'value' && k !== 'from' && k !== 'to' && k !== 'count' && k !== '@search.facets')
          .map((key) => (
            <div key={key} style={{ paddingLeft: '20px', marginTop: '2px' }}>
              <span style={{ color: '#9cdcfe' }}>&quot;{key}&quot;</span>: {renderValue(bucket[key])}
            </div>
          ))}
      </div>
    )
  }

  const names = Object.keys(props.facets).sort((a, b) => a.localeCompare(b))

  return (
    <div>
      {'{'}
      <div style={{ paddingLeft: '20px' }}>
        {names.map((name) => {
          const items = props.facets[name]

          return (
            <div key={name} style={{ marginBottom: '8px' }}>
              <span style={{ color: '#9cdcfe' }}>&quot;{name}&quot;</span>: [
              <div style={{ paddingLeft: '20px' }}>
                {items.map((item, idx) => (
                  <div key={idx}>{renderFacetItem(name, item)}</div>
                ))}
              </div>
              ],
            </div>
          )
        })}
      </div>
      {'}'}
    </div>
  )
}

export function RightJsonViewerPane(props: {
  activeResultView: ResultView
  jsonViewerMode: 'request' | 'response' | 'facets'
  setJsonViewerMode: (mode: 'request' | 'response' | 'facets') => void
  jsonViewerRequestData: JsonValue
  jsonViewerResponseData: JsonValue
  jsonViewerFacets: Record<string, unknown[]> | null
  onFacetFilterSelect?: (fieldName: string, bucket: Record<string, unknown>) => void
  onCollapse: () => void
  t: (key: TranslationKey) => string
}) {
  const { activeResultView } = props

  return (
    <section className="pane pane--right">
      <div className="pane__header">
        <div className="pane__title">Request/Response JSON Viewer</div>
        <button
          type="button"
          className="btn btn--icon"
          aria-label="Hide JSON viewer"
          title="Hide JSON viewer"
          onClick={props.onCollapse}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M9 5v14l7-7z" fill="currentColor" />
          </svg>
        </button>
      </div>

      <div className="section pane__scroll">
        <div className="section__title">Info</div>
        {activeResultView?.response ? (
          <div className="kv kv--mb16">
            <div className="kv__row">
              <div className="kv__k">runType</div>
              <div className="kv__v">{activeResultView.response.runType}</div>
            </div>
            <div className="kv__row">
              <div className="kv__k">status</div>
              <div className="kv__v">{activeResultView.response.status}</div>
            </div>
            <div className="kv__row">
              <div className="kv__k">requestId</div>
              <div className="kv__v mono">{activeResultView.response.requestId}</div>
            </div>
            <div className="kv__row">
              <div className="kv__k">at</div>
              <div className="kv__v mono">{activeResultView.response.at}</div>
            </div>
          </div>
        ) : (
          <div className="empty empty--mb8">{props.t('noJsonViewer')}</div>
        )}

        <div className="actions actions--mb10">
          <button
            type="button"
            className={'btn btn--tab ' + (props.jsonViewerMode === 'request' ? 'btn--active' : '')}
            onClick={() => props.setJsonViewerMode('request')}
          >
            Request
          </button>
          <button
            type="button"
            className={'btn btn--tab ' + (props.jsonViewerMode === 'response' ? 'btn--active' : '')}
            onClick={() => props.setJsonViewerMode('response')}
            disabled={!activeResultView?.response}
          >
            Response
          </button>
          <button
            type="button"
            className={'btn btn--tab ' + (props.jsonViewerMode === 'facets' ? 'btn--active' : '')}
            onClick={() => props.setJsonViewerMode('facets')}
            disabled={!props.jsonViewerFacets}
          >
            Facets
          </button>
          <button
            type="button"
            className="btn btn--downloadJson"
            onClick={() => {
              const data =
                props.jsonViewerMode === 'request'
                  ? props.jsonViewerRequestData
                  : props.jsonViewerMode === 'response'
                    ? props.jsonViewerResponseData
                    : (props.jsonViewerFacets as unknown as JsonValue)
              const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `${props.jsonViewerMode}-${Date.now()}.json`
              a.click()
              URL.revokeObjectURL(url)
            }}
            disabled={
              props.jsonViewerMode === 'request'
                ? !props.jsonViewerRequestData
                : props.jsonViewerMode === 'response'
                  ? !props.jsonViewerResponseData
                  : !props.jsonViewerFacets
            }
            title="Download JSON"
          >
            <i className="bi bi-download"></i>
          </button>
        </div>

        <div className="mono jsonViewer__body">
          {props.jsonViewerMode === 'facets' ? (
            props.jsonViewerFacets ? (
              <FacetsViewer
                facets={props.jsonViewerFacets}
                onFacetFilterSelect={props.onFacetFilterSelect}
                t={props.t}
              />
            ) : (
              <div className="empty">(no @search.facets)</div>
            )
          ) : (
            <JsonViewer
              data={props.jsonViewerMode === 'request' ? props.jsonViewerRequestData : props.jsonViewerResponseData}
              t={props.t}
            />
          )}
        </div>
      </div>
    </section>
  )
}
