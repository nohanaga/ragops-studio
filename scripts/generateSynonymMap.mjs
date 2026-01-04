/**
 * Generates/updates a large Azure AI Search synonym map CSV under docs/.
 *
 * This script normalizes existing rules, generates additional candidate rules,
 * de-duplicates tokens, and writes a capped number of lines for a practical
 * playground dataset.
 */

import fs from 'node:fs/promises'
import path from 'node:path'

const WORKSPACE_ROOT = path.resolve(new URL('..', import.meta.url).pathname)
const TARGET_FILE = path.join(WORKSPACE_ROOT, 'docs', 'synonymmap.csv')
const TARGET_LINES = 20000

function normalizeExistingLines(text) {
  const bannedFirstToken = [
    /^業界用語\d+$/,
    /^業界キーワード\d+$/,
    /^業界用語_\d+$/,
    /^業種分類\d{5}$/,
    /^業界分類\d{5}$/,
    /^産業分類\d{5}$/,
  ]

  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\\n/g, '').trim())
    .filter((line) => line.length > 0)
    .filter((line) => {
      const first = line.split(',')[0]?.trim() ?? ''
      return !bannedFirstToken.some((re) => re.test(first))
    })
}

function toRule(parts) {
  const cleaned = parts
    .map((p) => String(p).trim())
    .filter(Boolean)
    .map((p) => p.replace(/\s+/g, ' '))

  // no commas inside tokens (csv uses commas as separators)
  if (cleaned.some((p) => p.includes(','))) return null
  if (cleaned.length < 2) return null

  const unique = Array.from(new Set(cleaned))
  if (unique.length < 2) return null

  return unique.join(', ')
}

function buildSeedGroups() {
  /**
   * IMPORTANT:
   * Azure AI Search synonym map supports Solr-style equivalent rules like:
   *   term1, term2, term3
   * One rule per line.
   */

  const acronymGroups = [
    ['DX', 'デジタルトランスフォーメーション', 'Digital Transformation'],
    ['AI', '人工知能', 'Artificial Intelligence'],
    ['ML', '機械学習', 'Machine Learning'],
    ['DL', 'ディープラーニング', 'Deep Learning'],
    ['NLP', '自然言語処理', 'Natural Language Processing'],
    ['LLM', '大規模言語モデル', 'Large Language Model'],
    ['RAG', '検索拡張生成', 'Retrieval Augmented Generation'],
    ['OCR', '文字認識', 'Optical Character Recognition'],
    ['IoT', 'モノのインターネット', 'Internet of Things'],
    ['OT', '制御技術', 'Operational Technology'],
    ['IT', '情報技術', 'Information Technology'],
    ['SaaS', 'サース', 'Software as a Service'],
    ['PaaS', 'パース', 'Platform as a Service'],
    ['IaaS', 'イアース', 'Infrastructure as a Service'],
    ['ERP', '基幹システム', 'Enterprise Resource Planning'],
    ['CRM', '顧客管理', 'Customer Relationship Management'],
    ['SCM', 'サプライチェーン管理', 'Supply Chain Management'],
    ['BI', 'ビジネスインテリジェンス', 'Business Intelligence'],
    ['KPI', '重要業績評価指標', 'Key Performance Indicator'],
    ['OKR', '目標と主要な結果', 'Objectives and Key Results'],
    ['RPA', 'ロボティック・プロセス・オートメーション', 'Robotic Process Automation'],
    ['BPO', '業務委託', 'Business Process Outsourcing'],
    ['SRE', 'サイト信頼性エンジニアリング', 'Site Reliability Engineering'],
    ['DevOps', 'デブオプス', 'Development and Operations'],
    ['CI/CD', '継続的インテグレーション', '継続的デリバリー'],
    ['PoC', '概念実証', 'Proof of Concept'],
    ['MVP', '最小実用製品', 'Minimum Viable Product'],
    ['ROI', '投資対効果', 'Return on Investment'],
    ['TCO', '総所有コスト', 'Total Cost of Ownership'],
    ['SSO', 'シングルサインオン', 'Single Sign-On'],
    ['MFA', '多要素認証', 'Multi-Factor Authentication'],
    ['IAM', '認証認可管理', 'Identity and Access Management'],
    ['DWH', 'データウェアハウス', 'Data Warehouse'],
    ['ETL', '抽出変換ロード', 'Extract Transform Load'],
    ['ELT', '抽出ロード変換', 'Extract Load Transform'],
    ['CDP', '顧客データ基盤', 'Customer Data Platform'],
    ['API', 'アプリケーションプログラミングインターフェース', 'Application Programming Interface'],
    ['SDK', 'ソフトウェア開発キット', 'Software Development Kit'],
    ['UI', 'ユーザーインターフェース', 'User Interface'],
    ['UX', 'ユーザー体験', 'User Experience'],
    ['B2B', '企業間取引', 'Business to Business'],
    ['B2C', '消費者向け', 'Business to Consumer'],
    ['D2C', '直販', 'Direct to Consumer'],
    ['EC', '電子商取引', 'E-commerce'],
    ['CX', '顧客体験', 'Customer Experience'],
    ['CS', 'カスタマーサクセス', 'Customer Success'],
    ['VOC', '顧客の声', 'Voice of Customer'],
  ]

  const roleProcessGroups = [
    ['人事', 'HR', 'ヒューマンリソース'],
    ['採用', 'リクルーティング', 'Recruiting'],
    ['労務', '勤怠', 'Payroll'],
    ['経理', '会計', 'Accounting'],
    ['財務', 'ファイナンス', 'Finance'],
    ['法務', 'リーガル', 'Legal'],
    ['監査', 'オーディット', 'Audit'],
    ['購買', '調達', 'Procurement'],
    ['在庫管理', 'Inventory Management', '在庫'],
    ['品質管理', 'QC', 'Quality Control'],
    ['品質保証', 'QA', 'Quality Assurance'],
    ['営業', 'セールス', 'Sales'],
    ['マーケティング', 'Marketing', '販促'],
    ['広報', 'PR', 'Public Relations'],
    ['カスタマーサポート', 'サポート', 'Customer Support'],
    ['コンタクトセンター', 'コールセンター', 'Contact Center'],
    ['生産管理', 'Production Control', '生産計画'],
    ['需給計画', '需要予測', 'Demand Planning'],
    ['サプライチェーン', 'Supply Chain', 'SC'],
    ['物流', 'ロジスティクス', 'Logistics'],
    ['倉庫', 'WMS', 'Warehouse Management System'],
    ['配送', 'ラストマイル', 'Last Mile'],
    ['情報システム', '情シス', 'IT部門'],
    ['セキュリティ', '情報セキュリティ', 'Cybersecurity'],
    ['ガバナンス', '統制', 'Governance'],
    ['コンプライアンス', '法令遵守', 'Compliance'],
    ['リスク管理', 'リスクマネジメント', 'Risk Management'],
    ['BCP', '事業継続計画', 'Business Continuity Plan'],
    ['DR', '災害復旧', 'Disaster Recovery'],
  ]

  const domainNouns = [
    '自動車',
    '輸送機器',
    '半導体',
    '電子部品',
    '精密機器',
    '機械',
    '工作機械',
    'ロボット',
    '化学',
    '素材',
    '鉄鋼',
    '非鉄金属',
    '金属加工',
    '医療',
    'ヘルスケア',
    '介護',
    '製薬',
    'バイオ',
    '病院',
    '臨床検査',
    '保険',
    '生命保険',
    '損害保険',
    '銀行',
    '地方銀行',
    '証券',
    '資産運用',
    '決済',
    'FinTech',
    'クレジットカード',
    '不動産',
    '建設',
    '土木',
    '住宅',
    'リフォーム',
    'インフラ',
    '電力',
    'ガス',
    'エネルギー',
    '再生可能エネルギー',
    '太陽光',
    '風力',
    '水素',
    '蓄電池',
    '石油',
    'プラント',
    '食品',
    '飲料',
    '農業',
    '畜産',
    '水産',
    '外食',
    '小売',
    'コンビニ',
    '百貨店',
    'EC',
    '物流',
    '運輸',
    '航空',
    '海運',
    '鉄道',
    '旅行',
    '観光',
    'ホテル',
    '教育',
    'EdTech',
    '人材',
    'HRTech',
    '広告',
    'マーケティング',
    'メディア',
    '放送',
    'エンタメ',
    'ゲーム',
    '出版',
    'IT',
    'ソフトウェア',
    'クラウド',
    'データセンター',
    '通信',
    '5G',
    'サイバーセキュリティ',
    '行政',
    '自治体',
    '官公庁',
    '防災',
    'スマートシティ',
    'スマートファクトリー',
    '製造',
    '工場',
    '品質',
    'サプライチェーン',
    'SCM',
  ]

  const japaneseIndustryHeads = {
    manufacturing: [
      '自動車',
      '車載',
      '輸送機器',
      '半導体',
      '電子部品',
      '電機',
      '家電',
      '精密機器',
      '工作機械',
      '産業機械',
      '建設機械',
      'ロボット',
      'FA',
      '計測',
      '制御',
      '化学',
      '素材',
      '樹脂',
      '鉄鋼',
      '非鉄金属',
      '金属加工',
      '紙パルプ',
      '印刷',
      '食品',
      '飲料',
      '医薬品',
      '製薬',
      'バイオ',
      '医療機器',
      '化粧品',
      '日用品',
      'アパレル',
      '繊維',
    ],
    constructionRealEstate: [
      '建設',
      '土木',
      'ゼネコン',
      'サブコン',
      '設備工事',
      '電気工事',
      '空調',
      '衛生',
      '住宅',
      '不動産',
      '賃貸',
      '仲介',
      'マンション',
      'オフィス',
      '物流不動産',
      'リフォーム',
      '工務店',
    ],
    energyInfrastructure: [
      '電力',
      '発電',
      '送配電',
      'ガス',
      '石油',
      'プラント',
      'エネルギー',
      '再エネ',
      '再生可能エネルギー',
      '太陽光',
      '風力',
      '地熱',
      '水素',
      '蓄電池',
      'インフラ',
      '上下水道',
      '道路',
      '鉄道インフラ',
    ],
    retailLogisticsTravel: [
      '小売',
      '卸売',
      '流通',
      'EC',
      'ネット通販',
      'コンビニ',
      '百貨店',
      'スーパー',
      'ドラッグストア',
      '外食',
      '飲食',
      '物流',
      '倉庫',
      '配送',
      '運輸',
      '海運',
      '航空',
      '鉄道',
      '旅行',
      '観光',
      'ホテル',
    ],
    finance: [
      '金融',
      '銀行',
      '地方銀行',
      '信用金庫',
      '証券',
      '保険',
      '生保',
      '損保',
      '決済',
      'カード',
      'クレジットカード',
      '資産運用',
      'リース',
      'FinTech',
    ],
    healthcareEducationPublic: [
      '医療',
      '病院',
      'クリニック',
      '介護',
      '福祉',
      '薬局',
      '健診',
      '教育',
      '学校',
      '大学',
      '行政',
      '自治体',
      '官公庁',
      '防災',
      '公共',
    ],
    itMediaServices: [
      'IT',
      '情報通信',
      '通信',
      'データセンター',
      'クラウド',
      'SaaS',
      'ソフトウェア',
      'SI',
      'SIer',
      'システム開発',
      '受託開発',
      '運用',
      '保守',
      'セキュリティ',
      'サイバーセキュリティ',
      '広告',
      'マーケティング',
      'メディア',
      '放送',
      'ゲーム',
      'エンタメ',
      '人材',
      'BPO',
      'コンサル',
    ],
  }

  const japaneseIndustryTails = {
    manufacturing: [
      '業界',
      '産業',
      '分野',
      '領域',
      '市場',
      'マーケット',
      'メーカー',
      '製造',
      '製造業',
      '工場',
      '部品',
      '装置',
      '設備',
      '生産',
      '生産管理',
      '品質管理',
      '品質保証',
      '検査',
      'サプライチェーン',
      'SCM',
      '購買',
      '調達',
      '物流',
    ],
    constructionRealEstate: [
      '業界',
      '産業',
      '分野',
      '領域',
      '市場',
      'マーケット',
      '施工',
      '工事',
      '設計',
      '積算',
      '工程管理',
      '安全管理',
      '維持管理',
      '設備管理',
      '管理会社',
      'プロパティマネジメント',
      'PM',
      'ファシリティマネジメント',
      'FM',
    ],
    energyInfrastructure: [
      '業界',
      '産業',
      '分野',
      '領域',
      '市場',
      'マーケット',
      '発電',
      '送電',
      '配電',
      '設備',
      '保全',
      '点検',
      '運用',
      '需給',
      '電力取引',
    ],
    retailLogisticsTravel: [
      '業界',
      '産業',
      '分野',
      '領域',
      '市場',
      'マーケット',
      '事業',
      '店舗',
      'チェーン',
      '物流',
      '倉庫',
      '配送',
      '輸配送',
      '在庫',
      '在庫管理',
      '需要予測',
      '旅行業',
      '宿泊',
      '観光業',
    ],
    finance: [
      '業界',
      '産業',
      '分野',
      '領域',
      '市場',
      'マーケット',
      '事業',
      '決済',
      '与信',
      '審査',
      'リスク管理',
      'コンプライアンス',
      'AML',
      'KYC',
    ],
    healthcareEducationPublic: [
      '業界',
      '産業',
      '分野',
      '領域',
      '事業',
      '医療機関',
      '診療',
      '看護',
      '介護事業',
      '教育機関',
      '公共サービス',
      '行政サービス',
      '住民サービス',
    ],
    itMediaServices: [
      '業界',
      '産業',
      '分野',
      '領域',
      '市場',
      'マーケット',
      '事業',
      'サービス',
      'プラットフォーム',
      'ソリューション',
      '運用',
      '保守',
      '開発',
      '受託',
      'アウトソーシング',
      'BPO',
    ],
  }

  const industrySuffixTriples = [
    ['業界', '産業', 'セクター'],
    ['分野', '領域', 'ドメイン'],
    ['事業', 'ビジネス', '市場'],
  ]

  const explicitIndustries = [
    ['製造業', 'メーカー', 'Manufacturing'],
    ['建設業', '建設', 'Construction'],
    ['小売業', '小売', 'Retail'],
    ['卸売業', '卸売', 'Wholesale'],
    ['運輸業', '物流', 'Transportation'],
    ['情報通信業', 'IT', '通信'],
    ['金融業', '金融', 'Finance'],
    ['保険業', '保険', 'Insurance'],
    ['不動産業', '不動産', 'Real Estate'],
    ['医療業', '医療', 'Healthcare'],
    ['教育産業', '教育', 'Education'],
    ['宿泊業', 'ホテル', 'Hospitality'],
    ['飲食業', '外食', 'Food Service'],
  ]

  return {
    acronymGroups,
    roleProcessGroups,
    domainNouns,
    industrySuffixTriples,
    explicitIndustries,
    japaneseIndustryHeads,
    japaneseIndustryTails,
  }
}

function generateRules(existingLines, targetLines) {
  const {
    acronymGroups,
    roleProcessGroups,
    domainNouns,
    industrySuffixTriples,
    explicitIndustries,
    japaneseIndustryHeads,
    japaneseIndustryTails,
  } = buildSeedGroups()

  const all = new Set()

  // Keep existing rules first (normalized)
  for (const line of existingLines) all.add(line)

  function add(parts) {
    const rule = toRule(parts)
    if (!rule) return
    all.add(rule)
  }

  // Seed groups
  for (const g of acronymGroups) add(g)
  for (const g of roleProcessGroups) add(g)
  for (const g of explicitIndustries) add(g)

  // Systematic industry/domain expansions
  for (const noun of domainNouns) {
    for (const [s1, s2, s3] of industrySuffixTriples) {
      // noun, noun+suffix..., but avoid doubling like "EC industry" that might look odd; still ok for sample.
      add([noun, `${noun}${s1}`, `${noun}${s2}`])
      add([`${noun}${s1}`, `${noun}${s2}`, `${noun}${s3}`])
    }
  }

  // Japan business terms: generate many plausible compound phrases then create synonym variants
  for (const [group, heads] of Object.entries(japaneseIndustryHeads)) {
    const tails = japaneseIndustryTails[group] ?? []
    for (const head of heads) {
      // head-level variants
      add([head, `${head}業界`, `${head}産業`])
      add([`${head}分野`, `${head}領域`, `${head}セクター`])

      for (const tail of tails) {
        // Avoid extremely redundant combos like head already ends with tail
        if (head.endsWith(tail)) continue
        const phrase = `${head}${tail}`
        add([phrase, `${phrase}業界`, `${phrase}産業`])
        add([`${phrase}分野`, `${phrase}領域`, `${phrase}セクター`])
      }
    }
  }

  // Kana/kanji common alternates (lightweight)
  const kanaPairs = [
    ['サプライチェーン', '供給網'],
    ['ロジスティクス', '物流'],
    ['セキュリティ', '安全対策'],
    ['クラウド', 'クラウドサービス'],
    ['データ分析', 'アナリティクス'],
    ['顧客管理', '顧客情報管理'],
    ['顧客体験', '顧客経験'],
    ['購買', 'バイヤー業務'],
    ['調達', 'ソーシング'],
    ['品質保証', '品質担保'],
  ]
  for (const [a, b] of kanaPairs) {
    add([a, b])
    add([a, `${a}（${b}）`, b].map((v) => v.replace(/[（）]/g, '')))
  }

  // Expand by common "industry" tokens to reach 20k without nonsense
  const sectorTokens = [
    '企業',
    '業者',
    '事業者',
    'プレイヤー',
    'ベンダー',
    'サプライヤー',
  ]

  for (const noun of domainNouns) {
    for (const token of sectorTokens) {
      add([`${noun}${token}`, `${noun}企業`, `${noun}事業者`])
    }
  }

  // If still not enough, generate neutral Japan-style classification labels
  // (Avoid meaningless placeholders; keep them business-ish and consistent.)
  let i = 1
  while (all.size < targetLines) {
    const id = String(i).padStart(5, '0')
    add([`業種分類${id}`, `業界分類${id}`, `産業分類${id}`])
    i++
    if (i > 200000) break
  }

  // Produce final array preserving existing-first ordering as much as possible.
  // Set iteration order keeps insertion order in JS.
  const out = Array.from(all)

  // Ensure exact line count
  if (out.length > targetLines) return out.slice(0, targetLines)

  // Pad (shouldn't be needed due to loop)
  while (out.length < targetLines) {
    const n = out.length + 1
    out.push(`業界用語${n}, 業界キーワード${n}`)
  }

  return out
}

async function main() {
  let existingText = ''
  try {
    existingText = await fs.readFile(TARGET_FILE, 'utf8')
  } catch {
    // if missing, start empty
    existingText = ''
  }

  const existingLines = normalizeExistingLines(existingText)
  const outLines = generateRules(existingLines, TARGET_LINES)

  await fs.writeFile(TARGET_FILE, outLines.join('\n') + '\n', 'utf8')

  console.log(`Wrote ${outLines.length} synonym rules to ${path.relative(process.cwd(), TARGET_FILE)}`)
}

await main()
