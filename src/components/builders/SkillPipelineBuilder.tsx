/**
 * Skill Pipeline Builder.
 *
 * Assists authoring Azure AI Search skillsets by mapping each skill to a node
 * and showing a left-to-right flow. The underlying artifact is skillset JSON.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { ExpandableCodeMirror } from '../viewers/ExpandableCodeMirror'
import { githubDark, githubLight } from '@uiw/codemirror-theme-github'
import { json } from '@codemirror/lang-json'
import { EditorView } from '@codemirror/view'

import {
  ReactFlow,
  Controls,
  Background,
  Panel,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type NodeProps,
  type Connection,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import dagre from 'dagre'

import type { ConnectionProfile, SearchApiVersion } from '../../lib/model'
import { getIndexDefinition, getIndexerDefinition, getSkillset, listIndexers, listIndexes, listSkillsets } from '../../lib/aiSearchRest'

import type { ThemePreference } from '../../types/app'
import type { Language, TranslationKey } from '../../lib/translations'
import { translations } from '../../lib/translations'
import { SkillPipelineDebugRunner, type SkillPipelineDebugRunnerHandle } from './SkillPipelineDebugRunner'
import { SkillPipelineEnrichmentTreePreview } from './SkillPipelineEnrichmentTreePreview'
import {
  useSkillPipelineState,
  type SkillPipelineNode,
  type SkillPipelineEdge,
  type SkillPipelineSkillDefinition,
  type SkillPipelineIndexerDefinition,
  SKILL_PIPELINE_DOC_NODE_ID,
} from '../../contexts'

import {
  appendOutputFieldMappingToIndexer,
  removeOutputFieldMappingFromIndexer,
  type IndexerLike,
} from '../../utils/skillPipelineOutputFieldMappings'
import { usePublishFlow } from '../../hooks/usePublishFlow'
import { PublishDiffModal } from './PublishDiffModal'

type SkillPipelineEdgeLinkData = {
  sourcePath?: string
  targetInputName?: string
  created?: boolean
  prevSource?: string | null
  /** Stored when an array-producing source auto-sets the target skill's context. */
  prevContext?: string | null
}

type IndexerOutputMappingEdgeData = {
  kind: 'indexerOfm'
  sourceFieldName: string
  targetFieldName: string
}

const SKILL_PIPELINE_INDEXER_NODE_ID = 'indexer'
const SKILL_PIPELINE_INDEX_NODE_ID = 'index'
const CUSTOM_WEB_API_SKILL_ODATA_TYPE = '#Microsoft.Skills.Custom.WebApiSkill'

const DAGRE_RANKSEP_PX = 140

const DOC_ROOT_DEFAULT = '/document'

const DOC_SOURCE_PORTS: Array<{ id: string; label: string; segment: string }> = [
  { id: 'root', label: 'root', segment: '' },
  { id: 'content', label: 'content', segment: 'content' },
  { id: 'normalized_images', label: 'normalized_images/*', segment: 'normalized_images/*' },
  { id: 'normalized_images_content', label: 'normalized_images/*/content', segment: 'normalized_images/*/content' },
  { id: 'normalized_images_ocrText', label: 'normalized_images/*/ocrText', segment: 'normalized_images/*/ocrText' },
]

const DOC_HANDLE_TO_SEGMENT: Record<string, string> = DOC_SOURCE_PORTS.reduce((acc, p) => {
  acc[p.id] = p.segment
  return acc
}, {} as Record<string, string>)

function inferDocSourceHandleForPath(sourcePath: string, docRoot: string): string | null {
  const root = (docRoot || DOC_ROOT_DEFAULT).trim() || DOC_ROOT_DEFAULT
  const s = (sourcePath || '').trim()
  if (!s) return null
  if (s === root) return 'root'

  const content = `${root}/content`
  if (s === content || s.startsWith(`${content}/`)) return 'content'

  const ocrText = `${root}/normalized_images/*/ocrText`
  if (s === ocrText || s.startsWith(`${ocrText}/`)) return 'normalized_images_ocrText'

  const normContent = `${root}/normalized_images/*/content`
  if (s === normContent || s.startsWith(`${normContent}/`)) return 'normalized_images_content'

  const normalized = `${root}/normalized_images/*`
  if (s === normalized || s.startsWith(`${normalized}/`)) return 'normalized_images'

  return null
}

/**
 * Registry of built-in skill outputs that produce Collection (array) types.
 * When a connection is made FROM one of these outputs to a downstream skill,
 * the target skill's context and input source are automatically given the
 * `/*` wildcard suffix so that the skill iterates over each element.
 *
 * Key format: `@odata.type::outputName`
 *
 * Embedding vectors (Collection(Edm.Single)) are intentionally excluded
 * because they represent a single vector value, not an iterable sequence.
 *
 * References:
 *   https://learn.microsoft.com/azure/search/cognitive-search-predefined-skills
 */
const COLLECTION_OUTPUT_REGISTRY: ReadonlySet<string> = new Set([
  // SplitSkill — all outputs are parallel arrays
  '#Microsoft.Skills.Text.SplitSkill::textItems',
  '#Microsoft.Skills.Text.SplitSkill::offsets',
  '#Microsoft.Skills.Text.SplitSkill::lengths',
  '#Microsoft.Skills.Text.SplitSkill::ordinalPositions',
  // KeyPhraseExtractionSkill
  '#Microsoft.Skills.Text.KeyPhraseExtractionSkill::keyPhrases',
  // PIIDetectionSkill
  '#Microsoft.Skills.Text.PIIDetectionSkill::piiEntities',
  // SentimentSkill V3
  '#Microsoft.Skills.Text.V3.SentimentSkill::sentences',
  // EntityRecognitionSkill V3 — all category outputs are string arrays
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::persons',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::locations',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::organizations',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::quantities',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::dateTimes',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::urls',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::emails',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::personTypes',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::events',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::products',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::skills',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::addresses',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::phoneNumbers',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::ipAddresses',
  '#Microsoft.Skills.Text.V3.EntityRecognitionSkill::namedEntities',
  // EntityLinkingSkill V3
  '#Microsoft.Skills.Text.V3.EntityLinkingSkill::entities',
  // ImageAnalysisSkill
  '#Microsoft.Skills.Vision.ImageAnalysisSkill::brands',
  '#Microsoft.Skills.Vision.ImageAnalysisSkill::categories',
  '#Microsoft.Skills.Vision.ImageAnalysisSkill::faces',
  '#Microsoft.Skills.Vision.ImageAnalysisSkill::objects',
  '#Microsoft.Skills.Vision.ImageAnalysisSkill::tags',
  // DocumentExtractionSkill
  '#Microsoft.Skills.Util.DocumentExtractionSkill::normalized_images',
])

/**
 * Returns `true` when the primary (first) output of `node` is a Collection
 * type according to `COLLECTION_OUTPUT_REGISTRY`.
 */
function isSourceOutputCollection(node: SkillPipelineNode): boolean {
  if (node.data.kind !== 'skill') return false
  const skill = node.data.skill
  const odataType = typeof skill['@odata.type'] === 'string' ? skill['@odata.type'] : ''
  const outputs = Array.isArray(skill.outputs) ? skill.outputs : []
  if (!odataType || outputs.length === 0) return false
  const primaryOutputName = typeof outputs[0].name === 'string' ? outputs[0].name : ''
  return COLLECTION_OUTPUT_REGISTRY.has(`${odataType}::${primaryOutputName}`)
}

type BuiltInSkillTemplate = {
  id: string
  label: string
  skill: SkillPipelineSkillDefinition
}

const BUILT_IN_SKILL_TEMPLATES: BuiltInSkillTemplate[] = [
  {
    id: 'textSplit',
    label: 'spbSkillTextSplit',
    skill: {
      '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
      name: 'splitText',
      context: '/document',
      // The docs describe this as the primary configuration surface.
      // Providing defaults makes the template runnable immediately.
      textSplitMode: 'pages',
      maximumPageLength: 5000,
      pageOverlapLength: 0,
      defaultLanguageCode: 'en',
      inputs: [{ name: 'text', source: '/document/content' }],
      outputs: [{ name: 'textItems', targetName: 'pages' }],
    },
  },
  {
    id: 'keyPhrases',
    label: 'spbSkillKeyPhrase',
    skill: {
      '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
      name: 'keyPhrases',
      context: '/document',
      defaultLanguageCode: 'en',
      inputs: [{ name: 'text', source: '/document/content' }],
      outputs: [{ name: 'keyPhrases', targetName: 'keyPhrases' }],
    },
  },
  {
    id: 'languageDetection',
    label: 'spbSkillLanguageDetection',
    skill: {
      '@odata.type': '#Microsoft.Skills.Text.LanguageDetectionSkill',
      name: 'languageDetection',
      context: '/document',
      inputs: [{ name: 'text', source: '/document/content' }],
      outputs: [{ name: 'languageCode', targetName: 'languageCode' }],
    },
  },
  {
    id: 'piiDetection',
    label: 'spbSkillPiiDetection',
    skill: {
      '@odata.type': '#Microsoft.Skills.Text.PIIDetectionSkill',
      name: 'piiDetection',
      context: '/document',
      // Make maskedText output meaningful by default.
      // Docs: maskingMode 'none' (default) does not return maskedText.
      defaultLanguageCode: 'en',
      maskingMode: 'replace',
      maskingCharacter: '*',
      inputs: [{ name: 'text', source: '/document/content' }],
      outputs: [
        { name: 'piiEntities', targetName: 'piiEntities' },
        { name: 'maskedText', targetName: 'maskedText' },
      ],
    },
  },
  {
    id: 'textTranslation',
    label: 'spbSkillTextTranslation',
    skill: {
      '@odata.type': '#Microsoft.Skills.Text.TranslationSkill',
      name: 'translateText',
      context: '/document',
      // Required per docs: defaultToLanguageCode.
      defaultToLanguageCode: 'en',
      inputs: [{ name: 'text', source: '/document/content' }],
      outputs: [
        { name: 'translatedText', targetName: 'translatedText' },
        { name: 'translatedToLanguageCode', targetName: 'translatedToLanguageCode' },
        { name: 'translatedFromLanguageCode', targetName: 'translatedFromLanguageCode' },
      ],
    },
  },
  {
    id: 'sentimentV3',
    label: 'spbSkillSentiment',
    skill: {
      '@odata.type': '#Microsoft.Skills.Text.V3.SentimentSkill',
      name: 'sentiment',
      context: '/document',
      defaultLanguageCode: 'en',
      includeOpinionMining: false,
      inputs: [{ name: 'text', source: '/document/content' }],
      outputs: [
        { name: 'sentiment', targetName: 'sentiment' },
        { name: 'confidenceScores', targetName: 'confidenceScores' },
      ],
    },
  },
  {
    id: 'entityRecognitionV3',
    label: 'spbSkillEntityRecognition',
    skill: {
      '@odata.type': '#Microsoft.Skills.Text.V3.EntityRecognitionSkill',
      name: 'entities',
      context: '/document',
      // Match the template output (persons) to a constrained category.
      categories: ['Person'],
      defaultLanguageCode: 'en',
      inputs: [{ name: 'text', source: '/document/content' }],
      outputs: [{ name: 'persons', targetName: 'persons' }],
    },
  },
  {
    id: 'entityLinkingV3',
    label: 'spbSkillEntityLinking',
    skill: {
      '@odata.type': '#Microsoft.Skills.Text.V3.EntityLinkingSkill',
      name: 'entityLinks',
      context: '/document',
      defaultLanguageCode: 'en',
      inputs: [{ name: 'text', source: '/document/content' }],
      outputs: [{ name: 'entities', targetName: 'entities' }],
    },
  },
  {
    id: 'ocr',
    label: 'spbSkillOcr',
    skill: {
      '@odata.type': '#Microsoft.Skills.Vision.OcrSkill',
      name: 'ocr',
      context: '/document/normalized_images/*',
      defaultLanguageCode: 'en',
      inputs: [{ name: 'image', source: '/document/normalized_images/*' }],
      outputs: [{ name: 'text', targetName: 'ocrText' }],
    },
  },
  {
    id: 'imageAnalysis',
    label: 'spbSkillImageAnalysis',
    skill: {
      '@odata.type': '#Microsoft.Skills.Vision.ImageAnalysisSkill',
      name: 'imageAnalysis',
      context: '/document/normalized_images/*',
      // Keep it minimal but valid; users can add/remove features.
      defaultLanguageCode: 'en',
      visualFeatures: ['description', 'tags'],
      inputs: [{ name: 'image', source: '/document/normalized_images/*' }],
      outputs: [
        { name: 'description', targetName: 'imageDescription' },
        { name: 'tags', targetName: 'imageTags' },
      ],
    } as any,
  },
  {
    id: 'textMerge',
    label: 'spbSkillTextMerge',
    skill: {
      '@odata.type': '#Microsoft.Skills.Text.MergeSkill',
      name: 'mergeText',
      context: '/document',
      insertPreTag: ' ',
      insertPostTag: ' ',
      inputs: [
        { name: 'text', source: '/document/content' },
        // Common scenario: merge OCR text back into the main content using offsets from normalized images.
        { name: 'itemsToInsert', source: '/document/normalized_images/*/ocrText' },
        { name: 'offsets', source: '/document/normalized_images/*/contentOffset' },
      ],
      outputs: [{ name: 'mergedText', targetName: 'mergedText' }],
    },
  },
  {
    id: 'conditional',
    label: 'spbSkillConditional',
    skill: {
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
  },
  {
    id: 'documentExtraction',
    label: 'spbSkillDocumentExtraction',
    skill: {
      '@odata.type': '#Microsoft.Skills.Util.DocumentExtractionSkill',
      name: 'documentExtraction',
      context: '/document',
      inputs: [{ name: 'file_data', source: '/document/file_data' }],
      outputs: [
        { name: 'content', targetName: 'content' },
        { name: 'normalized_images', targetName: 'normalized_images' },
      ],
    } as any,
  },
  {
    id: 'azureOpenAIEmbedding',
    label: 'spbSkillAzureOpenAIEmbedding',
    skill: {
      '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill',
      name: 'embedding',
      context: '/document',
      // Required per docs: resourceUri, deploymentId, modelName.
      resourceUri: 'https://YOUR-RESOURCE.openai.azure.com',
      deploymentId: 'YOUR-EMBEDDING-DEPLOYMENT',
      modelName: 'text-embedding-3-small',
      inputs: [{ name: 'text', source: '/document/content' }],
      outputs: [{ name: 'embedding', targetName: 'embedding' }],
    } as any,
  },
  {
    id: 'genAIPrompt',
    label: 'spbSkillGenAIPrompt',
    skill: {
      '@odata.type': '#Microsoft.Skills.Custom.ChatCompletionSkill',
      name: 'genAIPrompt',
      context: '/document',
      // Required per docs: uri (public endpoint of the deployed model).
      uri: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/gpt-4o/chat/completions',
      apiKey: '',
      inputs: [
        { name: 'text', source: '/document/content' },
        { name: 'systemMessage', source: "='You are a helpful AI assistant.'" },
        { name: 'userMessage', source: "='Summarize the following text:'" },
      ],
      outputs: [{ name: 'response', targetName: 'response' }],
      commonModelParameters: { temperature: 0.7, maxTokens: 1024 },
    } as any,
  },
  {
    id: 'customWebApi',
    label: 'spbSkillCustomWebApi',
    skill: {
      '@odata.type': CUSTOM_WEB_API_SKILL_ODATA_TYPE,
      name: 'customWebApi',
      context: '/document',
      // Required per docs: uri (HTTPS endpoint of the custom Web API).
      uri: 'https://YOUR-FUNCTION-APP.azurewebsites.net/api/your-skill',
      httpMethod: 'POST',
      batchSize: 1000,
      inputs: [{ name: 'text', source: '/document/content' }],
      outputs: [{ name: 'result', targetName: 'customResult' }],
    } as any,
  },
]

function cloneBuiltInSkillTemplate(templateId: string, fallbackSkillNumber: number): SkillPipelineSkillDefinition {
  const found = BUILT_IN_SKILL_TEMPLATES.find((t) => t.id === templateId)
  const base = found?.skill
  const cloned: SkillPipelineSkillDefinition = JSON.parse(JSON.stringify(base ?? {}))
  const currentName = typeof cloned.name === 'string' && cloned.name.trim() ? cloned.name.trim() : `skill${fallbackSkillNumber}`
  cloned.name = currentName
  if (typeof cloned.context !== 'string' || !cloned.context.trim()) cloned.context = '/document'
  if (!Array.isArray((cloned as any).inputs)) (cloned as any).inputs = []
  if (!Array.isArray((cloned as any).outputs)) (cloned as any).outputs = []
  return cloned
}

/**
 * Collect all enrichment-tree paths produced by existing skill nodes.
 * Each path is `context + "/" + targetName`.
 */
function collectExistingOutputPaths(nodes: SkillPipelineNode[]): Set<string> {
  const paths = new Set<string>()
  for (const n of nodes) {
    if ((n as any)?.data?.kind !== 'skill') continue
    const skill = (n as any).data.skill as SkillPipelineSkillDefinition | undefined
    if (!skill) continue
    const ctx = typeof skill.context === 'string' ? skill.context : '/document'
    const outputs = Array.isArray(skill.outputs) ? skill.outputs : []
    for (const o of outputs) {
      const tn = typeof o?.targetName === 'string' ? o.targetName.trim() : ''
      const nm = typeof o?.name === 'string' ? o.name.trim() : ''
      const seg = tn || nm
      if (seg) paths.add(joinPath(ctx, seg))
    }
  }
  return paths
}

/**
 * Deduplicate the output targetNames of a new skill against paths already
 * occupied by existing skills.  Appends `_2`, `_3`, … until unique.
 */
function deduplicateOutputTargetNames(
  skill: SkillPipelineSkillDefinition,
  existingPaths: Set<string>,
): void {
  const ctx = typeof skill.context === 'string' ? skill.context : '/document'
  const outputs = Array.isArray(skill.outputs) ? skill.outputs : []
  for (const o of outputs) {
    const baseName = typeof o.targetName === 'string' ? o.targetName.trim() : ''
    if (!baseName) continue
    let candidate = baseName
    let attempt = 2
    while (existingPaths.has(joinPath(ctx, candidate))) {
      candidate = `${baseName}_${attempt}`
      attempt++
    }
    if (candidate !== baseName) {
      o.targetName = candidate
    }
    // Register so subsequent outputs within the same skill don't collide.
    existingPaths.add(joinPath(ctx, candidate))
  }
}

type SkillPipelineBuilderProps = {
  t: (key: TranslationKey) => string
  language: Language
  theme: ThemePreference
  copyToClipboard: (text: string) => Promise<void>
  onOpenSkillEditor?: (nodeId: string) => void

  profile: ConnectionProfile | null
  apiVersion: SearchApiVersion
}

/** Module-level language & translator so sub-components (custom ReactFlow nodes) can access i18n without prop drilling. */
let _spbLang: Language = 'en'
function _t(key: TranslationKey): string {
  return String((translations as any)[_spbLang]?.[key] ?? (translations as any)['en']?.[key] ?? key)
}

function SkillPipelineSkillNode(props: NodeProps<SkillPipelineNode>) {
  const { data, selected } = props
  const skill = (data as any)?.kind === 'skill' ? ((data as any).skill as SkillPipelineSkillDefinition) : undefined
  const name = typeof skill?.name === 'string' ? skill.name.trim() : ''
  const odataType = typeof skill?.['@odata.type'] === 'string' ? String(skill['@odata.type']).trim() : ''

  const shortTypeName = useMemo(() => {
    if (!odataType) return ''
    const cleaned = odataType.startsWith('#') ? odataType.slice(1) : odataType
    const parts = cleaned.split('.').filter(Boolean)
    return parts.length ? parts[parts.length - 1] : cleaned
  }, [odataType])

  const label = shortTypeName || name || _t('spbNodeFallbackSkill')

  const tag = (() => {
    const t = odataType
    if (!t) return null
    if (t.includes('.Skills.Util.') || t.includes('#Microsoft.Skills.Util.')) return { text: _t('spbTagUtil'), cls: 'spvStage__status--util' }
    if (t.includes('.Skills.Text.') || t.includes('#Microsoft.Skills.Text.')) return { text: _t('spbTagText'), cls: 'spvStage__status--text' }
    if (t.includes('.Skills.Custom.') || t.includes('#Microsoft.Skills.Custom.')) return { text: _t('spbTagCustom'), cls: 'spvStage__status--custom' }
    return { text: _t('spbTagSkill'), cls: 'spvStage__status--tag' }
  })()

  return (
    <div style={{ width: 260 }}>
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />

      <div
        className="spvStage spvStage--skill"
        style={{
          outline: selected ? '2px solid var(--accent)' : 'none',
          outlineOffset: 1,
        }}
      >
        <div className="spvStage__header">
          <div className="spvStage__title">
            <div className="spvStage__label">{label}</div>
            {tag ? <div className={`spvStage__status spvStage__status--tag ${tag.cls}`}>{tag.text}</div> : <div className="spvStage__status"></div>}
          </div>
          <div className="spvStage__meta">
            {name ? (
              <span className="mono mono--ellipsesSm" title={name}>
                {name}
              </span>
            ) : null}
            <span className="mono mono--ellipsesSm" title={odataType}>
              {odataType || ''}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function SkillPipelineDocumentNode(props: NodeProps<SkillPipelineNode>) {
  const { data, selected } = props
  const path = (data as any)?.kind === 'doc' && typeof (data as any).path === 'string' ? String((data as any).path) : '/document'

  return (
    <div style={{ width: 260 }}>
      <div
        className="spvStage spvStage--doc"
        style={{
          outline: selected ? '2px solid var(--accent)' : 'none',
          outlineOffset: 1,
        }}
      >
        <div className="spvStage__header">
          <div className="spvStage__title">
            <div className="spvStage__label">{_t('spbNodeDocument')}</div>
            <div className="spvStage__status spvStage__status--tag">{_t('spbNodeDocumentRoot')}</div>
          </div>
          <div className="spvStage__meta">
            <span className="mono mono--ellipsesSm" title={path}>
              {path}
            </span>
          </div>
        </div>

        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {DOC_SOURCE_PORTS.map((p) => {
            const fullPath = p.segment ? joinPath(path, p.segment) : (path || '/document')
            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span className="mono mono--ellipsesSm" title={fullPath}>
                  {fullPath}
                </span>
                <div style={{ position: 'relative', width: 16, height: 16, flex: '0 0 16px' }}>
                  <Handle
                    id={p.id}
                    type="source"
                    position={Position.Right}
                    style={{
                      width: 10,
                      height: 10,
                      border: '1px solid var(--border)',
                      background: 'var(--panel-2)',
                      right: -6,
                    }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function getProducedPathForConnection(sourceNode: SkillPipelineNode, sourceHandle?: string | null): string | null {
  if (sourceNode.data.kind === 'doc') {
    const base = getPrimaryProducedPath(sourceNode) ?? '/document'
    const handleId = typeof sourceHandle === 'string' && sourceHandle.trim() ? sourceHandle.trim() : 'root'
    const seg = DOC_HANDLE_TO_SEGMENT[handleId] ?? ''
    return seg ? joinPath(base, seg) : base
  }

  return getPrimaryProducedPath(sourceNode)
}

function SkillPipelineProjectionNode(props: NodeProps<SkillPipelineNode>) {
  const { data, selected } = props
  const targetIndexName = (data as any)?.kind === 'projection' && typeof (data as any).targetIndexName === 'string' ? String((data as any).targetIndexName) : ''
  const sourceContext = (data as any)?.kind === 'projection' && typeof (data as any).sourceContext === 'string' ? String((data as any).sourceContext) : ''
  const projectionCount = (data as any)?.kind === 'projection' && typeof (data as any).projectionCount === 'number' ? (data as any).projectionCount : null
  const fieldMappingCount = (data as any)?.kind === 'projection' && typeof (data as any).fieldMappingCount === 'number' ? (data as any).fieldMappingCount : null

  return (
    <div style={{ width: 260 }}>
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />

      <div
        className="spvStage spvStage--projection"
        style={{
          outline: selected ? '2px solid var(--accent)' : 'none',
          outlineOffset: 1,
        }}
      >
        <div className="spvStage__header">
          <div className="spvStage__title">
            <div className="spvStage__label">{_t('spbNodeIndexProjection')}</div>
            <div className="spvStage__status"></div>
          </div>
          <div className="spvStage__meta">
            <span className="mono mono--ellipsesSm" title={sourceContext}>
              {sourceContext || ''}
            </span>
            <span className="mono mono--ellipsesSm" title={targetIndexName}>
              {targetIndexName || ''}
            </span>
          </div>
        </div>

        <div className="spvStage__tableWrap">
          <div className="kv">
            <div className="kv__row">
              <div className="kv__k">{_t('spbNodeSelectorCount')}</div>
              <div className="kv__v" style={{ textAlign: 'right' }}>{projectionCount ?? '-'}</div>
            </div>
            <div className="kv__row">
              <div className="kv__k">{_t('spbNodeMappingCount')}</div>
              <div className="kv__v" style={{ textAlign: 'right' }}>{fieldMappingCount ?? '-'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SkillPipelineIndexNode(props: NodeProps<SkillPipelineNode>) {
  const { data, selected } = props
  const targetIndexName = (data as any)?.kind === 'index' && typeof (data as any).targetIndexName === 'string' ? String((data as any).targetIndexName) : ''
  const connectedFieldNames =
    (data as any)?.kind === 'index' && Array.isArray((data as any).connectedFieldNames)
      ? ((data as any).connectedFieldNames as unknown[]).map((x) => String(x)).filter(Boolean)
      : []
  const connectedSummary = connectedFieldNames.length ? connectedFieldNames.join(', ') : _t('spbNone')

  return (
    <div style={{ width: 260 }}>
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />

      <div
        className="spvStage spvStage--index"
        style={{
          outline: selected ? '2px solid var(--accent)' : 'none',
          outlineOffset: 1,
        }}
      >
        <div className="spvStage__header">
          <div className="spvStage__title">
            <div className="spvStage__label">{_t('spbNodeSearchIndex')}</div>
            <div className="spvStage__status"></div>
          </div>
          <div className="spvStage__meta">
            <span className="mono mono--ellipsesSm" title={targetIndexName}>
              {targetIndexName || ''}
            </span>
          </div>
        </div>

        <div className="spvStage__tableWrap">
          <div className="kv">
            <div className="kv__row">
              <div className="kv__k">{_t('spbNodeOutputFieldMappings')}</div>
              <div className="kv__v mono mono--ellipsesSm" style={{ textAlign: 'right', maxWidth: 170 }} title={connectedSummary}>
                {connectedSummary}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SkillPipelineIndexerNode(props: NodeProps<SkillPipelineNode>) {
  const { data, selected } = props
  const indexerName =
    (data as any)?.kind === 'indexer' && typeof (data as any).indexerName === 'string' ? String((data as any).indexerName) : ''
  const targetIndexName =
    (data as any)?.kind === 'indexer' && typeof (data as any).targetIndexName === 'string' ? String((data as any).targetIndexName) : ''
  const outputCount =
    (data as any)?.kind === 'indexer' && typeof (data as any).outputFieldMappingCount === 'number' ? (data as any).outputFieldMappingCount : 0
  const fieldCount = (data as any)?.kind === 'indexer' && typeof (data as any).fieldMappingCount === 'number' ? (data as any).fieldMappingCount : 0

  return (
    <div style={{ width: 260 }}>
      <Handle
        type="target"
        position={Position.Left}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />
      <Handle
        type="source"
        position={Position.Right}
        style={{
          width: 10,
          height: 10,
          border: '1px solid var(--border)',
          background: 'var(--panel-2)',
        }}
      />

      <div
        className="spvStage spvStage--projection"
        style={{
          outline: selected ? '2px solid var(--accent)' : 'none',
          outlineOffset: 1,
        }}
      >
        <div className="spvStage__header">
          <div className="spvStage__title">
            <div className="spvStage__label">{_t('spbNodeIndexer')}</div>
            <div className="spvStage__status"></div>
          </div>
          <div className="spvStage__meta">
            <span className="mono mono--ellipsesSm" title={indexerName}>
              {indexerName || ''}
            </span>
            <span className="mono mono--ellipsesSm" title={targetIndexName}>
              {targetIndexName || ''}
            </span>
          </div>
        </div>

        <div className="spvStage__tableWrap">
          <div className="kv">
            <div className="kv__row">
              <div className="kv__k">{_t('spbNodeFieldMappings')}</div>
              <div className="kv__v" style={{ textAlign: 'right' }}>
                {fieldCount}
              </div>
            </div>
            <div className="kv__row">
              <div className="kv__k">{_t('spbNodeOutputFieldMappings')}</div>
              <div className="kv__v" style={{ textAlign: 'right' }}>
                {outputCount}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function ensureJsonObject(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {}
}

function getNodeDims(n: SkillPipelineNode): { width: number; height: number } {
  const kind = (n as any)?.data?.kind
  if (kind === 'projection') return { width: 260, height: 200 }
  if (kind === 'indexer') return { width: 260, height: 150 }
  return { width: 260, height: 88 }
}

function getNodeRight(n: SkillPipelineNode): number {
  const { width } = getNodeDims(n)
  const x = typeof n.position?.x === 'number' ? n.position.x : 0
  return x + width
}

function recommendIndexerX(nodes: SkillPipelineNode[]): number {
  const flowNodes = nodes.filter((n) => {
    const kind = (n as any)?.data?.kind
    return kind === 'doc' || kind === 'skill' || kind === 'projection'
  })
  if (!flowNodes.length) return 1300
  const maxRight = Math.max(...flowNodes.map(getNodeRight))
  return maxRight + DAGRE_RANKSEP_PX
}

function applyDagreLayout(inputNodes: SkillPipelineNode[], inputEdges: SkillPipelineEdge[]): SkillPipelineNode[] {
  const fixedIds = new Set(
    inputNodes
      .filter((n) => (n as any)?.data?.kind === 'indexer')
      .map((n) => String(n.id))
      .filter(Boolean),
  )

  const layoutNodes = inputNodes.filter((n) => !fixedIds.has(String(n.id)))
  const layoutEdges = inputEdges.filter((e) => !fixedIds.has(String((e as any).source)) && !fixedIds.has(String((e as any).target)))

  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 80, ranksep: DAGRE_RANKSEP_PX })

  for (const n of layoutNodes) {
    const { width, height } = getNodeDims(n)
    g.setNode(n.id, { width, height })
  }
  for (const e of layoutEdges) g.setEdge(e.source, e.target)

  dagre.layout(g)

  const laidOut = layoutNodes.map((n) => {
    const p = g.node(n.id)
    if (!p) return n
    const { width, height } = getNodeDims(n)
    return {
      ...n,
      position: { x: p.x - width / 2, y: p.y - height / 2 },
    }
  })

  const byId = new Map(laidOut.map((n) => [String(n.id), n]))

  let next = inputNodes.map((n) => byId.get(String(n.id)) ?? n)

  // Keep the indexer node close to the right-most stage to avoid overly long edges.
  const idx = next.findIndex((n) => (n as any)?.data?.kind === 'indexer')
  if (idx >= 0) {
    const cur = next[idx]
    const y = typeof cur.position?.y === 'number' ? cur.position.y : 140
    const x = recommendIndexerX(next)
    next = next.map((n, i) => (i === idx ? ({ ...cur, position: { x, y } } as any) : n))
  }

  const indexerNode = next.find((n) => (n as any)?.data?.kind === 'indexer') ?? null
  if (indexerNode) {
    const { width: indexerWidth, height: indexerHeight } = getNodeDims(indexerNode)
    const indexNodes = next.filter((n) => (n as any)?.data?.kind === 'index')
    const { height: indexHeight } = indexNodes.length
      ? getNodeDims(indexNodes[0])
      : getNodeDims({ id: 'index', type: 'index', position: { x: 0, y: 0 }, data: { kind: 'index' } as any } as any)

    const baseX = (indexerNode.position?.x ?? 0) + indexerWidth + DAGRE_RANKSEP_PX
    const baseY = (indexerNode.position?.y ?? 0) + (indexerHeight - indexHeight) / 2

    // Place each index node to the right of the indexer. If multiple exist, stack vertically.
    const indexPosById = new Map<string, { x: number; y: number }>()
    indexNodes.forEach((n, i) => {
      indexPosById.set(String(n.id), { x: baseX, y: baseY + i * (indexHeight + 40) })
    })

    next = next.map((n) => {
      const p = indexPosById.get(String(n.id))
      return p ? ({ ...n, position: p } as any) : n
    })
  }

  return next
}

function joinPath(context: string, segment: string): string {
  const ctxRaw = (context || '').trim() || '/document'
  const segRaw = (segment || '').trim()
  const ctx = ctxRaw.endsWith('/') ? ctxRaw.slice(0, -1) : ctxRaw
  if (!segRaw) return ctx
  return `${ctx}/${segRaw}`
}

function getPrimaryProducedPath(node: SkillPipelineNode): string | null {
  const data = node.data
  if (data.kind === 'doc') return typeof data.path === 'string' && data.path.trim() ? data.path.trim() : '/document'
  if (data.kind !== 'skill') return null

  const skill = data.skill
  const context = typeof skill.context === 'string' && skill.context.trim() ? skill.context.trim() : '/document'
  const outputs = Array.isArray(skill.outputs) ? skill.outputs : []
  const first = outputs.find((o) => {
    const seg = (typeof o?.targetName === 'string' ? o.targetName : '') || (typeof o?.name === 'string' ? o.name : '')
    return !!seg.trim()
  })
  if (first) {
    const seg = (typeof first.targetName === 'string' ? first.targetName : '') || (typeof first.name === 'string' ? first.name : '')
    return joinPath(context, seg)
  }
  // Fallback: the context itself is a valid JSON-path root.
  return context
}

/**
 * Returns ALL produced paths from a skill node's outputs.
 * Unlike getPrimaryProducedPath which returns only the first output,
 * this returns a path for every output defined on the skill.
 * This is critical for skills like EntityRecognitionSkill that have
 * multiple outputs (persons, locations, organizations, etc.).
 */
function getAllProducedPaths(node: SkillPipelineNode): string[] {
  const data = node.data
  if (data.kind === 'doc') {
    const p = typeof data.path === 'string' && data.path.trim() ? data.path.trim() : '/document'
    return [p]
  }
  if (data.kind !== 'skill') return []

  const skill = data.skill
  const context = typeof skill.context === 'string' && skill.context.trim() ? skill.context.trim() : '/document'
  const outputs = Array.isArray(skill.outputs) ? skill.outputs : []
  const paths: string[] = []
  for (const o of outputs) {
    const seg = (typeof o?.targetName === 'string' ? o.targetName : '') || (typeof o?.name === 'string' ? o.name : '')
    if (seg.trim()) paths.push(joinPath(context, seg))
  }
  // Fallback: if no outputs, use context itself.
  if (paths.length === 0) paths.push(context)
  return paths
}

function makeUniqueInputName(existing: Array<{ name: string }>, base: string): string {
  const used = new Set(existing.map((i) => (typeof i?.name === 'string' ? i.name : '').trim()).filter(Boolean))
  if (!used.has(base)) return base
  for (let n = 2; n < 200; n++) {
    const candidate = `${base}${n}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}${Date.now()}`
}

/** Returns the primary input name for a built-in skill @odata.type. */
function getPrimaryInputName(odataType: string): string {
  const t = (odataType || '').toLowerCase()
  if (t.includes('ocrskill') || t.includes('imageanalysisskill')) return 'image'
  if (t.includes('conditionalskill')) return 'condition'
  if (t.includes('documentextractionskill')) return 'file_data'
  if (t.includes('shaperskill')) return 'input'
  // All Text.* skills (Split, KeyPhrase, Sentiment, EntityRecognition,
  // EntityLinking, PII, Translation, LanguageDetection, Merge,
  // AzureOpenAIEmbedding, CustomEntityLookup) use "text".
  if (t.includes('microsoft.skills.text.')) return 'text'
  // Custom / WebApi / AmlSkill / unknown → generic fallback.
  return 'input'
}

function applyConnectionToTargetSkill(params: {
  targetSkill: SkillPipelineSkillDefinition
  sourcePath: string
  /** When true the source output is a Collection type and we auto-append `/*`. */
  sourceIsCollection?: boolean
}): { nextSkill: SkillPipelineSkillDefinition; link: SkillPipelineEdgeLinkData } {
  const { targetSkill, sourcePath, sourceIsCollection } = params

  // When the source produces a Collection, downstream skills must iterate
  // over each element using the /* wildcard in both context and input source.
  const effectivePath = sourceIsCollection ? `${sourcePath}/*` : sourcePath
  const nextContext = sourceIsCollection ? `${sourcePath}/*` : targetSkill.context
  const prevContext = sourceIsCollection ? targetSkill.context : null

  let inputs = Array.isArray(targetSkill.inputs) ? targetSkill.inputs.map((i) => ({ ...i })) : []

  // 1. If there's an input with an empty source, fill it in.
  const idx = inputs.findIndex((i) => typeof i?.source === 'string' && !i.source.trim())
  if (idx >= 0) {
    const prevSource = typeof inputs[idx].source === 'string' ? inputs[idx].source : ''
    inputs[idx].source = effectivePath
    const link: SkillPipelineEdgeLinkData = {
      sourcePath: effectivePath,
      targetInputName: inputs[idx].name,
      created: false,
      prevSource,
      prevContext,
    }
    return { nextSkill: { ...targetSkill, context: nextContext, inputs }, link }
  }

  // 2. For built-in skills with a FIXED input schema, overwrite the primary
  //    input's source instead of creating a new input with a suffixed name
  //    like "text2" — Azure AI Search rejects input names that aren't in
  //    the skill's supported list.
  //    Skills that accept arbitrary user-defined input names are excluded:
  //    - Custom.WebApiSkill / Custom.AmlSkill — custom code defines inputs
  //    - Util.ShaperSkill — multiple arbitrary inputs are its core purpose
  const odataType = typeof (targetSkill as any)['@odata.type'] === 'string' ? String((targetSkill as any)['@odata.type']) : ''
  const primaryName = getPrimaryInputName(odataType)
  const tLower = odataType.toLowerCase()
  const allowsArbitraryInputs = tLower.includes('.custom.') || tLower.includes('shaperskill')
  const isFixedSchema = tLower.startsWith('#microsoft.skills.') && !allowsArbitraryInputs

  // Clean up legacy auto-generated inputs like "text2" on fixed-schema built-in skills.
  // These inputs are rejected by Azure AI Search and can linger in older graphs.
  if (isFixedSchema && primaryName) {
    const escaped = primaryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const suffixedPrimaryRe = new RegExp(`^${escaped}\\d+$`)
    inputs = inputs.filter((i) => !suffixedPrimaryRe.test(String(i?.name ?? '')))
  }

  if (isFixedSchema) {
    // Try to find the existing primary input to overwrite
    const primaryIdx = inputs.findIndex((i) => i.name === primaryName)
    if (primaryIdx >= 0) {
      const prevSource = inputs[primaryIdx].source
      inputs[primaryIdx].source = effectivePath
      const link: SkillPipelineEdgeLinkData = {
        sourcePath: effectivePath,
        targetInputName: primaryName,
        created: false,
        prevSource,
        prevContext,
      }
      return { nextSkill: { ...targetSkill, context: nextContext, inputs }, link }
    }
  }

  // 3. Fallback: add a new input.
  //    - Custom / WebApi / Aml / Shaper skills support arbitrary input names.
  //    - For fixed-schema skills this only runs when primary input isn't found
  //      (shouldn't normally happen).
  const nextName = makeUniqueInputName(inputs, primaryName)
  inputs.push({ name: nextName, source: effectivePath })
  const link: SkillPipelineEdgeLinkData = {
    sourcePath: effectivePath,
    targetInputName: nextName,
    created: true,
    prevSource: null,
    prevContext,
  }
  return { nextSkill: { ...targetSkill, context: nextContext, inputs }, link }
}

function revertConnectionOnTargetSkill(params: {
  targetSkill: SkillPipelineSkillDefinition
  link: SkillPipelineEdgeLinkData
}): SkillPipelineSkillDefinition {
  const { targetSkill, link } = params
  const inputName = typeof link.targetInputName === 'string' ? link.targetInputName : ''
  const sourcePath = typeof link.sourcePath === 'string' ? link.sourcePath : ''
  if (!inputName || !sourcePath) return targetSkill

  const inputs = Array.isArray(targetSkill.inputs) ? targetSkill.inputs.map((i) => ({ ...i })) : []
  const idx = inputs.findIndex((i) => i.name === inputName && typeof i.source === 'string' && i.source === sourcePath)
  if (idx < 0) return targetSkill

  // Restore context if it was auto-changed by a Collection output connection.
  const revertedContext =
    typeof link.prevContext === 'string' ? link.prevContext : targetSkill.context

  if (link.created) {
    inputs.splice(idx, 1)
    return { ...targetSkill, context: revertedContext, inputs }
  }

  inputs[idx].source = typeof link.prevSource === 'string' ? link.prevSource : ''
  return { ...targetSkill, context: revertedContext, inputs }
}

function getSkillFromNode(node: SkillPipelineNode): SkillPipelineSkillDefinition | null {
  const data: any = node.data
  if (data?.kind !== 'skill') return null
  const skill = data.skill
  return isRecord(skill) ? (skill as SkillPipelineSkillDefinition) : (skill as SkillPipelineSkillDefinition)
}

function inferEdgesFromSkills(params: {
  docNodeId: string
  docPath: string
  skillNodes: SkillPipelineNode[]
}): SkillPipelineEdge[] {
  const { docNodeId, docPath, skillNodes } = params
  const edges: SkillPipelineEdge[] = []
  const seen = new Set<string>()

  // Decide edges only when we can determine a single producer.
  const producedByLengthDesc = computeProducedPaths(skillNodes)

  const addEdgeUnique = (edge: SkillPipelineEdge, key: string) => {
    if (!edge.source || !edge.target) return
    if (edge.source === edge.target) return
    if (seen.has(key)) return
    seen.add(key)
    edges.push(edge)
  }

  for (const n of skillNodes) {
    const skill = getSkillFromNode(n)
    if (!skill) continue

    const inputsRaw = (skill as any).inputs
    const inputs = Array.isArray(inputsRaw) ? inputsRaw : []

    for (const i of inputs) {
      const r = isRecord(i) ? i : {}
      const source = typeof r.source === 'string' ? r.source.trim() : ''
      const inputName = typeof (r as any)?.name === 'string' ? String((r as any).name) : ''
      if (!source) continue

      // Skip expression-only sources (constants, string concatenation, etc.)
      if (source.startsWith("='")) continue
      if (source.startsWith('=') && source.includes('$(')) {
        // These are often computed from other fields; we don't try to parse expressions.
        continue
      }

      const producerId = findDeterministicProducerId({ source, producedByLengthDesc })
      if (producerId && producerId !== n.id) {
        const link: SkillPipelineEdgeLinkData = {
          sourcePath: source,
          targetInputName: inputName || undefined,
          created: false,
          prevSource: '',
        }
        addEdgeUnique(
          { id: uuidv4(), source: producerId, target: n.id, data: link } as any,
          `${producerId}->${n.id}|${inputName}|${source}`,
        )
        continue
      }

      // Deterministic doc edge only when no skill produced it.
      // Prefer known document ports (content / normalized_images) so the edge
      // originates from the matching handle.
      if (source === docPath || source.startsWith(`${docPath}/`)) {
        const handle = inferDocSourceHandleForPath(source, docPath)
        const rest = source.startsWith(`${docPath}/`) ? source.slice((`${docPath}/`).length) : ''
        const isDirectChild = rest && !rest.includes('/') && !rest.includes('*')
        if (handle || isDirectChild) {
          const link: SkillPipelineEdgeLinkData = {
            sourcePath: source,
            targetInputName: inputName || undefined,
            created: false,
            prevSource: '',
          }
          addEdgeUnique(
            {
              id: uuidv4(),
              source: docNodeId,
              sourceHandle: handle ?? 'root',
              target: n.id,
              data: link,
            } as any,
            `${docNodeId}(${handle ?? 'root'})->${n.id}|${inputName}|${source}`,
          )
        }
      }
    }
  }

  return edges
}

function computeProducedPaths(skillNodes: SkillPipelineNode[]): Array<{ path: string; producerId: string }> {
  const produced: Array<{ path: string; producerId: string }> = []
  for (const n of skillNodes) {
    const skill = getSkillFromNode(n)
    if (!skill) continue
    const context = typeof skill.context === 'string' ? skill.context : '/document'
    const outputsRaw = (skill as any).outputs
    const outputs = Array.isArray(outputsRaw) ? outputsRaw : []
    for (const o of outputs) {
      const r = isRecord(o) ? o : {}
      const targetName = typeof r.targetName === 'string' ? r.targetName : ''
      const name = typeof r.name === 'string' ? r.name : ''
      const seg = targetName.trim() || name.trim()
      if (!seg) continue
      produced.push({ path: joinPath(context, seg), producerId: n.id })
    }
  }
  return produced.sort((a, b) => b.path.length - a.path.length)
}

function trimTrailingWildcards(path: string): string[] {
  const out: string[] = []
  let cur = path.trim()
  if (!cur) return out
  out.push(cur)

  while (cur.endsWith('/*')) {
    cur = cur.slice(0, -2)
    if (cur.endsWith('/')) cur = cur.slice(0, -1)
    if (!cur) break
    out.push(cur)
  }

  return Array.from(new Set(out))
}

function findDeterministicProducerId(params: {
  source: string
  producedByLengthDesc: Array<{ path: string; producerId: string }>
}): string | null {
  const { source, producedByLengthDesc } = params
  const s = source.trim()
  if (!s) return null

  const candidates = trimTrailingWildcards(s)
  const exactHits: string[] = []
  const prefixHits: string[] = []

  for (const p of producedByLengthDesc) {
    // Exact match against the source or its trimmed variants.
    if (candidates.includes(p.path)) {
      exactHits.push(p.producerId)
      continue
    }

    // Array expansion: producer outputs a collection at p.path,
    // consumer reads elements under p.path/*/...
    if (s.startsWith(`${p.path}/*`)) {
      prefixHits.push(p.producerId)
    }
  }

  // Exact matches always take priority over prefix (ancestor array) matches.
  // e.g. for "/document/pages/*/pages2", prefer the skill that directly
  // produces that path over its ancestor SplitSkill at "/document/pages".
  const hits = exactHits.length > 0 ? exactHits : prefixHits
  const uniq = Array.from(new Set(hits))
  return uniq.length === 1 ? uniq[0] : null
}

function inferEdgesToIndexProjections(params: {
  docNodeId: string
  docRoot: string
  producedByLengthDesc: Array<{ path: string; producerId: string }>
  selectorNodes: Array<{ id: string; mappings: Array<{ source: string }> }>
  indexNodeIdByTarget: Map<string, string>
}): SkillPipelineEdge[] {
  const { docNodeId, docRoot, producedByLengthDesc, selectorNodes, indexNodeIdByTarget } = params
  const edges: SkillPipelineEdge[] = []
  const seen = new Set<string>()

  const addEdgeUnique = (edge: SkillPipelineEdge, key: string) => {
    if (!edge.source || !edge.target) return
    if (edge.source === edge.target) return
    if (seen.has(key)) return
    seen.add(key)
    edges.push(edge)
  }

  for (const sel of selectorNodes) {
    for (const m of sel.mappings) {
      const source = (m.source || '').trim()
      if (!source) continue
      if (source.startsWith("='")) continue
      if (source.startsWith('=') && source.includes('$(')) continue

      const producerId = findDeterministicProducerId({ source, producedByLengthDesc })
      if (producerId) {
        addEdgeUnique({ id: uuidv4(), source: producerId, target: sel.id } as any, `${producerId}->${sel.id}|${source}`)
        continue
      }

      // Deterministic doc edge only for direct children.
      if (source.startsWith(`${docRoot}/`)) {
        const rest = source.slice((`${docRoot}/`).length)
        if (rest && !rest.includes('/') && !rest.includes('*')) {
          addEdgeUnique(
            { id: uuidv4(), source: docNodeId, sourceHandle: inferDocSourceHandleForPath(source, docRoot) ?? 'root', target: sel.id } as any,
            `${docNodeId}->${sel.id}|${source}`,
          )
        }
      }
    }
  }

  // projection -> index
  for (const sel of selectorNodes) {
    const idxId = indexNodeIdByTarget.get((sel as any).targetIndexName)
    if (idxId) addEdgeUnique({ id: uuidv4(), source: sel.id, target: idxId } as any, `${sel.id}->${idxId}`)
  }

  return edges
}

function ensureIndexerNodeData(indexer: SkillPipelineIndexerDefinition): {
  indexerName: string
  targetIndexName: string
  outputFieldMappingCount: number
  fieldMappingCount: number
} {
  const name = typeof indexer?.name === 'string' ? indexer.name : ''
  const target = typeof indexer?.targetIndexName === 'string' ? indexer.targetIndexName : ''
  const ofm = Array.isArray((indexer as any)?.outputFieldMappings) ? (indexer as any).outputFieldMappings.length : 0
  const fm = Array.isArray((indexer as any)?.fieldMappings) ? (indexer as any).fieldMappings.length : 0
  return { indexerName: name, targetIndexName: target, outputFieldMappingCount: ofm, fieldMappingCount: fm }
}

function isRecordWithStrings(v: unknown, keys: string[]): v is Record<string, string> {
  if (!isRecord(v)) return false
  for (const k of keys) {
    if (typeof (v as any)[k] !== 'string') return false
  }
  return true
}

function inferIndexerEdges(params: {
  docNodeId: string
  indexerNodeId: string
  indexNodeId: string | null
  skillNodes: SkillPipelineNode[]
  indexer: SkillPipelineIndexerDefinition
}): SkillPipelineEdge[] {
  const { docNodeId, indexerNodeId, indexNodeId, skillNodes, indexer } = params
  const edges: SkillPipelineEdge[] = []
  const seen = new Set<string>()

  const producedByLengthDesc = computeProducedPaths(skillNodes)
  const outputFieldMappings = Array.isArray((indexer as any)?.outputFieldMappings) ? ((indexer as any).outputFieldMappings as any[]) : []

  const addEdgeUnique = (sourceId: string, targetId: string, label?: string) => {
    if (!sourceId || !targetId) return
    if (sourceId === targetId) return
    const k = `${sourceId}->${targetId}|${label ?? ''}`
    if (seen.has(k)) return
    seen.add(k)
    edges.push({
      id: uuidv4(),
      source: sourceId,
      target: targetId,
      label: label ? String(label) : undefined,
      deletable: false,
      selectable: false,
      animated: false,
    } as any)
  }

  const addOutputMappingEdgeUnique = (params: {
    sourceId: string
    targetId: string
    sourceFieldName: string
    targetFieldName: string
  }) => {
    const sourceId = params.sourceId
    const targetId = params.targetId
    const sourceFieldName = (params.sourceFieldName || '').trim()
    const targetFieldName = (params.targetFieldName || '').trim()
    if (!sourceId || !targetId) return
    if (sourceId === targetId) return
    if (!sourceFieldName || !targetFieldName) return

    const k = `ofm|${sourceFieldName}=>${targetFieldName}`
    if (seen.has(k)) return
    seen.add(k)

    const id = `indexerOfm:${encodeURIComponent(sourceFieldName)}::${encodeURIComponent(targetFieldName)}`
    edges.push({
      id,
      source: sourceId,
      target: targetId,
      label: targetFieldName,
      deletable: true,
      selectable: true,
      animated: false,
      data: {
        kind: 'indexerOfm',
        sourceFieldName,
        targetFieldName,
      } satisfies IndexerOutputMappingEdgeData,
    } as any)
  }

  for (const m of outputFieldMappings) {
    if (!isRecordWithStrings(m, ['sourceFieldName', 'targetFieldName'])) continue
    const source = (m.sourceFieldName || '').trim()
    const targetField = (m.targetFieldName || '').trim()
    if (!source) continue
    if (source.startsWith("='")) continue
    if (source.startsWith('=') && source.includes('$(')) continue

    const producerId = findDeterministicProducerId({ source, producedByLengthDesc })
    addOutputMappingEdgeUnique({
      sourceId: producerId ?? docNodeId,
      targetId: indexerNodeId,
      sourceFieldName: source,
      targetFieldName: targetField,
    })
  }

  if (indexNodeId) addEdgeUnique(indexerNodeId, indexNodeId)

  return edges
}

export function SkillPipelineBuilder(props: SkillPipelineBuilderProps) {
  const { t, profile, apiVersion, language, theme, copyToClipboard, onOpenSkillEditor } = props
  _spbLang = language

  const {
    skillsetName,
    skillsetDescription,
    indexProjections,
    knowledgeStore,
    indexer,
    setIndexer,
    newSkillset,
    currentSavedId,
    saveSkillsetError,
    savedSkillsets,
    refreshSavedSkillsets,
    saveSkillset,
    loadSkillset,
    deleteSkillset,
    nodes,
    setNodes,
    edges,
    setEdges,
    selectedNodeId,
    draftSkillJson,
    draftError,
    setSelectedNodeId,
    setDraftSkillJson,
    setDraftError,
    setDraftIndexJson,
    setDraftIndexError,
    setSkillsetName,
    setSkillsetDescription,
    setIndexProjections,
    setKnowledgeStore,
    setBaselineSkillsetJson,
    debugFetchedDocs,
    setDebugFetchedDocs,
  } = useSkillPipelineState()

  // ── Publish-to-Azure flow (shared with RightPane) ───────────────────
  const publishFlow = usePublishFlow({ profile, apiVersion, language, t })

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [mainTab, setMainTab] = useState<'graph' | 'skillsetJson' | 'debugRunner' | 'enrichmentTree'>('graph')
  const [debugBusy, setDebugBusy] = useState(false)
  const [debugProgress, setDebugProgress] = useState<string | null>(null)
  const debugRunnerRef = useRef<SkillPipelineDebugRunnerHandle | null>(null)
  const [_addSkillTemplateId, setAddSkillTemplateId] = useState<string>('')
  const [nodeContextMenu, setNodeContextMenu] = useState<
    | { kind: 'skill'; x: number; y: number; nodeId: string }
    | { kind: 'doc'; x: number; y: number; nodeId: string }
    | { kind: 'projection'; x: number; y: number; nodeId: string }
    | { kind: 'indexer'; x: number; y: number; nodeId: string }
    | { kind: 'index'; x: number; y: number; nodeId: string }
    | null
  >(null)
  const [edgeContextMenu, setEdgeContextMenu] = useState<
    | { x: number; y: number; edgeId: string; deletable: boolean }
    | null
  >(null)
  const [canvasContextMenu, setCanvasContextMenu] = useState<
    | { x: number; y: number; flowX: number; flowY: number }
    | null
  >(null)
  const [serviceResourceFilter, setServiceResourceFilter] = useState<string>('')

  const contextMenuSkill = useMemo(() => {
    if (!nodeContextMenu || nodeContextMenu.kind !== 'skill') return null
    const node = nodes.find((n) => n.id === nodeContextMenu.nodeId) ?? null
    if (!node || node.data.kind !== 'skill') return null
    return node.data.skill
  }, [nodeContextMenu, nodes])

  const isContextMenuCustomWebApiSkill =
    typeof contextMenuSkill?.['@odata.type'] === 'string' &&
    String(contextMenuSkill['@odata.type']).trim() === CUSTOM_WEB_API_SKILL_ODATA_TYPE

  const flowRef = useRef<ReactFlowInstance<SkillPipelineNode, any> | null>(null)
  const canvasKeyRef = useRef<HTMLDivElement | null>(null)
  const pendingFitViewRef = useRef(false)
  const indexFetchSeqRef = useRef(0)
  const lastSelectedNodeIdRef = useRef<string>('')

  const [remoteSkillsets, setRemoteSkillsets] = useState<string[]>([])
  const [remoteSelected, setRemoteSelected] = useState<string>('')
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)

  const [remoteIndexers, setRemoteIndexers] = useState<string[]>([])
  const [remoteIndexerSelected, setRemoteIndexerSelected] = useState<string>('')
  const [remoteIndexes, setRemoteIndexes] = useState<string[]>([])
  const [remoteIndexSelected, setRemoteIndexSelected] = useState<string>('')
  const [remoteResourcesLoading, setRemoteResourcesLoading] = useState(false)
  const [remoteResourcesError, setRemoteResourcesError] = useState<string | null>(null)

  const hasRemoteIndex = (nameRaw: string) => {
    const name = String(nameRaw || '').trim()
    if (!name) return false
    return remoteIndexes.some((n) => String(n).trim() === name)
  }

  const upsertSingleIndexNode = (targetIndexNameRaw: string) => {
    const targetIndexName = String(targetIndexNameRaw || '').trim()
    if (!targetIndexName) return

    setRemoteIndexSelected(targetIndexName)

    setNodes((prev) => {
      const indexNodes = prev.filter((n) => n.data.kind === 'index')
      const existing = indexNodes.find((n) => n.id === SKILL_PIPELINE_INDEX_NODE_ID) ?? indexNodes[0] ?? null

      const indexerNode = prev.find((n) => n.id === SKILL_PIPELINE_INDEXER_NODE_ID) ?? null
      const ixPos = (indexerNode?.position ?? { x: recommendIndexerX(prev), y: 140 }) as { x: number; y: number }
      const createPos = { x: ixPos.x + 260 + DAGRE_RANKSEP_PX, y: ixPos.y }

      if (!existing) {
        return prev.concat([
          {
            id: SKILL_PIPELINE_INDEX_NODE_ID,
            type: 'index',
            position: createPos,
            data: { kind: 'index', targetIndexName, selectionMode: 'auto' } as any,
          },
        ])
      }

      const curName = typeof (existing.data as any)?.targetIndexName === 'string' ? String((existing.data as any).targetIndexName).trim() : ''
      const selectionMode = typeof (existing.data as any)?.selectionMode === 'string' ? String((existing.data as any).selectionMode) : ''
      const isManual = selectionMode === 'manual'

      // Don't override a user-picked index.
      if (isManual && curName) return prev
      if (existing.id === SKILL_PIPELINE_INDEX_NODE_ID && curName === targetIndexName) return prev

      // Keep only the chosen index node; normalize id to SKILL_PIPELINE_INDEX_NODE_ID.
      return prev
        .filter((n) => n.data.kind !== 'index' || n.id === existing.id)
        .map((n) =>
          n.id === existing.id
            ? ({
                ...n,
                id: SKILL_PIPELINE_INDEX_NODE_ID,
                data: { ...(n as any).data, targetIndexName, selectionMode: 'auto' },
                position: n.position ?? createPos,
              } as any)
            : n,
        )
    })
  }

  const codeMirrorTheme = useMemo(() => {
    const isLight = theme === 'light' || theme === 'solarized'
    return isLight ? githubLight : githubDark
  }, [theme])

  const skillsetJson = useMemo(() => {
    const name = skillsetName.trim() || 'skillset1'
    const description = skillsetDescription.trim()
    const skillNodes = nodes.filter((n) => n.data.kind === 'skill')

    // Overlay the current draft into the generated JSON when it's valid,
    // so the Skillset JSON tab reflects the latest edits immediately.
    let draftOverlay: Record<string, unknown> | null = null
    if (!draftError && selectedNodeId) {
      const raw = draftSkillJson.trim()
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (isRecord(parsed)) draftOverlay = parsed
        } catch {
          // ignore parse errors; fall back to persisted node data
        }
      }
    }

    const base: Record<string, unknown> = {
      name,
      skills: skillNodes.map((n) => {
        if (draftOverlay && n.id === selectedNodeId) return draftOverlay
        return ensureJsonObject(n.data.kind === 'skill' ? (n.data as any).skill : {})
      }),
    }
    if (description) base.description = description
    if (indexProjections) base.indexProjections = indexProjections
    if (knowledgeStore) base.knowledgeStore = knowledgeStore
    return JSON.stringify(base, null, 2)
  }, [edges, nodes, skillsetDescription, skillsetName, indexProjections, knowledgeStore, selectedNodeId, draftSkillJson, draftError])

  const copySkillset = async () => {
    await copyToClipboard(skillsetJson)
  }

  const isSkillNode = (n: SkillPipelineNode): n is SkillPipelineNode & { data: { kind: 'skill'; skill: SkillPipelineSkillDefinition } } =>
    (n as any)?.data?.kind === 'skill'

  /** Add a skill from a built-in template, optionally placing it at a flow-coordinate position. */
  const addSkillWithTemplate = (templateId: string, position?: { x: number; y: number }) => {
    setCanvasContextMenu(null)
    setAddSkillTemplateId(templateId)

    setNodes((prev) => {
      const skillCount = prev.filter((x) => (x as any)?.data?.kind === 'skill').length
      const n = skillCount + 1
      const id = uuidv4()

      const skill: SkillPipelineSkillDefinition = cloneBuiltInSkillTemplate(templateId, n)
      const baseName = typeof skill.name === 'string' ? skill.name.trim() : ''
      if (baseName && !/\d+$/.test(baseName)) skill.name = `${baseName}${n}`

      const existingPaths = collectExistingOutputPaths(prev)
      deduplicateOutputTargetNames(skill, existingPaths)

      const pos = position ?? { x: 80 + (n - 1) * 40, y: 80 + (n - 1) * 30 }
      const next: SkillPipelineNode = {
        id,
        type: 'skill',
        position: pos,
        data: { kind: 'skill', skill },
      }
      const out = [...prev, next]
      setSelectedNodeId(id)
      setDraftSkillJson(JSON.stringify((next.data as any).skill, null, 2))
      setDraftError(null)

      const inputsRaw = (skill as any)?.inputs
      const inputs = Array.isArray(inputsRaw) ? inputsRaw : []
      const docRoot = DOC_ROOT_DEFAULT
      const producedByLengthDesc = computeProducedPaths(out.filter((x) => (x as any)?.data?.kind === 'skill'))

      setEdges((prevEdges) => {
        const nextEdges = [...prevEdges]
        const seen = new Set(
          prevEdges
            .map((e: any) => {
              const link = (e as any)?.data as SkillPipelineEdgeLinkData | undefined
              const sp = typeof link?.sourcePath === 'string' ? link.sourcePath : ''
              const tn = typeof link?.targetInputName === 'string' ? link.targetInputName : ''
              const sh = typeof (e as any)?.sourceHandle === 'string' ? String((e as any).sourceHandle) : ''
              return `${String((e as any)?.source)}(${sh})->${String((e as any)?.target)}|${tn}|${sp}`
            })
            .filter(Boolean),
        )

        for (const input of inputs) {
          const r = isRecord(input) ? input : {}
          const source = typeof (r as any)?.source === 'string' ? String((r as any).source).trim() : ''
          const inputName = typeof (r as any)?.name === 'string' ? String((r as any).name) : ''
          if (!source || !inputName) continue
          if (source.startsWith("='")) continue
          if (source.startsWith('=') && source.includes('$(')) continue

          let sourceId: string | null = null
          let sourceHandle: string | undefined

          const producerId = findDeterministicProducerId({ source, producedByLengthDesc })
          if (producerId && producerId !== id) {
            sourceId = producerId
          } else if (source === docRoot || source.startsWith(`${docRoot}/`)) {
            sourceId = SKILL_PIPELINE_DOC_NODE_ID
            sourceHandle = inferDocSourceHandleForPath(source, docRoot) ?? 'root'
          }

          if (!sourceId) continue
          const link: SkillPipelineEdgeLinkData = {
            sourcePath: source,
            targetInputName: inputName,
            created: false,
            prevSource: '',
          }

          const k = `${sourceId}(${sourceHandle ?? ''})->${id}|${inputName}|${source}`
          if (seen.has(k)) continue
          seen.add(k)
          nextEdges.push({ id: uuidv4(), source: sourceId, sourceHandle, target: id, data: link } as any)
        }

        return nextEdges
      })

      return out
    })
  }

  const deleteSkillNodeById = (id: string) => {
    setSelectedEdgeId(null)
    setNodeContextMenu(null)

    // Collect the enrichment-tree paths produced by the skill being deleted
    // so we can clean up corresponding indexer outputFieldMappings.
    const targetNode = nodes.find((n) => n.id === id) ?? null
    if (targetNode && targetNode.data.kind === 'skill') {
      const producedPaths = computeProducedPaths([targetNode]).map((p) => p.path)
      if (producedPaths.length > 0) {
        setIndexer((prev) => {
          if (!prev) return prev
          const ofm = Array.isArray((prev as any)?.outputFieldMappings) ? ((prev as any).outputFieldMappings as any[]) : []
          const filtered = ofm.filter((m: any) => {
            const src = typeof m?.sourceFieldName === 'string' ? m.sourceFieldName.trim() : ''
            if (!src) return true
            // Remove mappings whose sourceFieldName exactly matches or is a
            // descendant of a path produced by the deleted skill.
            return !producedPaths.some((p) => src === p || src.startsWith(`${p}/`) || src.startsWith(`${p}/*`))
          })
          if (filtered.length === ofm.length) return prev
          return { ...prev, outputFieldMappings: filtered } as any
        })
      }
    }

    // Remove attached edges.
    setEdges((prev) => prev.filter((e) => e.source !== id && e.target !== id))

    setNodes((prev) => {
      const target = prev.find((n) => n.id === id) ?? null
      if (!target || target.data.kind !== 'skill') return prev

      const next = prev.filter((n) => n.id !== id)

      if (selectedNodeId === id) {
        const nextSkillNode = next.find(isSkillNode) ?? null
        if (nextSkillNode) {
          setSelectedNodeId(nextSkillNode.id)
          setDraftSkillJson(JSON.stringify(nextSkillNode.data.skill ?? {}, null, 2))
        } else {
          setSelectedNodeId('')
          setDraftSkillJson('{}')
        }
        setDraftError(null)
      }

      return next
    })
  }

  const openSkillContextMenu = (params: { nodeId: string; x: number; y: number }) => {
    const node = nodes.find((n) => n.id === params.nodeId) ?? null
    if (!node || node.data.kind !== 'skill') {
      setNodeContextMenu(null)
      return
    }

    setSelectedEdgeId(null)
    setEdgeContextMenu(null)
    onSelectNode(params.nodeId)
    setNodeContextMenu({ kind: 'skill', x: params.x, y: params.y, nodeId: params.nodeId })
  }

  const openIndexerContextMenu = (params: { nodeId: string; x: number; y: number }) => {
    const node = nodes.find((n) => n.id === params.nodeId) ?? null
    if (!node || node.data.kind !== 'indexer') {
      setNodeContextMenu(null)
      return
    }

    setSelectedEdgeId(null)
  setEdgeContextMenu(null)
    onSelectNode(params.nodeId)
    setNodeContextMenu({ kind: 'indexer', x: params.x, y: params.y, nodeId: params.nodeId })

    // Lazy-load resources on first open.
    if (profile && !remoteResourcesLoading && remoteIndexers.length === 0) {
      void refreshRemoteResources()
    }
  }

  const openIndexContextMenu = (params: { nodeId: string; x: number; y: number }) => {
    const node = nodes.find((n) => n.id === params.nodeId) ?? null
    if (!node || node.data.kind !== 'index') {
      setNodeContextMenu(null)
      return
    }

    setSelectedEdgeId(null)
  setEdgeContextMenu(null)
    onSelectNode(params.nodeId)
    setNodeContextMenu({ kind: 'index', x: params.x, y: params.y, nodeId: params.nodeId })

    // Lazy-load resources on first open.
    if (profile && !remoteResourcesLoading && remoteIndexes.length === 0) {
      void refreshRemoteResources()
    }
  }

  const onSelectNode = (id: string) => {
    const nextId = String(id || '')
    if (!nextId) return

    // Prevent selection thrash (onNodeClick + onSelectionChange + state-driven re-renders)
    // from repeatedly resetting drafts / re-fetching.
    if (nextId === selectedNodeId || nextId === lastSelectedNodeIdRef.current) return
    lastSelectedNodeIdRef.current = nextId

    setSelectedNodeId(nextId)
    const node = nodes.find((n) => n.id === nextId) ?? null
    if (!node) {
      setDraftError(null)
      return
    }

    if ((node as any)?.data?.kind === 'skill') {
      setDraftSkillJson(JSON.stringify((node as any).data?.skill ?? {}, null, 2))
    }

    if ((node as any)?.data?.kind === 'index') {
      const indexName = typeof (node as any)?.data?.targetIndexName === 'string' ? String((node as any).data.targetIndexName) : ''
      fetchAndSetIndexJson(indexName)
    }
    setDraftError(null)
  }

  const nodeTypes = useMemo(
    () => ({
      skill: SkillPipelineSkillNode,
      doc: SkillPipelineDocumentNode,
      projection: SkillPipelineProjectionNode,
      indexer: SkillPipelineIndexerNode,
      index: SkillPipelineIndexNode,
    }),
    [],
  )

  const doLayout = () => {
    setNodes((prev) => applyDagreLayout(prev, edges))

    // Keep it snappy: re-fit after layout.
    setTimeout(() => flowRef.current?.fitView({ padding: 0.2, duration: 250 }), 0)
  }

  // Keep an indexer mapping node present when an indexer definition exists.
  useEffect(() => {
    setNodes((prev) => {
      const hasIndexerNode = prev.some((n) => n.id === SKILL_PIPELINE_INDEXER_NODE_ID)
      if (!indexer) {
        if (!hasIndexerNode) return prev
        return prev.filter((n) => n.id !== SKILL_PIPELINE_INDEXER_NODE_ID)
      }

      const summary = ensureIndexerNodeData(indexer)
      const ixNode: SkillPipelineNode = {
        id: SKILL_PIPELINE_INDEXER_NODE_ID,
        type: 'indexer',
        draggable: false,
        position: { x: recommendIndexerX(prev), y: 140 },
        data: {
          kind: 'indexer',
          indexerName: summary.indexerName,
          targetIndexName: summary.targetIndexName,
          outputFieldMappingCount: summary.outputFieldMappingCount,
          fieldMappingCount: summary.fieldMappingCount,
        } as any,
      }

      let next = hasIndexerNode
        ? prev.map((n) => (n.id === SKILL_PIPELINE_INDEXER_NODE_ID ? ({ ...ixNode, position: n.position ?? ixNode.position } as any) : n))
        : [...prev, ixNode]

      const targetIndexName = summary.targetIndexName.trim()
      if (targetIndexName) {
        const canAutoSync = hasRemoteIndex(targetIndexName)
        const indexNodes = next.filter((n) => n.data.kind === 'index')
        if (indexNodes.length === 0) {
          if (canAutoSync) {
            const ixPos = (next.find((n) => n.id === SKILL_PIPELINE_INDEXER_NODE_ID)?.position ?? ixNode.position) as { x: number; y: number }
            next = [
              ...next,
              {
                id: SKILL_PIPELINE_INDEX_NODE_ID,
                type: 'index',
                position: {
                  x: ixPos.x + 260 + DAGRE_RANKSEP_PX,
                  y: ixPos.y,
                },
                data: { kind: 'index', targetIndexName, selectionMode: 'auto' } as any,
              },
            ]
          }
        } else if (indexNodes.length === 1) {
          const only = indexNodes[0]
          const curName = typeof (only.data as any)?.targetIndexName === 'string' ? String((only.data as any).targetIndexName).trim() : ''
          const selectionMode = typeof (only.data as any)?.selectionMode === 'string' ? String((only.data as any).selectionMode) : ''
          const isManual = selectionMode === 'manual'
          // Auto-sync when the target index exists; otherwise only fill when empty.
          if (!isManual && ((canAutoSync && curName !== targetIndexName) || (!curName && targetIndexName))) {
            next = next.map((n) =>
              n.id === only.id
                ? ({
                    ...n,
                    id: SKILL_PIPELINE_INDEX_NODE_ID,
                    data: { ...(n as any).data, targetIndexName, selectionMode: 'auto' },
                  } as any)
                : n,
            )
          }
        }
      }

      return next
    })
  }, [indexer, setNodes])

  // Normalize: only one Index node may exist. If multiple are present, keep one and retarget edges.
  useEffect(() => {
    const indexNodes = nodes.filter((n) => n.data.kind === 'index')
    if (indexNodes.length <= 1) return

    const keep = indexNodes.find((n) => n.id === SKILL_PIPELINE_INDEX_NODE_ID) ?? indexNodes[0]
    const removeIds = indexNodes.filter((n) => n.id !== keep.id).map((n) => n.id)
    if (removeIds.length === 0) return

    setNodes((prev) => {
      const idxs = prev.filter((n) => n.data.kind === 'index')
      if (idxs.length <= 1) return prev
      const keepId = idxs.find((n) => n.id === SKILL_PIPELINE_INDEX_NODE_ID)?.id ?? idxs[0]?.id
      if (!keepId) return prev
      return prev.filter((n) => n.data.kind !== 'index' || n.id === keepId)
    })

    setEdges((prev) => {
      let changed = false
      const next = prev.map((e: any) => {
        const source = typeof e?.source === 'string' ? String(e.source) : ''
        const target = typeof e?.target === 'string' ? String(e.target) : ''

        if (!removeIds.includes(source) && !removeIds.includes(target)) return e
        changed = true
        return {
          ...e,
          source: removeIds.includes(source) ? keep.id : source,
          target: removeIds.includes(target) ? keep.id : target,
        }
      })

      if (!changed) return prev

      // Dedupe after retargeting.
      const seen = new Set<string>()
      const deduped = [] as any[]
      for (const e of next) {
        const sh = typeof e?.sourceHandle === 'string' ? e.sourceHandle : ''
        const th = typeof e?.targetHandle === 'string' ? e.targetHandle : ''
        const k = `${String(e?.source)}(${sh})->${String(e?.target)}(${th})|${JSON.stringify(e?.data ?? null)}`
        if (seen.has(k)) continue
        seen.add(k)
        deduped.push(e)
      }
      return deduped as any
    })
  }, [nodes, setEdges, setNodes])

  const indexerComputedEdges = useMemo(() => {
    if (!indexer) return []
    const skillNodes = nodes.filter((n) => n.data.kind === 'skill')
    const indexNodeId = nodes.find((n) => n.data.kind === 'index')?.id ?? null

    return inferIndexerEdges({
      docNodeId: SKILL_PIPELINE_DOC_NODE_ID,
      indexerNodeId: SKILL_PIPELINE_INDEXER_NODE_ID,
      indexNodeId,
      skillNodes,
      indexer,
    })
  }, [indexer, nodes])

  const viewEdges = useMemo(() => {
    const base = [...edges, ...indexerComputedEdges]
    return base.map((e) => ({ ...e, selected: !!selectedEdgeId && e.id === selectedEdgeId } as any))
  }, [edges, indexerComputedEdges, selectedEdgeId])

  const deleteConnectionsByNodeId = (nodeIdRaw: string, direction: 'all' | 'incoming' | 'outgoing' = 'all') => {
    const nodeId = String(nodeIdRaw || '').trim()
    if (!nodeId) return

    const ids = viewEdges
      .filter((e: any) => {
        const isOut = String(e?.source) === nodeId
        const isIn = String(e?.target) === nodeId
        if (direction === 'outgoing') return isOut
        if (direction === 'incoming') return isIn
        return isOut || isIn
      })
      .map((e: any) => (typeof e?.id === 'string' ? e.id : String(e?.id ?? '')))
      .filter(Boolean)

    if (!ids.length) return

    setSelectedEdgeId(null)
    setNodeContextMenu(null)
    setEdgeContextMenu(null)
    onEdgesChange(ids.map((id) => ({ id, type: 'remove' })))
  }

  const openDocContextMenu = (params: { nodeId: string; x: number; y: number }) => {
    const node = nodes.find((n) => n.id === params.nodeId) ?? null
    if (!node || node.data.kind !== 'doc') {
      setNodeContextMenu(null)
      return
    }

    setSelectedEdgeId(null)
    setEdgeContextMenu(null)
    onSelectNode(params.nodeId)
    setNodeContextMenu({ kind: 'doc', x: params.x, y: params.y, nodeId: params.nodeId })
  }

  const openProjectionContextMenu = (params: { nodeId: string; x: number; y: number }) => {
    const node = nodes.find((n) => n.id === params.nodeId) ?? null
    if (!node || node.data.kind !== 'projection') {
      setNodeContextMenu(null)
      return
    }

    setSelectedEdgeId(null)
    setEdgeContextMenu(null)
    onSelectNode(params.nodeId)
    setNodeContextMenu({ kind: 'projection', x: params.x, y: params.y, nodeId: params.nodeId })
  }

  // Sync index node display metadata: show which index fields are connected via outputFieldMappings.
  useEffect(() => {
    const targetIndexName = typeof (indexer as any)?.targetIndexName === 'string' ? String((indexer as any).targetIndexName) : ''
    const ofm = Array.isArray((indexer as any)?.outputFieldMappings) ? ((indexer as any).outputFieldMappings as any[]) : []
    const connected = ofm
      .map((m) => (m && typeof m.targetFieldName === 'string' ? m.targetFieldName.trim() : ''))
      .filter(Boolean)

    const uniqueConnected = Array.from(new Set(connected)).sort((a, b) => a.localeCompare(b))

    const sameArray = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

    setNodes((prev) => {
      const indexNodes = prev.filter((n) => (n as any)?.data?.kind === 'index')
      const singleIndexNodeId = indexNodes.length === 1 ? indexNodes[0]!.id : ''
      let changed = false
      const next = prev.map((n) => {
        if ((n as any)?.data?.kind !== 'index') return n
        const name = typeof (n as any)?.data?.targetIndexName === 'string' ? String((n as any).data.targetIndexName) : ''
        const nextFields =
          indexer && singleIndexNodeId
            ? uniqueConnected
            : indexer && targetIndexName && name === targetIndexName
              ? uniqueConnected
              : []
        const curFields = Array.isArray((n as any)?.data?.connectedFieldNames)
          ? ((n as any).data.connectedFieldNames as unknown[]).map((x) => String(x)).filter(Boolean)
          : []

        if (sameArray(curFields, nextFields)) return n
        changed = true
        return { ...n, data: { ...(n as any).data, connectedFieldNames: nextFields } }
      })
      return changed ? (next as any) : prev
    })
  }, [indexer, setNodes])

  const onEdgesChange = (changes: any[]) => {
    const removedIds = changes
      .filter((c) => c && c.type === 'remove' && typeof c.id === 'string')
      .map((c) => String(c.id))

    if (removedIds.length) {
      const removedComputed = removedIds
        .map((id) => indexerComputedEdges.find((e) => e.id === id) ?? null)
        .filter((e): e is SkillPipelineEdge => e !== null)

      if (removedComputed.length) {
        setIndexer((prev) => {
          if (!prev) return prev
          let next: IndexerLike = prev as unknown as IndexerLike
          for (const e of removedComputed) {
            const d = (e as any)?.data as IndexerOutputMappingEdgeData | undefined
            if (!d || d.kind !== 'indexerOfm') continue
            next = removeOutputFieldMappingFromIndexer(next, {
              sourceFieldName: d.sourceFieldName,
              targetFieldName: d.targetFieldName,
            })
          }
          return next as any
        })
      }
    }

    setEdges((prev) => {
      if (removedIds.length) {
        const removed = removedIds
          .map((id) => prev.find((e) => e.id === id) ?? null)
          .filter((e): e is SkillPipelineEdge => e !== null)

        if (removed.length) {
          let nextSelectedSkill: SkillPipelineSkillDefinition | null = null
          setNodes((prevNodes) => {
            let nextNodes = prevNodes
            for (const e of removed) {
              const link = (e as any)?.data as SkillPipelineEdgeLinkData | undefined
              if (!link) continue

              nextNodes = nextNodes.map((n) => {
                if (n.id !== e.target) return n
                if (n.data.kind !== 'skill') return n
                const nextSkill = revertConnectionOnTargetSkill({ targetSkill: n.data.skill, link })
                if (n.id === selectedNodeId) nextSelectedSkill = nextSkill
                return { ...n, data: { ...n.data, kind: 'skill', skill: nextSkill } }
              })
            }
            return nextNodes
          })

          if (nextSelectedSkill) {
            setDraftSkillJson(JSON.stringify(nextSelectedSkill, null, 2))
            setDraftError(null)
          }
        }

        setSelectedEdgeId((cur) => (cur && removedIds.includes(cur) ? null : cur))
      }

      return applyEdgeChanges(changes as any, prev)
    })
  }

  // Migration: doc node now only exposes handles with IDs.
  // Ensure existing edges pointing at the doc node have a valid sourceHandle.
  useEffect(() => {
    setEdges((prev) => {
      let changed = false
      const next = prev.map((e: any) => {
        if (String(e?.source) !== SKILL_PIPELINE_DOC_NODE_ID) return e
        if (typeof e?.sourceHandle === 'string' && e.sourceHandle.trim()) return e

        const link = (e as any)?.data as SkillPipelineEdgeLinkData | undefined
        const sp = typeof link?.sourcePath === 'string' ? link.sourcePath : ''
        const inferred = sp ? inferDocSourceHandleForPath(sp, DOC_ROOT_DEFAULT) : null
        changed = true
        return { ...e, sourceHandle: inferred ?? 'root' }
      })

      return changed ? (next as any) : prev
    })
  }, [setEdges])

  useEffect(() => {
    if (mainTab !== 'graph') return
    if (!flowRef.current) return
    // If returning to the canvas, re-fit once so it doesn't look "blank".
    const t = setTimeout(() => flowRef.current?.fitView({ padding: 0.2, duration: 200 }), 0)
    return () => clearTimeout(t)
  }, [mainTab])

  const refreshRemoteSkillsets = async () => {
    if (!profile) return
    setRemoteLoading(true)
    setRemoteError(null)
    try {
      const res = await listSkillsets({ profile, apiVersion, language })
      if (!res.ok) {
        setRemoteError(res.error.message)
        setRemoteSkillsets([])
        return
      }
      const value = (res.response as any)?.value
      const names = Array.isArray(value)
        ? value
            .map((x: any) => (x && typeof x.name === 'string' ? x.name : null))
            .filter((x: any): x is string => typeof x === 'string')
        : []
      setRemoteSkillsets(names)
      if (!remoteSelected && names.length > 0) setRemoteSelected(names[0])
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e))
      setRemoteSkillsets([])
    } finally {
      setRemoteLoading(false)
    }
  }

  const refreshRemoteResources = async () => {
    if (!profile) return
    setRemoteResourcesLoading(true)
    setRemoteResourcesError(null)

    try {
      const [ixRes, idxRes] = await Promise.all([
        listIndexers({ profile, apiVersion, language }),
        listIndexes({ profile, apiVersion, language }),
      ])

      if (!ixRes.ok) {
        setRemoteResourcesError(ixRes.error.message)
        setRemoteIndexers([])
      } else {
        const value = (ixRes.response as any)?.value
        const names = Array.isArray(value)
          ? value
              .map((x: any) => (x && typeof x.name === 'string' ? x.name : null))
              .filter((x: any): x is string => typeof x === 'string')
          : []
        setRemoteIndexers(names)
        if (!remoteIndexerSelected && names.length > 0) setRemoteIndexerSelected(names[0])
      }

      if (!idxRes.ok) {
        setRemoteResourcesError((cur) => cur ?? idxRes.error.message)
        setRemoteIndexes([])
      } else {
        const value = (idxRes.response as any)?.value
        const names = Array.isArray(value)
          ? value
              .map((x: any) => (x && typeof x.name === 'string' ? x.name : null))
              .filter((x: any): x is string => typeof x === 'string')
          : []
        setRemoteIndexes(names)
        if (!remoteIndexSelected && names.length > 0) setRemoteIndexSelected(names[0])
      }
    } catch (e) {
      setRemoteResourcesError(e instanceof Error ? e.message : String(e))
      setRemoteIndexers([])
      setRemoteIndexes([])
    } finally {
      setRemoteResourcesLoading(false)
    }
  }

  const loadRemoteIndexerByName = async (nameRaw: string) => {
    if (!profile) return
    const name = String(nameRaw || '').trim()
    if (!name) return

    setRemoteIndexerSelected(name)
    setRemoteResourcesLoading(true)
    setRemoteResourcesError(null)
    try {
      const ixGet = await getIndexerDefinition({ profile, indexerName: name, apiVersion, language })
      if (!ixGet.ok) {
        setRemoteResourcesError(ixGet.error.message)
        return
      }

      // If this indexer points to a target index, ensure we know whether it exists.
      const nextIndexer = ixGet.response && typeof ixGet.response === 'object' ? (ixGet.response as any) : null
      const targetIndexName = typeof nextIndexer?.targetIndexName === 'string' ? String(nextIndexer.targetIndexName).trim() : ''
      if (targetIndexName && !hasRemoteIndex(targetIndexName)) {
        try {
          const idxRes = await listIndexes({ profile, apiVersion, language })
          if (idxRes.ok) {
            const value = (idxRes.response as any)?.value
            const names = Array.isArray(value)
              ? value
                  .map((x: any) => (x && typeof x.name === 'string' ? x.name : null))
                  .filter((x: any): x is string => typeof x === 'string')
              : []
            setRemoteIndexes(names)
          }
        } catch {
          // ignore
        }
      }

      if (ixGet.response && typeof ixGet.response === 'object') {
        setIndexer(nextIndexer)
        pendingFitViewRef.current = true

        // Auto-set the single index node only when the service actually has the target index.
        if (targetIndexName && hasRemoteIndex(targetIndexName)) {
          upsertSingleIndexNode(targetIndexName)
        }
      }
    } catch (e) {
      setRemoteResourcesError(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoteResourcesLoading(false)
    }
  }

  const fetchAndSetIndexJson = (indexNameRaw: string) => {
    const indexName = String(indexNameRaw || '').trim()
    setDraftIndexError(null)
    setDraftIndexJson('{}')
    if (!indexName) {
      setDraftIndexError(t('spbErrIndexNameNotSet'))
      return
    }
    if (!profile) {
      setDraftIndexError(t('spbErrProfileNotInitialized'))
      return
    }

    const seq = ++indexFetchSeqRef.current
    void (async () => {
      const res = await getIndexDefinition({ profile, indexName, apiVersion, language })
      if (seq !== indexFetchSeqRef.current) return
      if (res.ok) {
        setDraftIndexJson(JSON.stringify(res.response ?? {}, null, 2))
        setDraftIndexError(null)
      } else {
        setDraftIndexError(String(res.error?.message ?? t('spbErrFailedFetchIndex')))
        setDraftIndexJson(JSON.stringify(res.error?.response ?? {}, null, 2))
      }
    })()
  }

  const updateIndexNodeTargetName = (params: { nodeId: string; targetIndexName: string }) => {
    const targetIndexName = params.targetIndexName.trim()
    if (!targetIndexName) return
    setRemoteIndexSelected(targetIndexName)

    setNodes((prev) =>
      prev.map((n) =>
        n.id === params.nodeId && n.data.kind === 'index'
          ? ({ ...n, data: { ...(n as any).data, targetIndexName, selectionMode: 'manual' } } as any)
          : n,
      ),
    )

    if (selectedNodeId === params.nodeId) {
      fetchAndSetIndexJson(targetIndexName)
    }
  }

  const loadRemoteSkillset = async () => {
    if (!profile) return
    const name = remoteSelected.trim()
    if (!name) return

    setRemoteLoading(true)
    setRemoteError(null)
    try {
      const res = await getSkillset({ profile, skillsetName: name, apiVersion, language })
      if (!res.ok) {
        setRemoteError(res.error.message)
        return
      }

      const obj = res.response as any

      // Keep the full remote JSON as the baseline for diff/publish.
      // Strip service metadata fields that we should not send back.
      try {
        if (obj && typeof obj === 'object') {
          const { ['@odata.etag']: _etag, ...rest } = obj as any
          setBaselineSkillsetJson(JSON.stringify(rest, null, 2))
        } else {
          setBaselineSkillsetJson('')
        }
      } catch {
        setBaselineSkillsetJson('')
      }
      const skills = Array.isArray(obj?.skills) ? obj.skills : []

      // Load the indexer bound to this skillset (if any) so we can visualize outputFieldMappings.
      let loadedIndexer: SkillPipelineIndexerDefinition | null = null
      try {
        const ixList = await listIndexers({ profile, apiVersion, language })
        if (ixList.ok) {
          const value = (ixList.response as any)?.value
          const candidates = Array.isArray(value) ? value : []
          const match = candidates.find((x: any) => x && typeof x.skillsetName === 'string' && x.skillsetName === name)
          const indexerName = match && typeof match.name === 'string' ? String(match.name) : ''
          if (indexerName) {
            const ixGet = await getIndexerDefinition({ profile, indexerName, apiVersion, language })
            if (ixGet.ok && ixGet.response && typeof ixGet.response === 'object') {
              loadedIndexer = ixGet.response as any
            }
          }
        }
      } catch {
        // ignore indexer load errors; skillset graph still loads
      }

      const docNode: SkillPipelineNode = {
        id: SKILL_PIPELINE_DOC_NODE_ID,
        type: 'doc',
        position: { x: 80, y: 80 },
        data: { kind: 'doc', path: '/document' } as any,
      }

      const nextSkillNodes: SkillPipelineNode[] = skills.map((skill: any, idx: number) => ({
        id: uuidv4(),
        type: 'skill',
        position: { x: 420 + idx * 320, y: 80 + idx * 10 },
        data: { kind: 'skill', skill: (skill ?? {}) as any } as any,
      }))

      // Prefer persisted graph layout if present.
      const graph = isRecord(obj?._ragops) && isRecord((obj as any)._ragops.graph) ? ((obj as any)._ragops.graph as any) : null
      const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes : null
      const graphEdges = Array.isArray(graph?.edges) ? graph.edges : null

      // indexProjections => projection nodes and index nodes
      const selectors = Array.isArray(obj?.indexProjections?.selectors) ? obj.indexProjections.selectors : []
      const uniqueTargets = Array.from(
        new Set(selectors.map((s: any) => (typeof s?.targetIndexName === 'string' ? s.targetIndexName : '')).filter((x: string) => x)),
      )
      const targetIndexName = uniqueTargets.join(', ')
      const sourceContext = selectors
        .map((s: any) => (typeof s?.sourceContext === 'string' ? s.sourceContext : ''))
        .filter((x: string) => x)
        .join(', ')

      const fieldMappingCount = selectors.reduce((acc: number, s: any) => acc + (Array.isArray(s?.mappings) ? s.mappings.length : 0), 0)

      const projectionNodes: SkillPipelineNode[] = selectors.length
        ? [
            {
              id: `mapping-${uuidv4()}`,
              type: 'projection',
              position: { x: 1100, y: 140 },
              data: {
                kind: 'projection',
                targetIndexName,
                sourceContext,
                projectionCount: selectors.length,
                outputFieldMappingCount: fieldMappingCount,
                fieldMappingCount,
              } as any,
            },
          ]
        : []

      const indexNodeIdByTarget = new Map<string, string>()
      const indexNodes: SkillPipelineNode[] = []

      const firstTargetIndexName =
        uniqueTargets.length > 0
          ? String(uniqueTargets[0] ?? '')
          : typeof (loadedIndexer as any)?.targetIndexName === 'string'
            ? String((loadedIndexer as any).targetIndexName)
            : ''

      if (firstTargetIndexName.trim()) {
        const id = SKILL_PIPELINE_INDEX_NODE_ID
        indexNodeIdByTarget.set(firstTargetIndexName, id)
        indexNodes.push({
          id,
          type: 'index',
          position: { x: 1500, y: 180 },
          data: { kind: 'index', targetIndexName: firstTargetIndexName, selectionMode: 'auto' } as any,
        })
      }

      let nextNodes: SkillPipelineNode[] = [docNode, ...nextSkillNodes, ...projectionNodes, ...indexNodes]
      let nextEdges: SkillPipelineEdge[] = []

      if (loadedIndexer) {
        const summary = ensureIndexerNodeData(loadedIndexer)
        const recommendedIndexerX = recommendIndexerX(nextNodes)
        nextNodes = nextNodes.concat([
          {
            id: SKILL_PIPELINE_INDEXER_NODE_ID,
            type: 'indexer',
            draggable: false,
            position: { x: recommendedIndexerX, y: 140 },
            data: { kind: 'indexer', ...summary } as any,
          },
        ])

        const tname = summary.targetIndexName.trim()
        if (tname) {
          const existingIndexNodes = nextNodes.filter((n) => n.data.kind === 'index')

          if (existingIndexNodes.length === 0) {
            nextNodes = nextNodes.concat([
              {
                id: SKILL_PIPELINE_INDEX_NODE_ID,
                type: 'index',
                position: {
                  x: recommendedIndexerX + 260 + DAGRE_RANKSEP_PX,
                  y: 140,
                },
                data: { kind: 'index', targetIndexName: tname, selectionMode: 'auto' } as any,
              },
            ])
          } else if (existingIndexNodes.length === 1) {
            const only = existingIndexNodes[0]!
            const curName = typeof (only.data as any)?.targetIndexName === 'string' ? String((only.data as any).targetIndexName).trim() : ''
            if (!curName) {
              nextNodes = nextNodes.map((n) =>
                n.id === only.id
                  ? ({ ...n, data: { ...(n as any).data, targetIndexName: tname, selectionMode: 'auto' } } as any)
                  : n,
              )
            }
          }
        }
      }

      if (graphNodes && graphEdges) {
        const posById = new Map<string, { x: number; y: number }>()
        for (const gn of graphNodes) {
          if (!isRecord(gn)) continue
          if (typeof gn.id !== 'string') continue
          if (typeof gn.x !== 'number' || typeof gn.y !== 'number') continue
          posById.set(gn.id, { x: gn.x, y: gn.y })
        }

        // If IDs match, apply positions. (Remote graph IDs may not match our generated UUIDs.)
        nextNodes = nextNodes.map((n) => {
          const p = posById.get(n.id)
          return p ? { ...n, position: { x: p.x, y: p.y } } : n
        })

        nextEdges = graphEdges
          .map((ge: any): SkillPipelineEdge | null => {
            if (!isRecord(ge)) return null
            const source = typeof ge.source === 'string' ? ge.source : ''
            const target = typeof ge.target === 'string' ? ge.target : ''
            if (!source || !target) return null
            const sourceHandle = typeof (ge as any).sourceHandle === 'string' ? String((ge as any).sourceHandle) : undefined
            const targetHandle = typeof (ge as any).targetHandle === 'string' ? String((ge as any).targetHandle) : undefined
            const data = (ge as any).data
            const migratedSourceHandle =
              source === SKILL_PIPELINE_DOC_NODE_ID
                ? sourceHandle ??
                  (typeof (data as any)?.sourcePath === 'string' ? inferDocSourceHandleForPath(String((data as any).sourcePath), DOC_ROOT_DEFAULT) ?? 'root' : 'root')
                : sourceHandle

            return { id: typeof ge.id === 'string' ? ge.id : uuidv4(), source, target, sourceHandle: migratedSourceHandle, targetHandle, data } as any
          })
          .filter((x: SkillPipelineEdge | null): x is SkillPipelineEdge => x !== null)
      } else {
        const docRoot = '/document'
        nextEdges = inferEdgesFromSkills({
          docNodeId: SKILL_PIPELINE_DOC_NODE_ID,
          docPath: docRoot,
          skillNodes: nextSkillNodes,
        })

        const producedByLengthDesc = computeProducedPaths(nextSkillNodes)
        const mappingNodeId = projectionNodes[0]?.id
        if (mappingNodeId) {
          const allMappingSources = selectors
            .flatMap((s: any) => (Array.isArray(s?.mappings) ? s.mappings : []))
            .map((m: any) => ({ source: typeof m?.source === 'string' ? m.source : '' }))
            .filter((m: any) => typeof m.source === 'string' && m.source.trim())

          nextEdges = nextEdges.concat(
            inferEdgesToIndexProjections({
              docNodeId: SKILL_PIPELINE_DOC_NODE_ID,
              docRoot,
              producedByLengthDesc,
              selectorNodes: [{ id: mappingNodeId, mappings: allMappingSources, targetIndexName: '' } as any],
              indexNodeIdByTarget,
            }),
          )

          // mapping -> index
          const firstIndexNodeId = indexNodes[0]?.id
          if (firstIndexNodeId) nextEdges.push({ id: uuidv4(), source: mappingNodeId, target: firstIndexNodeId })
        }
      }

      // Always apply a clean layout right after remote load.
      const laidOut = applyDagreLayout(nextNodes, nextEdges)

      setSkillsetName(typeof obj?.name === 'string' && obj.name.trim() ? obj.name : name)
      setSkillsetDescription(typeof obj?.description === 'string' ? obj.description : '')
      setIndexProjections(obj?.indexProjections ?? null)
      setKnowledgeStore(obj?.knowledgeStore ?? null)
      setIndexer(loadedIndexer)
      setNodes(laidOut)
      setEdges(nextEdges)

      const firstSkill = nextNodes.find((n) => (n as any)?.data?.kind === 'skill')
      if (firstSkill) {
        setSelectedNodeId(firstSkill.id)
        setDraftSkillJson(JSON.stringify((firstSkill as any).data.skill, null, 2))
      } else {
        setSelectedNodeId('')
        setDraftSkillJson('{}')
      }
      setDraftError(null)
      pendingFitViewRef.current = true
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoteLoading(false)
    }
  }

  const onNewSkillset = () => {
    const ok = window.confirm(t('spbNewConfirm'))
    if (!ok) return

    setSelectedEdgeId(null)
    setMainTab('graph')
    setAddSkillTemplateId('')
    setRemoteError(null)

    newSkillset()
    pendingFitViewRef.current = true
  }

  // ─── Local save / load / clone handlers ───────────────────────────

  const [localSavedOpen, setLocalSavedOpen] = useState(false)

  /** Overwrite-save to the current slot (or auto-SaveAs if no slot yet). */
  const onSave = () => {
    if (currentSavedId) {
      saveSkillset('save')
    } else {
      onSaveAs()
    }
  }

  /** Save as a new local entry, prompting for a new name. */
  const onSaveAs = () => {
    const newName = window.prompt(t('spbSaveAsPrompt'), skillsetName)
    if (newName == null) return // cancelled
    const trimmed = newName.trim() || skillsetName
    saveSkillset('saveAs', trimmed)
  }

  /** Load a previously saved local skillset. */
  const onLoadSaved = (id: string) => {
    const ok = window.confirm(t('spbLoadConfirm'))
    if (!ok) return

    setSelectedEdgeId(null)
    setMainTab('graph')
    setAddSkillTemplateId('')
    setRemoteError(null)

    loadSkillset(id)
    pendingFitViewRef.current = true
  }

  /** Clone: load an existing local skillset and immediately save it as a new copy. */
  const onCloneSaved = (id: string) => {
    const ok = window.confirm(t('spbCloneConfirm'))
    if (!ok) return

    // Read the name from the saved list before loading (to avoid stale closure).
    const item = savedSkillsets.find((s) => s.id === id)
    const baseName = item?.title || 'skillset'

    setSelectedEdgeId(null)
    setMainTab('graph')
    setAddSkillTemplateId('')
    setRemoteError(null)

    loadSkillset(id)

    // After loading, save as a new entry with " (copy)" suffix.
    const clonedName = baseName + ' (copy)'
    // Use setTimeout to ensure loadSkillset's state updates are flushed first,
    // then saveSkillset with nameOverride to guarantee the new name is persisted.
    setTimeout(() => saveSkillset('saveAs', clonedName), 0)
    pendingFitViewRef.current = true
  }

  /** Delete a saved local skillset. */
  const onDeleteSaved = (id: string) => {
    const ok = window.confirm(t('spbDeleteConfirm'))
    if (!ok) return
    deleteSkillset(id)
  }

  // Refresh the local saved list when the collapsible opens
  useEffect(() => {
    if (localSavedOpen) refreshSavedSkillsets()
  }, [localSavedOpen, refreshSavedSkillsets])

  useEffect(() => {
    if (!pendingFitViewRef.current) return
    if (!flowRef.current) return
    if (nodes.length === 0) return

    // Wait one paint so ReactFlow has applied nodes/edges.
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        flowRef.current?.fitView({ padding: 0.2, duration: 250 })
        pendingFitViewRef.current = false
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [nodes.length, edges.length])

  useEffect(() => {
    // Auto-load the remote list once a profile is present.
    if (!profile) return
    refreshRemoteSkillsets()
    refreshRemoteResources()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.endpoint, profile?.authType, profile?.apiKey, profile?.bearerToken])

  return (
    <div className="pane__centerContent" style={{ height: '100%' }}>
      <div className="section" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div className="section__title">{t('skillPipelineBuilder')}</div>
        <div className="section__hint">{t('spbIntro')}</div>

        <div
          className="spb-toolbar"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
            padding: '6px 10px',
            marginBottom: 10,
            borderRadius: 'var(--radius-sm)',
            background: 'var(--panel-2)',
            border: '1px solid var(--border)',
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, whiteSpace: 'nowrap' }}>
            <i className="bi bi-cloud-download" style={{ marginRight: 4 }}></i>{t('spbToolbarSkillsets')}
          </span>
          <select
            className="field__input"
            style={{ flex: 1, minWidth: 200, maxWidth: 340, padding: '4px 8px', fontSize: 13 }}
            value={remoteSelected}
            onChange={(e) => setRemoteSelected(e.target.value)}
            disabled={!profile || remoteLoading || remoteSkillsets.length === 0}
          >
            {remoteSkillsets.length === 0 ? <option value="">{t('spbNone')}</option> : null}
            {remoteSkillsets.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--sm" onClick={refreshRemoteSkillsets} disabled={!profile || remoteLoading} title={t('spbToolbarRefresh')}>
            <i className="bi bi-arrow-clockwise"></i>
          </button>
          <button type="button" className="btn btn--sm" onClick={loadRemoteSkillset} disabled={!profile || remoteLoading || !remoteSelected} title={t('spbToolbarLoad')}>
            <i className="bi bi-file-earmark-play"></i>
          </button>
          <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />
          <button type="button" className="btn btn--sm" onClick={onNewSkillset} title={t('spbNew')}>
            <i className="bi bi-file-earmark-plus"></i>
          </button>
          <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 2px' }} />
          <button type="button" className="btn btn--sm" onClick={copySkillset} title={t('spbCopySkillsetJson')}>
            <i className="bi bi-clipboard"></i>
          </button>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            className="btn btn--sm"
            onClick={publishFlow.onPublishClick}
            disabled={publishFlow.publishLoading}
            title={t('spbPublish')}
            style={publishFlow.publishLoading ? undefined : { background: 'var(--accent)', color: 'var(--accent-fg, #fff)', border: 'none' }}
          >
            <i className="bi bi-cloud-upload" style={{ marginRight: 4 }}></i>
            {publishFlow.publishLoading ? t('spbPublishing') : t('spbPublish')}
          </button>
          {publishFlow.publishError && <span className="notice notice--error builder__notice" style={{ fontSize: 12 }}>{publishFlow.publishError}</span>}
          {publishFlow.publishOkMessage && <span style={{ fontSize: 12, color: 'var(--success, #22863a)' }}>{publishFlow.publishOkMessage}</span>}
          {remoteError && <div className="notice notice--error builder__notice" style={{ fontSize: 12 }}>{remoteError}</div>}
        </div>

        {remoteResourcesError ? <div className="notice notice--error builder__notice">{remoteResourcesError}</div> : null}

        {/* ─── Local Skillset Library ─────────────────────── */}
        <div className="actions actions--mb10" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <button type="button" className="btn" onClick={onSave} title={currentSavedId ? t('spbSave') : t('spbSaveAs')}>
            <i className="bi bi-save"></i> {t('spbSave')}
          </button>
          <button type="button" className="btn" onClick={onSaveAs}>
            <i className="bi bi-save2"></i> {t('spbSaveAs')}
          </button>
          <button
            type="button"
            className={'btn ' + (localSavedOpen ? 'btn--active' : '')}
            onClick={() => setLocalSavedOpen((v) => !v)}
          >
            <i className="bi bi-folder2-open"></i> {t('spbSavedSkillsets')} ({savedSkillsets.length})
          </button>
          {saveSkillsetError && <div className="notice notice--error builder__notice">{saveSkillsetError}</div>}
        </div>

        {localSavedOpen && (
          <div
            style={{
              maxHeight: 200,
              overflowY: 'auto',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--panel-2)',
              padding: '6px 8px',
              marginBottom: 10,
              fontSize: 13,
            }}
          >
            <div className="section__hint" style={{ margin: '4px 0 8px 0' }}>{t('spbLocalLibraryHint')}</div>
            {savedSkillsets.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>{t('spbNoSavedSkillsets')}</div>
            ) : (
              savedSkillsets.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 0',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontWeight: item.id === currentSavedId ? 700 : 400,
                    }}
                    title={item.title + ' — ' + new Date(item.updatedAt).toLocaleString()}
                  >
                    {item.title}
                  </span>
                  <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>
                    {new Date(item.updatedAt).toLocaleString()}
                  </span>
                  <button type="button" className="btn btn--sm" onClick={() => onLoadSaved(item.id)} title={t('spbLoad')}>
                    <i className="bi bi-file-earmark-play"></i>
                  </button>
                  <button type="button" className="btn btn--sm" onClick={() => onCloneSaved(item.id)} title={t('spbClone')}>
                    <i className="bi bi-copy"></i>
                  </button>
                  <button type="button" className="btn btn--sm" onClick={() => onDeleteSaved(item.id)} title={t('spbDelete')}>
                    <i className="bi bi-trash"></i>
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        <div className="actions actions--mb10" style={{ flexWrap: 'wrap' }}>
          <button
            type="button"
            className={'btn btn--tab ' + (mainTab === 'graph' ? 'btn--active' : '')}
            onClick={() => setMainTab('graph')}
          >
            {t('spbTabGraph')}
          </button>
          <button
            type="button"
            className={'btn btn--tab ' + (mainTab === 'skillsetJson' ? 'btn--active' : '')}
            onClick={() => setMainTab('skillsetJson')}
          >
            {t('spbTabSkillsetJson')}
          </button>
          <button
            type="button"
            className={'btn btn--tab ' + (mainTab === 'debugRunner' ? 'btn--active' : '')}
            onClick={() => setMainTab('debugRunner')}
          >
            {t('spbTabDebugRunner')}
          </button>
          <button
            type="button"
            className={'btn btn--tab ' + (mainTab === 'enrichmentTree' ? 'btn--active' : '')}
            onClick={() => setMainTab('enrichmentTree')}
          >
            {t('spbTabEnrichmentTree')}
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {debugBusy && debugProgress ? (
              <span style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span className="spinner" style={{ width: 12, height: 12, border: '2px solid var(--border)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin 0.8s linear infinite', display: 'inline-block' }} />
                {debugProgress}
              </span>
            ) : null}
            <button
              type="button"
              className="btn"
              style={{ fontWeight: 600, padding: '5px 14px', fontSize: 13, background: 'var(--accent)', color: 'var(--accent-fg, #fff)', border: 'none', borderRadius: 'var(--radius-sm)' }}
              onClick={() => {
                // Start debug without switching tab – the runner stays mounted in background.
                debugRunnerRef.current?.startDebug()
              }}
              disabled={!profile || debugBusy}
              title={t('spbDebugStartDebug')}
            >
              <i className="bi bi-play-fill" style={{ marginRight: 4 }}></i>
              {t('spbDebugStartDebug')}
            </button>
          </div>
        </div>

        <div style={{ position: 'relative', flex: 1, minHeight: 360 }}>
          <div style={{ position: 'absolute', inset: 0, display: mainTab === 'graph' ? 'block' : 'none' }}>
            <div
              className={'spvPipeline' + (debugBusy ? ' spvPipeline--debugging' : '')}
              style={{
                position: 'relative',
                height: '100%',
                overflow: 'hidden',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--panel-2)',
              }}
              role="region"
              aria-label={t('spbAriaCanvas')}
              tabIndex={0}
              ref={canvasKeyRef}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setNodeContextMenu(null)
                  setEdgeContextMenu(null)
                  return
                }

                if (e.key !== 'Backspace' && e.key !== 'Delete') return

                if (selectedEdgeId) {
                  e.preventDefault()
                  onEdgesChange([{ id: selectedEdgeId, type: 'remove' }])
                  return
                }

                if (selectedNodeId) {
                  const hasAny = viewEdges.some((x: any) => String(x?.source) === selectedNodeId || String(x?.target) === selectedNodeId)
                  if (!hasAny) return
                  e.preventDefault()
                  deleteConnectionsByNodeId(selectedNodeId)
                }
              }}
            >
              {nodeContextMenu ? (
                <div
                  className="dropdown-menu show"
                  style={{
                    position: 'fixed',
                    left: Math.min(nodeContextMenu.x, window.innerWidth - 360),
                    top: Math.min(nodeContextMenu.y, window.innerHeight - 420),
                    right: 'auto',
                    width: nodeContextMenu.kind === 'skill' ? undefined : 360,
                    maxHeight: nodeContextMenu.kind === 'skill' ? undefined : 420,
                    overflowY: nodeContextMenu.kind === 'skill' ? undefined : 'auto',
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  {nodeContextMenu.kind === 'skill' ? (
                    <>
                      {isContextMenuCustomWebApiSkill && onOpenSkillEditor ? (
                        <>
                          <button
                            type="button"
                            className="dropdown-item"
                            onClick={() => {
                              const nodeId = nodeContextMenu.nodeId
                              setNodeContextMenu(null)
                              onOpenSkillEditor(nodeId)
                            }}
                          >
                            {t('spbEditSkillCode')}
                          </button>
                          <hr className="dropdown-divider" />
                        </>
                      ) : null}
                      <button type="button" className="dropdown-item" onClick={() => deleteConnectionsByNodeId(nodeContextMenu.nodeId, 'incoming')}>
                        {t('spbDisconnectInputs')}
                      </button>
                      <button type="button" className="dropdown-item" onClick={() => deleteConnectionsByNodeId(nodeContextMenu.nodeId, 'outgoing')}>
                        {t('spbDisconnectOutputs')}
                      </button>
                      <hr className="dropdown-divider" />
                      <button type="button" className="dropdown-item" onClick={() => deleteSkillNodeById(nodeContextMenu.nodeId)}>
                        {t('spbDeleteSkill')}
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" className="dropdown-item" onClick={() => deleteConnectionsByNodeId(nodeContextMenu.nodeId)}>
                        {t('spbDeleteConnections')}
                      </button>
                      {nodeContextMenu.kind === 'indexer' || nodeContextMenu.kind === 'index' ? (
                        <>
                          <div className="dropdown-menu__filter">
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                              <input
                                className="field__input"
                                style={{ flex: 1, padding: '6px 8px', fontSize: 12 }}
                                value={serviceResourceFilter}
                                onChange={(e) => setServiceResourceFilter(e.target.value)}
                                placeholder={t('spbServiceResourcesFilter')}
                              />
                              <button
                                type="button"
                                className="btn"
                                style={{ padding: '6px 10px', fontSize: 12 }}
                                onClick={() => void refreshRemoteResources()}
                                disabled={!profile || remoteResourcesLoading}
                                title={t('spbServiceResourcesRefresh')}
                              >
                                {t('spbServiceResourcesRefresh')}
                              </button>
                            </div>
                            {!profile ? (
                              <div className="text-muted-xs" style={{ marginTop: 6 }}>
                                {t('spvErrorProfileUnset')}
                              </div>
                            ) : null}
                            {remoteResourcesLoading ? (
                              <div className="text-muted-xs" style={{ marginTop: 6 }}>
                                {t('spbServiceResourcesLoading')}
                              </div>
                            ) : null}
                          </div>

                          <div className="dropdown-menu__pad" style={{ paddingTop: 8, paddingBottom: 8 }}>
                            {nodeContextMenu.kind === 'indexer' ? (
                              <>
                                <div className="text-muted-xs" style={{ marginBottom: 6 }}>
                                  {t('spbServiceResourcesIndexers')}
                                </div>
                                {(remoteIndexers || [])
                                  .filter((n) => {
                                    const q = serviceResourceFilter.trim().toLowerCase()
                                    if (!q) return true
                                    return String(n).toLowerCase().includes(q)
                                  })
                                  .slice(0, 200)
                                  .map((name) => (
                                    <button
                                      key={name}
                                      type="button"
                                      className="dropdown-item"
                                      disabled={!profile || remoteResourcesLoading}
                                      title={t('spbServiceResourcesLoadIndexer')}
                                      onClick={() => {
                                        setNodeContextMenu(null)
                                        void loadRemoteIndexerByName(name)
                                      }}
                                    >
                                      {name}
                                    </button>
                                  ))}
                                {remoteIndexers.length === 0 ? <div className="text-muted-xs">{t('spbNone')}</div> : null}
                              </>
                            ) : null}

                            {nodeContextMenu.kind === 'index' ? (
                              <>
                                <div className="text-muted-xs" style={{ marginBottom: 6 }}>
                                  {t('spbServiceResourcesIndexes')}
                                </div>
                                {(remoteIndexes || [])
                                  .filter((n) => {
                                    const q = serviceResourceFilter.trim().toLowerCase()
                                    if (!q) return true
                                    return String(n).toLowerCase().includes(q)
                                  })
                                  .slice(0, 200)
                                  .map((name) => (
                                    <button
                                      key={name}
                                      type="button"
                                      className="dropdown-item"
                                      disabled={!profile || remoteResourcesLoading}
                                      title={t('spbServiceResourcesAddIndexNode')}
                                      onClick={() => {
                                        const nodeId = nodeContextMenu.nodeId
                                        setNodeContextMenu(null)
                                        updateIndexNodeTargetName({ nodeId, targetIndexName: name })
                                      }}
                                    >
                                      {name}
                                    </button>
                                  ))}
                                {remoteIndexes.length === 0 ? <div className="text-muted-xs">{t('spbNone')}</div> : null}
                              </>
                            ) : null}
                          </div>
                        </>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              {edgeContextMenu ? (
                <div
                  className="dropdown-menu show"
                  style={{
                    position: 'fixed',
                    left: Math.min(edgeContextMenu.x, window.innerWidth - 360),
                    top: Math.min(edgeContextMenu.y, window.innerHeight - 220),
                    right: 'auto',
                    width: 280,
                    maxHeight: 220,
                    overflowY: 'auto',
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="dropdown-item"
                    disabled={!edgeContextMenu.deletable}
                    title={!edgeContextMenu.deletable ? t('spbEdgeCannotDelete') : ''}
                    onClick={() => {
                      const id = edgeContextMenu.edgeId
                      const deletable = edgeContextMenu.deletable
                      setEdgeContextMenu(null)
                      if (!deletable) return
                      onEdgesChange([{ id, type: 'remove' }])
                    }}
                  >
                    {t('spbDeleteConnection')}
                  </button>
                </div>
              ) : null}

              {canvasContextMenu ? (
                <div
                  className="dropdown-menu show"
                  style={{
                    position: 'fixed',
                    left: Math.min(canvasContextMenu.x, window.innerWidth - 280),
                    top: Math.min(canvasContextMenu.y, window.innerHeight - 400),
                    right: 'auto',
                    width: 280,
                    maxHeight: 400,
                    overflowY: 'auto',
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="dropdown-header" style={{ fontSize: 11, opacity: 0.7, padding: '4px 12px' }}>
                    {t('spbBuiltInSkillLabel')}
                  </div>
                  {BUILT_IN_SKILL_TEMPLATES.map((tpl) => (
                    <button
                      key={tpl.id}
                      type="button"
                      className="dropdown-item"
                      onClick={() => {
                        const pos = { x: canvasContextMenu.flowX, y: canvasContextMenu.flowY }
                        addSkillWithTemplate(tpl.id, pos)
                      }}
                    >
                      {t(tpl.label as TranslationKey)}
                    </button>
                  ))}
                  <div className="dropdown-divider" />
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => {
                      const pos = { x: canvasContextMenu.flowX, y: canvasContextMenu.flowY }
                      setCanvasContextMenu(null)
                      setNodes((prev) => {
                        const skillCount = prev.filter((x) => (x as any)?.data?.kind === 'skill').length
                        const n = skillCount + 1
                        const id = uuidv4()
                        const skill: SkillPipelineSkillDefinition = {
                          '@odata.type': '',
                          name: `skill${n}`,
                          context: '/document',
                          inputs: [],
                          outputs: [],
                        }
                        const next: SkillPipelineNode = {
                          id,
                          type: 'skill',
                          position: pos,
                          data: { kind: 'skill', skill },
                        }
                        setSelectedNodeId(id)
                        setDraftSkillJson(JSON.stringify(skill, null, 2))
                        setDraftError(null)
                        return [...prev, next]
                      })
                    }}
                  >
                    {t('spbBuiltInSkillNone')}
                  </button>
                </div>
              ) : null}

              <ReactFlow
                nodes={nodes}
                edges={viewEdges}
                nodeTypes={nodeTypes}
                onNodesChange={(changes) => setNodes((prev) => applyNodeChanges(changes, prev))}
                onEdgesChange={onEdgesChange}
                onConnect={(connection: Connection) => {
                  if (!connection.source || !connection.target) return

                  const sourceNode = nodes.find((n) => n.id === connection.source) ?? null
                  const targetNode = nodes.find((n) => n.id === connection.target) ?? null

                  const sourcePath = sourceNode ? getProducedPathForConnection(sourceNode, connection.sourceHandle) : null
                  let link: SkillPipelineEdgeLinkData | undefined
                  let nextTargetSkill: SkillPipelineSkillDefinition | null = null

                  // Skill/doc -> indexer connection: auto-add outputFieldMappings.
                  // Docs: outputFieldMappings map an enrichment-tree node (sourceFieldName) to an index field (targetFieldName).
                  // https://learn.microsoft.com/azure/search/cognitive-search-output-field-mapping
                  // For skills with multiple outputs (e.g. EntityRecognitionSkill: persons, locations, organizations),
                  // we add a mapping for EVERY output, not just the first one.
                  if (sourcePath && targetNode && targetNode.data.kind === 'indexer' && sourceNode) {
                    const allPaths = getAllProducedPaths(sourceNode)
                    setIndexer((prev) => {
                      if (!prev) return prev
                      let updated = prev as unknown as IndexerLike
                      for (const p of allPaths) {
                        updated = appendOutputFieldMappingToIndexer(updated, p)
                      }
                      return updated as any
                    })
                    return
                  }

                  if (sourcePath && targetNode && targetNode.data.kind === 'skill') {
                    const sourceIsCollection = sourceNode ? isSourceOutputCollection(sourceNode) : false
                    const { nextSkill, link: nextLink } = applyConnectionToTargetSkill({
                      targetSkill: targetNode.data.skill,
                      sourcePath,
                      sourceIsCollection,
                    })
                    link = nextLink
                    nextTargetSkill = nextSkill
                    setNodes((prev) =>
                      prev.map((n) => (n.id === targetNode.id ? { ...n, data: { ...n.data, kind: 'skill', skill: nextSkill } } : n)),
                    )

                    if (selectedNodeId === targetNode.id) {
                      setDraftSkillJson(JSON.stringify(nextSkill, null, 2))
                      setDraftError(null)
                    }
                  }

                  // When the new edge targets the same input name as an
                  // existing edge on the same node (e.g. overwriting the
                  // primary input of a fixed-schema built-in skill), remove
                  // the stale edge so the canvas stays in sync with the
                  // skill definition.
                  const newLinkData = link as SkillPipelineEdgeLinkData | undefined
                  const allowedInputNames = nextTargetSkill
                    ? new Set((Array.isArray(nextTargetSkill.inputs) ? nextTargetSkill.inputs : []).map((i) => String(i?.name ?? '')))
                    : null

                  setEdges((prev) => {
                    let base = prev
                    if (connection.target) {
                      base = prev.filter((e) => {
                        if (e.target !== connection.target) return true
                        const eLink = (e as any)?.data as SkillPipelineEdgeLinkData | undefined
                        const inputName = typeof eLink?.targetInputName === 'string' ? eLink.targetInputName : ''
                        if (!inputName) return true
                        if (newLinkData?.targetInputName && inputName === newLinkData.targetInputName) return false
                        if (allowedInputNames && !allowedInputNames.has(inputName)) return false
                        return true
                      })
                    }
                    return addEdge({ ...connection, id: uuidv4(), data: link }, base)
                  })
                }}
                onReconnect={(oldEdge, newConnection: Connection) => {
                  if (!newConnection.source || !newConnection.target) return

                  const oldLink = (oldEdge as any)?.data as SkillPipelineEdgeLinkData | undefined
                  const oldTargetId = typeof (oldEdge as any)?.target === 'string' ? String((oldEdge as any).target) : ''

                  // Revert the old edge's impact on the previous target skill.
                  if (oldLink && oldTargetId) {
                    let nextSelectedSkill: SkillPipelineSkillDefinition | null = null
                    setNodes((prevNodes) =>
                      prevNodes.map((n) => {
                        if (n.id !== oldTargetId) return n
                        if (n.data.kind !== 'skill') return n
                        const nextSkill = revertConnectionOnTargetSkill({ targetSkill: n.data.skill, link: oldLink })
                        if (n.id === selectedNodeId) nextSelectedSkill = nextSkill
                        return { ...n, data: { ...n.data, kind: 'skill', skill: nextSkill } }
                      }),
                    )

                    if (nextSelectedSkill) {
                      setDraftSkillJson(JSON.stringify(nextSelectedSkill, null, 2))
                      setDraftError(null)
                    }
                  }

                  const sourceNode = nodes.find((n) => n.id === newConnection.source) ?? null
                  const targetNode = nodes.find((n) => n.id === newConnection.target) ?? null

                  const sourcePath = sourceNode ? getProducedPathForConnection(sourceNode, newConnection.sourceHandle) : null
                  let link: SkillPipelineEdgeLinkData | undefined
                  let nextTargetSkill: SkillPipelineSkillDefinition | null = null

                  if (sourcePath && targetNode && targetNode.data.kind === 'skill') {
                    const sourceIsCollection = sourceNode ? isSourceOutputCollection(sourceNode) : false
                    const { nextSkill, link: nextLink } = applyConnectionToTargetSkill({
                      targetSkill: targetNode.data.skill,
                      sourcePath,
                      sourceIsCollection,
                    })
                    link = nextLink
                    nextTargetSkill = nextSkill

                    setNodes((prev) =>
                      prev.map((n) => (n.id === targetNode.id ? { ...n, data: { ...n.data, kind: 'skill', skill: nextSkill } } : n)),
                    )

                    if (selectedNodeId === targetNode.id) {
                      setDraftSkillJson(JSON.stringify(nextSkill, null, 2))
                      setDraftError(null)
                    }
                  }

                  const newLinkData = link as SkillPipelineEdgeLinkData | undefined
                  const allowedInputNames = nextTargetSkill
                    ? new Set((Array.isArray(nextTargetSkill.inputs) ? nextTargetSkill.inputs : []).map((i) => String(i?.name ?? '')))
                    : null

                  setEdges((prev) => {
                    const replaced = prev.map((e) =>
                      e.id === String((oldEdge as any)?.id)
                        ? ({ ...e, ...newConnection, data: link } as any)
                        : e,
                    )

                    if (!newConnection.target) return replaced

                    // Keep the updated edge, then remove:
                    // - any other edge pointing at the same input name
                    // - any edge pointing at an input that no longer exists on the skill
                    return replaced.filter((e) => {
                      if (e.id === String((oldEdge as any)?.id)) return true
                      if (e.target !== newConnection.target) return true
                      const eLink = (e as any)?.data as SkillPipelineEdgeLinkData | undefined
                      const inputName = typeof eLink?.targetInputName === 'string' ? eLink.targetInputName : ''
                      if (!inputName) return true
                      if (newLinkData?.targetInputName && inputName === newLinkData.targetInputName) return false
                      if (allowedInputNames && !allowedInputNames.has(inputName)) return false
                      return true
                    })
                  })
                }}
                onNodeClick={(e, node) => {
                  // Some pointer event paths can reach here even for non-left clicks;
                  // don't close context menus on right-click.
                  const btn = typeof (e as any)?.button === 'number' ? Number((e as any).button) : 0
                  if (btn === 2) return

                  canvasKeyRef.current?.focus()
                  setSelectedEdgeId(null)
                  setNodeContextMenu(null)
                  setEdgeContextMenu(null)
                  setCanvasContextMenu(null)
                  onSelectNode(node.id)
                }}
                onNodeContextMenu={(e, node) => {
                  e.preventDefault()
                  e.stopPropagation()
                  canvasKeyRef.current?.focus()

                  setEdgeContextMenu(null)
                  setCanvasContextMenu(null)

                  if (node.data.kind === 'skill') {
                    openSkillContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
                    return
                  }
                  if (node.data.kind === 'doc') {
                    openDocContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
                    return
                  }
                  if (node.data.kind === 'projection') {
                    openProjectionContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
                    return
                  }
                  if (node.data.kind === 'indexer') {
                    openIndexerContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
                    return
                  }
                  if (node.data.kind === 'index') {
                    openIndexContextMenu({ nodeId: node.id, x: e.clientX, y: e.clientY })
                    return
                  }

                  setNodeContextMenu(null)
                }}
                onSelectionChange={(sel) => {
                  const selectedNodes = Array.isArray(sel.nodes) ? sel.nodes : []
                  if (selectedNodes.length !== 1) return
                  const selected = selectedNodes[0]
                  const id = typeof (selected as any)?.id === 'string' ? String((selected as any).id) : ''
                  if (!id || id === selectedNodeId) return
                  setSelectedEdgeId(null)
                  onSelectNode(id)
                }}
                onEdgeClick={(e, edge) => {
                  e.preventDefault()
                  setNodeContextMenu(null)
                  setEdgeContextMenu(null)
                  setSelectedEdgeId(edge.id)
                }}
                onEdgeContextMenu={(e, edge) => {
                  e.preventDefault()
                  e.stopPropagation()
                  canvasKeyRef.current?.focus()

                  setNodeContextMenu(null)
                  setCanvasContextMenu(null)
                  setSelectedEdgeId(edge.id)

                  const deletable = typeof (edge as any)?.deletable === 'boolean' ? Boolean((edge as any).deletable) : true
                  setEdgeContextMenu({ x: e.clientX, y: e.clientY, edgeId: edge.id, deletable })
                }}
                onPaneContextMenu={(e) => {
                  e.preventDefault()
                  setNodeContextMenu(null)
                  setEdgeContextMenu(null)
                  const flowPos = flowRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY }) ?? { x: 0, y: 0 }
                  setCanvasContextMenu({ x: e.clientX, y: e.clientY, flowX: flowPos.x, flowY: flowPos.y })
                }}
                onPaneClick={() => {
                  canvasKeyRef.current?.focus()
                  setSelectedEdgeId(null)
                  setNodeContextMenu(null)
                  setEdgeContextMenu(null)
                  setCanvasContextMenu(null)
                }}
                onInit={(instance) => {
                  flowRef.current = instance
                }}
                fitView
              >
                <Controls showFitView />
                <Background />
                <Panel position="top-right">
                  <button type="button" className="btn btn--tab" onClick={doLayout}>
                    {t('spbToolbarLayout')}
                  </button>
                </Panel>
              </ReactFlow>
            </div>
          </div>

          <div style={{ position: 'absolute', inset: 0, display: mainTab === 'skillsetJson' ? 'block' : 'none' }}>
            <div
              style={{
                height: '100%',
                overflow: 'hidden',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--panel-2)',
              }}
              role="region"
              aria-label={t('spbAriaSkillsetJson')}
            >
              <ExpandableCodeMirror
                t={(k) => String(translations[language][k] ?? '')}
                modalTitle={t('spbGeneratedJson')}
                value={skillsetJson}
                height="calc(100vh - 360px)"
                theme={codeMirrorTheme}
                extensions={[json(), EditorView.lineWrapping, EditorView.editable.of(false)]}
                onChange={() => {
                  // read-only
                }}
              />
            </div>
          </div>

          <div style={{ position: 'absolute', inset: 0, display: mainTab === 'debugRunner' ? 'block' : 'none' }}>
            <div
              style={{
                height: '100%',
                overflow: 'hidden',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--panel-2)',
                padding: 10,
              }}
              role="region"
              aria-label={t('spbAriaDebugRunner')}
            >
              <SkillPipelineDebugRunner
                ref={debugRunnerRef}
                t={t}
                profile={profile}
                apiVersion={apiVersion}
                language={language}
                theme={theme}
                skillsetJson={skillsetJson}
                defaultSkillsetName={skillsetName}
                onFetchedDocs={setDebugFetchedDocs}
                onBusyChange={setDebugBusy}
                onProgressChange={setDebugProgress}
              />
            </div>
          </div>

          <div style={{ position: 'absolute', inset: 0, display: mainTab === 'enrichmentTree' ? 'block' : 'none' }}>
            <div
              style={{
                height: '100%',
                overflow: 'hidden',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--panel-2)',
                padding: 10,
              }}
              role="region"
              aria-label={t('spbAriaEnrichmentTree')}
            >
              <SkillPipelineEnrichmentTreePreview t={t as any} nodes={nodes} indexer={indexer} fetchedDocs={debugFetchedDocs} />
            </div>
          </div>
        </div>
      </div>

      {/* ── Publish to Azure confirmation modal (rendered always, controlled by hook) ─── */}
      <PublishDiffModal
        t={t}
        language={language}
        theme={theme}
        copyToClipboard={copyToClipboard}
        open={publishFlow.saveDiffOpen}
        onClose={publishFlow.closeDiffDialog}
        onConfirmPublish={publishFlow.publishToAzure}
        publishLoading={publishFlow.publishLoading}
        diffViewMode={publishFlow.diffViewMode}
        setDiffViewMode={publishFlow.setDiffViewMode}
        publishBaselineText={publishFlow.publishBaselineText}
        publishCandidateJson={publishFlow.publishCandidateJson}
        semanticDiff={publishFlow.semanticDiff}
        normalizedDiffLineSets={publishFlow.normalizedDiffLineSets}
        publishTargetName={publishFlow.publishTargetName}
        isNewSkillset={publishFlow.isNewSkillset}
        refetchingBaseline={publishFlow.refetchingBaseline}
        onChangeTargetName={publishFlow.changeTargetName}
        existingSkillsetNames={publishFlow.existingSkillsetNames}
      />
    </div>
  )
}
