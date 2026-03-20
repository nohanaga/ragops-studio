import { buildSampleRequest } from './skillValidator'

export type SkillEditorSampleInput = {
  name?: string
  source?: string
}

export type SkillEditorSampleOutput = {
  name?: string
  targetName?: string
}

type NormalizedInput = {
  name: string
  source: string
  variableName: string
}

type NormalizedOutput = {
  name: string
  targetName?: string
}

const SAMPLE_TEXT = 'Azure AI Search custom skill sample text for local testing.'
const SIMPLE_APPEND_SUFFIX = '🌷🌷🌷'

const PYTHON_KEYWORDS = new Set([
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'False',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'None',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'True',
  'try',
  'while',
  'with',
  'yield',
])

function normalizeName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeInputs(inputs: readonly SkillEditorSampleInput[] | undefined): Array<{ name: string; source: string }> {
  const seen = new Set<string>()
  const result: Array<{ name: string; source: string }> = []

  for (const input of inputs ?? []) {
    const name = normalizeName(input?.name)
    if (!name) continue

    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    result.push({
      name,
      source: normalizeName(input?.source),
    })
  }

  return result
}

function normalizeOutputs(outputs: readonly SkillEditorSampleOutput[] | undefined): NormalizedOutput[] {
  const seen = new Set<string>()
  const result: NormalizedOutput[] = []

  for (const output of outputs ?? []) {
    const name = normalizeName(output?.name)
    if (!name) continue

    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    result.push({
      name,
      targetName: normalizeName(output?.targetName) || undefined,
    })
  }

  return result
}

function toPythonIdentifier(name: string, used: Set<string>): string {
  let candidate = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+/, '')
  if (!candidate) candidate = 'value'
  if (/^[0-9]/.test(candidate)) candidate = `field_${candidate}`
  if (PYTHON_KEYWORDS.has(candidate)) candidate = `${candidate}_value`

  let unique = candidate
  let counter = 2
  while (used.has(unique)) {
    unique = `${candidate}_${counter}`
    counter += 1
  }
  used.add(unique)
  return unique
}

function isTextLikeField(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  return (
    normalized === 'text' ||
    normalized === 'content' ||
    normalized === 'body' ||
    normalized === 'message' ||
    normalized === 'title' ||
    normalized === 'summary' ||
    normalized === 'description' ||
    normalized === 'query'
  )
}

function sampleValueForField(name: string): unknown {
  const lower = name.trim().toLowerCase()
  if (isTextLikeField(name)) return SAMPLE_TEXT
  if (lower.includes('number') || lower.includes('count') || lower.includes('page') || lower.includes('index') || lower.includes('score')) return 1
  if (lower.includes('flag') || lower.includes('enabled') || lower.includes('active') || lower.includes('is_')) return true
  if (lower.includes('tags') || lower.includes('items') || lower.includes('list') || lower.includes('entities') || lower.includes('categories')) return ['sample']
  if (lower.includes('metadata') || lower.includes('properties') || lower.includes('config')) return { key: 'value' }
  return `sample_${name}`
}

export function buildSkillEditorSampleRequest(inputs?: readonly SkillEditorSampleInput[]) {
  const normalizedInputs = normalizeInputs(inputs)
  if (normalizedInputs.length === 0) {
    return buildSampleRequest()
  }

  const data: Record<string, unknown> = {}
  for (const input of normalizedInputs) {
    data[input.name] = sampleValueForField(input.name)
  }

  return {
    values: [
      {
        recordId: '1',
        data,
      },
    ],
  }
}

export function buildSkillEditorSampleCode(params: {
  inputs?: readonly SkillEditorSampleInput[]
  outputs?: readonly SkillEditorSampleOutput[]
  fallbackCode?: string
}): string {
  const fallbackCode = params.fallbackCode ?? 'def process(input: dict) -> dict:\n    return {}'
  const rawInputs = normalizeInputs(params.inputs)
  const outputs = normalizeOutputs(params.outputs)

  if (rawInputs.length === 0 || outputs.length === 0) {
    return fallbackCode
  }

  const usedNames = new Set<string>()
  const inputs: NormalizedInput[] = rawInputs.map((input) => ({
    ...input,
    variableName: toPythonIdentifier(input.name, usedNames),
  }))

  const lines: string[] = [
    'def process(input: dict) -> dict:',
    '    # --- Extract inputs ---',
  ]

  for (const inp of inputs) {
    lines.push(`    ${inp.variableName} = input.get(${JSON.stringify(inp.name)}, "")`)
  }

  const primaryInput = inputs.find((input) => isTextLikeField(input.name)) ?? inputs[0]
  lines.push('')
  lines.push('    # --- Transform ---')
  lines.push(`    ${primaryInput.variableName} = str(${primaryInput.variableName}) + ${JSON.stringify(SIMPLE_APPEND_SUFFIX)}`)
  lines.push('')

  lines.push('    # --- Build outputs ---')
  lines.push('    return {')
  for (const output of outputs) {
    lines.push(`        ${JSON.stringify(output.name)}: ${primaryInput.variableName},`)
  }
  lines.push('    }')

  return lines.join('\n')
}