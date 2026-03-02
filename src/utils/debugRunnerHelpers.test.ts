/**
 * Comprehensive tests for Debug Runner helpers.
 *
 * Verifies that for every built-in skill template the Debug Runner can:
 * 1. Extract all outputs correctly (extractSkillOutputs)
 * 2. Build valid Shaper skill inputs (buildShaperInputs)
 * 3. Generate unique field names (makeDebugCaptureFieldName)
 * 4. Map blob paths back to enrichment paths (resolveOutputsWithBlobPaths)
 * 5. Guess output mapping shapes correctly (guessOutputMappingShape)
 */

import { describe, expect, it } from 'vitest'

import {
  extractSkillOutputs,
  guessOutputMappingShape,
  makeDebugCaptureFieldName,
  buildShaperInputs,
  resolveOutputsWithBlobPaths,
  joinEnrichmentPath,
  toSearchFieldName,
  type ExtractedSkillOutput,
} from './debugRunnerHelpers'

// ---------------------------------------------------------------------------
// Built-in skill templates (mirrored from SkillPipelineBuilder.tsx)
// ---------------------------------------------------------------------------

const BUILT_IN_SKILLSETS: Array<{
  id: string
  label: string
  skillset: Record<string, unknown>
  expectedOutputCount: number
  /** Expected context for the first output. */
  expectedContext: string
}> = [
  {
    id: 'textSplit',
    label: 'Text Split',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
          name: 'splitText',
          context: '/document',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [{ name: 'textItems', targetName: 'pages' }],
        },
      ],
    },
    expectedOutputCount: 1,
    expectedContext: '/document',
  },
  {
    id: 'keyPhrases',
    label: 'Key Phrase Extraction',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
          name: 'keyPhrases',
          context: '/document',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [{ name: 'keyPhrases', targetName: 'keyPhrases' }],
        },
      ],
    },
    expectedOutputCount: 1,
    expectedContext: '/document',
  },
  {
    id: 'languageDetection',
    label: 'Language Detection',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.LanguageDetectionSkill',
          name: 'languageDetection',
          context: '/document',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [{ name: 'languageCode', targetName: 'languageCode' }],
        },
      ],
    },
    expectedOutputCount: 1,
    expectedContext: '/document',
  },
  {
    id: 'piiDetection',
    label: 'PII Detection',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.PIIDetectionSkill',
          name: 'piiDetection',
          context: '/document',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [
            { name: 'piiEntities', targetName: 'piiEntities' },
            { name: 'maskedText', targetName: 'maskedText' },
          ],
        },
      ],
    },
    expectedOutputCount: 2,
    expectedContext: '/document',
  },
  {
    id: 'textTranslation',
    label: 'Text Translation',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.TranslationSkill',
          name: 'translateText',
          context: '/document',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [
            { name: 'translatedText', targetName: 'translatedText' },
            { name: 'translatedToLanguageCode', targetName: 'translatedToLanguageCode' },
            { name: 'translatedFromLanguageCode', targetName: 'translatedFromLanguageCode' },
          ],
        },
      ],
    },
    expectedOutputCount: 3,
    expectedContext: '/document',
  },
  {
    id: 'sentimentV3',
    label: 'Sentiment (v3)',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.V3.SentimentSkill',
          name: 'sentiment',
          context: '/document',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [
            { name: 'sentiment', targetName: 'sentiment' },
            { name: 'confidenceScores', targetName: 'confidenceScores' },
          ],
        },
      ],
    },
    expectedOutputCount: 2,
    expectedContext: '/document',
  },
  {
    id: 'entityRecognitionV3',
    label: 'Entity Recognition (v3)',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.V3.EntityRecognitionSkill',
          name: 'entities',
          context: '/document',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [{ name: 'persons', targetName: 'persons' }],
        },
      ],
    },
    expectedOutputCount: 1,
    expectedContext: '/document',
  },
  {
    id: 'entityLinkingV3',
    label: 'Entity Linking (v3)',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.V3.EntityLinkingSkill',
          name: 'entityLinks',
          context: '/document',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [{ name: 'entities', targetName: 'entities' }],
        },
      ],
    },
    expectedOutputCount: 1,
    expectedContext: '/document',
  },
  {
    id: 'ocr',
    label: 'OCR',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Vision.OcrSkill',
          name: 'ocr',
          context: '/document/normalized_images/*',
          inputs: [{ name: 'image', source: '/document/normalized_images/*' }],
          outputs: [{ name: 'text', targetName: 'ocrText' }],
        },
      ],
    },
    expectedOutputCount: 1,
    expectedContext: '/document/normalized_images/*',
  },
  {
    id: 'imageAnalysis',
    label: 'Image Analysis',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Vision.ImageAnalysisSkill',
          name: 'imageAnalysis',
          context: '/document/normalized_images/*',
          inputs: [{ name: 'image', source: '/document/normalized_images/*' }],
          outputs: [
            { name: 'description', targetName: 'imageDescription' },
            { name: 'tags', targetName: 'imageTags' },
          ],
        },
      ],
    },
    expectedOutputCount: 2,
    expectedContext: '/document/normalized_images/*',
  },
  {
    id: 'textMerge',
    label: 'Text Merge',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.MergeSkill',
          name: 'mergeText',
          context: '/document',
          inputs: [
            { name: 'text', source: '/document/content' },
            { name: 'itemsToInsert', source: '/document/normalized_images/*/ocrText' },
            { name: 'offsets', source: '/document/normalized_images/*/contentOffset' },
          ],
          outputs: [{ name: 'mergedText', targetName: 'mergedText' }],
        },
      ],
    },
    expectedOutputCount: 1,
    expectedContext: '/document',
  },
  {
    id: 'conditional',
    label: 'Conditional',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Util.ConditionalSkill',
          name: 'conditional',
          context: '/document',
          inputs: [
            { name: 'condition', source: '= true' },
            { name: 'whenTrue', source: "= $(/document/content)" },
            { name: 'whenFalse', source: '= null' },
          ],
          outputs: [{ name: 'output', targetName: 'output' }],
        },
      ],
    },
    expectedOutputCount: 1,
    expectedContext: '/document',
  },
  {
    id: 'documentExtraction',
    label: 'Document Extraction',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Util.DocumentExtractionSkill',
          name: 'documentExtraction',
          context: '/document',
          inputs: [{ name: 'file_data', source: '/document/file_data' }],
          outputs: [
            { name: 'content', targetName: 'content' },
            { name: 'normalized_images', targetName: 'normalized_images' },
          ],
        },
      ],
    },
    expectedOutputCount: 2,
    expectedContext: '/document',
  },
  {
    id: 'azureOpenAIEmbedding',
    label: 'Azure OpenAI Embedding',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill',
          name: 'embedding',
          context: '/document',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [{ name: 'embedding', targetName: 'embedding' }],
        },
      ],
    },
    expectedOutputCount: 1,
    expectedContext: '/document',
  },
  {
    id: 'genAIPrompt',
    label: 'GenAI Prompt',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Custom.ChatCompletionSkill',
          name: 'genAIPrompt',
          context: '/document',
          inputs: [
            { name: 'text', source: '/document/content' },
            { name: 'systemMessage', source: "='You are a helpful AI assistant.'" },
            { name: 'userMessage', source: "='Summarize the following text:'" },
          ],
          outputs: [{ name: 'response', targetName: 'response' }],
        },
      ],
    },
    expectedOutputCount: 1,
    expectedContext: '/document',
  },
  {
    id: 'customWebApi',
    label: 'Custom Web API',
    skillset: {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Custom.WebApiSkill',
          name: 'customWebApi',
          context: '/document',
          inputs: [{ name: 'text', source: '/document/content' }],
          outputs: [{ name: 'result', targetName: 'customResult' }],
        },
      ],
    },
    expectedOutputCount: 1,
    expectedContext: '/document',
  },
]

// ===========================================================================
// Helper utilities
// ===========================================================================

describe('joinEnrichmentPath', () => {
  it('joins /document context with child segment', () => {
    expect(joinEnrichmentPath('/document', 'pages')).toBe('/document/pages')
  })
  it('handles nested context with wildcard', () => {
    expect(joinEnrichmentPath('/document/pages/*', 'keyPhrases')).toBe('/document/pages/*/keyPhrases')
  })
  it('handles missing context', () => {
    expect(joinEnrichmentPath('', 'content')).toBe('/document/content')
  })
})

describe('toSearchFieldName', () => {
  it('strips /document/ prefix and sanitizes', () => {
    expect(toSearchFieldName('/document/content')).toBe('content')
  })
  it('replaces invalid characters with underscores', () => {
    expect(toSearchFieldName('key-phrases')).toBe('key_phrases')
  })
  it('prepends f_ when name starts with non-letter', () => {
    expect(toSearchFieldName('123abc')).toBe('f_123abc')
  })
})

// ===========================================================================
// extractSkillOutputs — per-skill tests
// ===========================================================================

describe('extractSkillOutputs', () => {
  for (const template of BUILT_IN_SKILLSETS) {
    it(`extracts correct outputs for ${template.label} (${template.id})`, () => {
      const outputs = extractSkillOutputs(template.skillset)
      expect(outputs).toHaveLength(template.expectedOutputCount)

      for (const out of outputs) {
        // Every output must have non-empty fields.
        expect(out.skillName).toBeTruthy()
        expect(out.outputName).toBeTruthy()
        expect(out.targetName).toBeTruthy()
        expect(out.sourcePath).toBeTruthy()
        expect(out.sourcePath.startsWith('/document')).toBe(true)

        // Context must match expected.
        expect(out.context).toBe(template.expectedContext)

        // sourcePath = joinEnrichmentPath(context, targetName)
        const expected = joinEnrichmentPath(out.context, out.targetName)
        expect(out.sourcePath).toBe(expected)
      }
    })
  }

  it('handles empty skills array', () => {
    expect(extractSkillOutputs({ skills: [] })).toEqual([])
  })

  it('handles missing skills property', () => {
    expect(extractSkillOutputs({})).toEqual([])
  })

  it('skips outputs with empty name', () => {
    const outputs = extractSkillOutputs({
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
          name: 'split',
          context: '/document',
          outputs: [{ name: '', targetName: 'pages' }],
        },
      ],
    })
    expect(outputs).toHaveLength(0)
  })
})

// ===========================================================================
// guessOutputMappingShape — per-skill tests
//
// NOTE: According to official Microsoft documentation, many skill outputs are
// arrays (Collection) or complex types (e.g. EntityRecognition.persons →
// Collection(Edm.String), PIIDetection.piiEntities → Collection(Edm.ComplexType),
// SentimentSkill.confidenceScores → Edm.ComplexType, etc.).
// The implementation intentionally falls back to Edm.String for most outputs
// because: (1) ComplexType fields require sub-field definitions that are hard
// to auto-generate accurately, (2) the primary capture path is Knowledge Store
// blob projection which preserves full JSON regardless of index field type.
// Only KeyPhraseExtraction and OCR are special-cased because their
// outputFieldMapping sourcePaths require `/*` for correct flattening.
// ===========================================================================

describe('guessOutputMappingShape', () => {
  it('KeyPhraseExtractionSkill keyPhrases → Collection(Edm.String) with /*', () => {
    const out: ExtractedSkillOutput = {
      skillName: 'kpe',
      odataType: '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
      context: '/document',
      outputName: 'keyPhrases',
      targetName: 'keyPhrases',
      sourcePath: '/document/keyPhrases',
    }
    const shape = guessOutputMappingShape(out)
    expect(shape.sourcePath).toBe('/document/keyPhrases/*')
    expect(shape.fieldType).toBe('Collection(Edm.String)')
  })

  it('OcrSkill text → Collection(Edm.String) without /*', () => {
    const out: ExtractedSkillOutput = {
      skillName: 'ocr',
      odataType: '#Microsoft.Skills.Vision.OcrSkill',
      context: '/document/normalized_images/*',
      outputName: 'text',
      targetName: 'ocrText',
      sourcePath: '/document/normalized_images/*/ocrText',
    }
    const shape = guessOutputMappingShape(out)
    expect(shape.sourcePath).toBe('/document/normalized_images/*/ocrText')
    expect(shape.fieldType).toBe('Collection(Edm.String)')
  })

  // All other skills default to Edm.String
  const defaultStringSkills = BUILT_IN_SKILLSETS.filter(
    (t) => t.id !== 'keyPhrases' && t.id !== 'ocr',
  )
  for (const template of defaultStringSkills) {
    it(`${template.label} outputs default to Edm.String`, () => {
      const outputs = extractSkillOutputs(template.skillset)
      for (const out of outputs) {
        const shape = guessOutputMappingShape(out)
        expect(shape.fieldType).toBe('Edm.String')
        // sourcePath should not have /* appended
        expect(shape.sourcePath).toBe(out.sourcePath)
      }
    })
  }
})

// ===========================================================================
// buildShaperInputs — per-skill tests
// ===========================================================================

describe('buildShaperInputs', () => {
  for (const template of BUILT_IN_SKILLSETS) {
    it(`builds valid Shaper inputs for ${template.label} (${template.id})`, () => {
      const outputs = extractSkillOutputs(template.skillset)
      const { shaperInputs, blobPathMap } = buildShaperInputs(outputs)

      // Must always contain the content seed input.
      expect(shaperInputs[0]).toEqual({ name: 'content', source: '/document/content' })

      // All shaperInput names must be unique.
      const names = shaperInputs.map((i) => i.name)
      expect(new Set(names).size).toBe(names.length)

      // Every output's sourcePath must be in the blobPathMap.
      for (const out of outputs) {
        expect(blobPathMap.has(out.sourcePath)).toBe(true)
        const blobPath = blobPathMap.get(out.sourcePath)!
        expect(blobPath.startsWith('/document/')).toBe(true)
      }

      // All Shaper input names must be valid (alphanumeric + underscore).
      for (const input of shaperInputs) {
        const name = input.name as string
        expect(name).toMatch(/^[A-Za-z0-9_]+$/)
      }
    })
  }

  it('doc-level outputs become simple { name, source } inputs', () => {
    const outputs = extractSkillOutputs(
      BUILT_IN_SKILLSETS.find((t) => t.id === 'keyPhrases')!.skillset,
    )
    const { shaperInputs } = buildShaperInputs(outputs)

    // content + keyPhrases = 2 inputs
    expect(shaperInputs).toHaveLength(2)
    expect(shaperInputs[1]).toEqual({
      name: 'keyPhrases',
      source: '/document/keyPhrases',
    })
  })

  it('nested-context outputs become sourceContext grouped inputs', () => {
    const outputs = extractSkillOutputs(
      BUILT_IN_SKILLSETS.find((t) => t.id === 'ocr')!.skillset,
    )
    const { shaperInputs } = buildShaperInputs(outputs)

    // content + 1 nested group = 2 inputs
    expect(shaperInputs).toHaveLength(2)
    const nestedGroup = shaperInputs[1]
    expect(nestedGroup.sourceContext).toBe('/document/normalized_images/*')
    expect(nestedGroup.name).toBe('normalized_images')
    expect(Array.isArray(nestedGroup.inputs)).toBe(true)
    const nestedInputs = nestedGroup.inputs as Array<Record<string, unknown>>
    expect(nestedInputs[0].name).toBe('ocrText')
    expect(nestedInputs[0].source).toBe('/document/normalized_images/*/ocrText')
  })

  it('ImageAnalysis: multiple outputs in same nested context share one group', () => {
    const outputs = extractSkillOutputs(
      BUILT_IN_SKILLSETS.find((t) => t.id === 'imageAnalysis')!.skillset,
    )
    const { shaperInputs } = buildShaperInputs(outputs)

    // content + 1 nested group = 2 top-level inputs
    expect(shaperInputs).toHaveLength(2)
    const nestedGroup = shaperInputs[1]
    expect(nestedGroup.sourceContext).toBe('/document/normalized_images/*')
    const nestedInputs = nestedGroup.inputs as Array<Record<string, unknown>>
    expect(nestedInputs).toHaveLength(2)
    expect(nestedInputs.map((i) => i.name)).toEqual(
      expect.arrayContaining(['imageDescription', 'imageTags']),
    )
  })
})

// ===========================================================================
// makeDebugCaptureFieldName
// ===========================================================================

describe('makeDebugCaptureFieldName', () => {
  for (const template of BUILT_IN_SKILLSETS) {
    it(`generates valid field names for all ${template.label} outputs`, () => {
      const outputs = extractSkillOutputs(template.skillset)
      const usedFieldNames = new Map<string, number>()

      for (const out of outputs) {
        const fieldName = makeDebugCaptureFieldName({
          skillName: out.skillName,
          outputName: out.outputName,
          usedFieldNames,
        })
        expect(fieldName).toBeTruthy()
        expect(fieldName.startsWith('dbg__')).toBe(true)
        expect(fieldName.length).toBeLessThanOrEqual(128)
        // Must be a valid Azure Search field name
        expect(fieldName).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/)
      }
    })
  }

  it('generates unique field names for skills with same output name', () => {
    const usedFieldNames = new Map<string, number>()
    const name1 = makeDebugCaptureFieldName({
      skillName: 'skill1',
      outputName: 'text',
      usedFieldNames,
    })
    const name2 = makeDebugCaptureFieldName({
      skillName: 'skill1',
      outputName: 'text',
      usedFieldNames,
    })
    expect(name1).not.toBe(name2)
  })
})

// ===========================================================================
// resolveOutputsWithBlobPaths — end-to-end per-skill
// ===========================================================================

describe('resolveOutputsWithBlobPaths', () => {
  for (const template of BUILT_IN_SKILLSETS) {
    it(`resolves outputs with blobPaths for ${template.label} (${template.id})`, () => {
      const extractedOutputs = extractSkillOutputs(template.skillset)
      const { resolvedOutputs, shaperInputs } = resolveOutputsWithBlobPaths(extractedOutputs)

      expect(resolvedOutputs).toHaveLength(template.expectedOutputCount)

      for (const ro of resolvedOutputs) {
        // Every resolved output must have a fieldName and a blobPath.
        expect(ro.fieldName).toBeTruthy()
        expect(ro.blobPath).toBeTruthy()
        expect(ro.blobPath!.startsWith('/document/')).toBe(true)

        // For doc-level outputs, blobPath should match /document/{inputName}
        if (ro.context === '/document') {
          expect(ro.blobPath).toMatch(/^\/document\/[A-Za-z0-9_]+$/)
        }
        // For nested outputs, blobPath should match /document/{groupName}/*/{subName}
        else {
          expect(ro.blobPath).toMatch(/^\/document\/[A-Za-z0-9_]+\/\*\/[A-Za-z0-9_]+$/)
        }
      }

      // Shaper inputs must include the content seed.
      expect(shaperInputs[0]).toEqual({ name: 'content', source: '/document/content' })

      // All fieldNames must be unique.
      const fieldNames = resolvedOutputs.map((r) => r.fieldName)
      expect(new Set(fieldNames).size).toBe(fieldNames.length)
    })
  }
})

// ===========================================================================
// Name collision scenarios
// ===========================================================================

describe('name collision handling', () => {
  it('handles doc-level output named "content" (collision with seed)', () => {
    const outputs = extractSkillOutputs({
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Util.DocumentExtractionSkill',
          name: 'docExtract',
          context: '/document',
          outputs: [
            { name: 'content', targetName: 'content' },
            { name: 'normalized_images', targetName: 'normalized_images' },
          ],
        },
      ],
    })

    const { shaperInputs, blobPathMap } = buildShaperInputs(outputs)

    // "content" is already the seed → skill output should get "content_1" or similar
    const shaperNames = shaperInputs.map((i) => i.name)
    expect(new Set(shaperNames).size).toBe(shaperNames.length)

    // The blobPath for /document/content should be renamed (not /document/content)
    const contentBlobPath = blobPathMap.get('/document/content')
    expect(contentBlobPath).toBeTruthy()
    expect(contentBlobPath).not.toBe('/document/content')
  })

  it('handles two skills outputting to the same context with same target name', () => {
    const outputs = extractSkillOutputs({
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
          name: 'split1',
          context: '/document',
          outputs: [{ name: 'textItems', targetName: 'pages' }],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
          name: 'split2',
          context: '/document',
          outputs: [{ name: 'textItems', targetName: 'pages' }],
        },
      ],
    })

    const { shaperInputs } = buildShaperInputs(outputs)
    const shaperNames = shaperInputs.map((i) => i.name)
    expect(new Set(shaperNames).size).toBe(shaperNames.length)
  })

  it('handles nested group name colliding with doc-level output name', () => {
    // SplitSkill outputs "pages" at /document, then KeyPhraseExtraction at /document/pages/*
    // → The nested group would want to be named "pages" but it collides.
    const outputs = extractSkillOutputs({
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
          name: 'split',
          context: '/document',
          outputs: [{ name: 'textItems', targetName: 'pages' }],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
          name: 'kpe',
          context: '/document/pages/*',
          outputs: [{ name: 'keyPhrases', targetName: 'keyPhrases' }],
        },
      ],
    })

    const { shaperInputs, blobPathMap } = buildShaperInputs(outputs)

    // All shaperInput names must be unique.
    const names = shaperInputs.map((i) => i.name)
    expect(new Set(names).size).toBe(names.length)

    // The nested group for /document/pages/* should NOT be named "pages" (collision).
    const nestedGroup = shaperInputs.find((i) => i.sourceContext === '/document/pages/*')
    expect(nestedGroup).toBeTruthy()
    expect(nestedGroup!.name).not.toBe('pages')

    // blobPath for keyPhrases should use the renamed group.
    const kpBlobPath = blobPathMap.get('/document/pages/*/keyPhrases')
    expect(kpBlobPath).toBeTruthy()
    expect(kpBlobPath).not.toContain('/document/pages/')
    // It should be something like /document/pages_2/*/keyPhrases
    expect(kpBlobPath).toMatch(/^\/document\/[A-Za-z0-9_]+\/\*\/keyPhrases$/)
  })

  it('handles subName collision within same nested group', () => {
    const outputs = extractSkillOutputs({
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
          name: 'kpe1',
          context: '/document/pages/*',
          outputs: [{ name: 'keyPhrases', targetName: 'keyPhrases' }],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.LanguageDetectionSkill',
          name: 'lang',
          context: '/document/pages/*',
          outputs: [{ name: 'languageCode', targetName: 'keyPhrases' }],
        },
      ],
    })

    const { shaperInputs } = buildShaperInputs(outputs)
    const nestedGroup = shaperInputs.find((i) => i.sourceContext === '/document/pages/*')
    expect(nestedGroup).toBeTruthy()
    const nestedInputs = nestedGroup!.inputs as Array<Record<string, unknown>>
    expect(nestedInputs).toHaveLength(2)

    // Sub-names must be unique.
    const subNames = nestedInputs.map((i) => i.name)
    expect(new Set(subNames).size).toBe(subNames.length)
  })
})

// ===========================================================================
// Complex multi-skill pipeline tests
// ===========================================================================

describe('complex multi-skill pipelines', () => {
  it('SplitSkill + KeyPhraseExtraction + EntityRecognition pipeline', () => {
    const skillset = {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
          name: 'split',
          context: '/document',
          outputs: [{ name: 'textItems', targetName: 'pages' }],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
          name: 'kpe',
          context: '/document/pages/*',
          outputs: [{ name: 'keyPhrases', targetName: 'keyPhrases' }],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.V3.EntityRecognitionSkill',
          name: 'ner',
          context: '/document/pages/*',
          outputs: [{ name: 'persons', targetName: 'persons' }],
        },
      ],
    }

    const outputs = extractSkillOutputs(skillset)
    expect(outputs).toHaveLength(3)

    const { resolvedOutputs, shaperInputs } = resolveOutputsWithBlobPaths(outputs)
    expect(resolvedOutputs).toHaveLength(3)

    // Shaper: content + pages (doc-level) + 1 nested group for /document/pages/*
    expect(shaperInputs).toHaveLength(3)

    // Nested group should contain both keyPhrases and persons
    const nestedGroup = shaperInputs.find((i) => i.sourceContext === '/document/pages/*')
    expect(nestedGroup).toBeTruthy()
    const nested = nestedGroup!.inputs as Array<Record<string, unknown>>
    expect(nested).toHaveLength(2)
    expect(nested.map((i) => i.name)).toEqual(
      expect.arrayContaining(['keyPhrases', 'persons']),
    )

    // All blobPaths must be unique
    const blobPaths = resolvedOutputs.map((r) => r.blobPath)
    expect(new Set(blobPaths).size).toBe(blobPaths.length)

    // All fieldNames must be unique
    const fieldNames = resolvedOutputs.map((r) => r.fieldName)
    expect(new Set(fieldNames).size).toBe(fieldNames.length)
  })

  it('full pipeline: SplitSkill + KeyPhrase + Sentiment + LanguageDetection + Embedding', () => {
    const skillset = {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Text.LanguageDetectionSkill',
          name: 'lang',
          context: '/document',
          outputs: [{ name: 'languageCode', targetName: 'languageCode' }],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
          name: 'split',
          context: '/document',
          outputs: [{ name: 'textItems', targetName: 'pages' }],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
          name: 'kpe',
          context: '/document/pages/*',
          outputs: [{ name: 'keyPhrases', targetName: 'keyPhrases' }],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.V3.SentimentSkill',
          name: 'sentiment',
          context: '/document/pages/*',
          outputs: [
            { name: 'sentiment', targetName: 'sentiment' },
            { name: 'confidenceScores', targetName: 'confidenceScores' },
          ],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill',
          name: 'embedding',
          context: '/document/pages/*',
          outputs: [{ name: 'embedding', targetName: 'embedding' }],
        },
      ],
    }

    const outputs = extractSkillOutputs(skillset)
    // lang(1) + split(1) + kpe(1) + sentiment(2) + embedding(1) = 6
    expect(outputs).toHaveLength(6)

    const { resolvedOutputs, shaperInputs } = resolveOutputsWithBlobPaths(outputs)

    // content + languageCode + pages (doc-level) + 1 nested group for pages/* = 4
    expect(shaperInputs).toHaveLength(4)

    // Nested group for /document/pages/* should have 4 outputs
    const nestedGroup = shaperInputs.find((i) => i.sourceContext === '/document/pages/*')
    expect(nestedGroup).toBeTruthy()
    const nested = nestedGroup!.inputs as Array<Record<string, unknown>>
    expect(nested).toHaveLength(4)

    // All names are unique
    const allNames = shaperInputs.map((i) => i.name as string)
    expect(new Set(allNames).size).toBe(allNames.length)

    // All blobPaths are unique  
    const allBlobPaths = resolvedOutputs.map((r) => r.blobPath)
    expect(new Set(allBlobPaths).size).toBe(allBlobPaths.length)
  })

  it('OCR + TextMerge + SplitSkill pipeline with mixed contexts', () => {
    const skillset = {
      skills: [
        {
          '@odata.type': '#Microsoft.Skills.Vision.OcrSkill',
          name: 'ocr',
          context: '/document/normalized_images/*',
          outputs: [{ name: 'text', targetName: 'ocrText' }],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.MergeSkill',
          name: 'merge',
          context: '/document',
          outputs: [{ name: 'mergedText', targetName: 'mergedText' }],
        },
        {
          '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
          name: 'split',
          context: '/document',
          outputs: [{ name: 'textItems', targetName: 'chunks' }],
        },
      ],
    }

    const outputs = extractSkillOutputs(skillset)
    expect(outputs).toHaveLength(3)

    const { shaperInputs, blobPathMap } = buildShaperInputs(outputs)

    // content + mergedText + chunks (doc-level) + 1 nested group for normalized_images/* = 4
    expect(shaperInputs).toHaveLength(4)

    // OCR output should be nested
    const nestedGroup = shaperInputs.find((i) => i.sourceContext === '/document/normalized_images/*')
    expect(nestedGroup).toBeTruthy()
    expect(nestedGroup!.name).toBe('normalized_images')

    // Doc-level outputs should have simple blob paths
    expect(blobPathMap.get('/document/mergedText')).toBe('/document/mergedText')
    expect(blobPathMap.get('/document/chunks')).toBe('/document/chunks')

    // Nested output should have wildcard path
    expect(blobPathMap.get('/document/normalized_images/*/ocrText')).toBe(
      '/document/normalized_images/*/ocrText',
    )
  })

  it('all 14 built-in skills combined in one skillset', () => {
    const allSkills = BUILT_IN_SKILLSETS.flatMap((t) => {
      const skills = (t.skillset.skills as unknown[])
      return skills
    })

    const skillset = { skills: allSkills }
    const outputs = extractSkillOutputs(skillset)

    // Total outputs: sum of all expectedOutputCount
    const totalExpected = BUILT_IN_SKILLSETS.reduce((sum, t) => sum + t.expectedOutputCount, 0)
    expect(outputs).toHaveLength(totalExpected)

    const { resolvedOutputs, shaperInputs } = resolveOutputsWithBlobPaths(outputs)

    // All Shaper input names must be unique.
    const names = shaperInputs.map((i) => i.name as string)
    expect(new Set(names).size).toBe(names.length)

    // All field names must be unique.
    const fieldNames = resolvedOutputs.map((r) => r.fieldName)
    expect(new Set(fieldNames).size).toBe(fieldNames.length)

    // All blob paths must be set.
    for (const ro of resolvedOutputs) {
      expect(ro.blobPath).toBeTruthy()
    }

    // No Shaper input name should contain invalid characters.
    for (const input of shaperInputs) {
      const name = input.name as string
      expect(name).toMatch(/^[A-Za-z0-9_]+$/)
    }
  })
})
