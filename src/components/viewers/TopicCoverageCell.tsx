import {
  describeTopicPath, topicBranchColor, type LeafAssignment, type TopicCoverage, type TopicHierarchy, type TopicHit, type TopicTreemapCell,
} from '../../lib/topicGraphCoverage'

export const TOPIC_TREEMAP_WIDTH = 200
export const TOPIC_TREEMAP_HEIGHT = 120
const MAX_LISTED_TOPICS = 3

export type TopicCoverageText = {
  topicHit: string
  topicEffective: string
  topicCoverage: string
  versusBaseline: string
  topicUnassigned: string
  topicMapLabel: string
  topicRanksLabel: string
  topicCellHits: string
  topicCellShare: string
  topicRankTitle: string
  topicRankNone: string
  unranked: string
  incomplete: string
}

export type TopicColumnData = {
  coverage: TopicCoverage
  /** Leaf topic of each result in the compared window, by rank. */
  ranks: readonly (LeafAssignment | undefined)[]
}

const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template)

const percent = (value: number) => `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`

function branchColorOf(hierarchy: TopicHierarchy, topicId: string): string {
  return topicBranchColor(hierarchy.roots.indexOf(hierarchy.topics.get(topicId)?.branchId ?? ''))
}

function TopicTreemap({ hierarchy, cells, hits, text, count }: {
  hierarchy: TopicHierarchy
  cells: readonly TopicTreemapCell[]
  hits: ReadonlyMap<string, TopicHit>
  text: TopicCoverageText
  count: number
}) {
  const maxCount = Math.max(1, ...[...hits.values()].map((hit) => hit.count))
  return (
    <svg
      className="topicTreemap"
      viewBox={`0 0 ${TOPIC_TREEMAP_WIDTH} ${TOPIC_TREEMAP_HEIGHT}`}
      role="img"
      aria-label={fill(text.topicMapLabel, { count })}
    >
      {cells.map((cell) => {
        const hit = hits.get(cell.id)
        const share = percent(hierarchy.topics.get(cell.id)?.proportion ?? 0)
        const title = [
          `${describeTopicPath(hierarchy, cell.id)} (${cell.id})`,
          fill(text.topicCellShare, { share }),
          hit ? fill(text.topicCellHits, { count: hit.count, ranks: hit.ranks.map((rank) => `#${rank}`).join(', ') }) : '',
        ].filter(Boolean).join('\n')
        return (
          <g key={cell.id}>
            <rect
              className={hit ? 'topicTreemap__cell topicTreemap__cell--hit' : 'topicTreemap__cell'}
              x={cell.x}
              y={cell.y}
              width={cell.width}
              height={cell.height}
              fill={branchColorOf(hierarchy, cell.id)}
              fillOpacity={hit ? 0.4 + 0.6 * (hit.count / maxCount) : 0.14}
            >
              <title>{title}</title>
            </rect>
            {hit && cell.width >= 14 && cell.height >= 12 && (
              <text className="topicTreemap__count" x={cell.x + cell.width / 2} y={cell.y + cell.height / 2}>{hit.count}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

export function TopicCoverageCell({ data, baseline, isBaseline, groundData, hierarchy, cells, text }: {
  data?: TopicColumnData
  baseline?: TopicColumnData
  isBaseline: boolean
  groundData?: 'ranked' | 'unranked' | 'incomplete'
  hierarchy: TopicHierarchy
  cells: readonly TopicTreemapCell[]
  text: TopicCoverageText
}) {
  if (!data) {
    const reason = groundData === 'incomplete' ? text.incomplete : groundData === 'unranked' ? text.unranked : undefined
    return <span aria-label={reason} title={reason}>–</span>
  }
  const { coverage, ranks } = data
  const delta = !isBaseline && baseline && baseline.coverage.assigned > 0 && coverage.assigned > 0
    ? coverage.effectiveTopics - baseline.coverage.effectiveTopics : undefined
  const hits = new Map(coverage.hits.map((hit) => [hit.leafId, hit]))
  return <>
    <TopicTreemap hierarchy={hierarchy} cells={cells} hits={hits} text={text} count={ranks.length} />
    <dl className="agenticComparison__values">
      <div><dt>{text.topicHit}</dt><dd>{coverage.hits.length} / {coverage.leafCount}</dd></div>
      <div>
        <dt>{text.topicEffective}</dt>
        <dd>
          {coverage.effectiveTopics.toFixed(2)}
          {delta !== undefined && (
            <span className="agenticComparison__delta">{text.versusBaseline} {delta < 0 ? '-' : '+'}{Math.abs(delta).toFixed(2)}</span>
          )}
        </dd>
      </div>
      <div><dt>{text.topicCoverage}</dt><dd>{percent(coverage.corpusCoverage)}</dd></div>
    </dl>
    <ol className="topicStrip" aria-label={text.topicRanksLabel}>
      {ranks.map((assignment, index) => (
        <li
          key={index}
          className={assignment ? 'topicStrip__item' : 'topicStrip__item topicStrip__item--none'}
          style={assignment ? { background: branchColorOf(hierarchy, assignment.leafId) } : undefined}
          title={assignment
            ? fill(text.topicRankTitle, { rank: index + 1, topic: describeTopicPath(hierarchy, assignment.leafId), score: assignment.score.toFixed(2) })
            : fill(text.topicRankNone, { rank: index + 1 })}
        />
      ))}
    </ol>
    <ul className="topicHitList">
      {coverage.hits.slice(0, MAX_LISTED_TOPICS).map((hit) => (
        <li key={hit.leafId}>
          <span className="topicHitList__dot" style={{ background: branchColorOf(hierarchy, hit.leafId) }} aria-hidden="true" />
          <span className="topicHitList__name" title={describeTopicPath(hierarchy, hit.leafId)}>{hierarchy.topics.get(hit.leafId)?.label ?? hit.leafId}</span>
          <span className="topicHitList__count">×{hit.count}</span>
        </li>
      ))}
    </ul>
    {coverage.unassigned > 0 && <div className="text-muted-xs">{fill(text.topicUnassigned, { count: coverage.unassigned })}</div>}
  </>
}

export function TopicBranchLegend({ hierarchy }: { hierarchy: TopicHierarchy }) {
  return (
    <ul className="topicLegend">
      {hierarchy.roots.map((id, index) => {
        const node = hierarchy.topics.get(id)!
        return (
          <li key={id} title={`${node.label ?? id} (${id})`}>
            <span className="topicLegend__swatch" style={{ background: topicBranchColor(index) }} aria-hidden="true" />
            <span className="topicLegend__name">{node.label ?? id}</span>
            <span className="topicLegend__share">{percent(node.proportion)}</span>
          </li>
        )
      })}
    </ul>
  )
}
