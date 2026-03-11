/**
 * Visual builder for Azure AI Search `$filter` (OData) expressions.
 *
 * Keeps the filter editable both as a string and as a structured expression,
 * using the lightweight parser/linter in `src/lib/odataFilter.ts`.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import { getIndexDefinition } from '../../lib/aiSearchRest'
import { translations, type Language } from '../../lib/translations'
import {
  lintODataFilter,
  parseODataFilter,
  serializeODataFilter,
  type ODataFilterExpr,
} from '../../lib/odataFilter'

type IndexField = {
  name?: string
  type?: string
  filterable?: boolean
  fields?: IndexField[]
}

type FieldInfo = {
  path: string
  type: string
  filterable: boolean
  isCollection: boolean
  elementFields?: IndexField[]
}

type CompareOp = Extract<ODataFilterExpr, { kind: 'compare' }>['op']

function isCompareOp(value: string): value is CompareOp {
  return value === 'eq' || value === 'ne' || value === 'gt' || value === 'ge' || value === 'lt' || value === 'le'
}

function extractCollectionElementType(type: string): string {
  const m = /^Collection\((.*)\)$/.exec(type)
  return m ? m[1] : type
}

function flattenFields(fields: IndexField[], prefix = ''): FieldInfo[] {
  // Flatten nested index schema fields into a "path" list that can be bound to dropdowns.
  // Supports complex types and collections of complex types.
  const out: FieldInfo[] = []
  for (const f of fields) {
    const name = typeof f.name === 'string' ? f.name : ''
    const type = typeof f.type === 'string' ? f.type : 'Edm.String'
    if (!name) continue

    const path = prefix ? `${prefix}/${name}` : name
    const isCollection = /^Collection\(/.test(type)
    const elementType = extractCollectionElementType(type)

    const hasChildren = Array.isArray(f.fields) && f.fields.length > 0
    if (hasChildren) {
      // Complex type or collection of complex type.
      const children = flattenFields(f.fields ?? [], path)
      out.push(
        {
          path,
          type,
          filterable: !!f.filterable,
          isCollection,
          elementFields: isCollection ? f.fields : undefined,
        },
        ...children,
      )
    } else {
      out.push({
        path,
        type,
        filterable: !!f.filterable,
        isCollection,
        elementFields: isCollection && elementType === 'Edm.ComplexType' ? f.fields : undefined,
      })
    }
  }
  return out
}

function makeStringLiteral(s: string): ODataFilterExpr {
  return { kind: 'stringLiteral', value: s }
}

function makePath(p: string): Extract<ODataFilterExpr, { kind: 'path' }> {
  return { kind: 'path', value: p }
}

function isPathExpr(e: ODataFilterExpr): e is { kind: 'path'; value: string } {
  return e.kind === 'path'
}

function isCallExpr(e: ODataFilterExpr): e is { kind: 'call'; name: string; args: ODataFilterExpr[] } {
  return e.kind === 'call'
}

function SearchInListEditor(props: {
  list: string
  delim: string
  onChangeList: (next: string) => void
  placeholder: string
  emptyText: string
  removeTitle: string
}) {
  // Editor helper for functions like `search.in(field, 'a,b,c', ',')`.
  const effectiveDelim = props.delim || ','

  const items = useMemo(() => {
    if (!props.list) return []
    return props.list
      .split(effectiveDelim)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }, [props.list, effectiveDelim])

  const [draft, setDraft] = useState('')

  const add = () => {
    const next = draft.trim()
    if (!next) return
    const nextItems = [...items, next]
    props.onChangeList(nextItems.join(effectiveDelim))
    setDraft('')
  }

  const removeAt = (index: number) => {
    const nextItems = items.filter((_, i) => i !== index)
    props.onChangeList(nextItems.join(effectiveDelim))
  }

  return (
    <div className="list-editor">
      <div className="list-editor__inputRow">
        <input
          className="field__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          placeholder={props.placeholder}
        />
        <button type="button" className="btn" onClick={add}>
          +
        </button>
      </div>

      {items.length > 0 ? (
        <div className="list-editor__chips">
          {items.map((v, i) => (
            <div
              key={`${v}-${i}`}
              className="list-chip"
            >
              <span className="mono list-chip__text">{v}</span>
              <button
                type="button"
                className="btn btn--danger btn--xs"
                onClick={() => removeAt(i)}
                title={props.removeTitle}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-muted-xs">{props.emptyText}</div>
      )}
    </div>
  )
}

function getIndexFieldsFromResponse(response: unknown): IndexField[] {
  if (!response || typeof response !== 'object') return []
  const maybe = response as { fields?: unknown }
  return Array.isArray(maybe.fields) ? (maybe.fields as IndexField[]) : []
}

function assocFlatten(op: 'and' | 'or', e: ODataFilterExpr): ODataFilterExpr[] {
  if (e.kind === op) {
    return [...assocFlatten(op, e.left), ...assocFlatten(op, e.right)]
  }
  return [e]
}

function assocFold(op: 'and' | 'or', items: ODataFilterExpr[]): ODataFilterExpr {
  if (items.length === 0) return { kind: 'boolLiteral', value: true }
  let acc = items[0]
  for (let i = 1; i < items.length; i++) {
    acc = { kind: op, left: acc, right: items[i] }
  }
  return acc
}

type UiNode =
  | { kind: 'group'; op: 'and' | 'or'; items: UiNode[] }
  | { kind: 'not'; item: UiNode }
  | { kind: 'compare'; expr: Extract<ODataFilterExpr, { kind: 'compare' }> }
  | { kind: 'call'; expr: Extract<ODataFilterExpr, { kind: 'call' }> }
  | { kind: 'lambda'; expr: Extract<ODataFilterExpr, { kind: 'lambda' }> }
  | { kind: 'bool'; expr: Extract<ODataFilterExpr, { kind: 'path' }> }
  | { kind: 'literal'; expr: Extract<ODataFilterExpr, { kind: 'boolLiteral' | 'nullLiteral' | 'stringLiteral' | 'numberLiteral' | 'dateTimeLiteral' | 'geographyLiteral' }> }

function astToUi(e: ODataFilterExpr): UiNode {
  if (e.kind === 'and' || e.kind === 'or') {
    const items = assocFlatten(e.kind, e).map(astToUi)
    return { kind: 'group', op: e.kind, items }
  }
  if (e.kind === 'not') return { kind: 'not', item: astToUi(e.expr) }
  if (e.kind === 'compare') return { kind: 'compare', expr: e }
  if (e.kind === 'call') return { kind: 'call', expr: e }
  if (e.kind === 'lambda') return { kind: 'lambda', expr: e }
  if (e.kind === 'path') return { kind: 'bool', expr: e }
  if (
    e.kind === 'boolLiteral' ||
    e.kind === 'nullLiteral' ||
    e.kind === 'stringLiteral' ||
    e.kind === 'numberLiteral' ||
    e.kind === 'dateTimeLiteral' ||
    e.kind === 'geographyLiteral'
  ) {
    return { kind: 'literal', expr: e }
  }
  // Fallback: show as call-ish literal string
  return { kind: 'literal', expr: { kind: 'boolLiteral', value: true } }
}

function uiToAst(n: UiNode): ODataFilterExpr {
  switch (n.kind) {
    case 'group':
      return assocFold(n.op, n.items.map(uiToAst))
    case 'not':
      return { kind: 'not', expr: uiToAst(n.item) }
    case 'compare':
      return n.expr
    case 'call':
      return n.expr
    case 'lambda':
      return n.expr
    case 'bool':
      return n.expr
    case 'literal':
      return n.expr
    default: {
      const _exhaustive: never = n
      return _exhaustive
    }
  }
}

function replaceNode(root: UiNode, path: number[], next: UiNode): UiNode {
  if (path.length === 0) return next
  const [idx, ...rest] = path
  if (root.kind === 'group') {
    return {
      ...root,
      items: root.items.map((c, i) => (i === idx ? replaceNode(c, rest, next) : c)),
    }
  }
  if (root.kind === 'not') {
    if (idx !== 0) return root
    return { ...root, item: replaceNode(root.item, rest, next) }
  }
  return root
}

function deleteNode(root: UiNode, path: number[]): UiNode {
  if (path.length === 0) return root
  const [idx, ...rest] = path
  if (root.kind === 'group') {
    if (rest.length === 0) {
      return { ...root, items: root.items.filter((_, i) => i !== idx) }
    }
    return {
      ...root,
      items: root.items.map((c, i) => (i === idx ? deleteNode(c, rest) : c)),
    }
  }
  if (root.kind === 'not') {
    return { ...root, item: deleteNode(root.item, rest) }
  }
  return root
}

export function FilterQueryBuilder(props: {
  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
  indexName: string
  value: string
  onChange: (next: string) => void
  language: Language
}) {
  const t = (key: keyof typeof translations.ja): string => String(translations[props.language][key] ?? '')

  const [mode, setMode] = useState<'builder' | 'raw'>('builder')
  const [schemaFields, setSchemaFields] = useState<FieldInfo[]>([])
  const [schemaError, setSchemaError] = useState<string | null>(null)
  const [schemaLoading, setSchemaLoading] = useState(false)

  const lastValueRef = useRef<string>('')

  const parsed = useMemo(() => parseODataFilter(props.value), [props.value])
  const [uiRoot, setUiRoot] = useState<UiNode>(() => ({ kind: 'group', op: 'and', items: [] }))

  // Load index schema
  useEffect(() => {
    if (!props.profile || !props.indexName.trim() || !props.apiVersion) {
      setSchemaFields([])
      setSchemaError(null)
      return
    }

    const profile = props.profile

    let cancelled = false
    setSchemaLoading(true)
    setSchemaError(null)

    ;(async () => {
      try {
        const res = await getIndexDefinition({
          profile,
          indexName: props.indexName.trim(),
          apiVersion: props.apiVersion,
          language: props.language,
        })
        if (cancelled) return

        if (!res.ok) {
          setSchemaFields([])
          setSchemaError(res.error.message)
          return
        }

        const fields = getIndexFieldsFromResponse(res.response)
        setSchemaFields(flattenFields(fields))
      } catch (e) {
        if (cancelled) return
        setSchemaFields([])
        setSchemaError(String(e))
      } finally {
        if (!cancelled) setSchemaLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [props.profile, props.indexName, props.apiVersion, props.language])

  // Keep UI tree in sync when value changes (e.g., run restore)
  useEffect(() => {
    if (lastValueRef.current === props.value) return
    lastValueRef.current = props.value

    const r = parseODataFilter(props.value)
    if (r.ok) {
      setUiRoot(astToUi(r.expr))
      if (mode === 'builder') {
        // ok
      }
    } else {
      // If raw is invalid, prefer raw mode.
      setMode('raw')
    }
  }, [props.value, mode])

  const filterableFieldPaths = useMemo(() => {
    const fields = schemaFields.filter((f) => f.filterable)
    return fields.sort((a, b) => a.path.localeCompare(b.path))
  }, [schemaFields])

  const collectionFieldPaths = useMemo(() => {
    return schemaFields
      .filter((f) => f.isCollection)
      .sort((a, b) => a.path.localeCompare(b.path))
  }, [schemaFields])

  const ast = useMemo(() => uiToAst(uiRoot), [uiRoot])
  const rawFromAst = useMemo(() => {
    const serialized = serializeODataFilter(ast)
    // If the result is a boolean literal "true" or "false", return empty string instead
    if (serialized === 'true' || serialized === 'false') return ''
    return serialized
  }, [ast])
  const warnings = useMemo(() => lintODataFilter(ast, props.language), [ast, props.language])

  const applyUi = (nextRoot: UiNode) => {
    setUiRoot(nextRoot)
    const nextAst = uiToAst(nextRoot)
    const nextRaw = serializeODataFilter(nextAst)
    lastValueRef.current = nextRaw
    props.onChange(nextRaw)
  }

  const canSwitchToBuilder = parsed.ok

  const renderValueEditor = (
    value: ODataFilterExpr,
    onChange: (next: ODataFilterExpr) => void,
    opts: { suggestPaths?: string[]; defaultType?: string } = {},
  ) => {
    const suggestPaths = opts.suggestPaths ?? filterableFieldPaths.map((f) => f.path)

    const kind = value.kind
    const setKind = (k: string) => {
      if (k === 'path') onChange(makePath(suggestPaths[0] ?? ''))
      else if (k === 'string') onChange(makeStringLiteral(''))
      else if (k === 'number') onChange({ kind: 'numberLiteral', value: '0' })
      else if (k === 'datetime') onChange({ kind: 'dateTimeLiteral', value: '2010-01-01T00:00:00Z' })
      else if (k === 'null') onChange({ kind: 'nullLiteral' })
      else if (k === 'geography') onChange({ kind: 'geographyLiteral', value: "geography'POINT(0 0)'" })
      else if (k === 'geo.distance') {
        onChange({
          kind: 'call',
          name: 'geo.distance',
          args: [makePath(suggestPaths[0] ?? 'Location'), { kind: 'geographyLiteral', value: "geography'POINT(0 0)'" }],
        })
      }
    }

    const currentKind =
      kind === 'path'
        ? 'path'
        : kind === 'stringLiteral'
          ? 'string'
          : kind === 'numberLiteral'
            ? 'number'
            : kind === 'dateTimeLiteral'
              ? 'datetime'
              : kind === 'nullLiteral'
                ? 'null'
                : kind === 'geographyLiteral'
                  ? 'geography'
                  : kind === 'call' && value.name === 'geo.distance'
                    ? 'geo.distance'
                    : 'path'

    return (
      <div className="fqb__valueRow">
        <select
          className="field__input"
          value={currentKind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="path">field</option>
          <option value="string">string</option>
          <option value="number">number</option>
          <option value="datetime">datetime</option>
          <option value="null">null</option>
          <option value="geography">geography</option>
          <option value="geo.distance">geo.distance</option>
        </select>

        {currentKind === 'path' && isPathExpr(value) && (
          <select
            className="field__input"
            value={value.value}
            onChange={(e) => onChange(makePath(e.target.value))}
          >
            {suggestPaths.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}

        {currentKind === 'string' && value.kind === 'stringLiteral' && (
          <input className="field__input" value={value.value} onChange={(e) => onChange(makeStringLiteral(e.target.value))} />
        )}

        {currentKind === 'number' && value.kind === 'numberLiteral' && (
          <input className="field__input" value={value.value} onChange={(e) => onChange({ kind: 'numberLiteral', value: e.target.value })} />
        )}

        {currentKind === 'datetime' && value.kind === 'dateTimeLiteral' && (
          <input
            className="field__input"
            value={value.value}
            onChange={(e) => onChange({ kind: 'dateTimeLiteral', value: e.target.value })}
            placeholder="2010-01-01T00:00:00Z"
          />
        )}

        {currentKind === 'null' && value.kind === 'nullLiteral' && (
          <input className="field__input" value="null" disabled />
        )}

        {currentKind === 'geography' && value.kind === 'geographyLiteral' && (
          <input
            className="field__input"
            value={value.value}
            onChange={(e) => onChange({ kind: 'geographyLiteral', value: e.target.value })}
            placeholder="geography'POINT(lon lat)'"
          />
        )}

        {currentKind === 'geo.distance' && isCallExpr(value) && value.name === 'geo.distance' && (
          <div className="fqb__grid2">
            <select
              className="field__input"
              value={value.args[0] && isPathExpr(value.args[0]) ? value.args[0].value : suggestPaths[0] ?? 'Location'}
              onChange={(e) => {
                const nextArgs = [...value.args]
                nextArgs[0] = makePath(e.target.value)
                onChange({ ...value, args: nextArgs })
              }}
            >
              {suggestPaths.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <input
              className="field__input"
              value={value.args[1]?.kind === 'geographyLiteral' ? value.args[1].value : "geography'POINT(0 0)'"}
              onChange={(e) => {
                const nextArgs = [...value.args]
                nextArgs[1] = { kind: 'geographyLiteral', value: e.target.value }
                onChange({ ...value, args: nextArgs })
              }}
              placeholder="geography'POINT(lon lat)'"
            />
          </div>
        )}
      </div>
    )
  }

  const renderLambdaPredicateEditor = (
    expr: ODataFilterExpr,
    onChange: (next: ODataFilterExpr) => void,
    lambdaVar: string,
    elementPaths: string[],
  ) => {
    // For lambda predicates, we render a simplified editor
    // Support: compare, and, or
    
    if (expr.kind === 'compare') {
      const leftPath = expr.left.kind === 'path' ? expr.left.value : (elementPaths.length > 0 ? elementPaths[0] : lambdaVar)
      const update = (patch: Partial<typeof expr>) => onChange({ ...expr, ...patch })
      
      return (
        <div className="fqb__lambdaCompareRow">
          <select 
            className="field__input" 
            value={leftPath}
            onChange={(e) => update({ left: makePath(e.target.value) })}
          >
            {elementPaths.length === 0 && <option value={lambdaVar}>{lambdaVar}</option>}
            {elementPaths.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          
          <select
            className="field__input"
            value={expr.op}
            onChange={(e) => {
              const v = e.target.value
              if (isCompareOp(v)) update({ op: v })
            }}
          >
            <option value="eq">eq</option>
            <option value="ne">ne</option>
            <option value="gt">gt</option>
            <option value="ge">ge</option>
            <option value="lt">lt</option>
            <option value="le">le</option>
          </select>
          
          {renderValueEditor(expr.right, (next) => update({ right: next }), { suggestPaths: elementPaths })}
        </div>
      )
    }
    
    if (expr.kind === 'and' || expr.kind === 'or') {
      const items = assocFlatten(expr.kind, expr)
      const updateItem = (index: number, next: ODataFilterExpr) => {
        const newItems = [...items]
        newItems[index] = next
        onChange(assocFold(expr.kind, newItems))
      }
      const addItem = () => {
        const newItems = [...items, { 
          kind: 'compare' as const, 
          op: 'eq' as const, 
          left: makePath(elementPaths.length > 0 ? elementPaths[0] : lambdaVar),
          right: makeStringLiteral('')
        }]
        onChange(assocFold(expr.kind, newItems))
      }
      const removeItem = (index: number) => {
        const newItems = items.filter((_, i) => i !== index)
        if (newItems.length === 0) {
          onChange({ kind: 'boolLiteral', value: true })
        } else {
          onChange(assocFold(expr.kind, newItems))
        }
      }
      
      return (
        <div>
          <div className="fqb__title">
            {expr.kind === 'and' ? 'AND' : 'OR'} {t('fqbGroup')}:
          </div>
          {items.map((item, i) => (
            <div key={i} className="fqb__lambdaGroupItem">
              <div className="fqb__flex1">
                {renderLambdaPredicateEditor(item, (next) => updateItem(i, next), lambdaVar, elementPaths)}
              </div>
              <button type="button" className="btn btn--danger" onClick={() => removeItem(i)}>×</button>
            </div>
          ))}
          <button type="button" className="btn btn--mt4" onClick={addItem}>
            {t('fqbLambdaAddCondition')}
          </button>
        </div>
      )
    }
    
    // Fallback: show raw text editor
    const text = serializeODataFilter(expr)
    return (
      <textarea
        className="field__input"
        value={text}
        onChange={(e) => {
          const parsed = parseODataFilter(e.target.value)
          if (parsed.ok) onChange(parsed.expr)
        }}
        rows={3}
        placeholder={`${lambdaVar}/field eq 'value'`}
      />
    )
  }

  const renderNode = (node: UiNode, path: number[]) => {
    const key = path.join('.') || 'root'


    const remove = () => {
      applyUi(deleteNode(uiRoot, path))
    }

    const addChildToGroup = (groupPath: number[], kind: 'compare' | 'lambda' | 'call' | 'bool' | 'group') => {
      const buildDefault = (): UiNode => {
        if (kind === 'compare') {
          const left = makePath(filterableFieldPaths[0]?.path ?? 'Category')
          const right = makeStringLiteral('')
          return { kind: 'compare', expr: { kind: 'compare', op: 'eq', left, right } }
        }
        if (kind === 'lambda') {
          const collection = collectionFieldPaths[0]?.path ?? 'Rooms'
          const selectedCol = collectionFieldPaths.find((f) => f.path === collection) ?? null
          const lambdaVar = 'x'
          const elementPaths: string[] = []
          const hasComplexElements = selectedCol?.elementFields && Array.isArray(selectedCol.elementFields) && selectedCol.elementFields.length > 0
          if (hasComplexElements) {
            const flattened = flattenFields(selectedCol.elementFields!, lambdaVar)
            elementPaths.push(...flattened.map((x) => x.path))
          }
          // For simple collections (Collection(Edm.String), etc.), use just the variable name
          // For complex collections, use var/fieldName
          const defaultField = elementPaths.length > 0 ? elementPaths[0] : lambdaVar
          return { 
            kind: 'lambda', 
            expr: { 
              kind: 'lambda', 
              collection, 
              op: 'any', 
              varName: lambdaVar, 
              expr: { 
                kind: 'compare', 
                op: 'eq', 
                left: { kind: 'path', value: defaultField },
                right: { kind: 'stringLiteral', value: '' }
              } 
            } 
          }
        }
        if (kind === 'call') {
          return { kind: 'call', expr: { kind: 'call', name: 'search.in', args: [makePath(filterableFieldPaths[0]?.path ?? 'HotelName'), makeStringLiteral('a,b'), makeStringLiteral(',')] } }
        }
        if (kind === 'bool') {
          return { kind: 'bool', expr: makePath(filterableFieldPaths[0]?.path ?? 'IsEnabled') }
        }
        return { kind: 'group', op: 'and', items: [] }
      }

      const insert = (r: UiNode, p: number[]): UiNode => {
        if (p.length === 0) {
          if (r.kind !== 'group') return r
          return { ...r, items: [...r.items, buildDefault()] }
        }
        const [i, ...rest] = p
        if (r.kind === 'group') {
          return { ...r, items: r.items.map((c, idx) => (idx === i ? insert(c, rest) : c)) }
        }
        if (r.kind === 'not') {
          return { ...r, item: insert(r.item, rest) }
        }
        return r
      }

      applyUi(insert(uiRoot, groupPath))
    }

    const renderNotWrapper = (inner: UiNode, innerPath: number[]) => {
      return (
        <div className="fqb__row-not">
          <label className="fqb__checkLabel">
            <input
              type="checkbox"
              checked={node.kind === 'not'}
              onChange={(e) => {
                if (e.target.checked) {
                  applyUi(replaceNode(uiRoot, innerPath, { kind: 'not', item: inner }))
                } else {
                  // unwrap
                  applyUi(replaceNode(uiRoot, innerPath, inner))
                }
              }}
            />
            <span className="fqb__muted">{t('fqbNot')}</span>
          </label>
          <div />
          {innerPath.length > 0 && (
            <button type="button" className="btn btn--danger" onClick={remove} title={t('delete')}>
              ×
            </button>
          )}
        </div>
      )
    }

    if (node.kind === 'not') {
      return (
        <div key={key} className="fqb__card">
          {renderNotWrapper(node.item, path)}
          <div className="fqb__block">{renderNode(node.item, [...path, 0])}</div>
        </div>
      )
    }

    if (node.kind === 'group') {
      return (
        <div key={key} className="fqb__card">
          <div className="fqb__row-group">
            <select
              className="field__input"
              value={node.op}
              onChange={(e) => {
                const nextOp: 'and' | 'or' = e.target.value === 'or' ? 'or' : 'and'
                applyUi(replaceNode(uiRoot, path, { ...node, op: nextOp }))
              }}
            >
              <option value="and">and</option>
              <option value="or">or</option>
            </select>
            <div className="fqb__muted">{t('fqbGroup')}</div>
            {path.length > 0 && (
              <button type="button" className="btn btn--danger" onClick={remove} title={t('delete')}>
                ×
              </button>
            )}
          </div>

          <div className="fqb__stack">
            {node.items.length === 0 ? (
              <div className="fqb__muted">{t('fqbEmpty')}</div>
            ) : (
              node.items.map((c, i) => renderNode(c, [...path, i]))
            )}
          </div>

          <div className="fqb__actions">
            <button type="button" className="btn" onClick={() => addChildToGroup(path, 'compare')}>
              {t('fqbAddCondition')}: {t('fqbComparison')}
            </button>
            <button type="button" className="btn" onClick={() => addChildToGroup(path, 'lambda')}>
              {t('fqbAddCondition')}: {t('fqbLambda')}
            </button>
            <button type="button" className="btn" onClick={() => addChildToGroup(path, 'call')}>
              {t('fqbAddCondition')}: {t('fqbFunction')}
            </button>
            <button type="button" className="btn" onClick={() => addChildToGroup(path, 'bool')}>
              {t('fqbAddCondition')}: {t('fqbBoolField')}
            </button>
            <button type="button" className="btn" onClick={() => addChildToGroup(path, 'group')}>
              {t('fqbAddCondition')}: {t('fqbGroup')}
            </button>
          </div>
        </div>
      )
    }

    if (node.kind === 'compare') {
      const e = node.expr
      const left = e.left
      const right = e.right

      const update = (patch: Partial<typeof e>) => {
        applyUi(replaceNode(uiRoot, path, { ...node, expr: { ...e, ...patch } }))
      }

      const leftSuggest = filterableFieldPaths.map((f) => f.path)

      return (
        <div key={key} className="fqb__card">
          <div className="fqb__row-compare">
            {renderValueEditor(left, (next) => update({ left: next }), { suggestPaths: leftSuggest })}
            <select
              className="field__input"
              value={e.op}
              onChange={(ev) => {
                const v = ev.target.value
                const nextOp = (v === 'ne' || v === 'gt' || v === 'ge' || v === 'lt' || v === 'le') ? (v as typeof e.op) : 'eq'
                update({ op: nextOp })
              }}
            >
              <option value="eq">eq</option>
              <option value="ne">ne</option>
              <option value="gt">gt</option>
              <option value="ge">ge</option>
              <option value="lt">lt</option>
              <option value="le">le</option>
            </select>
            {renderValueEditor(right, (next) => update({ right: next }))}
            <button type="button" className="btn btn--danger" onClick={remove} title={t('delete')}>
              ×
            </button>
          </div>
        </div>
      )
    }

    if (node.kind === 'bool') {
      const update = (nextPath: string) => {
        applyUi(replaceNode(uiRoot, path, { kind: 'bool', expr: makePath(nextPath) }))
      }

      const suggestions = filterableFieldPaths
        .filter((f) => f.type === 'Edm.Boolean' || f.path.toLowerCase().includes('is') || f.path.toLowerCase().includes('has'))
        .map((f) => f.path)

      const all = filterableFieldPaths.map((f) => f.path)
      const options = suggestions.length ? suggestions : all

      return (
        <div key={key} className="fqb__card">
          <div className="fqb__row-bool">
            <select className="field__input" value={node.expr.value} onChange={(e) => update(e.target.value)}>
              {options.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn--danger" onClick={remove} title={t('delete')}>
              ×
            </button>
          </div>
        </div>
      )
    }

    if (node.kind === 'lambda') {
      const e = node.expr
      const selectedCollection = collectionFieldPaths.find((f) => f.path === e.collection) ?? null

      const update = (patch: Partial<typeof e>) => {
        applyUi(replaceNode(uiRoot, path, { ...node, expr: { ...e, ...patch } }))
      }

      const empty = !e.varName || !e.expr

      // Suggest element field paths as <var>/<field>
      const lambdaVar = e.varName || 'x'
      const elementPaths: string[] = []
      if (selectedCollection?.elementFields && Array.isArray(selectedCollection.elementFields)) {
        const flattened = flattenFields(selectedCollection.elementFields, lambdaVar)
        elementPaths.push(...flattened.map((x) => x.path))
      }

      return (
        <div key={key} className="fqb__card--accent">
          <div className="fqb__lambdaTop">
            <select className="field__input" value={e.collection} onChange={(ev) => update({ collection: ev.target.value })}>
              {collectionFieldPaths.length === 0 && <option value="">{t('fqbNoCollectionsAvailable')}</option>}
              {collectionFieldPaths.map((f) => (
                <option key={f.path} value={f.path}>
                  {f.path}
                </option>
              ))}
            </select>
            <select
              className="field__input"
              value={e.op}
              onChange={(ev) => update({ op: ev.target.value === 'all' ? 'all' : 'any' })}
            >
              <option value="any">any</option>
              <option value="all">all</option>
            </select>
            <input
              className="field__input mono"
              value={e.varName ?? ''}
              onChange={(ev) => update({ varName: ev.target.value })}
              placeholder={t('fqbPlaceholderVar')}
            />
            <button type="button" className="btn btn--danger" onClick={remove} title={t('delete')}>
              ×
            </button>
          </div>

          <label className="fqb__lambdaEmptyLabel">
            <input
              type="checkbox"
              checked={empty}
              onChange={(ev) => {
                if (ev.target.checked) {
                  update({ varName: undefined, expr: undefined })
                } else {
                  // Initialize with a simple comparison
                  // For simple collections, use just the variable name; for complex, use var/fieldName
                  const defaultField = elementPaths.length > 0 ? elementPaths[0] : lambdaVar
                  update({ 
                    varName: e.varName || lambdaVar, 
                    expr: { 
                      kind: 'compare', 
                      op: 'eq', 
                      left: { kind: 'path', value: defaultField },
                      right: { kind: 'stringLiteral', value: '' }
                    } 
                  })
                }
              }}
            />
            {t('fqbEmptyLambda')}
          </label>

          {!empty && e.expr && (
            <div className="fqb__panel">
              <div className="fqb__title">
                {t('fqbPredicateTitle')}
              </div>
              {renderLambdaPredicateEditor(e.expr, (nextExpr) => update({ expr: nextExpr }), lambdaVar, elementPaths)}
            </div>
          )}
        </div>
      )
    }

    if (node.kind === 'call') {
      const e = node.expr

      const update = (patch: Partial<typeof e>) => {
        applyUi(replaceNode(uiRoot, path, { ...node, expr: { ...e, ...patch } }))
      }

      const name = e.name
      if (name === 'search.in') {
        const field = (e.args[0] && isPathExpr(e.args[0])) ? e.args[0].value : filterableFieldPaths[0]?.path ?? 'HotelName'
        const list = e.args[1]?.kind === 'stringLiteral' ? e.args[1].value : ''
        const delim = e.args[2]?.kind === 'stringLiteral' ? e.args[2].value : ','

        return (
          <div key={key} className="fqb__card">
            <div className="fqb__row-call">
              <div className="fqb__muted">search.in</div>
              <select
                className="field__input"
                value={field}
                onChange={(ev) => update({ args: [makePath(ev.target.value), makeStringLiteral(list), makeStringLiteral(delim)] })}
              >
                {filterableFieldPaths.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path}
                  </option>
                ))}
              </select>
              <input
                className="field__input"
                value={delim}
                onChange={(ev) => update({ args: [makePath(field), makeStringLiteral(list), makeStringLiteral(ev.target.value)] })}
                placeholder=","
              />
              <button type="button" className="btn btn--danger" onClick={remove} title={t('delete')}>
                ×
              </button>
            </div>
            <div className="fqb__block">
              <SearchInListEditor
                list={list}
                delim={delim}
                onChangeList={(nextList) => update({ args: [makePath(field), makeStringLiteral(nextList), makeStringLiteral(delim)] })}
                placeholder={t('fqbListValuePlaceholder')}
                emptyText={t('fqbEmpty')}
                removeTitle={t('remove')}
              />
            </div>
          </div>
        )
      }

      if (name === 'geo.intersects') {
        const loc = (e.args[0] && isPathExpr(e.args[0])) ? e.args[0].value : 'Location'
        const poly = e.args[1]?.kind === 'geographyLiteral' ? e.args[1].value : "geography'POLYGON((0 0, 0 1, 1 1, 0 0))'"
        return (
          <div key={key} className="fqb__card">
            <div className="fqb__row-call2">
              <div className="fqb__muted">geo.intersects</div>
              <select
                className="field__input"
                value={loc}
                onChange={(ev) => update({ args: [makePath(ev.target.value), { kind: 'geographyLiteral', value: poly }] })}
              >
                {filterableFieldPaths.map((f) => (
                  <option key={f.path} value={f.path}>
                    {f.path}
                  </option>
                ))}
              </select>
              <button type="button" className="btn btn--danger" onClick={remove} title={t('delete')}>
                ×
              </button>
            </div>
            <div className="fqb__block">
              <textarea
                className="field__input"
                value={poly}
                onChange={(ev) => update({ args: [makePath(loc), { kind: 'geographyLiteral', value: ev.target.value }] })}
                placeholder="geography'POLYGON((lon lat, ...))'"
                rows={3}
              />
            </div>
          </div>
        )
      }

      if (name === 'search.ismatch' || name === 'search.ismatchscoring') {
        const query = e.args[0]?.kind === 'stringLiteral' ? e.args[0].value : ''
        const fields = e.args[1]?.kind === 'stringLiteral' ? e.args[1].value : ''
        const queryType = e.args[2]?.kind === 'stringLiteral' ? e.args[2].value : ''
        const mode = e.args[3]?.kind === 'stringLiteral' ? e.args[3].value : ''

        const nextArgs = (q: string, f: string, qt: string, sm: string) => {
          const args: ODataFilterExpr[] = [makeStringLiteral(q)]
          if (f) args.push(makeStringLiteral(f))
          if (qt) {
            while (args.length < 3) args.push(makeStringLiteral(''))
            args[2] = makeStringLiteral(qt)
          }
          if (sm) {
            while (args.length < 4) args.push(makeStringLiteral(''))
            args[3] = makeStringLiteral(sm)
          }
          return args
        }

        return (
          <div key={key} className="fqb__card">
            <div className="fqb__row-call2">
              <div className="fqb__muted">{name}</div>
              <input
                className="field__input"
                value={query}
                onChange={(ev) => update({ args: nextArgs(ev.target.value, fields, queryType, mode) })}
                placeholder={t('fqbPlaceholderQuery')}
              />
              <button type="button" className="btn btn--danger" onClick={remove} title={t('delete')}>
                ×
              </button>
            </div>
            <div className="fqb__block fqb__grid2">
              <input
                className="field__input"
                value={fields}
                onChange={(ev) => update({ args: nextArgs(query, ev.target.value, queryType, mode) })}
                placeholder={t('fqbPlaceholderFieldsOptional')}
              />
              <input
                className="field__input"
                value={queryType}
                onChange={(ev) => update({ args: nextArgs(query, fields, ev.target.value, mode) })}
                placeholder={t('fqbPlaceholderQueryTypeOptional')}
              />
              <input
                className="field__input"
                value={mode}
                onChange={(ev) => update({ args: nextArgs(query, fields, queryType, ev.target.value) })}
                placeholder={t('fqbPlaceholderSearchModeOptional')}
              />
            </div>
          </div>
        )
      }

      // Generic call
      return (
        <div key={key} className="fqb__card">
          <div className="fqb__row-bool">
            <input className="field__input" value={e.name} onChange={(ev) => update({ name: ev.target.value })} />
            <button type="button" className="btn btn--danger" onClick={remove} title={t('delete')}>
              ×
            </button>
          </div>
          <div className="fqb__muted fqb__block">
            {t('fqbGenericCallArgsEditInRaw')}
          </div>
        </div>
      )
    }

    if (node.kind === 'literal') {
      return (
        <div key={key} className="fqb__card">
          <div className="fqb__row-bool">
            <input className="field__input" value={serializeODataFilter(node.expr)} disabled />
            <button type="button" className="btn btn--danger" onClick={remove} title={t('delete')}>
              ×
            </button>
          </div>
        </div>
      )
    }

    return null
  }

  return (
    <div className="fqb">
      <div className="fqb__top">
        <button
          type="button"
          className={`btn btn--tab ${mode === 'builder' ? 'btn--active' : ''}`}
          onClick={() => {
            if (!canSwitchToBuilder) {
              setMode('raw')
              return
            }
            setMode('builder')
          }}
          disabled={!canSwitchToBuilder}
          title={!canSwitchToBuilder ? t('fqbCannotSwitchToBuilderTitle') : ''}
        >
          {t('fqbModeBuilder')}
        </button>
        <button
          type="button"
          className={`btn btn--tab ${mode === 'raw' ? 'btn--active' : ''}`}
          onClick={() => setMode('raw')}
        >
          {t('fqbModeRaw')}
        </button>

        <div className="fqb__status">
          {schemaLoading ? t('fqbLoadingSchema') : schemaError ? `${t('fqbSchemaError')}: ${schemaError}` : ''}
        </div>
      </div>

      {mode === 'raw' && (
        <div className="fqb__raw">
          <textarea
            className="field__input"
            value={props.value}
            onChange={(e) => {
              lastValueRef.current = e.target.value
              props.onChange(e.target.value)
            }}
            placeholder={t('fqbRawFilterPlaceholderExample')}
            rows={4}
          />
          {!parsed.ok && (
            <div className="notice notice--error">
              {t('fqbParseError')}: {parsed.error}
            </div>
          )}
        </div>
      )}

      {mode === 'builder' && (
        <div className="fqb__builder">
          {renderNode(uiRoot, [])}

          <div className="fqb__status">
            {t('fqbRawPreviewLabel')} <span className="mono">{rawFromAst}</span>
          </div>

          {warnings.length > 0 && (
            <div className="notice notice--warning">
              <div className="notice__title">{t('fqbWarnings')}</div>
              <ul className="notice__list">
                {warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
