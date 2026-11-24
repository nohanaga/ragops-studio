import { gqlIdentifier, gqlString, type GqlVocabulary } from './gqlAssist'
import type { TranslationKey } from './translations'

export type GqlScan = {
  masked: string
  unterminated: boolean
  openChar: string
  openAt: number
}

// 文字列リテラルとバッククォート識別子の中身を同じ長さの "_" に置き換え、構文解析が中身に惑わされないようにします。
export function scanGql(text: string): GqlScan {
  const out: string[] = []
  let quote = ''
  let openAt = -1
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\' && quote !== '`' && i + 1 < text.length) {
        out.push('_', '_')
        i += 1
      } else if (ch === quote) {
        quote = ''
        out.push(ch)
      } else out.push('_')
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      openAt = i
    }
    out.push(ch)
  }
  return { masked: out.join(''), unterminated: quote !== '', openChar: quote, openAt: quote ? openAt : -1 }
}

function isBalanced(masked: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
  const stack: string[] = []
  for (const ch of masked) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch)
    else if (ch in pairs && stack.pop() !== pairs[ch]) return false
  }
  return stack.length === 0
}

function bracketDepth(masked: string): number {
  let depth = 0
  for (const ch of masked) {
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if ((ch === ')' || ch === ']' || ch === '}') && depth > 0) depth -= 1
  }
  return depth
}

export type GqlClause = {
  keyword: string
  source: string
  body: string
  maskedBody: string
}

const CLAUSE_KEYWORD = /(?:OPTIONAL\s+MATCH|MATCH|WHERE|RETURN|ORDER\s+BY|GROUP\s+BY|LIMIT|OFFSET|NEXT|FILTER|LET|FOR|UNION)(?!\w)/iy

// 括弧の外にある節キーワードで、クエリを MATCH / WHERE / RETURN などの節に分けます。
export function splitGqlClauses(text: string, scan: GqlScan = scanGql(text)): { leading: string; clauses: GqlClause[] } {
  const masked = scan.masked
  const starts: Array<{ keyword: string; start: number; bodyStart: number }> = []
  let depth = 0
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0 && /[A-Za-z]/.test(ch) && !(i > 0 && /[\w.`]/.test(masked[i - 1]))) {
      CLAUSE_KEYWORD.lastIndex = i
      const match = CLAUSE_KEYWORD.exec(masked)
      if (match) {
        starts.push({ keyword: match[0].toUpperCase().replace(/\s+/g, ' '), start: i, bodyStart: i + match[0].length })
        i += match[0].length - 1
      }
    }
  }
  const clauses = starts.map((item, index): GqlClause => {
    const end = starts[index + 1]?.start ?? text.length
    const raw = text.slice(item.bodyStart, end)
    const offset = item.bodyStart + raw.length - raw.trimStart().length
    const body = raw.trim()
    return { keyword: item.keyword, source: text.slice(item.start, end).trim(), body, maskedBody: masked.slice(offset, offset + body.length) }
  })
  return { leading: text.slice(0, starts[0]?.start ?? text.length).trim(), clauses }
}

function splitAtTopLevel(body: string, masked: string, separator: (masked: string, index: number) => number): string[] {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i]
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1)
    else if (depth === 0) {
      const length = separator(masked, i)
      if (length > 0) {
        parts.push(body.slice(from, i).trim())
        from = i + length
        i += length - 1
      }
    }
  }
  parts.push(body.slice(from).trim())
  return parts.filter(Boolean)
}

const atComma = (masked: string, index: number) => (masked[index] === ',' ? 1 : 0)
const atAnd = (masked: string, index: number) => (
  masked.slice(index, index + 3).toUpperCase() === 'AND' && !/[\w.`]/.test(masked[index - 1] ?? ' ') && !/\w/.test(masked[index + 3] ?? ' ') ? 3 : 0
)

export type GqlPatternElement = {
  kind: 'node' | 'edge'
  variable: string
  label: string
  filter: string
  raw: string
  direction: 'out' | 'in' | 'any'
}

const ELEMENT = /^\s*([A-Za-z_]\w*)?\s*(?::\s*(`[^`]*`|[A-Za-z_]\w*))?\s*(\{[\s\S]*\}|WHERE[\s\S]*)?\s*$/i
const PATTERN_TOKEN = /(<)?-(?:\[([^\]]*)\])?-(>)?|\(([^()]*)\)/g

function parseElement(kind: 'node' | 'edge', raw: string, direction: GqlPatternElement['direction']): GqlPatternElement {
  const match = ELEMENT.exec(raw)
  return {
    kind, direction, raw: raw.trim(),
    variable: match?.[1] ?? '',
    label: (match?.[2] ?? '').replace(/^`|`$/g, ''),
    filter: (match?.[3] ?? '').trim(),
  }
}

// MATCH のパターンを、ノード ( ) と関係 [ ] の並びに分解します。解釈できない記述は raw に残します。
export function parseMatchPattern(body: string, maskedBody: string): GqlPatternElement[] {
  return [...maskedBody.matchAll(PATTERN_TOKEN)].map((match) => {
    const start = match.index ?? 0
    if (match[4] !== undefined) return parseElement('node', body.slice(start + 1, start + 1 + match[4].length), 'any')
    const direction = match[1] ? 'in' : match[3] ? 'out' : 'any'
    const innerStart = start + (match[1] ? 1 : 0) + 2
    return parseElement('edge', match[2] === undefined ? '' : body.slice(innerStart, innerStart + match[2].length), direction)
  })
}

function patternVariables(text: string, scan: GqlScan): Map<string, 'node' | 'edge'> {
  const variables = new Map<string, 'node' | 'edge'>()
  const { clauses } = splitGqlClauses(text, scan)
  for (const clause of clauses.filter((item) => item.keyword.endsWith('MATCH'))) {
    for (const element of parseMatchPattern(clause.body, clause.maskedBody)) {
      if (element.variable) variables.set(element.variable, element.kind)
    }
  }
  return variables
}

export type GqlDiagnosticCode = 'unterminatedString' | 'unbalanced' | 'fullWidth' | 'badOperator' | 'missingMatch' | 'missingReturn'
  | 'unconstrained' | 'missingLimit' | 'unquotedLabel' | 'unknownNodeType' | 'unknownPredicate'
export type GqlDiagnostic = {
  severity: 'error' | 'warning' | 'info'
  code: GqlDiagnosticCode
  params: Record<string, string>
}

const FULL_WIDTH = /[\u3000（）［］｛｝＝＜＞，：；＇＂‘’“”]/gu
const AGGREGATE = /\b(?:count|sum|avg|min|max|collect)\s*\(/i
const MAX_UNKNOWN_DIAGNOSTICS = 3

function closestName(name: string, candidates: string[]): string {
  const lower = name.toLowerCase()
  return candidates.find((candidate) => candidate.toLowerCase() === lower)
    ?? candidates.find((candidate) => candidate.toLowerCase().startsWith(lower) || lower.startsWith(candidate.toLowerCase()))
    ?? ''
}

// 実行前に見つけられる、初心者がつまずきやすい書き方を検出します。Azure の検証の代わりにはなりません。
export function analyzeGql(text: string, vocabulary: GqlVocabulary): GqlDiagnostic[] {
  if (!text.trim()) return []
  const scan = scanGql(text)
  const masked = scan.masked
  const diagnostics: GqlDiagnostic[] = []
  const push = (severity: GqlDiagnostic['severity'], code: GqlDiagnosticCode, params: Record<string, string> = {}) =>
    diagnostics.push({ severity, code, params })
  if (scan.unterminated) push('error', 'unterminatedString')
  else if (!isBalanced(masked)) push('error', 'unbalanced')
  const fullWidth = [...new Set(masked.match(FULL_WIDTH) ?? [])]
  if (fullWidth.length) push('warning', 'fullWidth', { chars: fullWidth.map((ch) => (ch === '\u3000' ? 'U+3000' : ch)).join(' ') })
  const operator = /==|!=/.exec(masked)?.[0]
  if (operator) push('warning', 'badOperator', { op: operator })

  const { leading, clauses } = splitGqlClauses(text, scan)
  const matches = clauses.filter((clause) => clause.keyword.endsWith('MATCH'))
  if (leading || !clauses[0]?.keyword.endsWith('MATCH')) push('warning', 'missingMatch')
  const hasReturn = clauses.some((clause) => clause.keyword === 'RETURN')
  if (!hasReturn) push('warning', 'missingReturn')
  if (matches.length && !/\bWHERE\b/i.test(masked) && !matches.some((clause) => /[:{]/.test(clause.maskedBody))) push('warning', 'unconstrained')
  if (hasReturn && !clauses.some((clause) => clause.keyword === 'LIMIT') && !AGGREGATE.test(masked)) push('info', 'missingLimit')

  for (const match of masked.matchAll(/[([]\s*(?:[A-Za-z_]\w*)?\s*:\s*([^\s`)\]{},|]+)/g)) {
    if (/[^A-Za-z0-9_]/.test(match[1])) push('warning', 'unquotedLabel', { label: match[1] })
  }
  if (vocabulary.loaded) {
    const predicateNames = vocabulary.predicates.map((item) => item.name)
    // trailing は、一致範囲の末尾にある、ラベル本体に含まれない文字数 (閉じる引用符) です。
    const lookups: Array<{ pattern: RegExp; code: 'unknownNodeType' | 'unknownPredicate'; names: string[]; trailing: number }> = [
      { pattern: /\(\s*(?:[A-Za-z_]\w*)?\s*:\s*(`[^`]*`|[A-Za-z_]\w*)/g, code: 'unknownNodeType', names: vocabulary.nodeTypes.map((item) => item.name), trailing: 0 },
      { pattern: /\[\s*(?:[A-Za-z_]\w*)?\s*:\s*(`[^`]*`|[A-Za-z_]\w*)/g, code: 'unknownPredicate', names: predicateNames, trailing: 0 },
      { pattern: /\.\s*predicate\s*=\s*['"](_+)['"]/gi, code: 'unknownPredicate', names: predicateNames, trailing: 1 },
    ]
    const reported = new Set<string>()
    for (const { pattern, code, names, trailing } of lookups) {
      for (const match of masked.matchAll(pattern)) {
        const end = (match.index ?? 0) + match[0].length - trailing
        const name = text.slice(end - match[1].length, end).replace(/^`|`$/g, '')
        const key = `${code}:${name}`
        if (!name || names.includes(name) || reported.has(key) || reported.size >= MAX_UNKNOWN_DIAGNOSTICS) continue
        reported.add(key)
        push('info', code, { name, suggestion: closestName(name, names) })
      }
    }
  }
  const rank = { error: 0, warning: 1, info: 2 }
  return diagnostics.sort((a, b) => rank[a.severity] - rank[b.severity])
}

export type GqlExplainCode = 'matchNode' | 'matchNodeAny' | 'matchEdge' | 'matchEdgeAny' | 'matchFilter' | 'wherePredicate' | 'whereName'
  | 'whereCompare' | 'returnColumn' | 'returnColumnPlain' | 'returnAggregate' | 'returnDistinct' | 'orderAsc' | 'orderDesc'
  | 'groupBy' | 'limit' | 'offset' | 'other'
export type GqlExplainItem = { code: GqlExplainCode; params: Record<string, string> }
export type GqlExplainClause = {
  keyword: string
  source: string
  pattern: GqlPatternElement[]
  items: GqlExplainItem[]
}
export type GqlExplanation = { leading: string; clauses: GqlExplainClause[] }

const ASSIGNMENT = /^([A-Za-z_]\w*)\.(predicate|name)\s*=\s*('[^']*'|"[^"]*")$/i

function explainClause(clause: GqlClause): GqlExplainClause {
  const { keyword, body, maskedBody } = clause
  const items: GqlExplainItem[] = []
  const item = (code: GqlExplainCode, params: Record<string, string> = {}) => items.push({ code, params })
  let pattern: GqlPatternElement[] = []
  if (keyword.endsWith('MATCH')) {
    pattern = parseMatchPattern(body, maskedBody)
    for (const element of pattern) {
      const params = { variable: element.variable, label: element.label }
      if (element.kind === 'node') item(element.label ? 'matchNode' : 'matchNodeAny', params)
      else item(element.label ? 'matchEdge' : 'matchEdgeAny', params)
      if (element.filter) item('matchFilter', { variable: element.variable, filter: element.filter })
    }
  } else if (keyword === 'WHERE') {
    for (const condition of splitAtTopLevel(body, maskedBody, atAnd)) {
      const match = ASSIGNMENT.exec(condition.replace(/^\(\s*|\s*\)$/g, ''))
      if (match) item(match[2].toLowerCase() === 'predicate' ? 'wherePredicate' : 'whereName', { variable: match[1], value: match[3] })
      else item('whereCompare', { text: condition })
    }
  } else if (keyword === 'RETURN') {
    const distinct = /^DISTINCT\s+/i.exec(body)
    if (distinct) item('returnDistinct')
    const offset = distinct?.[0].length ?? 0
    for (const column of splitAtTopLevel(body.slice(offset), maskedBody.slice(offset), atComma)) {
      const alias = /\s+AS\s+(\S+)$/i.exec(column)
      const expression = alias ? column.slice(0, alias.index).trim() : column
      const params = { expr: expression, alias: alias?.[1].replace(/^`|`$/g, '') ?? '' }
      if (AGGREGATE.test(expression)) item('returnAggregate', params)
      else item(alias ? 'returnColumn' : 'returnColumnPlain', params)
    }
  } else if (keyword === 'ORDER BY') {
    for (const sort of splitAtTopLevel(body, maskedBody, atComma)) {
      const direction = /\s+(ASC|DESC)$/i.exec(sort)
      item(direction?.[1].toUpperCase() === 'DESC' ? 'orderDesc' : 'orderAsc', { expr: direction ? sort.slice(0, direction.index).trim() : sort })
    }
  } else if (keyword === 'GROUP BY') item('groupBy', { exprs: body })
  else if ((keyword === 'LIMIT' || keyword === 'OFFSET') && /^\d+$/.test(body)) item(keyword === 'LIMIT' ? 'limit' : 'offset', { n: body })
  else item('other', { keyword })
  return { keyword, source: clause.source, pattern, items }
}

// クエリを節ごとに分け、平易な文章で意味を説明するための材料を返します。
export function explainGql(text: string): GqlExplanation {
  const { leading, clauses } = splitGqlClauses(text)
  return { leading, clauses: clauses.map(explainClause) }
}

export type GqlCompletionKind = 'keyword' | 'nodeType' | 'predicate' | 'name' | 'property' | 'variable' | 'function'
export type GqlCompletion = { label: string; insertText: string; kind: GqlCompletionKind; hintKey?: TranslationKey; count?: number }
export type GqlCompletionResult = { from: number; to: number; items: GqlCompletion[] }

const KEYWORDS = ['MATCH', 'WHERE', 'RETURN', 'ORDER BY', 'GROUP BY', 'LIMIT', 'OFFSET', 'AND', 'AS', 'DESC', 'ASC', 'DISTINCT']
const KEYWORD_HINTS: Partial<Record<string, TranslationKey>> = {
  MATCH: 'kgGqlClauseMatch', WHERE: 'kgGqlClauseWhere', RETURN: 'kgGqlClauseReturn',
  'ORDER BY': 'kgGqlClauseOrderBy', 'GROUP BY': 'kgGqlClauseGroupBy', LIMIT: 'kgGqlClauseLimit',
}
const PROPERTY_HINTS: Record<string, TranslationKey> = { name: 'kgGqlPropName', id: 'kgGqlPropId', predicate: 'kgGqlPropPredicate' }
const NEXT_KEYWORDS: Record<string, string[]> = {
  '': ['MATCH'], MATCH: ['WHERE', 'RETURN'], WHERE: ['AND', 'RETURN'], RETURN: ['ORDER BY', 'GROUP BY', 'LIMIT'],
  'GROUP BY': ['ORDER BY', 'LIMIT'], 'ORDER BY': ['LIMIT', 'DESC', 'ASC'], OFFSET: ['LIMIT'],
}
const OPERAND_CLAUSES = new Set(['WHERE', 'RETURN', 'ORDER BY', 'GROUP BY'])
const EXPECTS_OPERAND = /(?:[,([{:=<>+*/|&-]|\b(?:AND|OR|NOT|AS|BY|WHERE|MATCH|RETURN|LIMIT|OFFSET|IN|IS))\s*$/i
const MAX_COMPLETIONS = 10

const includesText = (value: string, partial: string) => value.toLowerCase().includes(partial.toLowerCase())

// 入力中の位置に応じて、型・関係名・名前・プロパティ・次に書く節の候補を返します。
export function getGqlCompletions(text: string, caret: number, vocabulary: GqlVocabulary): GqlCompletionResult | null {
  const position = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, position)
  const scan = scanGql(before)
  const result = (from: number, to: number, items: GqlCompletion[]): GqlCompletionResult | null =>
    items.length ? { from, to, items: items.slice(0, MAX_COMPLETIONS) } : null

  if (scan.unterminated) {
    if (scan.openChar === '`') return null
    const lead = before.slice(0, scan.openAt)
    const kind = /\.\s*predicate\s*=\s*$/i.test(lead) ? 'predicate' : /\.\s*name\s*=\s*$/i.test(lead) ? 'name' : null
    if (!kind) return null
    const prefix = before.slice(scan.openAt + 1)
    const rest = text.slice(position)
    const closing = rest.indexOf(scan.openChar)
    const newline = rest.indexOf('\n')
    const hasClosing = closing >= 0 && (newline < 0 || closing < newline)
    const source = kind === 'predicate'
      ? vocabulary.predicates.map((item) => ({ label: item.name, count: item.count }))
      : vocabulary.entities.map((item) => ({ label: item.name, count: item.degree }))
    const items: GqlCompletion[] = []
    for (const item of source) {
      if (gqlString(item.label) === null || !includesText(item.label, prefix) || items.some((added) => added.label === item.label)) continue
      items.push({ ...item, kind, insertText: hasClosing ? item.label : item.label + scan.openChar })
    }
    return result(scan.openAt + 1, hasClosing ? position + closing : position, items)
  }

  const masked = scan.masked
  const label = /([([])\s*(?:[A-Za-z_]\w*)?\s*:\s*([A-Za-z_]\w*)?$/.exec(masked)
  if (label) {
    const partial = label[2] ?? ''
    const names = label[1] === '(' ? vocabulary.nodeTypes : vocabulary.predicates
    const kind = label[1] === '(' ? 'nodeType' : 'predicate'
    return result(position - partial.length, position, names
      .filter((item) => gqlIdentifier(item.name) !== null && includesText(item.name, partial) && item.name !== partial)
      .map((item): GqlCompletion => ({ label: item.name, insertText: gqlIdentifier(item.name) ?? item.name, kind, count: item.count })))
  }

  if (bracketDepth(masked) > 0) return null
  const variables = patternVariables(before, scan)
  const property = /(?:^|[^\w`.'"])([A-Za-z_]\w*)\.(\w*)$/.exec(masked)
  if (property) {
    const kind = variables.get(property[1])
    const names = kind === 'node' ? ['name', 'id'] : kind === 'edge' ? ['predicate'] : ['name', 'id', 'predicate']
    return result(position - property[2].length, position, names
      .filter((name) => name.startsWith(property[2].toLowerCase()) && name !== property[2])
      .map((name): GqlCompletion => ({ label: name, insertText: name, kind: 'property', hintKey: PROPERTY_HINTS[name] })))
  }

  const word = /(?:^|[^\w`.'"])([A-Za-z_]\w*)$/.exec(masked)
  const partial = word?.[1] ?? ''
  const boundary = !partial && (before.length === 0 || /\s$/.test(before))
  if ((!partial && !boundary) || /\bAS\s+\w*$/i.test(before)) return null
  const { clauses } = splitGqlClauses(before, scan)
  const last = clauses.at(-1)?.keyword ?? ''
  const lowerPartial = partial.toLowerCase()
  const keyword = (name: string): GqlCompletion => ({ label: name, insertText: `${name} `, kind: 'keyword', hintKey: KEYWORD_HINTS[name] })
  const operands = (): GqlCompletion[] => {
    if (!OPERAND_CLAUSES.has(last)) return []
    const expressions = [...variables]
      .filter(([name]) => name.toLowerCase().startsWith(lowerPartial))
      .flatMap(([name, kind]) => (kind === 'node' ? ['name', 'id'] : ['predicate'])
        .map((field): GqlCompletion => ({ label: `${name}.${field}`, insertText: `${name}.${field}`, kind: 'variable', hintKey: PROPERTY_HINTS[field] })))
    if (last === 'RETURN' && 'count'.startsWith(lowerPartial)) expressions.push({ label: 'count(*)', insertText: 'count(*)', kind: 'function' })
    return expressions
  }
  if (partial) {
    const keywords = partial.length >= 2
      ? KEYWORDS.filter((name) => name.toLowerCase().startsWith(lowerPartial) && name.toLowerCase() !== lowerPartial).map(keyword) : []
    return result(position - partial.length, position, [...operands(), ...keywords])
  }
  return result(position, position, EXPECTS_OPERAND.test(before) ? operands() : (NEXT_KEYWORDS[last] ?? []).map(keyword))
}
