import type { Product } from '../api/types'

/** The leading words every title has in common ("Power Distribution Pro" + "Power Distribution Hi-Density" -> "Power Distribution"). */
function sharedPrefix(titles: string[]): string {
  const split = titles.map((t) => t.split(/\s+/))
  const out: string[] = []
  for (const [i, word] of (split[0] ?? []).entries()) {
    if (!split.every((words) => words[i]?.toLowerCase() === word.toLowerCase())) break
    out.push(word)
  }
  return out.join(' ')
}

/** What sets a member apart from the group: its title without the shared prefix (or all of it, if nothing is left). */
function distinguishing(title: string, prefix: string): string {
  const rest = prefix ? title.slice(prefix.length).trim() : title
  return rest || title
}

function isDefault(title: string): boolean {
  return title === '' || title.toLowerCase() === 'default'
}

function merge(first: Product, members: Product[]): Product {
  const prefix = sharedPrefix(members.map((m) => m.title))
  return {
    ...first,
    id: `collection:${first.collection}`,
    title: prefix || first.title,
    tags: [...new Set(members.flatMap((m) => m.tags))].sort(),
    variants: members.flatMap((m) => {
      const name = distinguishing(m.title, prefix)
      // Members are usually single-variant ("Default"), so name each variant for its product.
      return m.variants.map((v) => ({ ...v, title: isDefault(v.title) ? name : `${name} \u2013 ${v.title}` }))
    }),
  }
}

/**
 * Merges products the store files in one collection (same region, same
 * non-empty `collection`) into a single product, as the store's own page does.
 * Products with no collection, or alone in theirs, come through untouched.
 * The merged product sits where its first member was.
 */
export function groupProducts(products: Product[]): Product[] {
  const members = new Map<string, Product[]>()
  for (const p of products) {
    if (!p.collection) continue
    const key = `${p.region}/${p.collection}`
    members.set(key, [...(members.get(key) ?? []), p])
  }
  const emitted = new Set<string>()
  const out: Product[] = []
  for (const p of products) {
    const key = `${p.region}/${p.collection}`
    const group = p.collection ? members.get(key) : undefined
    if (!group || group.length < 2) out.push(p)
    else if (!emitted.has(key)) {
      emitted.add(key)
      out.push(merge(p, group))
    }
  }
  return out
}
