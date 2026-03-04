/**
 * Result rendering for all lab modes.
 *
 * Responsibilities:
 * - Render document lists and details (classic/semantic/vector/hybrid)
 * - Render agentic responses when present
 * - Support compare mode (diff view) for run-to-run analysis
 * - Sanitize highlight HTML before injecting into the DOM
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ResultView, LabMode, LatestResponse } from '../../types'
import type { Language, TranslationKey } from '../../lib/translations'
import type { AppSettings } from '../../lib/model'
import { extractDocs, extractAgenticResponse, pickPrimaryText, pickFirstStringField } from '../../utils'
import { formatLocalDateTime } from '../../utils/helpers'
import { unifiedDiff } from '../../lib/diffText'
import type { JsonValue } from '../../lib/aiSearchRest'
import { JsonViewer } from './JsonViewer'
import { AgenticActivityTimeline } from './AgenticActivityTimeline'
import { JSON_VIEWER_MAX_STRING_LENGTH } from '../../app/constants'
import DOMPurify from 'dompurify'

type JsonObject = { [key: string]: JsonValue }

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + '…'
}

function sanitizeSearchHighlightsHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['em'],
    ALLOWED_ATTR: [],
  })
}

function TruncTextInline(props: { text: string; collapsedChars?: number; t: (key: TranslationKey) => string }) {
  const { text, collapsedChars = 800, t } = props
  const [expanded, setExpanded] = useState(false)

  const isLong = text.length > collapsedChars
  const shown = expanded || !isLong ? text : truncateText(text, collapsedChars)

  return (
    <>
      {shown}
      {isLong && (
        <div className="truncText__toggleRow">
          <button type="button" className="btn btn--mini" onClick={() => setExpanded((v) => !v)}>
            {expanded ? t('showLessText') : t('showFullText')}
          </button>
          <span className="truncText__meta">
            {text.length.toLocaleString()} {t('charsUnit')}
          </span>
        </div>
      )}
    </>
  )
}

function LazyDetails(props: { className?: string; summaryText: string; render: () => ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <details className={props.className} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="resultCard__summary">
        <span className="resultCard__summaryIcon">▶</span>
        <span className="resultCard__summaryText">{props.summaryText}</span>
      </summary>
      {open ? props.render() : null}
    </details>
  )
}

type ResultViewPanelProps = {
  view: ResultView
  currentPage: number
  onPageChange: (page: number) => void
  t: (key: TranslationKey) => string
  language: Language
  compareMode: boolean
  onCompareModeChange: (next: boolean) => void
  compareBaseline?: LatestResponse | null
  settings?: AppSettings | null
}

type InlineSeg =
  | { kind: 'plain'; text: string }
  | {
      kind: 'token'
      text: string
      idx: number
      tokenText: string
      tokenType: string
      position?: number
      startOffset?: number
      endOffset?: number
    }

function buildInlineSegments(sourceText: string, tokens: JsonValue[]): InlineSeg[] | null {
  // Convert token offsets into a list of inline segments so we can render clickable
  // highlights while keeping the original text intact.
  if (!sourceText) return null
  if (!Array.isArray(tokens) || tokens.length === 0) return null

  const withOffsets = tokens
    .map((token, idx: number) => {
      if (!isJsonObject(token)) return null
      const startOffset = typeof token.startOffset === 'number' ? token.startOffset : undefined
      const endOffset = typeof token.endOffset === 'number' ? token.endOffset : undefined
      if (startOffset === undefined || endOffset === undefined) return null
      if (startOffset < 0 || endOffset < startOffset) return null
      if (endOffset > sourceText.length) return null

      return {
        idx,
        tokenText: typeof token.token === 'string' ? token.token : '',
        tokenType: typeof token.type === 'string' ? token.type : '',
        position: typeof token.position === 'number' ? token.position : undefined,
        startOffset,
        endOffset,
      }
    })
    .filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => (a.startOffset - b.startOffset) || (a.endOffset - b.endOffset) || (a.idx - b.idx))

  if (withOffsets.length === 0) return null

  const segs: InlineSeg[] = []
  let cursor = 0
  for (const tok of withOffsets) {
    // Overlaps can happen (e.g., synonyms/filters). Skip anything that would rewind.
    if (tok.startOffset < cursor) continue

    if (tok.startOffset > cursor) {
      segs.push({ kind: 'plain', text: sourceText.slice(cursor, tok.startOffset) })
    }

    segs.push({
      kind: 'token',
      text: sourceText.slice(tok.startOffset, tok.endOffset),
      idx: tok.idx,
      tokenText: tok.tokenText,
      tokenType: tok.tokenType,
      position: tok.position,
      startOffset: tok.startOffset,
      endOffset: tok.endOffset,
    })

    cursor = tok.endOffset
  }
  if (cursor < sourceText.length) {
    segs.push({ kind: 'plain', text: sourceText.slice(cursor) })
  }
  return segs
}

function getAnalyzeTokens(latestResponse: LatestResponse | null): JsonValue[] {
  if (!latestResponse) return []
  const body = latestResponse.body
  if (!isJsonObject(body)) return []
  const tokens = body.tokens
  return Array.isArray(tokens) ? tokens : []
}

function getAnalyzeSourceText(latestResponse: LatestResponse | null): string {
  if (!latestResponse) return ''
  const requestBody = latestResponse.requestBody
  if (!isJsonObject(requestBody)) return ''
  return typeof requestBody.text === 'string' ? requestBody.text : ''
}

export function ResultViewPanel({ view, currentPage, onPageChange, t, compareMode, onCompareModeChange, compareBaseline, settings }: ResultViewPanelProps) {
  const latestResponse = view.response
  const rawDetailsResetKey = `${view.id}|${view.runId ?? ''}|${latestResponse?.requestId ?? ''}|${latestResponse?.at ?? ''}`
  const labMode: LabMode = view.runType === 'agentic_retrieve' ? 'agentic' 
    : view.runType === 'analyze' ? 'analyze'
    : 'semantic-vector'

  if (!latestResponse) {
    return (
      <div className="section resultViewPanel">
        <div
          className="section__title resultViewPanel__header"
        >
          <span>{view.label}</span>
          <label className="resultViewPanel__compareLabel">
            <input
              type="checkbox"
              checked={compareMode}
              onChange={(e) => onCompareModeChange(e.target.checked)}
            />
            <span>{t('compareMode')}</span>
          </label>
        </div>
        <div className="empty">{t('noResults')}</div>
      </div>
    )
  }

  const requestBody = latestResponse.requestBody
  const requestObj = isJsonObject(requestBody) ? requestBody : null
  const searchText = typeof requestObj?.search === 'string' ? requestObj.search : ''

  return (
    <div className="section resultViewPanel">
      <div
        className="section__title resultViewPanel__header"
      >
        <div className="resultViewPanel__headerLeft">
          <span>{view.label}</span>
          <span className={`run__type run__type--${view.runType}`}>{view.runType}</span>
        </div>
        <label className="resultViewPanel__compareLabel">
          <input
            type="checkbox"
            checked={compareMode}
            onChange={(e) => onCompareModeChange(e.target.checked)}
          />
          <span>{t('compareMode')}</span>
        </label>
      </div>
      <>
        <div className="kv">
          <div className="kv__row">
            <div className="kv__k">{labMode === 'analyze' ? 'text' : 'query'}</div>
            <div className="kv__v kv__v--strong">
              {labMode === 'agentic' ? (
                (() => {
                  const requestBody = latestResponse.requestBody
                  const requestObj = isJsonObject(requestBody) ? requestBody : null
                  const messages = requestObj && Array.isArray(requestObj.messages) ? requestObj.messages : null
                  if (messages && messages.length > 0) {
                    return (
                      <div>
                        {messages.map((msg, idx: number) => {
                          const msgObj = isJsonObject(msg) ? msg : null
                          const role = typeof msgObj?.role === 'string' ? msgObj.role : ''
                          const contentRaw = msgObj?.content
                          const contentArr = Array.isArray(contentRaw) ? contentRaw : null
                          return (
                          <div key={idx} className="resultViewPanel__agenticMsgRow">
                            <span className="resultViewPanel__agenticRole">{role}:</span>{' '}
                            {contentArr ? (
                              contentArr.map((c, cIdx: number) => {
                                const cObj = isJsonObject(c) ? c : null
                                const tpe = typeof cObj?.type === 'string' ? cObj.type : ''
                                const text = typeof cObj?.text === 'string' ? cObj.text : ''
                                return <span key={cIdx}>{tpe === 'text' ? text : JSON.stringify(c)}</span>
                              })
                            ) : (
                              <span>{String(contentRaw ?? '')}</span>
                            )}
                          </div>
                          )
                        })}
                      </div>
                    )
                  }
                  return '(no messages)'
                })()
              ) : labMode === 'analyze' ? (
                (() => {
                  const requestBody = latestResponse.requestBody
                  const requestObj = isJsonObject(requestBody) ? requestBody : null
                  const text = typeof requestObj?.text === 'string' ? requestObj.text : ''
                  return text || '(empty)'
                })()
              ) : (
                searchText || '(empty)'
              )}
            </div>
          </div>
          {labMode === 'analyze' && (() => {
            const requestBody = latestResponse.requestBody
            const requestObj = isJsonObject(requestBody) ? requestBody : null
            const analyzer = typeof requestObj?.analyzer === 'string' ? requestObj.analyzer : ''
            const tokenizer = typeof requestObj?.tokenizer === 'string' ? requestObj.tokenizer : ''
            const normalizer = typeof requestObj?.normalizer === 'string' ? requestObj.normalizer : ''
            const charFiltersRaw = (requestObj && Array.isArray(requestObj.charFilters)) ? requestObj.charFilters : []
            const charFilters = charFiltersRaw.filter((x): x is string => typeof x === 'string').join(', ')
            const tokenFiltersRaw = (requestObj && Array.isArray(requestObj.tokenFilters)) ? requestObj.tokenFilters : []
            const tokenFilters = tokenFiltersRaw.filter((x): x is string => typeof x === 'string').join(', ')

            const rows: Array<{ k: string; v: string }> = [
              { k: 'analyzer', v: analyzer },
              { k: 'tokenizer', v: tokenizer },
              { k: 'normalizer', v: normalizer },
              { k: 'charFilters', v: charFilters },
              { k: 'tokenFilters', v: tokenFilters },
            ]

            return (
              <>
                {rows.map((r) => (
                  <div key={r.k} className="kv__row">
                    <div className="kv__k">{r.k}</div>
                    <div className="kv__v mono">{r.v && r.v.trim().length > 0 ? r.v : '\u00A0'}</div>
                  </div>
                ))}
              </>
            )
          })()}
          <div className="kv__row">
            <div className="kv__k">at</div>
            <div className="kv__v mono">{latestResponse.at ? formatLocalDateTime(latestResponse.at) : ''}</div>
          </div>
          {(latestResponse.latencyMs !== undefined || latestResponse.elapsedTimeMs !== undefined) && (
            <div className="kv__row">
              <div className="kv__k">latency</div>
              <div className="kv__v mono resultViewPanel__latency">
                {latestResponse.latencyMs !== undefined && (
                  <span>client: {latestResponse.latencyMs.toFixed(0)} ms</span>
                )}
                {latestResponse.elapsedTimeMs !== undefined && (
                  <span>elapsed-time: {latestResponse.elapsedTimeMs.toFixed(0)} ms</span>
                )}
              </div>
            </div>
          )}
        </div>

        {labMode === 'agentic' && (
          <>
            {(() => {
              const { response, references, activity, extractedChunks, groundingJsonText } = extractAgenticResponse(latestResponse.body)
              
              // Check if there's actual answer text (not just grounding data)
              const hasActualAnswer = response && response.some((msg) => {
                if (!isJsonObject(msg)) return false
                const contents = Array.isArray(msg.content) ? msg.content : []
                return contents.some((content) => {
                  if (!isJsonObject(content)) return false
                  if (content.type === 'text' && typeof content.text === 'string') {
                    // Treat the known grounding JSON blob (if present) as non-answer.
                    if (groundingJsonText && content.text === groundingJsonText) return false
                    return true
                  }
                  return false
                })
              })
              
              return (
                <>
                  {/* LLM Generated Answer */}
                  {hasActualAnswer && response && response.length > 0 && (
                    <div className="section">
                      <div className="section__title">Generated Answer</div>
                      {response.map((msg, idx) => {
                        const msgObj = isJsonObject(msg) ? msg : null
                        const role = typeof msgObj?.role === 'string' ? msgObj.role : ''
                        const contents = msgObj && Array.isArray(msgObj.content) ? msgObj.content : []
                        
                        return (
                          <div key={idx} className="answerSection">
                            <div className="answerCard">
                              <div className="answerCard__header">
                                <div className="answerCard__label">{role}</div>
                              </div>
                              {contents.map((content, contentIdx: number) => {
                                if (!isJsonObject(content)) return null
                                if (content.type === 'text' && typeof content.text === 'string') {
                                  // Skip grounding JSON blob here (it is shown in the separate section below).
                                  if (groundingJsonText && content.text === groundingJsonText) return null
                                  
                                  return (
                                    <div key={contentIdx} className="answerCard__text answerCard__text--prewrap">
                                      <TruncTextInline text={content.text} collapsedChars={4000} t={t} />
                                    </div>
                                  )
                                }
                                return null
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  
                  {/* Extracted Response (Grounding Data) */}
                  {extractedChunks && extractedChunks.length > 0 && (
                    <div className="section">
                      <div className="section__title">Extracted Response (Grounding Data) ({extractedChunks.length})</div>
                      <div className="resultList">
                        {extractedChunks.map((chunk, idx) => {
                          const c = isJsonObject(chunk) ? chunk : null
                          const refId = (c && typeof c.ref_id === 'number') ? c.ref_id : idx
                          const title = (c && typeof c.title === 'string') ? c.title : '(no title)'
                          const content = (c && typeof c.content === 'string') ? c.content : ''
                          const terms = (c && typeof c.terms === 'string') ? c.terms : null
                          
                          return (
                            <div key={idx} className={'resultCard' + (compareMode ? ' resultCard--compare' : '')}>
                              {compareMode ? (
                                <div className="resultCard__top">
                                  <div className="resultCard__index">#{idx + 1}</div>
                                  <div className="resultCard__title">
                                    <div>{title}</div>
                                    {content && <div className="resultCard__text-preview">{truncateText(content, 180)}</div>}
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div className="resultCard__index">#{idx + 1}</div>
                                  <div className="resultCard__top">
                                    <div className="resultCard__title">{title}</div>
                                  </div>
                                  <div className="kv">
                                    <div className="kv__row">
                                      <div className="kv__k">ref_id</div>
                                      <div className="kv__v mono">{refId}</div>
                                    </div>
                                    <div className="kv__row">
                                      <div className="kv__k">title</div>
                                      <div className="kv__v">{title}</div>
                                    </div>
                                  </div>
                                  {terms && (
                                    <div className="resultCard__captionArea">
                                      <div className="resultCard__captionLabel">Terms</div>
                                      <div className="resultCard__captionText"><TruncTextInline text={terms} collapsedChars={800} t={t} /></div>
                                    </div>
                                  )}
                                  {content && (
                                    <div className="resultCard__text">
                                      <TruncTextInline text={content} collapsedChars={800} t={t} />
                                    </div>
                                  )}
                                  <LazyDetails
                                    key={`${rawDetailsResetKey}:raw-chunk:${idx}`}
                                    className="resultCard__details"
                                    summaryText="RAW CHUNK"
                                    render={() => (
                                      <div className="mono jsonViewer__body rawJsonViewer">
                                        <JsonViewer
                                          data={chunk as unknown as JsonValue}
                                          initialOpenDepth={2}
                                          maxStringLength={JSON_VIEWER_MAX_STRING_LENGTH}
                                          hideRootObjectToggle
                                          collapseArraysByDefault
                                          t={t}
                                        />
                                      </div>
                                    )}
                                  />
                                </>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  
                  {/* References Array */}
                  {references && references.length > 0 && (
                    <div className="section">
                      <div className="section__title">References ({references.length})</div>
                      <div className="resultList">
                        {references.map((refValue, idx) => {
                          if (!isJsonObject(refValue)) return null

                          const refId = (typeof refValue.id === 'string' || typeof refValue.id === 'number') ? String(refValue.id) : ''
                          const type = typeof refValue.type === 'string' ? refValue.type : ''
                          const docKey = (typeof refValue.docKey === 'string' || typeof refValue.docKey === 'number') ? String(refValue.docKey) : ''
                          const activitySource = typeof refValue.activitySource === 'string' ? refValue.activitySource : ''
                          const sourceData = isJsonObject(refValue.sourceData) ? refValue.sourceData : null
                          const title = typeof refValue.title === 'string' ? refValue.title : ''
                          const rerankerScore = typeof refValue.rerankerScore === 'number' ? refValue.rerankerScore : undefined
                          const sourceDataText = typeof sourceData?.text === 'string' ? sourceData.text : ''
                          
                          return (
                            <div key={idx} className={'resultCard' + (compareMode ? ' resultCard--compare' : '')}>
                              {compareMode ? (
                                <div className="resultCard__top">
                                  <div className="resultCard__topMain">
                                    <div className="resultCard__index">#{idx + 1}</div>
                                    <div className="resultCard__title">
                                      <div>{title || `${type} - ref_id: ${refId}`}</div>
                                      {sourceDataText && <div className="resultCard__text-preview">{truncateText(sourceDataText, 180)}</div>}
                                    </div>
                                  </div>
                                  <div className="resultCard__scores">
                                    {typeof rerankerScore === 'number' && (
                                      <div className="resultCard__rerankerScore" title="reranker">re {rerankerScore.toFixed(4)}</div>
                                    )}
                                  </div>
                                </div>
                              ) : (
                                <>
                                  <div className="resultCard__index">#{idx + 1}</div>
                                  <div className="resultCard__top">
                                    <div className="resultCard__title">{title || `${type} - ref_id: ${refId}`}</div>
                                    <div className="resultCard__scores">
                                      {typeof rerankerScore === 'number' && (
                                        <div className="resultCard__rerankerScore">
                                          reranker {rerankerScore.toFixed(4)}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                  <div className="kv">
                                    <div className="kv__row">
                                      <div className="kv__k">ref_id</div>
                                      <div className="kv__v mono">{refId}</div>
                                    </div>
                                    <div className="kv__row">
                                      <div className="kv__k">type</div>
                                      <div className="kv__v mono">{type}</div>
                                    </div>
                                    <div className="kv__row">
                                      <div className="kv__k">activitySource</div>
                                      <div className="kv__v mono">{activitySource}</div>
                                    </div>
                                    {docKey && (
                                      <div className="kv__row">
                                        <div className="kv__k">docKey</div>
                                        <div className="kv__v mono kv__v--breakAll">
                                          {docKey}
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                  {sourceData && (
                                    <LazyDetails
                                      key={`${rawDetailsResetKey}:source-data:${idx}`}
                                      className="resultCard__details"
                                      summaryText="SOURCE DATA"
                                      render={() => (
                                        <div className="mono jsonViewer__body rawJsonViewer">
                                          <JsonViewer
                                            data={sourceData as unknown as JsonValue}
                                            initialOpenDepth={2}
                                            maxStringLength={JSON_VIEWER_MAX_STRING_LENGTH}
                                            hideRootObjectToggle
                                            collapseArraysByDefault
                                            t={t}
                                          />
                                        </div>
                                      )}
                                    />
                                  )}
                                  <LazyDetails
                                    key={`${rawDetailsResetKey}:raw-reference:${idx}`}
                                    className="resultCard__details"
                                    summaryText="RAW REFERENCE"
                                    render={() => (
                                      <div className="mono jsonViewer__body rawJsonViewer">
                                        <JsonViewer
                                          data={refValue as unknown as JsonValue}
                                          initialOpenDepth={2}
                                          maxStringLength={JSON_VIEWER_MAX_STRING_LENGTH}
                                          hideRootObjectToggle
                                          collapseArraysByDefault
                                          t={t}
                                        />
                                      </div>
                                    )}
                                  />
                                </>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  
                  {/* Activity Array (hierarchical timeline) */}
                  {activity && activity.length > 0 && (
                    <div className="section">
                      <AgenticActivityTimeline activity={activity} t={t} />
                    </div>
                  )}
                </>
              )
            })()}
          </>
        )}

        {labMode === 'analyze' && (() => {
          const tokens = getAnalyzeTokens(latestResponse)
          const sourceText = getAnalyzeSourceText(latestResponse)

          const inlineSegs = buildInlineSegments(sourceText, tokens)

          const baselineText = getAnalyzeSourceText(compareBaseline ?? null)
          const baselineTokens = getAnalyzeTokens(compareBaseline ?? null)
          const baselineInlineSegs = buildInlineSegments(baselineText, baselineTokens)
          const canDiff =
            compareMode &&
            !!compareBaseline &&
            sourceText.trim().length > 0 &&
            baselineText.trim().length > 0 &&
            sourceText === baselineText &&
            baselineTokens.length > 0 &&
            tokens.length > 0
          
          if (tokens.length === 0) {
            return <div className="empty">{t('noValueArray')}</div>
          }
          
          return (
            <div className="tokensSection">
              <div className="tokensSection__title">{t('tokens')} ({tokens.length})</div>

              {/* 1) Inline highlight view */}
              {inlineSegs && (
                <div className="resultViewPanel__mb12">
                  <div className="resultViewPanel__muted12 resultViewPanel__mb6">
                    Inline (token boundaries)
                  </div>
                  <div className="tokenInline" aria-label="inline token view">
                    {inlineSegs.map((seg, i) => {
                      if (seg.kind === 'plain') {
                        return (
                          <span key={i} className="tokenInline__plain">
                            {seg.text}
                          </span>
                        )
                      }

                      const offsetLabel =
                        seg.startOffset !== undefined && seg.endOffset !== undefined
                          ? `${seg.startOffset}-${seg.endOffset}`
                          : ''

                      const title = [
                        `#${seg.idx + 1}`,
                        seg.tokenText ? `token: ${seg.tokenText}` : undefined,
                        seg.tokenType ? `type: ${seg.tokenType}` : undefined,
                        seg.position !== undefined ? `position: ${seg.position}` : undefined,
                        offsetLabel ? `offset: ${offsetLabel}` : undefined,
                      ]
                        .filter(Boolean)
                        .join('\n')

                      return (
                        <span
                          key={i}
                          className="tokenInline__tok"
                          title={title}
                          data-token-type={seg.tokenType || undefined}
                        >
                          {seg.text}
                        </span>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* 4) Diff mode (uses compareMode toggle) */}
              {canDiff && (
                <div className="resultViewPanel__mb12">
                  <div className="resultViewPanel__diffHeader">
                    <div className="resultViewPanel__muted12">
                      Diff (baseline = latest)
                    </div>
                    <div className="mono resultViewPanel__muted12">
                      baseline: {baselineTokens.length} → current: {tokens.length} (Δ {tokens.length - baselineTokens.length})
                    </div>
                  </div>

                  {baselineInlineSegs && (
                    <div className="resultViewPanel__mb8">
                      <div className="resultViewPanel__muted12 resultViewPanel__mb6">
                        Before
                      </div>
                      <div className="tokenInline" aria-label="baseline inline token view">
                        {baselineInlineSegs.map((seg, i) => {
                          if (seg.kind === 'plain') {
                            return (
                              <span key={i} className="tokenInline__plain">
                                {seg.text}
                              </span>
                            )
                          }

                          const offsetLabel =
                            seg.startOffset !== undefined && seg.endOffset !== undefined
                              ? `${seg.startOffset}-${seg.endOffset}`
                              : ''

                          const title = [
                            `#${seg.idx + 1}`,
                            seg.tokenText ? `token: ${seg.tokenText}` : undefined,
                            seg.tokenType ? `type: ${seg.tokenType}` : undefined,
                            seg.position !== undefined ? `position: ${seg.position}` : undefined,
                            offsetLabel ? `offset: ${offsetLabel}` : undefined,
                          ]
                            .filter(Boolean)
                            .join('\n')

                          return (
                            <span
                              key={i}
                              className="tokenInline__tok"
                              title={title}
                              data-token-type={seg.tokenType || undefined}
                            >
                              {seg.text}
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  {inlineSegs && (
                    <div className="resultViewPanel__mb8">
                      <div className="resultViewPanel__muted12 resultViewPanel__mb6">
                        After
                      </div>
                      <div className="tokenInline" aria-label="current inline token view">
                        {inlineSegs.map((seg, i) => {
                          if (seg.kind === 'plain') {
                            return (
                              <span key={i} className="tokenInline__plain">
                                {seg.text}
                              </span>
                            )
                          }

                          const offsetLabel =
                            seg.startOffset !== undefined && seg.endOffset !== undefined
                              ? `${seg.startOffset}-${seg.endOffset}`
                              : ''

                          const title = [
                            `#${seg.idx + 1}`,
                            seg.tokenText ? `token: ${seg.tokenText}` : undefined,
                            seg.tokenType ? `type: ${seg.tokenType}` : undefined,
                            seg.position !== undefined ? `position: ${seg.position}` : undefined,
                            offsetLabel ? `offset: ${offsetLabel}` : undefined,
                          ]
                            .filter(Boolean)
                            .join('\n')

                          return (
                            <span
                              key={i}
                              className="tokenInline__tok"
                              title={title}
                              data-token-type={seg.tokenType || undefined}
                            >
                              {seg.text}
                            </span>
                          )
                        })}
                      </div>
                    </div>
                  )}

                  <LazyDetails
                    className="resultCard__details resultCard__details--mt8"
                    summaryText="TOKEN DIFF (unified)"
                    render={() => (
                      <pre className="mono resultCard__pre">{
                        unifiedDiff({
                          aName: 'baseline.tokens',
                          bName: 'current.tokens',
                          aText: baselineTokens
                            .map((x) => (isJsonObject(x) && typeof x.token === 'string' ? x.token : ''))
                            .join('\n'),
                          bText: tokens
                            .map((x) => (isJsonObject(x) && typeof x.token === 'string' ? x.token : ''))
                            .join('\n'),
                          context: 2,
                        })
                      }</pre>
                    )}
                  />
                </div>
              )}

              <div className="resultList">
                {tokens.map((token, idx: number) => {
                  const tokenObj = isJsonObject(token) ? token : null
                  const tokenText = typeof tokenObj?.token === 'string' ? tokenObj.token : ''
                  const tokenType = typeof tokenObj?.type === 'string' ? tokenObj.type : ''
                  const position = typeof tokenObj?.position === 'number' ? tokenObj.position : undefined
                  const start = typeof tokenObj?.startOffset === 'number' ? tokenObj.startOffset : undefined
                  const end = typeof tokenObj?.endOffset === 'number' ? tokenObj.endOffset : undefined

                  const slice =
                    sourceText && start !== undefined && end !== undefined && start >= 0 && end >= start && end <= sourceText.length
                      ? sourceText.slice(start, end)
                      : ''

                  const offsetLabel = start !== undefined && end !== undefined ? `${start}-${end}` : ''

                  return (
                    <div key={idx} className={'resultCard resultCard--compare'}>
                      <div className="resultCard__top">
                        <div className="resultCard__topMain">
                          <div className="resultCard__index">#{idx + 1}</div>
                          <div className="resultCard__title">
                            <div>{tokenText || '(empty)'}</div>
                            {slice && <div className="resultCard__text-preview">{truncateText(slice, 180)}</div>}
                          </div>
                        </div>
                        <div className="resultCard__scores">
                          {tokenType && (
                            <div className="resultCard__rerankerScore" title={t('tokenType')}>
                              {tokenType}
                            </div>
                          )}
                          {position !== undefined && (
                            <div className="resultCard__score" title={t('position')}>
                              {t('position')}: {position}
                            </div>
                          )}
                          {offsetLabel && (
                            <div className="resultCard__score" title={`${t('startOffset')} / ${t('endOffset')}`}>
                              {offsetLabel}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}
        
        {labMode !== 'agentic' && labMode !== 'analyze' && (
          <>
            {!compareMode && (() => {
              const body = latestResponse.body
              const answersRaw = (isJsonObject(body) && Array.isArray(body['@search.answers'])) ? body['@search.answers'] : []
              const answers = answersRaw.filter((a): a is JsonObject => isJsonObject(a))
              
              if (answers.length === 0) return null
              
              return (
                <div className="answerSection">
                  <div className="answerSection__title">Semantic Answers</div>
                  {answers.map((answer, idx: number) => {
                    const answerText = typeof answer.text === 'string' ? answer.text : ''
                    const answerHighlights = typeof answer.highlights === 'string' ? answer.highlights : ''
                    const score = typeof answer.score === 'number' ? answer.score : null
                    
                    if (!answerText) return null
                    
                    return (
                      <div key={idx} className="answerCard">
                        <div className="answerCard__header">
                          <div className="answerCard__label">Answer {idx + 1}</div>
                          {typeof score === 'number' && (
                            <div className="answerCard__score">score {score.toFixed(4)}</div>
                          )}
                        </div>
                        {answerHighlights.trim().length > 0 ? (
                          <div 
                            className="answerCard__highlight"
                            dangerouslySetInnerHTML={{ __html: sanitizeSearchHighlightsHtml(answerHighlights) }}
                          />
                        ) : (
                          <div className="answerCard__text">{answerText}</div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })()}
            {(() => {
              const docs = extractDocs(latestResponse.body)
              const hasBoosted = docs.some((d) => typeof d['@search.rerankerBoostedScore'] === 'number')
              const hasReranker = docs.some((d) => typeof d['@search.rerankerScore'] === 'number')

              const sorted = docs
                .map((doc, originalIndex) => ({ doc, originalIndex }))
                .sort((a, b) => {
                  const aDoc = a.doc
                  const bDoc = b.doc

                  const key: '@search.rerankerBoostedScore' | '@search.rerankerScore' | '@search.score' = hasBoosted
                    ? '@search.rerankerBoostedScore'
                    : hasReranker
                      ? '@search.rerankerScore'
                      : '@search.score'

                  const aVal = typeof aDoc[key] === 'number' ? aDoc[key] : -Infinity
                  const bVal = typeof bDoc[key] === 'number' ? bDoc[key] : -Infinity
                  const diff = bVal - aVal
                  if (diff !== 0) return diff
                  return a.originalIndex - b.originalIndex
                })

              const allDocs = sorted.map((x) => x.doc)
              const itemsPerPage = 20
              const totalItems = allDocs.length
              const totalPages = Math.ceil(totalItems / itemsPerPage)
              const startIdx = (currentPage - 1) * itemsPerPage
              const endIdx = startIdx + itemsPerPage
              const currentDocs = allDocs.slice(startIdx, endIdx)
              
              return (
                <>
                  {totalItems > 0 && (
                    <div className="resultInfo">
                      <div className="resultInfo__text">
                        Showing {startIdx + 1}-{Math.min(endIdx, totalItems)} of {totalItems} results
                      </div>
                    </div>
                  )}
                  <div className="resultList">
                    {currentDocs.map((doc, idx) => {
              const score = doc['@search.score']
              const rerankerScore = doc['@search.rerankerScore']
              const rerankerBoostedScore = doc['@search.rerankerBoostedScore']
              const captions = doc['@search.captions']
              const caption0 = Array.isArray(captions) ? captions[0] : null
              const captionObj = (caption0 && typeof caption0 === 'object' && !Array.isArray(caption0)) ? (caption0 as Record<string, JsonValue>) : null
              const captionText = typeof captionObj?.text === 'string' ? captionObj.text : ''
              const captionHighlights = typeof captionObj?.highlights === 'string' ? captionObj.highlights : ''
              const text = pickFirstStringField(doc, settings?.displayTextFields) ?? (typeof doc.text === 'string' ? doc.text : undefined)
              const highlights = doc['@search.highlights']
              const highlightFields = isJsonObject(highlights) ? Object.entries(highlights) : []
              return (
                <div key={idx} className={'resultCard' + (compareMode ? ' resultCard--compare' : '')}>
                  {compareMode ? (
                    <div className="resultCard__top">
                      <div className="resultCard__topMain">
                        <div className="resultCard__index">#{startIdx + idx + 1}</div>
                        <div className="resultCard__title">
                          <div>{pickPrimaryText(doc, settings?.displayTitleFields)}</div>
                          {text && <div className="resultCard__text-preview">{truncateText(text, 180)}</div>}
                        </div>
                      </div>
                      <div className="resultCard__scores">
                        {typeof rerankerBoostedScore === 'number' && (
                          <div className="resultCard__rerankerScore" title="reranker boosted score">boosted {rerankerBoostedScore.toFixed(4)}</div>
                        )}
                        {typeof rerankerScore === 'number' && (
                          <div className="resultCard__rerankerScore" title="reranker score">re {rerankerScore.toFixed(4)}</div>
                        )}
                        {typeof score === 'number' && (
                          <div className="resultCard__score" title="score">{score.toFixed(4)}</div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="resultCard__index">#{startIdx + idx + 1}</div>
                      <div className="resultCard__top">
                        <div className="resultCard__title">{pickPrimaryText(doc, settings?.displayTitleFields)}</div>
                        <div className="resultCard__scores">
                          {typeof rerankerBoostedScore === 'number' && (
                            <div className="resultCard__rerankerScore">
                              boosted {rerankerBoostedScore.toFixed(4)}
                            </div>
                          )}
                          {typeof rerankerScore === 'number' && (
                            <div className="resultCard__rerankerScore">
                              reranker {rerankerScore.toFixed(4)}
                            </div>
                          )}
                          {typeof score === 'number' && (
                            <div className="resultCard__score">score {score.toFixed(4)}</div>
                          )}
                        </div>
                      </div>
                      {typeof captionText === 'string' && captionText.trim().length > 0 && (
                        <div className="resultCard__captionArea">
                          <div className="resultCard__captionLabel">Semantic Caption</div>
                          {typeof captionHighlights === 'string' && captionHighlights.trim().length > 0 ? (
                            <div
                              className="resultCard__captionHighlight"
                              dangerouslySetInnerHTML={{ __html: sanitizeSearchHighlightsHtml(captionHighlights) }}
                            />
                          ) : (
                            <div className="resultCard__captionText"><TruncTextInline text={captionText} collapsedChars={800} t={t} /></div>
                          )}
                        </div>
                      )}
                      {highlightFields.length > 0 && (
                        <div className="resultCard__highlights">
                          {highlightFields.map(([field, values]) => (
                            <div key={field} className="resultCard__highlightField">
                              <div className="resultCard__highlightLabel">{field}:</div>
                              {Array.isArray(values) &&
                                values.map((val, i) => (
                                  <div
                                    key={i}
                                    className="resultCard__highlightValue"
                                    dangerouslySetInnerHTML={{ __html: sanitizeSearchHighlightsHtml(String(val)) }}
                                  />
                                ))}
                            </div>
                          ))}
                        </div>
                      )}
                      {typeof text === 'string' && text.trim().length > 0 && (
                        <div className="resultCard__text"><TruncTextInline text={text} collapsedChars={800} t={t} /></div>
                      )}
                      <LazyDetails
                        key={`${rawDetailsResetKey}:raw-document:${startIdx + idx}`}
                        className="resultCard__details"
                        summaryText="RAW DOCUMENT"
                        render={() => (
                          <div className="mono jsonViewer__body rawJsonViewer">
                            <JsonViewer
                              data={doc as unknown as JsonValue}
                              initialOpenDepth={2}
                              maxStringLength={JSON_VIEWER_MAX_STRING_LENGTH}
                              hideRootObjectToggle
                              collapseArraysByDefault
                              t={t}
                            />
                          </div>
                        )}
                      />
                    </>
                  )}
                </div>
              )
            })}
                  </div>
                  {totalPages > 1 && (
                    <div className="pagination">
                      <button
                        className="btn pagination__btn"
                        disabled={currentPage === 1}
                        onClick={() => onPageChange(currentPage - 1)}
                      >
                        Previous
                      </button>
                      <div className="pagination__info">
                        Page {currentPage} of {totalPages}
                      </div>
                      <button
                        className="btn pagination__btn"
                        disabled={currentPage === totalPages}
                        onClick={() => onPageChange(currentPage + 1)}
                      >
                        Next
                      </button>
                    </div>
                  )}
                </>
              )
            })()}
            {extractDocs(latestResponse.body).length === 0 && (
              <div className="empty">{t('noValueArray')}</div>
            )}
          </>
        )}
      </>
    </div>
  )
}
