import type { Product } from '../api/types'

/** Shown for products whose type the store hasn't told us (yet). */
export const OTHER_TYPE = 'Other'

/** The type a product is filed under. */
export function typeOf(p: Product): string {
  return p.type || OTHER_TYPE
}

/** True when every word of `query` appears in the product's name or one of its variants' names. */
export function matchesQuery(p: Product, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = [p.title, ...p.variants.map((v) => v.title)].join('\n').toLowerCase()
  return words.every((w) => haystack.includes(w))
}

/** Products matching the search text and (when non-empty) the chosen type. */
export function filterProducts(products: Product[], query: string, type: string): Product[] {
  return products.filter((p) => matchesQuery(p, query) && (!type || typeOf(p) === type))
}

export interface TypeCount {
  type: string
  count: number
}

/** The types present, with how many of `products` each holds: alphabetical, with Other last. */
export function typeCounts(products: Product[]): TypeCount[] {
  const counts = new Map<string, number>()
  for (const p of products) counts.set(typeOf(p), (counts.get(typeOf(p)) ?? 0) + 1)
  return [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => (a.type === OTHER_TYPE ? 1 : b.type === OTHER_TYPE ? -1 : a.type.localeCompare(b.type)))
}
