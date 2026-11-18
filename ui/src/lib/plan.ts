import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate'
import type { Product, Variant } from '../api/types'
import { totalCents } from './format'
import { cleanRefs, productRef } from './compare'

/** One line of the build plan: a variant of a product, and how many. */
export interface PlanLine {
  /** The product, as "region/slug". */
  ref: string
  /** The variant, by SKU. */
  sku: string
  qty: number
  /** What one cost, out the door, when the line was added; null if no price was shown then. */
  addedCents: number | null
}

export const MAX_QTY = 99
/** More lines than anyone plans; a bound so a crafted link can't build a huge page. */
export const MAX_LINES = 100

export const lineKey = (l: Pick<PlanLine, 'ref' | 'sku'>): string => `${l.ref}:${encodeURIComponent(l.sku)}`

/** A line as text, for the URL and for storage: "us/usw-pro:USW-PRO-24:2:19900". */
export const serializeLine = (l: PlanLine): string => `${lineKey(l)}:${l.qty}:${l.addedCents ?? ''}`

/** The inverse; null for anything malformed. */
export function parseLine(text: unknown): PlanLine | null {
  if (typeof text !== 'string') return null
  const parts = text.split(':')
  if (parts.length !== 4) return null
  const [ref, rawSku, rawQty, rawAdded] = parts as [string, string, string, string]
  if (cleanRefs([ref]).length !== 1) return null
  let sku: string
  try {
    sku = decodeURIComponent(rawSku)
  } catch {
    return null
  }
  if (sku === '' || !/^\d{1,2}$/.test(rawQty)) return null
  const qty = Number(rawQty)
  if (qty < 1 || qty > MAX_QTY) return null
  if (rawAdded !== '' && !/^\d{1,9}$/.test(rawAdded)) return null
  return { ref, sku, qty, addedCents: rawAdded === '' ? null : Number(rawAdded) }
}

/** The lines in a list of texts, skipping the malformed and repeated ones. */
export function parsePlan(list: unknown): PlanLine[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: PlanLine[] = []
  for (const item of list) {
    const l = parseLine(item)
    if (!l || seen.has(lineKey(l))) continue
    seen.add(lineKey(l))
    out.push(l)
    if (out.length >= MAX_LINES) break
  }
  return out
}

/** Longest plan slug we'll unpack. A plan of MAX_LINES lines needs far less; this bounds what a crafted one can inflate to. */
export const MAX_SLUG = 3000

const toBase64Url = (b: Uint8Array): string => {
  let bin = ''
  for (const x of b) bin += String.fromCharCode(x)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

/** A plan as a short URL-safe slug: its lines, one per row, compressed, then base64url. */
export const encodePlan = (lines: PlanLine[]): string => toBase64Url(deflateSync(strToU8(lines.map(serializeLine).join('\n')), { level: 9 }))

/** The inverse. Null when the slug isn't one we made; malformed lines inside it are dropped. */
export function decodePlan(slug: string): PlanLine[] | null {
  if (slug === '' || slug.length > MAX_SLUG || !/^[A-Za-z0-9_-]+$/.test(slug)) return null
  try {
    return parsePlan(strFromU8(inflateSync(fromBase64Url(slug))).split('\n'))
  } catch {
    return null
  }
}

/** Adds a line, or raises the quantity of the one already there. */
export function addLine(plan: PlanLine[], line: PlanLine): PlanLine[] {
  const same = plan.find((l) => lineKey(l) === lineKey(line))
  if (same) return plan.map((l) => (l === same ? { ...l, qty: Math.min(MAX_QTY, l.qty + line.qty) } : l))
  return plan.length >= MAX_LINES ? plan : [...plan, line]
}

export const removeLine = (plan: PlanLine[], key: string): PlanLine[] => plan.filter((l) => lineKey(l) !== key)

/** Sets a quantity, clamped to 1..MAX_QTY. */
export const setQty = (plan: PlanLine[], key: string, qty: number): PlanLine[] =>
  plan.map((l) => (lineKey(l) === key ? { ...l, qty: Math.min(MAX_QTY, Math.max(1, Math.round(qty) || 1)) } : l))

/** Switches a line to another variant of the same product, merging with a line that already has it. */
export function changeVariant(plan: PlanLine[], key: string, variant: Variant): PlanLine[] {
  const line = plan.find((l) => lineKey(l) === key)
  if (!line || variant.sku === line.sku) return plan
  const moved: PlanLine = { ...line, sku: variant.sku, addedCents: totalCents(variant) }
  return addLine(removeLine(plan, key), moved)
}

/** What to add when someone says "add this product": the cheapest variant in stock, else the cheapest, else the first. */
export function defaultVariant(p: Product): Variant | undefined {
  const cheapest = (vs: Variant[]) => vs.filter((v) => totalCents(v) !== null).sort((a, b) => totalCents(a)! - totalCents(b)!)[0]
  return cheapest(p.variants.filter((v) => v.status === 'Available')) ?? cheapest(p.variants) ?? p.variants[0]
}

export function lineFor(p: Product, qty = 1): PlanLine | null {
  const v = defaultVariant(p)
  return v ? { ref: productRef(p), sku: v.sku, qty, addedCents: totalCents(v) } : null
}

// ---- Pricing a plan against the current catalogue ----

export type LineState = 'in' | 'soon' | 'out' | 'unlisted' | 'untracked'

/** A line with what the catalogue says about it now. */
export interface LineView {
  line: PlanLine
  product?: Product
  variant?: Variant
  /** One's out-the-door price now; null when none is shown. */
  unitCents: number | null
  totalCents: number | null
  currency: string
  /** 'unlisted': the product is tracked but no longer has this variant. 'untracked': the product isn't tracked. */
  state: LineState
  /** The price when the line was added, when it has changed since. */
  wasCents: number | null
}

export function viewLine(line: PlanLine, products: Map<string, Product>): LineView {
  const product = products.get(line.ref)
  const variant = product?.variants.find((v) => v.sku === line.sku)
  const unitCents = variant ? totalCents(variant) : null
  const state: LineState = !product ? 'untracked' : !variant ? 'unlisted' : variant.status === 'Available' ? 'in' : variant.status === 'ComingSoon' ? 'soon' : 'out'
  return {
    line,
    product,
    variant,
    unitCents,
    totalCents: unitCents === null ? null : unitCents * line.qty,
    currency: variant?.currency ?? 'USD',
    state,
    wasCents: line.addedCents !== null && unitCents !== null && line.addedCents !== unitCents ? line.addedCents : null,
  }
}

export interface PlanTotals {
  /** Per currency, since products from different regions can be priced differently. */
  sums: { currency: string; cents: number }[]
  /** Lines with no price to add up. */
  unpriced: number
  items: number
  /** Lines that can't be bought right now. */
  notInStock: LineView[]
}

export function planTotals(views: LineView[]): PlanTotals {
  const sums = new Map<string, number>()
  for (const v of views) if (v.totalCents !== null) sums.set(v.currency, (sums.get(v.currency) ?? 0) + v.totalCents)
  return {
    sums: [...sums].map(([currency, cents]) => ({ currency, cents })),
    unpriced: views.filter((v) => v.totalCents === null).length,
    items: views.reduce((n, v) => n + v.line.qty, 0),
    notInStock: views.filter((v) => v.state !== 'in'),
  }
}
