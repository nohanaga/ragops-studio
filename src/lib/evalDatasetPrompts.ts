/**
 * Prompts for the Eval Dataset Generator (EDAG, Phase 1 MVP).
 *
 * Built following InPars / Promptagator style:
 *   - System prompt instructs strict grounding to the supplied excerpt.
 *   - User prompt includes a small number of few-shot exemplars and forces
 *     a JSON-only response shape (Azure OpenAI JSON mode compatible).
 */

import type { EvalLanguage, EvalQueryType } from '../types'

export interface BuildPromptParams {
  language: EvalLanguage
  queryTypes: EvalQueryType[]
  queriesPerDoc: number
  docId: string
  chunkText: string
  domainDescription?: string
  /** Phase 4: optional RAGEval-style schema injected as a structured note. */
  domainSchema?: import('../types').DomainSchema
}

export interface ExpectedQueryObject {
  query: string
  query_type: EvalQueryType
}

export interface ExpectedResponseShape {
  queries: ExpectedQueryObject[]
}

const TYPE_DEFINITIONS_JA: Record<EvalQueryType, string> = {
  factoid: '事実確認(factoid): 単一の事実・定義・固有名詞・数値などを尋ねる質問',
  'how-to': '手順(how-to): 「どのように〜するか」「手順は」など手順や方法を尋ねる質問',
  comparative: '比較(comparative): 2つ以上の概念・選択肢・値を比較する質問 (例: 「AとBの違いは」「どちらが速いか」)',
  'yes-no': 'Yes/No(yes-no): はい/いいえ で答えられる質問 (例: 「〜は可能か」「〜はサポートされているか」)',
}

const TYPE_DEFINITIONS_EN: Record<EvalQueryType, string> = {
  factoid: 'factoid: a question about a single fact, definition, proper noun, or number',
  'how-to': 'how-to: a question asking how to do something or describing a procedure',
  comparative: 'comparative: a question that compares two or more concepts/options/values (e.g., "What is the difference between A and B?", "Which is faster?")',
  'yes-no': 'yes-no: a question answerable with yes or no (e.g., "Is X supported?", "Can Y do Z?")',
}

function buildAllowedTypeBlock(language: EvalLanguage, queryTypes: EvalQueryType[]): string {
  const defs = language === 'ja' ? TYPE_DEFINITIONS_JA : TYPE_DEFINITIONS_EN
  const list = queryTypes.length > 0 ? queryTypes : (['factoid'] as EvalQueryType[])
  return list.map((t) => `- ${defs[t]}`).join('\n')
}

function buildFewShot(language: EvalLanguage, queryTypes: EvalQueryType[]): string {
  const list = queryTypes.length > 0 ? queryTypes : (['factoid'] as EvalQueryType[])
  const samplesJa: Record<EvalQueryType, ExpectedQueryObject> = {
    factoid: { query: 'Azure AI Search のセマンティックランカーは何のために使うのか？', query_type: 'factoid' },
    'how-to': { query: 'ベクトル検索インデックスを作成する手順は？', query_type: 'how-to' },
    comparative: { query: 'BM25 とセマンティックランカーの違いは何か？', query_type: 'comparative' },
    'yes-no': { query: 'Azure AI Search はベクトル検索をサポートしているか？', query_type: 'yes-no' },
  }
  const samplesEn: Record<EvalQueryType, ExpectedQueryObject> = {
    factoid: { query: 'What is the semantic ranker in Azure AI Search used for?', query_type: 'factoid' },
    'how-to': { query: 'How do you create a vector search index?', query_type: 'how-to' },
    comparative: { query: 'What is the difference between BM25 and the semantic ranker?', query_type: 'comparative' },
    'yes-no': { query: 'Does Azure AI Search support vector search?', query_type: 'yes-no' },
  }
  const samples = language === 'ja' ? samplesJa : samplesEn
  const items = list.map((t) => samples[t])
  const header = language === 'ja' ? '例:' : 'Example:'
  return `${header}\n${JSON.stringify({ queries: items })}`
}

export function buildSystemPrompt(language: EvalLanguage, domainDescription?: string): string {
  if (language === 'ja') {
    return [
      'あなたは検索エンジン（Azure AI Search）の精度評価用データセットを作成する専門家です。',
      '与えられたドキュメント抜粋から、ユーザーが実際に検索しそうな質問を生成してください。',
      '制約:',
      '- 抜粋本文だけで答えられる内容のみ',
      '- 固有名詞・数値はそのまま用いる',
      '- 1質問につき1観点のみ',
      '- 抽象的すぎる質問・複数文書を必要とする質問は禁止',
      '- 出力は必ず指定された JSON スキーマに従うこと（追加のテキスト・コードフェンス禁止）',
      '- query_type は必ず allowed_types のいずれかを使用し、それ以外を出力してはいけない',
      '- allowed_types に複数のタイプが指定されている場合は、可能な限り均等に分散させる',
      domainDescription ? `ドメイン補足: ${domainDescription}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
  return [
    'You are an expert in building evaluation datasets for search engines (Azure AI Search).',
    'Given an excerpt from a document, generate queries a real user is likely to search.',
    'Constraints:',
    '- The query must be answerable solely from the supplied excerpt.',
    '- Preserve proper nouns and numeric values verbatim.',
    '- Each query must focus on a single aspect.',
    '- Avoid overly abstract queries or queries that require multiple documents.',
    '- Output MUST strictly follow the specified JSON schema (no prose, no code fences).',
    '- query_type MUST be one of the allowed_types; never use a value outside that list.',
    '- When multiple allowed_types are specified, distribute the generated queries across them as evenly as possible.',
    domainDescription ? `Domain note: ${domainDescription}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildUserPrompt(params: BuildPromptParams): string {
  const { language, queryTypes, queriesPerDoc, docId, chunkText, domainSchema } = params
  const types = queryTypes.length > 0 ? queryTypes.join(',') : 'factoid'
  const typeBlock = buildAllowedTypeBlock(language, queryTypes)
  const fewShot = buildFewShot(language, queryTypes)
  const schemaBlock = renderDomainSchema(language, domainSchema)

  if (language === 'ja') {
    const lines = [
      `[language=ja] [allowed_types=${types}] [doc_id=${docId}]`,
      `次の本文から、検索クエリを ${queriesPerDoc} 件生成してください。`,
      'query_type は必ず以下のいずれかを使用してください:',
      typeBlock,
      'JSON スキーマ: { "queries": [{ "query": string, "query_type": "' + types.split(',').join('"|"') + '" }, ...] }',
    ]
    if (schemaBlock) lines.push(schemaBlock)
    lines.push(fewShot, '---本文---', chunkText, '---本文ここまで---')
    return lines.join('\n')
  }
  const lines = [
    `[language=en] [allowed_types=${types}] [doc_id=${docId}]`,
    `Generate ${queriesPerDoc} search queries from the following excerpt.`,
    'query_type MUST be exactly one of:',
    typeBlock,
    'JSON schema: { "queries": [{ "query": string, "query_type": "' + types.split(',').join('"|"') + '" }, ...] }',
  ]
  if (schemaBlock) lines.push(schemaBlock)
  lines.push(fewShot, '---BEGIN EXCERPT---', chunkText, '---END EXCERPT---')
  return lines.join('\n')
}

/* --------------------------------------------------------------------- */
/* Phase 4: Domain schema (RAGEval) renderer                              */
/* --------------------------------------------------------------------- */

/**
 * Renders the (optional) domain schema as a structured note. Returns an
 * empty string when no schema fields are populated, so existing prompts
 * remain byte-identical (snapshot-safe).
 */
export function renderDomainSchema(
  language: EvalLanguage,
  schema?: import('../types').DomainSchema,
): string {
  if (!schema) return ''
  const e = schema.entities?.trim()
  const r = schema.relations?.trim()
  const c = schema.constraints?.trim()
  if (!e && !r && !c) return ''
  if (language === 'ja') {
    const parts = ['ドメインスキーマ:']
    if (e) parts.push(`  - エンティティ: ${e}`)
    if (r) parts.push(`  - 関係: ${r}`)
    if (c) parts.push(`  - 制約: ${c}`)
    return parts.join('\n')
  }
  const parts = ['Domain schema:']
  if (e) parts.push(`  - entities: ${e}`)
  if (r) parts.push(`  - relations: ${r}`)
  if (c) parts.push(`  - constraints: ${c}`)
  return parts.join('\n')
}

/* --------------------------------------------------------------------- */
/* Phase 4: Evol-Instruct (easy → hard) rewrite prompt                    */
/* --------------------------------------------------------------------- */

export interface BuildHardenPromptParams {
  language: EvalLanguage
  query: string
  /** Original excerpt(s) so the harder rewrite stays answerable. */
  contextText: string
}

export function buildHardenSystemPrompt(language: EvalLanguage): string {
  if (language === 'ja') {
    return [
      'あなたは検索クエリを「より難しいが、依然として与えられた本文だけで回答可能な」形に書き換える専門家です。',
      '難化の手段例: 言い換え (paraphrase) / 否定形への変換 / 数値や条件の集約 / 一段抽象化 / 同義語置換。',
      '禁止事項: 本文に書かれていない事実を加えない / 答えを書かない / 元の意図を失わない。',
      '出力は必ず指定された JSON スキーマに従うこと（追加のテキスト・コードフェンス禁止）。',
    ].join('\n')
  }
  return [
    'You rewrite a search query into a HARDER variant that is STILL answerable from the supplied excerpt only.',
    'Tactics: paraphrase / negation / numeric or conditional aggregation / one level of abstraction / synonym substitution.',
    'Never invent facts that are not in the excerpt, never include the answer, and never drift from the original intent.',
    'Output MUST strictly follow the specified JSON schema (no prose, no code fences).',
  ].join('\n')
}

export function buildHardenUserPrompt(params: BuildHardenPromptParams): string {
  const { language, query, contextText } = params
  if (language === 'ja') {
    return [
      `[language=ja] 以下のクエリをより難しい形に書き換えてください。`,
      `元クエリ: ${query}`,
      'JSON スキーマ: { "query": string }',
      '---本文---',
      contextText,
      '---本文ここまで---',
    ].join('\n')
  }
  return [
    `[language=en] Rewrite the query below into a harder variant.`,
    `original query: ${query}`,
    'JSON schema: { "query": string }',
    '---BEGIN EXCERPT---',
    contextText,
    '---END EXCERPT---',
  ].join('\n')
}

/* --------------------------------------------------------------------- */
/* Ragas-style scenario prompts (Phase 3)                                */
/* --------------------------------------------------------------------- */

import type { EvalLength, EvalStyle, QueryShape } from '../types'

export interface BuildScenarioPromptParams {
  language: EvalLanguage
  /** Excerpts to ground the query in. 1 entry = single-hop, ≥2 = multi-hop. */
  docs: { id: string; text: string }[]
  shape: QueryShape
  persona?: string
  style?: EvalStyle
  length?: EvalLength
  domainDescription?: string
  /** Phase 4: optional RAGEval-style schema. */
  domainSchema?: import('../types').DomainSchema
}

const SHAPE_DESCRIPTIONS_JA: Record<QueryShape, string> = {
  single_specific:
    'single_specific: 単一文書から、固有名詞・数値・定義などの具体的な事実を尋ねる短い質問。',
  single_abstract:
    'single_abstract: 単一文書を踏まえつつ、要約・解釈・「なぜ/どのように」といった抽象度の高い質問。',
  multi_specific:
    'multi_specific: 提示された複数文書すべてを参照しないと答えられない、具体的な比較・差分質問 (例: 「A と B の違いは」)。',
  multi_abstract:
    'multi_abstract: 複数文書を横断して総合的に解釈・要約する高次の質問 (例: 「A から C への変化を述べよ」)。',
}

const SHAPE_DESCRIPTIONS_EN: Record<QueryShape, string> = {
  single_specific:
    'single_specific: Short fact lookup grounded in a single document (proper noun, number, or definition).',
  single_abstract:
    'single_abstract: Higher-level "why/how/summarise" question grounded in a single document.',
  multi_specific:
    'multi_specific: Concrete comparison/diff question that requires consulting all supplied documents (e.g. "What is the difference between A and B?").',
  multi_abstract:
    'multi_abstract: Cross-document synthesis or summarisation that spans all supplied documents (e.g. "Describe the evolution from A to C").',
}

const STYLE_HINTS_JA: Record<EvalStyle, string> = {
  web_search: '検索エンジンに入力する短いキーワード列に近い形式',
  chat: 'チャットボットへの自然な口語形式',
  formal: '社内ナレッジ検索のような丁寧で形式的な書き方',
  informal: 'カジュアルで砕けた口語',
}

const STYLE_HINTS_EN: Record<EvalStyle, string> = {
  web_search: 'short keyword-style query as typed into a search engine',
  chat: 'natural conversational style as typed into a chatbot',
  formal: 'polite, formal phrasing typical of an internal knowledge search',
  informal: 'casual, colloquial phrasing',
}

const LENGTH_HINTS_JA: Record<EvalLength, string> = {
  short: '10〜25 文字程度',
  medium: '25〜60 文字程度',
  long: '60〜120 文字程度',
}

const LENGTH_HINTS_EN: Record<EvalLength, string> = {
  short: '5–10 words',
  medium: '10–20 words',
  long: '20–35 words',
}

export function buildScenarioSystemPrompt(
  language: EvalLanguage,
  domainDescription?: string,
): string {
  if (language === 'ja') {
    return [
      'あなたは検索エンジン (Azure AI Search) の評価データセットを作成する専門家です。',
      'Ragas の 4 象限 (single/multi × specific/abstract) に従って、与えられたドキュメント抜粋から評価クエリを 1 件だけ生成してください。',
      '制約:',
      '- query は提示された本文だけを根拠に答えられること',
      '- multi_* の場合は、提示された全ての本文を参照しないと答えられない質問にすること',
      '- 抽象的すぎる質問・本文外の知識を必要とする質問は禁止',
      '- 出力は必ず指定された JSON スキーマに従うこと (追加のテキスト・コードフェンス禁止)',
      '- 1 ターンにつき 1 件のみ生成',
      domainDescription ? `ドメイン補足: ${domainDescription}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
  return [
    'You are an expert in building evaluation datasets for search engines (Azure AI Search).',
    'Following Ragas\' 4-quadrant taxonomy (single/multi × specific/abstract), generate exactly ONE evaluation query from the supplied document excerpt(s).',
    'Constraints:',
    '- The query MUST be answerable solely from the supplied excerpt(s).',
    '- For multi_* shapes, the query MUST require consulting ALL supplied excerpts.',
    '- Avoid overly abstract questions or questions requiring outside knowledge.',
    '- Output MUST strictly follow the specified JSON schema (no prose, no code fences).',
    '- Generate exactly one query per call.',
    domainDescription ? `Domain note: ${domainDescription}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildScenarioUserPrompt(params: BuildScenarioPromptParams): string {
  const { language, docs, shape, persona, style, length, domainSchema } = params
  const isMulti = shape.startsWith('multi_')
  const docIds = docs.map((d) => d.id).join(',')

  const shapeDesc =
    language === 'ja' ? SHAPE_DESCRIPTIONS_JA[shape] : SHAPE_DESCRIPTIONS_EN[shape]
  const styleHint = style
    ? language === 'ja'
      ? STYLE_HINTS_JA[style]
      : STYLE_HINTS_EN[style]
    : undefined
  const lengthHint = length
    ? language === 'ja'
      ? LENGTH_HINTS_JA[length]
      : LENGTH_HINTS_EN[length]
    : undefined

  const sections: string[] = []
  if (language === 'ja') {
    sections.push(
      `[language=ja] [shape=${shape}] [doc_ids=${docIds}] [docs=${docs.length}]`,
      `生成形式: ${shapeDesc}`,
    )
    if (persona) sections.push(`想定ユーザ (persona): ${persona}`)
    if (styleHint) sections.push(`文体 (style): ${styleHint}`)
    if (lengthHint) sections.push(`長さ (length): ${lengthHint}`)
    sections.push(
      isMulti
        ? '以下の複数の本文すべてを参照しないと答えられない質問を 1 件生成してください。'
        : '以下の本文から答えられる質問を 1 件生成してください。',
      'JSON スキーマ: { "query": string, "query_shape": "' + shape + '" }',
    )
  } else {
    sections.push(
      `[language=en] [shape=${shape}] [doc_ids=${docIds}] [docs=${docs.length}]`,
      `Shape: ${shapeDesc}`,
    )
    if (persona) sections.push(`Persona: ${persona}`)
    if (styleHint) sections.push(`Style: ${styleHint}`)
    if (lengthHint) sections.push(`Length: ${lengthHint}`)
    sections.push(
      isMulti
        ? 'Generate ONE question that requires consulting ALL of the following excerpts.'
        : 'Generate ONE question answerable from the following excerpt.',
      'JSON schema: { "query": string, "query_shape": "' + shape + '" }',
    )
  }

  // Phase 4: optional domain schema, snapshot-safe (empty when unset).
  const schemaBlock = renderDomainSchema(language, domainSchema)
  if (schemaBlock) sections.push(schemaBlock)

  for (let i = 0; i < docs.length; i++) {
    const headJa = `---本文 ${i + 1} (id=${docs[i].id})---`
    const headEn = `---EXCERPT ${i + 1} (id=${docs[i].id})---`
    const tail = language === 'ja' ? '---ここまで---' : '---END---'
    sections.push(language === 'ja' ? headJa : headEn, docs[i].text, tail)
  }

  return sections.join('\n')
}

/* --------------------------------------------------------------------- */
/* RAFT: Chain-of-Thought answer generation prompts                       */
/* --------------------------------------------------------------------- */

export interface BuildRaftAnswerPromptParams {
  language: EvalLanguage
  question: string
  oracleDoc: { id: string; text: string }
  distractorDocs: Array<{ id: string; text: string }>
}

export function buildRaftAnswerSystemPrompt(language: EvalLanguage): string {
  if (language === 'ja') {
    return [
      'あなたは RAG（Retrieval Augmented Generation）システムの Chain-of-Thought 回答を生成する専門家です。',
      '複数のドキュメント抜粋が与えられます。1 つだけがオラクル（正解の情報源）で、残りはディストラクター（不正解の文書）です。',
      '制約:',
      '- まず質問への回答方法についてステップバイステップの推論を提示してください。',
      '- 推論中にコンテキストからの文を引用する場合は "##begin_quote##" と "##end_quote##" で囲んでください。',
      '- 最終回答は必ず "<ANSWER>: " に続けて簡潔に書いてください。',
      '- ディストラクター文書の情報を回答の根拠にしてはいけません。',
      '- 抜粋に書かれていない事実を加えてはいけません。',
      '- 出力は必ず指定された JSON スキーマに従うこと（追加のテキスト・コードフェンス禁止）。',
    ].join('\n')
  }
  return [
    'You are an expert at generating Chain-of-Thought answers for RAG (Retrieval Augmented Generation) training.',
    'You will receive several document excerpts. Exactly one is the oracle (correct source); the rest are distractors.',
    'Constraints:',
    '- First provide step-by-step reasoning on how to answer the question.',
    '- In the reasoning, if you need to copy paste some sentences from the context, include them in "##begin_quote##" and "##end_quote##".',
    '- End your response with the final answer in the form "<ANSWER>: $answer". The answer should be succinct.',
    '- You MUST begin your final answer with the tag "<ANSWER>:".',
    '- NEVER use information from distractor documents as evidence.',
    '- NEVER invent facts that are not in the oracle excerpt.',
    '- Output MUST strictly follow the specified JSON schema (no prose, no code fences).',
  ].join('\n')
}

export function buildRaftAnswerUserPrompt(params: BuildRaftAnswerPromptParams): string {
  const { language, question, oracleDoc, distractorDocs } = params

  // Shuffle oracle into a random position among distractors so the
  // model learns to identify the relevant document, not the position.
  const allDocs: Array<{ id: string; text: string; isOracle: boolean }> = [
    { ...oracleDoc, isOracle: true },
    ...distractorDocs.map((d) => ({ ...d, isOracle: false })),
  ]
  // Fisher-Yates shuffle (in-place)
  for (let i = allDocs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[allDocs[i], allDocs[j]] = [allDocs[j], allDocs[i]]
  }

  const sections: string[] = []
  if (language === 'ja') {
    sections.push(
      `[language=ja] [question]`,
      `質問: ${question}`,
      '',
      `以下の ${allDocs.length} 件のドキュメント抜粋を参考に、Chain-of-Thought 形式で回答してください。`,
      `正しい情報源は 1 つだけです。残りは無関係な文書です。`,
      'JSON スキーマ: { "cot_answer": string }',
    )
  } else {
    sections.push(
      `[language=en] [question]`,
      `Question: ${question}`,
      '',
      `Answer the question using Chain-of-Thought reasoning based on the ${allDocs.length} document excerpts below.`,
      `Only ONE excerpt contains the correct information. The rest are distractors.`,
      'JSON schema: { "cot_answer": string }',
    )
  }

  for (let i = 0; i < allDocs.length; i++) {
    const d = allDocs[i]
    const headJa = `---ドキュメント ${i + 1} (id=${d.id})---`
    const headEn = `---Document ${i + 1} (id=${d.id})---`
    const tail = language === 'ja' ? '---ここまで---' : '---END---'
    sections.push(language === 'ja' ? headJa : headEn, d.text, tail)
  }

  return sections.join('\n')
}
