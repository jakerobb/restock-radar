import type { Product } from '../api/types'

/** Shown for products whose type the store hasn't told us (yet). */
export const OTHER_TYPE = 'Other'

/** The type a product is filed under. */
export function typeOf(p: Product): string {
  return p.type || OTHER_TYPE
}

/** Other ways to say a search word: typing the key also finds the phrases. */
const ALIASES: Record<string, string[]> = {
  nvr: ['network video recorder'],
  nas: ['network attached storage', 'network storage'],
  ups: ['uninterruptible power'],
  poe: ['power over ethernet'],
  gateway: ['router'],
  router: ['gateway'],
}

/** The text a search runs over: names, SKUs, and the words of the store category (physical-security-nvr). */
function searchText(p: Product): string {
  return [p.title, p.category.replaceAll('-', ' '), ...p.variants.flatMap((v) => [v.title, v.sku])].join('\n').toLowerCase()
}

/**
 * True when every word of `query` (or one of its aliases) appears in the
 * product's or its variants' names or SKUs, or in its store category.
 */
export function matchesQuery(p: Product, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = searchText(p)
  return words.every((w) => haystack.includes(w) || (ALIASES[w] ?? []).some((a) => haystack.includes(a)))
}

/** Products matching the search text, the chosen type (when non-empty), and every chosen tag. */
export function filterProducts(products: Product[], query: string, type: string, tags: string[] = []): Product[] {
  return products.filter(
    (p) => matchesQuery(p, query) && (!type || typeOf(p) === type) && tags.every((t) => p.tags.includes(t)),
  )
}

export interface TagCount {
  tag: string
  count: number
}

/** Every tag on any of `products`, with how many carry it: most common first, then alphabetical. */
export function tagCounts(products: Product[]): TagCount[] {
  const counts = new Map<string, number>()
  for (const p of products) for (const tag of p.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
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
