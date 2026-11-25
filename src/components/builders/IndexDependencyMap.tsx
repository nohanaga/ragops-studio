/**
 * Dependency map of the resources around the selected index.
 *
 *   Knowledge base -> Knowledge source -> Index -> Topic profile -> Topic index
 *
 * Every resource can be opened: indexes and topic profiles in the Index Builder,
 * knowledge sources and knowledge bases in their own builders.
 */

import { useEffect, useMemo, useState } from 'react'

import { getIndexStatistics } from '../../lib/aiSearchRest'
import {
  DEPENDENCY_NODE_HEIGHT,
  DEPENDENCY_NODE_WIDTH,
  buildDependencyGraph,
  layoutDependencyGraph,
  withDraftIndex,
  type DependencyEdgeKind,
  type DependencyNodeKind,
  type IndexRole,
  type PositionedNode,
} from '../../lib/indexDependencies'
import { MAX_DETAIL_REQUESTS, loadDependencySnapshot, type DependencyResource, type DependencySnapshotResult } from '../../lib/indexDependencyLoader'
import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import type { Language, TranslationKey } from '../../lib/translations'
import { translations } from '../../lib/translations'

type IndexDependencyMapProps = {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion | ''
  language: Language
  /** Index shown at the center of the map. */
  focusIndexName: string
  /** Definition in the editor, so that unsaved links are visible before saving. */
  draftIndex: Record<string, unknown> | null
  draftDirty: boolean
  onOpenIndex: (indexName: string) => void
  onSearchIndex: (indexName: string) => void
  onOpenTopicProfile: (ownerIndexName: string) => void
  onOpenKnowledgeSource?: (name: string) => void
  onOpenKnowledgeBase?: (name: string) => void
}

const CANVAS_PADDING_X = 120
const CANVAS_PADDING_Y = 8
const EDGE_LABEL_MAX_CHARS = 38

const KIND_LABEL_KEYS: Record<DependencyNodeKind, TranslationKey> = {
  knowledgeBase: 'indexDepKindKnowledgeBase',
  knowledgeSource: 'indexDepKindKnowledgeSource',
  index: 'indexDepKindIndex',
  topicProfile: 'indexDepKindTopicProfile',
}

const KIND_ICONS: Record<DependencyNodeKind, string> = {
  knowledgeBase: 'bi-journal-text',
  knowledgeSource: 'bi-collection',
  index: 'bi-database',
  topicProfile: 'bi-diagram-2',
}

const ROLE_LABEL_KEYS: Record<IndexRole, TranslationKey> = {
  searchTarget: 'indexDepRoleSearchTarget',
  topic: 'indexDepRoleTopic',
  entityGraph: 'indexDepRoleEntityGraph',
  graph: 'indexDepRoleGraph',
  provenance: 'indexDepRoleProvenance',
}

const EDGE_TITLE_KEYS: Record<DependencyEdgeKind, TranslationKey> = {
  kbSource: 'indexDepEdgeKbSource',
  sourceIndex: 'indexDepEdgeSourceIndex',
  fieldProfile: 'indexDepEdgeFieldProfile',
  profileIndex: 'indexDepEdgeProfileIndex',
  provenance: 'indexDepEdgeProvenance',
  unlinkedProfile: 'indexDepEdgeUnlinkedProfile',
}

const RESOURCE_LABEL_KEYS: Record<DependencyResource, TranslationKey> = {
  indexes: 'indexDepResourceIndexes',
  knowledgeSources: 'indexDepResourceKnowledgeSources',
  knowledgeBases: 'indexDepResourceKnowledgeBases',
}

function fillMessage(template: string, params: Record<string, string | number>): string {
  let text = template
  for (const [key, value] of Object.entries(params)) text = text.replaceAll(`{${key}}`, String(value))
  return text
}

function shorten(label: string): string {
  return label.length > EDGE_LABEL_MAX_CHARS ? `${label.slice(0, EDGE_LABEL_MAX_CHARS - 1)}…` : label
}

export function IndexDependencyMap({
  profile,
  apiVersion,
  language,
  focusIndexName,
  draftIndex,
  draftDirty,
  onOpenIndex,
  onSearchIndex,
  onOpenTopicProfile,
  onOpenKnowledgeSource,
  onOpenKnowledgeBase,
}: IndexDependencyMapProps) {
  const t = (key: TranslationKey): string => String(translations[language][key] ?? '')
  const [result, setResult] = useState<DependencySnapshotResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadCount, setReloadCount] = useState(0)
  const [documentCounts, setDocumentCounts] = useState<Record<string, number>>({})

  const connected = !!profile && apiVersion.trim().length > 0

  useEffect(() => {
    if (!profile || !apiVersion.trim()) return
    let cancelled = false
    const controller = new AbortController()
    void (async () => {
      setLoading(true)
      setLoadError(null)
      try {
        const next = await loadDependencySnapshot({ profile, apiVersion, language, signal: controller.signal })
        if (!cancelled) setResult(next)
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [profile, apiVersion, language, reloadCount])

  const serviceIndexNames = useMemo(
    () => new Set((result?.snapshot.indexes ?? []).map((index) => (typeof index.name === 'string' ? index.name : ''))),
    [result],
  )

  const focusName = (focusIndexName || (typeof draftIndex?.name === 'string' ? draftIndex.name : '')).trim()
  const layout = useMemo(() => {
    if (!result || !focusName) return null
    return layoutDependencyGraph(buildDependencyGraph(withDraftIndex(result.snapshot, draftIndex), focusName))
  }, [result, draftIndex, focusName])

  const statisticsTargets = useMemo(
    () => (layout?.nodes ?? []).filter((node) => node.kind === 'index' && serviceIndexNames.has(node.name)).map((node) => node.name),
    [layout, serviceIndexNames],
  )
  const statisticsKey = statisticsTargets.join('\n')

  useEffect(() => {
    if (!profile || !apiVersion.trim() || statisticsTargets.length === 0) return
    let cancelled = false
    void (async () => {
      const entries = await Promise.all(statisticsTargets.map(async (indexName): Promise<[string, number | null]> => {
        try {
          const response = await getIndexStatistics({ profile, apiVersion, indexName, language })
          const count = response.ok && response.response && typeof response.response === 'object' && !Array.isArray(response.response)
            ? response.response.documentCount
            : undefined
          return [indexName, typeof count === 'number' ? count : null]
        } catch {
          return [indexName, null]
        }
      }))
      if (cancelled) return
      setDocumentCounts((previous) => {
        const next = { ...previous }
        for (const [name, count] of entries) {
          if (count === null) delete next[name]
          else next[name] = count
        }
        return next
      })
    })()
    return () => {
      cancelled = true
    }
    // statisticsKey identifies the set of indexes; the array itself changes identity on every graph rebuild.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, apiVersion, language, statisticsKey, result])

  const actionFor = (node: PositionedNode): { label: string; run: () => void } | null => {
    if (node.missing) return null
    if (node.kind === 'index') {
      if (node.name === focusName) return null
      return { label: fillMessage(t('indexDepOpenIndex'), { name: node.name }), run: () => onOpenIndex(node.name) }
    }
    if (node.kind === 'topicProfile') {
      return { label: fillMessage(t('indexDepOpenProfile'), { name: node.name }), run: () => onOpenTopicProfile(node.ownerIndex) }
    }
    if (node.kind === 'knowledgeSource' && onOpenKnowledgeSource) {
      return { label: fillMessage(t('indexDepOpenSource'), { name: node.name }), run: () => onOpenKnowledgeSource(node.name) }
    }
    if (node.kind === 'knowledgeBase' && onOpenKnowledgeBase) {
      return { label: fillMessage(t('indexDepOpenBase'), { name: node.name }), run: () => onOpenKnowledgeBase(node.name) }
    }
    return null
  }

  const hasRelations = (layout?.nodes.length ?? 0) > 1

  return (
    <section className="indexSchemaWorkbench indexDep">
      <div className="indexDep__header">
        <div>
          <div className="indexSchemaWorkbench__title">
            <i className="bi bi-bezier2 icon--mr6"></i>
            {t('indexDepTitle')}
          </div>
          <div className="indexSchemaWorkbench__hint">{t('indexDepHint')}</div>
        </div>
        <button type="button" className="btn btn--sm" disabled={!connected || loading} onClick={() => setReloadCount((count) => count + 1)}>
          <i className="bi bi-arrow-clockwise icon--mr6"></i>
          {t('indexDepRefresh')}
        </button>
      </div>

      {!connected ? <div className="notice notice--error">{t('indexBuilderMissingProfileOrApiVersion')}</div> : null}
      {connected && loadError && <div className="notice notice--error" role="alert">{t('failedToLoad')}: {loadError}</div>}
      {result?.errors.map((error) => (
        <div key={`${error.resource}-${error.message}`} className="notice notice--warning" role="status">
          {fillMessage(t('indexDepLoadError'), { resource: t(RESOURCE_LABEL_KEYS[error.resource]), message: error.message })}
        </div>
      ))}
      {result && result.skippedDetails > 0 ? (
        <div className="notice notice--warning" role="status">
          {fillMessage(t('indexDepSkippedDetails'), { max: MAX_DETAIL_REQUESTS, count: result.skippedDetails })}
        </div>
      ) : null}
      {loading && !result ? <div className="empty">{t('indexDepLoading')}</div> : null}
      {connected && !focusName ? <div className="empty">{t('indexDepNoSelection')}</div> : null}

      {layout && focusName ? (
        <>
          {!hasRelations ? <div className="notice notice--info" role="status">{t('indexDepNoRelations')}</div> : null}
          <div className="indexDep__scroll">
            <div
              className="indexDep__canvas"
              style={{ width: layout.width + CANVAS_PADDING_X * 2, height: layout.height + CANVAS_PADDING_Y * 2 }}
              data-testid="index-dependency-canvas"
            >
              <svg className="indexDep__edges" width={layout.width + CANVAS_PADDING_X * 2} height={layout.height + CANVAS_PADDING_Y * 2} role="img" aria-label={t('indexDepTitle')}>
                <defs>
                  <marker id="indexDepArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path className="indexDep__arrow" d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                </defs>
                <g transform={`translate(${CANVAS_PADDING_X} ${CANVAS_PADDING_Y})`}>
                  {layout.edges.map((edge) => {
                    const label = shorten(edge.label)
                    const labelWidth = label.length * 6.4 + 14
                    return (
                      <g key={edge.id} className={`indexDep__edge indexDep__edge--${edge.kind}`} data-edge-id={edge.id}>
                        <title>{`${edge.label}: ${t(EDGE_TITLE_KEYS[edge.kind])}`}</title>
                        <path d={edge.path} markerEnd="url(#indexDepArrow)" />
                        <rect className="indexDep__edgeLabelBg" x={edge.labelX - labelWidth / 2} y={edge.labelY - 9} width={labelWidth} height={18} rx={9} />
                        <text className="indexDep__edgeLabel" x={edge.labelX} y={edge.labelY + 3.5}>{label}</text>
                      </g>
                    )
                  })}
                </g>
              </svg>
              {layout.nodes.map((node) => {
                const action = actionFor(node)
                const isFocus = node.kind === 'index' && node.name === focusName
                const existsInService = serviceIndexNames.has(node.name)
                const count = node.kind === 'index' ? documentCounts[node.name] : undefined
                return (
                  <div
                    key={node.id}
                    className={`indexDepNode indexDepNode--${node.kind}${isFocus ? ' indexDepNode--focus' : ''}${node.missing ? ' indexDepNode--missing' : ''}`}
                    style={{ left: node.x + CANVAS_PADDING_X, top: node.y + CANVAS_PADDING_Y, width: DEPENDENCY_NODE_WIDTH, height: DEPENDENCY_NODE_HEIGHT }}
                    data-node-id={node.id}
                  >
                    <div className="indexDepNode__kind">
                      <i className={`bi ${KIND_ICONS[node.kind]} icon--mr6`}></i>
                      {t(KIND_LABEL_KEYS[node.kind])}
                      {isFocus ? <span className="indexDepNode__focusBadge">{t('indexDepFocus')}</span> : null}
                    </div>
                    {action ? (
                      <button type="button" className="indexDepNode__name" title={action.label} aria-label={action.label} onClick={action.run}>
                        {node.name}
                      </button>
                    ) : (
                      <span className="indexDepNode__name" title={node.name}>{node.name}</span>
                    )}
                    <div className="indexDepNode__meta">
                      {node.missing ? <span className="indexDepChip indexDepChip--missing">{t('indexDepMissing')}</span> : null}
                      {isFocus && !existsInService ? <span className="indexDepChip indexDepChip--draft">{t('indexDepNewUnsaved')}</span> : null}
                      {isFocus && existsInService && draftDirty ? <span className="indexDepChip indexDepChip--draft">{t('indexDepUnsaved')}</span> : null}
                      {node.roles.map((role) => <span key={role} className="indexDepChip">{t(ROLE_LABEL_KEYS[role])}</span>)}
                      {node.kind === 'knowledgeSource' && node.detail ? <span className="indexDepChip">{node.detail}</span> : null}
                      {node.kind === 'topicProfile' && node.detail ? <span className="indexDepChip">defaultKind: {node.detail}</span> : null}
                      {count !== undefined ? <span className="indexDepChip">{fillMessage(t('indexDepDocCount'), { count: count.toLocaleString(language === 'ja' ? 'ja-JP' : 'en-US') })}</span> : null}
                    </div>
                    {node.kind === 'index' && !node.missing && existsInService ? (
                      <button
                        type="button"
                        className="indexDepNode__search"
                        title={fillMessage(t('indexDepSearchIndex'), { name: node.name })}
                        aria-label={fillMessage(t('indexDepSearchIndex'), { name: node.name })}
                        onClick={() => onSearchIndex(node.name)}
                      >
                        <i className="bi bi-search"></i>
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </div>
        </>
      ) : null}
    </section>
  )
}
