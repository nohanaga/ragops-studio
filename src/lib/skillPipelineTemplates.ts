import type { SkillPipelineSkillDefinition } from '../contexts'

// ---------------------------------------------------------------------------
// Skill Pipeline Template – category enum
// ---------------------------------------------------------------------------

export type SkillPipelineTemplateCategory =
  | 'rag'
  | 'document'
  | 'compliance'
  | 'analytics'
  | 'vision'
  | 'translation'
  | 'genai'

// ---------------------------------------------------------------------------
// Template shape
// ---------------------------------------------------------------------------

export type SkillPipelineTemplate = {
  id: string
  nameKey: string
  descriptionKey: string
  category: SkillPipelineTemplateCategory
  categoryKey: string
  icon: string // Bootstrap Icon CSS class
  skills: SkillPipelineSkillDefinition[]
}

// ---------------------------------------------------------------------------
// Category metadata (label keys & icons)
// ---------------------------------------------------------------------------

export const TEMPLATE_CATEGORIES: { key: SkillPipelineTemplateCategory; labelKey: string; icon: string }[] = [
  { key: 'rag', labelKey: 'spbTemplateCatRag', icon: 'bi-search' },
  { key: 'document', labelKey: 'spbTemplateCatDocument', icon: 'bi-file-earmark-text' },
  { key: 'compliance', labelKey: 'spbTemplateCatCompliance', icon: 'bi-shield-check' },
  { key: 'analytics', labelKey: 'spbTemplateCatAnalytics', icon: 'bi-bar-chart-line' },
  { key: 'vision', labelKey: 'spbTemplateCatVision', icon: 'bi-image' },
  { key: 'translation', labelKey: 'spbTemplateCatTranslation', icon: 'bi-translate' },
  { key: 'genai', labelKey: 'spbTemplateCatGenAI', icon: 'bi-robot' },
]

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

export const SKILL_PIPELINE_TEMPLATES: SkillPipelineTemplate[] = [
  // ── RAG / Vectorization ──────────────────────────────────────────────
  {
    id: 'rag-chunking-embedding',
    nameKey: 'spbTplRagChunkEmbed',
    descriptionKey: 'spbTplRagChunkEmbedDesc',
    category: 'rag',
    categoryKey: 'spbTemplateCatRag',
    icon: 'bi-search',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
        name: 'splitText',
        context: '/document',
        textSplitMode: 'pages',
        maximumPageLength: 2000,
        pageOverlapLength: 500,
        defaultLanguageCode: 'en',
        inputs: [{ name: 'text', source: '/document/content' }],
        outputs: [{ name: 'textItems', targetName: 'pages' }],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill',
        name: 'embedding',
        context: '/document/pages/*',
        resourceUri: 'https://YOUR-RESOURCE.openai.azure.com',
        deploymentId: 'YOUR-EMBEDDING-DEPLOYMENT',
        modelName: 'text-embedding-3-small',
        inputs: [{ name: 'text', source: '/document/pages/*' }],
        outputs: [{ name: 'embedding', targetName: 'vector' }],
      } as SkillPipelineSkillDefinition,
    ],
  },

  {
    id: 'rag-multilingual',
    nameKey: 'spbTplRagMultilingual',
    descriptionKey: 'spbTplRagMultilingualDesc',
    category: 'rag',
    categoryKey: 'spbTemplateCatRag',
    icon: 'bi-translate',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Text.LanguageDetectionSkill',
        name: 'languageDetection',
        context: '/document',
        inputs: [{ name: 'text', source: '/document/content' }],
        outputs: [{ name: 'languageCode', targetName: 'languageCode' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.TranslationSkill',
        name: 'translateText',
        context: '/document',
        defaultToLanguageCode: 'en',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'fromLanguageCode', source: '/document/languageCode' },
        ],
        outputs: [
          { name: 'translatedText', targetName: 'translatedText' },
          { name: 'translatedToLanguageCode', targetName: 'translatedToLanguageCode' },
          { name: 'translatedFromLanguageCode', targetName: 'translatedFromLanguageCode' },
        ],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
        name: 'splitText',
        context: '/document',
        textSplitMode: 'pages',
        maximumPageLength: 2000,
        pageOverlapLength: 500,
        defaultLanguageCode: 'en',
        inputs: [{ name: 'text', source: '/document/translatedText' }],
        outputs: [{ name: 'textItems', targetName: 'pages' }],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill',
        name: 'embedding',
        context: '/document/pages/*',
        resourceUri: 'https://YOUR-RESOURCE.openai.azure.com',
        deploymentId: 'YOUR-EMBEDDING-DEPLOYMENT',
        modelName: 'text-embedding-3-small',
        inputs: [{ name: 'text', source: '/document/pages/*' }],
        outputs: [{ name: 'embedding', targetName: 'vector' }],
      } as SkillPipelineSkillDefinition,
    ],
  },

  {
    id: 'rag-genai-enrichment',
    nameKey: 'spbTplRagGenAIEnrich',
    descriptionKey: 'spbTplRagGenAIEnrichDesc',
    category: 'rag',
    categoryKey: 'spbTemplateCatRag',
    icon: 'bi-robot',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
        name: 'splitText',
        context: '/document',
        textSplitMode: 'pages',
        maximumPageLength: 2000,
        pageOverlapLength: 500,
        defaultLanguageCode: 'en',
        inputs: [{ name: 'text', source: '/document/content' }],
        outputs: [{ name: 'textItems', targetName: 'pages' }],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Custom.ChatCompletionSkill',
        name: 'summarize',
        context: '/document',
        uri: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/gpt-4o/chat/completions',
        apiKey: '',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'systemMessage', source: "='You are a helpful AI assistant.'" },
          { name: 'userMessage', source: "='Summarize the following text concisely:'" },
        ],
        outputs: [{ name: 'response', targetName: 'summary' }],
        commonModelParameters: { temperature: 0.3, maxTokens: 512 },
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill',
        name: 'chunkEmbedding',
        context: '/document/pages/*',
        resourceUri: 'https://YOUR-RESOURCE.openai.azure.com',
        deploymentId: 'YOUR-EMBEDDING-DEPLOYMENT',
        modelName: 'text-embedding-3-small',
        inputs: [{ name: 'text', source: '/document/pages/*' }],
        outputs: [{ name: 'embedding', targetName: 'chunkVector' }],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill',
        name: 'summaryEmbedding',
        context: '/document',
        resourceUri: 'https://YOUR-RESOURCE.openai.azure.com',
        deploymentId: 'YOUR-EMBEDDING-DEPLOYMENT',
        modelName: 'text-embedding-3-small',
        inputs: [{ name: 'text', source: '/document/summary' }],
        outputs: [{ name: 'embedding', targetName: 'summaryVector' }],
      } as SkillPipelineSkillDefinition,
    ],
  },

  // ── Document Processing ──────────────────────────────────────────────
  {
    id: 'document-cracking-ocr',
    nameKey: 'spbTplDocOcr',
    descriptionKey: 'spbTplDocOcrDesc',
    category: 'document',
    categoryKey: 'spbTemplateCatDocument',
    icon: 'bi-file-earmark-text',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Vision.OcrSkill',
        name: 'ocr',
        context: '/document/normalized_images/*',
        defaultLanguageCode: 'en',
        inputs: [{ name: 'image', source: '/document/normalized_images/*' }],
        outputs: [{ name: 'text', targetName: 'ocrText' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.MergeSkill',
        name: 'mergeText',
        context: '/document',
        insertPreTag: ' ',
        insertPostTag: ' ',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'itemsToInsert', source: '/document/normalized_images/*/ocrText' },
          { name: 'offsets', source: '/document/normalized_images/*/contentOffset' },
        ],
        outputs: [{ name: 'mergedText', targetName: 'mergedText' }],
      },
    ],
  },

  {
    id: 'document-full-enrichment',
    nameKey: 'spbTplDocFullEnrich',
    descriptionKey: 'spbTplDocFullEnrichDesc',
    category: 'document',
    categoryKey: 'spbTemplateCatDocument',
    icon: 'bi-file-earmark-richtext',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Vision.OcrSkill',
        name: 'ocr',
        context: '/document/normalized_images/*',
        defaultLanguageCode: 'en',
        inputs: [{ name: 'image', source: '/document/normalized_images/*' }],
        outputs: [{ name: 'text', targetName: 'ocrText' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.MergeSkill',
        name: 'mergeText',
        context: '/document',
        insertPreTag: ' ',
        insertPostTag: ' ',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'itemsToInsert', source: '/document/normalized_images/*/ocrText' },
          { name: 'offsets', source: '/document/normalized_images/*/contentOffset' },
        ],
        outputs: [{ name: 'mergedText', targetName: 'mergedText' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.LanguageDetectionSkill',
        name: 'languageDetection',
        context: '/document',
        inputs: [{ name: 'text', source: '/document/mergedText' }],
        outputs: [{ name: 'languageCode', targetName: 'languageCode' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
        name: 'splitText',
        context: '/document',
        textSplitMode: 'pages',
        maximumPageLength: 5000,
        pageOverlapLength: 0,
        defaultLanguageCode: 'en',
        inputs: [
          { name: 'text', source: '/document/mergedText' },
          { name: 'languageCode', source: '/document/languageCode' },
        ],
        outputs: [{ name: 'textItems', targetName: 'pages' }],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Text.V3.EntityRecognitionSkill',
        name: 'entityRecognition',
        context: '/document/pages/*',
        categories: ['Person', 'Organization', 'Location'],
        defaultLanguageCode: 'en',
        inputs: [
          { name: 'text', source: '/document/pages/*' },
          { name: 'languageCode', source: '/document/languageCode' },
        ],
        outputs: [
          { name: 'persons', targetName: 'persons' },
          { name: 'organizations', targetName: 'organizations' },
          { name: 'locations', targetName: 'locations' },
        ],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
        name: 'keyPhrases',
        context: '/document/pages/*',
        defaultLanguageCode: 'en',
        inputs: [
          { name: 'text', source: '/document/pages/*' },
          { name: 'languageCode', source: '/document/languageCode' },
        ],
        outputs: [{ name: 'keyPhrases', targetName: 'keyPhrases' }],
      },
    ],
  },

  {
    id: 'document-ocr-vectorize',
    nameKey: 'spbTplDocOcrVectorize',
    descriptionKey: 'spbTplDocOcrVectorizeDesc',
    category: 'document',
    categoryKey: 'spbTemplateCatDocument',
    icon: 'bi-filetype-pdf',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Vision.OcrSkill',
        name: 'ocr',
        context: '/document/normalized_images/*',
        defaultLanguageCode: 'en',
        inputs: [{ name: 'image', source: '/document/normalized_images/*' }],
        outputs: [{ name: 'text', targetName: 'ocrText' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.MergeSkill',
        name: 'mergeText',
        context: '/document',
        insertPreTag: ' ',
        insertPostTag: ' ',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'itemsToInsert', source: '/document/normalized_images/*/ocrText' },
          { name: 'offsets', source: '/document/normalized_images/*/contentOffset' },
        ],
        outputs: [{ name: 'mergedText', targetName: 'mergedText' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
        name: 'splitText',
        context: '/document',
        textSplitMode: 'pages',
        maximumPageLength: 2000,
        pageOverlapLength: 500,
        defaultLanguageCode: 'en',
        inputs: [{ name: 'text', source: '/document/mergedText' }],
        outputs: [{ name: 'textItems', targetName: 'pages' }],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Text.AzureOpenAIEmbeddingSkill',
        name: 'embedding',
        context: '/document/pages/*',
        resourceUri: 'https://YOUR-RESOURCE.openai.azure.com',
        deploymentId: 'YOUR-EMBEDDING-DEPLOYMENT',
        modelName: 'text-embedding-3-small',
        inputs: [{ name: 'text', source: '/document/pages/*' }],
        outputs: [{ name: 'embedding', targetName: 'vector' }],
      } as SkillPipelineSkillDefinition,
    ],
  },

  // ── Compliance & PII ─────────────────────────────────────────────────
  {
    id: 'pii-redaction',
    nameKey: 'spbTplPiiRedaction',
    descriptionKey: 'spbTplPiiRedactionDesc',
    category: 'compliance',
    categoryKey: 'spbTemplateCatCompliance',
    icon: 'bi-shield-check',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Text.LanguageDetectionSkill',
        name: 'languageDetection',
        context: '/document',
        inputs: [{ name: 'text', source: '/document/content' }],
        outputs: [{ name: 'languageCode', targetName: 'languageCode' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.PIIDetectionSkill',
        name: 'piiDetection',
        context: '/document',
        defaultLanguageCode: 'en',
        maskingMode: 'replace',
        maskingCharacter: '*',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'languageCode', source: '/document/languageCode' },
        ],
        outputs: [
          { name: 'piiEntities', targetName: 'piiEntities' },
          { name: 'maskedText', targetName: 'maskedText' },
        ],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
        name: 'splitText',
        context: '/document',
        textSplitMode: 'pages',
        maximumPageLength: 2000,
        pageOverlapLength: 500,
        defaultLanguageCode: 'en',
        inputs: [{ name: 'text', source: '/document/maskedText' }],
        outputs: [{ name: 'textItems', targetName: 'pages' }],
      } as SkillPipelineSkillDefinition,
    ],
  },

  // ── Analytics & NLP ──────────────────────────────────────────────────
  {
    id: 'nlp-analytics',
    nameKey: 'spbTplNlpAnalytics',
    descriptionKey: 'spbTplNlpAnalyticsDesc',
    category: 'analytics',
    categoryKey: 'spbTemplateCatAnalytics',
    icon: 'bi-bar-chart-line',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Text.LanguageDetectionSkill',
        name: 'languageDetection',
        context: '/document',
        inputs: [{ name: 'text', source: '/document/content' }],
        outputs: [{ name: 'languageCode', targetName: 'languageCode' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.V3.SentimentSkill',
        name: 'sentiment',
        context: '/document',
        defaultLanguageCode: 'en',
        includeOpinionMining: true,
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'languageCode', source: '/document/languageCode' },
        ],
        outputs: [
          { name: 'sentiment', targetName: 'sentiment' },
          { name: 'confidenceScores', targetName: 'confidenceScores' },
          { name: 'sentences', targetName: 'sentences' },
        ],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Text.V3.EntityRecognitionSkill',
        name: 'entityRecognition',
        context: '/document',
        categories: ['Person', 'Organization', 'Location', 'Event'],
        defaultLanguageCode: 'en',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'languageCode', source: '/document/languageCode' },
        ],
        outputs: [
          { name: 'persons', targetName: 'persons' },
          { name: 'organizations', targetName: 'organizations' },
          { name: 'locations', targetName: 'locations' },
        ],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
        name: 'keyPhrases',
        context: '/document',
        defaultLanguageCode: 'en',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'languageCode', source: '/document/languageCode' },
        ],
        outputs: [{ name: 'keyPhrases', targetName: 'keyPhrases' }],
      },
    ],
  },

  {
    id: 'entity-linking-enrichment',
    nameKey: 'spbTplEntityLinking',
    descriptionKey: 'spbTplEntityLinkingDesc',
    category: 'analytics',
    categoryKey: 'spbTemplateCatAnalytics',
    icon: 'bi-diagram-3',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Text.LanguageDetectionSkill',
        name: 'languageDetection',
        context: '/document',
        inputs: [{ name: 'text', source: '/document/content' }],
        outputs: [{ name: 'languageCode', targetName: 'languageCode' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.V3.EntityRecognitionSkill',
        name: 'entityRecognition',
        context: '/document',
        categories: ['Person', 'Organization', 'Location'],
        defaultLanguageCode: 'en',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'languageCode', source: '/document/languageCode' },
        ],
        outputs: [
          { name: 'persons', targetName: 'persons' },
          { name: 'organizations', targetName: 'organizations' },
          { name: 'locations', targetName: 'locations' },
        ],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Text.V3.EntityLinkingSkill',
        name: 'entityLinking',
        context: '/document',
        defaultLanguageCode: 'en',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'languageCode', source: '/document/languageCode' },
        ],
        outputs: [{ name: 'entities', targetName: 'linkedEntities' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.KeyPhraseExtractionSkill',
        name: 'keyPhrases',
        context: '/document',
        defaultLanguageCode: 'en',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'languageCode', source: '/document/languageCode' },
        ],
        outputs: [{ name: 'keyPhrases', targetName: 'keyPhrases' }],
      },
    ],
  },

  // ── Vision & Multimodal ──────────────────────────────────────────────
  {
    id: 'image-analysis-enrichment',
    nameKey: 'spbTplImageAnalysis',
    descriptionKey: 'spbTplImageAnalysisDesc',
    category: 'vision',
    categoryKey: 'spbTemplateCatVision',
    icon: 'bi-image',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Vision.OcrSkill',
        name: 'ocr',
        context: '/document/normalized_images/*',
        defaultLanguageCode: 'en',
        inputs: [{ name: 'image', source: '/document/normalized_images/*' }],
        outputs: [{ name: 'text', targetName: 'ocrText' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Vision.ImageAnalysisSkill',
        name: 'imageAnalysis',
        context: '/document/normalized_images/*',
        defaultLanguageCode: 'en',
        visualFeatures: ['description', 'tags'],
        inputs: [{ name: 'image', source: '/document/normalized_images/*' }],
        outputs: [
          { name: 'description', targetName: 'imageDescription' },
          { name: 'tags', targetName: 'imageTags' },
        ],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Text.MergeSkill',
        name: 'mergeText',
        context: '/document',
        insertPreTag: ' ',
        insertPostTag: ' ',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'itemsToInsert', source: '/document/normalized_images/*/ocrText' },
          { name: 'offsets', source: '/document/normalized_images/*/contentOffset' },
        ],
        outputs: [{ name: 'mergedText', targetName: 'mergedText' }],
      },
    ],
  },

  // ── Translation & Multilingual ───────────────────────────────────────
  {
    id: 'translation-pipeline',
    nameKey: 'spbTplTranslation',
    descriptionKey: 'spbTplTranslationDesc',
    category: 'translation',
    categoryKey: 'spbTemplateCatTranslation',
    icon: 'bi-translate',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Text.LanguageDetectionSkill',
        name: 'languageDetection',
        context: '/document',
        inputs: [{ name: 'text', source: '/document/content' }],
        outputs: [{ name: 'languageCode', targetName: 'languageCode' }],
      },
      {
        '@odata.type': '#Microsoft.Skills.Text.TranslationSkill',
        name: 'translateText',
        context: '/document',
        defaultToLanguageCode: 'en',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'fromLanguageCode', source: '/document/languageCode' },
        ],
        outputs: [
          { name: 'translatedText', targetName: 'translatedText' },
          { name: 'translatedToLanguageCode', targetName: 'translatedToLanguageCode' },
          { name: 'translatedFromLanguageCode', targetName: 'translatedFromLanguageCode' },
        ],
      },
    ],
  },

  // ── GenAI / Custom ───────────────────────────────────────────────────
  {
    id: 'genai-custom-enrichment',
    nameKey: 'spbTplGenAICustom',
    descriptionKey: 'spbTplGenAICustomDesc',
    category: 'genai',
    categoryKey: 'spbTemplateCatGenAI',
    icon: 'bi-robot',
    skills: [
      {
        '@odata.type': '#Microsoft.Skills.Text.SplitSkill',
        name: 'splitText',
        context: '/document',
        textSplitMode: 'pages',
        maximumPageLength: 4000,
        pageOverlapLength: 200,
        defaultLanguageCode: 'en',
        inputs: [{ name: 'text', source: '/document/content' }],
        outputs: [{ name: 'textItems', targetName: 'pages' }],
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Custom.ChatCompletionSkill',
        name: 'categorize',
        context: '/document',
        uri: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/gpt-4o/chat/completions',
        apiKey: '',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'systemMessage', source: "='You are a document classifier. Return a JSON object with \"category\" and \"tags\" fields.'" },
          { name: 'userMessage', source: "='Classify the following document:'" },
        ],
        outputs: [{ name: 'response', targetName: 'classification' }],
        commonModelParameters: { temperature: 0, maxTokens: 256 },
      } as SkillPipelineSkillDefinition,
      {
        '@odata.type': '#Microsoft.Skills.Custom.ChatCompletionSkill',
        name: 'summarize',
        context: '/document',
        uri: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/gpt-4o/chat/completions',
        apiKey: '',
        inputs: [
          { name: 'text', source: '/document/content' },
          { name: 'systemMessage', source: "='You are a helpful AI assistant.'" },
          { name: 'userMessage', source: "='Provide a concise summary of the following text in 2-3 sentences:'" },
        ],
        outputs: [{ name: 'response', targetName: 'summary' }],
        commonModelParameters: { temperature: 0.3, maxTokens: 512 },
      } as SkillPipelineSkillDefinition,
    ],
  },
]
