import { serializeODataFilter, type ODataFilterExpr } from '../lib/odataFilter'

export type FacetFieldInfo = {
  path: string
  type: string
  collectionPath: string | null
  collectionItemPath: string | null
}

function facetLiteralExpression(value: unknown): ODataFilterExpr {
  if (value === null) return { kind: 'nullLiteral' }
  if (typeof value === 'boolean') return { kind: 'boolLiteral', value }
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'numberLiteral', value: String(value) }

  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text)) {
    return { kind: 'dateTimeLiteral', value: text }
  }

  return { kind: 'stringLiteral', value: text }
}

function combineComparisons(comparisons: ODataFilterExpr[]): ODataFilterExpr | null {
  if (comparisons.length === 0) return null
  return comparisons.slice(1).reduce<ODataFilterExpr>((left, right) => ({ kind: 'and', left, right }), comparisons[0])
}

function buildFacetPredicate(left: ODataFilterExpr, bucket: Record<string, unknown>): ODataFilterExpr | null {
  if (bucket.value !== undefined) {
    return {
      kind: 'compare',
      op: 'eq',
      left,
      right: facetLiteralExpression(bucket.value),
    }
  }

  const comparisons: ODataFilterExpr[] = []
  if (bucket.from !== undefined) {
    comparisons.push({
      kind: 'compare',
      op: 'ge',
      left,
      right: facetLiteralExpression(bucket.from),
    })
  }
  if (bucket.to !== undefined) {
    comparisons.push({
      kind: 'compare',
      op: 'lt',
      left,
      right: facetLiteralExpression(bucket.to),
    })
  }

  return combineComparisons(comparisons)
}

export function buildFacetFilterExpression(
  fieldName: string,
  bucket: Record<string, unknown>,
  fieldInfos: readonly FacetFieldInfo[] = [],
): string | null {
  const fieldInfo = fieldInfos.find((field) => field.path === fieldName)

  if (fieldInfo?.collectionPath) {
    const variableName = 'x'
    const leftPath = fieldInfo.collectionItemPath ? `${variableName}/${fieldInfo.collectionItemPath}` : variableName
    const predicate = buildFacetPredicate({ kind: 'path', value: leftPath }, bucket)
    if (!predicate) return null

    return serializeODataFilter({
      kind: 'lambda',
      collection: fieldInfo.collectionPath,
      op: 'any',
      varName: variableName,
      expr: predicate,
    })
  }

  const predicate = buildFacetPredicate({ kind: 'path', value: fieldName }, bucket)
  return predicate ? serializeODataFilter(predicate) : null
}