import type { TopicHierarchy } from '../../lib/topicGraphCoverage'
import { topicWheelLabel } from '../../lib/topicCharts'

/**
 * The topic hierarchy as nested buttons, for people who cannot use the chart with a pointer: the canvas of the chart
 * has no keyboard interaction. It stays out of sight until one of its buttons has focus, so it does not change how
 * the view looks or works with a mouse.
 */
export function TopicOutline({ hierarchy, activeId, label, onActivate }: {
  hierarchy: TopicHierarchy
  /** Topic that is zoomed into or selected. */
  activeId?: string
  label: string
  onActivate: (topicId: string) => void
}) {
  const list = (ids: readonly string[]) => <ul>
    {ids.map((id) => {
      const node = hierarchy.topics.get(id)!
      return <li key={id}>
        <button type="button" className="btn btn--ghost btn--sm" aria-current={activeId === id ? 'true' : undefined} onClick={() => onActivate(id)}>
          {topicWheelLabel(node)}
        </button>
        {node.children.length > 0 && list(node.children)}
      </li>
    })}
  </ul>
  return <nav className="topicWheel__outline" aria-label={label}>{list(hierarchy.roots)}</nav>
}
