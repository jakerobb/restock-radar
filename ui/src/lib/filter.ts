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

/** True when at least one variant of the product is available. */
export function isInStock(p: Product): boolean {
  return p.variants.some((v) => v.status === 'Available')
}

/** Products matching the search text, the chosen type (when non-empty), every chosen tag, and (optionally) being in stock. */
export function filterProducts(
  products: Product[],
  query: string,
  type: string,
  tags: string[] = [],
  inStockOnly = false,
): Product[] {
  return products.filter(
    (p) =>
      matchesQuery(p, query) &&
      (!type || typeOf(p) === type) &&
      tags.every((t) => p.tags.includes(t)) &&
      (!inStockOnly || isInStock(p)),
  )
}

export interface TagCount {
  tag: string
  count: number
}

/**
 * Every tag on any of `products`, with how many carry it: most common first, then alphabetical.
 * Pass `counted` (e.g. the products left after filtering) to count only those; tags with none stay listed at 0.
 */
export function tagCounts(products: Product[], counted: Product[] = products): TagCount[] {
  const counts = new Map<string, number>()
  for (const p of products) for (const tag of p.tags) counts.set(tag, 0)
  for (const p of counted) for (const tag of p.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

export interface TagGroupCounts {
  prefix: string
  options: TagCount[]
}

/** The prefix of a `prefix:name` tag (feature:4k -> feature); null for plain tags. */
export function tagPrefix(tag: string): string | null {
  const i = tag.indexOf(':')
  return i > 0 && i < tag.length - 1 ? tag.slice(0, i) : null
}

/** Splits tags into plain ones and `prefix:` groups (alphabetical by prefix); each keeps its incoming order. */
export function groupTags(tags: TagCount[]): { plain: TagCount[]; groups: TagGroupCounts[] } {
  const plain: TagCount[] = []
  const byPrefix = new Map<string, TagCount[]>()
  for (const t of tags) {
    const prefix = tagPrefix(t.tag)
    if (prefix === null) plain.push(t)
    else byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), t])
  }
  const groups = [...byPrefix]
    .map(([prefix, options]) => ({ prefix, options }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix))
  return { plain, groups }
}

/** For each tag prefix, how many of `products` carry at least one tag with it. */
export function prefixCounts(products: Product[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const p of products) {
    for (const prefix of new Set(p.tags.map(tagPrefix))) {
      if (prefix !== null) counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
    }
  }
  return counts
}

export interface TypeCount {
  type: string
  count: number
}

/**
 * The types present in `products`, alphabetical with Other last.
 * Pass `counted` (e.g. the products left by every other filter) to count only those; types with none stay listed at 0.
 */
export function typeCounts(products: Product[], counted: Product[] = products): TypeCount[] {
  const counts = new Map<string, number>()
  for (const p of products) counts.set(typeOf(p), 0)
  for (const p of counted) counts.set(typeOf(p), (counts.get(typeOf(p)) ?? 0) + 1)
  return [...counts]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => (a.type === OTHER_TYPE ? 1 : b.type === OTHER_TYPE ? -1 : a.type.localeCompare(b.type)))
}
