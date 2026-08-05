export type IrObjective = 'precision@k' | 'recall@k' | 'ndcg' | 'mrr'

export type RelevanceGrades = ReadonlyMap<string, number>

export function parseRelevanceGrades(value: unknown): RelevanceGrades | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined

  const entries = Object.entries(value)
  if (entries.length === 0) return undefined

  let hasPositive = false
  for (const [, grade] of entries) {
    if (typeof grade !== 'number' || !Number.isFinite(grade) || grade < 0) return undefined
    if (grade > 0) hasPositive = true
  }
  if (!hasPositive) return undefined

  return new Map(entries as Array<[string, number]>)
}

function precisionAtK(returned: string[], relevant: Set<string>, k: number): number {
  const top = returned.slice(0, k)
  if (top.length === 0) return 0
  let hit = 0
  for (const id of top) if (relevant.has(id)) hit++
  return hit / k
}

function recallAtK(returned: string[], relevant: Set<string>, k: number): number {
  const top = returned.slice(0, k)
  if (relevant.size === 0) return 0
  let hit = 0
  for (const id of top) if (relevant.has(id)) hit++
  return hit / relevant.size
}

function mrrAtK(returned: string[], relevant: Set<string>, k: number): number {
  const top = returned.slice(0, k)
  for (let i = 0; i < top.length; i++) {
    if (relevant.has(top[i])) return 1 / (i + 1)
  }
  return 0
}

function discount(rankIndex: number): number {
  return Math.log2(rankIndex + 2)
}

function binaryNdcgAtK(returned: string[], relevant: Set<string>, k: number): number {
  const dcg = returned.slice(0, k).reduce(
    (total, id, rankIndex) => total + (relevant.has(id) ? 1 / discount(rankIndex) : 0),
    0,
  )
  const idealLength = Math.min(k, relevant.size)
  if (idealLength === 0) return 0
  const idcg = Array.from({ length: idealLength }, (_, rankIndex) => 1 / discount(rankIndex))
    .reduce((total, gain) => total + gain, 0)
  return idcg === 0 ? 0 : dcg / idcg
}

function gradedNdcgAtK(returned: string[], grades: RelevanceGrades, k: number): number {
  const gain = (relevance: number) => 2 ** relevance - 1
  const dcg = returned.slice(0, k).reduce(
    (total, id, rankIndex) => total + gain(grades.get(id) ?? 0) / discount(rankIndex),
    0,
  )
  const idealGrades = Array.from(grades.values()).sort((a, b) => b - a).slice(0, k)
  const idcg = idealGrades.reduce(
    (total, relevance, rankIndex) => total + gain(relevance) / discount(rankIndex),
    0,
  )
  return idcg === 0 ? 0 : dcg / idcg
}

export function ndcgAtK(
  returned: string[],
  relevant: Set<string>,
  k: number,
  grades?: RelevanceGrades,
): number {
  return grades ? gradedNdcgAtK(returned, grades, k) : binaryNdcgAtK(returned, relevant, k)
}

export function scoreIrObjective(
  objective: IrObjective,
  returned: string[],
  relevant: Set<string>,
  k: number,
  grades?: RelevanceGrades,
): number {
  switch (objective) {
    case 'precision@k':
      return precisionAtK(returned, relevant, k)
    case 'recall@k':
      return recallAtK(returned, relevant, k)
    case 'ndcg':
      return ndcgAtK(returned, relevant, k, grades)
    case 'mrr':
      return mrrAtK(returned, relevant, k)
  }
}