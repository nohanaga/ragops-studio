import { translations, type Language } from './translations'

/**
 * Lightweight OData $filter parser/serializer + linter.
 *
 * Designed for interactive UI editing (Filter Query Builder): it is forgiving
 * while still providing actionable errors and lint warnings.
 */

export type ODataFilterExpr =
  | { kind: 'boolLiteral'; value: boolean }
  | { kind: 'nullLiteral' }
  | { kind: 'numberLiteral'; value: string }
  | { kind: 'stringLiteral'; value: string }
  | { kind: 'dateTimeLiteral'; value: string }
  | { kind: 'geographyLiteral'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'call'; name: string; args: ODataFilterExpr[] }
  | { kind: 'not'; expr: ODataFilterExpr }
  | { kind: 'and' | 'or'; left: ODataFilterExpr; right: ODataFilterExpr }
  | { kind: 'compare'; op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le'; left: ODataFilterExpr; right: ODataFilterExpr }
  | {
      kind: 'lambda';
      collection: string;
      op: 'any' | 'all';
      varName?: string;
      expr?: ODataFilterExpr;
    }

export type ParseResult =
  | { ok: true; expr: ODataFilterExpr }
  | { ok: false; error: string }

type Token =
  | { kind: 'identifier'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'datetime'; value: string }
  | { kind: 'geography'; value: string }
  | { kind: 'lparen' | 'rparen' | 'comma' | 'colon' | 'slash' | 'dot' }
  | { kind: 'eof' }

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r'
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch)
}

function isIdentPart(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

function looksLikeDateTime(s: string): boolean {
  // Heuristic detection for DateTime literals.
  // This is intentionally permissive to support interactive typing.
  // Very permissive: 2010-01-01T00:00:00Z or with offset
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)
}

function lex(input: string): Token[] {
  // --- Lexer ---
  // Converts raw filter text into tokens that the recursive-descent parser can consume.
  const tokens: Token[] = []
  let i = 0

  const peek = () => input[i] ?? ''
  const next = () => input[i++] ?? ''

  const push = (t: Token) => tokens.push(t)

  while (i < input.length) {
    const ch = peek()
    if (isWhitespace(ch)) {
      i++
      continue
    }

    if (ch === '(') {
      next()
      push({ kind: 'lparen' })
      continue
    }
    if (ch === ')') {
      next()
      push({ kind: 'rparen' })
      continue
    }
    if (ch === ',') {
      next()
      push({ kind: 'comma' })
      continue
    }
    if (ch === ':') {
      next()
      push({ kind: 'colon' })
      continue
    }
    if (ch === '/') {
      next()
      push({ kind: 'slash' })
      continue
    }
    if (ch === '.') {
      next()
      push({ kind: 'dot' })
      continue
    }

    // String literal: '...'
    if (ch === "'") {
      next() // consume opening
      let raw = ''
      while (i < input.length) {
        const c = next()
        if (c === "'") {
          // escaped ''
          if (peek() === "'") {
            next()
            raw += "'"
            continue
          }
          break
        }
        raw += c
      }
      push({ kind: 'string', value: raw })
      continue
    }

    // geography'...'
    if (input.slice(i, i + 10).toLowerCase() === "geography'") {
      i += 10
      let raw = "geography'"
      while (i < input.length) {
        const c = next()
        raw += c
        if (c === "'") {
          // end
          break
        }
      }
      push({ kind: 'geography', value: raw })
      continue
    }

    // Number literal (allow leading -)
    if (ch === '-' || /\d/.test(ch)) {
      // Try to parse as datetime first if it starts with digit
      if (/\d/.test(ch)) {
        let s = ''
        const startPos = i
        while (i < input.length) {
          const c = peek()
          if (/[0-9\-:TZ+.]/.test(c)) {
            s += next()
          } else {
            break
          }
        }
        if (looksLikeDateTime(s)) {
          push({ kind: 'datetime', value: s })
          continue
        }
        // Not a datetime, rewind and parse as number
        i = startPos
        s = ''
      }
      
      // Parse as number
      let s = ''
      if (ch === '-') s += next()
      while (i < input.length && /\d/.test(peek())) s += next()
      if (peek() === '.') {
        s += next()
        while (i < input.length && /\d/.test(peek())) s += next()
      }
      push({ kind: 'number', value: s })
      continue
    }

    // Identifier
    if (isIdentStart(ch)) {
      let s = ''
      while (i < input.length && isIdentPart(peek())) {
        s += next()
      }
      push({ kind: 'identifier', value: s })
      continue
    }

    // Unknown char
    // Keep going to avoid getting stuck; the parser/linter can report the issue.
    next()
    push({ kind: 'identifier', value: ch })
  }

  tokens.push({ kind: 'eof' })
  return tokens
}

type ParserState = {
  tokens: Token[]
  pos: number
}

function tokenToString(t: Token): string {
  if (t.kind === 'identifier') return t.value
  if (t.kind === 'string') return `'${t.value.replaceAll("'", "''")}'`
  if (t.kind === 'number') return t.value
  if (t.kind === 'datetime') return t.value
  if (t.kind === 'geography') return t.value
  return t.kind
}

function parseError(state: ParserState, msg: string): ParseResult {
  const near = state.tokens[state.pos]
  return { ok: false, error: `${msg} (near: ${near ? tokenToString(near) : 'EOF'})` }
}

function match(state: ParserState, kind: Token['kind']): boolean {
  const t = state.tokens[state.pos]
  if (t?.kind === kind) {
    state.pos++
    return true
  }
  return false
}

function expect(state: ParserState, kind: Token['kind']): Token | null {
  const t = state.tokens[state.pos]
  if (t?.kind === kind) {
    state.pos++
    return t
  }
  return null
}

function peekToken(state: ParserState): Token {
  return state.tokens[state.pos] ?? { kind: 'eof' }
}

function parseIdentifier(state: ParserState): string | null {
  const t = peekToken(state)
  if (t.kind !== 'identifier') return null
  state.pos++
  return t.value
}

function isCompareOp(id: string): id is 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' {
  return id === 'eq' || id === 'ne' || id === 'gt' || id === 'ge' || id === 'lt' || id === 'le'
}

function parsePrimary(state: ParserState): ODataFilterExpr | ParseResult {
  const t = peekToken(state)

  if (match(state, 'lparen')) {
    const inner = parseOr(state)
    if ('ok' in inner) return inner
    if (!expect(state, 'rparen')) return parseError(state, 'Expected )')
    return inner
  }

  if (t.kind === 'string') {
    state.pos++
    return { kind: 'stringLiteral', value: t.value }
  }
  if (t.kind === 'number') {
    state.pos++
    return { kind: 'numberLiteral', value: t.value }
  }
  if (t.kind === 'datetime') {
    state.pos++
    return { kind: 'dateTimeLiteral', value: t.value }
  }
  if (t.kind === 'geography') {
    state.pos++
    return { kind: 'geographyLiteral', value: t.value }
  }

  if (t.kind === 'identifier') {
    const id = t.value

    if (id === 'true' || id === 'false') {
      state.pos++
      return { kind: 'boolLiteral', value: id === 'true' }
    }
    if (id === 'null') {
      state.pos++
      return { kind: 'nullLiteral' }
    }

    // Dotted function name? (geo.distance, search.in, search.ismatch...)
    // Read identifier(.identifier)* into a name.
    state.pos++
    let dottedName = id
    while (match(state, 'dot')) {
      const nextId = parseIdentifier(state)
      if (!nextId) return parseError(state, 'Expected identifier after .')
      dottedName += `.${nextId}`
    }

    // Function call
    if (match(state, 'lparen')) {
      const args: ODataFilterExpr[] = []
      if (!match(state, 'rparen')) {
        while (true) {
          const expr = parseOr(state)
          if ('ok' in expr) return expr
          args.push(expr)
          if (match(state, 'comma')) continue
          if (match(state, 'rparen')) break
          return parseError(state, 'Expected , or ) in function args')
        }
      }
      return { kind: 'call', name: dottedName, args }
    }

    // Otherwise, treat as a path start. It might become a lambda.
    const segments: string[] = [dottedName]

    const savePos = () => state.pos

    while (true) {
      const beforeSlashPos = savePos()
      if (!match(state, 'slash')) break
      const nextTok = peekToken(state)
      if (nextTok.kind === 'identifier' && (nextTok.value === 'any' || nextTok.value === 'all')) {
        // Potential lambda: <path>/any(
        const op = nextTok.value as 'any' | 'all'
        const afterOpPos = state.pos + 1
        const afterOpTok = state.tokens[afterOpPos]
        if (afterOpTok && afterOpTok.kind === 'lparen') {
          // Consume op and (
          state.pos++ // consume op identifier
          state.pos++ // consume (

          // any() / all() with empty
          if (match(state, 'rparen')) {
            return { kind: 'lambda', collection: segments.join('/'), op }
          }

          const varName = parseIdentifier(state)
          if (!varName) return parseError(state, 'Expected lambda variable name')
          if (!expect(state, 'colon')) return parseError(state, 'Expected : after lambda variable')

          const predicate = parseOr(state)
          if ('ok' in predicate) return predicate

          if (!expect(state, 'rparen')) return parseError(state, 'Expected ) to close lambda')

          return { kind: 'lambda', collection: segments.join('/'), op, varName, expr: predicate }
        }
      }

      if (nextTok.kind !== 'identifier') {
        // rewind if it was just a slash not followed by identifier
        state.pos = beforeSlashPos
        break
      }
      state.pos++
      segments.push(nextTok.value)
    }

    return { kind: 'path', value: segments.join('/') }
  }

  return parseError(state, 'Unexpected token')
}

function parseCompare(state: ParserState): ODataFilterExpr | ParseResult {
  const left = parsePrimary(state)
  if ('ok' in left) return left

  const t = peekToken(state)
  if (t.kind === 'identifier' && isCompareOp(t.value)) {
    state.pos++
    const right = parsePrimary(state)
    if ('ok' in right) return right
    return { kind: 'compare', op: t.value, left, right }
  }

  return left
}

function parseNot(state: ParserState): ODataFilterExpr | ParseResult {
  const t = peekToken(state)
  if (t.kind === 'identifier' && t.value === 'not') {
    state.pos++
    const expr = parseNot(state)
    if ('ok' in expr) return expr
    return { kind: 'not', expr }
  }
  return parseCompare(state)
}

function parseAnd(state: ParserState): ODataFilterExpr | ParseResult {
  let left = parseNot(state)
  if ('ok' in left) return left
  while (true) {
    const t = peekToken(state)
    if (t.kind === 'identifier' && t.value === 'and') {
      state.pos++
      const right = parseNot(state)
      if ('ok' in right) return right
      left = { kind: 'and', left, right }
      continue
    }
    break
  }
  return left
}

function parseOr(state: ParserState): ODataFilterExpr | ParseResult {
  let left = parseAnd(state)
  if ('ok' in left) return left
  while (true) {
    const t = peekToken(state)
    if (t.kind === 'identifier' && t.value === 'or') {
      state.pos++
      const right = parseAnd(state)
      if ('ok' in right) return right
      left = { kind: 'or', left, right }
      continue
    }
    break
  }
  return left
}

export function parseODataFilter(input: string): ParseResult {
  const trimmed = input.trim()
  if (!trimmed) return { ok: true, expr: { kind: 'boolLiteral', value: true } }

  const state: ParserState = { tokens: lex(trimmed), pos: 0 }
  const expr = parseOr(state)
  if ('ok' in expr) return expr

  const tail = peekToken(state)
  if (tail.kind !== 'eof') {
    return parseError(state, 'Unexpected trailing tokens')
  }

  return { ok: true, expr }
}

function escapeStringLiteral(s: string): string {
  return `'${s.replaceAll("'", "''")}'`
}

function precedence(expr: ODataFilterExpr): number {
  switch (expr.kind) {
    case 'or':
      return 1
    case 'and':
      return 2
    case 'compare':
      return 3
    case 'not':
      return 4
    default:
      return 5
  }
}

function serializeWithParens(expr: ODataFilterExpr, parentPrec: number): string {
  const s = serializeODataFilter(expr)
  if (precedence(expr) < parentPrec) return `(${s})`
  return s
}

export function serializeODataFilter(expr: ODataFilterExpr): string {
  switch (expr.kind) {
    case 'boolLiteral':
      return expr.value ? 'true' : 'false'
    case 'nullLiteral':
      return 'null'
    case 'numberLiteral':
      return expr.value
    case 'stringLiteral':
      return escapeStringLiteral(expr.value)
    case 'dateTimeLiteral':
      return expr.value
    case 'geographyLiteral':
      return expr.value
    case 'path':
      return expr.value
    case 'call':
      return `${expr.name}(${expr.args.map((a) => serializeODataFilter(a)).join(', ')})`
    case 'not':
      return `not ${serializeWithParens(expr.expr, precedence(expr))}`
    case 'and':
      return `${serializeWithParens(expr.left, precedence(expr))} and ${serializeWithParens(expr.right, precedence(expr))}`
    case 'or':
      return `${serializeWithParens(expr.left, precedence(expr))} or ${serializeWithParens(expr.right, precedence(expr))}`
    case 'compare':
      return `${serializeWithParens(expr.left, precedence(expr))} ${expr.op} ${serializeWithParens(expr.right, precedence(expr))}`
    case 'lambda': {
      const base = `${expr.collection}/${expr.op}`
      if (!expr.varName || !expr.expr) return `${base}()`
      return `${base}(${expr.varName}: ${serializeODataFilter(expr.expr)})`
    }
    default: {
      const _exhaustive: never = expr
      return String(_exhaustive)
    }
  }
}

export function lintODataFilter(expr: ODataFilterExpr, language: Language = 'en'): string[] {
  const t = (key: keyof typeof translations.ja, params?: Record<string, string>) => {
    let text = String(translations[language][key] ?? '')
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, v)
      }
    }
    return text
  }
  const warnings: string[] = []

  const walk = (e: ODataFilterExpr) => {
    if (e.kind === 'compare') {
      // Common pitfall: not X gt 5 (should be not (X gt 5))
      if (e.left.kind === 'not') {
        warnings.push(t('odataNotWarning'))
      }
    }

    if (e.kind === 'lambda') {
      // Validate lambda: if empty (no varName/expr), it's valid
      // if has varName but no expr, or vice versa, it's invalid
      const hasVar = !!e.varName
      const hasExpr = !!e.expr
      if (hasVar !== hasExpr) {
        warnings.push(t('odataLambdaWarning', { collection: e.collection, op: e.op }))
      }
    }

    if (e.kind === 'and' || e.kind === 'or') {
      walk(e.left)
      walk(e.right)
    } else if (e.kind === 'not') {
      walk(e.expr)
    } else if (e.kind === 'call') {
      e.args.forEach(walk)
    } else if (e.kind === 'lambda' && e.expr) {
      walk(e.expr)
    }
  }

  walk(expr)
  return warnings
}
