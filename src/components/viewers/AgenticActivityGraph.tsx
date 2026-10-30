import { useMemo, useState, type ReactNode } from 'react'
import { Background, ControlButton, Controls, Handle, MarkerType, Position, ReactFlow, useReactFlow, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'

import {
  activityStatusKeys, buildActivityGraph,
  type ActivityGraphNode, type ActivityItem, type ActivityTranslator,
} from '../../lib/agenticActivityGraph'
import type { Language } from '../../lib/translations'
import type { LatestResponse } from '../../types'
import { AgenticActivityDetails } from './AgenticActivityDetails'

type FlowNode = Node<ActivityGraphNode & { statusLabel: string; countLabel: string }, 'activity'>

const icons: Record<ActivityGraphNode['kind'], string> = {
  request: 'bi-box-arrow-in-down', config: 'bi-sliders', activity: 'bi-activity',
  merge: 'bi-intersect', result: 'bi-chat-square-text', delivery: 'bi-send', excluded: 'bi-dash-circle',
}

function ActivityNode({ data, selected }: NodeProps<FlowNode>) {
  return (
    <div className={`actGraph__node actGraph__node--${data.kind}${selected ? ' actGraph__node--selected' : ''}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <div className="actGraph__nodeTitle"><i className={`bi ${icons[data.kind]}`} aria-hidden="true" /> {data.title}</div>
      <div className="actGraph__nodeSubtitle">
        {data.item ? (
          <>
            {data.item.knowledgeSourceName && (
              <div className="actGraph__subtitleRow" title={data.item.knowledgeSourceName}>
                <i className="bi bi-database" aria-hidden="true" />
                <span>{data.item.knowledgeSourceName}</span>
              </div>
            )}
            {data.item.search && (
              <div className="actGraph__subtitleRow" title={data.item.search}>
                <i className="bi bi-search" aria-hidden="true" />
                <span className="mono actGraph__query">{data.item.search}</span>
              </div>
            )}
          </>
        ) : data.subtitle}
      </div>
      <div className={`actGraph__state actGraph__state--${data.status}`}>
        <i className={`bi ${data.status === 'running' ? 'bi-arrow-repeat spin' : data.status === 'completed' ? 'bi-check-circle' : data.status === 'error' ? 'bi-exclamation-octagon' : 'bi-info-circle'}`} aria-hidden="true" /> {data.statusLabel}
        {data.item?.elapsedMs !== undefined && <span>{data.item.elapsedMs.toLocaleString()} ms</span>}
        {data.item?.count !== undefined && (
          <span title={data.countLabel} aria-label={`${data.countLabel}: ${data.item.count.toLocaleString()}`}>
            <i className="bi bi-collection" aria-hidden="true" /> {data.countLabel}: {data.item.count.toLocaleString()}
          </span>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} />
    </div>
  )
}

const nodeTypes = { activity: ActivityNode }

function GraphControls({ t }: { t: ActivityTranslator }) {
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  return (
    <Controls showZoom={false} showFitView={false} showInteractive={false} aria-label={t('actGraphViewMode')}>
      <ControlButton title={t('actGraphZoomIn')} aria-label={t('actGraphZoomIn')} onClick={() => { void zoomIn() }}><i className="bi bi-plus" aria-hidden="true" /></ControlButton>
      <ControlButton title={t('actGraphZoomOut')} aria-label={t('actGraphZoomOut')} onClick={() => { void zoomOut() }}><i className="bi bi-dash" aria-hidden="true" /></ControlButton>
      <ControlButton title={t('actGraphFit')} aria-label={t('actGraphFit')} onClick={() => { void fitView({ padding: 0.15, maxZoom: 0.85 }) }}><i className="bi bi-arrows-fullscreen" aria-hidden="true" /></ControlButton>
    </Controls>
  )
}

export function AgenticActivityGraph({ items, response, streaming, t, language, renderActivity }: {
  items: ActivityItem[]
  response?: LatestResponse
  streaming?: boolean
  t: ActivityTranslator
  language: Language
  renderActivity: (item: ActivityItem) => ReactNode
}) {
  const [selectedId, setSelectedId] = useState<string | null>('result')
  const [canvasError, setCanvasError] = useState<string | null>(null)
  const graph = useMemo(() => buildActivityGraph({ items, response, streaming, t }), [items, response, streaming, t])
  const { nodes, edges } = useMemo(() => {
    const layout = new dagre.graphlib.Graph()
    layout.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 60, marginx: 24, marginy: 24 })
    layout.setDefaultEdgeLabel(() => ({}))
    graph.nodes.forEach((node) => layout.setNode(node.id, { width: 260, height: 132 }))
    graph.edges.forEach((edge) => layout.setEdge(edge.source, edge.target))
    dagre.layout(layout)
    const nodes: FlowNode[] = graph.nodes.map((node) => {
      const position = layout.node(node.id)
      return {
        id: node.id, type: 'activity', data: { ...node, statusLabel: t(activityStatusKeys[node.status]), countLabel: t('actTimelineHits') },
        position: { x: position.x - 130, y: position.y - 66 },
        selected: node.id === selectedId,
        ariaLabel: `${node.title}: ${node.subtitle}, ${t(activityStatusKeys[node.status])}`,
      }
    })
    return {
      nodes,
      edges: graph.edges.map((edge) => ({
        ...edge, type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--muted)' },
        animated: graph.nodes.find((node) => node.id === edge.target)?.status === 'running',
        style: { stroke: 'var(--muted)', strokeDasharray: edge.uncertain ? '5 4' : undefined },
      })),
    }
  }, [graph, selectedId, t])

  return (
    <div className="actGraph">
      <div className="actGraph__legend">{t('actGraphEvidence')}</div>
      {canvasError && <div className="notice notice--error" role="alert">{canvasError}</div>}
      <div className={`actGraph__workspace${selectedId === null ? ' actGraph__workspace--collapsed' : ''}`}>
        <div className="actGraph__canvas" aria-label={t('actGraphView')}>
          <ReactFlow<FlowNode>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            onError={(code, message) => setCanvasError(`${code}: ${message}`)}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            deleteKeyCode={null}
            minZoom={0.1}
            maxZoom={1.8}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 0.85 }}
            ariaLabelConfig={{
              'node.a11yDescription.default': t('actGraphSelect'),
            }}
          >
            <Background color="var(--border)" />
            <GraphControls t={t} />
          </ReactFlow>
        </div>
        {selectedId !== null && (
          <AgenticActivityDetails nodes={graph.nodes} selectedId={selectedId} onSelect={setSelectedId} onClose={() => setSelectedId(null)} t={t} language={language} renderActivity={renderActivity} />
        )}
      </div>
    </div>
  )
}
