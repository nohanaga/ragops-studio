/**
 * Geometry of the topic wheel (a sunburst): the topic hierarchy as concentric rings that grow from the center.
 * An arc is as wide as its share. Without chunks the share is the corpus share of the leaf topics (`prop:proportion`).
 * With chunks every chunk has the same width, so a topic is as wide as the number of chunks placed in it.
 * Angles are in radians, clockwise from 12 o'clock.
 */

import type { TopicHierarchy, TopicNode } from './topicGraphCoverage'

export type WheelChunks = ReadonlyMap<string, readonly string[]>

export type SunburstArc = {
  /** Topic ID for a topic arc, chunk key for a chunk arc. */
  id: string
  kind: 'topic' | 'chunk'
  /** The topic itself, or the leaf topic that holds the chunk. */
  topicId: string
  /** Rings from the center: 1 is the innermost ring. */
  depth: number
  start: number
  end: number
  /** Index of the top-level topic that this arc belongs to. */
  branchIndex: number
  value: number
  /** True for a topic that has sub-topics (or chunks) to zoom into. */
  zoomable: boolean
}

export type SunburstLayout = {
  arcs: SunburstArc[]
  /** Number of rings that hold at least one arc. */
  levels: number
  /** Sum of the values of the arcs in the first ring. */
  total: number
}

const FULL_TURN = Math.PI * 2

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

export function layoutTopicSunburst(hierarchy: TopicHierarchy, chunks?: WheelChunks, focusId?: string): SunburstLayout {
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

  const focus = focusId ? hierarchy.topics.get(focusId) : undefined
  const firstRing = focus && (focus.children.length > 0 || (chunks?.get(focus.id)?.length ?? 0) > 0) ? focus : undefined
  const arcs: SunburstArc[] = []

  const placeChunks = (leaf: TopicNode, start: number, end: number, depth: number) => {
    const keys = chunks?.get(leaf.id) ?? []
    const step = (end - start) / Math.max(keys.length, 1)
    keys.forEach((key, index) => {
      arcs.push({
        id: key, kind: 'chunk', topicId: leaf.id, depth, start: start + index * step, end: start + (index + 1) * step,
        branchIndex: hierarchy.roots.indexOf(leaf.branchId), value: 1, zoomable: false,
      })
    })
  }

  const place = (ids: readonly string[], start: number, end: number, depth: number) => {
    const sum = ids.reduce((total, id) => total + valueOf(id), 0)
    if (sum <= 0) return
    let cursor = start
    for (const id of ids) {
      const value = valueOf(id)
      if (value <= 0) continue
      const node = hierarchy.topics.get(id)!
      const span = (end - start) * (value / sum)
      const hasChunks = node.children.length === 0 && (chunks?.get(id)?.length ?? 0) > 0
      arcs.push({
        id, kind: 'topic', topicId: id, depth, start: cursor, end: cursor + span,
        branchIndex: hierarchy.roots.indexOf(node.branchId), value, zoomable: node.children.length > 0 || hasChunks,
      })
      if (node.children.length > 0) place(node.children, cursor, cursor + span, depth + 1)
      else if (hasChunks) placeChunks(node, cursor, cursor + span, depth + 1)
      cursor += span
    }
  }

  if (firstRing && firstRing.children.length === 0) placeChunks(firstRing, 0, FULL_TURN, 1)
  else place(firstRing ? firstRing.children : hierarchy.roots, 0, FULL_TURN, 1)

  const ids = firstRing ? firstRing.children : hierarchy.roots
  return {
    arcs,
    levels: arcs.reduce((deepest, arc) => Math.max(deepest, arc.depth), 0),
    total: firstRing && firstRing.children.length === 0 ? chunks?.get(firstRing.id)?.length ?? 0 : ids.reduce((sum, id) => sum + valueOf(id), 0),
  }
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

const point = (radius: number, angle: number): [number, number] => [radius * Math.sin(angle), -radius * Math.cos(angle)]
const fixed = (value: number) => Number(value.toFixed(2)) + 0

/** SVG path of a ring segment around (0, 0). A full turn is shortened slightly because SVG cannot draw a closed arc. */
export function ringSegmentPath(inner: number, outer: number, start: number, end: number): string {
  const sweep = Math.min(end - start, FULL_TURN - 1e-4)
  const stop = start + sweep
  const large = sweep > Math.PI ? 1 : 0
  const [ox0, oy0] = point(outer, start)
  const [ox1, oy1] = point(outer, stop)
  const [ix1, iy1] = point(inner, stop)
  const [ix0, iy0] = point(inner, start)
  return [
    `M${fixed(ox0)} ${fixed(oy0)}`,
    `A${fixed(outer)} ${fixed(outer)} 0 ${large} 1 ${fixed(ox1)} ${fixed(oy1)}`,
    `L${fixed(ix1)} ${fixed(iy1)}`,
    `A${fixed(inner)} ${fixed(inner)} 0 ${large} 0 ${fixed(ix0)} ${fixed(iy0)}`,
    'Z',
  ].join(' ')
}

export type WheelLabelPlacement = {
  x: number
  y: number
  /** Degrees. The text runs along the radius and is flipped on the left half so that it is never upside down. */
  rotation: number
  text: string
}

const WIDE_CHARACTER = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uff00-\uffef]/
const characterWidth = (character: string, fontSize: number) => (WIDE_CHARACTER.test(character) ? 1 : 0.58) * fontSize

/** Shortens `text` with an ellipsis so that it fits in `maxWidth`. Returns undefined when fewer than 2 characters fit. */
export function fitWheelText(text: string, maxWidth: number, fontSize: number): string | undefined {
  const characters = [...text]
  let width = 0
  let fitting = 0
  for (const character of characters) {
    width += characterWidth(character, fontSize)
    if (width > maxWidth) break
    fitting += 1
  }
  if (fitting === characters.length) return text
  const ellipsis = characterWidth('…', fontSize)
  let shortened = 0
  width = ellipsis
  for (const character of characters) {
    width += characterWidth(character, fontSize)
    if (width > maxWidth) break
    shortened += 1
  }
  return shortened >= 2 ? `${characters.slice(0, shortened).join('')}…` : undefined
}

/** Radial label of a ring segment, or undefined when the segment is too narrow or too thin to read. */
export function placeWheelLabel(
  text: string, inner: number, outer: number, start: number, end: number, fontSize: number,
): WheelLabelPlacement | undefined {
  const middleRadius = (inner + outer) / 2
  if ((end - start) * middleRadius < fontSize * 1.15) return undefined
  const fitted = fitWheelText(text, outer - inner - fontSize * 0.7, fontSize)
  if (!fitted) return undefined
  const middle = (start + end) / 2
  const [x, y] = point(middleRadius, middle)
  const degrees = (middle * 180) / Math.PI
  return { x: fixed(x), y: fixed(y), rotation: fixed(degrees > 180 ? degrees - 270 : degrees - 90), text: fitted }
}
