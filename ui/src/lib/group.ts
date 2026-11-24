import type { Product } from '../api/types'

/** A product's compact name, falling back to its full title while the short one is unknown. */
function nameOf(p: Product): string {
  return p.short_title || p.title
}

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

/** What sets a member apart from the group: its title without the shared prefix. Empty for the member that is the prefix. */
function distinguishing(title: string, prefix: string): string {
  return prefix ? title.slice(prefix.length).trim() : title
}

function isDefault(title: string): boolean {
  return title === '' || title.toLowerCase() === 'default'
}

/** A title's difference from the group, without the separators left at its edges ("Swing, Glass Door", not ", Swing, Glass Door"). */
function trimmed(s: string): string {
  return s.replace(/^[\s,;:\u2013-]+|[\s,;:\u2013-]+$/g, '')
}

function hasDuplicates(labels: string[]): boolean {
  return new Set(labels).size < labels.length
}

function merge(first: Product, members: Product[], prefix: string): Product {
  // Members are often single-variant ("Default"), so name those for their product.
  // Otherwise a variant keeps its own name ("White / 1 m"), qualified by the
  // product unless the product is the group's namesake ("Outdoor \u2013 White / 1 m").
  const label = (v: Product['variants'][number], m: Product, name: string) => {
    if (isDefault(v.title)) return name || nameOf(m)
    return name ? `${name} \u2013 ${v.title}` : v.title
  }
  const rows = members.flatMap((m) => m.variants.map((v) => ({ m, v })))
  const named = (nameFor: (m: Product) => string) => rows.map(({ m, v }) => label(v, m, nameFor(m)))

  // Short titles are what set most products apart, but some share one ("12U Rack
  // Cabinet" for the glass and the perforated door, 450 mm and 600 mm). Only where
  // that leaves variants with the same name do the full titles take over, so groups
  // that are already clear keep their names.
  let labels = named((m) => distinguishing(nameOf(m), prefix))
  if (hasDuplicates(labels)) {
    const titlePrefix = sharedPrefix(members.map((m) => m.title))
    const byTitle = named((m) => trimmed(distinguishing(m.title, titlePrefix)))
    if (new Set(byTitle).size >= new Set(labels).size) labels = byTitle
  }
  // Variants that nothing in the store's text sets apart are told apart by SKU.
  const counts = new Map<string, number>()
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1)

  return {
    ...first,
    id: `collection:${first.collection}:${first.group}`,
    title: prefix || first.group || nameOf(first),
    tags: [...new Set(members.flatMap((m) => m.tags))].sort(),
    variants: rows.map(({ m, v }, i) => {
      const l = labels[i]!
      return { ...v, tags: m.tags, title: (counts.get(l) ?? 0) > 1 ? `${l} (${v.sku})` : l }
    }),
  }
}

/**
 * Merges products the store presents as one into a single product. Products
 * are candidates when they share a region and a non-empty `collection`, and are
 * then split by `group`, the title the store's breadcrumbs file them under:
 * "UniFi Patch Cable" and "UniFi Patch Cable Outdoor" share one, but
 * "UniFi Etherlighting Patch Cable" has its own, though all sit in one collection.
 *
 * Where the group isn't known yet (products not yet fetched from the product
 * page), members merge only if their names share at least two words, so a bare
 * brand ("UniFi") never forms a group of its own.
 *
 * Products that are alone in their bucket, or have no collection, come through
 * untouched. A merged product sits where its first member was.
 */
export function groupProducts(products: Product[]): Product[] {
  const bucketKey = (p: Product) => `${p.region}/${p.collection}/${p.group}`
  const buckets = new Map<string, Product[]>()
  for (const p of products) {
    if (!p.collection) continue
    buckets.set(bucketKey(p), [...(buckets.get(bucketKey(p)) ?? []), p])
  }

  // Decide once per bucket whether it merges, and under what name.
  const merged = new Map<string, { members: Product[]; prefix: string }>()
  for (const [key, members] of buckets) {
    if (members.length < 2) continue
    const prefix = sharedPrefix(members.map(nameOf))
    const known = members[0]!.group !== ''
    if (known || prefix.split(/\s+/).filter(Boolean).length >= 2) merged.set(key, { members, prefix })
  }

  const emitted = new Set<string>()
  const out: Product[] = []
  for (const p of products) {
    const key = bucketKey(p)
    const group = p.collection ? merged.get(key) : undefined
    if (!group) out.push(p)
    else if (!emitted.has(key)) {
      emitted.add(key)
      out.push(merge(p, group.members, group.prefix))
    }
  }
  return out
}
