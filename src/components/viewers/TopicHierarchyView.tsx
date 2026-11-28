import { lazy, Suspense, useEffect, useEffectEvent, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { JsonObject } from '../../app/json'
import { useTopicChartColors } from '../../hooks/useTopicChartColors'
import { KNOWLEDGE_GRAPH_API_VERSION } from '../../lib/knowledgeGraph'
import type { ConnectionProfile } from '../../lib/model'
import { describeTopicPath, type TopicHierarchy } from '../../lib/topicGraphCoverage'
import {
  loadChunkText, loadTopicHierarchy, loadWheelChunks, MAX_WHEEL_CHUNKS, TopicGraphReadError, type TopicGraphReadErrorCode, type TopicWheelChunks,
} from '../../lib/topicGraphReader'
import {
  buildSunburstItems, buildSunburstOption, buildTreeItems, buildTreeOption, chunkLabels, countChunks, countLeafTopics, formatShare, topicAncestry,
  topicWheelLabel, TREE_ROOT_ID, type TopicChartText, type TreeLayout, type TreeMode,
} from '../../lib/topicCharts'
import { translations, type Language, type TranslationKey } from '../../lib/translations'
import type { ThemePreference } from '../../types'

const TopicEChart = lazy(() => import('./TopicEChart'))

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

type Selection = { kind: 'topic' | 'chunk'; id: string }
type ChunkState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; failure: ReadFailure }
  | { status: 'ready'; data: TopicWheelChunks }
type ChunkTextState =
  | { status: 'loading' }
  | { status: 'error'; failure: ReadFailure }
  | { status: 'ready'; text?: string }

/** What the charts report about a click: the chart part that was hit and the data item behind it. */
type ChartClick = { componentType?: string; data?: { id?: string; kind?: string; zoomable?: boolean } }
const asChartClick = (params: unknown): ChartClick => (typeof params === 'object' && params !== null ? params as ChartClick : {})

const TREE_LAYOUTS = [
  { id: 'LR', icon: 'bi-arrow-right', label: 'kgTreeLayoutHorizontal' },
  { id: 'TB', icon: 'bi-arrow-down', label: 'kgTreeLayoutVertical' },
  { id: 'radial', icon: 'bi-bullseye', label: 'kgTreeLayoutRadial' },
] as const satisfies ReadonlyArray<{ id: TreeLayout; icon: string; label: TranslationKey }>

const WHEEL_STYLE: CSSProperties = { height: 'clamp(440px, 70vh, 740px)', width: '100%' }
const treeStyle = (layout: TreeLayout, visibleLeaves: number): CSSProperties => ({
  height: layout === 'TB' || layout === 'radial' ? 640 : Math.min(1100, Math.max(520, visibleLeaves * 26 + 120)),
  width: '100%',
})

/**
 * The topic hierarchy of a topic index as a sunburst or a tree (both drawn by ECharts), with a details panel. Both views
 * share the loaded hierarchy, the overlaid chunks and the selection. The hierarchy is read from the whole topic index,
 * not from the (possibly limited or filtered) documents that the graph view shows. Chunks are read only when the user asks.
 */
export function TopicHierarchyView({ profile, indexName, definition, language, theme, view }: {
  profile: ConnectionProfile | null
  indexName: string
  definition: JsonObject
  language: Language
  theme: ThemePreference
  view: 'wheel' | 'tree'
}) {
  const t = (key: TranslationKey) => translations[language][key]
  const colors = useTopicChartColors(theme)
  const [loaded, setLoaded] = useState<{ definition: JsonObject; hierarchy?: TopicHierarchy; failure?: ReadFailure } | null>(null)
  const [chunkState, setChunkState] = useState<ChunkState>({ status: 'idle' })
  const [showChunks, setShowChunks] = useState(true)
  const [focusId, setFocusId] = useState<string>()
  const [selected, setSelected] = useState<Selection | null>(null)
  const [treeLayout, setTreeLayout] = useState<TreeLayout>('LR')
  // A new object on every click, so that choosing the same mode again folds or opens what the user changed by hand.
  const [treeMode, setTreeMode] = useState<{ mode: TreeMode }>({ mode: 'default' })
  const [chunkTexts, setChunkTexts] = useState<ReadonlyMap<string, ChunkTextState>>(new Map())
  const chunkControllerRef = useRef<AbortController | null>(null)
  const textControllersRef = useRef(new Set<AbortController>())

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
  useEffect(() => {
    const textControllers = textControllersRef.current
    return () => {
      chunkControllerRef.current?.abort()
      textControllers.forEach((controller) => controller.abort())
    }
  }, [])

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
  const animate = useMemo(() => typeof window.matchMedia !== 'function' || !window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])
  const chartText = useMemo<TopicChartText>(() => {
    const copy = translations[language]
    return {
      collection: copy.kgWheelCollection, share: copy.kgWheelShare, chunks: copy.kgWheelChunksIn,
      assignedTopic: copy.kgWheelAssignedTopic, leafTopics: copy.kgWheelLeafTopics,
    }
  }, [language])

  const wheel = useMemo(() => {
    if (view !== 'wheel' || !hierarchy) return undefined
    const copy = translations[language]
    const sunburst = buildSunburstItems({ hierarchy, chunks: wheelChunks, labels, text: chartText, focusId: focus?.id })
    const count = wheelChunks ? sunburst.total : countLeafTopics(hierarchy, focus?.id)
    return {
      items: sunburst.items,
      option: buildSunburstOption({
        items: sunburst.items,
        title: focus ? topicWheelLabel(focus) : copy.kgWheelCollection,
        subtitle: fill(wheelChunks ? copy.kgWheelChunkCount : copy.kgWheelTopicCount, { count }),
        colors, animate, ariaLabel: copy.kgWheelAria,
      }),
    }
  }, [view, hierarchy, language, wheelChunks, labels, chartText, focus, colors, animate])

  const tree = useMemo(() => {
    if (view !== 'tree' || !hierarchy) return undefined
    const built = buildTreeItems({ hierarchy, chunks: wheelChunks, labels, text: chartText, mode: treeMode.mode, colors })
    return { visibleLeaves: built.visibleLeaves, option: buildTreeOption({ root: built.root, layout: treeLayout, colors, animate, ariaLabel: translations[language].kgTreeAria }) }
  }, [view, hierarchy, language, wheelChunks, labels, chartText, treeMode, treeLayout, colors, animate])

  async function loadChunks() {
    if (!hierarchy || !profile || profile.apiVersion !== KNOWLEDGE_GRAPH_API_VERSION) return
    chunkControllerRef.current?.abort()
    const controller = new AbortController()
    chunkControllerRef.current = controller
    setChunkState({ status: 'loading' })
    setChunkTexts(new Map())
    try {
      const data = await loadWheelChunks({ profile, language, signal: controller.signal }, indexName, hierarchy)
      if (controller.signal.aborted) return
      setChunkState({ status: 'ready', data })
      setShowChunks(true)
    } catch (error) {
      if (!controller.signal.aborted) setChunkState({ status: 'error', failure: toFailure(error) })
    }
  }

  async function readChunkText(key: string) {
    const source = chunkData
    if (!source?.textField || !profile || profile.apiVersion !== KNOWLEDGE_GRAPH_API_VERSION) return
    const known = chunkTexts.get(key)
    if (known?.status === 'loading' || known?.status === 'ready') return
    const controller = new AbortController()
    textControllersRef.current.add(controller)
    const remember = (state: ChunkTextState) => setChunkTexts((current) => new Map(current).set(key, state))
    remember({ status: 'loading' })
    try {
      const text = await loadChunkText({ profile, language, signal: controller.signal }, { contentIndex: source.contentIndex, keyField: source.keyField, textField: source.textField }, key)
      if (!controller.signal.aborted) remember({ status: 'ready', text })
    } catch (error) {
      if (!controller.signal.aborted) remember({ status: 'error', failure: toFailure(error) })
    } finally {
      textControllersRef.current.delete(controller)
    }
  }

  function selectChunk(key: string) {
    setSelected({ kind: 'chunk', id: key })
    void readChunkText(key)
  }

  function toggleChunks() {
    const next = !showChunks
    setShowChunks(next)
    if (next) return
    if (selected?.kind === 'chunk') setSelected(null)
    if (focus && focus.children.length === 0) setFocusId(focus.parentId)
  }

  function zoomOut() {
    if (!focus) return
    setFocusId(focus.parentId)
    setSelected(null)
  }

  function onWheelClick(params: unknown) {
    const { componentType, data } = asChartClick(params)
    if (componentType === 'title') zoomOut()
    else if (!data?.id) return
    else if (data.kind === 'chunk') selectChunk(data.id)
    else if (data.zoomable) {
      setFocusId(data.id)
      setSelected(null)
    } else setSelected({ kind: 'topic', id: data.id })
  }

  function onTreeClick(params: unknown) {
    const { data } = asChartClick(params)
    if (!data?.id) return
    if (data.kind === 'chunk') selectChunk(data.id)
    else if (data.kind === 'topic') setSelected({ kind: 'topic', id: data.id })
    else if (data.id === TREE_ROOT_ID) setSelected(null)
  }

  // The chart rebinds its event handlers whenever the object changes, so hand it handlers that never change.
  const clickHandlers = useRef({ wheel: onWheelClick, tree: onTreeClick })
  useEffect(() => { clickHandlers.current = { wheel: onWheelClick, tree: onTreeClick } })
  const wheelEvents = useMemo(() => ({ click: (params: unknown) => clickHandlers.current.wheel(params) }), [])
  const treeEvents = useMemo(() => ({ click: (params: unknown) => clickHandlers.current.tree(params) }), [])

  const describe = (value: ReadFailure) => fill(t(ERROR_KEYS[value.code]), { detail: value.detail })
  const target: Selection | null = selected ?? (view === 'wheel' && focus ? { kind: 'topic', id: focus.id } : null)
  const targetTopic = hierarchy && target?.kind === 'topic' ? hierarchy.topics.get(target.id) : undefined
  const targetChunk = target?.kind === 'chunk' ? chunkData?.assignments.get(target.id) : undefined
  const targetText = target?.kind === 'chunk' ? chunkTexts.get(target.id) : undefined
  const crumbs = hierarchy && focus ? topicAncestry(hierarchy, focus.id) : []
  const chartFallback = <div className="field__hint topicWheel__chartLoading" role="status"><i className="bi bi-arrow-repeat spin icon--mr6" aria-hidden="true" />{t('kgWheelLoading')}</div>

  return <div className="topicWheel">
    <div className="topicWheel__toolbar">
      {view === 'wheel'
        ? <nav className="topicWheel__crumbs" aria-label={t('kgWheelAria')}>
          <button type="button" className="btn btn--ghost btn--sm" disabled={!focus} onClick={() => { setFocusId(undefined); setSelected(null) }}>
            <i className="bi bi-bullseye icon--mr6" aria-hidden="true" />{t('kgWheelCollection')}
          </button>
          {crumbs.map((id, index) => <span key={id} className="topicWheel__crumb">
            <i className="bi bi-chevron-right" aria-hidden="true" />
            <button type="button" className="btn btn--ghost btn--sm" disabled={index === crumbs.length - 1}
              onClick={() => { setFocusId(id); setSelected(null) }}>{topicWheelLabel(hierarchy!.topics.get(id)!)}</button>
          </span>)}
        </nav>
        : <div className="topicWheel__treeControls">
          <div className="actions actions--tight" role="group" aria-label={t('kgTreeLayout')}>
            {TREE_LAYOUTS.map((item) => <button key={item.id} type="button" className={`btn btn--sm ${treeLayout === item.id ? 'btn--primary' : 'btn--secondary'}`}
              aria-pressed={treeLayout === item.id} onClick={() => setTreeLayout(item.id)}>
              <i className={`bi ${item.icon} icon--mr6`} aria-hidden="true" />{t(item.label)}
            </button>)}
          </div>
          <div className="actions actions--tight">
            <button type="button" className="btn btn--ghost btn--sm" disabled={!hierarchy} onClick={() => setTreeMode({ mode: 'expanded' })}>
              <i className="bi bi-arrows-expand icon--mr6" aria-hidden="true" />{t('kgTreeExpandAll')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={!hierarchy} onClick={() => setTreeMode({ mode: 'collapsed' })}>
              <i className="bi bi-arrows-collapse icon--mr6" aria-hidden="true" />{t('kgTreeCollapseAll')}
            </button>
          </div>
        </div>}
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
    {hierarchy && (view === 'wheel' && wheel?.items.length === 0
      ? <div className="field__hint">{t('kgWheelEmpty')}</div>
      : <div className="topicWheel__body">
        <div className="topicWheel__stage topicWheel__stage--chart">
          <Suspense fallback={chartFallback}>
            {wheel && <TopicEChart key="wheel" option={wheel.option} style={WHEEL_STYLE} onEvents={wheelEvents} />}
            {tree && <TopicEChart key={`tree-${treeLayout}`} option={tree.option} style={treeStyle(treeLayout, tree.visibleLeaves)} onEvents={treeEvents} />}
          </Suspense>
        </div>
        <aside className="topicWheel__details" aria-label={t('kgWheelDetails')}>
          <h4 className="kgInspector__caption">{t('kgWheelDetails')}</h4>
          {!targetTopic && !targetChunk && <p className="field__hint">{t('kgWheelDetailsEmpty')}</p>}
          {targetTopic && <>
            <strong className="topicWheel__detailsTitle">{topicWheelLabel(targetTopic)}</strong>
            <dl className="topicWheel__facts">
              <div><dt>{t('kgWheelPath')}</dt><dd>{describeTopicPath(hierarchy, targetTopic.id)}</dd></div>
              {targetTopic.description && <div><dt>{t('kgWheelDescription')}</dt><dd>{targetTopic.description}</dd></div>}
              <div><dt>{t('kgWheelShare')}</dt><dd>{formatShare(targetTopic.proportion)}</dd></div>
              <div><dt>{t('kgWheelLeafTopics')}</dt><dd>{countLeafTopics(hierarchy, targetTopic.id).toLocaleString(language)}</dd></div>
              {wheelChunks && <div><dt>{t('kgWheelChunksIn')}</dt><dd>{countChunks(hierarchy, wheelChunks, targetTopic.id).toLocaleString(language)}</dd></div>}
            </dl>
            {wheelChunks && targetTopic.children.length === 0 && <>
              <span className="field__label">{t('kgWheelChunkList')}</span>
              <ul className="topicWheel__chunkList">
                {(wheelChunks.get(targetTopic.id) ?? []).map((key) => <li key={key}>
                  <button type="button" className="btn btn--ghost btn--sm" title={key} onClick={() => selectChunk(key)}>{labels.get(key)}</button>
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
            <span className="field__label">{t('kgWheelChunkText')}{chunkData?.textField && <> <code>{chunkData.textField}</code></>}</span>
            {!chunkData?.textField
              ? <p className="field__hint">{t('kgWheelChunkTextNoField')}</p>
              : targetText?.status === 'loading'
                ? <div className="field__hint" role="status"><i className="bi bi-arrow-repeat spin icon--mr6" aria-hidden="true" />{t('kgWheelChunkTextLoading')}</div>
                : targetText?.status === 'error'
                  ? <div className="notice notice--error" role="alert">{describe(targetText.failure)}</div>
                  : targetText?.status === 'ready' && targetText.text
                    ? <pre className="topicWheel__chunkText" tabIndex={0}>{targetText.text}</pre>
                    : <p className="field__hint">{t('kgWheelChunkTextEmpty')}</p>}
          </>}
        </aside>
      </div>)}
    <p className="field__hint">{t(view === 'tree' ? 'kgTreeHint' : 'kgWheelHint')}</p>
    {chunkState.status !== 'ready' && <p className="field__hint">{fill(t('kgWheelChunksHint'), { max: MAX_WHEEL_CHUNKS })}</p>}
  </div>
}
