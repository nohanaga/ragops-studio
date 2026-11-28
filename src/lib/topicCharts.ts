/**
 * Data and option builders for the topic charts (an ECharts sunburst and an ECharts tree) and the small helpers that the
 * topic views share. Everything here is pure: the chart component only hands the result to ECharts.
 *
 * Tooltips are prebuilt as HTML strings (`tip`). Topic titles and chunk keys come from the index, so every dynamic
 * value is escaped with `escapeHtml` before it is put into a tip.
 */

import type { EChartsCoreOption } from 'echarts/core'
import { describeTopicPath, topicBranchColor, type TopicHierarchy, type TopicNode } from './topicGraphCoverage'

export type WheelChunks = ReadonlyMap<string, readonly string[]>

/** `topic:12` is shown as `12`. */
export const topicShortId = (id: string): string => id.replace(/^topic:/, '')

export function topicWheelLabel(node: TopicNode): string {
  const shortId = topicShortId(node.id)
  return node.label ? `${shortId}: ${node.label}` : shortId
}

/** Chunk labels are numbered in the order of the given keys: C1, C2, ... */
export function chunkLabels(keys: Iterable<string>): Map<string, string> {
  const labels = new Map<string, string>()
  for (const key of keys) labels.set(key, `C${labels.size + 1}`)
  return labels
}

/** Topic IDs from the top-level topic down to `topicId`. */
export function topicAncestry(hierarchy: TopicHierarchy, topicId: string): string[] {
  const path: string[] = []
  for (let node = hierarchy.topics.get(topicId); node; node = node.parentId ? hierarchy.topics.get(node.parentId) : undefined) path.unshift(node.id)
  return path
}

/** Number of chunks placed in the leaf topics under `topicId`. */
export function countChunks(hierarchy: TopicHierarchy, chunks: WheelChunks, topicId: string): number {
  const node = hierarchy.topics.get(topicId)
  if (!node) return 0
  return node.children.length === 0 ? chunks.get(topicId)?.length ?? 0 : node.children.reduce((sum, child) => sum + countChunks(hierarchy, chunks, child), 0)
}

/** Number of leaf topics under `topicId`, or in the whole hierarchy when no topic is given. */
export function countLeafTopics(hierarchy: TopicHierarchy, topicId?: string): number {
  if (!topicId) return hierarchy.leaves.length
  const node = hierarchy.topics.get(topicId)
  if (!node) return 0
  return node.children.length === 0 ? 1 : node.children.reduce((sum, child) => sum + countLeafTopics(hierarchy, child), 0)
}

/** Share of the corpus as a percentage; values below 10% keep one decimal. */
export const formatShare = (value: number): string => `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character])

/** Colors of the app theme. `fontFamily` is the font of the page, so that the text on the canvas matches it. */
export type TopicChartColors = { foreground: string; muted: string; panel: string; border: string; accent: string; fontFamily?: string }

/** Translated captions of the tooltips. */
export type TopicChartText = {
  collection: string
  share: string
  chunks: string
  assignedTopic: string
  leafTopics: string
}

type ChartInput = {
  hierarchy: TopicHierarchy
  chunks?: WheelChunks
  labels: ReadonlyMap<string, string>
  text: TopicChartText
}

const branchIndexOf = (hierarchy: TopicHierarchy, node: TopicNode) => Math.max(0, hierarchy.roots.indexOf(node.branchId))
/** Deeper topics are lighter, so the rings of one branch read as a gradient. */
const topicColor = (hierarchy: TopicHierarchy, node: TopicNode) => topicBranchColor(branchIndexOf(hierarchy, node), Math.min(68, 46 + node.depth * 6))
const chunkColor = (hierarchy: TopicHierarchy, leaf: TopicNode) => topicBranchColor(branchIndexOf(hierarchy, leaf), 78, 55)

const tipLine = (caption: string, value: string) => `<div><span style="opacity:.7">${escapeHtml(caption)}</span> ${escapeHtml(value)}</div>`
const tipTitle = (title: string) => `<div style="font-weight:600;margin-bottom:4px">${escapeHtml(title)}</div>`

function topicTip(input: ChartInput, node: TopicNode): string {
  const { hierarchy, chunks, text } = input
  return [
    tipTitle(topicWheelLabel(node)),
    `<div style="opacity:.75;margin-bottom:4px">${escapeHtml(describeTopicPath(hierarchy, node.id))}</div>`,
    tipLine(`${text.share}:`, formatShare(node.proportion)),
    tipLine(`${text.leafTopics}:`, String(countLeafTopics(hierarchy, node.id))),
    chunks ? tipLine(`${text.chunks}:`, String(countChunks(hierarchy, chunks, node.id))) : '',
  ].join('')
}

function chunkTip(input: ChartInput, leaf: TopicNode, key: string): string {
  const { hierarchy, labels, text } = input
  return [
    tipTitle(labels.get(key) ?? key),
    `<div style="font-family:monospace;font-size:11px;word-break:break-all">${escapeHtml(key)}</div>`,
    `<div style="margin-top:4px"><span style="opacity:.7">${escapeHtml(text.assignedTopic)}:</span> ${escapeHtml(describeTopicPath(hierarchy, leaf.id))}</div>`,
  ].join('')
}

export type TopicChartItem = {
  id: string
  kind: 'topic' | 'chunk'
  /** The topic itself, or the leaf topic that holds the chunk. */
  topicId: string
  name: string
  /** Prebuilt, escaped HTML for the tooltip. */
  tip: string
  /** True for a topic that has sub-topics (or chunks) to zoom into. */
  zoomable: boolean
  /** Only leaves carry a value; ECharts sums it up for the parents. */
  value?: number
  itemStyle: { color: string }
  /** Direction and width of the label, set for the wheel by `buildSunburstOption`. */
  label?: { rotate: 'radial' | 'tangential'; width: number }
  children?: TopicChartItem[]
}

/**
 * Items of the sunburst. A segment is as wide as its value: the corpus share of a leaf topic, or one per chunk when
 * chunks are given (topics that hold no chunk are left out). With `focusId` the items start below that topic.
 */
export function buildSunburstItems(input: ChartInput & { focusId?: string }): { items: TopicChartItem[]; total: number } {
  const { hierarchy, chunks, labels } = input
  const values = new Map<string, number>()
  const valueOf = (id: string): number => {
    const known = values.get(id)
    if (known !== undefined) return known
    const node = hierarchy.topics.get(id)!
    const value = node.children.length > 0
      ? node.children.reduce((sum, child) => sum + valueOf(child), 0)
      : chunks ? chunks.get(id)?.length ?? 0 : node.proportion
    values.set(id, value)
    return value
  }

  const chunkItems = (leaf: TopicNode): TopicChartItem[] => (chunks?.get(leaf.id) ?? []).map((key) => ({
    id: key, kind: 'chunk', topicId: leaf.id, name: labels.get(key) ?? key, tip: chunkTip(input, leaf, key), zoomable: false, value: 1,
    itemStyle: { color: chunkColor(hierarchy, leaf) },
  }))
  const topicItem = (id: string): TopicChartItem | undefined => {
    const value = valueOf(id)
    if (value <= 0) return undefined
    const node = hierarchy.topics.get(id)!
    const children = node.children.length > 0 ? topicItems(node.children) : chunkItems(node)
    return {
      id, kind: 'topic', topicId: id, name: topicWheelLabel(node), tip: topicTip(input, node), zoomable: children.length > 0,
      itemStyle: { color: topicColor(hierarchy, node) },
      ...(children.length > 0 ? { children } : { value }),
    }
  }
  const topicItems = (ids: readonly string[]): TopicChartItem[] => ids.flatMap((id) => topicItem(id) ?? [])

  const focus = input.focusId ? hierarchy.topics.get(input.focusId) : undefined
  const zoomRoot = focus && (focus.children.length > 0 || (chunks?.get(focus.id)?.length ?? 0) > 0) ? focus : undefined
  if (zoomRoot && zoomRoot.children.length === 0) return { items: chunkItems(zoomRoot), total: chunks?.get(zoomRoot.id)?.length ?? 0 }
  const ids = zoomRoot ? zoomRoot.children : hierarchy.roots
  return { items: topicItems(ids), total: ids.reduce((sum, id) => sum + valueOf(id), 0) }
}

export type TreeLayout = 'LR' | 'TB' | 'radial'
/** `default` opens the topics and folds the chunks, `expanded` opens everything, `collapsed` folds every topic. */
export type TreeMode = 'default' | 'expanded' | 'collapsed'

export type TopicTreeItem = {
  id: string
  kind: 'root' | 'topic' | 'chunk'
  topicId: string
  name: string
  tip: string
  value?: number
  symbolSize: number
  collapsed: boolean
  itemStyle: { color: string; borderColor: string }
  lineStyle: { color: string }
  children?: TopicTreeItem[]
}

export const TREE_ROOT_ID = 'root'

/** Items of the tree. A node grows with the corpus share of its topic. `visibleLeaves` sizes the chart for the open nodes. */
export function buildTreeItems(input: ChartInput & { mode: TreeMode; colors: TopicChartColors }): { root: TopicTreeItem; visibleLeaves: number } {
  const { hierarchy, chunks, labels, mode } = input
  let visibleLeaves = 0

  const chunkItems = (leaf: TopicNode): TopicTreeItem[] => (chunks?.get(leaf.id) ?? []).map((key) => {
    const color = chunkColor(hierarchy, leaf)
    return {
      id: key, kind: 'chunk', topicId: leaf.id, name: labels.get(key) ?? key, tip: chunkTip(input, leaf, key), value: 1, symbolSize: 7,
      collapsed: false, itemStyle: { color, borderColor: color }, lineStyle: { color },
    }
  })
  const topicItem = (id: string, parentOpen: boolean): TopicTreeItem => {
    const node = hierarchy.topics.get(id)!
    const color = topicColor(hierarchy, node)
    const hasTopics = node.children.length > 0
    const folded = mode === 'collapsed' ? true : hasTopics ? false : mode === 'default'
    const children = hasTopics ? node.children.map((child) => topicItem(child, parentOpen && !folded)) : chunkItems(node)
    if (parentOpen) {
      if (folded || children.length === 0) visibleLeaves += 1
      else if (!hasTopics) visibleLeaves += children.length
    }
    return {
      id, kind: 'topic', topicId: id, name: topicWheelLabel(node), tip: topicTip(input, node), symbolSize: Math.round(9 + Math.sqrt(node.proportion) * 26),
      collapsed: folded && children.length > 0, itemStyle: { color, borderColor: color }, lineStyle: { color },
      ...(children.length > 0 ? { children } : {}),
    }
  }
  const children = hierarchy.roots.map((id) => topicItem(id, true))
  const accent = input.colors.accent
  const root: TopicTreeItem = {
    id: TREE_ROOT_ID, kind: 'root', topicId: TREE_ROOT_ID, name: input.text.collection, tip: tipTitle(input.text.collection), symbolSize: 16, collapsed: false,
    itemStyle: { color: accent, borderColor: accent }, lineStyle: { color: accent }, children,
  }
  return { root, visibleLeaves: Math.max(1, visibleLeaves) }
}

const tooltipFormatter = (params: unknown): string => {
  const tip = (params as { data?: { tip?: unknown } } | null)?.data?.tip
  return typeof tip === 'string' ? tip : ''
}

const baseOption = (colors: TopicChartColors, animate: boolean, ariaLabel: string) => ({
  backgroundColor: 'transparent',
  animation: animate,
  textStyle: { fontFamily: colors.fontFamily ?? 'sans-serif' },
  aria: { enabled: true, label: { description: ariaLabel } },
  tooltip: {
    trigger: 'item',
    confine: true,
    backgroundColor: colors.panel,
    borderColor: colors.border,
    textStyle: { color: colors.foreground, fontSize: 12 },
    extraCssText: 'max-width:340px;white-space:normal;box-shadow:0 6px 20px rgba(0,0,0,.3);',
    formatter: tooltipFormatter,
  },
})

const depthOf = (items: readonly TopicChartItem[]): number =>
  items.reduce((deepest, item) => Math.max(deepest, 1 + (item.children ? depthOf(item.children) : 0)), 0)

/** The wheel is drawn into a square of about this many pixels; labels are laid out for a ring that fits it. */
const WHEEL_DIAMETER = 560
const SUNBURST_HOLE = 0.17
const SUNBURST_OUTER = 0.96
const LABEL_FONT_SIZE = 11
const LABEL_PADDING = 12

const WIDE_CHARACTER = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/
const textWidth = (text: string, fontSize: number) =>
  [...text].reduce((sum, character) => sum + (WIDE_CHARACTER.test(character) ? fontSize : fontSize * 0.58), 0)

/**
 * Sets the direction and the width of every label. A name that fits along the ring is written radially. A longer name
 * is written along the arc when the arc is longer than the ring is thick (inner rings usually are), and is otherwise cut.
 */
function withLabelLayout(items: readonly TopicChartItem[], ringThickness: number): TopicChartItem[] {
  const valueOf = (item: TopicChartItem): number => (item.children ? item.children.reduce((sum, child) => sum + valueOf(child), 0) : item.value ?? 0)
  const total = items.reduce((sum, item) => sum + valueOf(item), 0)
  const holeRadius = (SUNBURST_HOLE * WHEEL_DIAMETER) / 2
  const radialRoom = Math.max(24, Math.round(ringThickness - LABEL_PADDING))
  const visit = (list: readonly TopicChartItem[], depth: number): TopicChartItem[] => list.map((item) => {
    const arcLength = total > 0 ? (valueOf(item) / total) * 2 * Math.PI * (holeRadius + (depth - 0.5) * ringThickness) : 0
    const fitsRadially = textWidth(item.name, LABEL_FONT_SIZE) <= radialRoom
    const alongArc = !fitsRadially && arcLength - LABEL_PADDING > radialRoom
    return {
      ...item,
      label: alongArc ? { rotate: 'tangential', width: Math.round(arcLength - LABEL_PADDING) } : { rotate: 'radial', width: radialRoom },
      ...(item.children ? { children: visit(item.children, depth + 1) } : {}),
    }
  })
  return visit(items, 1)
}

export function buildSunburstOption(input: {
  items: readonly TopicChartItem[]
  title: string
  subtitle: string
  colors: TopicChartColors
  animate: boolean
  ariaLabel: string
}): EChartsCoreOption {
  const { colors } = input
  const ringThickness = ((SUNBURST_OUTER - SUNBURST_HOLE) * WHEEL_DIAMETER) / 2 / Math.max(1, depthOf(input.items))
  return {
    ...baseOption(colors, input.animate, input.ariaLabel),
    title: {
      text: input.title,
      subtext: input.subtitle,
      left: 'center',
      top: 'middle',
      itemGap: 6,
      triggerEvent: true,
      textStyle: { color: colors.foreground, fontSize: 14, fontWeight: 600, width: 104, overflow: 'truncate' },
      subtextStyle: { color: colors.muted, fontSize: 12, width: 104, overflow: 'truncate' },
    },
    series: [{
      type: 'sunburst',
      data: withLabelLayout(input.items, ringThickness),
      radius: [`${SUNBURST_HOLE * 100}%`, `${SUNBURST_OUTER * 100}%`],
      center: ['50%', '50%'],
      startAngle: 90,
      nodeClick: false,
      sort: (a: { dataIndex: number }, b: { dataIndex: number }) => a.dataIndex - b.dataIndex,
      itemStyle: { borderColor: colors.panel, borderWidth: 2, borderRadius: 5 },
      label: {
        minAngle: 7, color: '#fff', fontSize: LABEL_FONT_SIZE, textBorderColor: 'rgba(0, 0, 0, 0.45)', textBorderWidth: 2, overflow: 'truncate',
      },
      // Hovering outlines the segment and dims everything except its ancestors and descendants. This relies on ECharts being
      // able to parse every color it is given (see `topicBranchColor`); otherwise the hovered segment loses its fill and
      // cannot be hit, which made the hover state flip on and off with every pixel of pointer movement.
      emphasis: { focus: 'relative', itemStyle: { shadowBlur: 16, shadowColor: 'rgba(0, 0, 0, 0.4)' } },
      blur: { itemStyle: { opacity: 0.35 }, label: { opacity: 0.35 } },
      animationType: 'expansion',
      animationDuration: 700,
      animationDurationUpdate: 600,
      animationEasingUpdate: 'cubicInOut',
    }],
  }
}

export function buildTreeOption(input: {
  root: TopicTreeItem
  layout: TreeLayout
  colors: TopicChartColors
  animate: boolean
  ariaLabel: string
}): EChartsCoreOption {
  const { colors, layout } = input
  const text = { color: colors.foreground, fontSize: 12, width: 180, overflow: 'truncate' }
  const placement = layout === 'LR'
    ? {
      orient: 'LR', left: '9%', right: '27%', top: '4%', bottom: '4%',
      label: { ...text, position: 'left', verticalAlign: 'middle', align: 'right' },
      leaves: { label: { ...text, position: 'right', verticalAlign: 'middle', align: 'left' } },
    }
    : layout === 'TB'
      ? {
        orient: 'TB', left: '4%', right: '4%', top: '6%', bottom: '30%',
        label: { ...text, position: 'top', rotate: -90, verticalAlign: 'middle', align: 'right' },
        leaves: { label: { ...text, position: 'bottom', rotate: -90, verticalAlign: 'middle', align: 'left' } },
      }
      : { left: '12%', right: '12%', top: '8%', bottom: '8%', label: { ...text } }
  return {
    ...baseOption(colors, input.animate, input.ariaLabel),
    series: [{
      type: 'tree',
      data: [input.root],
      layout: layout === 'radial' ? 'radial' : 'orthogonal',
      edgeShape: 'curve',
      symbol: 'emptyCircle',
      roam: true,
      scaleLimit: { min: 0.4, max: 4 },
      expandAndCollapse: true,
      initialTreeDepth: -1,
      lineStyle: { width: 1.6, curveness: 0.5, opacity: 0.75 },
      itemStyle: { borderWidth: 2 },
      emphasis: { focus: 'descendant' },
      blur: { itemStyle: { opacity: 0.3 }, label: { opacity: 0.3 }, lineStyle: { opacity: 0.2 } },
      animationDuration: 600,
      animationDurationUpdate: 500,
      ...placement,
    }],
  }
}
