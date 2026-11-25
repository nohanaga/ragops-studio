import { useEffect, useMemo, useRef, useState } from 'react'
import type ForceGraph from 'force-graph'
import type { LinkObject, NodeObject } from 'force-graph'
import type { WorkbenchGraph, WorkbenchNode, WorkbenchEdge } from '../../lib/knowledgeGraph'
import { graphCategoryPalette } from '../../lib/graphPalette'
import { translations, type Language } from '../../lib/translations'
import type { ThemePreference } from '../../types'

type CanvasNode = NodeObject & WorkbenchNode & { color: string; radius: number }
type CanvasLink = LinkObject<CanvasNode> & Omit<WorkbenchEdge, 'source' | 'target'> & {
  source: string | CanvasNode
  target: string | CanvasNode
  color: string
  curvature: number
}

function category(node: WorkbenchNode): string {
  return node.type === 'owl:Class' ? node.label : node.type
}

function shortLabel(label: string): string {
  const text = /^https?:\/\//.test(label) ? label.split(/[/#]/).filter(Boolean).at(-1) ?? label : label
  return text.length > 26 ? `${text.slice(0, 23)}…` : text
}

function endpointId(endpoint: string | CanvasNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id
}

function tooltip(text: string): HTMLElement {
  const element = document.createElement('span')
  element.textContent = text
  return element
}

export function KnowledgeGraphCanvas({ graph, selectedId, onSelect, onClearSelection, language, theme }: {
  graph: WorkbenchGraph
  selectedId: string | null
  onSelect: (kind: 'node' | 'edge', id: string) => void
  onClearSelection?: () => void
  language: Language
  theme: ThemePreference
}) {
  const t = (key: keyof typeof translations.ja) => translations[language][key]
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const instanceRef = useRef<ForceGraph<CanvasNode, CanvasLink> | null>(null)
  const callbacksRef = useRef({ onSelect, onClearSelection })
  const positionsRef = useRef(new Map<string, Pick<CanvasNode, 'x' | 'y' | 'fx' | 'fy'>>())
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showLabels, setShowLabels] = useState(false)
  const [particles, setParticles] = useState(true)
  const [fullscreen, setFullscreen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [layout, setLayout] = useState<'force' | 'radial'>('force')
  const layoutRef = useRef(layout)
  const focus = useMemo(() => {
    const requestedSeed = hoveredId ?? selectedId
    const seed = graph.nodes.some((node) => node.id === requestedSeed) || graph.edges.some((edge) => edge.id === requestedSeed) ? requestedSeed : null
    const nodes = new Set<string>()
    const edges = new Set<string>()
    const selectedEdge = graph.edges.find((edge) => edge.id === seed)
    if (selectedEdge) {
      nodes.add(selectedEdge.source); nodes.add(selectedEdge.target); edges.add(selectedEdge.id)
    } else if (seed) {
      nodes.add(seed)
      graph.edges.filter((edge) => edge.source === seed || edge.target === seed).forEach((edge) => {
        nodes.add(edge.source); nodes.add(edge.target); edges.add(edge.id)
      })
    }
    const query = search.trim().toLocaleLowerCase()
    const matches = new Set(graph.nodes.filter((node) => `${node.label} ${node.type}`.toLocaleLowerCase().includes(query)).map((node) => node.id))
    return { nodes, edges, matches, active: Boolean(seed || query), query }
  }, [graph, hoveredId, selectedId, search])
  const visualRef = useRef({ focus, selectedId, showLabels, particles })
  const categories = useMemo(() => {
    const counts = new Map<string, number>()
    graph.nodes.forEach((node) => counts.set(category(node), (counts.get(category(node)) ?? 0) + 1))
    return [...counts]
  }, [graph])
  const categoryColors = useMemo(() => graphCategoryPalette(categories.map(([name]) => name)), [categories])
  const selectedNode = graph.nodes.find((node) => node.id === selectedId)
  const selectedEdge = graph.edges.find((edge) => edge.id === selectedId)

  useEffect(() => { callbacksRef.current = { onSelect, onClearSelection } }, [onSelect, onClearSelection])
  useEffect(() => {
    visualRef.current = { focus, selectedId, showLabels, particles }
    const instance = instanceRef.current
    if (!instance) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    instance.linkWidth((link) => focus.edges.has(link.id) ? 2.4 : 1.2)
    instance.linkDirectionalParticles((link) => particles && !reducedMotion && (!focus.active || focus.edges.has(link.id)) ? 1 : 0)
  }, [focus, selectedId, showLabels, particles])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !graph.nodes.length) return
    let canceled = false
    let instance: ForceGraph<CanvasNode, CanvasLink> | null = null
    let fitTimer: ReturnType<typeof setTimeout> | undefined
    let resizeObserver: ResizeObserver | undefined
    let themeObserver: MutationObserver | undefined
    let fitted = false
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const colorScheme = window.matchMedia('(prefers-color-scheme: dark)')
    let colors = { foreground: '', muted: '', panel: '', border: '', accent: '', light: false }
    const linkColor = (link: CanvasLink) => {
      const state = visualRef.current.focus
      if (state.edges.has(link.id)) return link.color
      if (state.active && !(state.query && state.matches.has(endpointId(link.source)) && state.matches.has(endpointId(link.target)))) return `${link.color}45`
      return `${link.color}${colors.light ? '85' : '65'}`
    }
    const particleCount = (link: CanvasLink) => visualRef.current.particles && !motion.matches
      && (!visualRef.current.focus.active || visualRef.current.focus.edges.has(link.id)) ? 1 : 0
    const readColors = () => {
      const style = getComputedStyle(stage)
      colors = {
        foreground: style.getPropertyValue('--fg').trim(), muted: style.getPropertyValue('--muted').trim(),
        panel: style.getPropertyValue('--panel').trim(), border: style.getPropertyValue('--border').trim(),
        accent: style.getPropertyValue('--accent').trim(), light: style.colorScheme === 'light',
      }
      instance?.linkColor((link) => linkColor(link))
      instance?.linkDirectionalArrowColor((link) => linkColor(link))
      instance?.linkDirectionalParticles((link) => particleCount(link))
    }
    const activeNode = (node: CanvasNode) => {
      const state = visualRef.current.focus
      return !state.active || state.nodes.has(node.id) || Boolean(state.query && state.matches.has(node.id))
    }
    const nodes: CanvasNode[] = graph.nodes.map((node) => {
      const degree = graph.edges.filter((edge) => edge.source === node.id || edge.target === node.id).length
      return { ...node, ...positionsRef.current.get(node.id), color: categoryColors[category(node)], radius: 7 + Math.min(6, Math.sqrt(degree) * 2) }
    })
    const pairs = new Map<string, WorkbenchEdge[]>()
    graph.edges.forEach((edge) => {
      const pair = JSON.stringify([edge.source, edge.target].sort())
      pairs.set(pair, [...(pairs.get(pair) ?? []), edge])
    })
    const links: CanvasLink[] = graph.edges.map((edge) => {
      const siblings = pairs.get(JSON.stringify([edge.source, edge.target].sort())) ?? []
      return {
        ...edge, color: categoryColors[category(graph.nodes.find((node) => node.id === edge.source)!)],
        curvature: edge.source === edge.target ? 0.7 : siblings.length > 1 ? 0.18 * (siblings.indexOf(edge) + 1) : 0,
      }
    })
    import('force-graph').then(({ default: Graph }) => {
      if (canceled) return
      readColors()
      instance = new Graph<CanvasNode, CanvasLink>(stage)
      instanceRef.current = instance
      instance
        .width(Math.max(1, stage.clientWidth)).height(Math.max(1, stage.clientHeight)).backgroundColor('transparent')
        .minZoom(0.05).maxZoom(6)
        .nodeId('id').nodeVal((node) => (node.radius / 4) ** 2)
        .nodeLabel((node) => tooltip(`${node.label} · ${node.type}`))
        .nodeCanvasObject((node, context, scale) => {
          if (node.x === undefined || node.y === undefined) return
          const active = activeNode(node)
          const selected = visualRef.current.selectedId === node.id
          const radius = node.radius / Math.max(0.05, scale)
          context.save()
          context.globalAlpha = active ? 1 : 0.35
          const glow = context.createRadialGradient(node.x, node.y, radius * 0.3, node.x, node.y, radius * 2.8)
          glow.addColorStop(0, `${node.color}${selected ? '60' : '28'}`)
          glow.addColorStop(1, `${node.color}00`)
          context.fillStyle = glow
          context.beginPath(); context.arc(node.x, node.y, radius * 2.8, 0, Math.PI * 2); context.fill()
          context.fillStyle = colors.panel
          context.strokeStyle = node.color
          context.lineWidth = (selected ? 2.8 : 1.8) / Math.max(0.05, scale)
          context.beginPath(); context.arc(node.x, node.y, radius, 0, Math.PI * 2); context.fill(); context.stroke()
          context.fillStyle = node.color
          context.beginPath(); context.arc(node.x, node.y, radius * 0.38, 0, Math.PI * 2); context.fill()
          if (selected) {
            context.strokeStyle = `${node.color}80`
            context.lineWidth = 1 / scale
            context.beginPath(); context.arc(node.x, node.y, radius + 5, 0, Math.PI * 2); context.stroke()
          }
          if (graph.nodes.length <= 40 || scale > 0.45 || selected || visualRef.current.focus.nodes.has(node.id)) {
            const size = 11 / Math.max(0.05, scale)
            context.font = `${selected ? 650 : 500} ${size}px system-ui`
            const label = shortLabel(node.label)
            const width = context.measureText(label).width
            context.fillStyle = colors.panel
            context.globalAlpha = active ? 0.92 : 0.35
            context.fillRect(node.x - width / 2 - 5, node.y + radius + 4, width + 10, size + 7)
            context.globalAlpha = active ? 1 : 0.65
            context.fillStyle = colors.foreground
            context.textAlign = 'center'; context.textBaseline = 'top'
            context.fillText(label, node.x, node.y + radius + 7)
          }
          context.restore()
        })
        .nodePointerAreaPaint((node, color, context, scale) => {
          if (node.x === undefined || node.y === undefined) return
          context.fillStyle = color
          context.beginPath(); context.arc(node.x, node.y, (node.radius + 5) / Math.max(0.05, scale), 0, Math.PI * 2); context.fill()
        })
        .linkLabel((link) => tooltip(link.label))
        .linkColor(linkColor)
        .linkWidth((link) => visualRef.current.focus.edges.has(link.id) ? 2.4 : 1.2)
        .linkCurvature((link) => link.curvature)
        .linkDirectionalArrowLength(5).linkDirectionalArrowRelPos(0.8).linkDirectionalArrowColor(linkColor)
        .linkDirectionalParticles(particleCount)
        .linkDirectionalParticleWidth(2).linkDirectionalParticleSpeed(0.003)
        .linkDirectionalParticleColor((link) => link.color)
        .linkCanvasObjectMode(() => 'after')
        .linkCanvasObject((link, context, scale) => {
          if (!visualRef.current.showLabels || (scale < 0.6 && !visualRef.current.focus.edges.has(link.id))) return
          const source = typeof link.source === 'object' ? link.source : undefined
          const target = typeof link.target === 'object' ? link.target : undefined
          if (source?.x === undefined || source.y === undefined || target?.x === undefined || target.y === undefined) return
          if (visualRef.current.focus.active && !visualRef.current.focus.edges.has(link.id)) return
          const x = (source.x + target.x) / 2; const y = (source.y + target.y) / 2
          const size = 10 / Math.max(0.05, scale)
          context.font = `500 ${size}px system-ui`
          const label = shortLabel(link.label); const width = context.measureText(label).width
          context.fillStyle = colors.panel; context.fillRect(x - width / 2 - 5, y - size / 2 - 3, width + 10, size + 6)
          context.fillStyle = colors.muted; context.textAlign = 'center'; context.textBaseline = 'middle'
          context.fillText(label, x, y)
        })
        .onNodeHover((node) => setHoveredId(node?.id ?? null))
        .onNodeClick((node) => callbacksRef.current.onSelect('node', node.id))
        .onLinkClick((link) => callbacksRef.current.onSelect('edge', link.id))
        .onBackgroundClick(() => callbacksRef.current.onClearSelection?.())
        .onNodeDragEnd((node) => { node.fx = node.x; node.fy = node.y })
        .warmupTicks(40).cooldownTime(2500).graphData({ nodes, links })
      const linkForce = instance.d3Force('link')
      const charge = instance.d3Force('charge')
      if (linkForce && typeof linkForce.distance === 'function') linkForce.distance(145)
      if (charge && typeof charge.strength === 'function') charge.strength(-260)
      if (layoutRef.current === 'radial') nodes.forEach((node, index) => {
        node.fx = Math.cos(index / nodes.length * Math.PI * 2) * 160
        node.fy = Math.sin(index / nodes.length * Math.PI * 2) * 160
      })
      const fit = () => {
        if (!stage.clientWidth || !stage.clientHeight) return
        instance?.zoomToFit(motion.matches ? 0 : 400, 70)
        fitted = true
      }
      resizeObserver = new ResizeObserver(() => {
        if (stage.clientWidth && stage.clientHeight) {
          instance?.width(stage.clientWidth).height(stage.clientHeight)
          if (!fitted) { clearTimeout(fitTimer); fitTimer = setTimeout(fit, 150) }
        }
      })
      resizeObserver.observe(stage)
      themeObserver = new MutationObserver(readColors)
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
      motion.addEventListener('change', readColors)
      colorScheme.addEventListener('change', readColors)
      fitTimer = setTimeout(fit, 150)
      setError(null)
    }).catch((e: unknown) => {
      if (!canceled) setError(e instanceof Error ? e.message : String(e))
    })
    return () => {
      canceled = true
      clearTimeout(fitTimer)
      resizeObserver?.disconnect(); themeObserver?.disconnect(); motion.removeEventListener('change', readColors)
      colorScheme.removeEventListener('change', readColors)
      if (instance) {
        positionsRef.current = new Map(instance.graphData().nodes.map((node) => [node.id, { x: node.x, y: node.y, fx: node.fx, fy: node.fy }]))
        instance._destructor()
      }
      instanceRef.current = null
    }
  }, [graph, theme, categoryColors])

  useEffect(() => {
    layoutRef.current = layout
    const instance = instanceRef.current
    if (!instance) return
    const nodes = instance.graphData().nodes
    nodes.forEach((node, index) => {
      node.fx = layout === 'radial' ? Math.cos(index / nodes.length * Math.PI * 2) * 160 : undefined
      node.fy = layout === 'radial' ? Math.sin(index / nodes.length * Math.PI * 2) * 160 : undefined
    })
    instance.d3ReheatSimulation()
  }, [layout])

  useEffect(() => {
    if (!fullscreen) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setFullscreen(false) }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [fullscreen])

  return (
    <div className={`kgGraph${fullscreen ? ' kgGraph--fullscreen' : ''}`} ref={containerRef}>
      <div className="kgGraph__toolbar">
        <div className="actions actions--tight">
          <button type="button" className="btn btn--sm" onClick={() => instanceRef.current?.zoomToFit(400, 70)} title={t('ivGraphZoomFit')}><i className="bi bi-arrows-fullscreen" /> {t('ivGraphZoomFit')}</button>
          <button type="button" className="btn btn--sm" onClick={() => {
            instanceRef.current?.graphData().nodes.forEach((node) => { node.fx = undefined; node.fy = undefined })
            setLayout('force'); instanceRef.current?.d3ReheatSimulation()
          }} title={t('ivGraphReheat')}><i className="bi bi-arrow-clockwise" /> {t('ivGraphReheat')}</button>
          <button type="button" className="btn btn--sm" aria-label={fullscreen ? t('ivGraphExitFullscreen') : t('ivGraphFullscreen')} onClick={() => setFullscreen((value) => !value)}><i className={`bi bi-fullscreen${fullscreen ? '-exit' : ''}`} /></button>
        </div>
        <label className="kgGraph__search"><i className="bi bi-search" /><input aria-label={t('ivGraphSearchPlaceholder')} placeholder={t('ivGraphSearchPlaceholder')} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      </div>
      <div className="kgGraph__viewport">
      <div className="kgGraph__stage" ref={stageRef} role="img" aria-label={`${t('kgVisualization')}: ${graph.nodes.length} ${t('kgNodes')}, ${graph.edges.length} ${t('kgEdges')}`} />
      {!graph.nodes.length && <div className="kgGraph__empty"><i className="bi bi-diagram-3" /><strong>{t('kgVisualization')}</strong><span>{t('kgGraphEmpty')}</span></div>}
      <div className="kgGraph__metrics"><span><i className="bi bi-circle" /><strong>{graph.nodes.length}</strong> {t('kgNodes')}</span><span><i className="bi bi-bezier2" /><strong>{graph.edges.length}</strong> {t('kgEdges')}</span></div>
      {(selectedNode || selectedEdge) && <div className="kgGraph__focus"><span className="kgEyebrow">{t('kgSelected')}</span><strong>{selectedNode?.label ?? selectedEdge?.label}</strong><span>{selectedNode?.type ?? `${shortLabel(graph.nodes.find((node) => node.id === selectedEdge?.source)?.label ?? '')} → ${shortLabel(graph.nodes.find((node) => node.id === selectedEdge?.target)?.label ?? '')}`}</span></div>}
      </div>
      <div className="kgGraph__footer">
        <div className="kgGraph__legend">{categories.slice(0, 8).map(([type, count]) => <span key={type} title={type}><i style={{ background: categoryColors[type] }} />{shortLabel(type)}<strong>{count}</strong></span>)}</div>
        <div className="kgGraph__options">
          <select aria-label={t('ivGraphLayoutTitle')} value={layout} onChange={(event) => setLayout(event.target.value === 'radial' ? 'radial' : 'force')}><option value="force">{t('ivGraphLayoutForce')}</option><option value="radial">{t('ivGraphLayoutRadial')}</option></select>
          <label><input type="checkbox" checked={showLabels} onChange={(event) => setShowLabels(event.target.checked)} />{t('ivGraphEdgeLabels')}</label>
          <label><input type="checkbox" checked={particles} onChange={(event) => setParticles(event.target.checked)} />{t('ivGraphParticles')}</label>
        </div>
      </div>
      {error && <div className="notice notice--error" role="alert">{error}</div>}
    </div>
  )
}
