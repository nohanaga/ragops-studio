/**
 * Semantic Resource Diff Engine.
 *
 * Compares two Azure AI Search resource definitions (skillsets, indexes, etc.)
 * at the structural level rather than doing a naïve text diff.  This means:
 *
 *  - Key ordering differences are ignored (JSON objects are unordered by spec).
 *  - `null` vs missing key is treated as equivalent (Azure often strips nulls).
 *  - Empty arrays `[]` vs missing arrays are treated as equivalent.
 *  - Numeric precision differences (e.g. `1` vs `1.0`) are normalised.
 *  - `@odata.etag` and other service-injected metadata are stripped.
 *
 * The output is a list of human-readable change entries that can be rendered
 * in a review UI.  Each entry carries a JSON-path, the old value, the new
 * value, and a change kind (added / removed / changed / moved / reordered).
 */

// ─── Types ──────────────────────────────────────────────────────────────

export type DiffChangeKind =
  | 'added'
  | 'removed'
  | 'changed'
  | 'reordered'    // named items were reordered but identical in content
  | 'skill-added'
  | 'skill-removed'
  | 'skill-changed'
  | 'item-added'   // generic named-array item added (e.g. index field)
  | 'item-removed' // generic named-array item removed
  | 'item-changed' // generic named-array item changed
  | 'unchanged'

export type DiffEntry = {
  /** A human-readable JSON-path, e.g. `skills[1].inputs[0].source` */
  path: string
  kind: DiffChangeKind
  /** Previous value (serialised for display). `undefined` when `kind === 'added'`. */
  oldValue?: string
  /** New value (serialised for display). `undefined` when `kind === 'removed'`. */
  newValue?: string
  /** For skill-level changes, the skill name for identification. */
  skillName?: string
  /** Nested child changes (for skill-changed entries). */
  children?: DiffEntry[]
}

export type SkillsetDiffResult = {
  /** `true` when no semantic changes exist between the two objects. */
  identical: boolean
  /** Flat / tree list of all changes. */
  changes: DiffEntry[]
  /** The normalised "before" JSON text (for side-by-side display). */
  normalizedBeforeJson: string
  /** The normalised "after" JSON text (for side-by-side display). */
  normalizedAfterJson: string
}

// ─── Default service metadata keys to strip before comparison ───────────

const DEFAULT_SERVICE_META_KEYS = new Set([
  '@odata.etag',
  '@odata.context',
  // Azure may inject these on GET but they should not block publish.
  'encryptionKey',   // only compare if explicitly present in both
])

// ─── Configuration for generic resource diff ────────────────────────────

/**
 * Configuration for `computeResourceDiff`.  Describes which array fields
 * should be matched by name (like skills[] or fields[]) rather than by
 * position, and which metadata keys to strip.
 */
export interface ResourceDiffConfig {
  /** Top-level metadata keys to ignore (default: @odata.etag, @odata.context, encryptionKey). */
  serviceMeta?: Set<string>
  /**
   * Named arrays: top-level array fields whose elements are objects with a
   * `name` property.  These are matched by name (+ optional `typeKey`) rather
   * than by index position.
   *
   * Example for skillset: `[{ field: 'skills', typeKey: '@odata.type', label: 'skill' }]`
   * Example for index:    `[{ field: 'fields', label: 'field' }]`
   */
  namedArrays?: Array<{
    /** The top-level key, e.g. `'skills'` or `'fields'`. */
    field: string
    /** Optional secondary matching key (e.g. `'@odata.type'`). */
    typeKey?: string
    /** Human-readable label for diff display (e.g. `'skill'`, `'field'`). */
    label: string
  }>
}

// ─── Normalisation helpers ──────────────────────────────────────────────

export type JsonPrimitive = string | number | boolean | null
export type JsonArray = JsonVal[]
export type JsonObject = { [key: string]: JsonVal }
export type JsonVal = JsonPrimitive | JsonArray | JsonObject

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Deep-normalise a parsed JSON value:
 * - Sort object keys alphabetically (for deterministic comparison).
 * - Treat `null`, `undefined`, and empty-string the same for optional fields.
 * - Strip service metadata.
 */
function normalise(val: unknown, stripMeta = true, metaKeys: Set<string> = DEFAULT_SERVICE_META_KEYS): JsonVal {
  if (val === undefined || val === null) return null

  if (typeof val === 'number') {
    // Normalise -0 → 0
    return Object.is(val, -0) ? 0 : val
  }

  if (typeof val === 'string' || typeof val === 'boolean') {
    return val as JsonPrimitive
  }

  if (Array.isArray(val)) {
    return val.map((item) => normalise(item, stripMeta))
  }

  if (isObject(val)) {
    const keys = Object.keys(val).sort()
    const out: JsonObject = {}
    for (const k of keys) {
      if (stripMeta && metaKeys.has(k)) continue
      const v = normalise(val[k], stripMeta, metaKeys)
      // Drop keys whose normalised value is null (treat as "absent").
      // But keep explicit `false`, `0`, `""` (falsy but meaningful).
      if (v === null) continue
      // Drop empty arrays (equivalent to absent in Azure skillset semantics).
      if (Array.isArray(v) && v.length === 0) continue
      out[k] = v
    }
    return out
  }

  // Fallback — cast to string.
  return String(val)
}

/** Stable JSON serialisation (keys sorted, 2-space indent). */
function stableStringify(val: JsonVal): string {
  return JSON.stringify(val, null, 2) ?? 'null'
}

/** Compact single-line stringify for diff display values. */
function compactStringify(val: unknown): string {
  if (val === undefined) return 'undefined'
  if (val === null) return 'null'
  if (typeof val === 'string') return val.length > 120 ? `"${val.slice(0, 117)}…"` : `"${val}"`
  try {
    const s = JSON.stringify(val)
    return s.length > 200 ? s.slice(0, 197) + '…' : s
  } catch {
    return String(val)
  }
}

// ─── Deep equality ──────────────────────────────────────────────────────

function deepEqual(a: JsonVal, b: JsonVal): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false

  if (typeof a === 'number' && typeof b === 'number') {
    return a === b
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }

  if (isObject(a) && isObject(b)) {
    const keysA = Object.keys(a as JsonObject)
    const keysB = Object.keys(b as JsonObject)
    if (keysA.length !== keysB.length) return false
    return keysA.every((k) => deepEqual((a as JsonObject)[k], (b as JsonObject)[k]))
  }

  return a === b
}

// ─── Skill matching ─────────────────────────────────────────────────────

/**
 * Match skills across before/after by identity key.
 * Priority: 1) name+@odata.type, 2) name alone, 3) index position.
 */
function matchSkills(
  before: JsonVal[],
  after: JsonVal[],
): Array<{ beforeIdx: number | null; afterIdx: number | null }> {
  const result: Array<{ beforeIdx: number | null; afterIdx: number | null }> = []
  const usedBefore = new Set<number>()
  const usedAfter = new Set<number>()

  const key = (skill: JsonVal): string => {
    if (!isObject(skill)) return ''
    const s = skill as JsonObject
    const name = typeof s.name === 'string' ? s.name : ''
    const type = typeof s['@odata.type'] === 'string' ? s['@odata.type'] : ''
    return `${type}::${name}`
  }

  const nameOf = (skill: JsonVal): string => {
    if (!isObject(skill)) return ''
    const s = skill as JsonObject
    return typeof s.name === 'string' ? s.name : ''
  }

  // Pass 1: exact key match (type + name)
  for (let ai = 0; ai < after.length; ai++) {
    const ak = key(after[ai])
    if (!ak) continue
    for (let bi = 0; bi < before.length; bi++) {
      if (usedBefore.has(bi)) continue
      if (key(before[bi]) === ak) {
        result.push({ beforeIdx: bi, afterIdx: ai })
        usedBefore.add(bi)
        usedAfter.add(ai)
        break
      }
    }
  }

  // Pass 2: name-only match for unmatched
  for (let ai = 0; ai < after.length; ai++) {
    if (usedAfter.has(ai)) continue
    const an = nameOf(after[ai])
    if (!an) continue
    for (let bi = 0; bi < before.length; bi++) {
      if (usedBefore.has(bi)) continue
      if (nameOf(before[bi]) === an) {
        result.push({ beforeIdx: bi, afterIdx: ai })
        usedBefore.add(bi)
        usedAfter.add(ai)
        break
      }
    }
  }

  // Pass 3: positional match ONLY for unnamed skills (skills with no name
  // that couldn't be matched by type+name or name alone). Named skills that
  // didn't match should appear as distinct add/remove entries.
  for (let ai = 0; ai < after.length; ai++) {
    if (usedAfter.has(ai)) continue
    const an = nameOf(after[ai])
    if (an) continue // Named skill — don't fall back to positional
    if (!usedBefore.has(ai) && ai < before.length && !nameOf(before[ai])) {
      result.push({ beforeIdx: ai, afterIdx: ai })
      usedBefore.add(ai)
      usedAfter.add(ai)
    }
  }

  // Remaining unmatched "after" entries → added
  for (let ai = 0; ai < after.length; ai++) {
    if (!usedAfter.has(ai)) {
      result.push({ beforeIdx: null, afterIdx: ai })
    }
  }

  // Remaining unmatched "before" entries → removed
  for (let bi = 0; bi < before.length; bi++) {
    if (!usedBefore.has(bi)) {
      result.push({ beforeIdx: bi, afterIdx: null })
    }
  }

  return result
}

// ─── Generic named-item matching ────────────────────────────────────────

/**
 * Match named items across before/after by identity key.
 * Priority: 1) typeKey+name, 2) name alone, 3) positional (unnamed only).
 *
 * This is a generalised version of `matchSkills` that works for any array
 * of objects with a `name` property (e.g. fields[], scoringProfiles[]).
 */
function matchNamedItems(
  before: JsonVal[],
  after: JsonVal[],
  typeKey?: string,
): Array<{ beforeIdx: number | null; afterIdx: number | null }> {
  const result: Array<{ beforeIdx: number | null; afterIdx: number | null }> = []
  const usedBefore = new Set<number>()
  const usedAfter = new Set<number>()

  const key = (item: JsonVal): string => {
    if (!isObject(item)) return ''
    const s = item as JsonObject
    const name = typeof s.name === 'string' ? s.name : ''
    const type = typeKey && typeof s[typeKey] === 'string' ? (s[typeKey] as string) : ''
    return type ? `${type}::${name}` : name
  }

  const nameOf = (item: JsonVal): string => {
    if (!isObject(item)) return ''
    const s = item as JsonObject
    return typeof s.name === 'string' ? s.name : ''
  }

  // Pass 1: exact key match (typeKey + name, or name only when no typeKey)
  for (let ai = 0; ai < after.length; ai++) {
    const ak = key(after[ai])
    if (!ak) continue
    for (let bi = 0; bi < before.length; bi++) {
      if (usedBefore.has(bi)) continue
      if (key(before[bi]) === ak) {
        result.push({ beforeIdx: bi, afterIdx: ai })
        usedBefore.add(bi)
        usedAfter.add(ai)
        break
      }
    }
  }

  // Pass 2: name-only match for unmatched (when typeKey is set)
  if (typeKey) {
    for (let ai = 0; ai < after.length; ai++) {
      if (usedAfter.has(ai)) continue
      const an = nameOf(after[ai])
      if (!an) continue
      for (let bi = 0; bi < before.length; bi++) {
        if (usedBefore.has(bi)) continue
        if (nameOf(before[bi]) === an) {
          result.push({ beforeIdx: bi, afterIdx: ai })
          usedBefore.add(bi)
          usedAfter.add(ai)
          break
        }
      }
    }
  }

  // Pass 3: positional match for unnamed items only
  for (let ai = 0; ai < after.length; ai++) {
    if (usedAfter.has(ai)) continue
    const an = nameOf(after[ai])
    if (an) continue
    if (!usedBefore.has(ai) && ai < before.length && !nameOf(before[ai])) {
      result.push({ beforeIdx: ai, afterIdx: ai })
      usedBefore.add(ai)
      usedAfter.add(ai)
    }
  }

  // Remaining unmatched
  for (let ai = 0; ai < after.length; ai++) {
    if (!usedAfter.has(ai)) result.push({ beforeIdx: null, afterIdx: ai })
  }
  for (let bi = 0; bi < before.length; bi++) {
    if (!usedBefore.has(bi)) result.push({ beforeIdx: bi, afterIdx: null })
  }

  return result
}

// ─── Object-level diff ──────────────────────────────────────────────────

/**
 * Diff two normalised objects and produce DiffEntry children.
 */
function diffObjects(
  before: JsonObject,
  after: JsonObject,
  pathPrefix: string,
): DiffEntry[] {
  const entries: DiffEntry[] = []
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)])

  for (const k of allKeys) {
    const fullPath = pathPrefix ? `${pathPrefix}.${k}` : k
    const hasB = k in before
    const hasA = k in after

    if (hasB && !hasA) {
      entries.push({
        path: fullPath,
        kind: 'removed',
        oldValue: compactStringify(before[k]),
      })
    } else if (!hasB && hasA) {
      entries.push({
        path: fullPath,
        kind: 'added',
        newValue: compactStringify(after[k]),
      })
    } else {
      // Both exist
      const bv = before[k]
      const av = after[k]
      if (deepEqual(bv, av)) continue

      if (isObject(bv) && isObject(av)) {
        const children = diffObjects(bv as JsonObject, av as JsonObject, fullPath)
        if (children.length > 0) entries.push(...children)
      } else if (Array.isArray(bv) && Array.isArray(av)) {
        const children = diffArrays(bv, av, fullPath)
        if (children.length > 0) entries.push(...children)
      } else {
        entries.push({
          path: fullPath,
          kind: 'changed',
          oldValue: compactStringify(bv),
          newValue: compactStringify(av),
        })
      }
    }
  }

  return entries
}

/**
 * Diff two normalised arrays.
 */
function diffArrays(
  before: JsonArray,
  after: JsonArray,
  pathPrefix: string,
): DiffEntry[] {
  const entries: DiffEntry[] = []

  // For short arrays or arrays of primitives, simple index-by-index comparison.
  const maxLen = Math.max(before.length, after.length)
  for (let i = 0; i < maxLen; i++) {
    const fullPath = `${pathPrefix}[${i}]`
    if (i >= before.length) {
      entries.push({
        path: fullPath,
        kind: 'added',
        newValue: compactStringify(after[i]),
      })
    } else if (i >= after.length) {
      entries.push({
        path: fullPath,
        kind: 'removed',
        oldValue: compactStringify(before[i]),
      })
    } else if (!deepEqual(before[i], after[i])) {
      if (isObject(before[i]) && isObject(after[i])) {
        const children = diffObjects(before[i] as JsonObject, after[i] as JsonObject, fullPath)
        if (children.length > 0) entries.push(...children)
      } else {
        entries.push({
          path: fullPath,
          kind: 'changed',
          oldValue: compactStringify(before[i]),
          newValue: compactStringify(after[i]),
        })
      }
    }
  }

  return entries
}

// ─── Skill-level diff ───────────────────────────────────────────────────

function diffSkillsArray(
  beforeSkills: JsonVal[],
  afterSkills: JsonVal[],
): DiffEntry[] {
  const matches = matchSkills(beforeSkills, afterSkills)
  const entries: DiffEntry[] = []

  for (const m of matches) {
    if (m.beforeIdx !== null && m.afterIdx !== null) {
      const bSkill = normalise(beforeSkills[m.beforeIdx]) as JsonObject
      const aSkill = normalise(afterSkills[m.afterIdx]) as JsonObject
      const skillName = (typeof aSkill.name === 'string' ? aSkill.name : '') ||
                        (typeof bSkill.name === 'string' ? bSkill.name : '') ||
                        `[${m.afterIdx}]`

      if (deepEqual(bSkill, aSkill)) {
        // Position may have changed — note reorder if index differs.
        if (m.beforeIdx !== m.afterIdx) {
          entries.push({
            path: `skills[${m.afterIdx}]`,
            kind: 'reordered',
            skillName,
            oldValue: `index ${m.beforeIdx}`,
            newValue: `index ${m.afterIdx}`,
          })
        }
        continue
      }

      const children = diffObjects(bSkill, aSkill, `skills[${m.afterIdx}]`)
      entries.push({
        path: `skills[${m.afterIdx}]`,
        kind: 'skill-changed',
        skillName,
        children,
      })
    } else if (m.beforeIdx !== null) {
      const bSkill = beforeSkills[m.beforeIdx]
      const skillName = isObject(bSkill) && typeof (bSkill as JsonObject).name === 'string'
        ? (bSkill as JsonObject).name as string : `[${m.beforeIdx}]`
      entries.push({
        path: `skills[${m.beforeIdx}]`,
        kind: 'skill-removed',
        skillName,
        oldValue: compactStringify(bSkill),
      })
    } else if (m.afterIdx !== null) {
      const aSkill = afterSkills[m.afterIdx]
      const skillName = isObject(aSkill) && typeof (aSkill as JsonObject).name === 'string'
        ? (aSkill as JsonObject).name as string : `[${m.afterIdx}]`
      entries.push({
        path: `skills[${m.afterIdx}]`,
        kind: 'skill-added',
        skillName,
        newValue: compactStringify(aSkill),
      })
    }
  }

  return entries
}

// ─── Main entry point ───────────────────────────────────────────────────

/**
 * Compute a semantic diff between two skillset definitions.
 *
 * Both inputs should be the plain objects (already parsed from JSON).
 * Service metadata (`@odata.etag`, etc.) is automatically stripped.
 *
 * @param before - The skillset definition currently on the service (or empty `{}` for new).
 * @param after  - The candidate skillset definition from the editor.
 * @returns A `SkillsetDiffResult` with per-field change entries.
 */
export function computeSkillsetDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SkillsetDiffResult {
  const normBefore = normalise(before) as JsonObject
  const normAfter = normalise(after) as JsonObject

  const normalizedBeforeJson = stableStringify(normBefore)
  const normalizedAfterJson = stableStringify(normAfter)

  if (deepEqual(normBefore, normAfter)) {
    return {
      identical: true,
      changes: [],
      normalizedBeforeJson,
      normalizedAfterJson,
    }
  }

  const changes: DiffEntry[] = []

  // ── Top-level properties (excluding `skills`) ───────────────────────

  const topBefore = { ...normBefore }
  const topAfter = { ...normAfter }
  delete topBefore.skills
  delete topAfter.skills

  const topChanges = diffObjects(topBefore, topAfter, '')
  changes.push(...topChanges)

  // ── Skills array (matched by name) ──────────────────────────────────

  const bSkills = Array.isArray(normBefore.skills) ? normBefore.skills : []
  const aSkills = Array.isArray(normAfter.skills) ? normAfter.skills : []

  const skillChanges = diffSkillsArray(bSkills, aSkills)
  changes.push(...skillChanges)

  return {
    identical: changes.length === 0,
    changes,
    normalizedBeforeJson,
    normalizedAfterJson,
  }
}

// ─── Generic named-array diff ───────────────────────────────────────────

/**
 * Diff a named array field (e.g. `fields[]`, `scoringProfiles[]`) using
 * name-based matching.  Produces `item-added` / `item-removed` / `item-changed`
 * and `reordered` entries.
 */
function diffNamedArray(
  beforeItems: JsonVal[],
  afterItems: JsonVal[],
  fieldName: string,
  typeKey: string | undefined,
  metaKeys: Set<string>,
): DiffEntry[] {
  const matches = matchNamedItems(beforeItems, afterItems, typeKey)
  const entries: DiffEntry[] = []

  for (const m of matches) {
    if (m.beforeIdx !== null && m.afterIdx !== null) {
      const bItem = normalise(beforeItems[m.beforeIdx], true, metaKeys) as JsonObject
      const aItem = normalise(afterItems[m.afterIdx], true, metaKeys) as JsonObject
      const itemName = (typeof aItem.name === 'string' ? aItem.name : '') ||
                       (typeof bItem.name === 'string' ? bItem.name : '') ||
                       `[${m.afterIdx}]`

      if (deepEqual(bItem, aItem)) {
        if (m.beforeIdx !== m.afterIdx) {
          entries.push({
            path: `${fieldName}[${m.afterIdx}]`,
            kind: 'reordered',
            skillName: itemName,
            oldValue: `index ${m.beforeIdx}`,
            newValue: `index ${m.afterIdx}`,
          })
        }
        continue
      }

      const children = diffObjects(bItem, aItem, `${fieldName}[${m.afterIdx}]`)
      entries.push({
        path: `${fieldName}[${m.afterIdx}]`,
        kind: 'item-changed',
        skillName: itemName,
        children,
      })
    } else if (m.beforeIdx !== null) {
      const bItem = beforeItems[m.beforeIdx]
      const itemName = isObject(bItem) && typeof (bItem as JsonObject).name === 'string'
        ? (bItem as JsonObject).name as string : `[${m.beforeIdx}]`
      entries.push({
        path: `${fieldName}[${m.beforeIdx}]`,
        kind: 'item-removed',
        skillName: itemName,
        oldValue: compactStringify(bItem),
      })
    } else if (m.afterIdx !== null) {
      const aItem = afterItems[m.afterIdx]
      const itemName = isObject(aItem) && typeof (aItem as JsonObject).name === 'string'
        ? (aItem as JsonObject).name as string : `[${m.afterIdx}]`
      entries.push({
        path: `${fieldName}[${m.afterIdx}]`,
        kind: 'item-added',
        skillName: itemName,
        newValue: compactStringify(aItem),
      })
    }
  }

  return entries
}

// ─── Generic resource diff ──────────────────────────────────────────────

/** Result type alias — identical structure, usable for any resource type. */
export type ResourceDiffResult = SkillsetDiffResult

/**
 * Compute a semantic diff between two Azure resource definitions.
 *
 * Works for skillsets, indexes, indexers, or any JSON object that follows
 * Azure AI Search conventions.  Named arrays (like `skills[]` or `fields[]`)
 * are matched by name rather than by position.
 *
 * @param before - The resource definition currently on the service (or `{}` for new).
 * @param after  - The candidate resource definition from the editor.
 * @param config - Optional configuration for metadata stripping and named arrays.
 */
export function computeResourceDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  config?: ResourceDiffConfig,
): ResourceDiffResult {
  const metaKeys = config?.serviceMeta ?? DEFAULT_SERVICE_META_KEYS
  const namedArrays = config?.namedArrays ?? []

  const normBefore = normalise(before, true, metaKeys) as JsonObject
  const normAfter = normalise(after, true, metaKeys) as JsonObject

  const normalizedBeforeJson = stableStringify(normBefore)
  const normalizedAfterJson = stableStringify(normAfter)

  if (deepEqual(normBefore, normAfter)) {
    return { identical: true, changes: [], normalizedBeforeJson, normalizedAfterJson }
  }

  const changes: DiffEntry[] = []

  // Collect named-array field names to exclude from top-level diff
  const namedFieldNames = new Set(namedArrays.map((na) => na.field))

  // Top-level properties (excluding named arrays)
  const topBefore = { ...normBefore }
  const topAfter = { ...normAfter }
  for (const f of namedFieldNames) {
    delete topBefore[f]
    delete topAfter[f]
  }
  changes.push(...diffObjects(topBefore, topAfter, ''))

  // Each named array
  for (const na of namedArrays) {
    const bArr = Array.isArray(normBefore[na.field]) ? normBefore[na.field] as JsonVal[] : []
    const aArr = Array.isArray(normAfter[na.field]) ? normAfter[na.field] as JsonVal[] : []
    changes.push(...diffNamedArray(bArr, aArr, na.field, na.typeKey, metaKeys))
  }

  return { identical: changes.length === 0, changes, normalizedBeforeJson, normalizedAfterJson }
}

/**
 * Render a DiffEntry tree as a concise text summary (for clipboard / logs).
 */
export function diffEntriesToText(entries: DiffEntry[], indent = 0): string {
  const pad = '  '.repeat(indent)
  const lines: string[] = []

  for (const e of entries) {
    switch (e.kind) {
      case 'added':
        lines.push(`${pad}+ ${e.path}: ${e.newValue}`)
        break
      case 'removed':
        lines.push(`${pad}- ${e.path}: ${e.oldValue}`)
        break
      case 'changed':
        lines.push(`${pad}~ ${e.path}: ${e.oldValue} → ${e.newValue}`)
        break
      case 'reordered':
        lines.push(`${pad}↕ ${e.path} (${e.skillName}): ${e.oldValue} → ${e.newValue}`)
        break
      case 'skill-added':
        lines.push(`${pad}+ skill "${e.skillName}" added`)
        break
      case 'skill-removed':
        lines.push(`${pad}- skill "${e.skillName}" removed`)
        break
      case 'skill-changed':
        lines.push(`${pad}~ skill "${e.skillName}":`)
        if (e.children) lines.push(diffEntriesToText(e.children, indent + 1))
        break
      case 'item-added':
        lines.push(`${pad}+ "${e.skillName}" added`)
        break
      case 'item-removed':
        lines.push(`${pad}- "${e.skillName}" removed`)
        break
      case 'item-changed':
        lines.push(`${pad}~ "${e.skillName}":`)
        if (e.children) lines.push(diffEntriesToText(e.children, indent + 1))
        break
      case 'unchanged':
        // skip
        break
    }
  }

  return lines.join('\n')
}
