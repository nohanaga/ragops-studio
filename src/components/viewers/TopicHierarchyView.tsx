import { useEffect, useEffectEvent, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { JsonObject } from '../../app/json'
import { KNOWLEDGE_GRAPH_API_VERSION } from '../../lib/knowledgeGraph'
import type { ConnectionProfile } from '../../lib/model'
import { describeTopicPath, topicBranchColor, type TopicHierarchy } from '../../lib/topicGraphCoverage'
import {
  loadTopicHierarchy, loadWheelChunks, MAX_WHEEL_CHUNKS, TopicGraphReadError, type TopicGraphReadErrorCode, type TopicWheelChunks,
} from '../../lib/topicGraphReader'
import {
  chunkLabels, countChunks, countLeafTopics, fitWheelText, layoutTopicSunburst, placeWheelLabel, ringSegmentPath, topicAncestry,
  topicShortId, topicWheelLabel, type SunburstArc,
} from '../../lib/topicSunburst'
import { translations, type Language, type TranslationKey } from '../../lib/translations'

const CENTER_RADIUS = 64
const OUTER_RADIUS_TARGET = 340
const MIN_RING = 34
const MAX_RING = 76
const FONT_SIZE = 11

type ReadFailure = { code: TopicGraphReadErrorCode | 'unexpected' | 'needVersion'; detail: string }

const ERROR_KEYS = {
  request: 'kgWheelErrorRequest',
  noContentIndex: 'kgWheelErrorNoContentIndex',
  noTopicProfile: 'kgWheelErrorNoTopicProfile',
  ambiguousVector: 'kgWheelErrorAmbiguous',
  vectorNotRetrievable: 'kgWheelErrorVectorNotRetrievable',
  unsupportedTopicIndex: 'kgWheelErrorUnsupported',
  tooLarge: 'kgWheelErrorTooLarge',
  unexpected: 'kgWheelErrorUnexpected',
  needVersion: 'kgNeedVersion',
} satisfies Record<ReadFailure['code'], TranslationKey>

function toFailure(error: unknown): ReadFailure {
  if (error instanceof TopicGraphReadError) return { code: error.code, detail: error.detail }
  return { code: 'unexpected', detail: error instanceof Error ? error.message : String(error) }
}

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template)

const percent = (value: number) => `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`

type Selection = { kind: 'topic' | 'chunk'; id: string }
type ChunkState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; failure: ReadFailure }
  | { status: 'ready'; data: TopicWheelChunks }

const activateWithKeyboard = (event: KeyboardEvent, action: () => void) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  action()
}

/**
 * Sunburst of the topic hierarchy of a topic index. The hierarchy is read from the whole topic index, not from the
 * (possibly limited or filtered) documents that the graph view shows. Chunks are read only when the user asks for them.
 */
export function TopicWheel({ profile, indexName, definition, language }: {
  profile: ConnectionProfile | null
  indexName: string
  definition: JsonObject
  language: Language
}) {
  const t = (key: TranslationKey) => translations[language][key]
  const [loaded, setLoaded] = useState<{ definition: JsonObject; hierarchy?: TopicHierarchy; failure?: ReadFailure } | null>(null)
  const [chunkState, setChunkState] = useState<ChunkState>({ status: 'idle' })
  const [showChunks, setShowChunks] = useState(true)
  const [focusId, setFocusId] = useState<string>()
  const [selected, setSelected] = useState<Selection | null>(null)
  const chunkControllerRef = useRef<AbortController | null>(null)

  const readHierarchy = useEffectEvent(async (signal: AbortSignal) => {
    if (!profile || profile.apiVersion !== KNOWLEDGE_GRAPH_API_VERSION) {
      setLoaded({ definition, failure: { code: 'needVersion', detail: '' } })
      return
    }
    try {
      const hierarchy = await loadTopicHierarchy({ profile, language, signal }, { topicIndex: indexName, topicDefinition: definition })
      if (!signal.aborted) setLoaded({ definition, hierarchy })
    } catch (error) {
      if (!signal.aborted) setLoaded({ definition, failure: toFailure(error) })
    }
  })
  useEffect(() => {
    const controller = new AbortController()
    void readHierarchy(controller.signal)
    return () => controller.abort()
  }, [definition, indexName])
  useEffect(() => () => chunkControllerRef.current?.abort(), [])

  const loading = loaded?.definition !== definition
  const hierarchy = loading ? undefined : loaded?.hierarchy
  const failure = loading ? undefined : loaded?.failure
  const chunkData = chunkState.status === 'ready' ? chunkState.data : undefined
  const wheelChunks = useMemo(() => {
    if (!chunkData || !showChunks) return undefined
    const byLeaf = new Map<string, string[]>()
    for (const [key, { leafId }] of chunkData.assignments) byLeaf.set(leafId, [...(byLeaf.get(leafId) ?? []), key])
    return byLeaf
  }, [chunkData, showChunks])
  const labels = useMemo(() => chunkLabels(chunkData?.assignments.keys() ?? []), [chunkData])
  const focus = hierarchy && focusId ? hierarchy.topics.get(focusId) : undefined
  const layout = useMemo(() => hierarchy ? layoutTopicSunburst(hierarchy, wheelChunks, focus?.id) : undefined, [hierarchy, wheelChunks, focus?.id])

  async function loadChunks() {
    if (!hierarchy || !profile || profile.apiVersion !== KNOWLEDGE_GRAPH_API_VERSION) return
    chunkControllerRef.current?.abort()
    const controller = new AbortController()
    chunkControllerRef.current = controller
    setChunkState({ status: 'loading' })
    try {
      const data = await loadWheelChunks({ profile, language, signal: controller.signal }, indexName, hierarchy)
      if (controller.signal.aborted) return
      setChunkState({ status: 'ready', data })
      setShowChunks(true)
    } catch (error) {
      if (!controller.signal.aborted) setChunkState({ status: 'error', failure: toFailure(error) })
    }
  }

  function toggleChunks() {
    const next = !showChunks
    setShowChunks(next)
    if (next) return
    if (selected?.kind === 'chunk') setSelected(null)
    if (focus && focus.children.length === 0) setFocusId(focus.parentId)
  }

  function activate(arc: SunburstArc) {
    if (arc.kind === 'topic' && arc.zoomable) {
      setFocusId(arc.id)
      setSelected(null)
    } else {
      setSelected({ kind: arc.kind, id: arc.id })
    }
  }

  function zoomOut() {
    if (!focus) return
    setFocusId(focus.parentId)
    setSelected(null)
  }

  const describe = (value: ReadFailure) => fill(t(ERROR_KEYS[value.code]), { detail: value.detail })
  const ring = layout ? Math.min(MAX_RING, Math.max(MIN_RING, (OUTER_RADIUS_TARGET - CENTER_RADIUS) / Math.max(layout.levels, 1))) : MIN_RING
  const extent = CENTER_RADIUS + (layout?.levels ?? 0) * ring + 10
  const target: Selection | null = selected ?? (focus ? { kind: 'topic', id: focus.id } : null)
  const targetTopic = hierarchy && target?.kind === 'topic' ? hierarchy.topics.get(target.id) : undefined
  const targetChunk = target?.kind === 'chunk' ? chunkData?.assignments.get(target.id) : undefined
  const centerTitle = focus ? topicWheelLabel(focus) : t('kgWheelCollection')
  const centerCount = !hierarchy || !layout ? 0 : wheelChunks ? layout.total : countLeafTopics(hierarchy, focus?.id)
  const centerCountText = fill(t(wheelChunks ? 'kgWheelChunkCount' : 'kgWheelTopicCount'), { count: centerCount })
  const crumbs = hierarchy && focus ? topicAncestry(hierarchy, focus.id) : []

  const topicTooltip = (arc: SunburstArc) => {
    const node = hierarchy!.topics.get(arc.id)!
    return [
      `${describeTopicPath(hierarchy!, arc.id)} (${topicShortId(arc.id)})`,
      wheelChunks ? `${t('kgWheelChunksIn')}: ${arc.value}` : `${t('kgWheelShare')}: ${percent(node.proportion)}`,
    ].join('\n')
  }

  return <div className="topicWheel">
    <div className="topicWheel__toolbar">
      <nav className="topicWheel__crumbs" aria-label={t('kgWheelAria')}>
        <button type="button" className="btn btn--ghost btn--sm" disabled={!focus} onClick={() => { setFocusId(undefined); setSelected(null) }}>
          <i className="bi bi-bullseye icon--mr6" aria-hidden="true" />{t('kgWheelCollection')}
        </button>
        {crumbs.map((id, index) => <span key={id} className="topicWheel__crumb">
          <i className="bi bi-chevron-right" aria-hidden="true" />
          <button type="button" className="btn btn--ghost btn--sm" disabled={index === crumbs.length - 1}
            onClick={() => { setFocusId(id); setSelected(null) }}>{topicWheelLabel(hierarchy!.topics.get(id)!)}</button>
        </span>)}
      </nav>
      <div className="actions actions--tight">
        {chunkState.status === 'ready'
          ? <button type="button" className="btn btn--secondary btn--sm" aria-pressed={showChunks} onClick={toggleChunks}>
            <i className={`bi ${showChunks ? 'bi-eye-slash' : 'bi-eye'} icon--mr6`} aria-hidden="true" />{t(showChunks ? 'kgWheelHideChunks' : 'kgWheelShowChunks')}
          </button>
          : <button type="button" className="btn btn--secondary btn--sm" disabled={!hierarchy || chunkState.status === 'loading'} onClick={() => void loadChunks()}>
            <i className={`bi ${chunkState.status === 'loading' ? 'bi-arrow-repeat spin' : 'bi-layers'} icon--mr6`} aria-hidden="true" />
            {t(chunkState.status === 'loading' ? 'kgWheelChunksLoading' : 'kgWheelLoadChunks')}
          </button>}
      </div>
    </div>
    {loading && <div className="field__hint" role="status"><i className="bi bi-arrow-repeat spin icon--mr6" aria-hidden="true" />{t('kgWheelLoading')}</div>}
    {failure && <div className="notice notice--error" role="alert">{describe(failure)}</div>}
    {chunkState.status === 'error' && <div className="notice notice--error" role="alert">{describe(chunkState.failure)}</div>}
    {chunkData?.truncated && <div className="notice notice--info" role="status">{fill(t('kgWheelChunksTruncated'), { max: MAX_WHEEL_CHUNKS })}</div>}
    {chunkData && chunkData.unassigned > 0 && <div className="notice notice--info" role="status">{fill(t('kgWheelChunksUnassigned'), { count: chunkData.unassigned })}</div>}
    {hierarchy && layout && (layout.arcs.length === 0
      ? <div className="field__hint">{t('kgWheelEmpty')}</div>
      : <div className="topicWheel__body">
        <div className="topicWheel__stage">
          <svg className="topicWheel__svg" viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`} role="group" aria-label={t('kgWheelAria')}>
            {layout.arcs.map((arc) => {
              const inner = CENTER_RADIUS + (arc.depth - 1) * ring
              const outer = inner + ring
              const topic = arc.kind === 'topic' ? hierarchy.topics.get(arc.id) : undefined
              const text = topic ? topicWheelLabel(topic) : labels.get(arc.id) ?? arc.id
              const label = placeWheelLabel(text, inner, outer, arc.start, arc.end, FONT_SIZE)
              const isSelected = selected?.kind === arc.kind && selected.id === arc.id
              const tooltip = topic ? topicTooltip(arc) : `${text}: ${arc.id}\n${describeTopicPath(hierarchy, arc.topicId)}`
              return <g key={`${arc.kind}:${arc.id}`}
                className={`topicWheel__arc topicWheel__arc--${arc.kind}${isSelected ? ' topicWheel__arc--selected' : ''}`}
                role="button" aria-label={text} aria-pressed={arc.kind === 'chunk' || !arc.zoomable ? isSelected : undefined}
                tabIndex={arc.kind === 'topic' ? 0 : undefined}
                onClick={() => activate(arc)} onKeyDown={(event) => activateWithKeyboard(event, () => activate(arc))}>
                <title>{tooltip}</title>
                <path d={ringSegmentPath(inner, outer, arc.start, arc.end)} fill={topicBranchColor(Math.max(0, arc.branchIndex))} fillOpacity={arc.kind === 'chunk' ? 0.62 : 0.94} />
                {label && <text className="topicWheel__label" fontSize={FONT_SIZE} transform={`translate(${label.x} ${label.y}) rotate(${label.rotation})`}>{label.text}</text>}
              </g>
            })}
            <g className={`topicWheel__center${focus ? '' : ' topicWheel__center--root'}`} role="button" aria-label={focus ? t('kgWheelUp') : centerTitle}
              aria-disabled={!focus} tabIndex={focus ? 0 : undefined} onClick={zoomOut} onKeyDown={(event) => activateWithKeyboard(event, zoomOut)}>
              <title>{focus ? `${centerTitle}\n${t('kgWheelUp')}` : centerTitle}</title>
              <circle r={CENTER_RADIUS} />
              <text className="topicWheel__centerTitle" y={-7}>{fitWheelText(centerTitle, CENTER_RADIUS * 2 - 16, 12) ?? centerTitle.slice(0, 4)}</text>
              <text className="topicWheel__centerCount" y={12}>{centerCountText}</text>
            </g>
          </svg>
        </div>
        <aside className="topicWheel__details" aria-label={t('kgWheelDetails')}>
          <h4 className="kgInspector__caption">{t('kgWheelDetails')}</h4>
          {!targetTopic && !targetChunk && <p className="field__hint">{t('kgWheelDetailsEmpty')}</p>}
          {targetTopic && <>
            <strong className="topicWheel__detailsTitle">{topicWheelLabel(targetTopic)}</strong>
            <dl className="topicWheel__facts">
              <div><dt>{t('kgWheelPath')}</dt><dd>{describeTopicPath(hierarchy, targetTopic.id)}</dd></div>
              {targetTopic.description && <div><dt>{t('kgWheelDescription')}</dt><dd>{targetTopic.description}</dd></div>}
              <div><dt>{t('kgWheelShare')}</dt><dd>{percent(targetTopic.proportion)}</dd></div>
              <div><dt>{t('kgWheelLeafTopics')}</dt><dd>{countLeafTopics(hierarchy, targetTopic.id).toLocaleString(language)}</dd></div>
              {wheelChunks && <div><dt>{t('kgWheelChunksIn')}</dt><dd>{countChunks(hierarchy, wheelChunks, targetTopic.id).toLocaleString(language)}</dd></div>}
            </dl>
            {wheelChunks && targetTopic.children.length === 0 && <>
              <span className="field__label">{t('kgWheelChunkList')}</span>
              <ul className="topicWheel__chunkList">
                {(wheelChunks.get(targetTopic.id) ?? []).map((key) => <li key={key}>
                  <button type="button" className="btn btn--ghost btn--sm" title={key} onClick={() => setSelected({ kind: 'chunk', id: key })}>{labels.get(key)}</button>
                </li>)}
              </ul>
            </>}
          </>}
          {targetChunk && target && <>
            <strong className="topicWheel__detailsTitle">{labels.get(target.id)}</strong>
            <dl className="topicWheel__facts">
              <div><dt>{t('kgWheelChunkKey')}</dt><dd className="topicWheel__key">{target.id}</dd></div>
              <div><dt>{t('kgWheelAssignedTopic')}</dt><dd>{describeTopicPath(hierarchy, targetChunk.leafId)}</dd></div>
            </dl>
          </>}
        </aside>
      </div>)}
    <p className="field__hint">{t('kgWheelHint')}</p>
    {chunkState.status !== 'ready' && <p className="field__hint">{fill(t('kgWheelChunksHint'), { max: MAX_WHEEL_CHUNKS })}</p>}
  </div>
}
