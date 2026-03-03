/**
 * Debug Runner helper utilities.
 *
 * Pure functions extracted from SkillPipelineDebugRunner so they can be
 * unit-tested independently.  These handle:
 *
 * - Extracting skill outputs from a skillset definition
 * - Generating Shaper skill inputs for Knowledge Store projection
 * - Guessing output field mapping shapes (source paths & field types)
 * - Building debug capture field names
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtractedSkillOutput = {
  skillName: string
  odataType: string
  context: string
  outputName: string
  targetName: string
  sourcePath: string
}

export type ResolvedSkillOutput = ExtractedSkillOutput & {
  fieldName: string
  blobPath?: string
}

export type ShaperBuildResult = {
  shaperInputs: Array<Record<string, unknown>>
  blobPathMap: Map<string, string>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeJsonPointerPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return '/document'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

export function joinEnrichmentPath(context: string, child: string): string {
  const base = normalizeJsonPointerPath(context)
  const c = child.trim()
  if (!c) return base
  if (base.endsWith('/')) return `${base}${c}`
  return `${base}/${c}`
}

export function toSearchFieldName(input: string): string {
  const raw = input.trim()
  const stripped = raw.replace(/^\/document\//, '').replace(/^\//, '')
  const underscored = stripped
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  const startsOk = underscored.match(/^[A-Za-z]/) ? underscored : `f_${underscored || 'out'}`
  return startsOk.slice(0, 128)
}

// ---------------------------------------------------------------------------
// extractSkillOutputs
// ---------------------------------------------------------------------------

type SkillsetSkillLike = {
  '@odata.type'?: unknown
  name?: unknown
  context?: unknown
  outputs?: unknown
}

export function extractSkillOutputs(
  skillset: Record<string, unknown>,
): ExtractedSkillOutput[] {
  const skills = Array.isArray(skillset.skills)
    ? (skillset.skills as unknown[])
    : []
  const out: ExtractedSkillOutput[] = []

  for (const s of skills) {
    const skill = (isRecord(s) ? (s as SkillsetSkillLike) : {}) as SkillsetSkillLike
    const odataType =
      typeof skill['@odata.type'] === 'string'
        ? (skill['@odata.type'] as string)
        : ''
    const skillName =
      typeof skill.name === 'string' ? (skill.name as string) : ''
    const context =
      typeof skill.context === 'string'
        ? (skill.context as string)
        : '/document'
    const outputs = Array.isArray(skill.outputs)
      ? (skill.outputs as unknown[])
      : []

    for (const o of outputs) {
      if (!isRecord(o)) continue
      const outputName =
        typeof o.name === 'string' ? (o.name as string) : ''
      if (!outputName.trim()) continue
      const targetNameRaw =
        typeof o.targetName === 'string' ? (o.targetName as string) : ''
      const targetName = (targetNameRaw.trim() || outputName.trim()).trim()
      const sourcePath = joinEnrichmentPath(context, targetName)

      out.push({
        skillName: skillName || '(unnamed-skill)',
        odataType,
        context,
        outputName: outputName.trim(),
        targetName,
        sourcePath,
      })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// guessOutputMappingShape
// ---------------------------------------------------------------------------

/**
 * Guess the output field mapping shape (sourcePath & fieldType) for a skill output.
 *
 * NOTE: Many skill outputs are actually arrays or complex objects according to
 * the official Microsoft documentation (e.g. EntityRecognition.persons is
 * Collection(Edm.String), PIIDetection.piiEntities is Collection(Edm.ComplexType),
 * AzureOpenAIEmbedding.embedding is Collection(Edm.Single), etc.).
 * We intentionally fall back to Edm.String for most outputs because:
 *
 * 1. The primary consumer is the auto-generated debug index, which only needs
 *    to *store* the enrichment values for inspection — not query them.
 * 2. Edm.ComplexType fields require sub-field definitions that vary per skill
 *    version and configuration, making fully-accurate auto-generation fragile.
 * 3. The main capture path is Knowledge Store blob projection (via Shaper),
 *    which preserves the full JSON structure regardless of index field type.
 *
 * Only KeyPhraseExtractionSkill.keyPhrases and OcrSkill.text are special-cased
 * because their outputFieldMapping sourcePaths require `/*` for correct
 * flattening into a Collection(Edm.String) index field.
 */
export function guessOutputMappingShape(
  x: ExtractedSkillOutput,
): { sourcePath: string; fieldType: string } {
  const odata = x.odataType.toLowerCase()
  const outName = x.outputName.toLowerCase()

  if (odata.includes('keyphraseextractionskill') && outName === 'keyphrases') {
    return { sourcePath: `${x.sourcePath}/*`, fieldType: 'Collection(Edm.String)' }
  }

  if (
    odata.includes('ocrskill') &&
    (outName === 'text' || outName === 'layouttext')
  ) {
    return { sourcePath: x.sourcePath, fieldType: 'Collection(Edm.String)' }
  }

  return { sourcePath: x.sourcePath, fieldType: 'Edm.String' }
}

// ---------------------------------------------------------------------------
// makeDebugCaptureFieldName
// ---------------------------------------------------------------------------

export function makeDebugCaptureFieldName(params: {
  skillName: string
  outputName: string
  usedFieldNames: Map<string, number>
}): string {
  const maxLen = 128
  const prefix = 'dbg__'
  const sep = '__'

  const safeSkill = toSearchFieldName(params.skillName)
  const safeOutput = toSearchFieldName(params.outputName)

  let base = `${prefix}${safeSkill}${sep}${safeOutput}`
  if (base.length > maxLen) {
    const remaining = maxLen - prefix.length - sep.length
    const minPart = 8
    const skillBudget = Math.max(minPart, Math.floor(remaining * 0.6))
    const skillPart = safeSkill.slice(
      0,
      Math.min(safeSkill.length, skillBudget),
    )
    const outBudget = Math.max(minPart, remaining - skillPart.length)
    const outPart = safeOutput.slice(
      0,
      Math.min(safeOutput.length, outBudget),
    )
    base = `${prefix}${skillPart}${sep}${outPart}`.slice(0, maxLen)
  }

  const bump = (name: string) => {
    const prev = params.usedFieldNames.get(name) ?? 0
    params.usedFieldNames.set(name, prev + 1)
    return prev
  }

  if (bump(base) === 0) return base

  for (let n = 2; n < 10000; n++) {
    const suffix = `_${n}`
    const trimmedBase =
      base.length + suffix.length <= maxLen
        ? base
        : base.slice(0, Math.max(0, maxLen - suffix.length))
    const candidate = `${trimmedBase}${suffix}`
    if (bump(candidate) === 0) return candidate
  }

  return base.slice(0, maxLen)
}

// ---------------------------------------------------------------------------
// buildShaperInputs  — extracted from SkillPipelineDebugRunner provision()
// ---------------------------------------------------------------------------

/**
 * Given extracted skill outputs, builds the Shaper skill's `inputs` array
 * and a `blobPathMap` that maps each enrichment sourcePath to the
 * corresponding path inside the Shaper output blob.
 */
export function buildShaperInputs(
  extractedOutputs: ExtractedSkillOutput[],
): ShaperBuildResult {
  const docLevelOutputs: ExtractedSkillOutput[] = []
  const nestedGroups = new Map<string, ExtractedSkillOutput[]>()

  for (const out of extractedOutputs) {
    if (out.context === '/document') {
      docLevelOutputs.push(out)
    } else {
      const group = nestedGroups.get(out.context) || []
      group.push(out)
      nestedGroups.set(out.context, group)
    }
  }

  const shaperInputs: Array<Record<string, unknown>> = [
    { name: 'content', source: '/document/content' },
  ]
  const usedShaperNames = new Set<string>(['content'])
  const blobPathMap = new Map<string, string>()

  const makeShaperName = (candidate: string): string => {
    let name =
      candidate.replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') ||
      'out'
    if (usedShaperNames.has(name)) {
      name = `${name}_${usedShaperNames.size}`
    }
    usedShaperNames.add(name)
    return name
  }

  // Document-level outputs → simple { name, source } inputs.
  for (const out of docLevelOutputs) {
    const inputName = makeShaperName(out.targetName || out.outputName)
    shaperInputs.push({ name: inputName, source: out.sourcePath })
    blobPathMap.set(out.sourcePath, `/document/${inputName}`)
  }

  // Nested outputs → sourceContext grouped inputs.
  for (const [context, outputs] of nestedGroups) {
    const contextBase = context
      .replace(/^\/document\/?/, '')
      .replace(/\/\*$/, '')
    const groupName = makeShaperName(
      contextBase.replace(/\//g, '_') || 'nested',
    )

    const nestedInputs: Array<Record<string, unknown>> = []
    const usedSubNames = new Set<string>()
    for (const out of outputs) {
      let subName =
        (out.targetName || out.outputName)
          .replace(/[^A-Za-z0-9_]/g, '_')
          .replace(/^_+|_+$/g, '') || 'val'
      if (usedSubNames.has(subName)) {
        subName = `${subName}_${usedSubNames.size}`
      }
      usedSubNames.add(subName)
      nestedInputs.push({ name: subName, source: out.sourcePath })
      blobPathMap.set(
        out.sourcePath,
        `/document/${groupName}/*/${subName}`,
      )
    }

    shaperInputs.push({
      name: groupName,
      sourceContext: context,
      inputs: nestedInputs,
    })
  }

  return { shaperInputs, blobPathMap }
}

/**
 * Convenience: resolves outputs with field names and blob paths in one call.
 */
export function resolveOutputsWithBlobPaths(
  extractedOutputs: ExtractedSkillOutput[],
): { resolvedOutputs: ResolvedSkillOutput[]; shaperInputs: Array<Record<string, unknown>> } {
  const usedFieldNames = new Map<string, number>()
  const resolvedOutputs: ResolvedSkillOutput[] = extractedOutputs.map((x) => {
    const fieldName = makeDebugCaptureFieldName({
      skillName: x.skillName,
      outputName: x.outputName,
      usedFieldNames,
    })
    return { ...x, fieldName }
  })

  const { shaperInputs, blobPathMap } = buildShaperInputs(extractedOutputs)

  for (const ro of resolvedOutputs) {
    ro.blobPath = blobPathMap.get(ro.sourcePath)
  }

  return { resolvedOutputs, shaperInputs }
}
