import type { Product } from '../api/types'

export const SORT_OPTIONS = [
  { value: 'updated', label: 'Recently updated' },
  { value: 'date', label: 'Date added' },
  { value: 'name', label: 'Name' },
  { value: 'price-asc', label: 'Price (low to high)' },
  { value: 'price-desc', label: 'Price (high to low)' },
] as const

export type SortKey = (typeof SORT_OPTIONS)[number]['value']

export const DEFAULT_SORT: SortKey = 'updated'

const STORAGE_KEY = 'restock-radar.sort'

export function isSortKey(value: unknown): value is SortKey {
  return SORT_OPTIONS.some((o) => o.value === value)
}

export function readStoredSort(): SortKey {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return isSortKey(stored) ? stored : DEFAULT_SORT
  } catch {
    return DEFAULT_SORT
  }
}

export function storeSort(key: SortKey): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, key)
  } catch {
    // Not remembered; the choice still applies for this visit.
  }
}

function time(iso: string): number {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/** The earliest moment any variant was first seen: when the product started being tracked. */
function added(p: Product): number {
  return Math.min(...p.variants.map((v) => time(v.first_seen)))
}

/** The latest change to any variant. */
function updated(p: Product): number {
  return Math.max(...p.variants.map((v) => time(v.last_changed)))
}

/** The lowest variant price, or null when no variant shows one. */
function lowestPrice(p: Product): number | null {
  const prices = p.variants.flatMap((v) => (v.price_cents === null ? [] : [v.price_cents]))
  return prices.length ? Math.min(...prices) : null
}

function byName(a: Product, b: Product): number {
  return a.title.toLowerCase().localeCompare(b.title.toLowerCase()) || a.region.localeCompare(b.region)
}

/**
 * A sorted copy of `products`. Date and recently-updated put the newest first;
 * price orders by each product's cheapest variant, with unpriced products last
 * either way. Ties fall back to name.
 */
export function sortProducts(products: Product[], key: SortKey): Product[] {
  const out = [...products]
  const by = (value: (p: Product) => number, dir: 1 | -1) => out.sort((a, b) => dir * (value(a) - value(b)) || byName(a, b))
  switch (key) {
    case 'date':
      return by(added, -1)
    case 'updated':
      return by(updated, -1)
    case 'price-asc':
    case 'price-desc': {
      const dir = key === 'price-asc' ? 1 : -1
      return out.sort((a, b) => {
        const pa = lowestPrice(a)
        const pb = lowestPrice(b)
        if (pa === null || pb === null) return pa === pb ? byName(a, b) : pa === null ? 1 : -1
        return dir * (pa - pb) || byName(a, b)
      })
    }
    default:
      return out.sort(byName)
  }
}
