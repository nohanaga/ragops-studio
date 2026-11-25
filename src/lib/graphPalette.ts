export const CLUSTER_COLORS = [
  '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
  '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
  '#86bcb6', '#8cd17d', '#b6992d', '#499894', '#d37295',
  '#a0cbe8', '#ffbe7d', '#ff9888', '#89d4cf', '#8dca6b',
]

export function graphCategoryColor(category: string): string {
  let hash = 0
  for (const character of category) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0
  return CLUSTER_COLORS[hash % CLUSTER_COLORS.length]
}

export function graphCategoryPalette(categories: string[]): Record<string, string> {
  const assigned = new Map<string, string>()
  const used = new Set<string>()
  for (const category of categories) {
    const preferred = graphCategoryColor(category)
    const color = used.has(preferred) ? CLUSTER_COLORS.find((candidate) => !used.has(candidate)) ?? preferred : preferred
    assigned.set(category, color)
    used.add(color)
  }
  return Object.fromEntries(assigned)
}
